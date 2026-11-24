// workbuddy-relay — OpenCode server plugin (in-process, the DSH architecture).
//
// Everything the old standalone relay did now lives inside the OpenCode
// service process:
//   1. A loopback HTTP shim on 127.0.0.1:<ephemeral> that translates the
//      OpenAI-compatible surface into the WorkBuddy gateway protocol
//      (conversation-triple headers, CLI UA, system head, fingerprint rescue,
//      forced streaming, SSE passthrough/aggregation).
//   2. A `workbuddy` provider registered via ctx.provider.transform, whose
//      baseURL points at the shim — models come live from the /v3/config
//      catalog (app-channel UA) with discount badges in display names.
//
// Lifecycle is the host's: the shim listens while the plugin is loaded and is
// closed in the cleanup function. No standalone process, no startup item, no
// window flashes.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Model, Plugin, Provider } from "@opencode/plugin";

import { store } from "./lib/store.mjs";
import { startLogin, pollLogin } from "./lib/login.mjs";
import { refreshCredential, CredentialError } from "./lib/auth.mjs";
import { fetchCatalog } from "./lib/catalog.mjs";
import { sendChat, pipeSse, aggregateSse, UpstreamError } from "./lib/chat.mjs";

const PROVIDER_ID = "workbuddy";

function writeJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

function bearerOf(req) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listenOnce(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function pluginErrorStatus(error) {
  if (error instanceof UpstreamError) {
    return error.kind === "auth" ? 401
      : error.kind === "quota" ? 402
      : error.kind === "rate" ? 429
      : error.kind === "queue" ? 429
      : error.kind === "client" ? 400
      : 502;
  }
  return 500;
}

export default Plugin.define({
  id: "workbuddy-relay",

  async setup(ctx) {
    const secret = randomBytes(24).toString("hex");
    let catalog = store.catalog;
    let currentBaseURL = "";

    // ---- the in-process loopback shim ----
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const route = url.pathname.replace(/\/+$/, "") || "/";

      try {
        if (route === "/healthz" && req.method === "GET") {
          const cred = store.credential;
          writeJson(res, 200, {
            ok: true,
            loggedIn: Boolean(cred?.accessToken),
            account: cred?.nickname,
            models: catalog?.models?.length ?? 0,
          });
          return;
        }

        const bearer = bearerOf(req);
        if (bearer === "") {
          writeJson(res, 401, { error: { message: "missing Authorization bearer", type: "auth" } });
          return;
        }
        const hasSecret = bearer === secret;
        if (!hasSecret && route.startsWith("/wb/")) {
          writeJson(res, 403, { error: { message: "management routes require the plugin secret", type: "auth" } });
          return;
        }

        if (route === "/wb/login/start" && req.method === "POST") {
          const body = await readBody(req);
          const opts = body ? JSON.parse(body) : {};
          writeJson(res, 200, await startLogin({ open: opts.open !== false }));
          return;
        }
        if (route === "/wb/login/poll" && req.method === "GET") {
          writeJson(res, 200, await pollLogin(url.searchParams.get("id") ?? ""));
          return;
        }
        if (route === "/wb/refresh" && req.method === "POST") {
          const cred = await refreshCredential();
          writeJson(res, 200, { ok: true, account: cred.nickname, refreshedAt: cred.refreshedAt });
          return;
        }
        if (route === "/wb/catalog" && (req.method === "POST" || req.method === "GET")) {
          if (req.method === "POST") {
            try {
              catalog = await fetchCatalog();
              await ctx.provider.reload();
              writeJson(res, 200, catalog);
            } catch (error) {
              const status = error instanceof CredentialError || /credential/.test(String(error)) ? 401 : 502;
              writeJson(res, status, { error: { message: String(error.message ?? error) } });
            }
            return;
          }
          writeJson(res, 200, catalog ?? { models: [] });
          return;
        }
        // ---- OpenAI-compatible surface (what the provider package calls) ----
        if (route === "/v1/models" && req.method === "GET") {
          writeJson(res, 200, {
            object: "list",
            data: (catalog?.models ?? []).map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "workbuddy" })),
          });
          return;
        }
        if (route === "/v1/chat/completions" && req.method === "POST") {
          const raw = await readBody(req);
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            writeJson(res, 400, { error: { message: "invalid JSON body", type: "invalid_request" } });
            return;
          }
          const model = typeof body.model === "string" ? body.model : "";
          if (model === "") {
            writeJson(res, 400, { error: { message: "model is required", type: "invalid_request" } });
            return;
          }
          const abort = new AbortController();
          req.on("close", () => {
            if (!res.writableEnded) abort.abort();
          });

          // The desktop app stamps its own WorkBuddy keychain JWT onto
          // provider requests; forward it. When the caller presents the
          // in-process secret instead, fall back to the vault credential.
          const injectedToken = hasSecret ? undefined : bearer;

          let upstream;
          try {
            upstream = await sendChat(body, { signal: abort.signal, token: injectedToken });
          } catch (error) {
            const status = pluginErrorStatus(error);
            writeJson(res, status, {
              error: { message: error.message, type: error instanceof UpstreamError ? error.kind : "internal", detail: error.detail },
            });
            return;
          }

          if (body.stream === true) {
            pipeSse(upstream, res, abort);
          } else {
            try {
              writeJson(res, 200, await aggregateSse(upstream, model));
            } catch (error) {
              writeJson(res, 502, { error: { message: `failed to read upstream answer: ${error.message}`, type: "server" } });
            }
          }
          return;
        }

        writeJson(res, 404, { error: { message: `no such route: ${req.method} ${route}`, type: "not_found" } });
      } catch (error) {
        if (!res.headersSent) {
          writeJson(res, 500, { error: { message: String(error?.stack ?? error), type: "internal" } });
        } else {
          res.end();
        }
      }
    });

    const port = await listenOnce(server);
    currentBaseURL = `http://127.0.0.1:${port}/v1`;

    // ---- register the provider against the shim ----
    const buildModels = () =>
      (catalog?.models ?? []).map((m) => ({
        ...Model.Info.default(PROVIDER_ID, Model.ID.make(m.id)),
        name: m.displayName ?? m.id,
        ...(m.contextWindow ? { limit: { context: m.contextWindow, output: m.maxTokens } } : {}),
        ...(m.supportsToolCall === false ? { capabilities: { tools: false } } : {}),
      }));

    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(PROVIDER_ID),
          name: "WorkBuddy",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: currentBaseURL, apiKey: secret },
        },
        models: buildModels(),
      });
    });

    // Fresh catalog (also picks up promo/badge changes) + provider reload.
    const refreshCatalog = async () => {
      try {
        const fresh = await fetchCatalog();
        if (fresh?.models?.length) {
          catalog = fresh;
          await ctx.provider.reload();
        }
      } catch (error) {
        console.error(`[workbuddy] catalog refresh failed: ${error.message ?? error}`);
      }
    };

    const catalogTimer = setInterval(() => void refreshCatalog(), 30 * 60 * 1000);
    catalogTimer.unref?.();

    // Fresh catalog at startup (badges/promos may have changed since last run).
    void (async () => {
      if (!store.credential?.accessToken) {
        console.log("[workbuddy] not signed in — run: node plugin/login-cli.mjs");
        return;
      }
      await refreshCatalog();
    })();

    console.log(`[workbuddy] provider ready at ${currentBaseURL} (${catalog?.models?.length ?? 0} models)`);

    return () => {
      clearInterval(catalogTimer);
      try {
        server.closeAllConnections?.();
      } catch {
        /* ignore */
      }
      server.close();
    };
  },
});
