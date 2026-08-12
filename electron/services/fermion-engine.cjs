"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const DEFAULT_FERMION_ENGINE_DIR = "/Users/majinkuu/Desktop/fermion-tex-engine";
const DEFAULT_PORT = 4633;
const DEFAULT_START_TIMEOUT_MS = 30_000;

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
          return reject(new Error(`fermion request failed (${res.statusCode}): ${text}`));
        }
        try { resolve(JSON.parse(text)); } catch { reject(new Error("fermion returned invalid JSON")); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("fermion request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

const requestBuffer = (url, { timeoutMs = 5_000 } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          return reject(new Error(`fermion request failed (${res.statusCode}): ${buffer.toString("utf8")}`));
        }
        resolve(buffer);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("fermion request timed out")));
    req.on("error", reject);
    req.end();
  });

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
      server.close(() => port ? resolve(port) : reject(new Error("could not allocate a fermion port")));
    });
  });
};

class FermionEngineService {
  constructor(options = {}) {
    const envDir = typeof process.env.TEX64_FERMION_ENGINE_DIR === "string"
      ? process.env.TEX64_FERMION_ENGINE_DIR.trim() : "";
    this.engineDir = envDir || options.engineDir || DEFAULT_FERMION_ENGINE_DIR;
    this.nodePath = options.nodePath || "node";
    this.serverScript = options.serverScript || "server.js";
    this.preferredPort = options.port ?? DEFAULT_PORT;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 75;
    this.spawnImpl = options.spawnImpl || spawn;
    this.existsSync = options.existsSync || fs.existsSync;
    this.proc = null;
    this.startPromise = null;
    this.port = null;
    this.backend = null;
    this.state = "stopped";
    this.lastError = null;
    this.renderQueue = Promise.resolve();
  }

  isAvailable() { return this.existsSync(path.join(this.engineDir, this.serverScript)); }
  isRunning() { return Boolean(this.proc && this.proc.exitCode === null && !this.proc.killed); }
  get url() { return this.port ? `http://127.0.0.1:${this.port}` : null; }
  getStatus() {
    return { available: this.isAvailable(), running: this.isRunning(), state: this.state,
      url: this.url, backend: this.backend, engineDir: this.engineDir, error: this.lastError };
  }

  async start() {
    if (this.isRunning() && this.state === "ready") {
      return { ok: true, url: this.url, backend: this.backend };
    }
    if (this.startPromise) return this.startPromise;
    if (!this.isAvailable()) {
      const error = new Error(`fermion-tex-engine was not found at ${this.engineDir}. Set TEX64_FERMION_ENGINE_DIR to its checkout.`);
      this.state = "unavailable";
      this.lastError = error.message;
      throw error;
    }
    this.state = "starting";
    this.lastError = null;
    this.startPromise = this.startProcess();
    try { return await this.startPromise; } finally { this.startPromise = null; }
  }

  async startProcess() {
    this.port = await findAvailablePort(this.preferredPort);
    let proc;
    try {
      proc = this.spawnImpl(this.nodePath, [this.serverScript], {
        cwd: this.engineDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORT: String(this.port) },
      });
      this.proc = proc;
    } catch (error) {
      this.handleEnd(proc, error);
      throw error;
    }
    proc.stdout.on("data", (chunk) => { const text = chunk.toString("utf8").trim(); if (text) console.log("[fermion]", text); });
    proc.stderr.on("data", (chunk) => { const text = chunk.toString("utf8").trim(); if (text) console.warn("[fermion]", text); });
    proc.on("error", (error) => this.handleEnd(proc, error));
    proc.on("exit", (code, signal) => this.handleEnd(proc, new Error(`fermion engine exited (code=${code} signal=${signal})`)));

    const deadline = Date.now() + this.startTimeoutMs;
    let lastError;
    while (this.proc === proc && Date.now() < deadline) {
      try {
        const doc = await requestJson(`${this.url}/doc`, { timeoutMs: Math.min(1_000, this.startTimeoutMs) });
        this.backend = typeof doc.backend === "string" ? doc.backend : null;
        this.state = "ready";
        return { ok: true, url: this.url, backend: this.backend };
      } catch (error) { lastError = error; }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    const error = new Error(`fermion engine did not become ready within ${this.startTimeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`);
    if (this.proc === proc) { try { proc.kill("SIGTERM"); } catch {} }
    this.handleEnd(proc, error);
    throw error;
  }

  handleEnd(proc, error) {
    if (proc && this.proc !== proc) return;
    this.proc = null;
    this.port = null;
    this.backend = null;
    this.state = "stopped";
    this.lastError = error?.message || null;
  }

  async replaceDocument(source, errorMessage) {
    if (typeof source !== "string") throw new Error(errorMessage);
    await this.start();
    const doc = await requestJson(`${this.url}/doc`);
    const current = typeof doc.source === "string" ? doc.source : "";
    return requestJson(`${this.url}/edit`, {
      method: "POST",
      body: { start: 0, end: current.length, text: source },
      timeoutMs: this.startTimeoutMs,
    });
  }

  async push({ source } = {}) {
    const report = await this.replaceDocument(source, "fermion push requires source text");
    return { ok: true, url: this.url, backend: this.backend, report };
  }

  renderPdf({ source } = {}) {
    const run = async () => {
      const report = await this.replaceDocument(source, "fermion render requires source text");
      const pdf = await requestBuffer(`${this.url}/pdf`, { timeoutMs: this.startTimeoutMs });
      return { ok: true, report, pdfBase64: pdf.toString("base64") };
    };
    const result = this.renderQueue.then(run, run);
    this.renderQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.port = null;
    this.backend = null;
    this.state = "stopped";
    if (proc) { try { proc.kill("SIGTERM"); } catch {} }
    return { ok: true };
  }

  shutdown() { return this.stop(); }
}

module.exports = { FermionEngineService, DEFAULT_FERMION_ENGINE_DIR, DEFAULT_PORT, findAvailablePort, requestBuffer };
