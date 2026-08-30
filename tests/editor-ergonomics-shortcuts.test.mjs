import test from "node:test";
import assert from "node:assert/strict";

import {
  attachEditorErgonomics,
  planEnvironmentCompletion,
  planTexDelimiterCompletion,
} from "../Resources/web/app/editor-ergonomics.js";

const TestRange = class Range {
  constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
    this.startLineNumber = startLineNumber;
    this.startColumn = startColumn;
    this.endLineNumber = endLineNumber;
    this.endColumn = endColumn;
  }
};

test("TeX delimiters replace Monaco's plain closer", () => {
  assert.deepEqual(planTexDelimiterCompletion("[", "\\[", "]"), {
    text: "\n  \n\\]",
    replaceLength: 1,
    cursorLineDelta: 1,
    cursorColumn: 3,
  });
  assert.deepEqual(planTexDelimiterCompletion("(", "text \\(", ")"), {
    text: "\\)",
    replaceLength: 1,
  });
  assert.equal(planTexDelimiterCompletion("[", "[", "]"), null);
  assert.equal(planTexDelimiterCompletion("[", "\\\\[", "]"), null);
  assert.equal(planTexDelimiterCompletion("[", "\\[", "\\]"), null);
});

test("environment completion creates one indented blank body line", () => {
  assert.deepEqual(planEnvironmentCompletion("  \\begin{align*}", ""), {
    text: "\n    \n  \\end{align*}",
    cursorColumn: 5,
  });
  assert.equal(planEnvironmentCompletion("prefix \\begin{align}", ""), null);
  assert.equal(planEnvironmentCompletion("\\begin{align}", " trailing"), null);
});

test("typing a TeX display opener creates a blank body line and moves the caret into it", () => {
  let onDidType = null;
  const edits = [];
  const positions = [];
  const editor = {
    onDidType: (listener) => { onDidType = listener; },
    onKeyDown: () => {},
    getModel: () => ({ getLineContent: () => "\\[]" }),
    getPosition: () => ({ lineNumber: 1, column: 3 }),
    executeEdits: (source, nextEdits) => edits.push({ source, ...nextEdits[0] }),
    setPosition: (position) => positions.push(position),
  };
  attachEditorErgonomics(
    { KeyCode: { Enter: 3 }, Range: TestRange },
    editor,
    {}
  );

  onDidType("[");

  assert.equal(edits[0].source, "ergo-tex-delimiter");
  assert.equal(edits[0].text, "\n  \n\\]");
  assert.deepEqual(edits[0].range, new TestRange(1, 3, 1, 4));
  assert.deepEqual(positions[0], { lineNumber: 2, column: 3 });
});

test("typing the final environment brace inserts body and places the caret in it", () => {
  let onDidType = null;
  const edits = [];
  const positions = [];
  const line = "  \\begin{equation}";
  const editor = {
    onDidType: (listener) => { onDidType = listener; },
    onKeyDown: () => {},
    getModel: () => ({ getLineContent: () => line }),
    getPosition: () => ({ lineNumber: 4, column: line.length + 1 }),
    executeEdits: (source, nextEdits) => edits.push({ source, ...nextEdits[0] }),
    setPosition: (position) => positions.push(position),
  };
  attachEditorErgonomics(
    { KeyCode: { Enter: 3 }, Range: TestRange },
    editor,
    {}
  );

  onDidType("}");

  assert.equal(edits[0].source, "ergo-env");
  assert.equal(edits[0].text, "\n    \n  \\end{equation}");
  assert.deepEqual(positions[0], { lineNumber: 5, column: 5 });
});

test("Cmd+B is reserved for LaTeX bold wrapping, not build", () => {
  const actions = [];
  const edits = [];
  let position = null;
  let focused = false;
  const selection = {
    startLineNumber: 2,
    startColumn: 5,
    endLineNumber: 2,
    endColumn: 5,
  };
  const KeyMod = { CtrlCmd: 2048 };
  const KeyCode = { Enter: 3, KeyB: 34, KeyI: 35 };
  const monaco = {
    KeyMod,
    KeyCode,
    Range: TestRange,
  };
  const editor = {
    onKeyDown: () => {},
    addAction: (action) => actions.push(action),
    getSelection: () => selection,
    getModel: () => ({ getValueInRange: () => "" }),
    executeEdits: (_source, nextEdits) => edits.push(...nextEdits),
    setPosition: (nextPosition) => {
      position = nextPosition;
    },
    focus: () => {
      focused = true;
    },
  };

  attachEditorErgonomics(monaco, editor, {});

  const bold = actions.find((action) => action.id === "tex64.wrap.textbf");
  assert.ok(bold);
  assert.deepEqual(bold.keybindings, [KeyMod.CtrlCmd | KeyCode.KeyB]);
  assert.equal(actions.some((action) => /build/i.test(`${action.id} ${action.label}`)), false);

  bold.run();

  assert.equal(edits[0].text, "\\textbf{}");
  assert.deepEqual(position, { lineNumber: 2, column: 13 });
  assert.equal(focused, true);
});
