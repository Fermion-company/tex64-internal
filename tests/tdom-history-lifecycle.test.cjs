"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { TdomEngineService } = require("../electron/services/tdom-engine.cjs");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const options = (ensureAccess) => ({ engineDir: "/tmp/tex64-tdom-lifecycle-fixture", existsSync: () => true, port: 49739,
  fileAccess: { ensureAccess, probeIfAllowed: () => true }, pollIntervalMs: 1, startTimeoutMs: 2000 });

test("tdom-engine checkout wins while the old tdom-core name remains a fallback", () => {
  const modern = "/fake/home/tdom-engine";
  const legacy = "/fake/home/tdom-core";
  const marker = (directory) => `${directory}/server.js`;
  const service = new TdomEngineService({
    homeDir: "/fake/home",
    existsSync: (candidate) => candidate === marker(modern) || candidate === marker(legacy),
  });
  assert.equal(service.engineDir, modern);

  const fallback = new TdomEngineService({
    homeDir: "/fake/home",
    existsSync: (candidate) => candidate === marker(legacy),
  });
  assert.equal(fallback.engineDir, legacy);
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
