"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const redactGitOutput = (input, secrets = []) => {
  let text = String(input ?? "").replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/gi, "$1[redacted]@")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]")
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)(?:basic|bearer)\s+[^\s]+/gi, "$1[redacted]");
  for (const secret of secrets) if (typeof secret === "string" && secret.length) text = text.split(secret).join("[redacted]");
  return text;
};
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

class GitRunner {
  constructor({ binaryPath, root, timeoutMs = 30000, maxOutputBytes = 8 * 1024 * 1024, spawnImpl = spawn, secrets = [], env = {} }) {
    if (!path.isAbsolute(binaryPath || "") || !path.isAbsolute(root || "")) throw failure("GIT_PATH_REQUIRED", "Git and project paths must be absolute.");
    this.binaryPath = fs.realpathSync(binaryPath);
    fs.accessSync(this.binaryPath, fs.constants.X_OK);
    if (!fs.statSync(this.binaryPath).isFile()) throw failure("GIT_PATH_REQUIRED", "Git executable is not a file.");
    this.root = fs.realpathSync(root);
    const stat = fs.statSync(this.root);
    if (!stat.isDirectory()) throw failure("GIT_ROOT_INVALID", "Open a project folder first.");
    this.rootIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    this.timeoutMs = timeoutMs; this.maxOutputBytes = maxOutputBytes; this.spawnImpl = spawnImpl; this.secrets = secrets; this.env = { ...env };
  }
  assertRoot() {
    const stat = fs.statSync(this.root);
    if (fs.realpathSync(this.root) !== this.root || `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== this.rootIdentity) throw failure("STALE_WORKSPACE", "The project folder changed.");
  }
  async run(args, { signal, timeoutMs = this.timeoutMs, allowFailure = false, readOnly = false, input = null } = {}) {
    this.assertRoot();
    if (!Array.isArray(args) || !args.length || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw failure("GIT_ARGS_INVALID", "Invalid Git arguments.");
    if (input !== null && !(typeof input === "string" || Buffer.isBuffer(input)) || input !== null && Buffer.byteLength(input) > 8 * 1024 * 1024) throw failure("GIT_INPUT_INVALID", "Git input exceeds the safe limit.");
    // This is a main-process service, never a renderer arbitrary-command API.
    if (signal?.aborted) throw failure("GIT_CANCELLED", "Git operation cancelled before starting.");
    const env = { ...process.env, ...this.env };
    const runtimeGitKeys = new Set(["GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_ASKPASS"]);
    // Runtime env may include the entire launching process env. Sanitize
    // after merging: repository/config/trace overrides must not retarget Git.
    for (const key of Object.keys(env)) {
      if ((/^GIT_/i.test(key) && !runtimeGitKeys.has(key)) ||
          /^(?:DOTNET_|COMPlus_|DYLD_|GCM_)/i.test(key) ||
          /^(?:SSH_ASKPASS|SSH_ASKPASS_REQUIRE|BROWSER|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key)) delete env[key];
    }
    // Restore only runtime-owned settings after removing inherited GCM/.NET
    // injection points. Do not resurrect missing keys from process.env.
    if (typeof this.env.GCM_CREDENTIAL_STORE === "string") env.GCM_CREDENTIAL_STORE = this.env.GCM_CREDENTIAL_STORE;
    env.DOTNET_MULTILEVEL_LOOKUP = "0";
    Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: this.env.GIT_ASKPASS || "", SSH_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never", GCM_INTERACTIVE: "0", GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", LANG: "C", TERM: "dumb" });
    const flags = readOnly ? ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"] : [];
    return new Promise((resolve, reject) => {
      let child; let stopReason = null; let spawnError = null; let timer; let killTimer;
      const stdout = []; const stderr = []; let outputBytes = 0;
      const stop = (code, message) => {
        if (stopReason) return;
        stopReason = { code, message };
        const kill = sig => {
          try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig); else child.kill(sig); }
          catch { try { child.kill(sig); } catch {} }
        };
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 1000);
        killTimer.unref?.();
      };
      const cancelled = () => stop("GIT_CANCELLED", "Git operation interrupted; verify its result before retrying.");
      try { child = this.spawnImpl(this.binaryPath, [...flags, ...args], { cwd: this.root, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] }); }
      catch (error) { reject(failure("GIT_START_FAILED", redactGitOutput(error.message, this.secrets))); return; }
      const collect = destination => chunk => {
        const bytes = Buffer.from(chunk); outputBytes += bytes.length;
        if (outputBytes > this.maxOutputBytes) { stop("GIT_OUTPUT_LIMIT", "Git output exceeded the safe display limit."); return; }
        destination.push(bytes);
      };
      if (input !== null) { child.stdin?.on("error", () => {}); child.stdin?.end(input); }
      child.stdout?.on("data", collect(stdout)); child.stderr?.on("data", collect(stderr));
      child.once("error", error => { spawnError = error; });
      child.once("close", (code, childSignal) => {
        clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", cancelled);
        const result = { code, signal: childSignal, stdout: Buffer.concat(stdout), stderr: redactGitOutput(Buffer.concat(stderr).toString("utf8"), this.secrets) };
        if (stopReason || spawnError || code !== 0) result.stdout = Buffer.from(redactGitOutput(result.stdout.toString("utf8"), this.secrets));
        if (stopReason) reject(failure(stopReason.code, stopReason.message, { result }));
        else if (spawnError) reject(failure("GIT_START_FAILED", redactGitOutput(spawnError.message, this.secrets), { result }));
        else if (code !== 0 && !allowFailure) reject(failure("GIT_FAILED", result.stderr.trim() || "Git operation failed.", { result }));
        else resolve(result);
      });
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted) cancelled();
      timer = setTimeout(() => stop("GIT_TIMEOUT", "Git operation timed out; verify its result before retrying."), Math.max(1, timeoutMs));
      timer.unref?.();
    });
  }
}
module.exports = { GitRunner, redactGitOutput };
