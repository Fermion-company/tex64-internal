"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const { SynctexService } = require("../electron/services/synctex/service.cjs");
const { createBuildPathResolvers } = require("../electron/handlers/build/path-resolvers.cjs");
const { createSynctexForwardHandler } = require("../electron/handlers/build/synctex-forward.cjs");
const { createSynctexReverseHandler } = require("../electron/handlers/build/synctex-reverse.cjs");

// Real LuaLaTeX -synctex=1 output. The gzip sidecars only have their Input
// paths rebased. Bbox snapshots are in PDF points, from pdftotext -bbox-layout
// on these same PDFs. Source ownership was assigned by matching the text in
// each printed column to the TeX, including repeated exam paragraphs in order.
// The only unprinted page (t05:1) is a chapter-opening blank.
const fixtures = path.join(__dirname, "fixtures", "synctex-host-r2");
const harness = (name, { live, sidecar } = {}) => {
  const root = path.join(fixtures, name);
  const source = name === "t00" ? "原稿.tex" : "main.tex";
  const pdfPath = path.join(root, "main.pdf");
  const service = new SynctexService();
  const calls = [];
  service.forward = async (input) => { calls.push(input); return { ok: false, error: "Use the index" }; };
  service.findSynctex = () => "synctex";
  const available = () => sidecar?.() !== false;
  const actualSidecar = service.findSynctexOutputPath.bind(service);
  service.findSynctexOutputPath = (pdf) => available() ? actualSidecar(pdf) : null;
  const fileSystem = {
    ...fs,
    statSync: (file) => {
      if (!available() && file === path.join(root, "main.synctex.gz")) throw new Error("sidecar is gone");
      return fs.statSync(file);
    },
  };
  let reply;
  let serial = 0;
  const resolvers = createBuildPathResolvers({ fs, path });
  const deps = {
    fs: fileSystem, synctexService: service, state: { lastBuildPdfPath: pdfPath },
    delay: async () => {}, ensureWorkspace: () => root,
    sendToRenderer: (_type, result) => { reply = result; },
    resolveJumpDocument: async () => ({ targetFile: source, pdfPath, built: available() }),
    pdfWindowManager: { show() {}, queueSync() {} },
    getLiveEngine: () => live && { jumpToSource: live },
  };
  const { handleSynctexForward } = createSynctexForwardHandler(deps, resolvers);
  const { handleSynctexReverse } = createSynctexReverseHandler(deps, resolvers);
  return {
    root, source, service, calls,
    jump: async (line, options = {}) => {
      reply = undefined;
      await handleSynctexForward({ type: "synctex:forward", requestId: String(++serial), source: "manual",
        path: source, line, column: 1, fallbackToTop: true, pdfViewerMode: "tab", livePaper: Boolean(live), ...options });
      return reply;
    },
    reverse: async (page, x, y) => {
      reply = undefined;
      await handleSynctexReverse({ type: "synctex:reverse", pdfPath: "main.pdf", page, x, y });
      return reply;
    },
  };
};

const rectsOf = (answer) => answer.blocks?.map((box) => ({ page: answer.page, ...box })) ?? [{
  page: answer.page, x: answer.blockX, y: answer.blockY,
  width: answer.blockWidth, height: answer.blockHeight,
}];

for (const [name, lineCount, pagesWithInk] of [
  ["r01", 43, [1, 2, 3, 4, 5, 6, 7]],
  ["t01", 5, [1]], ["t03", 7, [1]], ["t05", 15, [2, 3, 4]], ["r02", 38, [1, 2, 3, 4]],
  ["t08a", 3, [1]],
]) {
  test(`${name}: Build Jump contains every measured glyph, on its own page and in a vertical rectangle`, async () => {
    const { root, service, calls, jump } = harness(name);
    const truth = JSON.parse(gunzipSync(fs.readFileSync(path.join(root, "bbox.json.gz"))));
    assert.equal(Object.keys(truth.lines).length, lineCount);
    const pdfPath = path.join(root, "main.pdf");
    assert.equal(service.loadForwardIndex(service.findSynctexOutputPath(pdfPath)).pageCount, truth.pageCount);
    const seen = new Set();
    for (const [line, glyphs] of Object.entries(truth.lines)) {
      const answer = await jump(Number(line));
      const label = `${name}:${line}`;
      assert.equal(answer.ok, true, label);
      assert.equal(answer.fallback, false, label);
      assert.equal(answer.direction, "tate", label);
      assert.equal(answer.page, Math.min(...glyphs.map(([page]) => page)), label);
      const [indexed] = service.forwardLinesQuick({
        sourcePath: path.join(root, "main.tex"), pdfPath, lines: [Number(line)], firstSubstantialPage: true,
      }).results;
      assert.equal(indexed.page, answer.page, label);
      assert.equal(indexed.direction, "tate", label);
      const rects = rectsOf(answer);
      for (const rect of rects) assert.ok(rect.height > rect.width, JSON.stringify(rect));
      const missing = glyphs.filter(([page, xMin, yMin, xMax, yMax]) => {
        seen.add(page);
        // Round-off in the PDF text extraction and font metric overhang.
        const tolerance = 0.75;
        return !rects.some((rect) => rect.page === page && xMin >= rect.x - tolerance &&
          xMax <= rect.x + rect.width + tolerance && yMin >= rect.y - tolerance && yMax <= rect.y + rect.height + tolerance);
      });
      assert.equal(missing.length, 0, `${label}: ${JSON.stringify({ missing: missing.slice(0, 8), rects })}`);
    }
    assert.deepEqual([...seen].sort((a, b) => a - b), pagesWithInk);
    if (name === "t08a") {
      const yoko = await jump(4);
      assert.equal(yoko.direction, undefined);
      assert.ok(rectsOf(yoko).every((box) => box.width > box.height));
    }
    assert.equal(calls.length, 0);
  });
}

for (const [name, inkLines] of [
  ["t00", [3, 4, 6, 8, 10]],
  ["t02y", [3, 4, 5, 6, 8, 10, 11, 13, 14, 15, 17, 19, 20, 21, 23, 25]],
  ["t20y", [4, 5, 8, 9, 13, 16, 17]],
]) {
  test(`${name}: each yoko forward rectangle reverses at its centre`, async () => {
    const { jump, reverse, service, root, source } = harness(name);
    for (const line of inkLines) {
      const answer = await jump(line);
      assert.equal(answer.ok, true, `${name}:${line}`);
      assert.equal(answer.fallback, false, `${name}:${line}`);
      const rects = rectsOf(answer);
      // A different recent Jump can lie close to the point, e.g. a heading
      // just before a paragraph. The clicked row's source takes precedence.
      service.registerForwardHint({ pdfPath: path.join(root, "main.pdf"), page: answer.page,
        x: rects[0].x + rects[0].width / 2, y: rects[0].y + rects[0].height / 2,
        sourcePath: path.join(root, source), line: line + 1 });
      for (const { page, x, y, width, height } of rects) {
        assert.ok(width > height, `${name}:${line}`);
        const hit = await reverse(page, x + width / 2, y + height / 2);
        assert.equal(hit.path, source, JSON.stringify(hit));
        assert.equal(hit.line, line, `${name}:${line}, page ${page}, ${x},${y}`);
      }
    }
  });
}

test("a cached Jump cannot answer after the sidecar is trashed", async () => {
  let available = true;
  const { jump } = harness("t00", { sidecar: () => available });
  const options = { pdfPath: "main.pdf" };
  assert.equal((await jump(4, options)).ok, true);
  available = false;
  assert.equal((await jump(4, options)).code, "NEEDS_BUILD");
});

test("missing SyncTeX checks the Live status of the Build's own document", async () => {
  const checks = [];
  const { root, source, jump } = harness("t00", {
    sidecar: () => false,
    live: async ({ documentPath }) => {
      checks.push(documentPath);
      return documentPath ? null : { status: "failed", rootPath: "/another/document.tex" };
    },
  });
  assert.equal((await jump(4)).code, "NEEDS_BUILD");
  assert.deepEqual(checks, [path.join(root, source)]);
});

test("missing SyncTeX starts a Build only when Live has no current compile error", async () => {
  for (const live of [undefined, async () => null, async () => ({ status: "pending" })]) {
    const { jump, source } = harness("t00", { sidecar: () => false, live });
    const answer = await jump(4);
    assert.equal(answer.code, "NEEDS_BUILD");
    assert.equal(answer.targetFile, source);
  }
  const queries = [];
  const { jump } = harness("t00", {
    sidecar: () => false,
    live: async (query) => { queries.push(query); return { status: "failed" }; },
  });
  for (const livePaper of [true, false]) {
    const answer = await jump(4, { livePaper });
    assert.equal(answer.error, "SyncTeX data was not found.");
    assert.equal(answer.code, undefined);
  }
  assert.deepEqual(queries.map(({ statusOnly }) => statusOnly), [false, true]);
});

test("the static viewer paints each part on its own page and uses that page's dimensions", async () => {
  const { jump } = harness("r01");
  const answer = await jump(15);
  assert.equal(answer.page, 1);
  const vm = require("node:vm");
  const source = fs.readFileSync(require.resolve("../Resources/web/pdf-viewer.js"), "utf8");
  const start = source.indexOf("  const applySyncHighlight =");
  const end = source.indexOf("\n  };", start) + "\n  };".length;
  class PageElement {
    isConnected = true;
    markers = [];
    appendChild(marker) { this.markers.push(marker); }
  }
  const views = [600, 800].map((height) => ({
    height,
    div: new PageElement(),
    viewport: { convertToViewportPoint: (x, y) => [x, height - y] },
  }));
  const context = vm.createContext({
    state: {}, HTMLElement: PageElement, setTimeout: () => 0,
    document: { createElement: () => ({ style: {} }) },
    pdfViewer: { getPageView: (index) => views[index] },
    resolvePagePdfHeight: (view) => view.height,
    resolveViewportScale: () => ({ x: 1, y: 1 }),
  });
  vm.runInContext(source.slice(start, end) + "\nthis.mark = applySyncHighlight;", context);
  context.mark(views[0], answer, 0, 0);
  const expected = rectsOf(answer);
  for (const [index, { div }] of views.entries()) {
    const blocks = expected.filter(({ page }) => page === index + 1);
    assert.ok(blocks.length > 0);
    assert.equal(div.markers.length, blocks.length);
    for (const [i, block] of blocks.entries()) {
      assert.ok(Math.abs(parseFloat(div.markers[i].style.top) - (block.y - 1)) < 0.001);
    }
  }
});
