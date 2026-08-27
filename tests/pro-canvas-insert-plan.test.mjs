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
  assert.equal(moved, "preamble");
  assert.deepEqual(point, { lineNumber: 7, column: 1 });
});

test("a cursor already in the body is left alone", () => {
  const { point, moved } = planBodyInsert(DOC, { lineNumber: 5, column: 7 });
  assert.equal(moved, null);
  assert.deepEqual(point, { lineNumber: 5, column: 7 });
});

test("a document without \\begin{document} keeps the cursor", () => {
  const { point, moved } = planBodyInsert("just a fragment\n", { lineNumber: 1, column: 3 });
  assert.equal(moved, null);
  assert.deepEqual(point, { lineNumber: 1, column: 3 });
});

const withBody = (...body) => ["\\documentclass{article}", "\\begin{document}", ...body, "\\end{document}"].join("\n");

test("a cursor inside an existing figure lands after it, not inside", () => {
  const doc = withBody("%% tex64-figure v2 h=deadbeef AAAA", "\\begin{tikzpicture}", "  \\draw (0,0) -- (1,1);", "\\end{tikzpicture}", "after");
  for (const line of [4, 5, 6]) { // \begin の次〜\end の行
    const { point, moved } = planBodyInsert(doc, { lineNumber: line, column: 3 });
    assert.equal(moved, "environment", `line ${line}`);
    assert.deepEqual(point, { lineNumber: 7, column: 1 }, `line ${line}`);
  }
});

test("the figure's metadata line is treated as part of the figure", () => {
  const doc = withBody("%% tex64-figure v2 h=deadbeef AAAA", "\\begin{tikzpicture}", "\\end{tikzpicture}");
  const { point, moved } = planBodyInsert(doc, { lineNumber: 3, column: 1 });
  assert.equal(moved, "environment");
  assert.deepEqual(point, { lineNumber: 6, column: 1 });
});

test("column 1 of an environment's first line still counts as outside it", () => {
  const doc = withBody("\\begin{tikzpicture}", "\\end{tikzpicture}");
  assert.equal(planBodyInsert(doc, { lineNumber: 3, column: 1 }).moved, null);
  assert.equal(planBodyInsert(doc, { lineNumber: 3, column: 8 }).moved, "environment");
});

test("math and verbatim environments push the figure past their end", () => {
  const doc = withBody("\\begin{align}", "  a &= b \\\\", "  c &= d", "\\end{align}", "text");
  const { point, moved } = planBodyInsert(doc, { lineNumber: 5, column: 4 });
  assert.equal(moved, "environment");
  assert.deepEqual(point, { lineNumber: 7, column: 1 });
});

test("a nested environment escapes to the outermost one that cannot hold a figure", () => {
  const doc = withBody("\\begin{tikzpicture}", "\\begin{scope}", "  \\draw (0,0);", "\\end{scope}", "\\end{tikzpicture}", "x");
  const { point } = planBodyInsert(doc, { lineNumber: 5, column: 3 });
  assert.deepEqual(point, { lineNumber: 8, column: 1 });
});

test("environments that can hold a figure are left alone", () => {
  const doc = withBody("\\begin{itemize}", "  \\item one", "\\end{itemize}");
  assert.equal(planBodyInsert(doc, { lineNumber: 4, column: 12 }).moved, null);
});

test("a commented-out \\begin{tikzpicture} does not trap the cursor", () => {
  const doc = withBody("% \\begin{tikzpicture}", "text");
  assert.equal(planBodyInsert(doc, { lineNumber: 4, column: 3 }).moved, null);
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

test("relative figure width adds graphicx only when missing", () => {
  assert.ok(missingPreambleLines(DOC,[],false,true).includes("\\usepackage{graphicx}"));
  const present=DOC.replace("\\usepackage{amsmath}","\\usepackage{amsmath,graphicx}");
  assert.doesNotMatch(missingPreambleLines(present,[],false,true).join("\n"),/graphicx/);
});

test("the closing brace of a resizebox is part of the existing figure", () => {
  const doc=withBody("%% tex64-figure v2 h=deadbeef AAAA","\\resizebox{.8\\linewidth}{!}{%","\\begin{tikzpicture}","\\end{tikzpicture}","}","after");
  const {point,moved}=planBodyInsert(doc,{lineNumber:3,column:1});
  assert.equal(moved,"environment");
  assert.deepEqual(point,{lineNumber:8,column:1});
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
  assert.equal(plan.moved, "preamble");
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
