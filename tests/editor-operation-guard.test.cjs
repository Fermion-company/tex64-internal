"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const ts = require("typescript");

test("ending history cannot unlock a Git operation and preserves pre-existing read-only editors", async () => {
  const source = await fs.readFile(path.join(__dirname, "../web-src/app/editor-operation-guard.ts"), "utf8");
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const { getEditorOperationGuard } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  const makeEditor = readOnly => ({ readOnly, getRawOptions() { return { readOnly: this.readOnly }; }, updateOptions(value) { this.readOnly = value.readOnly; } });
  const editable = makeEditor(false), viewer = makeEditor(true), later = makeEditor(false);
  const groups = [{ editor: editable }, { editor: viewer }];
  const session = { getEditorGroups: () => groups };
  const history = getEditorOperationGuard(session), git = getEditorOperationGuard(session);
  history.setLocked("history-ui", true);
  git.setLocked("git-ui", true);
  history.setLocked("history-ui", false);
  assert.equal(editable.readOnly, true);
  groups.push({ editor: later }); git.refresh();
  assert.equal(later.readOnly, true);
  git.setLocked("git-ui", false);
  assert.equal(editable.readOnly, false);
  assert.equal(later.readOnly, false);
  assert.equal(viewer.readOnly, true);
});
