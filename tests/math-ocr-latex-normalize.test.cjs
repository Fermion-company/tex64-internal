const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeDecodedLatex,
  normalizeFallbackText,
} = require("../electron/services/math-ocr/latex-normalize.cjs");

// --- normalizeDecodedLatex ---

test("normalizeDecodedLatex: simple expression passthrough", () => {
  assert.equal(normalizeDecodedLatex("x^{2}+3x+2=0"), "x^{2}+3x+2=0");
});

test("normalizeDecodedLatex: empty returns empty", () => {
  assert.equal(normalizeDecodedLatex(""), "");
  assert.equal(normalizeDecodedLatex(null), "");
});

test("normalizeDecodedLatex: strips spacing commands", () => {
  const result = normalizeDecodedLatex("x \\, + \\; y");
  assert.ok(!result.includes("\\,"), `unexpected \\, in ${result}`);
  assert.ok(!result.includes("\\;"), `unexpected \\; in ${result}`);
});

test("normalizeDecodedLatex: unwraps boxed expression", () => {
  assert.equal(normalizeDecodedLatex("\\boxed{x^{2}+1}"), "x^{2}+1");
});

test("normalizeDecodedLatex: unwraps fbox expression", () => {
  assert.equal(normalizeDecodedLatex("\\fbox{a+b}"), "a+b");
});

test("normalizeDecodedLatex: normalizes operator names", () => {
  const result = normalizeDecodedLatex("\\operatorname{sin}(x)");
  assert.equal(result, "\\sin(x)");
});

test("normalizeDecodedLatex: normalizes geq/leq/neq", () => {
  const result = normalizeDecodedLatex("x \\geq 0");
  assert.ok(result.includes("\\ge"), `expected \\ge in ${result}`);
});

test("normalizeDecodedLatex: postProcessLatex removes extra spaces", () => {
  const result = normalizeDecodedLatex("x ^ { 2 } + 3");
  assert.equal(result, "x^{2}+3");
});

test("normalizeDecodedLatex: repairs broken fraction parentheses", () => {
  // Repair produces \left(\frac{a}{b}\right), then outer delimiters stripped
  const result = normalizeDecodedLatex("\\frac{(a}{b)}");
  assert.equal(result, "\\frac{a}{b}");
});

test("normalizeDecodedLatex: strips redundant outer round delimiters", () => {
  const result = normalizeDecodedLatex("\\left(x+y\\right)");
  assert.equal(result, "x+y");
});

test("normalizeDecodedLatex: strips redundant outer square delimiters", () => {
  const result = normalizeDecodedLatex("\\left[x+y\\right]");
  assert.equal(result, "x+y");
});

test("normalizeDecodedLatex: keeps outer parens around matrix", () => {
  const input = "\\left(\\begin{matrix}a\\\\b\\end{matrix}\\right)";
  const result = normalizeDecodedLatex(input);
  assert.ok(result.includes("pmatrix") || result.includes("binom"), `unexpected: ${result}`);
});

test("normalizeDecodedLatex: collapses empty fractions", () => {
  assert.equal(normalizeDecodedLatex("\\frac{x}{}"), "x");
  assert.equal(normalizeDecodedLatex("\\frac{}{y}"), "y");
});

test("normalizeDecodedLatex: normalizes varlimsup to lim", () => {
  const result = normalizeDecodedLatex("\\varlimsup_{x\\to0}f(x)");
  assert.ok(result.includes("\\lim"), `expected \\lim in ${result}`);
});

test("normalizeDecodedLatex: normalizes compact binom (no space)", () => {
  // postProcessLatex preserves letter-space-letter, so test without space
  const result = normalizeDecodedLatex("\\binom{n}{k}");
  assert.equal(result, "\\binom{n}{k}");
});

test("normalizeDecodedLatex: normalizes compact binom shorthand", () => {
  // Shorthand like \binomnk (no spaces, no braces)
  const result = normalizeDecodedLatex("\\binomnk");
  assert.equal(result, "\\binom{n}{k}");
});

test("normalizeDecodedLatex: strips array formatting commands", () => {
  const result = normalizeDecodedLatex("\\arraycolsep=5pt x^{2}");
  assert.ok(!result.includes("arraycolsep"), `unexpected arraycolsep in ${result}`);
});

test("normalizeDecodedLatex: matrix body to binom conversion", () => {
  const input = "\\left(\\begin{matrix}n\\\\k\\end{matrix}\\right)";
  const result = normalizeDecodedLatex(input);
  assert.ok(result.includes("\\binom"), `expected \\binom in ${result}`);
});

test("normalizeDecodedLatex: fixes matrix separators", () => {
  const input = "\\begin{matrix}{1}{2}{3}{4}\\end{matrix}";
  const result = normalizeDecodedLatex(input);
  assert.ok(result.includes("&") || result.includes("\\\\"), `expected matrix structure in ${result}`);
});

// --- normalizeFallbackText ---

test("normalizeFallbackText: empty returns empty", () => {
  assert.equal(normalizeFallbackText(""), "");
  assert.equal(normalizeFallbackText(null), "");
});

test("normalizeFallbackText: strips non-math chars", () => {
  const result = normalizeFallbackText("x² + y = 0");
  assert.ok(!result.includes("²"), `should strip non-ASCII: ${result}`);
});

test("normalizeFallbackText: auto-adds superscript for trailing digit", () => {
  assert.equal(normalizeFallbackText("x2"), "x^2");
  assert.equal(normalizeFallbackText("x12"), "x^{12}");
});

test("normalizeFallbackText: preserves existing superscript", () => {
  const result = normalizeFallbackText("x^2+y");
  assert.ok(result.includes("^"), `should keep ^: ${result}`);
});

test("normalizeFallbackText: strips whitespace", () => {
  const result = normalizeFallbackText("x + y = 0");
  assert.ok(!result.includes(" "), `should strip spaces: ${result}`);
  assert.equal(result, "x+y=0");
});
