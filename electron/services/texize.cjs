"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { resolveEngineDir, NO_FILE_ACCESS } = require("./engine-dir.cjs");

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const SHUTDOWN_GRACE_MS = 5_000;

class TexizeService {
  constructor(options = {}) {
    const envTexizeDir = typeof process.env.TEX64_TEXIZE_DIR === "string"
      ? process.env.TEX64_TEXIZE_DIR.trim()
      : "";
    this.fileAccess = options.fileAccess || NO_FILE_ACCESS;
    this.explicitTexizeDir = options.texizeDir;
    this.envTexizeDir = envTexizeDir;
    this.existsSync = options.existsSync || fs.existsSync;
    const resolved = this.resolveDirectory();
    this.texizeDir = resolved.dir;
    this.needsAccess = resolved.needsAccess;
    this.explicitPythonPath = options.pythonPath;
    this.pythonPath = options.pythonPath || path.join(this.texizeDir, "venv", "bin", "python");
    this.daemonArgs = options.daemonArgs || ["-m", "ocr2tex.serve"];
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.spawnImpl = options.spawnImpl || spawn;

    this.proc = null;
    this.startPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.readyTimer = null;
    this.stdoutBuffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.idleTimer = null;
    this.forceKillTimer = null;
    this.version = null;
    this.state = "stopped";
    this.lastError = null;
  }

  resolveDirectory() {
    return resolveEngineDir({ name: "texize", marker: "venv/bin/python", envDir: this.envTexizeDir,
      explicitDir: this.explicitTexizeDir, existsSync: this.existsSync, fileAccess: this.fileAccess });
  }

  refreshDirectory() {
    const resolved = this.resolveDirectory();
    this.texizeDir = resolved.dir;
    this.needsAccess = resolved.needsAccess;
    if (!this.explicitPythonPath) this.pythonPath = path.join(this.texizeDir, "venv", "bin", "python");
  }

  isAvailable() {
    return this.fileAccess.probeIfAllowed(this.pythonPath, () => this.existsSync(this.pythonPath)) === true;
  }

  isRunning() {
    return Boolean(this.proc && this.proc.exitCode === null && !this.proc.killed);
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.isRunning(),
      state: this.state,
      version: this.version,
      texizeDir: this.texizeDir,
      needsAccess: this.needsAccess,
      error: this.lastError,
    };
  }

  async snippet({ imageBase64, translate, assetsDir } = {}) {
    if (typeof imageBase64 !== "string" || !imageBase64.trim()) {
      throw new Error("texize snippet requires a non-empty imageBase64 string");
    }
    const comma = imageBase64.indexOf(",");
    const imageB64 = imageBase64.startsWith("data:") && comma >= 0
      ? imageBase64.slice(comma + 1)
      : imageBase64;
    const request = { op: "snippet", image_b64: imageB64 };
    if (typeof translate === "string" && translate.trim()) {
      request.translate = translate.trim();
    }
    if (typeof assetsDir === "string" && assetsDir.trim()) {
      request.assets_dir = assetsDir.trim();
    }
    return this.request(request);
  }

  async request(payload) {
    await this.ensureReady();
    const id = this.nextId++;
    const message = { ...payload, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`texize request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(`${JSON.stringify(message)}\n`);
        this.scheduleIdleShutdown();
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async ensureReady() {
    if (this.isRunning() && this.state === "ready") {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    const allowed = await this.fileAccess.ensureAccess(this.texizeDir, { reason: "texize" });
    if (!allowed) {
      const root = this.fileAccess.classify(this.texizeDir)?.root || this.texizeDir;
      const error = new Error(`TeX64 cannot start texize because it has no permission to access ${root}.`);
      this.lastError = error.message;
      this.state = "unavailable";
      throw error;
    }
    this.refreshDirectory();
    if (this.startPromise) return this.startPromise;
    if (!this.isAvailable()) {
      const error = new Error(
        `texize Python was not found at ${this.pythonPath}. ` +
        "Set TEX64_TEXIZE_DIR to a texize checkout with venv/bin/python."
      );
      this.lastError = error.message;
      this.state = "unavailable";
      throw error;
    }

    this.state = "starting";
    this.lastError = null;
    this.stdoutBuffer = "";
    this.startPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const startPromise = this.startPromise;
    const readyTimeoutMs = Math.max(this.requestTimeoutMs, 1_000);
    this.readyTimer = setTimeout(() => {
      if (this.proc) {
        try { this.proc.kill("SIGTERM"); } catch {}
      }
      this.handleProcessEnd(this.proc, new Error(
        `texize daemon did not become ready within ${readyTimeoutMs}ms`
      ));
    }, readyTimeoutMs);
    this.readyTimer.unref?.();

    let proc;
    try {
      proc = this.spawnImpl(this.pythonPath, this.daemonArgs, {
        cwd: this.texizeDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
      this.proc = proc;
    } catch (error) {
      this.handleProcessEnd(proc, error);
      return startPromise;
    }

    proc.stdout.on("data", (chunk) => this.handleStdout(proc, chunk));
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.warn("[texize]", text);
    });
    proc.on("error", (error) => this.handleProcessEnd(proc, error));
    proc.on("exit", (code, signal) => {
      this.handleProcessEnd(proc, new Error(`texize daemon exited (code=${code} signal=${signal})`));
    });
    return startPromise;
  }

  handleStdout(proc, chunk) {
    if (this.proc !== proc) return;
    this.stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        console.warn("[texize] ignored malformed stdout line");
        continue;
      }
      if (message.ready === true && this.state === "starting") {
        this.version = typeof message.version === "string" ? message.version : null;
        this.state = "ready";
        const resolve = this.readyResolve;
        this.readyResolve = null;
        this.readyReject = null;
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = null;
        this.startPromise = null;
        if (resolve) resolve();
        this.scheduleIdleShutdown();
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      this.scheduleIdleShutdown();
      if (message.ok === true) {
        pending.resolve(message);
      } else {
        pending.reject(new Error(message.error || "texize request failed"));
      }
    }
  }

  handleProcessEnd(proc, error) {
    if (proc && this.proc !== proc) return;
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
    this.forceKillTimer = null;
    this.clearIdleTimer();
    this.proc = null;
    this.stdoutBuffer = "";
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    const message = error?.message || "texize daemon stopped";
    this.lastError = message;
    this.state = "stopped";
    const rejectReady = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    this.startPromise = null;
    if (rejectReady) rejectReady(new Error(message));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  scheduleIdleShutdown() {
    this.clearIdleTimer();
    if (!this.isRunning() || this.idleTimeoutMs < 0) return;
    this.idleTimer = setTimeout(() => this.shutdown(), this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  shutdown() {
    this.clearIdleTimer();
    const proc = this.proc;
    if (!proc) return;
    this.state = "stopping";
    try {
      proc.stdin.write(`${JSON.stringify({ id: this.nextId++, op: "shutdown" })}\n`);
    } catch {
      try { proc.kill("SIGTERM"); } catch {}
      return;
    }
    this.forceKillTimer = setTimeout(() => {
      if (this.proc === proc) {
        try { proc.kill("SIGTERM"); } catch {}
      }
    }, SHUTDOWN_GRACE_MS);
    this.forceKillTimer.unref?.();
  }
}

module.exports = {
  TexizeService,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
};
