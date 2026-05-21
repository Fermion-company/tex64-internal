const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { TexlabService } = require("../electron/services/texlab/service.cjs");

const REPO_ROOT = path.join(__dirname, "..");

// Drives the real bundled texlab binary through the transport service to verify
// Content-Length framing, spawn, and binary-path resolution end to end. Skips
// when the binary isn't present (e.g. CI before `npm run texlab:fetch`).
test("texlab transport: initialize handshake round-trips", async (t) => {
  const service = new TexlabService({ appPath: REPO_ROOT, isPackaged: false });

  if (!service.isAvailable()) {
    t.skip("texlab binary not installed (run: npm run texlab:fetch)");
    return;
  }

  const messages = [];
  let resolveInit;
  const initialized = new Promise((resolve) => {
    resolveInit = resolve;
  });

  service.setHandlers({
    onMessage: (message) => {
      messages.push(message);
      if (message && message.id === 1) {
        resolveInit(message);
      }
    },
    onStatus: () => {},
  });

  const ok = service.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      clientInfo: { name: "tex64-test" },
      rootUri: null,
      capabilities: {},
    },
  });
  assert.equal(ok, true, "send() should succeed when binary is available");
  assert.equal(service.isRunning(), true, "process should be running after send");

  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("timed out waiting for initialize response")),
      8000
    );
  });
  let response;
  try {
    response = await Promise.race([initialized, timeout]);
  } finally {
    clearTimeout(timer);
  }

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.ok(response.result, "initialize result present");
  assert.ok(response.result.capabilities, "server advertised capabilities");
  // texlab supports completion + hover among others.
  assert.ok(
    response.result.capabilities.completionProvider,
    "texlab should advertise completionProvider"
  );

  service.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  service.send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
  service.send({ jsonrpc: "2.0", method: "exit" });
  service.shutdown();
  assert.equal(service.isRunning(), false, "process should be stopped after shutdown");
});

// Bug #1 regression: a renderer reload sends a second `initialize`. The service
// must restart texlab so the fresh client talks to a pristine server. If it
// reused the already-initialized process, texlab would reject the second
// `initialize` with an error instead of returning capabilities.
test("texlab transport: a second initialize restarts the server cleanly", async (t) => {
  const service = new TexlabService({ appPath: REPO_ROOT, isPackaged: false });
  if (!service.isAvailable()) {
    t.skip("texlab binary not installed (run: npm run texlab:fetch)");
    return;
  }

  const pending = new Map();
  service.setHandlers({
    onMessage: (message) => {
      if (message && pending.has(message.id)) {
        const resolve = pending.get(message.id);
        pending.delete(message.id);
        resolve(message);
      }
    },
    onStatus: () => {},
  });
  const waitFor = (id) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for id=${id}`)), 8000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });

  const initParams = {
    processId: null,
    clientInfo: { name: "tex64-test" },
    rootUri: null,
    capabilities: {},
  };

  service.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: initParams });
  const r1 = await waitFor(1);
  assert.ok(r1.result && r1.result.capabilities, "first initialize returns capabilities");
  service.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  assert.equal(service.isRunning(), true);

  // Simulate the reloaded renderer sending a fresh initialize.
  service.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: initParams });
  const r2 = await waitFor(2);
  assert.ok(!r2.error, "second initialize must not error (server was restarted)");
  assert.ok(
    r2.result && r2.result.capabilities,
    "second initialize returns capabilities from the fresh server"
  );
  assert.equal(service.isRunning(), true, "server is running after the restart");

  service.send({ jsonrpc: "2.0", method: "exit" });
  service.shutdown();
});
