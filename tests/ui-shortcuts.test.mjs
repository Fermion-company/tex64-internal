import test from "node:test";
import assert from "node:assert/strict";

import { isBuildShortcutEvent } from "../Resources/web/app/ui-events.js";

const event = (overrides = {}) => ({
  altKey: false,
  ctrlKey: false,
  defaultPrevented: false,
  key: "Enter",
  metaKey: true,
  shiftKey: false,
  target: null,
  ...overrides,
});

test("Cmd/Ctrl+Enter triggers build outside form controls", () => {
  assert.equal(isBuildShortcutEvent(event()), true);
  assert.equal(isBuildShortcutEvent(event({ metaKey: false, ctrlKey: true })), true);
  assert.equal(isBuildShortcutEvent(event({ key: "b" })), false);
  assert.equal(isBuildShortcutEvent(event({ defaultPrevented: true })), false);
});

test("Cmd/Ctrl+Enter does not steal submission from text fields", () => {
  const textarea = {
    tagName: "TEXTAREA",
    closest: () => null,
  };
  const monacoTextarea = {
    tagName: "TEXTAREA",
    closest: (selector) => (selector === ".monaco-editor" ? {} : null),
  };
  assert.equal(isBuildShortcutEvent(event({ target: textarea })), false);
  assert.equal(isBuildShortcutEvent(event({ target: monacoTextarea })), true);
});
