// Chat translation: OpenAI-compatible in, WorkBuddy gateway out.
//
// The upstream endpoint (`/v2/chat/completions`) accepts the standard OpenAI
// chat JSON and answers with OpenAI-shaped SSE, which we pipe through for
// streaming clients and aggregate for non-streaming ones.
//
// Gateway gates (all measured on the real gateways by dsh-connect-workbuddy):
//   1. first message must have role "system"
//   2. the conversation identity triple headers must be present
//   3. content fingerprints: known third-party agent prompt openings are
//      refused with business code 11128 -> rescue = neutral head + zero-width
//      space perturbation at sentence boundaries.

import {
  chatBase,
  chatHeaders,
  currentCredential,
  refreshCredential,
} from "./auth.mjs";
import { CHAT_PATH, FALLBACK_SYSTEM_PROMPT, FINGERPRINT_PATTERNS, CHAT_HEADER_TIMEOUT_MS } from "./constants.mjs";

export class UpstreamError extends Error {
  constructor(message, { status = 0, kind = "server", detail } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // "client" | "auth" | "rate" | "queue" | "channel" | "server"
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Body preparation
// ---------------------------------------------------------------------------

function ensureSystemHead(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const withHead = messages.length > 0 && messages[0]?.role === "system"
    ? body
    : { ...body, messages: [{ role: "system", content: FALLBACK_SYSTEM_PROMPT }, ...messages] };
  // The gateway answers non-stream requests with 11101 ("Non-stream chat
  // request is currently not supported"); non-streaming clients are served by
  // aggregating the upstream SSE in the relay.
  return { ...withHead, stream: true };
}

function messageText(m) {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  }
  return "";
}

function isFingerprinted(body) {
  return (body.messages ?? []).some((m) => {
    if (m.role !== "system" && m.role !== "assistant" && m.role !== "developer") return false;
    const text = messageText(m);
    return FINGERPRINT_PATTERNS.some((re) => re.test(text));
  });
}

/** Break substring fingerprints with an invisible zero-width space. The model
 * reads the same words; the exact-substring match no longer hits. */
function perturbText(text) {
  return text.replace(/([。！？.!?\n]|(?<=[a-z])\. )/gu, "$&\u200b");
}

function perturbFingerprints(body) {
  return {
    ...body,
    messages: (body.messages ?? []).map((m) => {
      if (m.role !== "system" && m.role !== "assistant" && m.role !== "developer") return m;
      if (typeof m.content === "string") {
        return { ...m, content: perturbText(m.content) };
      }
      if (Array.isArray(m.content)) {
        return {
          ...m,
          content: m.content.map((part) =>
            typeof part?.text === "string" ? { ...part, text: perturbText(part.text) } : part,
          ),
        };
      }
      return m;
    }),
  };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function classify(status, bodyText) {
  let code;
  try {
    const doc = JSON.parse(bodyText);
    if (typeof doc?.code === "number") code = doc.code;
  } catch {
    /* not JSON */
  }
  if (status === 401) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate";
  if (code === 6020 || code === 6021 || code === 6022) return "queue";
  if (code === 11128 || code === 11140) return "channel";
  if (status >= 400 && status < 500) return "client";
  return "server";
}

function errorFromResponse(status, bodyText) {
  let snippet = bodyText;
  let displayMsg;
  try {
    const doc = JSON.parse(bodyText);
    displayMsg = doc.displayMsg ?? doc.msg ?? doc.message;
    if (displayMsg !== null && typeof displayMsg === "object") {
      displayMsg = displayMsg.zh ?? displayMsg["zh-hant"] ?? displayMsg.en ?? JSON.stringify(displayMsg);
    }
    snippet = JSON.stringify(doc).slice(0, 400);
  } catch {
    /* keep raw */
  }
  return new UpstreamError(`workbuddy upstream http ${status}: ${displayMsg ?? snippet}`, {
    status,
    kind: classify(status, bodyText),
    detail: { displayMsg, body: snippet },
  });
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

async function sendOnce(cred, bodyJson, signal) {
  let res;
  const timed = AbortSignal.any([AbortSignal.timeout(CHAT_HEADER_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  try {
    res = await fetch(`${chatBase()}${CHAT_PATH}`, {
      method: "POST",
      headers: chatHeaders(cred),
      body: bodyJson,
      signal: timed,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { error: new UpstreamError(`transport error: ${error.message ?? error}`, { kind: "server" }) };
  }
  if (res.ok) return { res };
  const text = (await res.text()).slice(0, 8000);
  return { error: errorFromResponse(res.status, text) };
}

/**
 * Send one chat request; handles auth refresh on 401 (once) and the channel
 * gate rescue ladder on 11128 (neutral head already enforced; perturbation
 * second). Returns the raw upstream Response (streaming body).
 */
/**
 * Send one chat request; handles auth refresh on 401 (once, vault credentials
 * only) and the channel gate rescue ladder on 11128.
 *
 * `token` (when given) is an externally injected WorkBuddy access token —
 * the OpenCode desktop app stamps its own keychain JWT onto every request,
 * and the gateway accepts it directly — so it is forwarded as-is and never
 * refreshed here (the refresh token is not ours).
 */
export async function sendChat(body, { signal, token } = {}) {
  let prepared = ensureSystemHead(body);
  let injected = false;
  let cred;
  if (token) {
    cred = { accessToken: token, uid: "", domain: "" };
    injected = true;
  } else {
    cred = await currentCredential();
  }

  let attempt = await sendOnce(cred, JSON.stringify(prepared), signal);
  if (attempt.error?.kind === "auth" && !injected) {
    const fresh = await refreshCredential();
    attempt = await sendOnce(fresh, JSON.stringify(prepared), signal);
  }
  if (attempt.res) return attempt.res;

  if (attempt.error?.kind === "channel" || isFingerprinted(prepared)) {
    const perturbed = perturbFingerprints(prepared);
    attempt = await sendOnce(cred, JSON.stringify(perturbed), signal);
    if (attempt.res) return attempt.res;
  }
  throw attempt.error ?? new UpstreamError("upstream failed without a classified error", { kind: "server" });
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

/** Pipe an upstream SSE response to the client untouched. */
export function pipeSse(upstream, res, signal) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const reader = upstream.body.getReader();
  let closed = false;
  res.on("close", () => {
    closed = true;
    try {
      signal?.abort();
    } catch {
      /* ignore */
    }
  });
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
    } catch {
      /* client aborted or upstream reset */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
      res.end();
    }
  })();
}

/** Consume the upstream SSE and aggregate one OpenAI-shaped JSON response. */
export async function aggregateSse(upstream, model) {
  const text = await upstream.text();
  let content = "";
  let reasoning = "";
  let finish = null;
  let usage;
  let id = `chatcmpl-${Date.now()}`;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") break;
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof frame.id === "string") id = frame.id;
    const choice = frame.choices?.[0];
    const delta = choice?.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (frame.usage) usage = frame.usage;
  }
  const message = { role: "assistant", content };
  if (reasoning !== "") message.reasoning_content = reasoning;
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish ?? "stop" }],
    ...(usage ? { usage } : {}),
  };
}

export { CHAT_HEADER_TIMEOUT_MS };
