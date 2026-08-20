"use strict";

// Real-time preview engine host (beta). Spawns the TDOM engine's server.js
// (a resident, incremental LuaLaTeX runtime — sibling repo `tdom-core`) as a
// child Node process and proxies document pushes to it over local HTTP. The
// renderer embeds the engine's own preview client (`/?embed=1`) in an iframe;
// this service only owns the process lifecycle and the edit stream.
//
// Engine directory resolution mirrors fermion-engine.cjs: a developer
// checkout wins (so editing ~/tdom-core is picked up on the next preview
// start), with a vendored copy (Resources/tdom-engine, `npm run tdom:sync`)
// as the packaged-app fallback.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { NO_FILE_ACCESS } = require("./engine-dir.cjs");
const { getPreferredTexliveBinDirs } = require("./texlive-paths.cjs");
const { findAvailablePort } = require("./fermion-engine.cjs");

// Off the tdom dev default (4633) so a manually run `npm start` in the
// checkout and the embedded engine don't race for the same port.
const DEFAULT_PORT = 4646;
// First boot compiles the fork shim with cc and boots a resident lualatex —
// noticeably slower than a plain HTTP server coming up.
const DEFAULT_START_TIMEOUT_MS = 90_000;
const ENGINE_NAME = "tdom-core";
const MARKER = "server.js";

const requestJson = (url, { method = "GET", body, timeoutMs = 5_000 } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      method,
      headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode || 500) >= 400) {
          return reject(new Error(`tdom request failed (${res.statusCode}): ${text}`));
        }
        try { resolve(JSON.parse(text)); } catch { reject(new Error("tdom returned invalid JSON")); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("tdom request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

// Minimal range edit between two sources (common prefix/suffix trim), so the
// engine's checkpoint reuse sees a tight dirty range instead of a full-file
// replacement on every keystroke.
const diffEdit = (previous, next) => {
  let start = 0;
  const maxStart = Math.min(previous.length, next.length);
  while (start < maxStart && previous.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  let endPrevious = previous.length;
  let endNext = next.length;
  while (endPrevious > start && endNext > start
    && previous.charCodeAt(endPrevious - 1) === next.charCodeAt(endNext - 1)) {
    endPrevious -= 1;
    endNext -= 1;
  }
  return { start, end: endPrevious, text: next.slice(start, endNext) };
};

const uniquePaths = (items) => {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (typeof item !== "string" || !item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
};

class TdomEngineService {
  constructor(options = {}) {
    const envDir = typeof process.env.TEX64_TDOM_ENGINE_DIR === "string"
      ? process.env.TEX64_TDOM_ENGINE_DIR.trim() : "";
    this.fileAccess = options.fileAccess || NO_FILE_ACCESS;
    this.envEngineDir = envDir;
    this.explicitEngineDir = options.engineDir;
    this.vendoredDir = options.vendoredDir
      || (options.resourcesPath ? path.join(options.resourcesPath, "tdom-engine") : null);
    this.workDir = options.workDir
      || (options.userDataPath ? path.join(options.userDataPath, "tdom-work") : null);
    this.homeDir = options.homeDir || os.homedir();
    this.preferredPort = options.port ?? DEFAULT_PORT;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 150;
    this.spawnImpl = options.spawnImpl || spawn;
    this.existsSync = options.existsSync || fs.existsSync;
    const resolved = this.resolveDirectory();
    this.engineDir = resolved.dir;
    this.needsAccess = resolved.needsAccess;
    this.proc = null;
    this.startPromise = null;
    this.port = null;
    this.state = "stopped";
    this.lastError = null;
    this.stderrTail = [];
    this.lastSource = null;
    this.pushQueue = Promise.resolve();
  }

  resolveDirectory() {
    const selected = this.envEngineDir || this.explicitEngineDir;
    if (selected) return { dir: selected, needsAccess: null };
    const candidates = [
      path.join(this.homeDir, "Library", "Application Support", "TeX64", "engines", ENGINE_NAME),
      path.join(this.homeDir, "Developer", ENGINE_NAME),
      path.join(this.homeDir, ENGINE_NAME),
      path.join(this.homeDir, "Desktop", ENGINE_NAME),
    ];
    let needsAccess = null;
    for (const candidate of candidates) {
      const result = this.fileAccess.probeIfAllowed(candidate,
        () => this.existsSync(path.join(candidate, MARKER)));
      if (result === true) return { dir: candidate, needsAccess: null };
      if (result === null) needsAccess ||= this.fileAccess.classify(candidate)?.key || null;
    }
    if (this.vendoredDir && this.existsSync(path.join(this.vendoredDir, MARKER))) {
      return { dir: this.vendoredDir, needsAccess: null };
    }
    return { dir: candidates.at(2), needsAccess };
  }

  refreshDirectory() {
    const resolved = this.resolveDirectory();
    this.engineDir = resolved.dir;
    this.needsAccess = resolved.needsAccess;
  }

  isAvailable() {
    return this.fileAccess.probeIfAllowed(this.engineDir,
      () => this.existsSync(path.join(this.engineDir, MARKER))) === true;
  }

  isRunning() { return Boolean(this.proc && this.proc.exitCode === null && !this.proc.killed); }
  get url() { return this.port ? `http://127.0.0.1:${this.port}` : null; }

  getStatus() {
    return { available: this.isAvailable(), running: this.isRunning(), state: this.state,
      url: this.url, engineDir: this.engineDir, needsAccess: this.needsAccess,
      error: this.lastError };
  }

  async start() {
    if (this.isRunning() && this.state === "ready") return { ok: true, url: this.url };
    if (this.startPromise) return this.startPromise;
    const allowed = await this.fileAccess.ensureAccess(this.engineDir, { reason: "tdom" });
    if (!allowed) {
      const root = this.fileAccess.classify(this.engineDir)?.root || this.engineDir;
      const error = new Error(`TeX64 cannot start the real-time preview engine because it has no permission to access ${root}.`);
      this.state = "unavailable";
      this.lastError = error.message;
      throw error;
    }
    this.refreshDirectory();
    if (this.startPromise) return this.startPromise;
    if (!this.isAvailable()) {
      const error = new Error(`tdom-core engine was not found at ${this.engineDir}. Set TEX64_TDOM_ENGINE_DIR to its checkout or run npm run tdom:sync.`);
      this.state = "unavailable";
      this.lastError = error.message;
      throw error;
    }
    this.state = "starting";
    this.lastError = null;
    this.startPromise = this.startProcess();
    try { return await this.startPromise; } finally { this.startPromise = null; }
  }

  // The engine refuses to boot when TDOM_SAMPLE names a file that is not in
  // <engineDir>/samples, and the sample set is the engine repo's business —
  // pick a small one that actually exists instead of hardcoding a name.
  pickBootSample() {
    const samplesDir = path.join(this.engineDir, "samples");
    const preferred = ["demo-lua.tex", "minimal.tex", "demo.tex"];
    for (const name of preferred) {
      if (this.existsSync(path.join(samplesDir, name))) return name;
    }
    try {
      const candidates = fs.readdirSync(samplesDir)
        .filter((name) => name.endsWith(".tex"))
        .map((name) => {
          let size = Infinity;
          try { size = fs.statSync(path.join(samplesDir, name)).size; } catch {}
          return { name, size };
        })
        .sort((a, b) => a.size - b.size);
      if (candidates.length) return candidates[0].name;
    } catch { /* no samples dir — let the engine report it */ }
    return "demo-lua.tex";
  }

  buildSpawnEnv() {
    const pathParts = uniquePaths([
      ...getPreferredTexliveBinDirs(),
      ...(process.env.PATH || "").split(path.delimiter),
      // poppler (pdftocairo/pdftotext/pdfinfo) and cc live outside the TeX
      // tree; a Finder-launched Electron app has a minimal PATH.
      "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    ]);
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(this.port),
      PATH: pathParts.join(path.delimiter),
      // Boot on the small demo sample (the same one the engine's own tests
      // boot); the real document arrives via POST /open right after.
      TDOM_SAMPLE: process.env.TDOM_SAMPLE || this.pickBootSample(),
      // The engine keeps one forked lualatex per checkpoint (~100-300MB
      // each); cap it well below the engine's own default of 64.
      TDOM_MAX_CHECKPOINTS: process.env.TDOM_MAX_CHECKPOINTS || "8",
    };
    if (this.workDir) env.TDOM_WORKDIR = this.workDir;
    return env;
  }

  async startProcess() {
    this.port = await findAvailablePort(this.preferredPort);
    this.stderrTail = [];
    let proc;
    try {
      proc = this.spawnImpl(process.execPath, [path.join(this.engineDir, MARKER)], {
        cwd: this.engineDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: this.buildSpawnEnv(),
      });
      this.proc = proc;
    } catch (error) {
      this.handleEnd(proc, error);
      throw error;
    }
    proc.stdout.on("data", (chunk) => { const text = chunk.toString("utf8").trim(); if (text) console.log("[tdom]", text); });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (!text) return;
      console.warn("[tdom]", text);
      this.stderrTail = [...this.stderrTail, ...text.split("\n")].slice(-8);
    });
    proc.on("error", (error) => this.handleEnd(proc, error));
    proc.on("exit", (code, signal) => this.handleEnd(proc, new Error(`tdom engine exited (code=${code} signal=${signal})`)));

    const deadline = Date.now() + this.startTimeoutMs;
    let lastError;
    while (this.proc === proc && Date.now() < deadline) {
      try {
        await requestJson(`${this.url}/status`, { timeoutMs: 1_000 });
        this.state = "ready";
        this.lastSource = null;
        return { ok: true, url: this.url };
      } catch (error) { lastError = error; }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    const detail = this.stderrTail.length ? ` — ${this.stderrTail.join(" / ")}` : "";
    const error = this.proc === proc
      ? new Error(`tdom engine did not become ready within ${this.startTimeoutMs}ms${lastError ? `: ${lastError.message}` : ""}${detail}`)
      : new Error(`tdom engine failed to start${detail || (this.lastError ? ` — ${this.lastError}` : "")}`);
    if (this.proc === proc) { try { proc.kill("SIGTERM"); } catch {} }
    this.handleEnd(proc, error);
    throw error;
  }

  handleEnd(proc, error) {
    if (proc && this.proc !== proc) return;
    this.proc = null;
    this.port = null;
    this.state = "stopped";
    this.lastSource = null;
    this.lastError = error?.message || null;
  }

  // Push the full editor buffer; the service turns it into a minimal range
  // edit against the last pushed source. `fresh` (file switch) reopens the
  // document, which resets the engine's checkpoint state.
  push({ source, fresh = false } = {}) {
    if (typeof source !== "string") return Promise.reject(new Error("tdom push requires source text"));
    const run = async () => {
      await this.start();
      const openTimeout = this.startTimeoutMs;
      if (fresh || this.lastSource === null) {
        await requestJson(`${this.url}/open`, { method: "POST", body: { text: source }, timeoutMs: openTimeout });
        this.lastSource = source;
      } else if (source !== this.lastSource) {
        const edit = diffEdit(this.lastSource, source);
        try {
          await requestJson(`${this.url}/edit`, { method: "POST", body: edit, timeoutMs: openTimeout });
          this.lastSource = source;
        } catch (error) {
          // Engine and service disagree about the source (restart, external
          // change) — resync with a fresh open rather than compounding.
          await requestJson(`${this.url}/open`, { method: "POST", body: { text: source }, timeoutMs: openTimeout });
          this.lastSource = source;
        }
      }
      return { ok: true, url: this.url };
    };
    const result = this.pushQueue.then(run, run);
    this.pushQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.port = null;
    this.state = "stopped";
    this.lastSource = null;
    if (proc) { try { proc.kill("SIGTERM"); } catch {} }
    return { ok: true };
  }

  shutdown() { return this.stop(); }
}

module.exports = { TdomEngineService, DEFAULT_PORT, diffEdit };
