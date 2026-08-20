import test from "node:test";
import assert from "node:assert/strict";
import { countMarkedLines, segmentBuildLog } from "../Resources/web/app/build-log-view.js";

// A transcript shaped like a real one: banners, then the few lines that matter.
const transcript = `This is LuaHBTeX, Version 1.24.0 (TeX Live 2026)
 restricted system commands enabled.
(./main.tex
LaTeX2e <2026-06-01>
(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls
Document Class: article 2025/01/22 v1.4n Standard LaTeX document class
(/usr/local/texlive/2026/texmf-dist/tex/latex/base/size10.clo))

LaTeX Warning: Reference \`sec:nowhere' on page 1 undefined on input line 3.

Overfull \\hbox (12.3pt too wide) in paragraph at lines 10--12
./main.tex:4: Undefined control sequence.
l.4 \\thiscommanddoesnotexist

./main.tex:31: Package luatex.def Error: File \`x.png' not found.
Output written on main.pdf (1 page).`;

const marked = (severity) =>
  segmentBuildLog(transcript).filter((segment) => segment.severity === severity);

test("the banners stay unmarked", () => {
  const plain = segmentBuildLog(transcript).filter((segment) => segment.severity === null);
  const plainText = plain.map((segment) => segment.text).join("\n");
  assert.match(plainText, /LuaHBTeX/);
  assert.match(plainText, /article\.cls/);
  assert.ok(!/Undefined control sequence/.test(plainText), "an error leaked into the plain run");
});

test("errors are marked, including the ones behind a file:line: prefix", () => {
  const errors = marked("error").map((segment) => segment.text);
  assert.ok(errors.some((line) => /Undefined control sequence/.test(line)));
  assert.ok(
    errors.some((line) => /Package luatex\.def Error/.test(line)),
    `the -file-line-error form was missed: ${JSON.stringify(errors)}`
  );
});

test("warnings are marked but never as errors", () => {
  const warnings = marked("warning").map((segment) => segment.text);
  assert.ok(warnings.some((line) => /Reference/.test(line)));
  assert.ok(warnings.some((line) => /Overfull/.test(line)));
  const errors = marked("error").map((segment) => segment.text);
  assert.ok(!errors.some((line) => /Overfull|LaTeX Warning/.test(line)));
});

test("TeX's l.NN line is marked as context, but only when it follows an error", () => {
  const context = marked("context").map((segment) => segment.text);
  assert.deepEqual(context, ["l.4 \\thiscommanddoesnotexist"]);

  const orphan = segmentBuildLog("l.4 \\somecommand\nnothing else here");
  assert.deepEqual(
    orphan.filter((segment) => segment.severity !== null),
    [],
    "an l.NN line with no error above it was marked anyway"
  );
});

test("an empty log produces nothing to mark", () => {
  assert.deepEqual(segmentBuildLog(""), []);
  assert.equal(countMarkedLines(segmentBuildLog("")), 0);
});

test("the marked count is what the summary promises", () => {
  assert.equal(countMarkedLines(segmentBuildLog(transcript)), marked("error").length + marked("warning").length + marked("context").length);
});
