// workbuddy-relay — local OpenAI-compatible relay for the WorkBuddy cloud gateway.
//
// Endpoints:
//   GET  /healthz                 liveness + login/catalog state
//   GET  /v1/models               OpenAI model list (from the /v3/config catalog)
//   POST /v1/chat/completions     OpenAI chat (stream + non-stream)
//   POST /wb/login/start          web sign-in: issues the URL to open
//   GET  /wb/login/poll?id=...    poll the sign-in outcome
//   POST /wb/refresh              force a token refresh
//   POST /wb/catalog              refresh the model catalog (returns projected list)
//   GET  /wb/checkin              run the daily check-in now (idempotent)
//   GET  /wb/checkin-status       check-in status (local marker + upstream)
//   GET  /wb/opencode-config      ready-to-paste providers section for opencode.json
//
// Every route except /healthz requires `Authorization: Bearer <secret>`; the
// secret is generated once and stored in relay.json next to the chosen port.
//
// Lifecycle: a long-running local service. Started via the Windows startup
// item (workbuddy-relay.cmd in the Startup folder, idempotent) or by hand;
// it stays up until killed or the machine shuts down.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { store, stateDir } from "./lib/store.mjs";
import { startLogin, pollLogin } from "./lib/login.mjs";
import { refreshCredential, CredentialError } from "./lib/auth.mjs";
import { fetchCatalog } from "./lib/catalog.mjs";
import { sendChat, pipeSse, aggregateSse, UpstreamError } from "./lib/chat.mjs";
import { checkinStatus, dailyCheckin, todayMarker } from "./lib/checkin.mjs";

const DEFAULT_PORT = 41142;
const PORT_RANGE = 20;

function writeJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function bearerOf(req) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function bearerOk(req, secret) {
  return bearerOf(req) !== "";
}

// Single-instance lock (stateDir/relay.lock). Concurrent spawns happen for
// real: several OpenCode plugin instances (one per project location) can run
// ensureRelay at the same moment, and a port probe alone races the winner's
// listen. openSync 'wx' is atomic, so exactly one process wins.
//
// Returns the lock file path, or null when a live relay already owns it.
let lockFile = null;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSingletonLock() {
  const file = path.join(stateDir, "relay.lock");
  const create = () => {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  if (create()) return file;
  let owner = 0;
  try {
    owner = Number(fs.readFileSync(file, "utf8").trim());
  } catch {
    /* unreadable lock counts as stale */
  }
  if (pidAlive(owner)) return null;
  // Stale lock (crashed / killed owner): take over.
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
  return create() ? file : null;
}

function releaseSingletonLock() {
  if (!lockFile) return;
  try {
    fs.unlinkSync(lockFile);
  } catch {
    /* ignore */
  }
  lockFile = null;
}

// process.exit() right after console.log can hang forever when stdout is a
// redirected Windows pipe whose write never completes (observed with
// concurrent spawns under Start-Process). Set exitCode first, then force
// exit from a timer: the loop drains normally in the healthy case, and the
// 3s backstop timer still fires even when a stuck pipe keeps the loop alive.
function exitSoon(code, delayMs = 250) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), delayMs).unref?.();
  setTimeout(() => process.exit(code), Math.max(delayMs, 3000)).unref?.();
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

function catalogForModels(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: "workbuddy",
    })),
  };
}

function opencodeConfigSection(catalog, port, secret) {
  const models = {};
  for (const m of catalog?.models ?? []) {
    models[m.id] = {
      name: m.displayName,
      ...(m.contextWindow ? { limit: { context: m.contextWindow, output: m.maxTokens } } : {}),
      ...(m.supportsToolCall === false ? { capabilities: { tools: false } } : {}),
    };
  }
  return {
    workbuddy: {
      name: "WorkBuddy",
      package: "@opencode/ai/providers/openai-compatible",
      settings: {
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: secret,
      },
      models,
    },
  };
}

// Black-box recorder: uncaught errors go to a separate file via
// appendFileSync, bypassing stdout entirely — relays were observed dying with
// empty logs, so the last words must not depend on the stdio pipe.
function blackbox(line) {
  try {
    fs.appendFileSync(
      path.join(stateDir, "relay-crash.log"),
      `${new Date().toISOString()} pid=${process.pid} ${line}\n`,
    );
  } catch {
    /* nothing left to try */
  }
}

process.on("uncaughtException", (error) => {
  blackbox(`uncaughtException: ${error?.stack ?? error}`);
  releaseSingletonLock();
  exitSoon(1);
});

process.on("unhandledRejection", (reason) => {
  blackbox(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

async function main() {
  const runtime = store.runtime ?? {};
  const secret = runtime.secret ?? randomBytes(24).toString("hex");

  lockFile = acquireSingletonLock();
  if (!lockFile) {
    console.log("[relay] another relay process already owns this state dir; exiting");
    exitSoon(0);
    return;
  }

  const shutdown = (reason) => {
    blackbox(`shutdown: ${reason}`);
    console.log(`[relay] shutting down: ${reason}`);
    releaseSingletonLock();
    try {
      server.closeAllConnections?.();
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    // Backstop without unref(): fires even if close() or a wedged pipe
    // would otherwise keep the event loop alive.
    setTimeout(() => process.exit(0), 3000);
  };

  // Clean up on Ctrl+C / service stop so the lock file never goes stale.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/healthz" && req.method === "GET") {
        const cred = store.credential;
        writeJson(res, 200, {
          ok: true,
          loggedIn: Boolean(cred?.accessToken),
          account: cred?.nickname ? cred.nickname : undefined,
          catalogAgeMs: store.catalog?.savedAt ? Date.now() - Date.parse(store.catalog.savedAt) : undefined,
          models: store.catalog?.models?.length ?? 0,
        });
        return;
      }

      if (!bearerOk(req, secret)) {
        writeJson(res, 401, { error: { message: "missing Authorization bearer", type: "auth" } });
        return;
      }
      const bearer = bearerOf(req);
      const hasSecret = bearer === secret;

      // ---- sign-in & management (relay secret only; the injected desktop JWT
      // must not be able to mint credentials or read the vault) ----
      if (!hasSecret && path.startsWith("/wb/")) {
        writeJson(res, 403, { error: { message: "management routes require the relay secret", type: "auth" } });
        return;
      }
      if (path === "/wb/login/start" && req.method === "POST") {
        const body = await readBody(req);
        const opts = body ? JSON.parse(body) : {};
        writeJson(res, 200, await startLogin({ open: opts.open !== false }));
        return;
      }
      if (path === "/wb/login/poll" && req.method === "GET") {
        writeJson(res, 200, await pollLogin(url.searchParams.get("id") ?? ""));
        return;
      }

      // ---- credentials & catalog ----
      if (path === "/wb/refresh" && req.method === "POST") {
        const cred = await refreshCredential();
        writeJson(res, 200, { ok: true, account: cred.nickname, refreshedAt: cred.refreshedAt });
        return;
      }
      if (path === "/wb/catalog" && (req.method === "POST" || req.method === "GET")) {
        if (req.method === "POST") {
          try {
            writeJson(res, 200, await fetchCatalog());
          } catch (error) {
            if (error instanceof CredentialError || /credential/.test(String(error))) {
              writeJson(res, 401, { error: { message: String(error.message ?? error) } });
            } else {
              writeJson(res, 502, { error: { message: String(error.message ?? error) } });
            }
          }
          return;
        }
        writeJson(res, 200, store.catalog ?? { models: [] });
        return;
      }
      if (path === "/wb/opencode-config" && req.method === "GET") {
        writeJson(res, 200, {
          port: server.address().port,
          providers: opencodeConfigSection(store.catalog, server.address().port, secret),
        });
        return;
      }

      if (path === "/wb/checkin" && req.method === "GET") {
        try {
          const result = await dailyCheckin(store.credential);
          writeJson(res, 200, result);
        } catch (error) {
          const status = /credential|no credential|sign in/i.test(String(error)) ? 401 : 502;
          writeJson(res, status, { error: { message: String(error.message ?? error), type: "checkin" } });
        }
        return;
      }
      if (path === "/wb/checkin-status" && req.method === "GET") {
        try {
          const upstream = await checkinStatus(store.credential);
          writeJson(res, 200, { today: todayMarker(), upstream });
        } catch (error) {
          const status = /credential|no credential|sign in/i.test(String(error)) ? 401 : 502;
          writeJson(res, status, { error: { message: String(error.message ?? error), type: "checkin" } });
        }
        return;
      }

      // ---- OpenAI-compatible surface ----
      if (path === "/v1/models" && req.method === "GET") {
        writeJson(res, 200, catalogForModels(store.catalog));
        return;
      }
      if (path === "/v1/chat/completions" && req.method === "POST") {
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

        // The OpenCode desktop app injects its own WorkBuddy keychain JWT as
        // the bearer; forward it to the gateway. When the caller presents the
        // relay secret instead, fall back to the vault credential.
        const injectedToken = hasSecret ? undefined : bearer;

        let upstream;
        try {
          upstream = await sendChat(body, { signal: abort.signal, token: injectedToken });
        } catch (error) {
          if (error instanceof UpstreamError) {
            const status =
              error.kind === "auth" ? 401
              : error.kind === "quota" ? 402
              : error.kind === "rate" ? 429
              : error.kind === "queue" ? 429
              : error.kind === "client" ? 400
              : 502;
            writeJson(res, status, {
              error: { message: error.message, type: error.kind, detail: error.detail },
            });
          } else {
            writeJson(res, 500, { error: { message: String(error.message ?? error), type: "internal" } });
          }
          return;
        }

        const wantsStream = body.stream === true;
        if (wantsStream) {
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

      writeJson(res, 404, { error: { message: `no such route: ${req.method} ${path}`, type: "not_found" } });
    } catch (error) {
      if (!res.headersSent) {
        writeJson(res, 500, { error: { message: String(error?.stack ?? error), type: "internal" } });
      } else {
        res.end();
      }
    }
  });

  // Pick the configured port, or scan upward from the default.
  const wanted = Number.isInteger(runtime.port) ? runtime.port : DEFAULT_PORT;
  let port = wanted;
  for (let attempt = 0; attempt < PORT_RANGE; attempt++) {
    // Idempotent spawn guard: if the wanted port is already served by a
    // healthy relay, exit quietly instead of binding a shifted port and
    // clobbering relay.json (which callers read to find us).
    if (attempt === 0 && (await healthyRelayOn(port))) {
      console.log(`[relay] a healthy relay already serves http://127.0.0.1:${port}; exiting`);
      releaseSingletonLock();
      exitSoon(0);
      return;
    }
    try {
      await new Promise((resolve, reject) => {
        const onError = (e) => {
          server.off("listening", onOk);
          reject(e);
        };
        const onOk = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onOk);
        server.listen(port, "127.0.0.1");
      });
      break;
    } catch {
      port += 1;
    }
  }

  store.saveRuntime({ ...runtime, port, secret, pid: process.pid, startedAt: new Date().toISOString() });
  console.log(`[relay] listening on http://127.0.0.1:${port} (pid ${process.pid}, state: ${process.env.WB_RELAY_HOME ?? "~/.workbuddy-relay"})`);
  console.log(`[relay] logged in: ${Boolean(store.credential?.accessToken)}; models: ${store.catalog?.models?.length ?? 0}`);

  startupCheckin();
  startCheckinTimer();
}

/**
 * Periodic safety net: the startup check-in only fires once per process, so a
 * machine that stays on for days would miss days. Every 30 minutes the timer
 * checks the (idempotent) status endpoint and claims when
 * `today_checked_in` is false. Cost when already checked in: one cheap POST
 * per 30 min. The claim decision is purely the server's flag, so a timer
 * firing at 00:05 claims the NEW day exactly once — the next 30-min ticks
 * see today_checked_in=true and do nothing.
 */
function startCheckinTimer() {
  if (!store.credential?.accessToken) return; // no credential: nothing to claim
  const INTERVAL_MS = 30 * 60 * 1000;
  let lastDay = null; // local YYYY-MM-DD of the last successful claim attempt

  const tick = async () => {
    const today = new Date().toLocaleDateString("sv"); // sv-SE → YYYY-MM-DD
    try {
      const cred = store.credential;
      if (!cred?.accessToken) return;
      const status = await checkinStatus(cred);
      if (status?.active && !status.today_checked_in) {
        const result = await dailyCheckin(cred);
        console.log(`[relay] scheduled check-in: ${result.message}`);
        lastDay = today;
      } else if (status?.today_checked_in) {
        lastDay = today;
      }
    } catch (error) {
      // Quiet: startup check-in and /wb/checkin already log loudly; a timer
      // miss just retries in 30 minutes. Log only on day rollover failures.
      if (lastDay !== today) console.error(`[relay] scheduled check-in failed (retries in 30min): ${error.message}`);
    }
  };

  const timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref?.(); // never keep the process alive just for the timer
  void tick(); // first pass right away — covers long-running relays that crossed midnight
}

// Claim the daily credit once per relay start. Runs in the background so a
// slow/failed upstream never delays startup; the local checkin.json ledger
// short-circuits when today is already recorded (zero network calls), and
// upstream idempotency (code 10001) is the second line of defense.
// Skips silently when no credential is on disk (not signed in yet).
async function startupCheckin() {
  if (!store.credential?.accessToken) {
    console.log("[relay] check-in skipped: not signed in");
    return;
  }
  if (todayMarker()) {
    console.log("[relay] check-in skipped: already recorded today (local state)");
    return;
  }
  try {
    const cred = store.credential;
    const result = await dailyCheckin(cred);
    console.log(`[relay] daily check-in: ${result.message}`);
  } catch (error) {
    // Non-fatal: token might be stale; a /wb/refresh or the next restart retries.
    console.error(`[relay] daily check-in failed (will retry on next start): ${error.message}`);
  }
}

// True when the port answers /healthz with ok:true (i.e. another instance of
// this relay, not some unrelated process).
async function healthyRelayOn(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    return (await res.json())?.ok === true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  releaseSingletonLock();
  console.error(`[relay] fatal: ${error?.stack ?? error}`);
  blackbox(`fatal: ${error?.stack ?? error}`);
  exitSoon(1);
});
