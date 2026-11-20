// Daily check-in (Buddy 加油站): claims the daily credit reward once per day.
//
// Endpoints (billing host, NOT the chat host):
//   POST /v2/billing/meter/checkin-activity-status  → today_checked_in, streak
//   POST /v2/billing/meter/daily-checkin            → claim; idempotent upstream
//     (already checked in today → code 10001 "今天已签到")
//
// Local state: a single-record marker file (stateDir/checkin.json) holding
// ONLY today's check-in status — `{ date, checkedIn }`. A stale entry (any
// other date) is ignored/overwritten, so no history is kept. On startup or
// timer tick, a marker for today means "done, do nothing" (zero network
// calls); its absence triggers the normal status→claim flow, and every
// terminal outcome (claimed / already / 10001 / inactive) writes the marker
// so the question is only ever answered once per day. Upstream idempotency
// (code 10001) remains as the second line of defense.

import {
  CN_BILLING_BASE,
  CLIENT_UA,
  JSON_TIMEOUT_MS,
} from "./constants.mjs";
import { stateDir } from "./store.mjs";
import fs from "node:fs";
import path from "node:path";

const STATE_FILE = path.join(stateDir, "checkin.json");

function todayLocal() {
  return new Date().toLocaleDateString("sv"); // sv-SE → YYYY-MM-DD
}

/** Today's marker `{ date, checkedIn }`, or null when absent/stale. */
function todayState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return s?.date === todayLocal() && s.checkedIn === true ? s : null;
  } catch {
    return null;
  }
}

/** Persist today's check-in state (single record; overwritten daily). */
function markToday(source) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ date: todayLocal(), checkedIn: true, source, at: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    /* the marker is an optimization; failures must not break check-in */
  }
}

/** Headers for the billing-meter endpoints (same channel identity as chat). */
function billingHeaders(cred) {
  const headers = {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: CN_BILLING_BASE,
    Referer: `${CN_BILLING_BASE}/`,
    "User-Agent": CLIENT_UA,
    "Content-Type": "application/json",
    Authorization: `Bearer ${cred.accessToken}`,
  };
  if (cred.uid) headers["X-User-Id"] = cred.uid;
  else headers["X-No-User-Id"] = "1";
  if (cred.domain) headers["X-Domain"] = cred.domain;
  else headers["X-No-Department-Info"] = "1";
  return headers;
}

async function meterCall(path, cred, body = {}) {
  let res;
  try {
    res = await fetch(`${CN_BILLING_BASE}${path}`, {
      method: "POST",
      headers: billingHeaders(cred),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`billing transport error: ${error.message}`);
  }
  const text = await res.text();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`billing answered non-JSON (http ${res.status}): ${text.slice(0, 200)}`);
  }
  return { doc, status: res.status };
}

/** Full check-in status document (`data` field), or null when not signed in. */
export async function checkinStatus(cred) {
  const { doc } = await meterCall("/v2/billing/meter/checkin-activity-status", cred);
  if (doc.code !== 0 && doc.code !== 200) throw new Error(`status refused: ${doc.msg ?? JSON.stringify(doc).slice(0, 200)}`);
  return doc.data ?? null;
}

/** The local marker for today, if any (for diagnostics and the status API). */
export function todayMarker() {
  return todayState();
}

/**
 * Claim today's reward. Returns a plain summary:
 *   { action: "claimed"|"already"|"ineligible"|"done-local",
 *     credit?, streakDays?, message }
 * "done-local": today's marker exists → answered without any network call.
 * "already": the upstream status flag or code 10001 says checked in.
 */
export async function dailyCheckin(cred) {
  const local = todayState();
  if (local) {
    return { action: "done-local", message: "今天已签到（本地状态，跳过网络请求）" };
  }

  const status = await checkinStatus(cred);
  if (!status?.active) {
    markToday("inactive"); // nothing to claim today; don't re-ask until tomorrow
    return { action: "ineligible", message: "签到活动未开启或已结束" };
  }
  if (status.today_checked_in) {
    markToday("status");
    return {
      action: "already",
      credit: status.today_credit,
      streakDays: status.streak_days,
      message: `今天已签到（+${status.today_credit ?? status.daily_credit} 积分，连签 ${status.streak_days} 天）`,
    };
  }

  const { doc } = await meterCall("/v2/billing/meter/daily-checkin", cred);
  if (doc.code === 0 || doc.code === 200) {
    const data = doc.data ?? {};
    // Refresh the status for accurate streak reporting after a successful claim.
    let streakDays = data.streakDays ?? data.streak_days;
    try {
      const fresh = await checkinStatus(cred);
      if (fresh?.streak_days != null) streakDays = fresh.streak_days;
    } catch {
      /* keep the claim payload's value */
    }
    markToday("claimed");
    return {
      action: "claimed",
      credit: data.credit ?? data.todayCredit ?? status.daily_credit,
      streakDays,
      message: `签到成功（+${data.credit ?? data.todayCredit ?? status.daily_credit} 积分，连签 ${streakDays ?? "?"} 天）`,
    };
  }
  if (doc.code === 10001) {
    markToday("upstream-10001");
    return { action: "already", message: "今天已签到，请明天再来" };
  }
  throw new Error(`checkin refused (code ${doc.code}): ${doc.msg ?? JSON.stringify(doc).slice(0, 200)}`);
}
