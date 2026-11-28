"use strict";

// One folder belongs to one app process at a time. Several TeX64 processes
// share the same userData directory (File > New Window starts another one), and
// history, Git protection, comments and the AI chats of a folder are written
// back whole from memory: two processes on the same folder would overwrite each
// other. The claim lives in app data or the per-user temporary lock directory.
//
// Ownership passes only when the owner process is gone: its pid no longer
// exists, or the pid now belongs to a process that started at another time
// (pid reuse). A quiet heartbeat alone never frees a folder: a suspended owner
// (sleep, App Nap, a debugger, a long synchronous step) is still the owner.
// The heartbeat only spares the start-time lookup while the owner is active.
//
// Claims are generations, "<folder hash>.<n>.json", each created exclusively
// (a complete temporary file hard-linked into place), so when two processes
// replace the same gone owner exactly one creates generation n + 1. The owner
// checks before every renewal and every use that its generation is still the
// newest; if another live process holds a newer one, the folder is lost to
// this process (onLost) and owns() stays false.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawnSync } = require("node:child_process");
const { temporaryLockDirectory, ensureTemporaryLockDirectory, logStorageFailure, LINK_UNSUPPORTED } = require("./app-storage.cjs");
const storageError = (error) => typeof error?.code === "string" && /^E[A-Z0-9]+$/.test(error.code);

const HEARTBEAT_MS = 10_000;
const STALE_MS = 90_000;
// Our own start time comes from process.uptime(), another process's from the
// OS; they agree to well within this.
const START_TOLERANCE_MS = 5_000;

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

const linuxStartTime = (pid, read = fs.readFileSync) => {
  const stat = read(`/proc/${pid}/stat`, "utf8");
  const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  const boot = Number(/^btime (\d+)$/m.exec(read("/proc/stat", "utf8"))?.[1]);
  return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + (ticks / 100) * 1000 : null;
};

// The command that prints a process's start time, its options, its default
// timeout and how to read its output.
const startTimeQuery = (pid, platform) => platform === "win32" ? {
  file: "powershell.exe",
  args: ["-NoProfile", "-NonInteractive", "-Command",
    `try { ([DateTimeOffset](Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds() } catch { '' }`],
  options: { windowsHide: true },
  timeout: 10_000,
  parse: (stdout) => {
    const value = Number(String(stdout || "").trim());
    return value > 0 ? value : null;
  },
} : {
  file: "ps",
  args: ["-o", "lstart=", "-p", String(Number(pid))],
  options: { env: { ...process.env, LC_ALL: "C" } },
  timeout: 5_000,
  parse: (stdout) => {
    const value = Date.parse(String(stdout || "").trim());
    return Number.isFinite(value) ? value : null;
  },
};

// When the process with this pid started (ms since the epoch), or null when
// the OS cannot say. Only asked when an owner's heartbeat has gone quiet.
const processStartTime = (pid, timeout) => {
  try {
    if (process.platform === "linux") return linuxStartTime(pid);
    const query = startTimeQuery(pid, process.platform);
    const out = spawnSync(query.file, query.args, { ...query.options, encoding: "utf8", timeout: timeout ?? query.timeout });
    return out.status === 0 ? query.parse(out.stdout) : null;
  } catch {
    return null;
  }
};

// The same answer without blocking the event loop (PowerShell alone can take
// seconds to start). One query per pid runs at a time and its answer is
// reused briefly, so callers that poll a lock share it.
const START_TIME_REUSE_MS = 5_000;
const startTimeLookups = new Map();
const processStartTimeAsync = (pid, {
  timeout, platform = process.platform, run = execFile, read = fs.readFileSync,
  cache = startTimeLookups, now = Date.now,
} = {}) => {
  pid = Number(pid);
  const cached = cache.get(pid);
  if (cached && (cached.settledAt === undefined || now() - cached.settledAt < START_TIME_REUSE_MS)) return cached.promise;
  const entry = {};
  entry.promise = new Promise((resolve) => {
    if (platform === "linux") {
      try { resolve(linuxStartTime(pid, read)); } catch { resolve(null); }
      return;
    }
    const query = startTimeQuery(pid, platform);
    try {
      run(query.file, query.args, { ...query.options, encoding: "utf8", timeout: timeout ?? query.timeout, maxBuffer: 64 * 1024 },
        (error, stdout) => resolve(error ? null : query.parse(stdout)));
    } catch {
      resolve(null);
    }
  }).then((value) => {
    entry.settledAt = now();
    return value;
  });
  cache.set(pid, entry);
  return entry.promise;
};

class WorkspaceWindowLock {
  constructor({
    directory,
    pid = process.pid,
    startedAt = Date.now() - process.uptime() * 1000,
    now = () => Date.now(),
    isAlive = pidAlive,
    startTimeOf = processStartTime,
    startTimeAsync = processStartTimeAsync,
    heartbeatMs = HEARTBEAT_MS,
    staleMs = STALE_MS,
    onLost = () => {},
  } = {}) {
    this.directory = directory;
    this.pid = pid;
    this.startedAt = startedAt;
    this.now = now;
    this.isAlive = isAlive;
    this.startTimeOf = startTimeOf;
    this.startTimeAsync = startTimeAsync;
    this.heartbeatMs = heartbeatMs;
    this.staleMs = staleMs;
    this.onLost = onLost;
    this.token = crypto.randomUUID();
    this.held = new Map(); // canonical root -> { base, gen, file }
    this.unprotected = new Set();
    this.timer = null;
    this.known = new Map(); // pid -> { value, at }: answers of startTimeAsync
    this.refreshing = new Map();
    this.blocking = false;
  }

  // A process's start time without waiting for the OS: the last answer of the
  // asynchronous lookup, renewed in the background once it is a few seconds
  // old. With no answer yet, the synchronous claim() asks the OS directly and
  // every other check leaves the claim undecided (verify() returns null).
  startTime(pid) {
    const known = this.known.get(pid);
    if (known && this.now() - known.at < START_TIME_REUSE_MS) return known.value;
    if (this.blocking && !known) return this.startTimeOf(pid);
    void this.refresh(pid);
    if (known) return known.value;
    throw new Error("Workspace claim could not be verified.");
  }

  refresh(pid) {
    if (!this.refreshing.has(pid)) {
      this.refreshing.set(pid, Promise.resolve()
        .then(() => this.startTimeAsync(pid))
        .catch(() => null)
        .then((value) => {
          this.known.set(pid, { value: Number.isFinite(value) ? value : null, at: this.now() });
          this.refreshing.delete(pid);
        }));
    }
    return this.refreshing.get(pid);
  }

  baseFor(canonical) {
    return crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
  }

  // Every claim generation of a folder, newest first. Older TeX64 builds wrote
  // "<hash>.json"; it counts as generation 0.
  records(base, dir) {
    const pattern = new RegExp(`^${base}(?:\\.(\\d+))?\\.json$`);
    const records = [];
    for (const name of fs.readdirSync(dir)) {
      const match = pattern.exec(name);
      if (!match) continue;
      const file = path.join(dir, name);
      let owner = null;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
        owner = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") continue; // removed since readdir
        // A fallback exclusive create can be visible before it is complete.
      }
      records.push({ gen: match[1] === undefined ? 0 : Number(match[1]), file, owner, mtimeMs });
    }
    return records.sort((a, b) => b.gen - a.gen);
  }

  newest(base, dir) {
    const [top] = this.records(base, dir);
    if (top && (!Number.isInteger(top.owner?.pid) || top.owner.pid <= 0 ||
        typeof top.owner.token !== "string" || !top.owner.token)) {
      throw new Error("Workspace claim could not be verified.");
    }
    return top;
  }

  // Whether the process that wrote this claim still runs.
  ownerAlive(owner, mtimeMs) {
    if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    if (owner.token === this.token) return true;
    // This pid is ours now: the claim is from an earlier process that had it.
    if (owner.pid === this.pid) return false;
    if (!this.isAlive(owner.pid)) return false;
    if (this.now() - mtimeMs <= this.staleMs) return true;
    // Quiet for a while: suspended, or the pid now belongs to another program.
    const started = this.startTime(owner.pid);
    if (Number.isFinite(started) && Number.isFinite(owner.startedAt)) {
      return Math.abs(started - owner.startedAt) <= START_TOLERANCE_MS;
    }
    // Cannot tell: never take a folder from a process that may be its owner.
    return true;
  }

  // Creates generation `gen` for `base` if nobody has yet; null if someone did.
  create(base, gen, dir) {
    const file = path.join(dir, `${base}.${gen}.json`);
    const temporary = path.join(dir, `${base}.${gen}.${this.token}.tmp`);
    try {
      const bytes = JSON.stringify({ pid: this.pid, token: this.token, startedAt: this.startedAt });
      fs.writeFileSync(temporary, bytes, { mode: 0o600 });
      try {
        fs.linkSync(temporary, file);
      } catch (error) {
        if (error.code === "EEXIST") return null;
        if (!LINK_UNSUPPORTED.has(error.code)) throw error;
        // No hard links on this volume: exclusive create (a reader may briefly
        // see it empty, which only delays the next claim).
        try {
          fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
        } catch (fallbackError) {
          if (fallbackError.code === "EEXIST") return null;
          throw fallbackError;
        }
      }
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
    return { base, gen, file, dir };
  }

  // Takes the folder when its newest claim has no live owner. Returns the new
  // claim, or null while a live process holds it.
  acquire(base, dir) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const top = this.newest(base, dir);
      if (top && top.owner?.token !== this.token && this.ownerAlive(top.owner, top.mtimeMs)) return null;
      const claim = this.create(base, (top?.gen ?? 0) + 1, dir);
      if (!claim) continue; // another process created that generation first
      const records = this.records(base, dir);
      if (records[0]?.gen !== claim.gen || records[0]?.owner?.token !== this.token) {
        this.remove(claim.file);
        continue;
      }
      for (const record of records) {
        if (record.gen < claim.gen) {
          try { fs.unlinkSync(record.file); } catch {}
        }
      }
      return claim;
    }
    throw new Error("Workspace claim could not be verified.");
  }

  directories() {
    return [this.directory(), path.join(temporaryLockDirectory(), "open-workspaces")];
  }

  acquireAvailable(base) {
    const directories = this.directories();
    // A fallback claim still counts if app data becomes writable again.
    for (const dir of directories) {
      try {
        const top = this.newest(base, dir);
        if (top && top.owner.token !== this.token && this.ownerAlive(top.owner, top.mtimeMs)) return false;
      } catch (error) {
        if (!storageError(error)) throw error;
      }
    }
    let failure;
    for (const [index, dir] of directories.entries()) {
      try {
        if (index === 1) ensureTemporaryLockDirectory(path.dirname(dir));
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        return this.acquire(base, dir) ?? false;
      } catch (error) {
        if (!storageError(error)) throw error;
        failure = error;
      }
    }
    logStorageFailure("workspace folder locks", failure);
    return null;
  }

  claim(rootPath) {
    this.blocking = true;
    try {
      return this.claimNow(rootPath);
    } finally {
      this.blocking = false;
    }
  }

  // claim() for the main process: it first learns, off the event loop, the
  // start time of every quiet live owner this claim has to judge.
  async claimAsync(rootPath) {
    if (typeof rootPath === "string" && rootPath) {
      const base = this.baseFor(canonicalRoot(rootPath));
      const quiet = new Set();
      for (const dir of this.directories()) {
        try {
          const top = this.newest(base, dir);
          const owner = top?.owner;
          if (owner && owner.token !== this.token && owner.pid !== this.pid && this.isAlive(owner.pid) &&
              this.now() - top.mtimeMs > this.staleMs) quiet.add(owner.pid);
        } catch {
          // Unreadable here: the claim itself decides.
        }
      }
      await Promise.all([...quiet].map((pid) => this.refresh(pid)));
    }
    return this.claimNow(rootPath);
  }

  claimNow(rootPath) {
    if (typeof rootPath !== "string" || !rootPath) return true;
    const canonical = canonicalRoot(rootPath);
    if (this.held.has(canonical)) return this.verify(canonical) !== false;
    return this.reclaim(canonical) !== false;
  }

  reclaim(canonical) {
    this.unprotected.delete(canonical);
    let claim;
    try {
      claim = this.acquireAvailable(this.baseFor(canonical));
    } catch {
      // An incomplete claim can be a live owner still publishing it.
      return null;
    }
    if (claim === null) this.unprotected.add(canonical);
    if (!claim) return claim;
    this.held.set(canonical, claim);
    this.startHeartbeat();
    return true;
  }

  verify(canonical) {
    const mine = this.held.get(canonical);
    if (!mine) return false;
    try {
      const top = this.newest(mine.base, mine.dir);
      if (top && top.gen === mine.gen && top.owner?.token === this.token) return true;
    } catch (error) {
      if (!storageError(error)) return null;
    }
    const recovered = this.reclaim(canonical);
    if (recovered !== false) return recovered;
    this.held.delete(canonical);
    this.stopHeartbeatIfIdle();
    try {
      this.onLost(canonical);
    } catch {
      // The notice is best effort; the folder stays lost either way.
    }
    return false;
  }

  owns(rootPath) {
    if (typeof rootPath !== "string" || !rootPath) return false;
    return this.verify(canonicalRoot(rootPath)) === true;
  }

  permitsWrites(rootPath) {
    if (typeof rootPath !== "string" || !rootPath) return false;
    const canonical = canonicalRoot(rootPath);
    const result = this.held.has(canonical) ? this.verify(canonical)
      : this.unprotected.has(canonical) ? this.reclaim(canonical) : false;
    return result === true || this.unprotected.has(canonical);
  }

  // Drops every claim except the folder that is open now.
  keepOnly(rootPath) {
    const keep = typeof rootPath === "string" && rootPath ? canonicalRoot(rootPath) : null;
    for (const canonical of this.unprotected) if (canonical !== keep) this.unprotected.delete(canonical);
    for (const [canonical, claim] of [...this.held]) {
      if (canonical === keep) continue;
      this.held.delete(canonical);
      this.remove(claim.file);
    }
    this.stopHeartbeatIfIdle();
  }

  releaseAll() {
    this.keepOnly(null);
  }

  remove(file) {
    try {
      if (JSON.parse(fs.readFileSync(file, "utf8")).token === this.token) fs.rmSync(file, { force: true });
    } catch {
      // Already gone, or taken over by a newer claim.
    }
  }

  stopHeartbeatIfIdle() {
    if (!this.held.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  startHeartbeat() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const time = new Date(this.now());
      for (const canonical of [...this.held.keys()]) {
        if (!this.verify(canonical)) continue;
        try {
          fs.utimesSync(this.held.get(canonical).file, time, time);
        } catch {
          // The next verify decides.
        }
      }
    }, this.heartbeatMs);
    this.timer.unref?.();
  }
}

module.exports = { WorkspaceWindowLock, canonicalRoot, pidAlive, processStartTime, processStartTimeAsync };
