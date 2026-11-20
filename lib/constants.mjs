// Protocol constants, extracted from the WorkBuddy cloud gateway behavior
// as implemented by dsh-connect-workbuddy (README documents the same values).

export const CN_CHAT_BASE = "https://copilot.tencent.com";
export const CN_BILLING_BASE = "https://www.codebuddy.cn";
export const GLOBAL_BASE = "https://www.workbuddy.ai";

/** The login/OAuth API prefix (both regions). */
export const API_PREFIX = "/v2/plugin";

/** Chat channel identity: the CLI agent UA, used for every chat request. */
export const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

/**
 * The WorkBuddy APP's product identity, required by /v3/config to receive the
 * app-channel document (62 models + modelPromotions/modelTiers). The CLI UA
 * answers with a strict subset and NO promotion feed.
 */
export const PRODUCT_UA = "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0";

export const CHAT_PATH = "/v2/chat/completions";
export const CONFIG_PATH = "/v3/config";
export const REFRESH_PATH = "/v2/plugin/auth/token/refresh";
export const ACCOUNT_PATH = "/v2/plugin/account";

/** Last-resort system head so the first message is always `system` (gate rule). */
export const FALLBACK_SYSTEM_PROMPT = "You are a helpful assistant.";

/**
 * System openings the gateway fingerprints as "unapproved channel" (measured,
 * 2026-10-21; case-insensitive substring match since issue #125).
 */
export const FINGERPRINT_PATTERNS = [
  /you are an ai agent powered by deepseek harness/i,
  /you are claude code, anthropic's official cli for claude/i,
  /you are a coding agent powered by the .{0,80}? model\./i,
  /you are interacting with the user through the deepseek harness web gui/i,
];

export const JSON_TIMEOUT_MS = 30_000;
export const CHAT_HEADER_TIMEOUT_MS = 300_000;
