"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { LivePreviewPageLimit, LIVE_PREVIEW_PAGE_LIMIT } = require("../electron/services/live-preview-page-limit.cjs");
const { TdomEngineService } = require("../electron/services/tdom-engine.cjs");

const papers = (files) => {
  let counted = 0;
  const limit = new LivePreviewPageLimit({
    countPages: async (pdfPath) => { counted += 1; return files.get(pdfPath).pages; },
    stat: async (pdfPath) => {
      const file = files.get(pdfPath);
      if (!file) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isFile: () => true, size: file.size ?? 1000, mtimeMs: file.mtimeMs };
    },
  });
  return { limit, counted: () => counted };
};

test("the limit is 200 pages: a 200-page Build is live, a 201-page one is not", async () => {
  assert.equal(LIVE_PREVIEW_PAGE_LIMIT, 200);
  const files = new Map([["/p/a.pdf", { pages: 200, mtimeMs: 1 }], ["/p/b.pdf", { pages: 201, mtimeMs: 1 }]]);
  const { limit } = papers(files);
  assert.deepEqual(await limit.check("/p/a.tex"), { limited: false, pages: 200 });
  assert.deepEqual(await limit.check("/p/b.tex"), { limited: true, pages: 201 });
  assert.deepEqual(await limit.check("/p/never-built.tex"), { limited: false, pages: null });
});

test("a Build paper is counted once until it changes", async () => {
  const files = new Map([["/p/a.pdf", { pages: 389, mtimeMs: 1 }]]);
  const { limit, counted } = papers(files);
  await limit.check("/p/a.tex");
  await limit.check("/p/a.tex");
  assert.equal(counted(), 1);
  files.set("/p/a.pdf", { pages: 120, mtimeMs: 2 });
  assert.deepEqual(await limit.check("/p/a.tex"), { limited: false, pages: 120 });
  assert.equal(counted(), 2);
});

test("what the engine reports outranks an older Build, and a newer Build outranks the report", async () => {
  const files = new Map([["/p/a.pdf", { pages: 150, mtimeMs: 1_000 }]]);
  const { limit } = papers(files);
  assert.equal(limit.observe("/p/a.tex", 180, 2_000), false);
  assert.equal((await limit.check("/p/a.tex")).limited, false);
  assert.equal(limit.observe("/p/a.tex", 230, 2_000), true);
  assert.deepEqual(await limit.check("/p/a.tex"), { limited: true, pages: 230 });
  files.set("/p/a.pdf", { pages: 190, mtimeMs: 3_000 });
  assert.deepEqual(await limit.check("/p/a.tex"), { limited: false, pages: 190 });
});

test("a Build whose output goes elsewhere is counted from the project's Build cache", async () => {
  const files = new Map([["/p/.tex64/cache/gen/paper.bin", { pages: 389, mtimeMs: 5 }]]);
  const service = new TdomEngineService({
    pageLimit: papers(files).limit,
    loadBuildCache: async ({ rootPath, mainFileName }) => {
      assert.deepEqual([rootPath, mainFileName], ["/p", "book.tex"]);
      return { hit: true, artifacts: { pdf: { filePath: "/p/.tex64/cache/gen/paper.bin" } } };
    },
  });
  assert.deepEqual(await service.checkPageLimit("/p/book.tex", "/p"), { limited: true, pages: 389 });
  files.set("/p/book.pdf", { pages: 90, mtimeMs: 9 });
  assert.deepEqual(await service.checkPageLimit("/p/book.tex", "/p"), { limited: false, pages: 90 });
});

test("a push for a document past the limit answers limited, starts nothing and stops a running engine", async () => {
  const files = new Map([["/p/book.pdf", { pages: 389, mtimeMs: 1 }]]);
  const service = new TdomEngineService({ pageLimit: papers(files).limit, loadBuildCache: async () => ({ hit: false }) });
  let killed = 0, started = 0;
  service.start = async () => { started += 1; };
  Object.assign(service, { proc: { exitCode: null, killed: false, kill() { killed += 1; } }, state: "ready", port: 1234 });
  const answer = await service.push({ source: "x", path: "/p/book.tex", fresh: true });
  assert.deepEqual(answer, { ok: true, limited: true, pages: 389 });
  assert.equal(killed, 1);
  assert.equal(started, 0);
  assert.equal(service.getStatus().pageLimited, true);
  assert.equal(service.pageWatchTimer, null);
  service.stop();
  assert.equal(service.getStatus().pageLimited, false);
});

test("a Build of a document past the limit is not opened in the engine", async () => {
  const files = new Map([["/p/book.pdf", { pages: 389, mtimeMs: 1 }]]);
  const service = new TdomEngineService({ pageLimit: papers(files).limit, loadBuildCache: async () => ({ hit: false }) });
  const lease = { projectRoot: "/p", mainFile: "book.tex", released: false, pendingSnapshot: { filePath: "/p/book.tex" } };
  service.activeBuildLease = lease;
  service.start = async () => { throw new Error("must not start"); };
  const answer = await service.adoptCanonicalBuild(lease, { schemaVersion: 1 });
  assert.deepEqual(answer, { adopted: false, deferred: true, reason: "live-preview-page-limit" });
});
