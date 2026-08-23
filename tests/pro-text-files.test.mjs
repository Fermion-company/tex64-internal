import test from "node:test";
import assert from "node:assert/strict";

import {
  isEditableTextFilePath,
  isExtendedTextFilePath,
} from "../Resources/web/app/files.js";

test("Pro text file paths include common programming and text files", () => {
  for (const path of ["src/main.py", "a/b/Makefile", ".gitignore", "Dockerfile", "notes.md"]) {
    assert.equal(isExtendedTextFilePath(path), true, path);
  }
  for (const path of ["main.tex", "figure.png", "paper.pdf", "archive.zip"]) {
    assert.equal(isExtendedTextFilePath(path), false, path);
  }
});

test("editable text paths include TeX and Pro text files", () => {
  assert.equal(isEditableTextFilePath("main.tex"), true);
  assert.equal(isEditableTextFilePath("src/main.py"), true);
  assert.equal(isEditableTextFilePath("figure.png"), false);
});
