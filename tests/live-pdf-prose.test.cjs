const test = require("node:test");
const assert = require("node:assert/strict");
const { matchProse, updatePrintedText } = require("../electron/services/live-pdf-prose.cjs");

test("independent edits preserve the original TeX line break and escaped characters", () => {
  let state = { raw: "a\n   b\\%", visible: "a b%", offsets: [0, 1, 5, 6, 8] };
  state = updatePrintedText(state, "A b%");
  state = updatePrintedText(state, "A b%&#_");
  assert.equal(state.raw, "A\n   b\\%\\&\\#\\_");
  state = updatePrintedText(state, "A b\n");
  assert.equal(state.raw, "A\n   b\n\n");
  assert.deepEqual(state.offsets, [0, 1, 5, 6, 8]);
});

test("a repeated run requires every occurrence in the same SyncTeX row and reliable reading order", () => {
  const src = "same and same";
  const regions = [{ kind: "text", start: 0, end: src.length, contentStart: 0, contentEnd: src.length,
    value: src, sourceValue: src }];
  const boxes = [{ box: { left: 10, top: 10, right: 80, bottom: 24 } }];
  const match = points => matchProse(src, regions, 0, src.length, "same", () => true, boxes, points);
  const first = { x: 16, y: 18 }, second = { x: 48, y: 18, selected: true };
  assert.deepEqual(match(), { needsOccurrences: true });
  assert.equal(match([second]), null);
  assert.equal(match([second, first]), null);
  assert.equal(match([first, { ...second, y: 32 }]), null);
  assert.equal(match([first, second]).a, 9);
});

test("a matching phrase in opaque macro output cannot replace an identical literal", () => {
  const src = "\\copyText{} same", start = src.indexOf("same");
  const region = { kind: "text", start, end: src.length, contentStart: start, contentEnd: src.length,
    value: "same", sourceValue: "same" };
  assert.equal(matchProse(src, [region], 0, src.length, "same", () => true, [], null), null);
});
