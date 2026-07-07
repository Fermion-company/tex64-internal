import test from "node:test";
import assert from "node:assert/strict";

import {
  extractMathEnvFromExcerpt,
  extractRefTargetSummary,
  cleanHeadingText,
} from "../Resources/web/app/monaco-hover/ref-target-preview.js";
import {
  cleanBibValue,
  formatBibAuthors,
  formatBibEntryMarkdown,
} from "../Resources/web/app/monaco-hover/bib-utils.js";
import {
  resolveColorSpec,
  collectDefinedColors,
  rgbToHex,
} from "../Resources/web/app/monaco-hover/color-hover.js";

// ── ref target: math environments ──────────────────────────────

test("extractMathEnvFromExcerpt finds the equation containing the label", () => {
  const lines = [
    "Some text before.",
    "\\begin{equation}",
    "  E = mc^2 \\label{eq:energy}",
    "\\end{equation}",
    "Some text after.",
  ];
  const latex = extractMathEnvFromExcerpt({ startLine: 10, lines, targetLine: 12 });
  assert.ok(latex);
  assert.ok(latex.includes("\\begin{equation}"));
  assert.ok(latex.includes("E = mc^2"));
  assert.ok(latex.includes("\\end{equation}"));
});

test("extractMathEnvFromExcerpt handles align* and multi-line bodies", () => {
  const lines = [
    "\\begin{align*}",
    "  a &= b + c \\\\",
    "  d &= e \\label{eq:d}",
    "\\end{align*}",
  ];
  const latex = extractMathEnvFromExcerpt({ startLine: 1, lines, targetLine: 3 });
  assert.ok(latex);
  assert.ok(latex.startsWith("\\begin{align*}"));
  assert.ok(latex.endsWith("\\end{align*}"));
});

test("extractMathEnvFromExcerpt handles \\[ \\] display blocks", () => {
  const lines = ["intro", "\\[", "  x^2 + y^2 = z^2", "\\]", "outro"];
  const latex = extractMathEnvFromExcerpt({ startLine: 5, lines, targetLine: 7 });
  assert.ok(latex);
  assert.ok(latex.includes("x^2 + y^2 = z^2"));
});

test("extractMathEnvFromExcerpt returns null outside math", () => {
  const lines = ["\\section{Intro}\\label{sec:intro}", "Plain prose."];
  assert.equal(extractMathEnvFromExcerpt({ startLine: 1, lines, targetLine: 1 }), null);
});

test("extractMathEnvFromExcerpt picks the innermost display environment", () => {
  const lines = [
    "\\begin{gather}",
    "  a = 1 \\\\",
    "  b = 2 \\label{eq:b}",
    "\\end{gather}",
  ];
  const latex = extractMathEnvFromExcerpt({ startLine: 1, lines, targetLine: 3 });
  assert.ok(latex);
  assert.ok(latex.includes("\\begin{gather}"));
});

// ── ref target: sections and captions ──────────────────────────

test("extractRefTargetSummary returns section heading", () => {
  const lines = ["\\section{Numerical Results}\\label{sec:results}"];
  const summary = extractRefTargetSummary({ startLine: 4, lines, targetLine: 4 });
  assert.deepEqual(summary, { kind: "section", text: "§ Numerical Results" });
});

test("extractRefTargetSummary looks back for the heading above the label", () => {
  const lines = ["\\subsection{Case $n=2$}", "\\label{sec:case2}"];
  const summary = extractRefTargetSummary({ startLine: 1, lines, targetLine: 2 });
  assert.equal(summary?.kind, "section");
  assert.ok(summary.text.includes("Case"));
});

test("extractRefTargetSummary returns figure caption", () => {
  const lines = [
    "\\begin{figure}",
    "  \\includegraphics{plot.png}",
    "  \\caption{Convergence of the estimator}",
    "  \\label{fig:conv}",
    "\\end{figure}",
  ];
  const summary = extractRefTargetSummary({ startLine: 1, lines, targetLine: 4 });
  assert.deepEqual(summary, { kind: "caption", text: "Convergence of the estimator" });
});

test("cleanHeadingText strips styling commands", () => {
  assert.equal(cleanHeadingText("\\textbf{Bold} and \\emph{em}~text"), "Bold and em text");
});

// ── bib formatting ──────────────────────────────────────────────

test("cleanBibValue resolves accents and drops braces", () => {
  assert.equal(cleanBibValue("{Erd\\H{o}s}, P\\'al"), "Erdős, Pál");
  assert.equal(cleanBibValue("The {Riemann} Hypothesis --- a survey"), "The Riemann Hypothesis — a survey");
});

test("formatBibAuthors converts Last, First and truncates long lists", () => {
  assert.equal(formatBibAuthors("Knuth, Donald E."), "Donald E. Knuth");
  assert.equal(
    formatBibAuthors("Doe, Jane and Smith, John"),
    "Jane Doe, John Smith"
  );
  assert.equal(
    formatBibAuthors("A, X and B, Y and C, Z and others"),
    "X A, Y B, Z C, et al."
  );
  assert.equal(
    formatBibAuthors("A1, F and A2, F and A3, F and A4, F and A5, F"),
    "F A1, F A2, F A3, et al."
  );
});

test("formatBibEntryMarkdown builds a compact card with links", () => {
  const md = formatBibEntryMarkdown({
    title: "Attention Is All You Need",
    author: "Vaswani, Ashish and Shazeer, Noam",
    year: "2017",
    booktitle: "Advances in Neural Information Processing Systems",
    doi: "10.1000/example",
  });
  const lines = md.split("  \n");
  assert.equal(lines[0], "**Attention Is All You Need**");
  assert.equal(lines[1], "Ashish Vaswani, Noam Shazeer");
  assert.ok(lines[2].includes("2017 · Advances in Neural"));
  assert.ok(lines[3].includes("(https://doi.org/10.1000/example)"));
});

test("formatBibEntryMarkdown handles arXiv eprints", () => {
  const md = formatBibEntryMarkdown({
    title: "T",
    eprint: "1706.03762",
    archiveprefix: "arXiv",
  });
  assert.ok(md.includes("[arXiv:1706.03762](https://arxiv.org/abs/1706.03762)"));
});

test("formatBibEntryMarkdown returns empty string for empty fields", () => {
  assert.equal(formatBibEntryMarkdown({}), "");
});

// ── colors ──────────────────────────────────────────────────────

test("resolveColorSpec resolves base and dvips names", () => {
  assert.equal(rgbToHex(resolveColorSpec("red")), "#FF0000");
  assert.equal(rgbToHex(resolveColorSpec("teal")), "#008080");
  assert.equal(rgbToHex(resolveColorSpec("NavyBlue")), "#006EB8");
  assert.equal(resolveColorSpec("notacolor"), null);
});

test("resolveColorSpec handles xcolor mixes", () => {
  // red!50 = 50% red on white
  assert.equal(rgbToHex(resolveColorSpec("red!50")), "#FF8080");
  // blue!50!black = 50% blue + 50% black
  assert.equal(rgbToHex(resolveColorSpec("blue!50!black")), "#000080");
  // full chain stays in range
  const chained = resolveColorSpec("red!80!blue!40");
  assert.ok(chained);
});

test("resolveColorSpec handles explicit models", () => {
  assert.equal(rgbToHex(resolveColorSpec("1,0,0", "rgb")), "#FF0000");
  assert.equal(rgbToHex(resolveColorSpec("255,128,0", "RGB")), "#FF8000");
  assert.equal(rgbToHex(resolveColorSpec("2E86AB", "HTML")), "#2E86AB");
  assert.equal(rgbToHex(resolveColorSpec("0.5", "gray")), "#808080");
  assert.equal(rgbToHex(resolveColorSpec("0,0,0,1", "cmyk")), "#000000");
  assert.equal(resolveColorSpec("garbage", "rgb"), null);
});

test("collectDefinedColors picks up definecolor and colorlet", () => {
  const doc = [
    "\\documentclass{article}",
    "\\definecolor{brand}{HTML}{2E86AB}",
    "\\colorlet{brandlight}{brand!50}",
    "\\begin{document}",
  ];
  const defined = collectDefinedColors((n) => doc[n - 1] ?? "", doc.length);
  assert.equal(rgbToHex(defined.get("brand")), "#2E86AB");
  assert.ok(defined.get("brandlight"));
  // brand!50 = mixed with white (rounded per channel)
  assert.equal(rgbToHex(defined.get("brandlight")), "#97C3D5");
});
