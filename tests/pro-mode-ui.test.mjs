import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateProSplitterDrag,
  clampPreviewShare,
  parseProModeState,
  proShortcutPane,
} from "../Resources/web/app/pro-mode-ui.js";

test("splitter drag collapses panes below the minimum and restores the preview share", () => {
  assert.equal(calculateProSplitterDrag(.05, .34, .1).collapse, "source");
  assert.equal(calculateProSplitterDrag(.95, .34, .1).collapse, "preview");
  const open = calculateProSplitterDrag(.42, .34, .1);
  assert.equal(open.collapse, null);
  assert.ok(Math.abs(open.previewShare - .58) < 1e-9);
});

test("Code pane shortcuts map without using the structure-menu shortcut", () => {
  assert.equal(proShortcutPane("1"), "preview");
  assert.equal(proShortcutPane("2"), "source");
  assert.equal(proShortcutPane("3"), null);
  assert.equal(proShortcutPane("o"), null);
});

test("Code preview share is clamped", () => {
  assert.equal(clampPreviewShare(.98, .12), .88);
  assert.equal(clampPreviewShare(.01, .12), .12);
});

test("Code workspace state restores valid persisted values", () => {
  const state = parseProModeState(JSON.stringify({
    enabled: true,
    ratios: [2, 1, 1],
    collapsed: { preview: true, source: false, reference: true, code: false },
  }));
  assert.deepEqual(state.collapsed, { preview: true, source: false });
  assert.equal(state.previewShare, .5);
});

test("Code workspace state safely falls back for corrupt storage", () => {
  const state = parseProModeState("not json");
  assert.equal(state.previewShare, .34);
  assert.deepEqual(state.collapsed, { preview: false, source: false });
});
