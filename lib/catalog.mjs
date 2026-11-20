// Model catalog: the /v3/config document the WorkBuddy APP reads.
//
// MUST be read with the APP product UA: the CLI channel answers with a strict
// subset that publishes neither modelPromotions nor modelTiers, so reading it
// as the CLI channel is the documented cause of a badge-less model list.
//
// Document shape (measured via dsh-connect-workbuddy):
//   data.models[]:  { id, name, maxInputTokens, maxOutputTokens, credits: "x0.79",
//                     reasoning, supportsToolCall, supportsImages, disabled,
//                     descriptionZh, descriptionEn }
//   data.agents[]:  [{ name: "cli", models: [id, ...] }]   <- the chat roster
//   data.modelPromotions[] + data.modelTiers[]: promo feed (夜间折扣/限时免费/...)

import { CN_BILLING_BASE, CN_CHAT_BASE, CONFIG_PATH, PRODUCT_UA, JSON_TIMEOUT_MS } from "./constants.mjs";
import { store } from "./store.mjs";

/** Hosts known to serve /v3/config; tried in order. */
const CONFIG_BASES = ["https://www.workbuddy.cn", CN_CHAT_BASE, CN_BILLING_BASE];

function envelopeData(document) {
  if (document === null || typeof document !== "object") return {};
  const d = document.data;
  return d !== null && typeof d === "object" ? d : document;
}

function parseCreditMultiplier(value) {
  if (typeof value !== "string") return undefined;
  const m = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseUpstreamModel(raw) {
  if (raw === null || typeof raw !== "object") return undefined;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (id === "" || raw.disabled === true) return undefined;
  const input = typeof raw.maxInputTokens === "number" ? raw.maxInputTokens : 0;
  const output = typeof raw.maxOutputTokens === "number" ? raw.maxOutputTokens : 0;
  if (input <= 0 || output <= 0) return undefined;
  const creditMultiplier = parseCreditMultiplier(raw.credits);
  return {
    id,
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : id,
    contextWindow: input,
    maxTokens: output,
    ...(creditMultiplier === undefined ? {} : { creditMultiplier }),
    supportsToolCall: typeof raw.supportsToolCall === "boolean" ? raw.supportsToolCall : undefined,
    supportsImages: raw.disabledMultimodal === true ? false : typeof raw.supportsImages === "boolean" ? raw.supportsImages : undefined,
    reasoning: raw.reasoning ?? undefined,
    descriptionZh: typeof raw.descriptionZh === "string" ? raw.descriptionZh : undefined,
  };
}

// ---------------------------------------------------------------------------
// Promotion activity windows: a badge is a function of the clock.
//
// Real document shape (measured 2026-11-20, CN app-channel /v3/config):
//   { id, kind: "discount", enabled, priority, modelIds: [...],
//     badge: { label, shortLabel?, color?, icon?, display?: "activeOnly" },
//     discount?: { discountedCredits: "0.50x", factor, displayMode },
//     hover: { textZh },
//     schedule: { timezone: "Asia/Shanghai",
//                 daily?: [{ start: "23:00", end: "7:50" }],
//                 validFrom?: ISO8601(+08:00), validUntil?: ISO8601 } }
//   modelTiers[]: { badge: { label: "订阅优先" }, enabled, modelIds, priority,
//                   requiredUserType } — no schedule, always on.
// ---------------------------------------------------------------------------

function minutesOfDay(tz, now) {
  // Local wall-clock minutes for the schedule's timezone.
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const [h, m] = fmt.format(now).split(":").map(Number);
    return h * 60 + m;
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

function parseHmms(s) {
  const m = /^([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?$/.exec(String(s ?? "").trim());
  if (!m) return undefined;
  return { h: Number(m[1]), m: Number(m[2]) };
}

function inDailyWindow(schedule, now) {
  const daily = schedule?.daily;
  if (!Array.isArray(daily) || daily.length === 0) return undefined;
  const tz = typeof schedule.timezone === "string" && schedule.timezone !== "" ? schedule.timezone : undefined;
  const minutesNow = minutesOfDay(tz ?? undefined, now);
  let any = false;
  for (const w of daily) {
    const start = parseHmms(w.start ?? w.startTime ?? w.start_time);
    const end = parseHmms(w.end ?? w.endTime ?? w.end_time);
    if (!start || !end) continue;
    any = true;
    const sm = start.h * 60 + start.m;
    const em = end.h * 60 + end.m;
    if (em <= sm) {
      // crosses midnight (e.g. 23:00–7:50)
      if (minutesNow >= sm || minutesNow < em) return true;
    } else if (minutesNow >= sm && minutesNow < em) {
      return true;
    }
  }
  return any ? false : undefined;
}

function inSchedule(promo, now) {
  const schedule = promo.schedule;
  if (schedule === undefined || schedule === null || typeof schedule !== "object") return true;
  const t = now.getTime();
  const validFrom = Date.parse(schedule.validFrom ?? schedule.valid_from ?? "");
  const validUntil = Date.parse(schedule.validUntil ?? schedule.valid_until ?? "");
  if (Number.isFinite(validFrom) && t < validFrom) return false;
  if (Number.isFinite(validUntil) && t >= validUntil) return false;
  const daily = inDailyWindow(schedule, now);
  if (daily === false) return false;
  return true;
}

function parseMultiplierText(value) {
  if (typeof value !== "string") return undefined;
  const m = /([0-9]*\.?[0-9]+)/.exec(value);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Everything that holds for `modelId` right now: active discount promotions
 * (highest priority first) plus standing tier badges.
 */
export function activePromos(promos, tiers, modelId, now = new Date()) {
  const hits = [];
  for (const p of Array.isArray(promos) ? promos : []) {
    if (p === null || typeof p !== "object") continue;
    if (p.enabled === false) continue;
    const idList = Array.isArray(p.modelIds) ? p.modelIds : undefined;
    if (idList && !idList.includes(modelId)) continue;
    if (!inSchedule(p, now)) continue;
    const badge = p.badge ?? {};
    const label = typeof badge.label === "string" ? badge.label : "";
    if (label === "") continue;
    hits.push({
      kind: "promo",
      label,
      priority: typeof p.priority === "number" ? p.priority : 0,
      // Discounted credit multiplier ("0.50x" -> 0.5), when the promo reprices.
      effectiveMultiplier: parseMultiplierText(p.discount?.discountedCredits),
      description: typeof p.hover?.textZh === "string" ? p.hover.textZh : undefined,
    });
  }
  for (const t of Array.isArray(tiers) ? tiers : []) {
    if (t === null || typeof t !== "object" || t.enabled === false) continue;
    if (!Array.isArray(t.modelIds) || !t.modelIds.includes(modelId)) continue;
    const label = typeof t.badge?.label === "string" ? t.badge.label : "";
    if (label === "") continue;
    hits.push({ kind: "tier", label, priority: typeof t.priority === "number" ? t.priority : 0 });
  }
  return hits.sort((a, b) => b.priority - a.priority);
}

// ---------------------------------------------------------------------------
// Fetch + project
// ---------------------------------------------------------------------------

export async function fetchCatalog() {
  const cred = store.credential;
  if (!cred?.accessToken) throw new Error("no credential; sign in first");

  let lastError;
  for (const base of CONFIG_BASES) {
    try {
      const res = await fetch(`${base}${CONFIG_PATH}`, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": PRODUCT_UA,
          Authorization: `Bearer ${cred.accessToken}`,
          "X-Requested-With": "XMLHttpRequest",
          Origin: CN_BILLING_BASE,
          Referer: `${CN_BILLING_BASE}/`,
        },
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      });
      if (!res.ok) {
        lastError = `${base} answered http ${res.status}`;
        continue;
      }
      const doc = await res.json();
      const projected = projectDocument(doc);
      if (projected.models.length > 0) {
        const result = { source: base, fetchedAt: new Date().toISOString(), ...projected };
        store.saveCatalog(result);
        return result;
      }
      lastError = `${base} answered without models`;
    } catch (error) {
      lastError = `${base}: ${error.message ?? error}`;
    }
  }
  throw new Error(`all catalog hosts failed (${lastError})`);
}

export function projectDocument(doc) {
  const data = envelopeData(doc);
  const rawModels = Array.isArray(data.models) ? data.models : [];
  const byId = new Map();
  for (const raw of rawModels) {
    const parsed = parseUpstreamModel(raw);
    if (parsed) byId.set(parsed.id, parsed);
  }
  // The `cli` agent roster is the chat-capable selection, in declared order.
  let cliIds;
  for (const agent of Array.isArray(data.agents) ? data.agents : []) {
    if (agent && agent.name === "cli" && Array.isArray(agent.models)) {
      cliIds = agent.models.filter((id) => typeof id === "string");
      break;
    }
  }
  const ids = cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()];
  const promos = Array.isArray(data.modelPromotions) ? data.modelPromotions : [];
  const tiers = Array.isArray(data.modelTiers) ? data.modelTiers : [];
  const models = ids
    .map((id) => byId.get(id))
    .filter((m) => m !== undefined)
    .map((m) => ({ ...m, promos: activePromos(promos, tiers, m.id) }))
    .map(attachDisplayName);
  return { models, promotions: promos, tiers };
}

/**
 * Display name as the app's own menu renders it: `GLM-5.3 · x0.69`, the
 * multiplier repriced by the highest-priority active discount, then the
 * active badges (`夜间折扣` / `限时免费` / `订阅优先`).
 */
function attachDisplayName(model) {
  const discount = model.promos.find((p) => p.kind === "promo" && p.effectiveMultiplier !== undefined);
  const effective = discount?.effectiveMultiplier ?? model.creditMultiplier;
  const multPart = effective === undefined ? "" : ` · x${effective.toFixed(2)}`;
  const labels = model.promos.map((p) => p.label).filter(Boolean);
  const badgePart = labels.length > 0 ? ` · ${labels.join("/")}` : "";
  return {
    ...model,
    effectiveMultiplier: effective,
    displayName: `${model.name}${multPart}${badgePart}`,
  };
}
