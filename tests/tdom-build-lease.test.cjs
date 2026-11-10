"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TdomEngineService } = require("../electron/services/tdom-engine.cjs");
const { BuildService } = require("../electron/services/build/service.cjs");
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ready = () => {
  const service = new TdomEngineService();
  Object.assign(service, { proc: { exitCode: null, killed: false }, state: "ready", port: 1234 });
  return service;
};
const payload = { projectRoot: "/tmp/lease-project", mainFile: "main.tex" };
const snapshot = { projectRoot: payload.projectRoot, filePath: "/tmp/lease-project/main.tex",
  source: "source", overlays: new Map(), sessionKey: "session" };
const token = "12345678-1234-1234-1234-123456789abc";

for (const blockedBy of ["document-reset", "shipping-boot", "warming", "preview-work-settling", "starting"]) {
  test(`Build leaves ${blockedBy} wait at 1500ms and keeps the local open gate until release`, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
    const service = ready();
    if (blockedBy === "starting") service.state = "starting";
    let calls = 0;
    service.applyActiveBuildLease = async ({ timeoutMs, ttlMs }) => {
      calls++;
      assert.ok(timeoutMs <= 1500);
      assert.equal(ttlMs, 5000);
      return { statusCode: 409, reason: "resident-bootstrap-active", blockedBy, retryAfterMs: 250 };
    };
    let lease;
    const pending = service.acquireBuildLease(payload).then(value => { lease = value; });
    for (let i = 0; i < 29; i++) { await nextTurn(); t.mock.timers.tick(50); }
    await nextTurn();
    assert.equal(lease, undefined);
    t.mock.timers.tick(50);
    await pending;
    assert.equal(Date.now(), 101_500);
    assert.equal(lease.bound, false);
    assert.equal(calls > 0, blockedBy !== "starting");
    let opened = false;
    const open = service.runOutsideBuildLease(() => { opened = true; });
    await nextTurn();
    assert.equal(opened, false);
    await lease.release();
    await open;
    assert.equal(opened, true);
    assert.equal(service.activeBuildLease, null);
  });
}

async function endpoint(t, handler) {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    await handler(req, res, body ? JSON.parse(body) : null);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const service = ready();
  service.port = server.address().port;
  t.after(async () => { if (service.activeBuildLease) await service.releaseBuildLease(service.activeBuildLease); });
  return service;
}
const reply = (res, body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };

test("joining an earlier acquire request cannot extend Build's absolute deadline", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const service = ready();
  const request = deferred();
  service.applyActiveBuildLease = () => request.promise;
  const acquiring = service.acquireBuildLease(payload);
  t.mock.timers.tick(1500);
  const lease = await acquiring;
  assert.equal(lease.bound, false);
  await lease.release();
  request.resolve(null);
  assert.equal(service.activeBuildLease, null);
});

test("a second standalone file queues behind the book open and retains its own target", async t => {
  const book = deferred();
  const seen = deferred();
  const files = [];
  const service = await endpoint(t, async (req, res, body) => {
    assert.equal(req.url, "/open");
    files.push(body.filePath);
    if (files.length === 1) { seen.resolve(); await book.promise; }
    reply(res, { report: { srcRev: files.length } });
  });
  service.start = async () => ({ ok: true });
  const first = service.push({ path: "/tmp/book.tex", source: "book" });
  await seen.promise;
  const second = service.push({ path: "/tmp/test.tex", source: "small" });
  await nextTurn();
  assert.deepEqual(files, ["/tmp/book.tex"]);
  book.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(files, ["/tmp/book.tex", "/tmp/test.tex"]);
  assert.equal(service.lastPath, "/tmp/test.tex");
  assert.equal(service.lastSource, "small");
});

test("unresponsive HTTP is bounded even when the peer keeps sending bytes", async t => {
  let probeTtl;
  const service = await endpoint(t, (req, res, body) => {
    probeTtl = body.ttlMs;
    res.writeHead(200, { "Content-Type": "application/json" }); res.write(" ");
    const timer = setInterval(() => res.write(" "), 30);
    res.on("close", () => clearInterval(timer));
  });
  const started = performance.now();
  const lease = await service.acquireBuildLease(payload);
  assert.ok(performance.now() - started < 2500);
  assert.equal(lease.bound, false);
  assert.equal(probeTtl, 5000, "a lost grant can pause the remote only briefly");
  await lease.release();
});

for (const adopted of [true, false]) {
  test(`fallback waits for the existing open, reacquires identity, and ${adopted ? "imports" : "rejects stale"} Build without reopening`, async t => {
    const opening = deferred();
    let bootstrap = true;
    const routes = [];
    const identity = { documentEpoch: 7, srcRev: 4, sourceHash: "current" };
    const service = await endpoint(t, (req, res, body) => {
      routes.push(req.url);
      if (req.url.endsWith("/acquire")) return bootstrap
        ? reply(res, { reason: "resident-bootstrap-active" }, 409)
        : reply(res, { ok: true, acquired: true, token, bound: true, identity });
      if (req.url.endsWith("/renew")) return reply(res, { ok: true, renewed: true });
      if (req.url.endsWith("/release")) return reply(res, { ok: true, released: true });
      if (req.url === "/canonical/build-import") {
        assert.deepEqual(body.identity, identity);
        assert.equal(body.canonicalBuild.token, token);
        return reply(res, { ok: adopted, adopted, reason: adopted ? null : "source-identity-changed" }, adopted ? 200 : 409);
      }
      assert.fail(`unexpected request ${req.url}`);
    });
    service.inFlightOpen = { snapshot, promise: opening.promise };
    const lease = await service.acquireBuildLease(payload);
    const importing = lease.adopt({ schemaVersion: 1 });
    await nextTurn();
    assert.equal(routes.includes("/canonical/build-import"), false);
    bootstrap = false;
    service.rememberOpenedSnapshot(snapshot, 4);
    opening.resolve();
    const result = await importing;
    assert.equal(result.adopted, adopted);
    assert.equal(routes.filter(route => route === "/canonical/build-import").length, 1);
    assert.equal(routes.includes("/open"), false);
    await lease.release();
    assert.equal(service.activeBuildLease, null);
  });
}

test("a grant racing an issued open releases the remote gate before waiting for that open", async t => {
  const opening = deferred();
  let releases = 0, imports = 0;
  const service = await endpoint(t, (req, res) => {
    if (req.url.endsWith("/acquire")) return reply(res, {
      ok: true, acquired: true, token, bound: true, identity: { srcRev: 4 },
    });
    if (req.url.endsWith("/renew")) return reply(res, { ok: true, renewed: true });
    if (req.url.endsWith("/release")) {
      releases++;
      service.rememberOpenedSnapshot(snapshot, 4);
      opening.resolve();
      return reply(res, { ok: true, released: true });
    }
    assert.equal(req.url, "/canonical/build-import");
    imports++;
    assert.equal(releases, 1);
    return reply(res, { ok: true, adopted: true });
  });
  service.inFlightOpen = { snapshot, promise: opening.promise };
  const lease = await service.acquireBuildLease(payload);
  assert.equal(lease.bound, true);
  assert.equal((await lease.adopt({ schemaVersion: 1 })).adopted, true);
  assert.equal(imports, 1);
  await lease.release();
  assert.equal(releases, 2);
});

test("the next Build cancels optional adoption instead of waiting for bootstrap", async () => {
  const service = new BuildService();
  const adoption = deferred();
  let releases = 0;
  service.pendingBuildAdoption = adoption.promise;
  service.pendingBuildAdoptionLease = { release() { releases++; } };
  service.runBuild = async () => ({ kind: "success" });
  assert.equal((await service.build("/tmp", "main.tex")).kind, "success");
  assert.equal(releases, 1);
  adoption.resolve();
});

test("compatibility Build owns separate output and aux bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-lease-isolation-"));
  try {
    fs.writeFileSync(path.join(root, "main.tex"), "source");
    fs.writeFileSync(path.join(root, "main.aux"), "old aux");
    const build = new BuildService();
    const tx = build.beginPdfOutputTransaction(root, path.join(root, "main.pdf"), [], "main.tex");
    assert.notEqual(tx.stagingDir, root);
    fs.writeFileSync(path.join(tx.stagingDir, "main.aux"), "Build aux");
    assert.equal(fs.readFileSync(path.join(root, "main.aux"), "utf8"), "old aux");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
