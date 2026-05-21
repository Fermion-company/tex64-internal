import test from "node:test";
import assert from "node:assert/strict";

import { tokenizeLatexProse, shouldCheckWord } from "../Resources/web/app/spell/latex-tokenizer.js";

const words = (text) => tokenizeLatexProse(text).map((t) => t.word);

test("plain prose words are tokenized", () => {
  assert.deepEqual(words("hello world foo"), ["hello", "world", "foo"]);
});

test("command names are skipped, prose args are kept", () => {
  // \section and \textbf names skipped; their brace contents kept.
  assert.deepEqual(words("\\section{Introduction} and \\textbf{bold} text"), [
    "Introduction",
    "and",
    "bold",
    "text",
  ]);
});

test("non-prose command args are skipped", () => {
  assert.deepEqual(words("see \\ref{sec:intro} and \\cite{knuth1984} here"), ["see", "and", "here"]);
  assert.deepEqual(words("\\label{fig:plot} caption"), ["caption"]);
  assert.deepEqual(words("\\usepackage[utf8]{inputenc} done"), ["done"]);
});

test("inline and display math is skipped", () => {
  assert.deepEqual(words("text $x = y_2$ more"), ["text", "more"]);
  assert.deepEqual(words("pre \\(z = 1\\) post"), ["pre", "post"]);
  assert.deepEqual(words("pre \\[ \\sinh x \\] post"), ["pre", "post"]);
  assert.deepEqual(words("pre $$ \\alpha + beta $$ post"), ["pre", "post"]);
});

test("math environments are skipped", () => {
  const src = "before\n\\begin{align}\n x = y + zz \\\\\n\\end{align}\nafter";
  assert.deepEqual(words(src), ["before", "after"]);
});

test("comments are skipped", () => {
  assert.deepEqual(words("real text % commented mistayke here\nnext"), ["real", "text", "next"]);
});

test("escaped chars are not words", () => {
  assert.deepEqual(words("100\\% done \\& finished"), ["done", "finished"]);
});

test("\\href keeps the link text but skips the URL", () => {
  assert.deepEqual(words("\\href{https://example.com}{click here}"), ["click", "here"]);
});

test("acronyms (all caps) and single letters are skipped", () => {
  assert.deepEqual(words("a PDF file in HTML"), ["file", "in"]);
});

test("apostrophes and hyphens are kept internally", () => {
  assert.deepEqual(words("don't use well-known tricks"), ["don't", "use", "well-known", "tricks"]);
});

test("token positions are 1-based and span the word", () => {
  const toks = tokenizeLatexProse("ab cde");
  assert.deepEqual(toks[0], { word: "ab", lineNumber: 1, startColumn: 1, endColumn: 3 });
  assert.deepEqual(toks[1], { word: "cde", lineNumber: 1, startColumn: 4, endColumn: 7 });
});

test("positions track newlines", () => {
  const toks = tokenizeLatexProse("first\n  second");
  assert.equal(toks[1].word, "second");
  assert.equal(toks[1].lineNumber, 2);
  assert.equal(toks[1].startColumn, 3);
});

test("shouldCheckWord filters", () => {
  assert.equal(shouldCheckWord("a"), false);
  assert.equal(shouldCheckWord("PDF"), false);
  assert.equal(shouldCheckWord("hello"), true);
});
