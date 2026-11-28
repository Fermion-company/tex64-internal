"use strict";
// Jump while Live shows the document: what the last Build cannot answer (no
// Build, a file or a line it does not have) comes from Live's current
// revision, never as "build first" (handlers/build/synctex-forward.cjs).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSynctexForwardHandler } = require("../electron/handlers/build/synctex-forward.cjs");
const { createBuildPathResolvers } = require("../electron/handlers/build/path-resolvers.cjs");
const { SynctexService } = require("../electron/services/synctex/service.cjs");
const { createBuildSourceTracker } = require("../electron/services/synctex/build-sources.cjs");

// One typeset line: an hbox at height `v` with `glyphs` characters of (tag, line).
const row = (tag, line, v, glyphs, h0 = 4000000) =>
  [`(${tag},${line}:${h0},${v}:26000000,600000,150000`,
    ...Array.from({ length: glyphs }, (_, i) => `x${tag},${line}:${h0 + i * 400000},${v}`),
    ")"];
const page = (number, rows) =>
  [`{${number}`, "[1,1:4000000,50000000:26000000,46000000,0", ...rows.flat(), "]", `}${number}`];

// main.tex: 200 lines of prose. The last Build typeset lines 1–10 on page 1.
const project = (t, { pdf = true, synctex = true, mainText } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-jump-live-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, "main.tex");
  fs.writeFileSync(main, mainText ?? Array.from({ length: 200 }, (_, i) => `Paragraph text ${i + 1}.`).join("\n"));
  fs.mkdirSync(path.join(dir, "ch"));
  fs.writeFileSync(path.join(dir, "ch", "new.tex"), "A chapter written after the last Build.\n");
  if (pdf) fs.writeFileSync(path.join(dir, "main.pdf"), "%PDF-1.5\n");
  if (synctex) {
    fs.writeFileSync(path.join(dir, "main.synctex"), [
      "SyncTeX Version:1", `Input:1:${main}`, "Output:pdf",
      "Magnification:1000", "Unit:1", "X Offset:0", "Y Offset:0", "Content:",
      ...page(1, Array.from({ length: 10 }, (_, i) => row(1, i + 1, 5000000 + i * 2000000, 30))),
      "Postamble:", "Count:0", "",
    ].join("\n"));
  }
  return { dir, main, pdf: path.join(dir, "main.pdf") };
};

const box = { left: 72, top: 300, right: 500, bottom: 312 };

const harness = (files, { document, live, lastBuildPdfPath = null, buildSources, windowLive = null, onProcess = null,
  windowPath = null, workspace = null } = {}) => {
  const sent = [];
  const shown = [];
  const synced = [];
  const asked = [];
  const cliCalls = [];
  const synctexService = new SynctexService({});
  // The `synctex` process: the index answers in these tests.
  synctexService.forward = async (args) => {
    cliCalls.push(args);
    onProcess?.(args);
    return { ok: false, error: "stub process" };
  };
  const handler = createSynctexForwardHandler({
    fs,
    pdfWindowManager: {
      show: (pdfPath) => shown.push(pdfPath),
      queueSync: (sync) => synced.push(sync),
      matchingLivePreview: () => windowLive,
      get livePreview() { return windowLive; },
      currentPath: windowPath,
    },
    synctexService,
    sendToRenderer: (type, payload) => sent.push({ type, payload }),
    ensureWorkspace: () => files.dir,
    state: { lastBuildPdfPath },
    delay: async () => {},
    resolveJumpDocument: async () => {
      if (typeof document === "function") return document();
      return document ?? null;
    },
    getLiveEngine: live === undefined ? undefined : () => ({
      jumpToSource: async (args) => {
        asked.push(args);
        return typeof live === "function" ? live(args) : live;
      },
    }),
    ...(buildSources ? { buildSources } : {}),
    ...(workspace ? { workspace } : {}),
  }, createBuildPathResolvers({ fs, path }));
  const jump = (overrides = {}) => handler.handleSynctexForward({
    type: "synctex:forward", requestId: "r1", source: "manual", path: "main.tex",
    line: 3, column: 1, fallbackToTop: true, pdfViewerMode: "tab", ...overrides,
  });
  const result = () => sent.filter((entry) => entry.type === "synctex:forwardResult").map((entry) => entry.payload);
  return { handler, jump, result, shown, synced, asked, cliCalls };
};

const notBuilt = { targetFile: "main.tex", pdfPath: null, built: false };
const hit = (files, extra = {}) => ({ status: "hit", page: 3, boxes: [box], rootPath: files.main, ...extra });

test("no Build yet: Live's current revision answers instead of starting a Build", async (t) => {
  const files = project(t, { pdf: false, synctex: false });
  const h = harness(files, { document: notBuilt, live: hit(files) });
  await h.jump({ line: 120 });
  const [answer] = h.result();
  assert.equal(answer.ok, true);
  assert.equal(answer.code, undefined);
  assert.equal(answer.live, true);
  assert.equal(answer.page, 3);
  assert.equal(answer.pdfPath, "main.pdf");
  assert.deepEqual([answer.blockX, answer.blockY, answer.blockWidth, answer.blockHeight], [72, 300, 428, 12]);
  assert.equal(answer.fallback, false);
  assert.equal(answer.requestId, "r1");
  assert.deepEqual(h.asked.map(({ projectRoot, filePath, line }) => ({ projectRoot, filePath, line })),
    [{ projectRoot: files.dir, filePath: files.main, line: 120 }]);
});

test("no Build and nothing from Live: the Build is still what Jump asks for", async (t) => {
  const files = project(t, { pdf: false, synctex: false });
  for (const live of [undefined, null, { status: "pending", rootPath: files.main }, { status: "miss", rootPath: files.main }]) {
    const h = harness(files, { document: notBuilt, live });
    await h.jump({ line: 120 });
    assert.deepEqual(h.result(), [{ ok: false, code: "NEEDS_BUILD", targetFile: "main.tex", requestId: "r1" }]);
  }
});

test("no document and no Build this session: Live answers instead of 'No PDF yet. Build first.'", async (t) => {
  const files = project(t, { pdf: false, synctex: false });
  const unresolved = () => { throw new Error("File not found: main.tex"); };
  const h = harness(files, { document: unresolved, live: hit(files) });
  await h.jump();
  assert.equal(h.result()[0].ok, true);
  assert.equal(h.result()[0].live, true);

  // and without Live: one Build (the Build resolves the document), then the Jump (real-app D9)
  const without = harness(files, { document: unresolved, live: null });
  await without.jump();
  assert.deepEqual(without.result(), [{ ok: false, code: "NEEDS_BUILD", targetFile: null, requestId: "r1" }]);
});

test("a file the last Build does not include is answered by Live", async (t) => {
  const files = project(t);
  const built = { targetFile: "main.tex", pdfPath: files.pdf, built: true };
  const h = harness(files, { document: built, live: hit(files, { page: 5 }) });
  await h.jump({ path: "ch/new.tex", line: 1 });
  assert.equal(h.result()[0].ok, true);
  assert.equal(h.result()[0].page, 5);
  assert.equal(h.asked[0].filePath, path.join(files.dir, "ch", "new.tex"));

  const without = harness(files, { document: built, live: { status: "miss", rootPath: files.main } });
  await without.jump({ path: "ch/new.tex", line: 1 });
  assert.equal(without.result()[0].ok, false);
  assert.equal(without.result()[0].error, "The file is not part of this PDF.");
});

test("a line the last Build has nothing near is answered by Live, not by its first page", async (t) => {
  const files = project(t);
  const built = { targetFile: "main.tex", pdfPath: files.pdf, built: true };
  const h = harness(files, { document: built, live: hit(files, { page: 7 }) });
  await h.jump({ line: 150 });
  assert.equal(h.result()[0].page, 7);
  assert.equal(h.result()[0].notTypeset, undefined);

  // Live current with no ink either: the Build's stand-in (its first page) stays.
  const miss = harness(files, { document: built, live: { status: "miss", rootPath: files.main } });
  await miss.jump({ line: 150 });
  assert.equal(miss.result()[0].ok, true);
  assert.equal(miss.result()[0].page, 1);
  assert.equal(miss.result()[0].notTypeset, true);
  assert.equal(miss.result()[0].live, undefined);
});

test("the document Live shows: its current pass answers first, so the viewer moves once", async (t) => {
  const files = project(t);
  const built = { targetFile: "main.tex", pdfPath: files.pdf, built: true };
  const h = harness(files, { document: built, live: hit(files, { page: 2 }) });
  await h.jump({ line: 3, livePaper: true });
  assert.equal(h.result()[0].live, true);
  assert.equal(h.result()[0].page, 2);
  // asked at once (no waiting for a pass), and only about the document a Build of this file makes
  assert.equal(h.asked[0].waitMs, 0);
  assert.equal(h.asked[0].documentPath, files.main);
  assert.ok(h.asked[0].answerWithinMs > 0);

  // red or orange (that pass failed, is behind, or the engine is down): the Build answers
  for (const live of [{ status: "failed", rootPath: files.main }, { status: "pending", rootPath: files.main }, null]) {
    const red = harness(files, { document: built, live });
    await red.jump({ line: 3, livePaper: true });
    assert.equal(red.result()[0].ok, true);
    assert.equal(red.result()[0].page, 1);
    assert.equal(red.result()[0].live, undefined);
  }
});

test("a PDF without SyncTeX is said at once, without probing neighbours with the synctex process", async (t) => {
  const files = project(t, { synctex: false });
  const h = harness(files, { document: null, live: null, lastBuildPdfPath: files.pdf });
  // (the reader's Jump builds once, below; any other Jump is told)
  await h.jump({ line: 3, source: "other" });
  assert.deepEqual(h.result(), [{ ok: false, error: "SyncTeX data was not found.", requestId: "r1" }]);
  assert.equal(h.cliCalls.length, 0);

  const live = harness(files, { document: null, live: hit(files), lastBuildPdfPath: files.pdf });
  await live.jump({ line: 3 });
  assert.equal(live.result()[0].live, true);

  const gone = harness(files, { document: null, live: null, lastBuildPdfPath: path.join(files.dir, "gone.pdf") });
  await gone.jump({ line: 3, source: "other" });
  assert.deepEqual(gone.result(), [{ ok: false, error: "PDF not found.", requestId: "r1" }]);
  assert.equal(gone.cliCalls.length, 0);
});

test("a preamble line with no Build: Live's first page stands in, and nothing is built", async (t) => {
  const files = project(t, {
    pdf: false, synctex: false,
    mainText: "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nHello.\n\\end{document}\n",
  });
  const miss = { status: "miss", rootPath: null };
  const h = harness(files, { document: notBuilt, live: () => ({ ...miss, rootPath: files.main }) });
  await h.jump({ line: 2 });
  assert.deepEqual(h.result(), [{
    ok: true, page: 1, x: 0, y: 0, fallback: true, notTypeset: true, live: true, pdfPath: "main.pdf", requestId: "r1",
  }]);
  // A body line Live has no ink for is not "not typeset" on that evidence alone.
  const body = harness(files, { document: notBuilt, live: () => ({ ...miss, rootPath: files.main }) });
  await body.jump({ line: 4 });
  assert.equal(body.result()[0].code, "NEEDS_BUILD");
});

test("window viewer: the live answer goes to the window with the source line to refine from", async (t) => {
  const files = project(t, { pdf: false, synctex: false });
  const h = harness(files, { document: notBuilt, live: hit(files, { page: 39, livePage: 2 }), windowLive: { hold: false } });
  await h.jump({ line: 120, pdfViewerMode: "window" });
  assert.deepEqual(h.shown, [files.pdf]);
  assert.equal(h.synced.length, 1);
  assert.equal(h.synced[0].page, 39);
  assert.equal(h.synced[0].livePage, 2);
  assert.equal(h.synced[0].sourceFile, "main.tex");
  assert.equal(h.synced[0].sourceLine, 120);
  assert.equal(h.result()[0].ok, true);
});

test("window viewer: the Build's answer also names the source line, and a neighbour's place is approximate", async (t) => {
  const files = project(t);
  const built = { targetFile: "main.tex", pdfPath: files.pdf, built: true };
  const exact = harness(files, { document: built });
  await exact.jump({ line: 3, pdfViewerMode: "window" });
  assert.equal(exact.synced[0].sourceFile, "main.tex");
  assert.equal(exact.synced[0].sourceLine, 3);
  assert.equal(exact.synced[0].approximate, undefined);
  // line 12: the Build's nearest typeset line (10) stands in
  const near = harness(files, { document: built });
  await near.jump({ line: 12, pdfViewerMode: "window" });
  assert.equal(near.result()[0].fallback, true);
  assert.equal(near.synced[0].approximate, true);
  assert.equal(near.synced[0].sourceLine, 12);
});

test("a newer Jump takes over from one still waiting for Live", async (t) => {
  const files = project(t, { pdf: false, synctex: false });
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const h = harness(files, {
    document: notBuilt,
    live: async (args) => (++calls === 1 ? (await waiting, args.isCurrent() ? hit(files) : null) : hit(files, { page: 8 })),
  });
  const first = h.jump({ requestId: "first", line: 50 });
  await new Promise((resolve) => setImmediate(resolve));
  await h.jump({ requestId: "second", line: 60 });
  release();
  await first;
  assert.deepEqual(h.result().map((answer) => [answer.requestId, answer.page]), [["second", 8]]);
});

test("the Jump after a Build never asks Live (the Build's paper is current)", async (t) => {
  const files = project(t, { pdf: false, synctex: false });
  const h = harness(files, { document: notBuilt, live: hit(files) });
  await h.jump({ source: "auto-build", fallbackToTop: false, line: 120 });
  assert.equal(h.asked.length, 0);
  assert.equal(h.result()[0].code, "NEEDS_BUILD");
});

// The status mark is red: Live has no current pass to answer from (it failed
// for the current source, is behind it, or the engine is down), so the last
// Build answers, and its SyncTeX numbers the lines as that Build read them.
const prose = Array.from({ length: 200 }, (_, i) => `Paragraph text ${i + 1}.`);
const built = (files) => ({ targetFile: "main.tex", pdfPath: files.pdf, built: true });
const redLive = (files) => ({ status: "failed", rootPath: files.main });
const knownBuild = (text) => ({ sourceFor: async () => text });

test("red: lines added above since the Build do not move the Jump (the caret's line is the Build's line 5)", async (t) => {
  const files = project(t);
  const baseline = harness(files, { document: built(files), live: redLive(files), buildSources: knownBuild(prose.join("\n")) });
  await baseline.jump({ line: 5 });
  const [expected] = baseline.result();

  // Three lines written above line 5 since that Build (autosaved, too).
  const now = ["New one.", "New two.", "New three.", ...prose].join("\n");
  fs.writeFileSync(files.main, now);
  const h = harness(files, { document: built(files), live: redLive(files), buildSources: knownBuild(prose.join("\n")) });
  await h.jump({ line: 8, text: now });
  const [answer] = h.result();
  assert.equal(answer.ok, true);
  assert.equal(answer.page, expected.page);
  assert.equal(answer.y, expected.y, "the Build's line 5, not its line 8");
  assert.equal(answer.fallback, false, "an unchanged line is answered as itself");
});

test("red: lines removed above since the Build do not move the Jump either", async (t) => {
  const files = project(t);
  const baseline = harness(files, { document: built(files), live: redLive(files), buildSources: knownBuild(prose.join("\n")) });
  await baseline.jump({ line: 9 });
  const now = prose.slice(2).join("\n");
  const h = harness(files, { document: built(files), live: redLive(files), buildSources: knownBuild(prose.join("\n")) });
  await h.jump({ line: 7, text: now });
  assert.equal(h.result()[0].y, baseline.result()[0].y);
});

test("red: a line written since the Build is answered 'about here', at its place among the Build's lines", async (t) => {
  const files = project(t);
  const baseline = harness(files, { document: built(files), live: redLive(files), buildSources: knownBuild(prose.join("\n")) });
  await baseline.jump({ line: 4 });
  const now = [...prose.slice(0, 3), "Written after the Build.", ...prose.slice(3)].join("\n");
  const h = harness(files, { document: built(files), live: redLive(files), buildSources: knownBuild(prose.join("\n")) });
  await h.jump({ line: 4, text: now });
  assert.equal(h.result()[0].y, baseline.result()[0].y, "where the Build had the line that follows it");
  assert.equal(h.result()[0].fallback, true);
});

test("red: a file whose Build text is not known and that changed since is answered 'about here'", async (t) => {
  const files = project(t);
  const now = ["New one.", ...prose].join("\n");
  fs.writeFileSync(files.main, now);
  const h = harness(files, { document: built(files), live: redLive(files), buildSources: knownBuild(null) });
  await h.jump({ line: 4, text: now });
  assert.equal(h.result()[0].ok, true);
  assert.equal(h.result()[0].fallback, true);
});

test("window viewer, red: the mapped answer is approximate only when the line is new", async (t) => {
  const files = project(t);
  const now = ["New one.", ...prose].join("\n");
  const h = harness(files, { document: built(files), live: redLive(files), buildSources: knownBuild(prose.join("\n")) });
  await h.jump({ line: 4, text: now, pdfViewerMode: "window" });
  assert.equal(h.synced[0].approximate, undefined);
  assert.equal(h.synced[0].sourceLine, 4, "the frame refines from the editor's line");
  const fresh = harness(files, { document: built(files), live: redLive(files), buildSources: knownBuild(prose.join("\n")) });
  await fresh.jump({ line: 1, text: now, pdfViewerMode: "window" });
  assert.equal(fresh.synced[0].approximate, true);
});

test("an \\input line is recognised in the editor's text, not in the file autosave has not caught up with", async (t) => {
  const files = project(t, { mainText: ["A.", "B.", "\\input{ch/new}", "C."].join("\n") });
  const h = harness(files, { document: built(files), live: (args) => hit(files, { page: 6, asked: args.filePath }) });
  // the editor has a line more above the \input than the file on disk
  await h.jump({ line: 4, livePaper: true, text: ["A.", "Typed just now.", "B.", "\\input{ch/new}", "C."].join("\n") });
  assert.equal(h.asked[0].filePath, path.join(files.dir, "ch", "new.tex"));
  assert.equal(h.result()[0].sourcePath, "ch/new.tex");
  // and a line the disk still has as \input but the editor no longer does is not one
  const moved = harness(files, { document: built(files), live: hit(files) });
  await moved.jump({ line: 3, livePaper: true, text: ["A.", "B.", "C."].join("\n") });
  assert.equal(moved.asked[0].filePath, files.main);
});

// Live's page numbers belong on the Live paper only. A static PDF on screen
// (Live off, or the paper a Build holds) is answered from its own SyncTeX.
test("a static paper on screen is never given Live's page numbers", async (t) => {
  const files = project(t);
  const h = harness(files, { document: built(files), live: hit(files, { page: 9 }) });
  await h.jump({ line: 3, livePaper: false });
  assert.equal(h.asked.length, 0);
  assert.equal(h.result()[0].page, 1);
  // nor for a line that static paper lacks
  const missing = harness(files, { document: built(files), live: hit(files, { page: 9 }) });
  await missing.jump({ path: "ch/new.tex", line: 1, livePaper: false });
  assert.equal(missing.asked.length, 0);
  assert.equal(missing.result()[0].error, "The file is not part of this PDF.");
});

test("window viewer: what the window shows decides (Live paper, or a held static PDF)", async (t) => {
  const files = project(t);
  const shown = harness(files, { document: built(files), live: hit(files, { page: 9 }), windowLive: { hold: false } });
  await shown.jump({ line: 3, pdfViewerMode: "window" });
  assert.equal(shown.synced[0].page, 9);
  const held = harness(files, { document: built(files), live: hit(files, { page: 9 }), windowLive: { hold: true } });
  await held.jump({ line: 3, pdfViewerMode: "window" });
  assert.equal(held.asked.length, 0);
  assert.equal(held.synced[0].page, 1);
});

// Jump while a Build runs (owner, 11/25: 「表示が固まってる・固まってはないが安全に出せる時は確実に飛べるように」).
const touch = (file, ms) => fs.utimesSync(file, ms / 1000, ms / 1000);
const previousBuild = async (files) => {
  // the Build before: it read `prose`, and its PDF + SyncTeX are in place
  const base = Date.now() - 60_000;
  touch(files.main, base);
  let clock = base + 1_000;
  const tracker = createBuildSourceTracker({ now: () => clock });
  tracker.observe("building", { pdfPath: "main.pdf" }, files.dir);
  touch(path.join(files.dir, "main.synctex"), base + 2_000);
  touch(files.pdf, base + 2_000);
  clock = base + 3_000;
  tracker.observe("success", { pdfPath: "main.pdf" }, files.dir);
  await tracker.whenSettled();
  return tracker;
};

test("Build running, the previous PDF on screen: answered from that PDF, in the numbering of the text it was built from", async (t) => {
  const files = project(t);
  const tracker = await previousBuild(files);
  const baseline = harness(files, { document: built(files), buildSources: tracker });
  await baseline.jump({ line: 5, livePaper: false });
  // three lines written since, and the next Build running (its output is staged elsewhere)
  const now = ["New one.", "New two.", "New three.", ...prose].join("\n");
  fs.writeFileSync(files.main, now);
  tracker.observe("building", { pdfPath: "main.pdf" }, files.dir);
  assert.equal(tracker.running(files.pdf), true);
  const h = harness(files, { document: built(files), buildSources: tracker, live: hit(files, { page: 9 }) });
  await h.jump({ line: 8, text: now, livePaper: false });
  assert.equal(h.result().length, 1);
  assert.equal(h.result()[0].y, baseline.result()[0].y);
  assert.equal(h.result()[0].fallback, false);
  assert.equal(h.asked.length, 0, "the static paper on screen, not Live");
});

test("Build running, the Live paper on screen and current: Live answers", async (t) => {
  const files = project(t);
  const tracker = await previousBuild(files);
  tracker.observe("building", { pdfPath: "main.pdf" }, files.dir);
  const h = harness(files, { document: built(files), buildSources: tracker, live: hit(files, { page: 4 }) });
  await h.jump({ line: 5, livePaper: true });
  assert.equal(h.result()[0].live, true);
  assert.equal(h.result()[0].page, 4);
});

test("the Build swaps its PDF in while a Jump is answered: one answer, from the new paper, after the swap", async (t) => {
  const files = project(t);
  const order = [];
  let swapped = false;
  const newSynctex = () => fs.writeFileSync(path.join(files.dir, "main.synctex"), [
    "SyncTeX Version:1", `Input:1:${files.main}`, "Output:pdf",
    "Magnification:1000", "Unit:1", "X Offset:0", "Y Offset:0", "Content:",
    // the new paper: everything 6 lines lower
    ...page(1, Array.from({ length: 10 }, (_, i) => row(1, i + 1, 17000000 + i * 2000000, 30))),
    "Postamble:", "Count:0", "",
  ].join("\n"));
  const buildSources = {
    sourceFor: async () => prose.join("\n"),
    whenSettled: async () => { order.push("build success sent"); return true; },
  };
  // The Build's commit (SyncTeX first, then the PDF) lands after the old
  // paper's index has been read, while the answer is being finished.
  const onProcess = () => {
    if (swapped) return;
    swapped = true;
    newSynctex();
    touch(path.join(files.dir, "main.synctex"), Date.now() + 5_000);
    touch(files.pdf, Date.now() + 5_000);
  };
  const h = harness(files, { document: built(files), buildSources, onProcess });
  const send = h.handler.handleSynctexForward;
  await send({ type: "synctex:forward", requestId: "r1", source: "manual", path: "main.tex", line: 5, column: 1,
    fallbackToTop: true, pdfViewerMode: "tab", livePaper: false });
  // the retry runs on its own: let it finish
  for (let i = 0; i < 20 && h.result().length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.result().length, 1, "one answer");
  assert.deepEqual(order, ["build success sent"]);
  // line 5 on the new paper: 17000000 + 4 * 2000000 sp
  const expected = harness(files, { document: built(files) });
  await expected.jump({ line: 5, livePaper: false });
  assert.equal(h.result()[0].y, expected.result()[0].y);
  assert.equal(h.result()[0].requestId, "r1");
});

test("Live says it typesets nothing for a body line: 'not typeset' from Live, not a Build", async (t) => {
  const files = project(t, { pdf: false, synctex: false });
  const h = harness(files, { document: notBuilt, live: { status: "miss", rootPath: files.main, notTypeset: true } });
  await h.jump({ line: 120, livePaper: true });
  assert.deepEqual(h.result(), [{
    ok: true, page: 1, x: 0, y: 0, fallback: true, notTypeset: true, live: true, pdfPath: "main.pdf", requestId: "r1",
  }]);
  // the Build's own "not typeset" is not replaced by Live's
  const builtFiles = project(t);
  const both = harness(builtFiles, { document: built(builtFiles), live: { status: "miss", rootPath: builtFiles.main, notTypeset: true } });
  await both.jump({ line: 150 });
  assert.equal(both.result()[0].notTypeset, true);
  assert.equal(both.result()[0].live, undefined);
});

test("a place from Live carries the revision it is of (goto-sync liveRevision); one from a Build does not", async (t) => {
  const files = project(t);
  const revision = { documentEpoch: 3, srcRev: 7, canonicalId: 9 };
  const tab = harness(files, { document: built(files), live: hit(files, { page: 2, revision }) });
  await tab.jump({ line: 3, livePaper: true });
  assert.deepEqual(tab.result()[0].liveRevision, revision);
  const win = harness(files, { document: built(files), live: hit(files, { page: 2, revision }), windowLive: { hold: false } });
  await win.jump({ line: 3, pdfViewerMode: "window" });
  assert.deepEqual(win.synced[0].liveRevision, revision);
  const build = harness(files, { document: built(files), live: { status: "pending", rootPath: files.main } });
  await build.jump({ line: 3, livePaper: true, pdfViewerMode: "window" });
  assert.equal(build.synced[0].liveRevision, undefined);
});

// The viewer's re-check (pdf-viewer.js "jump-recheck"): the PDF a Build made is
// on screen, and a Jump was made while that Build ran. Its line, on that PDF.
const recheck = (h, files, extra = {}) => h.handler.handleSynctexForward({
  type: "synctex:forward", requestId: "rc", source: "recheck", path: "main.tex", line: 5, column: 1,
  pdfPath: "main.pdf", recheckToken: 41, fallbackToTop: false, livePaper: false, pdfViewerMode: "tab", ...extra,
});

test("re-check: the Jump's line on the PDF the Build made, from the text that Build read", async (t) => {
  const files = project(t);
  const tracker = await previousBuild(files);
  const baseline = harness(files, { document: built(files), buildSources: tracker });
  await baseline.jump({ line: 5, livePaper: false });
  // the Jump was made in a text with three lines more above it than the Build read
  const atJump = ["New one.", "New two.", "New three.", ...prose].join("\n");
  const h = harness(files, { buildSources: tracker, live: hit(files, { page: 9 }) });
  await recheck(h, files, { line: 8, text: atJump });
  assert.deepEqual(h.result().map(({ page, y, recheckToken, approximate, requestId, pdfPath }) =>
    ({ page, y, recheckToken, approximate, requestId, pdfPath })), [{
    page: baseline.result()[0].page, y: baseline.result()[0].y, recheckToken: 41, approximate: undefined, requestId: "rc", pdfPath: "main.pdf",
  }]);
  assert.equal(h.asked.length, 0, "never Live");
  // a line written since the Build started: "about here"
  const fresh = harness(files, { buildSources: tracker });
  await recheck(fresh, files, { line: 1, text: atJump });
  assert.equal(fresh.result()[0].approximate, true);
});

test("re-check: nothing when the line is not on that PDF, and never a Build, a notice or another paper", async (t) => {
  const files = project(t);
  const tracker = await previousBuild(files);
  const missing = harness(files, { buildSources: tracker, document: notBuilt });
  await recheck(missing, files, { line: 150 });
  assert.deepEqual(missing.result(), []);
  const otherFile = harness(files, { buildSources: tracker });
  await recheck(otherFile, files, { path: "ch/new.tex", line: 1 });
  assert.deepEqual(otherFile.result(), []);
  const noPaper = harness(files, { buildSources: tracker });
  await recheck(noPaper, files, { pdfPath: "gone.pdf" });
  assert.deepEqual(noPaper.result(), []);
});

test("re-check: superseded by a Build started since, or by one that replaced that PDF", async (t) => {
  const files = project(t);
  const tracker = await previousBuild(files);
  const replaced = harness(files, { buildSources: tracker });
  touch(path.join(files.dir, "main.synctex"), Date.now() + 10_000);
  await recheck(replaced, files);
  assert.deepEqual(replaced.result(), []);
  const files2 = project(t);
  const tracker2 = await previousBuild(files2);
  tracker2.observe("building", { pdfPath: "main.pdf" }, files2.dir);
  const running = harness(files2, { buildSources: tracker2 });
  await recheck(running, files2);
  assert.deepEqual(running.result(), []);
});

test("re-check, window viewer: to the window only while it shows that PDF", async (t) => {
  const files = project(t);
  const tracker = await previousBuild(files);
  const shown = harness(files, { buildSources: tracker, windowPath: files.pdf });
  await recheck(shown, files, { pdfPath: files.pdf, pdfViewerMode: "window", requestId: undefined });
  assert.equal(shown.synced.length, 1);
  assert.equal(shown.synced[0].recheckToken, 41);
  assert.deepEqual(shown.shown, [], "the window is not reopened");
  assert.deepEqual(shown.result(), [], "nothing to the main window");
  const elsewhere = harness(files, { buildSources: tracker, windowPath: path.join(files.dir, "other.pdf") });
  await recheck(elsewhere, files, { pdfPath: files.pdf, pdfViewerMode: "window", requestId: undefined });
  assert.equal(elsewhere.synced.length, 0);
});

test("re-check and the reader's Jump do not cancel each other", async (t) => {
  const files = project(t);
  const tracker = await previousBuild(files);
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const h = harness(files, { document: built(files), buildSources: tracker,
    live: async () => { await slow; return hit(files, { page: 7 }); } });
  const jump = h.jump({ requestId: "manual", line: 3, livePaper: true });
  await new Promise((resolve) => setImmediate(resolve));
  await recheck(h, files);
  release();
  await jump;
  assert.deepEqual(h.result().map((answer) => answer.requestId).sort(), ["manual", "rc"]);
});

// A line that reads a file: which file is the one the Build of its document
// reads (tex-build-target.cjs resolveIncludesOf), not a guess beside the line.
const { resolveIncludesOf } = require("../electron/services/tex-build-target.cjs");
const { resolveInputLineTarget } = require("../electron/services/tex-input-target.cjs");
const diskWorkspace = (dir) => ({
  getRootPath: () => dir,
  resolvePath: (file) => path.resolve(dir, file),
  readFile: async (file) => fs.promises.readFile(path.resolve(dir, file), "utf8"),
  listFiles: async () => {
    const out = [];
    const walk = (sub) => {
      for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
        const rel = sub ? `${sub}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(rel); else out.push(rel);
      }
    };
    walk("");
    return out;
  },
  getRecentBuildTargets: () => [],
  rootInfo: async () => null,
  resolveTexRootFromMagic: async () => null,
});
const importProject = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-jump-import-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  put("paper/main.tex", ["\\documentclass{article}", "\\usepackage{import}", "\\begin{document}",
    "\\input{chapters/one}", "\\import{parts/}{body}", "\\end{document}"].join("\n"));
  // a plain \input in a chapter is read from the document's folder (paper/), not the chapter's
  put("paper/chapters/one.tex", ["One.", "\\input{chapters/two}"].join("\n"));
  put("paper/chapters/two.tex", ["", "% two", "Two, the one the Build reads."].join("\n"));
  put("chapters/two.tex", "A decoy at the workspace root.");
  // inside an imported file, \subimport is read from the import's folder
  put("paper/parts/body.tex", ["Body.", "\\subimport{sub/}{deep}"].join("\n"));
  put("paper/parts/sub/deep.tex", "Deep.");
  return dir;
};

test("a line that reads a file goes to the file the document's Build reads (root in a sub-folder, \\subimport)", async (t) => {
  const dir = importProject(t);
  const ws = diskWorkspace(dir);
  const chapterIncludes = await resolveIncludesOf(ws, "paper/main.tex", "paper/chapters/one.tex");
  assert.deepEqual(resolveInputLineTarget(dir, "paper/chapters/one.tex", 2, { includes: chapterIncludes }),
    { path: "paper/chapters/two.tex", line: 3 });
  // the guess beside the line took the workspace root's file of that name
  assert.equal(resolveInputLineTarget(dir, "paper/chapters/one.tex", 2)?.path, "chapters/two.tex");
  const bodyIncludes = await resolveIncludesOf(ws, "paper/main.tex", "paper/parts/body.tex");
  assert.deepEqual(resolveInputLineTarget(dir, "paper/parts/body.tex", 2, { includes: bodyIncludes }),
    { path: "paper/parts/sub/deep.tex", line: 1 });
});

test("Jump from such a line asks about that file, with the document resolved first", async (t) => {
  const dir = importProject(t);
  const files = { dir, main: path.join(dir, "paper/main.tex"), pdf: path.join(dir, "paper/main.pdf") };
  const h = harness(files, {
    workspace: diskWorkspace(dir),
    document: { targetFile: "paper/main.tex", pdfPath: null, built: false },
    live: (args) => hit(files, { page: 2, asked: args.filePath }),
  });
  await h.jump({ path: "paper/chapters/one.tex", line: 2, livePaper: true });
  assert.equal(h.asked[0].filePath, path.join(dir, "paper/chapters/two.tex"));
  assert.equal(h.asked[0].line, 3);
  assert.equal(h.result()[0].sourcePath, "paper/chapters/two.tex");
});

test("vertical writing from Live: each column, and the direction, reach the viewer", async (t) => {
  const files = project(t);
  const columns = [{ left: 300, top: 80, right: 310, bottom: 440 }, { left: 283, top: 80, right: 293, bottom: 300 }];
  const h = harness(files, { document: built(files), live: hit(files, { boxes: columns, direction: "tate" }), windowLive: { hold: false } });
  await h.jump({ line: 3, pdfViewerMode: "window" });
  assert.equal(h.synced[0].direction, "tate");
  assert.deepEqual(h.synced[0].blocks, [{ x: 300, y: 80, width: 10, height: 360 }, { x: 283, y: 80, width: 10, height: 220 }]);
  assert.equal(h.result()[0].direction, "tate");
});
