import assert from "node:assert/strict";
import test from "node:test";
import { extractPreamble, scanTikzsetStyles } from "../Resources/web/app/pro-canvas/project-context.js";

test("extractPreamble returns the verbatim text between documentclass and document", () => {
  assert.equal(extractPreamble("\\documentclass{article}\n% keep this\n\\usepackage{tikz}\n\\begin{document}\nHi"), "% keep this\n\\usepackage{tikz}\n");
  assert.equal(extractPreamble("\\documentclass[a4paper, 11pt]{article}\n\\newcommand{\\x}{y}\n\\begin{document}"), "\\newcommand{\\x}{y}\n");
});

test("extractPreamble requires documentclass and begin document", () => {
  assert.equal(extractPreamble("\\begin{document}"), null);
  assert.equal(extractPreamble("\\documentclass{article}\ntext"), null);
});

test("scanTikzsetStyles finds exact style definitions and deduplicates", () => {
  const source = String.raw`
\tikzset{
  primary/.style={draw=blue, decorate={one,{two}}},
  spaced name/.style = {
    line width=1pt
  },
  ignored/.style n args={2}{draw=#1},
  also ignored/.style args={#1}{draw=#1},
  coded/.code={x},
  primary/.append style={thick}
}
bare-name/.style={fill=red}
primary/.style={draw=black}
`;
  assert.deepEqual(scanTikzsetStyles(source), ["primary", "spaced name", "bare-name"]);
});

test("scanTikzsetStyles rejects invalid names", () => {
  assert.deepEqual(scanTikzsetStyles("1bad/.style={x}\ngood_name/.style={y}"), ["good_name"]);
});
