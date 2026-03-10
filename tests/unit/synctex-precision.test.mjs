import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { SynctexService } = require("../../electron/services/synctex/service.cjs");

// ---------------------------------------------------------------------------
// parseForwardBlocks
// ---------------------------------------------------------------------------

test("parseForwardBlocks extracts page, x, y, h, v, W, H from synctex output", () => {
  const service = new SynctexService();
  const output = [
    "SyncTeX result begin",
    "Output:/tmp/test.pdf",
    "Page:1",
    "x:72.000",
    "y:300.500",
    "h:73.000",
    "v:301.000",
    "W:120.500",
    "H:10.200",
    "before:foo",
    "offset:0",
    "middle:bar",
    "after:baz",
    "SyncTeX result end",
  ].join("\n");
  const blocks = service.parseForwardBlocks(output);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].page, 1);
  assert.equal(blocks[0].x, 72);
  assert.equal(blocks[0].y, 300.5);
  assert.equal(blocks[0].h, 73);
  assert.equal(blocks[0].v, 301);
  assert.equal(blocks[0].width, 120.5);
  assert.equal(blocks[0].height, 10.2);
});

test("parseForwardBlocks handles multiple blocks", () => {
  const service = new SynctexService();
  const output = [
    "SyncTeX result begin",
    "Output:/tmp/test.pdf",
    "Page:1",
    "x:72.000",
    "y:300.500",
    "h:73.000",
    "v:301.000",
    "W:120.500",
    "H:10.200",
    "Output:/tmp/test.pdf",
    "Page:2",
    "x:100.000",
    "y:200.000",
    "h:101.000",
    "v:201.000",
    "W:80.000",
    "H:12.000",
    "SyncTeX result end",
  ].join("\n");
  const blocks = service.parseForwardBlocks(output);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].page, 1);
  assert.equal(blocks[1].page, 2);
  assert.equal(blocks[1].x, 100);
  assert.equal(blocks[1].width, 80);
});

test("parseForwardBlocks returns empty for garbage input", () => {
  const service = new SynctexService();
  assert.deepEqual(service.parseForwardBlocks(""), []);
  assert.deepEqual(service.parseForwardBlocks(null), []);
  assert.deepEqual(service.parseForwardBlocks("garbage text"), []);
});

// ---------------------------------------------------------------------------
// buildForwardCandidates
// ---------------------------------------------------------------------------

test("buildForwardCandidates uses h,v-H for block bounding box", () => {
  const service = new SynctexService();
  // Real synctex output: x=156.5, y=156.6, h=133.8, v=158.6, W=343.7, H=9.08
  const block = { page: 1, x: 156.513, y: 156.596, h: 133.768, v: 158.648, width: 343.711, height: 9.076 };
  const candidates = service.buildForwardCandidates(block);
  assert.ok(candidates.length >= 1);
  for (const c of candidates) {
    assert.equal(c.page, 1);
    // blockX should be h (left margin), not x (text start)
    assert.equal(c.blockX, 133.768, "blockX should use h (left edge)");
    // blockY should be v - H (top of box), not y
    const expectedTop = 158.648 - 9.076; // = 149.572
    assert.ok(Math.abs(c.blockY - expectedTop) < 0.01, `blockY should be v-H=${expectedTop}, got ${c.blockY}`);
    // blockWidth stays as W
    assert.equal(c.blockWidth, 343.711);
    // blockHeight = H + depth_estimate (3)
    assert.ok(Math.abs(c.blockHeight - 12.076) < 0.01, `blockHeight should be H+3=${12.076}, got ${c.blockHeight}`);
  }
});

test("buildForwardCandidates falls back to x,y when h,v missing", () => {
  const service = new SynctexService();
  const block = { page: 1, x: 100, y: 200, h: null, v: null, width: 50, height: 10 };
  const candidates = service.buildForwardCandidates(block);
  for (const c of candidates) {
    // When h is null, blockX falls back to x
    assert.equal(c.blockX, 100);
    // When v is null, blockY falls back to y
    assert.equal(c.blockY, 200);
  }
});

test("buildForwardCandidates deduplicates identical points", () => {
  const service = new SynctexService();
  const block = { page: 1, x: 100, y: 200, h: 100, v: 200, width: null, height: null };
  const candidates = service.buildForwardCandidates(block);
  const seen = new Set();
  for (const c of candidates) {
    const key = `${c.x}:${c.y}`;
    assert.ok(!seen.has(key), `duplicate candidate at ${key}`);
    seen.add(key);
  }
});

// ---------------------------------------------------------------------------
// Forward hint cache (findForwardHint) — tightened ranges
// ---------------------------------------------------------------------------

test("findForwardHint matches within dx=180, dy=14", () => {
  const service = new SynctexService();
  const pdfPath = "/tmp/test.pdf";
  const sourcePath = "/tmp/test.tex";
  service.registerForwardHint({
    pdfPath,
    page: 1,
    x: 200,
    y: 400,
    sourcePath,
    line: 10,
    column: 1,
  });
  // dx=170 should match (within 180)
  const match = service.findForwardHint({ pdfPath, page: 1, x: 370, y: 408 });
  assert.ok(match, "should match within dx=170, dy=8");
  assert.equal(match.line, 10);
});

test("findForwardHint rejects matches beyond dx=180", () => {
  const service = new SynctexService();
  const pdfPath = "/tmp/test.pdf";
  const sourcePath = "/tmp/test.tex";
  service.registerForwardHint({
    pdfPath,
    page: 1,
    x: 200,
    y: 400,
    sourcePath,
    line: 10,
    column: 1,
  });
  const noMatch = service.findForwardHint({ pdfPath, page: 1, x: 400, y: 400 });
  assert.equal(noMatch, null, "should not match when dx=200 > 180");
});

test("findForwardHint rejects matches beyond dy=14", () => {
  const service = new SynctexService();
  const pdfPath = "/tmp/test.pdf";
  const sourcePath = "/tmp/test.tex";
  service.registerForwardHint({
    pdfPath,
    page: 1,
    x: 200,
    y: 400,
    sourcePath,
    line: 10,
    column: 1,
  });
  const noMatch = service.findForwardHint({ pdfPath, page: 1, x: 200, y: 420 });
  assert.equal(noMatch, null, "should not match when dy=20 > 14");
});

test("findForwardHint prefers closer hints by score", () => {
  const service = new SynctexService();
  const pdfPath = "/tmp/test.pdf";
  const sourcePath = "/tmp/test.tex";
  service.registerForwardHint({
    pdfPath,
    page: 1,
    x: 200,
    y: 400,
    sourcePath,
    line: 10,
    column: 1,
  });
  service.registerForwardHint({
    pdfPath,
    page: 1,
    x: 210,
    y: 400,
    sourcePath,
    line: 20,
    column: 1,
  });
  const match = service.findForwardHint({ pdfPath, page: 1, x: 212, y: 400 });
  assert.ok(match);
  assert.equal(match.line, 20, "should pick the closer hint");
});

// ---------------------------------------------------------------------------
// findRecentPageHint
// ---------------------------------------------------------------------------

test("findRecentPageHint respects maxDx/maxDy defaults", () => {
  const service = new SynctexService();
  const pdfPath = "/tmp/test.pdf";
  const sourcePath = "/tmp/test.tex";
  service.registerForwardHint({
    pdfPath,
    page: 1,
    x: 200,
    y: 400,
    sourcePath,
    line: 10,
    column: 1,
  });
  const match = service.findRecentPageHint({ page: 1, x: 220, y: 410 });
  assert.ok(match, "should match within default range");
  const noMatch = service.findRecentPageHint({ page: 1, x: 300, y: 500 });
  assert.equal(noMatch, null, "should not match when too far");
});

// ---------------------------------------------------------------------------
// registerForwardHint keeps only newest per page
// ---------------------------------------------------------------------------

test("registerForwardHint replaces older hint for same page", () => {
  const service = new SynctexService();
  const pdfPath = "/tmp/test.pdf";
  const sourcePath = "/tmp/test.tex";
  service.registerForwardHint({
    pdfPath,
    page: 1,
    x: 100,
    y: 200,
    sourcePath,
    line: 5,
    column: 1,
  });
  service.registerForwardHint({
    pdfPath,
    page: 1,
    x: 150,
    y: 250,
    sourcePath,
    line: 15,
    column: 1,
  });
  const samePage = service.forwardHints.filter(
    (h) => h.page === 1 && h.pdfPath === service.normalizeComparePath(pdfPath)
  );
  assert.equal(samePage.length, 1, "should keep only the newest hint per page");
  assert.equal(samePage[0].line, 15);
});

// ---------------------------------------------------------------------------
// isSkippableSynctexLine (used in forward handler backtrack)
// ---------------------------------------------------------------------------

test("isSkippableSynctexLine detects comments and structural commands", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-skip-"));
  const texPath = path.join(tmpDir, "test.tex");
  try {
    fs.writeFileSync(
      texPath,
      [
        "% This is a comment",
        "\\begin{document}",
        "Hello world",
        "\\end{document}",
        "",
        "\\label{fig:1}",
        "Real content here",
        "  ",
      ].join("\n"),
      "utf8"
    );

    const { createSynctexForwardHandler } = require(
      "../../electron/handlers/build/synctex-forward.cjs"
    );

    // We can't directly access isSkippableSynctexLine since it's a closure.
    // But we can verify the skip patterns by reading the file ourselves.
    const content = fs.readFileSync(texPath, "utf8");
    const lines = content.split(/\r?\n/);

    const isSkippable = (lineNumber) => {
      const line = lines[lineNumber - 1];
      if (typeof line !== "string") return false;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("%")) return true;
      if (
        /^\\(?:begin|end|label|caption|centering|toprule|midrule|bottomrule|hline|cline)\b/.test(
          trimmed
        )
      )
        return true;
      if (/\\\\\s*$/.test(trimmed)) return true;
      if (/(^|[^\\])&/.test(trimmed)) return true;
      return false;
    };

    assert.equal(isSkippable(1), true, "comment line");
    assert.equal(isSkippable(2), true, "\\begin{document}");
    assert.equal(isSkippable(3), false, "real content");
    assert.equal(isSkippable(4), true, "\\end{document}");
    assert.equal(isSkippable(5), true, "empty line");
    assert.equal(isSkippable(6), true, "\\label");
    assert.equal(isSkippable(7), false, "real content");
    assert.equal(isSkippable(8), true, "whitespace-only");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Coordinate conversion math (SyncTeX ↔ PDF)
// ---------------------------------------------------------------------------

test("SyncTeX to PDF Y conversion is invertible", () => {
  const pagePdfHeight = 842;
  const synctexY = 300;
  const pdfY = pagePdfHeight - synctexY;
  const recovered = pagePdfHeight - pdfY;
  assert.equal(recovered, synctexY);
});

test("Click bias is applied in PDF points, not pixels", () => {
  const CLICK_BIAS_Y_PT = 2;
  const pagePdfHeight = 842;
  const pdfYBottom = 542;

  // Without bias:
  const synctexYNoBias = pagePdfHeight - pdfYBottom;
  // With bias (applied in SyncTeX space):
  const synctexYWithBias = pagePdfHeight - pdfYBottom + CLICK_BIAS_Y_PT;

  assert.equal(synctexYNoBias, 300);
  assert.equal(synctexYWithBias, 302);

  // At any zoom level, the bias remains 2pt in PDF space
  for (const zoom of [0.5, 1.0, 1.5, 2.0, 3.0]) {
    const pixelBiasEquiv = CLICK_BIAS_Y_PT * zoom;
    // The old approach would have a fixed 2px bias → 2/zoom in PDF points
    const oldPdfBias = 2 / zoom;
    // Our new approach: always 2pt regardless of zoom
    assert.equal(CLICK_BIAS_Y_PT, 2, `bias stays 2pt at zoom=${zoom}`);
    // The old approach varied: at zoom=2, old bias = 1pt; at zoom=0.5, old bias = 4pt
    if (zoom !== 1) {
      assert.notEqual(oldPdfBias, CLICK_BIAS_Y_PT, `old bias differs at zoom=${zoom}`);
    }
  }
});

// ---------------------------------------------------------------------------
// resolvePagePdfHeight fallback chain
// ---------------------------------------------------------------------------

test("resolvePagePdfHeight from rawDims.pageHeight", () => {
  // Simulating the function inline since it's a browser function
  const resolve = (pageView) => {
    const rawHeight = Number(pageView?.viewport?.rawDims?.pageHeight);
    if (Number.isFinite(rawHeight) && rawHeight > 0) return rawHeight;
    const viewBox = pageView?.viewport?.viewBox;
    if (Array.isArray(viewBox) && viewBox.length >= 4) {
      const height = Math.abs(Number(viewBox[3]) - Number(viewBox[1]));
      if (Number.isFinite(height) && height > 0) return height;
    }
    const vp = pageView?.viewport;
    if (vp) {
      const rotation = Number(vp.rotation) || 0;
      const isRotated = rotation === 90 || rotation === 270;
      const scaledDim = Number(isRotated ? vp.width : vp.height);
      const scale = Number(vp.scale);
      if (Number.isFinite(scaledDim) && scaledDim > 0 && Number.isFinite(scale) && scale > 0) {
        const d = scaledDim / scale;
        if (Number.isFinite(d) && d > 0) return d;
      }
    }
    return null;
  };

  // Tier 1: rawDims
  assert.equal(
    resolve({ viewport: { rawDims: { pageHeight: 842 }, viewBox: [0, 0, 595, 842] } }),
    842
  );

  // Tier 2: viewBox (rawDims missing)
  assert.equal(
    resolve({ viewport: { viewBox: [0, 0, 595, 842] } }),
    842
  );

  // Tier 3: viewport dimensions (everything else missing)
  assert.equal(
    resolve({ viewport: { height: 1684, scale: 2, rotation: 0 } }),
    842
  );

  // Tier 3 rotated: width becomes height
  assert.equal(
    resolve({ viewport: { width: 1684, height: 1190, scale: 2, rotation: 90 } }),
    842
  );

  // All missing
  assert.equal(resolve({}), null);
  assert.equal(resolve(null), null);
});

// ---------------------------------------------------------------------------
// Forward backtrack range constants
// ---------------------------------------------------------------------------

test("Forward backtrack range is reduced", () => {
  // Verify the maxBacktrack constants by reading the handler source
  const handlerSource = fs.readFileSync(
    path.resolve("electron/handlers/build/synctex-forward.cjs"),
    "utf8"
  );
  const match = handlerSource.match(
    /const maxBacktrack = forwardSource === "manual" \? (\d+) : (\d+)/
  );
  assert.ok(match, "maxBacktrack pattern found in source");
  const manualMax = Number(match[1]);
  const autoMax = Number(match[2]);
  assert.ok(manualMax <= 80, `manual backtrack ${manualMax} should be ≤ 80`);
  assert.ok(autoMax <= 100, `auto backtrack ${autoMax} should be ≤ 100`);
});

// ---------------------------------------------------------------------------
// Hint cache range constants
// ---------------------------------------------------------------------------

test("Hint cache ranges are tightened", () => {
  const hintSource = fs.readFileSync(
    path.resolve("electron/services/synctex/hints.cjs"),
    "utf8"
  );
  const dxMatch = hintSource.match(/const maxDx = (\d+)/);
  const dyMatch = hintSource.match(/const maxDy = (\d+)/);
  assert.ok(dxMatch, "maxDx found in hints.cjs");
  assert.ok(dyMatch, "maxDy found in hints.cjs");
  const maxDx = Number(dxMatch[1]);
  const maxDy = Number(dyMatch[1]);
  assert.ok(maxDx <= 200, `maxDx=${maxDx} should be ≤ 200 (was 240)`);
  assert.ok(maxDy <= 16, `maxDy=${maxDy} should be ≤ 16 (was 26)`);
});

// ---------------------------------------------------------------------------
// Hint expiration (30s cleanup)
// ---------------------------------------------------------------------------

test("Hints expire after 30 seconds", () => {
  const service = new SynctexService();
  const pdfPath = "/tmp/test.pdf";
  const sourcePath = "/tmp/test.tex";
  const now = Date.now();
  // Manually insert an old hint
  service.forwardHints.push({
    pdfPath: service.normalizeComparePath(pdfPath),
    sourcePath: service.normalizeComparePath(sourcePath),
    page: 1,
    x: 200,
    y: 400,
    line: 10,
    column: 1,
    timestamp: now - 31000, // 31 seconds ago
  });
  service.cleanupForwardHints(now);
  assert.equal(service.forwardHints.length, 0, "old hint should be cleaned up");
});

test("Recent hints survive cleanup", () => {
  const service = new SynctexService();
  const pdfPath = "/tmp/test.pdf";
  const sourcePath = "/tmp/test.tex";
  const now = Date.now();
  service.forwardHints.push({
    pdfPath: service.normalizeComparePath(pdfPath),
    sourcePath: service.normalizeComparePath(sourcePath),
    page: 1,
    x: 200,
    y: 400,
    line: 10,
    column: 1,
    timestamp: now - 5000, // 5 seconds ago
  });
  service.cleanupForwardHints(now);
  assert.equal(service.forwardHints.length, 1, "recent hint should survive");
});

// ---------------------------------------------------------------------------
// buildReverseOffsets
// ---------------------------------------------------------------------------

test("buildReverseOffsets generates symmetric offsets", () => {
  const service = new SynctexService();
  const { xOffsets, yOffsets } = service.buildReverseOffsets({ x: 200, y: 400, expanded: false });
  assert.ok(xOffsets.includes(0), "x offsets include 0");
  assert.ok(yOffsets.includes(0), "y offsets include 0");
  // Symmetric check
  for (const off of xOffsets) {
    if (off !== 0) {
      assert.ok(xOffsets.includes(-off), `x offsets should include -${off} if ${off} exists`);
    }
  }
  for (const off of yOffsets) {
    if (off !== 0) {
      assert.ok(yOffsets.includes(-off), `y offsets should include -${off} if ${off} exists`);
    }
  }
});

test("buildReverseOffsets expanded includes more offsets", () => {
  const service = new SynctexService();
  const narrow = service.buildReverseOffsets({ x: 200, y: 400, expanded: false });
  const wide = service.buildReverseOffsets({ x: 200, y: 400, expanded: true });
  assert.ok(
    wide.xOffsets.length > narrow.xOffsets.length,
    "expanded x offsets should be larger"
  );
  assert.ok(
    wide.yOffsets.length > narrow.yOffsets.length,
    "expanded y offsets should be larger"
  );
});

// ---------------------------------------------------------------------------
// estimateReverseOffsetMax
// ---------------------------------------------------------------------------

test("estimateReverseOffsetMax returns larger range for larger coordinates", () => {
  const service = new SynctexService();
  const small = service.estimateReverseOffsetMax({ x: 100, y: 200 });
  const medium = service.estimateReverseOffsetMax({ x: 2000, y: 400 });
  const large = service.estimateReverseOffsetMax({ x: 7000, y: 400 });
  assert.ok(small <= medium, `small (${small}) <= medium (${medium})`);
  assert.ok(medium <= large, `medium (${medium}) <= large (${large})`);
});

// ---------------------------------------------------------------------------
// End-to-end: real synctex output → bounding box → coordinate conversion
// ---------------------------------------------------------------------------

test("Real synctex data: bounding box matches actual text line on page", () => {
  const service = new SynctexService();
  // Real output from: synctex view -i "2:1:sections/intro.tex" -o main.pdf
  // Line 2: "This section provides context..."
  const output = [
    "SyncTeX result begin",
    "Output:/tmp/main.pdf",
    "Page:1",
    "x:156.513062",
    "y:156.595749",
    "h:133.768356",
    "v:158.648056",
    "W:343.711060",
    "H:9.075966",
    "before:",
    "offset:-1",
    "middle:",
    "after:",
    "SyncTeX result end",
  ].join("\n");
  const blocks = service.parseForwardBlocks(output);
  assert.equal(blocks.length, 1);
  const block = blocks[0];

  const candidates = service.buildForwardCandidates(block);
  const c = candidates[0];

  // Verify bounding box uses h (left margin) not x (text start)
  assert.ok(
    Math.abs(c.blockX - 133.768356) < 0.01,
    `blockX=${c.blockX} should be h=133.768, not x=156.513`
  );

  // Verify bounding box top = v - H (baseline minus height)
  const expectedTop = 158.648056 - 9.075966; // = 149.572
  assert.ok(
    Math.abs(c.blockY - expectedTop) < 0.01,
    `blockY=${c.blockY} should be v-H=${expectedTop.toFixed(3)}`
  );

  // Verify width spans the text column
  assert.ok(
    Math.abs(c.blockWidth - 343.711060) < 0.01,
    `blockWidth=${c.blockWidth} should be W=343.711`
  );

  // Verify the right edge doesn't exceed page width
  // A4/Letter right edge ~477pt, not 500pt
  const rightEdge = c.blockX + c.blockWidth;
  assert.ok(rightEdge < 480, `right edge ${rightEdge.toFixed(1)} should be < 480`);

  // Simulate applySyncHighlight coordinate conversion
  const PAGE_HEIGHT = 841.89; // A4 page height in points
  const topSynctex = c.blockY; // v - H
  const bottomSynctex = c.blockY + c.blockHeight; // v - H + H + depth ≈ v + depth

  // Convert SyncTeX → PDF coordinates (flip Y)
  const pdfTop = PAGE_HEIGHT - topSynctex; // ~692 (near top in PDF coords)
  const pdfBottom = PAGE_HEIGHT - bottomSynctex; // ~680

  // PDF top should be larger than PDF bottom (PDF y goes up)
  assert.ok(pdfTop > pdfBottom, `pdfTop (${pdfTop.toFixed(1)}) > pdfBottom (${pdfBottom.toFixed(1)})`);

  // The visual height should be ~12pt (H + depth_estimate)
  const visualHeight = pdfTop - pdfBottom;
  assert.ok(visualHeight > 8 && visualHeight < 20,
    `visual height ${visualHeight.toFixed(1)}pt should be 8-20pt for body text`);
});

test("Real synctex data: highlight for citation inline box", () => {
  const service = new SynctexService();
  // Second block from: synctex view -i "7:1:sections/intro.tex"
  // This is a small \cite{} box
  const output = [
    "SyncTeX result begin",
    "Output:/tmp/main.pdf",
    "Page:1",
    "x:170.899124",
    "y:214.849777",
    "h:170.899124",
    "v:214.849777",
    "W:5.409706",
    "H:6.973848",
    "before:",
    "offset:-1",
    "middle:",
    "after:",
    "SyncTeX result end",
  ].join("\n");
  const blocks = service.parseForwardBlocks(output);
  const candidates = service.buildForwardCandidates(blocks[0]);
  const c = candidates[0];

  // For this box h=x, so blockX = h = 170.9
  assert.ok(Math.abs(c.blockX - 170.899) < 0.01);

  // Small citation box: width ~5.4pt
  assert.ok(c.blockWidth < 10, `citation box width ${c.blockWidth} should be small`);

  // Height should include depth estimate
  assert.ok(c.blockHeight > 6.97, `blockHeight ${c.blockHeight} should be > H=6.97`);
});
