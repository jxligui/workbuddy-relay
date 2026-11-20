// WorkBuddy web login (OAuth-style state flow), CN region.
//
//   POST {base}/v2/plugin/auth/state?platform=workbuddy  -> {state, authUrl}
//   (user opens authUrl in a browser and scans/confirms)
//   GET  {base}/v2/plugin/auth/token?state={state}       -> {accessToken, refreshToken, ...}
//   GET  {base}/v2/plugin/account  (Bearer)              -> profile (uid, nickname)

import { randomUUID } from "node:crypto";
import { CN_BILLING_BASE, API_PREFIX, JSON_TIMEOUT_MS } from "./constants.mjs";
import { store } from "./store.mjs";

const SESSION_TTL_MS = 10 * 60 * 1000;
/** sessions live in-process only, like the reference implementation */
const sessions = new Map();

function envelopeData(document) {
  if (document === null || typeof document !== "object") return {};
  const d = document.data;
  if (d !== null && typeof d === "object") return d;
  return document;
}

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

async function fetchJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(JSON_TIMEOUT_MS) });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: undefined, text };
  }
}

/** Start one login session; returns the URL the user must open. */
export async function startLogin({ region = "cn", open = true } = {}) {
  if (region !== "cn") throw new Error("only the CN region is implemented");
  const base = CN_BILLING_BASE;
  const { status, json } = await fetchJson(`${base}${API_PREFIX}/auth/state?platform=workbuddy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
  });
  const data = envelopeData(json);
  const state = firstString(data, ["state", "State"]);
  if (state === "") {
    throw new Error(`sign-in service did not issue a state (http ${status})`);
  }
  const authUrl =
    firstString(data, ["authUrl", "auth_url", "url", "Url"]) ||
    `${base}/login?state=${encodeURIComponent(state)}`;

  const loginId = `wbo_${randomUUID().replaceAll("-", "")}`;
  sessions.set(loginId, {
    region,
    base,
    state,
    expiresAtMs: Date.now() + SESSION_TTL_MS,
    done: false,
  });

  if (open && process.platform === "win32") {
    try {
      const { spawn } = await import("node:child_process");
      spawn("cmd", ["/c", "start", "", authUrl], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch {
      /* caller can open the URL manually */
    }
  }

  return { loginId, verificationUri: authUrl, expiresInSec: SESSION_TTL_MS / 1000 };
}

async function collectAccount(session, accessToken, tokenData) {
  // Profile first, JWT claims only as identity fallback (display metadata).
  let profile = {};
  try {
    const { json } = await fetchJson(`${session.base}${API_PREFIX}/account`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    });
    profile = envelopeData(json);
  } catch {
    /* profile optional */
  }
  const uid = firstString(profile, ["uid", "Uid", "userId", "UserID"]);
  const nickname = firstString(profile, ["nickname", "NickName"]);
  const domain = firstString(tokenData, ["domain", "Domain"]);
  return {
    uid,
    nickname,
    domain,
    accessToken,
    refreshToken: firstString(tokenData, ["refreshToken", "refresh_token", "RefreshToken"]),
    expiresInSec: typeof tokenData.expiresIn === "number" ? tokenData.expiresIn : undefined,
  };
}

/** Poll once for a login outcome. */
export async function pollLogin(loginId) {
  const session = sessions.get(loginId);
  if (!session) return { done: true, error: "sign-in session not found; start a new one" };
  if (session.done) return { done: true, account: session.account, error: session.error };
  if (Date.now() > session.expiresAtMs) {
    sessions.delete(loginId);
    return { done: true, error: "the sign-in timed out; start again" };
  }

  let res;
  try {
    res = await fetch(`${session.base}${API_PREFIX}/auth/token?state=${encodeURIComponent(session.state)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
  } catch {
    return { done: false };
  }
  let json;
  try {
    json = JSON.parse(await res.text());
  } catch {
    return { done: false };
  }
  const code = typeof json.code === "number" ? json.code : -1;
  if (code !== 0 && code !== 200) return { done: false };
  const data = envelopeData(json);
  const accessToken = firstString(data, ["accessToken", "access_token", "AccessToken"]);
  if (accessToken === "") return { done: false };

  session.done = true;
  try {
    const account = await collectAccount(session, accessToken, data);
    sessions.delete(loginId);
    store.saveCredential(account);
    return { done: true, account: { uid: account.uid, nickname: account.nickname, domain: account.domain } };
  } catch (error) {
    sessions.delete(loginId);
    return { done: true, error: String(error) };
  }
}
