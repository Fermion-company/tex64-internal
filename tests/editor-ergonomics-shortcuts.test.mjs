import test from "node:test";
import assert from "node:assert/strict";

import { attachEditorErgonomics } from "../Resources/web/app/editor-ergonomics.js";

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
    Range: class Range {
      constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
        this.startLineNumber = startLineNumber;
        this.startColumn = startColumn;
        this.endLineNumber = endLineNumber;
        this.endColumn = endColumn;
      }
    },
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
