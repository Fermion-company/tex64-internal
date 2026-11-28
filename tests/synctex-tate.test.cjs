"use strict";
// Jump on vertical writing (LuaTeX-ja tate), from real SyncTeX: ltjtarticle
// (t01), jlreq tate (t03) and a novel's first two pages (r01), with a yoko
// control (t00). tests/fixtures/synctex-tate/truth.json holds where
// pdftotext puts the first glyph of some words (made by
// testing/tate-verify-20261125 fixtures compiled with `lualatex -synctex=1`).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { SynctexService } = require("../electron/services/synctex/service.cjs");
const { createSynctexForwardHandler } = require("../electron/handlers/build/synctex-forward.cjs");
const { createBuildPathResolvers } = require("../electron/handlers/build/path-resolvers.cjs");

const FIXTURES = path.join(__dirname, "fixtures", "synctex-tate");
const truth = JSON.parse(fs.readFileSync(path.join(FIXTURES, "truth.json"), "utf8"));

const unpack = (t, name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tex64-tate-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(FIXTURES, `${name}.tex`), path.join(dir, "main.tex"));
  const text = zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, `${name}.synctex.gz`))).toString("utf8");
  fs.writeFileSync(path.join(dir, "main.synctex"), text.split("@DIR@").join(dir));
  fs.writeFileSync(path.join(dir, "main.pdf"), "%PDF-1.5\n");
  return { dir, main: path.join(dir, "main.tex"), pdf: path.join(dir, "main.pdf") };
};

const jumpFrom = async (files, line) => {
  const sent = [];
  const cli = [];
  const service = new SynctexService({});
  service.forward = async (args) => { cli.push(args); return { ok: false, error: "stub process" }; };
  const handler = createSynctexForwardHandler({
    fs, synctexService: service, state: { lastBuildPdfPath: null }, delay: async () => {},
    pdfWindowManager: { show() {}, queueSync() {} },
    sendToRenderer: (type, payload) => sent.push(payload),
    ensureWorkspace: () => files.dir,
    resolveJumpDocument: async () => ({ targetFile: "main.tex", pdfPath: files.pdf, built: true }),
  }, createBuildPathResolvers({ fs, path }));
  await handler.handleSynctexForward({ type: "synctex:forward", requestId: "r", source: "manual", path: "main.tex",
    line, column: 1, fallbackToTop: true, pdfViewerMode: "tab", livePaper: false });
  return { answer: sent[0], cli };
};
const rectsOf = (answer) => Array.isArray(answer.blocks) && answer.blocks.length
  ? answer.blocks
  : [{ x: answer.blockX, y: answer.blockY, width: answer.blockWidth, height: answer.blockHeight }];
// The line itself, or the one that ends its paragraph when that is
// \end{document}: the SyncTeX of both yoko and tate Japanese text files the
// paragraph under the line that ends it (only a blank line is looked past).
const endsWith = (files, line) => {
  const next = fs.readFileSync(files.main, "utf8").split("\n")[line] ?? "";
  return /^\\end\{document\}/.test(next.trim()) ? [line, line + 1] : [line];
};
const holds = (rect, point, slack = 2) => point.x >= rect.x - slack && point.x <= rect.x + rect.width + slack &&
  point.y >= rect.y - slack && point.y <= rect.y + rect.height + slack;

test("a tate page is told by its SyncTeX (a box set upright inside its turned frame), a yoko page is not", (t) => {
  const service = new SynctexService({});
  for (const name of ["t01", "t03", "r01"]) {
    const files = unpack(t, name);
    const index = service.loadForwardIndex(service.findSynctexOutputPath(files.pdf));
    assert.equal(index.pages.get(1).tate, true, name);
  }
  const yoko = unpack(t, "t00");
  const index = service.loadForwardIndex(service.findSynctexOutputPath(yoko.pdf));
  assert.equal(index.pages.get(1).tate, undefined);
});

for (const name of ["t01", "t03", "r01"]) {
  test(`${name}: Jump marks the columns that hold the line, and never asks the synctex process`, async (t) => {
    const files = unpack(t, name);
    for (const word of truth[name]) {
      const { answer, cli } = await jumpFrom(files, word.line);
      assert.equal(answer.ok, true, word.token);
      assert.equal(answer.direction, "tate", word.token);
      assert.equal(answer.page, word.page, word.token);
      const rects = rectsOf(answer);
      for (const rect of rects) assert.ok(rect.height > rect.width, `${word.token}: a column, not a row`);
      assert.ok(rects.some((rect) => holds(rect, word)), `${word.token}: ${JSON.stringify({ word, rects })}`);
      assert.equal(cli.length, 0, "its frame is unturned: a band across the top of the page");
    }
  });

  test(`${name}: a click on a glyph of a tate column names its source line`, (t) => {
    const files = unpack(t, name);
    const service = new SynctexService({});
    for (const word of truth[name]) {
      const hit = service.reverseQuick({ pdfPath: files.pdf, page: word.page, x: word.x, y: word.y });
      assert.deepEqual(endsWith(files, word.line).includes(hit?.line), true, `${word.token}: ${hit?.line}`);
      assert.equal(hit.exact, true, word.token);
    }
  });
}

test("yoko: unchanged (rows, no direction)", async (t) => {
  const files = unpack(t, "t00");
  const service = new SynctexService({});
  for (const word of truth.t00) {
    const { answer } = await jumpFrom(files, word.line);
    assert.equal(answer.ok, true);
    assert.equal(answer.direction, undefined);
    for (const rect of rectsOf(answer)) assert.ok(rect.width > rect.height, "a row");
    assert.ok(rectsOf(answer).some((rect) => holds(rect, word)), word.token);
    assert.ok(endsWith(files, word.line).includes(service.reverseQuick({ pdfPath: files.pdf, page: word.page, x: word.x, y: word.y })?.line));
  }
});

test("only what sits in the tate box turns: a yoko page with one tate box keeps its rows", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-tate-mixed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, "main.tex");
  fs.writeFileSync(main, "a\nb\nc\n");
  fs.writeFileSync(path.join(dir, "main.pdf"), "%PDF-1.5\n");
  const sp = (bp) => Math.round(bp * 65781.76);
  fs.writeFileSync(path.join(dir, "main.synctex"), [
    "SyncTeX Version:1", `Input:1:${main}`, "Output:pdf", "Magnification:1000", "Unit:1", "X Offset:0", "Y Offset:0", "Content:",
    "{1", `[1,1:${sp(72)},${sp(72)}:${sp(400)},${sp(600)},0`,
    // a yoko line at y = 100
    `(1,1:${sp(72)},${sp(100)}:${sp(300)},${sp(8)},${sp(2)}`, `x1,1:${sp(80)},${sp(100)}`, ")",
    // Y: an upright box 50 wide, 200 high at (200, 300) holding T, its tate frame (200 long, 50 across)
    `[1,2:${sp(200)},${sp(300)}:${sp(50)},${sp(200)},0`,
    `[1,2:${sp(200)},${sp(-40)}:${sp(200)},${sp(50)},0`,
    `(1,2:${sp(200)},${sp(-20)}:${sp(200)},${sp(5)},${sp(5)}`, `x1,2:${sp(210)},${sp(-20)}`, ")",
    "]", "]",
    "]", "}1", "Postamble:", "Count:0", "Post scriptum:", "",
  ].join("\n"));
  const service = new SynctexService({});
  const quick = service.forwardLinesQuick({ sourcePath: main, pdfPath: path.join(dir, "main.pdf"), lines: [1, 2] });
  const [yoko, tate] = quick.results;
  assert.equal(yoko.direction, undefined);
  assert.ok(Math.abs(yoko.y - 100) < 0.01 && Math.abs(yoko.x - 80) < 0.01, JSON.stringify(yoko));
  // (210, -20) of T's frame: x = 200 + 50 + (-40) - (-20) = 230, y = 300 - 200 + 210 = 310
  assert.equal(tate.direction, "tate");
  assert.ok(Math.abs(tate.x - 230) < 0.01 && Math.abs(tate.y - 310) < 0.01, JSON.stringify(tate));
});
