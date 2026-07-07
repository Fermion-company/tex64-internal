import test from "node:test";
import assert from "node:assert/strict";

import {
  findMacroDefinitionInLines,
  findCommandTokenAt,
} from "../Resources/web/app/monaco-hover/macro-definition.js";

const linesAccessor = (lines) => (n) => lines[n - 1] ?? "";

test("finds a simple newcommand definition", () => {
  const lines = [
    "\\documentclass{article}",
    "\\newcommand{\\R}{\\mathbb{R}}",
    "\\begin{document}",
  ];
  const def = findMacroDefinitionInLines(linesAccessor(lines), lines.length, "R");
  assert.ok(def);
  assert.equal(def.lineNumber, 2);
  assert.ok(def.text.includes("\\mathbb{R}"));
});

test("does not match a longer command name prefix", () => {
  const lines = ["\\newcommand{\\Real}{\\mathbb{R}}"];
  assert.equal(findMacroDefinitionInLines(linesAccessor(lines), 1, "R"), null);
  assert.ok(findMacroDefinitionInLines(linesAccessor(lines), 1, "Real"));
});

test("supports brace-less and operator declarations", () => {
  const lines = [
    "\\newcommand\\etal{\\textit{et al.}}",
    "\\DeclareMathOperator*{\\argmin}{arg\\,min}",
    "\\def\\eps{\\varepsilon}",
  ];
  assert.equal(findMacroDefinitionInLines(linesAccessor(lines), 3, "etal")?.lineNumber, 1);
  assert.equal(findMacroDefinitionInLines(linesAccessor(lines), 3, "argmin")?.lineNumber, 2);
  assert.equal(findMacroDefinitionInLines(linesAccessor(lines), 3, "eps")?.lineNumber, 3);
});

test("captures multi-line definitions while braces stay open", () => {
  const lines = [
    "\\newcommand{\\norm}[1]{",
    "  \\left\\lVert #1 \\right\\rVert",
    "}",
    "text",
  ];
  const def = findMacroDefinitionInLines(linesAccessor(lines), lines.length, "norm");
  assert.ok(def);
  assert.equal(def.lineNumber, 1);
  assert.ok(def.text.includes("\\lVert"));
  assert.ok(def.text.trimEnd().endsWith("}"));
});

test("returns null when no definition exists", () => {
  const lines = ["Some text with \\undefinedmacro usage."];
  assert.equal(findMacroDefinitionInLines(linesAccessor(lines), 1, "undefinedmacro"), null);
});

test("findCommandTokenAt returns the command under the cursor", () => {
  const line = "Let \\R be the reals and \\norm{x} a norm.";
  const idx = line.indexOf("\\norm") + 2;
  assert.deepEqual(findCommandTokenAt(line, idx), {
    name: "norm",
    startIndex: line.indexOf("\\norm"),
    endIndex: line.indexOf("\\norm") + "\\norm".length,
  });
  assert.equal(findCommandTokenAt(line, 0), null);
});

test("findCommandTokenAt skips escaped backslash sequences", () => {
  const line = "a \\\\alpha b";
  // Cursor inside "alpha" of "\\\\alpha": the backslash before "alpha" is
  // escaped, so this is not a command.
  const idx = line.indexOf("alpha") + 1;
  assert.equal(findCommandTokenAt(line, idx), null);
});
