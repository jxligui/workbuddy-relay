// Credential refresh + upstream request header builders.

import { randomUUID } from "node:crypto";
import {
  CN_CHAT_BASE,
  CN_BILLING_BASE,
  CLIENT_UA,
  REFRESH_PATH,
  JSON_TIMEOUT_MS,
} from "./constants.mjs";
import { store } from "./store.mjs";

export class CredentialError extends Error {}

/** The chat/billing base for the (CN) credential. */
export function chatBase() {
  return CN_CHAT_BASE;
}

function originReferer() {
  return CN_BILLING_BASE;
}

/** Refresh endpoint headers: the only place X-Refresh-Token appears. */
function refreshHeaders(cred) {
  const headers = {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: originReferer(),
    Referer: `${originReferer()}/`,
    "User-Agent": CLIENT_UA,
    "X-Refresh-Token": cred.refreshToken,
    "X-Auth-Refresh-Source": "workbuddy",
  };
  if (cred.uid) headers["X-User-Id"] = cred.uid;
  else headers["X-No-User-Id"] = "1";
  if (cred.domain) headers["X-Domain"] = cred.domain;
  else headers["X-No-Department-Info"] = "1";
  return headers;
}

/** Refresh the access token; persists and returns the merged credential. */
export async function refreshCredential() {
  const cred = store.credential;
  if (!cred?.refreshToken) throw new CredentialError("no credential on disk; sign in first");
  let res;
  try {
    res = await fetch(`${chatBase()}${REFRESH_PATH}`, {
      method: "POST",
      headers: refreshHeaders(cred),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CredentialError(`refresh transport error: ${error}`);
  }
  const text = await res.text();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new CredentialError(`refresh answered non-JSON (http ${res.status}): ${text.slice(0, 200)}`);
  }
  const code = typeof doc.code === "number" ? doc.code : -1;
  if (!res.ok || (code !== 0 && code !== 200)) {
    throw new CredentialError(`refresh refused (http ${res.status}, code ${code}): ${JSON.stringify(doc).slice(0, 300)}`);
  }
  const data = doc.data ?? {};
  const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
  if (accessToken === "") throw new CredentialError("refresh returned no accessToken; sign in again");
  const merged = {
    ...cred,
    accessToken,
    refreshToken: typeof data.refreshToken === "string" && data.refreshToken !== "" ? data.refreshToken : cred.refreshToken,
    expiresInSec: typeof data.expiresIn === "number" && data.expiresIn > 0 ? data.expiresIn : cred.expiresInSec,
    domain: typeof data.domain === "string" && data.domain !== "" ? data.domain : cred.domain,
    refreshedAt: new Date().toISOString(),
  };
  store.saveCredential(merged);
  return merged;
}

/** A credential believed valid; refreshes when past its nominal expiry. */
export async function currentCredential() {
  const cred = store.credential;
  if (!cred?.accessToken) throw new CredentialError("no credential on disk; run the web sign-in first");
  const savedAtMs = cred.savedAt ? Date.parse(cred.savedAt) : 0;
  const lifetimeMs = (cred.expiresInSec ?? 3600) * 1000;
  const stale = savedAtMs === 0 || Date.now() - savedAtMs > Math.max(60_000, lifetimeMs - 5 * 60_000);
  if (stale) {
    try {
      return await refreshCredential();
    } catch (error) {
      // Keep serving with the old token if upstream is unreachable; a 401 in
      // chat will trigger one more refresh+retry anyway.
      console.error(`[relay] refresh failed, using the stored token: ${error.message}`);
      return cred;
    }
  }
  return cred;
}

/**
 * Conversation identity triple: the chat endpoint requires it (business code
 * 11128 / "conversation id missing" otherwise). Any well-formed UUID passes;
 * values are generated per request and never persisted.
 */
export function conversationHeaders(stableConversationId) {
  return {
    "X-Conversation-ID": stableConversationId ?? randomUUID(),
    "X-Conversation-Request-ID": randomUUID(),
    "X-Conversation-Message-ID": randomUUID(),
  };
}

/** Chat request headers (the CLI channel identity). */
export function chatHeaders(cred) {
  const headers = {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: originReferer(),
    Referer: `${originReferer()}/`,
    "User-Agent": CLIENT_UA,
    "Content-Type": "application/json",
    "X-Product": "SaaS",
    ...conversationHeaders(),
    Authorization: `Bearer ${cred.accessToken}`,
  };
  if (cred.uid) headers["X-User-Id"] = cred.uid;
  else headers["X-No-User-Id"] = "1";
  headers["X-No-Enterprise-Id"] = "1";
  if (cred.domain) headers["X-Domain"] = cred.domain;
  else headers["X-No-Department-Info"] = "1";
  return headers;
}
