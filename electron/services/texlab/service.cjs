"use strict";

// Transport-only sidecar for the texlab language server (GPL-3.0). This process
// spawns texlab and relays Content-Length framed JSON-RPC between its stdio and
// the renderer verbatim — it does NOT interpret LSP semantics. The actual LSP
// client (handshake, request/response matching, provider glue) lives in the
// renderer; see web-src/app/lsp/. Binary resolution and lifecycle mirror the
// math-ocr service convention (dev vs app.asar.unpacked paths).

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

class TexlabService {
  constructor({ appPath, isPackaged, resourcesPath } = {}) {
    this.appPath = typeof appPath === "string" ? appPath : "";
    this.isPackaged = isPackaged === true;
    this.resourcesPath = typeof resourcesPath === "string" ? resourcesPath : "";
    this.proc = null;
    this.starting = false;
    this.stdoutBuf = Buffer.alloc(0);
    this.onMessage = null;
    this.onStatus = null;
    this.binaryPath = this.resolveBinaryPath();
  }

  platformKey() {
    return `${process.platform}-${process.arch}`;
  }

  resolveBinaryPath() {
    const key = this.platformKey();
    const exe = process.platform === "win32" ? "texlab.exe" : "texlab";
    const candidates = [];
    if (this.isPackaged && this.resourcesPath) {
      candidates.push(
        path.join(this.resourcesPath, "app.asar.unpacked", "Resources", "texlab", key, exe)
      );
    }
    if (this.appPath) {
      candidates.push(path.join(this.appPath, "Resources", "texlab", key, exe));
    }
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // ignore and try next candidate
      }
    }
    return null;
  }

  isAvailable() {
    return Boolean(this.binaryPath);
  }

  isRunning() {
    return Boolean(this.proc && this.proc.exitCode === null && !this.proc.killed);
  }

  setHandlers({ onMessage, onStatus } = {}) {
    this.onMessage = typeof onMessage === "function" ? onMessage : null;
    this.onStatus = typeof onStatus === "function" ? onStatus : null;
  }

  emitStatus(status, detail) {
    if (!this.onStatus) {
      return;
    }
    try {
      this.onStatus(status, detail ?? null);
    } catch {
      // a failing status sink must not take down the service
    }
  }

  start() {
    if (this.isRunning() || this.starting) {
      return true;
    }
    if (!this.binaryPath) {
      // The binary may have been fetched after construction; re-resolve once.
      this.binaryPath = this.resolveBinaryPath();
    }
    if (!this.binaryPath) {
      this.emitStatus("unavailable", "texlab binary not found");
      return false;
    }
    this.starting = true;
    try {
      this.proc = spawn(this.binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      this.starting = false;
      this.proc = null;
      this.emitStatus("unavailable", error && error.message ? error.message : String(error));
      return false;
    }
    this.stdoutBuf = Buffer.alloc(0);
    const proc = this.proc;
    proc.stdout.on("data", (chunk) => this.handleStdout(chunk));
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.warn("[texlab]", text);
      }
    });
    proc.on("error", (error) => {
      if (this.proc === proc) {
        this.proc = null;
      }
      this.emitStatus("stopped", error && error.message ? error.message : String(error));
    });
    proc.on("exit", (code, signal) => {
      const wasCurrent = this.proc === proc;
      if (wasCurrent) {
        this.proc = null;
        this.stdoutBuf = Buffer.alloc(0);
      }
      // Suppress the status when this process was superseded by a restart.
      if (wasCurrent) {
        this.emitStatus("stopped", `exited (code=${code} signal=${signal})`);
      }
    });
    this.starting = false;
    this.emitStatus("started", null);
    return true;
  }

  handleStdout(chunk) {
    this.stdoutBuf = Buffer.concat([this.stdoutBuf, chunk]);
    // Content-Length framed JSON-RPC (LSP base protocol).
    for (;;) {
      const headerEnd = this.stdoutBuf.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = this.stdoutBuf.slice(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed frame: drop the header and resync to avoid a stuck loop.
        this.stdoutBuf = this.stdoutBuf.slice(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.stdoutBuf.length < bodyStart + length) {
        return; // wait for the rest of the body
      }
      const body = this.stdoutBuf.slice(bodyStart, bodyStart + length).toString("utf8");
      this.stdoutBuf = this.stdoutBuf.slice(bodyStart + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      if (this.onMessage) {
        try {
          this.onMessage(message);
        } catch (error) {
          console.warn("[texlab] onMessage handler failed", error);
        }
      }
    }
  }

  send(message) {
    if (!message || typeof message !== "object") {
      return false;
    }
    // A fresh client (renderer load/reload) always begins with `initialize`. If
    // a previous texlab is still running, restart it so the new client talks to
    // a pristine server (texlab rejects a second `initialize` on one process).
    // This replaces the old did-start-loading reset, which a PDF-viewer iframe
    // load could trigger spuriously and kill texlab mid-session. The superseded
    // process's exit is suppressed because shutdown() nulls this.proc before its
    // exit handler runs.
    if (message.method === "initialize" && this.isRunning()) {
      this.shutdown();
    }
    if (!this.isRunning()) {
      if (!this.start()) {
        return false;
      }
    }
    let json;
    try {
      json = JSON.stringify(message);
    } catch {
      return false;
    }
    const payload = Buffer.from(json, "utf8");
    const head = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii");
    try {
      this.proc.stdin.write(head);
      this.proc.stdin.write(payload);
      return true;
    } catch (error) {
      console.warn("[texlab] stdin write failed", error);
      return false;
    }
  }

  shutdown() {
    const proc = this.proc;
    this.proc = null;
    this.stdoutBuf = Buffer.alloc(0);
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}

module.exports = { TexlabService };
