// On-disk state: vault (credential), catalog cache, relay runtime info.
// Base dir: %USERPROFILE%\.workbuddy-relay  (or WB_RELAY_HOME override)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

export const stateDir =
  process.env.WB_RELAY_HOME || path.join(os.homedir(), ".workbuddy-relay");

const CREDENTIAL_FILE = path.join(stateDir, "credential.json");
const CATALOG_FILE = path.join(stateDir, "catalog.json");
const RUNTIME_FILE = path.join(stateDir, "relay.json");

function ensureDir() {
  fs.mkdirSync(stateDir, { recursive: true });
  if (process.platform === "win32") {
    // Best-effort ACL hardening (the token file is plaintext JSON; see the
    // dsh-connect-workbuddy WINDOWS.md notes on why mode 0600 is not enough).
    try {
      spawnSync(
        "icacls",
        [stateDir, "/inheritance:r", "/grant:r", "*S-1-3-4:(OI)(CI)(F)", "*S-1-5-18:(OI)(CI)(F)", "*S-1-5-32-544:(OI)(CI)(F)"],
        { windowsHide: true, stdio: "ignore" },
      );
    } catch {
      /* ignore */
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export const store = {
  get credential() {
    return readJson(CREDENTIAL_FILE);
  },
  saveCredential(cred) {
    writeJson(CREDENTIAL_FILE, { ...cred, savedAt: new Date().toISOString() });
  },
  clearCredential() {
    try {
      fs.rmSync(CREDENTIAL_FILE, { force: true });
    } catch {
      /* ignore */
    }
  },

  get catalog() {
    return readJson(CATALOG_FILE);
  },
  saveCatalog(cat) {
    writeJson(CATALOG_FILE, { ...cat, savedAt: new Date().toISOString() });
  },

  get runtime() {
    return readJson(RUNTIME_FILE);
  },
  saveRuntime(rt) {
    writeJson(RUNTIME_FILE, rt);
  },
};
