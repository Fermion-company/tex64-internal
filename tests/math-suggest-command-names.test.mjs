import test from "node:test";
import assert from "node:assert/strict";

import { buildRankedWordCandidates } from "../Resources/web/math/wysiwyg/math-wysiwyg-candidates.js";

// Regression suite distilled from the 2026-07 real-arXiv keystroke
// simulation (headless corpus run over math/physics/CS papers). Guards the
// two properties that audit found broken:
//   1. Typing a standard LaTeX command's full name must never yield zero
//      candidates ("suggestions vanish as you finish typing the name").
//   2. The top candidate for an exact command name must be that command
//      (or its curated semantic equivalent).

const topLatex = (token) => buildRankedWordCandidates(token)[0]?.candidate.key.latex ?? "";

test("exact command names put the command itself first", () => {
  const expectations = {
    sin: "\\sin",
    frac: "\\frac{#?}{#?}",
    mathrm: "\\mathrm{#?}",
    mathbf: "\\mathbf{#?}",
    mathcal: "\\mathcal{#?}",
    operatorname: "\\operatorname{#?}",
    cfrac: "\\cfrac{#?}{#?}",
    pmod: "\\pmod{#?}",
    prime: "\\prime",
    langle: "\\langle",
    rangle: "\\rangle",
    lfloor: "\\lfloor",
    rfloor: "\\rfloor",
    lceil: "\\lceil",
    rceil: "\\rceil",
    lvert: "\\lvert",
    rvert: "\\rvert",
    textrm: "\\textrm{#?}",
  };
  for (const [token, latex] of Object.entries(expectations)) {
    assert.equal(topLatex(token), latex, `top candidate for "${token}"`);
  }
});

test("amsmath dots variants map to renderable equivalents", () => {
  assert.equal(topLatex("dotsc"), "\\ldots");
  assert.equal(topLatex("dotsb"), "\\cdots");
});

test("environment names resolve to their templates", () => {
  assert.ok(topLatex("pmatrix").includes("\\begin{pmatrix}"));
  assert.ok(topLatex("bmatrix").includes("\\begin{bmatrix}"));
  assert.ok(topLatex("cases").includes("cases"));
});

test("standard command names never yield zero candidates", () => {
  const names = [
    "alpha", "beta", "gamma", "sum", "int", "sqrt", "binom", "partial",
    "nabla", "infty", "otimes", "oplus", "cdot", "times", "subseteq",
    "mathbb", "mathfrak", "mathsf", "mathtt", "mathit", "boldsymbol",
    "langle", "rangle", "lfloor", "rceil", "cfrac", "pmod", "prime",
    "operatorname", "mathrm", "mathbf", "mathcal", "textrm",
    "ket", "bra", "braket", "hat", "widehat", "bar", "tilde", "vec",
    "overline", "underline", "ldots", "cdots", "vdots", "ddots",
    "leftrightarrow", "Rightarrow", "hookrightarrow", "mapsto",
  ];
  for (const name of names) {
    assert.ok(
      buildRankedWordCandidates(name).length > 0,
      `expected candidates for full command name "${name}"`
    );
  }
});

test("shared prefixes keep the shorter core command first", () => {
  // "tex" must keep \text ahead of the longer \textrm sibling.
  assert.equal(topLatex("tex"), "\\text{#?}");
  // "dots" prefers \ldots (amsmath's default dots) over \cdots.
  assert.equal(topLatex("dots"), "\\ldots");
  // The original complaint from TODO.md: "sin" must beat "sinh".
  assert.equal(topLatex("sin"), "\\sin");
});
