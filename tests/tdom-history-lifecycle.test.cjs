"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { TdomEngineService } = require("../electron/services/tdom-engine.cjs");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const options = (ensureAccess) => ({ engineDir: "/tmp/tex64-tdom-lifecycle-fixture", existsSync: () => true, port: 49739,
  fileAccess: { ensureAccess, probeIfAllowed: () => true }, pollIntervalMs: 1, startTimeoutMs: 2000 });

test("bundled engine wins over home checkouts unless explicitly overridden", t => {
  const envKeys = ["TDOM_ENGINE_DIR", "TEX64_TDOM_ENGINE_DIR"];
  const savedEnv = envKeys.map(key => process.env[key]);
  t.after(() => envKeys.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[index];
  }));
  envKeys.forEach(key => delete process.env[key]);
  const modern = "/fake/home/tdom-engine";
  const legacy = "/fake/home/tdom-core";
  const resourcesPath = "/fake/app/Resources";
  const bundled = `${resourcesPath}/tdom-engine`;
  const unpacked = `${resourcesPath}/app.asar.unpacked/Resources/tdom-engine`;
  const marker = (directory) => `${directory}/server.js`;
  const probes = [];
  const available = new Set([modern, legacy, bundled].map(marker));
  const fixture = {
    homeDir: "/fake/home",
    existsSync: candidate => { probes.push(candidate); return available.has(candidate); },
  };
  const service = new TdomEngineService({ ...fixture, resourcesPath });
  assert.equal(service.engineDir, bundled);
  assert.equal(service.isAvailable(), true);
  assert.equal(probes.some(candidate => candidate.startsWith("/fake/home/")), false);

  available.add(marker(unpacked));
  assert.equal(new TdomEngineService({ ...fixture, resourcesPath }).engineDir, unpacked);
  const missing = new TdomEngineService(fixture);
  assert.equal(missing.engineDir, null); // Neither home checkout is an implicit fallback.
  assert.equal(missing.isAvailable(), false);
  available.delete(marker(unpacked));
  available.delete(marker(bundled));
  assert.equal(new TdomEngineService({ ...fixture, resourcesPath }).isAvailable(), false);

  assert.equal(new TdomEngineService({ ...fixture, resourcesPath, engineDir: modern }).engineDir, modern);
  process.env.TEX64_TDOM_ENGINE_DIR = legacy;
  assert.equal(new TdomEngineService({ ...fixture, resourcesPath }).engineDir, legacy);
  process.env.TDOM_ENGINE_DIR = modern;
  assert.equal(new TdomEngineService({ ...fixture, resourcesPath, engineDir: legacy }).engineDir, modern);
});

test("history stop invalidates a start still waiting for access and allows a new start", async () => {
  const access = deferred(); let spawns = 0;
  const service = new TdomEngineService({ ...options(() => access.promise), spawnImpl: () => { spawns++; throw Error("unexpected spawn"); } });
  const pending = service.start();
  await service.pushQueue;
  service.stop();
  access.resolve(true);
  await assert.rejects(pending, { code: "TDOM_CANCELLED" });
  assert.equal(spawns, 0);
  assert.equal(service.state, "stopped");
  service.startProcess = async () => { spawns++; return { ok: true, url: "new-session" }; };
  assert.equal((await service.start()).url, "new-session");
  assert.equal(spawns, 1);
});

test("history stop during port allocation prevents a late spawn", async () => {
  let spawns = 0;
  const service = new TdomEngineService({ ...options(async () => true), spawnImpl: () => { spawns++; throw Error("unexpected spawn"); } });
  const pending = service.start();
  // Access has resolved and startProcess has yielded in findAvailablePort.
  await Promise.resolve();
  assert.equal(service.state, "starting");
  service.stop();
  await assert.rejects(pending, { code: "TDOM_CANCELLED" });
  assert.equal(spawns, 0);
  assert.equal(service.port, null);
});

test("late readiness cannot resurrect stopped preview; restarting can open and push source", async t => {
  const statusSeen = deferred(); const releaseStatus = deferred();
  const servers = []; let spawnCount = 0; let opens = 0;
  const service = new TdomEngineService({ ...options(async () => true), spawnImpl: (_command, _args, spawnOptions) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.exitCode = null; child.killed = false;
    const first = ++spawnCount === 1;
    const server = http.createServer(async (req, res) => {
      if (first && req.url === "/status") { statusSeen.resolve(); await releaseStatus.promise; }
      if (req.url === "/open") opens++;
      req.resume(); res.setHeader("Content-Type", "application/json"); res.end("{}");
    });
    servers.push(server); server.listen(Number(spawnOptions.env.PORT), "127.0.0.1");
    child.kill = () => { child.killed = true; return true; }; // Deliberately delayed process/HTTP response.
    return child;
  } });
  t.after(async () => { service.stop(); await Promise.all(servers.map(s => new Promise(r => s.close(r)))); });
  const oldStart = service.start();
  await statusSeen.promise;
  service.stop();
  const newStart = service.start();
  releaseStatus.resolve();
  await assert.rejects(oldStart, { code: "TDOM_CANCELLED" });
  assert.equal((await newStart).ok, true);
  assert.equal(service.state, "ready");
  assert.equal(spawnCount, 2);
  assert.equal((await service.push({ source: "\\documentclass{article}", path: "/tmp/main.tex" })).ok, true);
  assert.equal(opens, 1);
});
