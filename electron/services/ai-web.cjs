"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { pathToFileURL } = require("url");

// Source builds use the current local workspace on the fixed development port.
// Packaged builds never consult settings or fall back to another service: they
// start the bundled standalone Next server on loopback and authenticate its
// health proof with a per-launch secret that is never exposed to the webview.
const DEFAULT_DEV_URL = "http://localhost:3100";
const NATIVE_RESOURCE_DIR = "tex64-ai-native";
const NATIVE_SESSION_TOKEN_ENV = "TEX64_AI_NATIVE_SESSION_TOKEN";
const NATIVE_SESSION_CHALLENGE_QUERY = "nativeChallenge";
const NATIVE_SESSION_PROOF_HEADER = "x-tex64-native-proof";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 100;
const START_ATTEMPTS = 2;
const NATIVE_ENVIRONMENT_PASSTHROUGH = new Set([
  "APPDATA",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
]);

const isHttpUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const findAvailableLoopbackPort = () =>
  new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.unref();
    reservation.once("error", reject);
    reservation.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = reservation.address();
      const port = typeof address === "object" && address ? address.port : 0;
      reservation.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error("Could not reserve a loopback port."));
      });
    });
  });

const requestHttpHealth = (url, timeoutMs = 1_000) =>
  new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Connection: "close" } }, (response) => {
      const result = {
        status: response.statusCode ?? 0,
        proof:
          typeof response.headers[NATIVE_SESSION_PROOF_HEADER] === "string"
            ? response.headers[NATIVE_SESSION_PROOF_HEADER]
            : "",
      };
      response.resume();
      resolve(result);
    });
    request.once("error", reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("AI server health request timed out."));
    });
  });

const nativeSessionHealthProof = (token, challenge) =>
  crypto.createHmac("sha256", token).update(challenge, "utf8").digest("base64url");

const equalSecret = (left, right) => {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    crypto.timingSafeEqual(leftBytes, rightBytes)
  );
};

const createNativeServerEnvironment = ({
  baseEnvironment = process.env,
  port,
  resourcesDir,
  runtimeDir,
  token,
}) => {
  const environment = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (
      typeof value === "string" &&
      NATIVE_ENVIRONMENT_PASSTHROUGH.has(key.toUpperCase())
    ) {
      environment[key] = value;
    }
  }
  return {
    ...environment,
    HOSTNAME: "127.0.0.1",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    PORT: String(port),
    ...(resourcesDir ? { TEX64_APP_RESOURCES_DIR: resourcesDir } : {}),
    TEX64_AI_NATIVE_RUNTIME_DIR: runtimeDir,
    TEX64_LOCAL_DATA_DIR: path.join(runtimeDir, "data"),
    TEX64_LOCAL_DEVELOPMENT: "false",
    [NATIVE_SESSION_TOKEN_ENV]: token,
  };
};

class AiWebService {
  constructor({
    app,
    utilityProcess,
    resourcesPath = process.resourcesPath,
    findAvailablePort = findAvailableLoopbackPort,
    requestHealth = requestHttpHealth,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  }) {
    this.app = app;
    this.utilityProcess = utilityProcess;
    this.resourcesPath = resourcesPath;
    this.findAvailablePort = findAvailablePort;
    this.requestHealth = requestHealth;
    this.startupTimeoutMs = startupTimeoutMs;
    this.nativeServer = null;
    this.startPromise = null;
    this.pendingChild = null;
    this.shuttingDown = false;
  }

  resolveDevUrl() {
    return DEFAULT_DEV_URL;
  }

  resolveNativeBundleDir() {
    if (!this.app.isPackaged) return null;
    return path.join(this.resourcesPath, NATIVE_RESOURCE_DIR);
  }

  resolveNativeRuntimeDir() {
    return path.join(this.app.getPath("userData"), "ai-native");
  }

  getNativeOrigin() {
    return this.nativeServer?.baseUrl ?? null;
  }

  async waitUntilHealthy(healthUrl, expectedProof, state) {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.shuttingDown) {
        throw new Error("AI server is shutting down.");
      }
      if (state.exited) {
        const detail = state.stderr.trim();
        throw new Error(
          `AI server exited during startup (code ${state.exitCode}).${detail ? ` ${detail}` : ""}`
        );
      }
      const result = await this.requestHealth(healthUrl).catch(() => null);
      if (
        result?.status === 200 &&
        equalSecret(result.proof ?? "", expectedProof)
      ) {
        return;
      }
      await delay(HEALTH_POLL_INTERVAL_MS);
    }
    throw new Error("AI server did not become ready in time.");
  }

  async startNativeServerOnce() {
    if (!this.utilityProcess?.fork) {
      throw new Error("Electron utilityProcess is unavailable.");
    }

    const bundleDir = this.resolveNativeBundleDir();
    const serverFile = bundleDir ? path.join(bundleDir, "server.js") : "";
    if (!serverFile || !fs.statSync(serverFile, { throwIfNoEntry: false })?.isFile()) {
      throw new Error("The bundled AI server is missing.");
    }

    const runtimeDir = this.resolveNativeRuntimeDir();
    fs.mkdirSync(runtimeDir, { recursive: true });
    const port = await this.findAvailablePort();
    const token = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.randomBytes(32).toString("base64url");
    const baseUrl = `http://127.0.0.1:${port}`;
    const healthUrl = new URL("/api/health", baseUrl);
    healthUrl.searchParams.set(NATIVE_SESSION_CHALLENGE_QUERY, challenge);
    const expectedHealthProof = nativeSessionHealthProof(token, challenge);

    const child = this.utilityProcess.fork(serverFile, [], {
      cwd: runtimeDir,
      env: createNativeServerEnvironment({
        port,
        resourcesDir: this.resourcesPath,
        runtimeDir,
        token,
      }),
      serviceName: "TeX64 AI",
      stdio: "pipe",
    });
    this.pendingChild = child;

    const state = { exited: false, exitCode: null, stderr: "" };
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk) => {
      state.stderr = `${state.stderr}${String(chunk)}`.slice(-8_192);
    });
    child.once("exit", (code) => {
      state.exited = true;
      state.exitCode = code;
      if (this.pendingChild === child) this.pendingChild = null;
      if (this.nativeServer?.child === child) this.nativeServer = null;
    });

    try {
      await this.waitUntilHealthy(healthUrl.toString(), expectedHealthProof, state);
      if (state.exited || this.shuttingDown) {
        throw new Error("AI server stopped before it became available.");
      }
      const running = { baseUrl, child };
      this.pendingChild = null;
      this.nativeServer = running;
      return running;
    } catch (error) {
      child.kill();
      if (this.pendingChild === child) this.pendingChild = null;
      throw error;
    }
  }

  async startNativeServer() {
    let lastError = null;
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      if (this.shuttingDown) throw new Error("AI server is shutting down.");
      try {
        return await this.startNativeServerOnce();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("AI server could not be started.");
  }

  async ensureNativeServer() {
    if (this.nativeServer) return this.nativeServer;
    if (!this.startPromise) {
      this.startPromise = this.startNativeServer().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  async resolveUrl() {
    if (!this.app.isPackaged) return this.resolveDevUrl();
    const server = await this.ensureNativeServer();
    return new URL(server.baseUrl).toString();
  }

  async getConfig() {
    const url = await this.resolveUrl();
    return {
      ok: true,
      url,
      preloadFileUrl: pathToFileURL(
        path.join(__dirname, "..", "ai-web-preload.cjs")
      ).toString(),
      packaged: this.app.isPackaged === true,
    };
  }

  shutdown() {
    this.shuttingDown = true;
    const children = new Set([this.pendingChild, this.nativeServer?.child]);
    for (const child of children) child?.kill?.();
    this.pendingChild = null;
    this.nativeServer = null;
  }
}

module.exports = {
  AiWebService,
  DEFAULT_DEV_URL,
  NATIVE_RESOURCE_DIR,
  NATIVE_SESSION_TOKEN_ENV,
  NATIVE_SESSION_CHALLENGE_QUERY,
  createNativeServerEnvironment,
  findAvailableLoopbackPort,
  isHttpUrl,
  nativeSessionHealthProof,
  requestHttpHealth,
};
