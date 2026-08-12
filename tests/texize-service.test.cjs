"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { TexizeService } = require("../electron/services/texize.cjs");

const fakeDaemon = path.join(__dirname, "fixtures", "texize-fake-daemon.cjs");

const createService = (options = {}) => new TexizeService({
  texizeDir: __dirname,
  pythonPath: process.execPath,
  daemonArgs: [fakeDaemon],
  requestTimeoutMs: 250,
  idleTimeoutMs: -1,
  ...options,
});

test("TexizeService waits for ready and round-trips snippet fields", async (t) => {
  const service = createService();
  t.after(() => service.shutdown());

  const response = await service.snippet({
    imageBase64: "data:image/png;base64,wait-for-ready",
    translate: "Japanese",
    assetsDir: "/tmp/assets",
  });

  assert.equal(response.ok, true);
  assert.equal(response.tex, "tex:wait-for-ready");
  assert.equal(response.translate, "Japanese");
  assert.deepEqual(response.assets, ["assets/figure.png"]);
  assert.equal(service.getStatus().state, "ready");
  assert.equal(service.getStatus().version, "fake-1.0");
});

test("TexizeService rejects a timed-out request and remains usable", async (t) => {
  const service = createService({ requestTimeoutMs: 50 });
  t.after(() => service.shutdown());

  await assert.rejects(() => service.snippet({ imageBase64: "timeout" }), /timed out after 50ms/);
  const response = await service.snippet({ imageBase64: "after-timeout" });
  assert.equal(response.tex, "tex:after-timeout");
});

test("TexizeService rejects pending work on death and restarts next request", async (t) => {
  const service = createService();
  t.after(() => service.shutdown());

  const first = await service.snippet({ imageBase64: "first" });
  await assert.rejects(() => service.snippet({ imageBase64: "crash" }), /exited \(code=23/);
  assert.equal(service.isRunning(), false);

  const restarted = await service.snippet({ imageBase64: "restarted" });
  assert.equal(restarted.tex, "tex:restarted");
  assert.notEqual(restarted.pid, first.pid);
});

test("TexizeService reports a missing venv Python clearly", async () => {
  const service = new TexizeService({
    texizeDir: "/missing/texize",
    pythonPath: "/missing/texize/venv/bin/python",
    existsSync: () => false,
  });
  assert.equal(service.getStatus().available, false);
  await assert.rejects(
    () => service.snippet({ imageBase64: "image" }),
    /texize Python was not found.*TEX64_TEXIZE_DIR/
  );
});

test("TexizeService sends shutdown after the idle interval", async () => {
  const service = createService({ idleTimeoutMs: 20 });
  await service.snippet({ imageBase64: "idle" });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 500;
    const poll = () => {
      if (!service.isRunning()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("daemon did not stop after idle timeout"));
      setTimeout(poll, 10);
    };
    poll();
  });
  assert.equal(service.getStatus().state, "stopped");
});
