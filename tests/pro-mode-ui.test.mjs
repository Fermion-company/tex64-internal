import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateProSplitterDrag,
  clampProRatios,
  createProSplitViewCoordinator,
  parseProModeState,
  proShortcutPane,
} from "../Resources/web/app/pro-mode-ui.js";

test("splitter drag collapses panes below the minimum and freely restores ratios", () => {
  // Layout 1 renders source LEFT / preview RIGHT, so the pointer ratio at the
  // splitter is the source's share while ratios[0] remains the preview's.
  assert.equal(calculateProSplitterDrag("preview-source", 0, 0.05, [.34, .33, .33], .1).collapse, "source");
  assert.equal(calculateProSplitterDrag("preview-source", 0, 0.95, [.34, .33, .33], .1).collapse, "preview");
  const open = calculateProSplitterDrag("preview-source", 0, .42, [.34, .33, .33], .1);
  assert.equal(open.collapse, null);
  assert.ok(Math.abs(open.ratios[0] - .58) < 1e-9);
  assert.equal(calculateProSplitterDrag("source-reference-code", 1, .95, [.34, .33, .33], .1).collapse, "code");
});

test("Pro pane shortcuts map without using the structure-menu shortcut", () => {
  assert.equal(proShortcutPane("1", "preview-source"), "preview");
  assert.equal(proShortcutPane("1", "source-reference-code"), "reference");
  assert.equal(proShortcutPane("2", "preview-source"), "source");
  assert.equal(proShortcutPane("3", "source-reference-code"), "code");
  assert.equal(proShortcutPane("o", "preview-source"), null);
});

test("Pro pane ratios are normalized and clamped", () => {
  const ratios = clampProRatios([0.98, 0.01, 0.01], 0.12);
  assert.ok(ratios.every((ratio) => ratio >= 0.119));
  assert.ok(Math.abs(ratios.reduce((sum, ratio) => sum + ratio, 0) - 1) < 1e-9);
});

test("Pro mode state restores valid persisted values", () => {
  const state = parseProModeState(JSON.stringify({
    enabled: true,
    layout: "preview-source",
    ratios: [2, 1, 1],
    collapsed: { preview: true, source: false, reference: true, code: false },
  }));
  assert.equal(state.enabled, true);
  assert.equal(state.layout, "preview-source");
  assert.deepEqual(state.collapsed, { preview: true, source: false, reference: true, code: false });
  assert.deepEqual(state.ratios, [0.5, 0.25, 0.25]);
});

// The 3-pane layout retired with the reference window: whatever a profile has
// stored, Pro mode comes up on preview | source.
test("Pro mode state normalizes the retired 3-pane layout", () => {
  const state = parseProModeState(JSON.stringify({ enabled: true, layout: "source-reference-code" }));
  assert.equal(state.layout, "preview-source");
});

test("Pro mode state safely falls back for corrupt storage", () => {
  const state = parseProModeState("not json");
  assert.equal(state.enabled, false);
  assert.equal(state.layout, "preview-source");
  assert.equal(state.collapsed.code, true);
});

test("Pro mode restores the light-mode split view state when disabled", () => {
  let splitEnabled = true;
  const changes = [];
  const syncSplitView = createProSplitViewCoordinator({
    getSplitViewEnabled: () => splitEnabled,
    setSplitViewEnabled: (enabled) => {
      splitEnabled = enabled;
      changes.push(enabled);
    },
  });

  syncSplitView(false, "preview-source");
  assert.deepEqual(changes, []);
  syncSplitView(true, "preview-source");
  syncSplitView(true, "source-reference-code");
  syncSplitView(false, "source-reference-code");

  assert.deepEqual(changes, [false, true, true]);
  assert.equal(splitEnabled, true);
});
