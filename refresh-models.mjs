// Refresh the WorkBuddy model catalog and rewrite the `providers.workbuddy`
// section of the global opencode.json — model display names carry the
// discount badges (限时免费 / 夜间折扣 / 订阅优先), so a refresh is what
// makes promotions show up or disappear.
//
// Usage:  node refresh-models.mjs
// Needs a running relay. OpenCode keeps one alive automatically (plugin);
// outside OpenCode start it first:  node server.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const runtime = JSON.parse(readFileSync(join(homedir(), ".workbuddy-relay", "relay.json"), "utf8"));
const base = `http://127.0.0.1:${runtime.port}`;
const auth = { Authorization: `Bearer ${runtime.secret}` };

const catalog = await (await fetch(`${base}/wb/catalog`, { method: "POST", headers: auth })).json();
if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
  console.error("[refresh] catalog is empty; keeping the current config");
  process.exit(1);
}

const configPath = join(homedir(), ".config", "opencode", "opencode.json");
// Some Windows editors / PowerShell `Set-Content -Encoding UTF8` prepend a
// UTF-8 BOM, which JSON.parse rejects. Strip it defensively (and write without
// one below) so a refresh can never be blocked by the BOM again.
function readJsonFile(file) {
  let buf = readFileSync(file);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  return JSON.parse(buf.toString("utf8"));
}
const config = readJsonFile(configPath);
const port = runtime.port;

config.providers ??= {};
config.providers.workbuddy ??= { name: "WorkBuddy", package: "@opencode/ai/providers/openai-compatible" };
config.providers.workbuddy.settings = { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: runtime.secret };
config.providers.workbuddy.headers = { Authorization: `Bearer ${runtime.secret}` };

const models = {};
for (const m of catalog.models) {
  models[m.id] = {
    name: m.displayName,
    ...(m.contextWindow ? { limit: { context: m.contextWindow, output: m.maxTokens } } : {}),
    ...(m.supportsToolCall === false ? { capabilities: { tools: false } } : {}),
  };
}
config.providers.workbuddy.models = models;

// Node writes plain UTF-8 with no BOM — keeps JSON.parse happy on every read.
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
console.log(`[refresh] wrote ${catalog.models.length} models from ${catalog.source} into ${configPath}`);
for (const m of catalog.models) console.log(`  ${m.id.padEnd(24)} ${m.displayName}`);
