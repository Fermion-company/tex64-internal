"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  AiWebService,
  DEFAULT_DEV_URL,
  NATIVE_SESSION_CHALLENGE_QUERY,
  NATIVE_SESSION_TOKEN_ENV,
  createNativeServerEnvironment,
  nativeSessionHealthProof,
} = require("../electron/services/ai-web.cjs");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4321;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killCount = 0;
  }

  kill() {
    this.killCount += 1;
    return true;
  }
}

const withTempBundle = async (callback) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-ai-web-"));
  const resourcesPath = path.join(temporary, "resources");
  const bundleDir = path.join(resourcesPath, "tex64-ai-native");
  const userData = path.join(temporary, "user-data");
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "server.js"), "// test server\n");
  try {
    return await callback({ bundleDir, resourcesPath, temporary, userData });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
};

test("native server environment cannot inherit hosted credentials", () => {
  const environment = createNativeServerEnvironment({
    baseEnvironment: {
      AI_GATEWAY_API_KEY: "gateway-secret",
      DATABASE_URL: "postgres://secret",
      NODE_OPTIONS: "--require=/tmp/untrusted.cjs",
      OPENAI_API_KEY: "openai-secret",
      PATH: "/usr/bin",
      TEX64_SESSION_SECRET: "session-secret",
      VERCEL_OIDC_TOKEN: "oidc-secret",
    },
    port: 43123,
    resourcesDir: "/app/resources",
    runtimeDir: "/writable/runtime",
    token: "launch-secret",
  });

  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.TEX64_LOCAL_DEVELOPMENT, "false");
  assert.equal(environment.TEX64_APP_RESOURCES_DIR, "/app/resources");
  assert.equal(environment[NATIVE_SESSION_TOKEN_ENV], "launch-secret");
  for (const key of [
    "AI_GATEWAY_API_KEY",
    "DATABASE_URL",
    "NODE_OPTIONS",
    "OPENAI_API_KEY",
    "TEX64_SESSION_SECRET",
    "VERCEL_OIDC_TOKEN",
  ]) {
    assert.equal(environment[key], undefined, `${key} must not cross the process boundary`);
  }
});

test("packaged AI config starts one loopback utility process with a session token", async () => {
  await withTempBundle(async ({ bundleDir, resourcesPath, userData }) => {
    const child = new FakeChild();
    const forks = [];
    const healthRequests = [];
    const service = new AiWebService({
      app: {
        isPackaged: true,
        getAppPath: () => "/unused",
        getPath: (name) => {
          assert.equal(name, "userData");
          return userData;
        },
      },
      utilityProcess: {
        fork: (modulePath, args, options) => {
          forks.push({ args, modulePath, options });
          return child;
        },
      },
      resourcesPath,
      findAvailablePort: async () => 43123,
      requestHealth: async (url) => {
        healthRequests.push(url);
        const fork = forks[0];
        const challenge = new URL(url).searchParams.get(
          NATIVE_SESSION_CHALLENGE_QUERY,
        );
        const token = fork.options.env[NATIVE_SESSION_TOKEN_ENV];
        return {
          status: 200,
          // A status-only response from a process that won a port race is not
          // trusted. Make the first poll prove that it retries.
          proof:
            healthRequests.length === 1
              ? "not-the-child-proof"
              : nativeSessionHealthProof(token, challenge),
        };
      },
    });

    const [first, second] = await Promise.all([service.getConfig(), service.getConfig()]);
    assert.equal(forks.length, 1);
    assert.equal(first.url, second.url);
    const url = new URL(first.url);
    const token = forks[0].options.env[NATIVE_SESSION_TOKEN_ENV];
    assert.equal(url.origin, "http://127.0.0.1:43123");
    assert.equal(url.search, "");
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(first.packaged, true);

    const fork = forks[0];
    assert.equal(fork.modulePath, path.join(bundleDir, "server.js"));
    assert.deepEqual(fork.args, []);
    assert.equal(fork.options.cwd, path.join(userData, "ai-native"));
    assert.equal(fork.options.env.HOSTNAME, "127.0.0.1");
    assert.equal(fork.options.env.PORT, "43123");
    assert.equal(fork.options.env.TEX64_APP_RESOURCES_DIR, resourcesPath);
    assert.equal(fork.options.env[NATIVE_SESSION_TOKEN_ENV], token);
    assert.equal(
      fork.options.env.TEX64_AI_NATIVE_RUNTIME_DIR,
      path.join(userData, "ai-native"),
    );
    assert.equal(
      fork.options.env.TEX64_LOCAL_DATA_DIR,
      path.join(userData, "ai-native", "data"),
    );
    const healthUrl = new URL(healthRequests[0]);
    assert.equal(healthUrl.searchParams.has("nativeToken"), false);
    assert.match(
      healthUrl.searchParams.get(NATIVE_SESSION_CHALLENGE_QUERY),
      /^[A-Za-z0-9_-]{43}$/,
    );
    assert.equal(healthRequests.length, 2);

    service.shutdown();
    assert.equal(child.killCount, 1);
  });
});

test("packaged AI config fails closed when its native server is absent", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-ai-web-missing-"));
  try {
    const service = new AiWebService({
      app: {
        isPackaged: true,
        getPath: () => temporary,
      },
      utilityProcess: { fork: () => assert.fail("must not fork a missing server") },
      resourcesPath: temporary,
    });
    await assert.rejects(service.getConfig(), /bundled AI server is missing/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("source builds use only the current local AI workspace", async () => {
  const original = process.env.TEX64_AI_WEB_URL;
  process.env.TEX64_AI_WEB_URL = "https://old-ai.example";
  try {
    const service = new AiWebService({
      app: { isPackaged: false },
    });
    const config = await service.getConfig();
    assert.equal(config.url, DEFAULT_DEV_URL);
    assert.equal("localAppDir" in config, false);
  } finally {
    if (original === undefined) delete process.env.TEX64_AI_WEB_URL;
    else process.env.TEX64_AI_WEB_URL = original;
  }
});
