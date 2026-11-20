"use strict";
// workbuddy-relay lifecycle — Desktop (Electron main) part.
// Bundled by hand as CommonJS: this file is copied to dist/gui-experimental.cjs.
// It keeps the relay alive while the desktop app is open and stops it when the
// app quits. The relay is shared with CLI OpenCode via a client registry, so we
// only stop it when no other client is still running.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Plugin } = require("@opencode/plugin/gui");

const PROJECT_DIR = "D:/WorkSpace/OpenCode/workbuddy-relay";
const STATE_DIR = process.env.WB_RELAY_HOME || path.join(os.homedir(), ".workbuddy-relay");
const CLIENTS_FILE = path.join(STATE_DIR, "relay-clients.json");
const LOCK_FILE = path.join(STATE_DIR, "relay.lock");

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
    const tmp = `${CLIENTS_FILE}.desktop.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ clients }, null, 2));
    fs.renameSync(tmp, CLIENTS_FILE);
  } catch {
    /* bookkeeping must never break the app */
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
    /* idempotent start script; relay may already be up */
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

module.exports = Plugin.define({
  main(ctx) {
    const id = `desktop-${process.pid}`;
    const clients = readClients();
    clients[id] = process.pid;
    writeClients(clients);
    ensureRelay();
    ctx.onCleanup(() => {
      const left = readClients();
      delete left[id];
      writeClients(left);
      if (Object.keys(left).length === 0) stopRelay();
    });
  },
});
