import test from "node:test";
import assert from "node:assert/strict";

import {
  isEditableTextFilePath,
  isProTextFilePath,
} from "../Resources/web/app/files.js";

test("Pro text file paths include common programming and text files", () => {
  for (const path of ["src/main.py", "a/b/Makefile", ".gitignore", "Dockerfile", "notes.md"]) {
    assert.equal(isProTextFilePath(path), true, path);
  }
  for (const path of ["main.tex", "figure.png", "paper.pdf", "archive.zip"]) {
    assert.equal(isProTextFilePath(path), false, path);
  }
});

test("editable text paths include TeX and Pro text files", () => {
  assert.equal(isEditableTextFilePath("main.tex"), true);
  assert.equal(isEditableTextFilePath("src/main.py"), true);
  assert.equal(isEditableTextFilePath("figure.png"), false);
});
