const test = require("node:test");
const assert = require("node:assert");

const {
  findIntroducedLatexDuplicates,
  findIntroducedDuplicateLine,
} = require("../electron/services/agent-tools-safety.cjs");

const PAPER = [
  "\\documentclass{article}",
  "\\title{A Survey}",
  "\\author{Anonymous}",
  "",
  "\\begin{document}",
  "\\maketitle",
  "\\end{document}",
].join("\n");

test("rejects a renamed author written beside the old one", () => {
  const edited = PAPER.replace(
    "\\author{Anonymous}",
    "\\author{Anonymous}\n\\author{Wedd}"
  );
  assert.deepStrictEqual(
    findIntroducedLatexDuplicates("main.tex", PAPER, edited),
    ["\\author"]
  );
});

test("rejects the same command duplicated verbatim", () => {
  const edited = PAPER.replace(
    "\\author{Anonymous}",
    "\\author{Wedd}\n\\author{Wedd}"
  );
  assert.deepStrictEqual(
    findIntroducedLatexDuplicates("main.tex", PAPER, edited),
    ["\\author"]
  );
});

test("accepts editing the command in place", () => {
  const edited = PAPER.replace("\\author{Anonymous}", "\\author{Wedd}");
  assert.deepStrictEqual(
    findIntroducedLatexDuplicates("main.tex", PAPER, edited),
    []
  );
});

test("leaves a duplicate the file already had alone", () => {
  const already = PAPER.replace(
    "\\author{Anonymous}",
    "\\author{A}\n\\author{B}"
  );
  const edited = already.replace("\\title{A Survey}", "\\title{A Brief Survey}");
  assert.deepStrictEqual(
    findIntroducedLatexDuplicates("main.tex", already, edited),
    []
  );
});

test("ignores commented-out copies", () => {
  const edited = PAPER.replace(
    "\\author{Anonymous}",
    "% \\author{Anonymous}\n\\author{Wedd}"
  );
  assert.deepStrictEqual(
    findIntroducedLatexDuplicates("main.tex", PAPER, edited),
    []
  );
});

test("only guards .tex files", () => {
  const edited = PAPER.replace(
    "\\author{Anonymous}",
    "\\author{Anonymous}\n\\author{Wedd}"
  );
  assert.deepStrictEqual(
    findIntroducedLatexDuplicates("notes.md", PAPER, edited),
    []
  );
});

test("reports a substantial line the edit duplicated next to itself", () => {
  const before = "alpha\nThe survey covers attention in transformers.\nomega";
  const after =
    "alpha\nThe survey covers attention in transformers.\n" +
    "The survey covers attention in transformers.\nomega";
  assert.strictEqual(
    findIntroducedDuplicateLine(before, after),
    "The survey covers attention in transformers."
  );
});

test("leaves short repeated lines alone", () => {
  const before = "\\begin{align}\nx\n\\end{align}";
  const after = "\\begin{align}\nx\nx\n\\end{align}";
  assert.strictEqual(findIntroducedDuplicateLine(before, after), null);
});

test("leaves a repeated pair the file already had alone", () => {
  const line = "The survey covers attention in transformers.";
  const before = `alpha\n${line}\n${line}\nomega`;
  const after = `alpha\n${line}\n${line}\nomega\ntail`;
  assert.strictEqual(findIntroducedDuplicateLine(before, after), null);
});
