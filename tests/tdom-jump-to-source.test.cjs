"use strict";
// TdomEngineService.jumpToSource: the live preview's own answer for a Jump
// (server /synctex/jump), asked when the last Build has none.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { TdomEngineService } = require("../electron/services/tdom-engine.cjs");

const root = path.resolve("/tmp/tex64-jump-project");
const main = path.join(root, "main.tex");
const chapter = path.join(root, "ch", "one.tex");

// A stand-in engine: /status and /synctex/jump answered by the test.
const engine = async (t, { status, jump }) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ url: req.url, body: parsed });
      const reply = req.url === "/status" ? status(requests) : jump(parsed, requests);
      res.writeHead(reply?.httpStatus ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply?.httpStatus ? { error: "bad" } : reply));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const service = new TdomEngineService({ engineDir: "/tmp/tex64-jump-fixture", existsSync: () => true,
    fileAccess: { ensureAccess: async () => true, probeIfAllowed: () => true } });
  service.port = server.address().port;
  service.proc = { exitCode: null, killed: false };
  service.state = "ready";
  service.lastPath = main;
  service.lastProjectRoot = root;
  return { service, requests };
};

const status = (extra = {}) => () => ({ up: true, srcRev: 7, documentEpoch: 3, ...extra });
const box = { left: 72, top: 300, right: 500, bottom: 312 };

test("a current canonical pass answers with its page and boxes", async (t) => {
  const { service, requests } = await engine(t, {
    status: status(),
    jump: (body) => ({ page: 4, boxes: [box, { ...box, top: 314, bottom: 326 }], id: 9, srcRev: body.srcRev,
      documentEpoch: body.documentEpoch, line: body.line }),
  });
  const answer = await service.jumpToSource({ projectRoot: root, filePath: chapter, line: 12 });
  assert.deepEqual(answer, {
    status: "hit", page: 4, boxes: [box, { ...box, top: 314, bottom: 326 }], rootPath: main,
    // the revision the place is of: the viewer may take it as exact on that revision
    revision: { documentEpoch: 3, srcRev: 7, canonicalId: 9 },
  });
  const asked = requests.find((request) => request.url === "/synctex/jump").body;
  // named as the viewer names it, relative to the project the engine opened
  assert.deepEqual(asked, { file: "ch/one.tex", line: 12, documentEpoch: 3, srcRev: 7 });
});

test("a root spelled through a symlink is the same project", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-jump-real-"));
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  t.after(() => { fs.rmSync(link, { force: true }); fs.rmSync(real, { recursive: true, force: true }); });
  const { service, requests } = await engine(t, {
    status: status(),
    jump: (body) => ({ page: 2, boxes: [box], srcRev: body.srcRev, documentEpoch: body.documentEpoch }),
  });
  service.lastProjectRoot = real;
  service.lastPath = path.join(real, "main.tex");
  const answer = await service.jumpToSource({ projectRoot: link, filePath: path.join(link, "main.tex"), line: 4 });
  assert.equal(answer.status, "hit");
  assert.equal(requests.find((request) => request.url === "/synctex/jump").body.file, "main.tex");
});

test("a chapter window's page is the Build sheet around it, with the live page beside it", async (t) => {
  const { service } = await engine(t, {
    status: status({ outer: { key: "k", before: 37, afterFrom: 49, pages: 389 } }),
    jump: (body) => ({ page: 2, boxes: [box], srcRev: body.srcRev, documentEpoch: body.documentEpoch }),
  });
  const answer = await service.jumpToSource({ projectRoot: root, filePath: chapter, line: 3 });
  assert.equal(answer.page, 39);
  assert.equal(answer.livePage, 2);
});

test("a pass still behind the source is waited for, up to the limit", async (t) => {
  let asked = 0;
  const { service } = await engine(t, {
    status: status(),
    jump: (body) => (++asked < 3
      ? { pending: true, documentEpoch: body.documentEpoch, srcRev: body.srcRev }
      : { page: 1, boxes: [box], srcRev: body.srcRev, documentEpoch: body.documentEpoch }),
  });
  const answer = await service.jumpToSource({ projectRoot: root, filePath: main, line: 20, waitMs: 2000 });
  assert.equal(answer.status, "hit");
  assert.equal(asked, 3);

  const behind = await engine(t, {
    status: status(),
    jump: (body) => ({ pending: true, documentEpoch: body.documentEpoch, srcRev: body.srcRev }),
  });
  const started = Date.now();
  assert.deepEqual(await behind.service.jumpToSource({ projectRoot: root, filePath: main, line: 20, waitMs: 300 }),
    { status: "pending", rootPath: main });
  assert.ok(Date.now() - started < 1500);
});

test("a current pass with no ink for the line is a miss; an unreadable file says nothing", async (t) => {
  const { service } = await engine(t, {
    status: status(),
    jump: (body) => (body.line === 2
      ? { pending: false, documentEpoch: body.documentEpoch, srcRev: body.srcRev }
      : { found: false }),
  });
  assert.deepEqual(await service.jumpToSource({ projectRoot: root, filePath: main, line: 2, waitMs: 2000 }),
    { status: "miss", rootPath: main });
  assert.equal(await service.jumpToSource({ projectRoot: root, filePath: main, line: 5 }), null);
});

test("an answer for an older revision is not taken as the current one", async (t) => {
  let asked = 0;
  const { service } = await engine(t, {
    status: () => ({ up: true, srcRev: 7 + asked, documentEpoch: 3 }),
    jump: (body) => (++asked === 1
      ? { page: 9, boxes: [box], srcRev: body.srcRev - 1, documentEpoch: body.documentEpoch }
      : { page: 4, boxes: [box], srcRev: body.srcRev, documentEpoch: body.documentEpoch }),
  });
  const answer = await service.jumpToSource({ projectRoot: root, filePath: main, line: 2, waitMs: 2000 });
  assert.equal(answer.page, 4);
});

test("no live document of this project: nothing is asked", async (t) => {
  const { service, requests } = await engine(t, { status: status(), jump: () => ({ page: 1, boxes: [box] }) });
  assert.equal(await service.jumpToSource({ projectRoot: "/tmp/other-project", filePath: main, line: 1 }), null);
  service.pageLimited = true;
  assert.equal(await service.jumpToSource({ projectRoot: root, filePath: main, line: 1 }), null);
  service.pageLimited = false;
  service.state = "starting";
  assert.equal(await service.jumpToSource({ projectRoot: root, filePath: main, line: 1 }), null);
  service.state = "ready";
  service.proc = null;
  assert.equal(await service.jumpToSource({ projectRoot: root, filePath: main, line: 1 }), null);
  assert.equal(requests.length, 0);
});

test("an engine error or a superseded Jump gives no answer", async (t) => {
  const failing = await engine(t, { status: status(), jump: () => ({ httpStatus: 400 }) });
  assert.equal(await failing.service.jumpToSource({ projectRoot: root, filePath: main, line: 1 }), null);
  const superseded = await engine(t, {
    status: status(),
    jump: (body) => ({ page: 1, boxes: [box], srcRev: body.srcRev, documentEpoch: body.documentEpoch }),
  });
  assert.equal(await superseded.service.jumpToSource({
    projectRoot: root, filePath: main, line: 1, isCurrent: () => false,
  }), null);
});

// Red: the canonical pass failed for the current source, or is of an older
// one. Its lines are another text's: it is never asked.
test("a pass that failed for the current source is 'failed', not asked and not a miss", async (t) => {
  const { service, requests } = await engine(t, {
    status: status({ canonical: { rev: 6, error: "Undefined control sequence", errorRev: 7 } }),
    jump: () => ({ page: 3, boxes: [box] }),
  });
  assert.deepEqual(await service.jumpToSource({ projectRoot: root, filePath: main, line: 4, waitMs: 2000 }),
    { status: "failed", rootPath: main });
  assert.equal(requests.filter((request) => request.url === "/synctex/jump").length, 0);
});

test("a pass of an older source is not asked; with no time to wait it is 'pending' at once", async (t) => {
  const { service, requests } = await engine(t, {
    status: status({ canonical: { rev: 5 } }),
    jump: () => ({ page: 3, boxes: [box] }),
  });
  const started = Date.now();
  assert.deepEqual(await service.jumpToSource({ projectRoot: root, filePath: main, line: 4, waitMs: 0 }),
    { status: "pending", rootPath: main });
  assert.ok(Date.now() - started < 500);
  assert.equal(requests.filter((request) => request.url === "/synctex/jump").length, 0);
});

test("a stale Live failure is pending, while a superseded request reports nothing", async (t) => {
  const { service } = await engine(t, {
    status: status({ canonical: { error: "Old compile error", errorRev: 6 } }),
    jump: () => ({ pending: false, reason: "failed", documentEpoch: 3, srcRev: 6 }),
  });
  assert.deepEqual(await service.jumpToSource({ projectRoot: root, filePath: main, line: 4 }),
    { status: "pending", rootPath: main });
  const failed = await engine(t, {
    status: status({ canonical: { error: "Undefined control sequence", errorRev: 7 } }),
    jump: () => ({ page: 1, boxes: [box] }),
  });
  assert.equal(await failed.service.jumpToSource({ projectRoot: root, filePath: main, line: 4, isCurrent: () => false }), null);
});

test("checking an error while the Build PDF is held never looks up Live coordinates", async (t) => {
  const { service, requests } = await engine(t, {
    status: status({ canonical: { rev: 7 } }),
    jump: (body) => ({ page: 1, boxes: [box], srcRev: body.srcRev, documentEpoch: body.documentEpoch }),
  });
  assert.equal(await service.jumpToSource({ projectRoot: root, filePath: main, line: 4, statusOnly: true }), null);
  assert.deepEqual(requests.map(({ url }) => url), ["/status"]);
});

test("only the document Live shows is asked about", async (t) => {
  const { service, requests } = await engine(t, { status: status(), jump: (body) => ({ page: 1, boxes: [box],
    srcRev: body.srcRev, documentEpoch: body.documentEpoch }) });
  assert.equal(await service.jumpToSource({ projectRoot: root, filePath: chapter, line: 1,
    documentPath: path.join(root, "chapter-alone.tex") }), null);
  assert.equal(requests.length, 0);
  assert.equal((await service.jumpToSource({ projectRoot: root, filePath: chapter, line: 1, documentPath: main })).status, "hit");
});

test("an answer that takes longer than the caller allows is no answer", async (t) => {
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ up: true, srcRev: 7, documentEpoch: 3, canonical: { rev: 7 } }));
      return;
    }
    // the first lookup of a pass, reading a long PDF's text
    setTimeout(() => { res.writeHead(200); res.end(JSON.stringify({ page: 1, boxes: [box] })); }, 1500);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const service = new TdomEngineService({ engineDir: "/tmp/tex64-jump-fixture", existsSync: () => true,
    fileAccess: { ensureAccess: async () => true, probeIfAllowed: () => true } });
  Object.assign(service, { port: server.address().port, proc: { exitCode: null, killed: false }, state: "ready",
    lastPath: main, lastProjectRoot: root });
  const started = Date.now();
  assert.equal(await service.jumpToSource({ projectRoot: root, filePath: main, line: 1, answerWithinMs: 300 }), null);
  assert.ok(Date.now() - started < 1200);
});

// The engine says why it has no answer (server /synctex/jump `reason`).
test("the engine's reason: nothing typeset, failed, still to come, or cannot tell", async (t) => {
  const reasons = { 1: "no-ink", 2: "failed", 3: "not-an-input", 4: "unreadable" };
  let pendingOnce = true;
  const { service } = await engine(t, {
    status: status(),
    jump: (body) => (body.line === 5
      ? (pendingOnce ? (pendingOnce = false, { pending: false, reason: "pending", documentEpoch: 3, srcRev: 7 })
        : { page: 2, boxes: [box], srcRev: 7, documentEpoch: 3 })
      : { pending: false, reason: reasons[body.line], documentEpoch: 3, srcRev: 7 }),
  });
  const ask = (line, waitMs = 0) => service.jumpToSource({ projectRoot: root, filePath: main, line, waitMs });
  assert.deepEqual(await ask(1), { status: "miss", rootPath: main, notTypeset: true });
  assert.deepEqual(await ask(2), { status: "failed", rootPath: main });
  assert.equal(await ask(3), null);
  assert.equal(await ask(4), null);
  // still to come (a pass behind on another input): waited for like `pending`
  assert.equal((await ask(5, 2000)).status, "hit");
});

test("vertical writing: the engine's columns come through with their direction", async (t) => {
  const column = { left: 300, top: 80, right: 310, bottom: 440 };
  const { service } = await engine(t, {
    status: status(),
    jump: (body) => ({ page: 1, direction: "tate", boxes: [column, { ...column, left: 283, right: 293 }],
      srcRev: body.srcRev, documentEpoch: body.documentEpoch }),
  });
  const answer = await service.jumpToSource({ projectRoot: root, filePath: main, line: 4 });
  assert.equal(answer.direction, "tate");
  assert.equal(answer.boxes.length, 2);
});
