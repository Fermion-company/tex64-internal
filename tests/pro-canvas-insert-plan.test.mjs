import test from "node:test";
import assert from "node:assert/strict";

const { planBodyInsert, missingPreambleLines, planFigureInsert } = await import(
  "../Resources/web/app/pro-canvas/insert-plan.js"
);

const DOC = [
  "\\documentclass{article}",
  "\\usepackage{amsmath}",
  "",
  "\\begin{document}",
  "Hello.",
  "",
  "\\end{document}",
].join("\n");

test("a preamble cursor is moved to just before \\end{document}", () => {
  const { point, moved } = planBodyInsert(DOC, { lineNumber: 1, column: 1 });
  assert.equal(moved, true);
  assert.deepEqual(point, { lineNumber: 7, column: 1 });
});

test("a cursor already in the body is left alone", () => {
  const { point, moved } = planBodyInsert(DOC, { lineNumber: 5, column: 7 });
  assert.equal(moved, false);
  assert.deepEqual(point, { lineNumber: 5, column: 7 });
});

test("a document without \\begin{document} keeps the cursor", () => {
  const { point, moved } = planBodyInsert("just a fragment\n", { lineNumber: 1, column: 3 });
  assert.equal(moved, false);
  assert.deepEqual(point, { lineNumber: 1, column: 3 });
});

test("a missing \\end{document} appends past the last line", () => {
  const { point } = planBodyInsert("\\begin{document}\nbody\n", { lineNumber: 1, column: 1 });
  assert.equal(point.lineNumber, 4);
});

test("missing packages and libraries are reported", () => {
  assert.deepEqual(missingPreambleLines(DOC, ["arrows.meta", "patterns"], false), [
    "\\usepackage{tikz}",
    "\\usetikzlibrary{arrows.meta,patterns}",
  ]);
});

test("packages already present are not repeated", () => {
  const doc = DOC.replace(
    "\\usepackage{amsmath}",
    "\\usepackage{amsmath,tikz}\n\\usetikzlibrary{arrows.meta}"
  );
  assert.deepEqual(missingPreambleLines(doc, ["arrows.meta"], false), []);
  assert.deepEqual(missingPreambleLines(doc, ["arrows.meta", "patterns"], false), [
    "\\usetikzlibrary{patterns}",
  ]);
});

test("pgfplots brings its compat line, and standalone needs no tikz package", () => {
  assert.deepEqual(missingPreambleLines(DOC, [], true), [
    "\\usepackage{tikz}",
    "\\usepackage{pgfplots}",
    "\\pgfplotsset{compat=1.18}",
  ]);
  const standalone = "\\documentclass{standalone}\n\\begin{document}\n\\end{document}\n";
  assert.deepEqual(missingPreambleLines(standalone, [], false), []);
});

test("a commented-out package still counts as missing", () => {
  const doc = DOC.replace("\\usepackage{amsmath}", "% \\usepackage{tikz}");
  assert.ok(missingPreambleLines(doc, [], false).includes("\\usepackage{tikz}"));
});

test("a commented \\begin{document} does not fool the body search", () => {
  const doc = "\\documentclass{article}\n% \\begin{document}\n\\begin{document}\nx\n\\end{document}\n";
  const { point } = planBodyInsert(doc, { lineNumber: 1, column: 1 });
  assert.equal(point.lineNumber, 5);
});

test("the full plan places the preamble edit at \\begin{document}", () => {
  const plan = planFigureInsert(DOC, { lineNumber: 1, column: 1 }, ["arrows.meta"], true);
  assert.equal(plan.movedIntoBody, true);
  assert.deepEqual(plan.body, { lineNumber: 7, column: 1 });
  assert.equal(plan.preamble.lineNumber, 4);
  assert.equal(
    plan.preamble.text,
    "\\usepackage{tikz}\n\\usetikzlibrary{arrows.meta}\n\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}\n"
  );
});

test("a fragment file gets no preamble edit", () => {
  const plan = planFigureInsert("\\draw (0,0);\n", { lineNumber: 1, column: 1 }, ["patterns"], true);
  assert.equal(plan.preamble, null);
});
