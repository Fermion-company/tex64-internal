const test = require("node:test");
const assert = require("node:assert/strict");
const { SynctexService } = require("../electron/services/synctex/service.cjs");

// Regressions pinned here, found via the e2e-paper workspace (2026-08-20):
// clicks inside a paragraph resolved to the neighboring paragraph or to the
// blank line between them. Two causes: measureForwardDistance capped box
// width at 200pt — a paragraph that is one source line has a 453pt-wide line
// box, so the real box was demoted to distance-from-left-edge — and read the
// box as [baseline, baseline+H] instead of [baseline-H, baseline+depth]. And
// the exact synctex hit used to evict every other candidate, even when it
// named the blank line synctex charges the inter-paragraph glue to.

const viewOutput = (rows) =>
  [
    "This is SyncTeX command line utility, version 1.5",
    "SyncTeX result begin",
    ...rows.flatMap((row) => [
      "Output:main.pdf",
      `Page:${row.page}`,
      `x:${row.x}`,
      `y:${row.y}`,
      `h:${row.h}`,
      `v:${row.v}`,
      `W:${row.W}`,
      `H:${row.H}`,
      "before:",
      "offset:-1",
      "middle:",
      "after:",
    ]),
    "SyncTeX result end",
  ].join("\n");

const measureArgs = (click) => ({
  synctexPath: "/usr/bin/synctex",
  pdfPath: "/w/main.pdf",
  sourcePath: "/w/main.tex",
  line: 36,
  column: 1,
  click,
  cwd: "/w",
  env: {},
});

test("a paragraph-wide line box still measures as a box", async () => {
  const service = new SynctexService();
  // One rendered row of a one-source-line paragraph: 453pt wide, 9.9pt tall,
  // baseline at v. The old width cap (200pt) demoted this to a point.
  service.runProcess = async () => ({
    status: 0,
    output: viewOutput([
      { page: 1, x: 106.5, y: 567.2, h: 70.8, v: 569.5, W: 453.5, H: 9.9 },
    ]),
  });
  const inside = await service.measureForwardDistance(
    measureArgs({ page: 1, x: 300, y: 565 }),
  );
  assert.equal(inside, 0);
  // A click 9.6pt above the band [v-H, v+3] measures by that gap, squared.
  const above = await service.measureForwardDistance(
    measureArgs({ page: 1, x: 300, y: 550 }),
  );
  assert.ok(above > 80 && above < 100, `expected ~92, got ${above}`);
});

test("the box spans [baseline-H, baseline+depth], not below the baseline", async () => {
  const service = new SynctexService();
  service.runProcess = async () => ({
    status: 0,
    output: viewOutput([
      { page: 1, x: 106.5, y: 567.2, h: 70.8, v: 569.5, W: 453.5, H: 9.9 },
    ]),
  });
  // Just above the baseline is inside the glyphs; the old reading placed the
  // box below the baseline and measured this as a miss.
  const aboveBaseline = await service.measureForwardDistance(
    measureArgs({ page: 1, x: 300, y: 563 }),
  );
  assert.equal(aboveBaseline, 0);
});

test("an exact hit on the inter-paragraph blank line does not evict the prose", async () => {
  const service = new SynctexService();
  service.measureForwardDistance = async () => 0;
  service.getReverseLinePenalty = ({ line }) => (line === 43 ? 1200 : 0);
  const selected = await service.selectReverseCandidate({
    candidates: [
      // The paragraph the reader clicked: hit by many nearby offsets.
      { path: "/w/main.tex", line: 36, column: 1, count: 40, exactHit: false, minOffsetDistance: 4 },
      // The blank line synctex charges the glue to: the exact hit itself.
      { path: "/w/main.tex", line: 43, column: 1, count: 10, exactHit: true, minOffsetDistance: 0 },
    ],
    click: { page: 1, x: 300, y: 679 },
    synctexPath: "/usr/bin/synctex",
    pdfPath: "/w/main.pdf",
    cwd: "/w",
    env: {},
  });
  assert.equal(selected.line, 36);
});
