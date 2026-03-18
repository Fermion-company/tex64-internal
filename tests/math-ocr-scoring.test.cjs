const assert = require("node:assert/strict");
const test = require("node:test");

const {
  looksLikeGarbage,
  isLikelyInvalidLatex,
  scoreLatexCandidate,
  isSimpleFormula,
} = require("../electron/services/math-ocr/scoring.cjs");

// --- looksLikeGarbage ---

test("looksLikeGarbage: empty is garbage", () => {
  assert.equal(looksLikeGarbage(""), true);
  assert.equal(looksLikeGarbage(null), true);
});

test("looksLikeGarbage: over 300 chars is garbage", () => {
  assert.equal(looksLikeGarbage("x".repeat(301)), true);
});

test("looksLikeGarbage: too many \\pi is garbage", () => {
  assert.equal(looksLikeGarbage("\\pi".repeat(9)), true);
});

test("looksLikeGarbage: no alphanumeric is garbage", () => {
  assert.equal(looksLikeGarbage("+++==="), true);
});

test("looksLikeGarbage: \\begin{array} is NOT garbage anymore", () => {
  assert.equal(
    looksLikeGarbage("\\begin{array}{cc}1&2\\\\3&4\\end{array}"),
    false
  );
});

test("looksLikeGarbage: normal math is not garbage", () => {
  assert.equal(looksLikeGarbage("x^{2}+3x+2=0"), false);
});

// --- scoreLatexCandidate ---

test("scoreLatexCandidate: simple formula scores well", () => {
  const score = scoreLatexCandidate("x^{2}+3x+2=0");
  assert.ok(score >= 90, `expected >= 90, got ${score}`);
});

test("scoreLatexCandidate: \\frac bonus", () => {
  const score = scoreLatexCandidate("\\frac{x}{y}");
  assert.ok(score > 100, `expected > 100, got ${score}`);
});

test("scoreLatexCandidate: \\begin{array} has mild penalty", () => {
  const score = scoreLatexCandidate("\\begin{array}{cc}1&2\\\\3&4\\end{array}");
  // Should still be positive (base 100 - 10 + 0 = 90)
  assert.ok(score >= 80, `expected >= 80, got ${score}`);
});

test("scoreLatexCandidate: unbalanced braces penalized", () => {
  const balanced = scoreLatexCandidate("\\frac{x}{y}");
  const unbalanced = scoreLatexCandidate("\\frac{x}{y}}");
  assert.ok(balanced > unbalanced, `balanced ${balanced} should be > unbalanced ${unbalanced}`);
});

test("scoreLatexCandidate: <unk> tokens penalized", () => {
  const score = scoreLatexCandidate("x + <unk> = 0");
  assert.ok(score < 50, `expected < 50, got ${score}`);
});

test("scoreLatexCandidate: empty returns -1000", () => {
  assert.equal(scoreLatexCandidate(""), -1000);
});

// --- isLikelyInvalidLatex ---

test("isLikelyInvalidLatex: valid LaTeX", () => {
  assert.equal(isLikelyInvalidLatex("x^{2}+y^{2}=r^{2}"), false);
});

test("isLikelyInvalidLatex: unbalanced braces", () => {
  assert.equal(isLikelyInvalidLatex("\\frac{x}{y}}"), true);
});

test("isLikelyInvalidLatex: mismatched \\left/\\right", () => {
  assert.equal(isLikelyInvalidLatex("\\left(x+y"), true);
});

test("isLikelyInvalidLatex: empty frac", () => {
  assert.equal(isLikelyInvalidLatex("\\frac{x}{}"), true);
});

test("isLikelyInvalidLatex: \\begin{array} is NOT invalid anymore", () => {
  assert.equal(
    isLikelyInvalidLatex("\\begin{array}{cc}1&2\\\\3&4\\end{array}"),
    false
  );
});

// --- isSimpleFormula ---

test("isSimpleFormula: simple expressions", () => {
  assert.equal(isSimpleFormula("x^2+y=0"), true);
  assert.equal(isSimpleFormula("a+b=c"), true);
});

test("isSimpleFormula: too long", () => {
  assert.equal(isSimpleFormula("x".repeat(25)), false);
});

test("isSimpleFormula: contains backslash", () => {
  assert.equal(isSimpleFormula("\\frac{1}{2}"), false);
});
