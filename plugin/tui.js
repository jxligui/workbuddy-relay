// workbuddy-relay lifecycle — CLI (TUI) part.
// Ensures the relay is running while a terminal OpenCode is open, and stops it
// when the last OpenCode client exits (Desktop + CLI share one relay).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Plugin } from "@opencode/plugin/tui";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = process.env.WB_RELAY_HOME || path.join(os.homedir(), ".workbuddy-relay");
const CLIENTS_FILE = path.join(STATE_DIR, "relay-clients.json");
const LOCK_FILE = path.join(STATE_DIR, "relay.lock");
const ID = `tui-${process.pid}`;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

function readClients() {
  try {
    const doc = JSON.parse(fs.readFileSync(CLIENTS_FILE, "utf8"));
    const out = {};
    for (const [key, pid] of Object.entries(doc.clients || {})) {
      if (alive(pid)) out[key] = pid;
    }
    return out;
  } catch {
    return {};
  }
}

function writeClients(clients) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${CLIENTS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ clients }, null, 2));
    fs.renameSync(tmp, CLIENTS_FILE);
  } catch {
    /* bookkeeping must never break the client */
  }
}

function ensureRelay() {
  try {
    const child = spawn("cmd", ["/c", "start-relay.cmd"], {
      cwd: PROJECT_DIR,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    /* relay may already be running; start script is idempotent */
  }
}

function stopRelay() {
  try {
    const pid = Number.parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
    if (alive(pid)) spawn("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
  } catch {
    /* nothing to stop */
  }
}

export default Plugin.define({
  id: "workbuddy-relay.lifecycle",
  setup() {
    const clients = readClients();
    clients[ID] = process.pid;
    writeClients(clients);
    ensureRelay();
    return () => {
      const left = readClients();
      delete left[ID];
      writeClients(left);
      if (Object.keys(left).length === 0) stopRelay();
    };
  },
});
