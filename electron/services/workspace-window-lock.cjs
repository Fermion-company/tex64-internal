"use strict";

// One folder belongs to one app process at a time. Several TeX64 processes
// share the same userData directory (File > New Window starts another one), and
// history, Git protection, comments and the AI chats of a folder are written
// back whole from memory: two processes on the same folder would overwrite each
// other. The claim is a file under userData, never inside the project.
//
// An owner counts as alive only while its pid exists AND it keeps touching the
// file, so a crashed owner whose pid was reused cannot block a folder forever.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HEARTBEAT_MS = 10_000;
const STALE_MS = 90_000;

const canonicalRoot = (rootPath) => {
  let resolved = path.resolve(rootPath);
  try {
    resolved = typeof fs.realpathSync.native === "function"
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch {
    // A folder that is about to be created has no real path yet.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

class WorkspaceWindowLock {
  constructor({ directory, pid = process.pid, now = () => Date.now(), isAlive = pidAlive, heartbeatMs = HEARTBEAT_MS, staleMs = STALE_MS } = {}) {
    this.directory = directory;
    this.pid = pid;
    this.now = now;
    this.isAlive = isAlive;
    this.heartbeatMs = heartbeatMs;
    this.staleMs = staleMs;
    this.token = crypto.randomUUID();
    this.held = new Map(); // canonical root -> lock file
    this.timer = null;
  }

  fileFor(canonical) {
    return path.join(this.directory(), `${crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32)}.json`);
  }

  ownerOf(file) {
    try {
      const stat = fs.statSync(file);
      const owner = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
      if (owner.token === this.token) return null;
      if (this.now() - stat.mtimeMs > this.staleMs) return null;
      return this.isAlive(owner.pid) ? owner : null;
    } catch {
      return null;
    }
  }

  // True when this process now owns the folder; false while another live
  // process has it open.
  claim(rootPath) {
    if (typeof rootPath !== "string" || !rootPath) return true;
    const canonical = canonicalRoot(rootPath);
    if (this.held.has(canonical)) return true;
    const file = this.fileFor(canonical);
    const payload = JSON.stringify({ pid: this.pid, token: this.token });
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          fs.writeFileSync(file, payload, { flag: "wx" });
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (this.ownerOf(file)) return false;
          fs.rmSync(file, { force: true });
        }
      }
      // Two processes replacing the same dead owner: the file names the winner.
      if (JSON.parse(fs.readFileSync(file, "utf8")).token !== this.token) return false;
    } catch {
      // A userData that cannot be written must not stop folders from opening.
      return true;
    }
    this.held.set(canonical, file);
    this.startHeartbeat();
    return true;
  }

  // Drops every claim except the folder that is open now.
  keepOnly(rootPath) {
    const keep = typeof rootPath === "string" && rootPath ? canonicalRoot(rootPath) : null;
    for (const [canonical, file] of [...this.held]) {
      if (canonical === keep) continue;
      this.held.delete(canonical);
      this.remove(file);
    }
    if (!this.held.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  releaseAll() {
    this.keepOnly(null);
  }

  remove(file) {
    try {
      if (JSON.parse(fs.readFileSync(file, "utf8")).token === this.token) fs.rmSync(file, { force: true });
    } catch {
      // Already gone, or taken over after this process stalled.
    }
  }

  startHeartbeat() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const time = new Date(this.now());
      for (const file of this.held.values()) {
        try {
          fs.utimesSync(file, time, time);
        } catch {
          // The next claim by another process decides.
        }
      }
    }, this.heartbeatMs);
    this.timer.unref?.();
  }
}

module.exports = { WorkspaceWindowLock, canonicalRoot };
