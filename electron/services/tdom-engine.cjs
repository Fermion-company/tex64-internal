"use strict";

// Real-time preview engine host (beta). Spawns the TDOM engine's server.js
// (a resident, incremental LuaLaTeX runtime — sibling repo `tdom-engine`) as a
// child Node process and proxies document pushes to it over local HTTP. TDOM
// owns compilation only; TeX64 reads canonical PDF bytes back into its normal
// PDF viewers instead of embedding the engine's preview UI.
//
// Engine directory resolution mirrors fermion-engine.cjs: a developer
// checkout wins (so editing ~/tdom-engine is picked up on the next preview
// start), with a vendored copy (Resources/tdom-engine, `npm run tdom:sync`)
// as the packaged-app fallback.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { NO_FILE_ACCESS } = require("./engine-dir.cjs");
const { getPreferredTexliveBinDirs } = require("./texlive-paths.cjs");

// Off the tdom dev default (4633) so a manually run `npm start` in the
// checkout and the embedded engine don't race for the same port.
const DEFAULT_PORT = 4646;
// First boot compiles the fork shim with cc and boots a resident lualatex —
// noticeably slower than a plain HTTP server coming up.
const DEFAULT_START_TIMEOUT_MS = 90_000;
const ENGINE_NAME = "tdom-engine";
const LEGACY_ENGINE_NAME = "tdom-core";
const MARKER = "server.js";

const isPortAvailable = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.unref();
  server.once("error", () => resolve(false));
  server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
});

const findAvailablePort = async (preferred = DEFAULT_PORT) => {
  if (await isPortAvailable(preferred)) return preferred;
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error("could not allocate a TDOM port")));
    });
  });
};

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

const requestBuffer = (url, { timeoutMs = 5_000, maxBytes = 32 * 1024 * 1024 } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if ((res.statusCode || 500) >= 400) {
        res.resume();
        reject(new Error(`tdom request failed (${res.statusCode})`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error("tdom PDF exceeds the preview size limit"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("tdom request timed out")));
    req.on("error", reject);
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

const isWithin = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
};

class TdomEngineService {
  constructor(options = {}) {
    const envDir = typeof process.env.TDOM_ENGINE_DIR === "string" && process.env.TDOM_ENGINE_DIR.trim()
      ? process.env.TDOM_ENGINE_DIR.trim()
      : typeof process.env.TEX64_TDOM_ENGINE_DIR === "string"
        ? process.env.TEX64_TDOM_ENGINE_DIR.trim()
        : "";
    const pathExists = options.existsSync || fs.existsSync;
    this.fileAccess = options.fileAccess || NO_FILE_ACCESS;
    this.envEngineDir = envDir;
    this.explicitEngineDir = options.engineDir;
    const unpackedVendoredDir = options.resourcesPath
      ? path.join(options.resourcesPath, "app.asar.unpacked", "Resources", "tdom-engine")
      : null;
    this.vendoredDir = options.vendoredDir
      || (unpackedVendoredDir && pathExists(path.join(unpackedVendoredDir, MARKER))
        ? unpackedVendoredDir
        : options.resourcesPath ? path.join(options.resourcesPath, "tdom-engine") : null);
    const directHostWebRoot = options.resourcesPath
      ? path.join(options.resourcesPath, "web")
      : null;
    const unpackedHostWebRoot = options.resourcesPath
      ? path.join(options.resourcesPath, "app.asar.unpacked", "Resources", "web")
      : null;
    // The engine is an external process and cannot read Electron's virtual
    // app.asar. Packaged builds expose only the MathLive/WYSIWYG files needed
    // by the formula editor; development uses Resources/web directly.
    this.hostWebRoot = options.hostWebRoot ||
      (unpackedHostWebRoot && pathExists(unpackedHostWebRoot)
        ? unpackedHostWebRoot
        : directHostWebRoot);
    this.workDir = options.workDir
      || (options.userDataPath ? path.join(options.userDataPath, "tdom-work") : null);
    this.homeDir = options.homeDir || os.homedir();
    this.preferredPort = options.port ?? DEFAULT_PORT;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 150;
    this.spawnImpl = options.spawnImpl || spawn;
    this.existsSync = pathExists;
    const resolved = this.resolveDirectory();
    this.engineDir = resolved.dir;
    this.needsAccess = resolved.needsAccess;
    this.proc = null;
    this.startPromise = null;
    this.lifecycleGeneration = 0;
    this.port = null;
    this.state = "stopped";
    this.lastError = null;
    this.stderrTail = [];
    this.lastSource = null;
    this.lastPath = null;
    this.lastProjectRoot = null;
    this.lastSessionKey = null;
    this.lastOverlays = new Map();
    this.lastRootMtimeMs = null;
    this.pushQueue = Promise.resolve();
  }

  resolveDirectory() {
    const selected = this.envEngineDir || this.explicitEngineDir;
    if (selected) return { dir: selected, needsAccess: null };
    const candidates = [ENGINE_NAME, LEGACY_ENGINE_NAME].flatMap((name) => [
      path.join(this.homeDir, "Library", "Application Support", "TeX64", "engines", name),
      path.join(this.homeDir, "Developer", name),
      path.join(this.homeDir, name),
      path.join(this.homeDir, "Desktop", name),
    ]);
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

  assertLifecycle(generation) {
    if (generation !== this.lifecycleGeneration) {
      throw Object.assign(new Error("Live preview startup was cancelled."), { code: "TDOM_CANCELLED" });
    }
  }

  async start() {
    if (this.isRunning() && this.state === "ready") return { ok: true, url: this.url };
    if (this.startPromise) return this.startPromise;
    const generation = this.lifecycleGeneration;
    const pending = (async () => {
      const allowed = await this.fileAccess.ensureAccess(this.engineDir, { reason: "tdom" });
      this.assertLifecycle(generation);
      if (!allowed) {
        const root = this.fileAccess.classify(this.engineDir)?.root || this.engineDir;
        const error = new Error(`TeX64 cannot start the real-time preview engine because it has no permission to access ${root}.`);
        this.state = "unavailable";
        this.lastError = error.message;
        throw error;
      }
      this.refreshDirectory();
      if (!this.isAvailable()) {
        const error = new Error(`tdom-engine was not found at ${this.engineDir}. Set TDOM_ENGINE_DIR to its checkout or run npm run tdom:sync.`);
        this.state = "unavailable";
        this.lastError = error.message;
        throw error;
      }
      this.state = "starting";
      this.lastError = null;
      return this.startProcess(generation);
    })();
    this.startPromise = pending;
    try { return await pending; }
    finally { if (this.startPromise === pending) this.startPromise = null; }
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
      // Real output-routine shipping is the fast exact-page successor to
      // glyph overlays. It runs off the keystroke path and fails closed to
      // the ordinary canonical compile for unsupported preambles.
      TDOM_SHIP: process.env.TDOM_SHIP ?? "1",
      TDOM_SHIP_PRIVATE_PDF: process.env.TDOM_SHIP_PRIVATE_PDF ?? "1",
      // Certified plain-text anchoring maps resident LuaLaTeX line output
      // onto the last canonical PDF. Unsupported rules, graphics, callbacks
      // and ambiguous SyncTeX locations fail closed to ordinary shipping.
      TDOM_CANONICAL_ANCHOR: process.env.TDOM_CANONICAL_ANCHOR ?? "1",
    };
    // Reuse TeX64's packaged pdf.js in the external TDOM process. The engine
    // is intentionally dependency-free when used standalone, so pass the
    // exact resolved module instead of making its Application Support clone
    // install another copy.
    try {
      env.TDOM_PDFJS_PATH = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    } catch {
      // No pdf.js means only the certified fast-anchor path is unavailable;
      // canonical LuaLaTeX rendering remains fully functional.
    }
    if (this.workDir) env.TDOM_WORKDIR = this.workDir;
    if (this.hostWebRoot) env.TDOM_HOST_WEB_ROOT = this.hostWebRoot;
    return env;
  }

  async startProcess(generation = this.lifecycleGeneration) {
    const port = await findAvailablePort(this.preferredPort);
    this.assertLifecycle(generation);
    this.port = port;
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
        this.assertLifecycle(generation);
        if (this.proc !== proc) throw new Error("Live preview process changed during startup.");
        this.state = "ready";
        this.lastSource = null;
        this.lastPath = null;
        this.lastProjectRoot = null;
        this.lastSessionKey = null;
        this.lastOverlays.clear();
        this.lastRootMtimeMs = null;
        return { ok: true, url: this.url };
      } catch (error) {
        this.assertLifecycle(generation);
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    this.assertLifecycle(generation);
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
    this.lastPath = null;
    this.lastProjectRoot = null;
    this.lastSessionKey = null;
    this.lastOverlays.clear();
    this.lastRootMtimeMs = null;
    this.lastError = error?.message || null;
  }

  // Push the configured root plus dirty project buffers. The service turns
  // root changes into a minimal range edit and child buffers into overlay
  // deltas; switching tabs within one project never reopens the engine.
  resolvePushSnapshot(payload = {}) {
    const workspaceRoot = typeof payload.workspaceRoot === "string" && path.isAbsolute(payload.workspaceRoot)
      ? path.resolve(payload.workspaceRoot) : null;
    const rootFile = typeof payload.rootFile === "string" ? payload.rootFile.trim() : "";
    if (!workspaceRoot || !rootFile) {
      if (typeof payload.source !== "string") throw new Error("tdom push requires source text");
      const filePath = typeof payload.path === "string" && payload.path ? path.resolve(payload.path) : null;
      return {
        source: payload.source,
        filePath,
        projectRoot: null,
        sessionKey: filePath || "legacy",
        overlays: new Map(),
        fresh: Boolean(payload.fresh),
        rootMtimeMs: null,
      };
    }

    const rootPath = path.resolve(workspaceRoot, rootFile);
    if (!isWithin(workspaceRoot, rootPath)) throw new Error("tdom root file escapes the workspace");
    const buffers = new Map();
    for (const item of Array.isArray(payload.buffers) ? payload.buffers : []) {
      const rel = typeof item?.path === "string" ? item.path.trim() : "";
      const text = typeof item?.text === "string" ? item.text : typeof item?.source === "string" ? item.source : null;
      if (!rel || text === null) continue;
      const absolute = path.resolve(workspaceRoot, rel);
      if (!isWithin(workspaceRoot, absolute)) continue;
      buffers.set(absolute, text);
    }
    let rootMtimeMs = null;
    try { rootMtimeMs = fs.statSync(rootPath).mtimeMs; } catch {}
    let source = buffers.get(rootPath);
    if (source === undefined && this.lastPath === rootPath && this.lastSource !== null
      && this.lastRootMtimeMs === rootMtimeMs) {
      source = this.lastSource;
    }
    if (source === undefined) source = fs.readFileSync(rootPath, "utf8");
    buffers.delete(rootPath);
    return {
      source,
      filePath: rootPath,
      projectRoot: workspaceRoot,
      sessionKey: `${workspaceRoot}\0${rootPath}`,
      overlays: buffers,
      fresh: Boolean(payload.fresh),
      rootMtimeMs,
    };
  }

  push(payload = {}) {
    const run = async () => {
      await this.start();
      const snapshot = this.resolvePushSnapshot(payload);
      const openTimeout = this.startTimeoutMs;
      const normalizedPath = snapshot.filePath;
      const pathChanged = normalizedPath !== this.lastPath;
      const sessionChanged = snapshot.sessionKey !== this.lastSessionKey;
      const fullOverlays = [...snapshot.overlays].map(([filePath, text]) => ({ filePath, text }));
      if (snapshot.fresh || pathChanged || sessionChanged || this.lastSource === null) {
        await requestJson(`${this.url}/open`, {
          method: "POST",
          body: {
            text: snapshot.source,
            ...(normalizedPath ? { filePath: normalizedPath } : {}),
            ...(snapshot.projectRoot ? { projectRoot: snapshot.projectRoot } : {}),
            ...(fullOverlays.length ? { overlays: fullOverlays } : {}),
          },
          timeoutMs: openTimeout,
        });
        this.lastSource = snapshot.source;
        this.lastPath = normalizedPath;
        this.lastProjectRoot = snapshot.projectRoot;
        this.lastSessionKey = snapshot.sessionKey;
        this.lastOverlays = new Map(snapshot.overlays);
        this.lastRootMtimeMs = snapshot.rootMtimeMs;
      } else {
        const overlays = [];
        for (const [filePath, text] of snapshot.overlays) {
          if (this.lastOverlays.get(filePath) !== text) overlays.push({ filePath, text });
        }
        const removeOverlays = [...this.lastOverlays.keys()].filter((filePath) => !snapshot.overlays.has(filePath));
        const sourceChanged = snapshot.source !== this.lastSource;
        if (!sourceChanged && !overlays.length && !removeOverlays.length) {
          this.lastRootMtimeMs = snapshot.rootMtimeMs;
          return { ok: true, url: this.url };
        }
        const edit = sourceChanged ? diffEdit(this.lastSource, snapshot.source) : { start: 0, end: 0, text: "" };
        try {
          await requestJson(`${this.url}/edit`, {
            method: "POST",
            body: {
              ...edit,
              ...(Number.isFinite(Number(payload.clientEditAtEpochMs))
                ? { clientEditAtEpochMs: Number(payload.clientEditAtEpochMs) }
                : {}),
              ...(overlays.length ? { overlays } : {}),
              ...(removeOverlays.length ? { removeOverlays } : {}),
            },
            timeoutMs: openTimeout,
          });
          this.lastSource = snapshot.source;
          this.lastOverlays = new Map(snapshot.overlays);
          this.lastRootMtimeMs = snapshot.rootMtimeMs;
        } catch (error) {
          // Engine and service disagree about the source (restart, external
          // change) — resync with a fresh open rather than compounding.
          await requestJson(`${this.url}/open`, {
            method: "POST",
            body: {
              text: snapshot.source,
              ...(normalizedPath ? { filePath: normalizedPath } : {}),
              ...(snapshot.projectRoot ? { projectRoot: snapshot.projectRoot } : {}),
              ...(fullOverlays.length ? { overlays: fullOverlays } : {}),
            },
            timeoutMs: openTimeout,
          });
          this.lastSource = snapshot.source;
          this.lastPath = normalizedPath;
          this.lastProjectRoot = snapshot.projectRoot;
          this.lastSessionKey = snapshot.sessionKey;
          this.lastOverlays = new Map(snapshot.overlays);
          this.lastRootMtimeMs = snapshot.rootMtimeMs;
        }
      }
      return { ok: true, url: this.url };
    };
    const result = this.pushQueue.then(run, run);
    this.pushQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async focus(payload = {}) {
    if (!this.isRunning() || this.state !== "ready" || this.lastSource === null) {
      return { ok: false, error: "live preview engine is not ready" };
    }
    const offset = Number(payload.offset);
    if (!Number.isFinite(offset)) return { ok: false, error: "focus requires a finite offset" };
    const response = await requestJson(`${this.url}/warm`, {
      method: "POST",
      body: { offset },
      timeoutMs: 2_000,
    });
    return { ok: true, ...response };
  }

  async snapshot(payload = {}) {
    if (!this.isRunning() || this.state !== "ready" || !this.url) {
      return { ok: false, error: "live preview engine is not ready" };
    }
    const status = await requestJson(`${this.url}/status`, { timeoutMs: 2_000 });
    const documentEpoch = Number(status?.documentEpoch) || 0;
    const generation = Number(status?.canonical?.id) || 0;
    const afterGeneration = Number(payload.afterGeneration) || 0;
    // documentEpoch advances as soon as a source edit lands, while the
    // canonical PDF may still be the last-good generation. Only transfer
    // bytes when the PDF generation itself advances.
    const unchanged = generation === afterGeneration;
    if (!generation || unchanged) {
      return {
        ok: true,
        unchanged: true,
        pending: Boolean(status?.canonical?.inFlight),
        documentEpoch,
        generation,
        error: status?.canonical?.error || null,
      };
    }
    const pdf = await requestBuffer(`${this.url}/canonical.pdf`, { timeoutMs: 10_000 });
    if (!pdf.length || !pdf.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
      throw new Error("tdom returned an invalid PDF snapshot");
    }
    let pdfPath = null;
    if (this.lastPath && this.lastProjectRoot && isWithin(this.lastProjectRoot, this.lastPath)) {
      pdfPath = path.relative(this.lastProjectRoot, this.lastPath)
        .split(path.sep)
        .join("/")
        .replace(/\.tex$/i, ".pdf");
    }
    return {
      ok: true,
      unchanged: false,
      documentEpoch,
      generation,
      path: pdfPath,
      mainFile: pdfPath ? pdfPath.replace(/\.pdf$/i, ".tex") : null,
      mimeType: "application/pdf",
      byteSize: pdf.length,
      data: pdf.toString("base64"),
    };
  }

  stop() {
    // Invalidate startup even before a child exists (permission / port awaits).
    this.lifecycleGeneration += 1;
    this.startPromise = null;
    const proc = this.proc;
    this.proc = null;
    this.port = null;
    this.state = "stopped";
    this.lastSource = null;
    this.lastPath = null;
    this.lastProjectRoot = null;
    this.lastSessionKey = null;
    this.lastOverlays.clear();
    this.lastRootMtimeMs = null;
    if (proc) { try { proc.kill("SIGTERM"); } catch {} }
    return { ok: true };
  }

  shutdown() { return this.stop(); }
}

module.exports = { TdomEngineService, DEFAULT_PORT, diffEdit };
