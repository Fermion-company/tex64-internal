const test = require("node:test");
const assert = require("node:assert/strict");
const {
  looksBinary,
  isSearchableSourceFile,
  isExtendedTextFileName,
} = require("../electron/services/text-file-types.cjs");

test("looksBinary detects NUL bytes", () => {
  assert.equal(
    looksBinary(Buffer.concat([Buffer.from("#!/usr/bin/env python\n"), Buffer.alloc(64)])),
    true,
  );
  assert.equal(looksBinary(Buffer.from("print('hello')\n")), false);
});

test("isSearchableSourceFile includes source text and excludes build artifacts", () => {
  for (const name of ["main.tex", "refs.bib", "notes.py", "Makefile"]) {
    assert.equal(isSearchableSourceFile(name), true, name);
  }
  for (const name of ["main.aux", "build.log", "figure.png"]) {
    assert.equal(isSearchableSourceFile(name), false, name);
  }
});

test("isExtendedTextFileName recognizes supported names and extensions", () => {
  assert.equal(isExtendedTextFileName(".gitignore"), true);
  assert.equal(isExtendedTextFileName("sample.py"), true);
  assert.equal(isExtendedTextFileName("archive.zip"), false);
});
