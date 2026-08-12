import test from "node:test";
import assert from "node:assert/strict";
import { ensureTrailingNewline } from "../Resources/web/app/pro-editor-insert.js";

test("editor insert text ends with exactly the existing or one appended newline", () => {
  assert.equal(ensureTrailingNewline("snippet"), "snippet\n");
  assert.equal(ensureTrailingNewline("snippet\n"), "snippet\n");
  assert.equal(ensureTrailingNewline("snippet\n\n"), "snippet\n\n");
});
