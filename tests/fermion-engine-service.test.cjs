"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { FermionEngineService } = require("../electron/services/fermion-engine.cjs");

const fixture = path.join(__dirname, "fixtures", "fermion-fake-engine.cjs");
const createService = () => new FermionEngineService({
  engineDir: __dirname,
  nodePath: process.execPath,
  serverScript: path.relative(__dirname, fixture),
  port: 4633,
  startTimeoutMs: 2_000,
  pollIntervalMs: 20,
});

const waitForStopped = (service) => new Promise((resolve, reject) => {
  const deadline = Date.now() + 1_000;
  const poll = () => {
    if (!service.isRunning()) return resolve();
    if (Date.now() > deadline) return reject(new Error("fake fermion did not stop"));
    setTimeout(poll, 10);
  };
  poll();
});

test("FermionEngineService starts, returns its URL, and restarts after death", async (t) => {
  const service = createService();
  t.after(() => service.shutdown());

  let first;
  try { first = await service.start(); }
  catch (error) {
    if (error?.code === "EPERM" || /listen EPERM/.test(error?.message || "")) return t.skip("loopback listeners are blocked by this sandbox");
    throw error;
  }
  assert.equal(first.ok, true);
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(first.backend, "fake");
  const firstPid = service.proc.pid;

  service.proc.kill("SIGTERM");
  await waitForStopped(service);

  const second = await service.start();
  assert.equal(second.ok, true);
  assert.notEqual(service.proc.pid, firstPid);
  assert.equal(service.getStatus().state, "ready");
});

test("FermionEngineService pushes a full source replacement", async (t) => {
  const service = createService();
  t.after(() => service.shutdown());
  let result;
  try { result = await service.push({ source: "\\documentclass{article}\nhello" }); }
  catch (error) {
    if (error?.code === "EPERM" || /listen EPERM/.test(error?.message || "")) return t.skip("loopback listeners are blocked by this sandbox");
    throw error;
  }
  assert.equal(result.ok, true);
  assert.equal(result.report.source, "\\documentclass{article}\nhello");
});
