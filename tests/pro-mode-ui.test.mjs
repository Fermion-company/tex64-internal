import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateProSplitterDrag,
  clampPreviewShare,
  isCodePreviewVisible,
  parseProModeState,
} from "../Resources/web/app/pro-mode-ui.js";

test("splitter drag keeps both the editor and preview usable", () => {
  assert.equal(calculateProSplitterDrag(.05, .1).previewShare, .9);
  assert.equal(calculateProSplitterDrag(.95, .1).previewShare, .1);
  const open = calculateProSplitterDrag(.42, .1);
  assert.ok(Math.abs(open.previewShare - .58) < 1e-9);
});

test("Code preview share is clamped", () => {
  assert.equal(clampPreviewShare(.98, .12), .88);
  assert.equal(clampPreviewShare(.01, .12), .12);
});

test("Code preview is hidden when PDF output uses a detached window", () => {
  assert.equal(isCodePreviewVisible(true, false), false);
  assert.equal(isCodePreviewVisible(true, true), true);
  assert.equal(isCodePreviewVisible(false, true), false);
});

test("Code workspace state restores valid persisted values", () => {
  const state = parseProModeState(JSON.stringify({
    enabled: true,
    ratios: [2, 1, 1],
    collapsed: { preview: true, source: false, reference: true, code: false },
  }));
  assert.equal(state.previewShare, .5);
});

test("Code workspace state safely falls back for corrupt storage", () => {
  const state = parseProModeState("not json");
  assert.equal(state.previewShare, .34);
});
