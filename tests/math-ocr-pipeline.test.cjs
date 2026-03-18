const assert = require("node:assert/strict");
const test = require("node:test");

// Integration / E2E tests: simulate the full pipeline from decoder output
// to final user-facing LaTeX, exercising strip-text → normalizeDecodedLatex
// → scoring → main-math-capture normalization.

const { stripNonMathText } = require("../electron/services/math-ocr/strip-text.cjs");
const { normalizeDecodedLatex, normalizeFallbackText } = require("../electron/services/math-ocr/latex-normalize.cjs");
const {
  scoreLatexCandidate,
  isLikelyInvalidLatex,
  looksLikeGarbage,
  isSimpleFormula,
  scoreFallbackCandidate,
  normalizeFallbackImageCandidates,
  decodeImageDataUrl,
} = require("../electron/services/math-ocr/scoring.cjs");
const { decodeTokens, buildIdToToken } = require("../electron/services/math-ocr/tokenizer.cjs");
const { buildDecodeCandidates, clamp, softmax, createRng, sampleFromProbs } = require("../electron/services/math-ocr/sampling.cjs");

// Helper: simulate the service.cjs decode pipeline
const simulateDecodePipeline = (rawDecoded) => {
  const stripped = stripNonMathText(rawDecoded);
  return normalizeDecodedLatex(stripped);
};

// --- Full Pipeline: decoder output → final LaTeX ---

test("pipeline: clean quadratic formula passes through", () => {
  const raw = "x = \\frac { - b \\pm \\sqrt { b ^ { 2 } - 4 a c } } { 2 a }";
  const result = simulateDecodePipeline(raw);
  assert.ok(result.includes("\\frac"), `should contain \\frac: ${result}`);
  assert.ok(result.includes("\\sqrt"), `should contain \\sqrt: ${result}`);
  assert.ok(!isLikelyInvalidLatex(result), `should be valid LaTeX: ${result}`);
  assert.ok(scoreLatexCandidate(result) >= 90, `score should be >= 90: ${scoreLatexCandidate(result)}`);
});

test("pipeline: text-prefixed formula strips text", () => {
  const raw = "Solve the following equation x ^ { 2 } + 3 x + 2 = 0";
  const result = simulateDecodePipeline(raw);
  assert.ok(!result.includes("Solve"), `should not contain 'Solve': ${result}`);
  assert.ok(!result.includes("following"), `should not contain 'following': ${result}`);
  assert.ok(!result.includes("equation"), `should not contain 'equation': ${result}`);
  assert.ok(result.includes("x"), `should contain variable x: ${result}`);
});

test("pipeline: \\text{} at edges stripped, interior preserved", () => {
  const raw = "\\text{Solve:} \\frac{\\text{area}}{\\text{time}} \\text{units}";
  const result = simulateDecodePipeline(raw);
  assert.ok(!result.startsWith("\\text{Solve"), `leading \\text should be removed: ${result}`);
  assert.ok(result.includes("\\text{area}"), `interior \\text{area} should be preserved: ${result}`);
  assert.ok(result.includes("\\text{time}"), `interior \\text{time} should be preserved: ${result}`);
});

test("pipeline: cases environment with \\text{if} preserved", () => {
  const raw = "\\begin{cases} x & \\text{if } x > 0 \\\\ -x & \\text{if } x \\le 0 \\end{cases}";
  const result = simulateDecodePipeline(raw);
  assert.ok(result.includes("\\text{if"), `should preserve \\text{if}: ${result}`);
  assert.ok(result.includes("cases"), `should preserve cases: ${result}`);
});

test("pipeline: frac with text labels preserved", () => {
  const raw = "\\frac { \\text{距離} } { \\text{時間} }";
  const result = simulateDecodePipeline(raw);
  assert.ok(result.includes("\\frac"), `should contain \\frac: ${result}`);
  assert.ok(result.includes("\\text{距離}"), `should keep Japanese text inside frac: ${result}`);
});

test("pipeline: trig function names converted", () => {
  const raw = "sin x + cos y = tan z";
  const result = simulateDecodePipeline(raw);
  assert.ok(result.includes("\\sin"), `should convert sin → \\sin: ${result}`);
  assert.ok(result.includes("\\cos"), `should convert cos → \\cos: ${result}`);
  assert.ok(result.includes("\\tan"), `should convert tan → \\tan: ${result}`);
});

test("pipeline: \\operatorname normalized to standard commands", () => {
  const raw = "\\operatorname{sin}(x) + \\operatorname{log}(y)";
  const result = simulateDecodePipeline(raw);
  assert.equal(result, "\\sin(x)+\\log(y)");
});

test("pipeline: boxed unwrapped + text stripped", () => {
  const raw = "\\text{Answer:} \\boxed{x^{2}+1}";
  const result = simulateDecodePipeline(raw);
  assert.ok(!result.includes("\\boxed"), `should unwrap boxed: ${result}`);
  assert.ok(!result.includes("Answer"), `should strip text: ${result}`);
  assert.ok(result.includes("x^{2}+1"), `should keep formula: ${result}`);
});

test("pipeline: matrix with text context", () => {
  const raw = "the matrix is \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}";
  const result = simulateDecodePipeline(raw);
  // "the" (3+ letters) stripped, "matrix" kept (LaTeX command name), "is" kept (2 letters)
  assert.ok(!result.includes("the "), `should strip 'the': ${result}`);
  assert.ok(result.includes("pmatrix"), `should keep pmatrix: ${result}`);
});

test("pipeline: garbage detection on text-only output", () => {
  const raw = "This is just text without any math at all";
  const stripped = stripNonMathText(raw);
  // After stripping 3+ letter words, only 2-letter "is" and "at" remain
  // These are short residuals, not real math
  assert.ok(!stripped.includes("This"), `should strip 'This': ${stripped}`);
  assert.ok(!stripped.includes("just"), `should strip 'just': ${stripped}`);
  assert.ok(!stripped.includes("text"), `should strip 'text': ${stripped}`);
  assert.ok(!stripped.includes("without"), `should strip 'without': ${stripped}`);
  assert.ok(!stripped.includes("math"), `should strip 'math': ${stripped}`);
});

test("pipeline: repeated \\pi detection", () => {
  const garbage = "\\pi".repeat(9);
  assert.ok(looksLikeGarbage(garbage), "9+ \\pi should be garbage");
});

// --- Scoring integration ---

test("scoring: valid formula scores high, invalid scores lower", () => {
  const valid = "\\frac{x^{2}+1}{x-1}";
  const invalid = "\\frac{x^{2}+1}{x-1}}";
  assert.ok(scoreLatexCandidate(valid) > scoreLatexCandidate(invalid));
  assert.equal(isLikelyInvalidLatex(valid), false);
  assert.equal(isLikelyInvalidLatex(invalid), true);
});

test("scoring: \\begin{array} is valid and scores reasonably", () => {
  const latex = "\\begin{array}{cc}1&2\\\\3&4\\end{array}";
  assert.equal(looksLikeGarbage(latex), false);
  assert.equal(isLikelyInvalidLatex(latex), false);
  assert.ok(scoreLatexCandidate(latex) >= 80, `should score >= 80: ${scoreLatexCandidate(latex)}`);
});

test("scoring: mismatched environments detected", () => {
  const latex = "\\begin{array}{c}1\\\\2\\end{matrix}";
  assert.equal(isLikelyInvalidLatex(latex), true);
});

test("scoring: mismatched \\left/\\right detected", () => {
  assert.equal(isLikelyInvalidLatex("\\left(x+y\\right)"), false);
  assert.equal(isLikelyInvalidLatex("\\left(x+y"), true);
  assert.equal(isLikelyInvalidLatex("\\left(x+y\\right)\\right)"), true);
});

// --- Fallback scoring integration ---

test("scoreFallbackCandidate: simple formula with high confidence scores well", () => {
  const score = scoreFallbackCandidate("x^2+y=0", 92);
  assert.ok(score > 60, `should score well: ${score}`);
});

test("scoreFallbackCandidate: low confidence scores low", () => {
  const high = scoreFallbackCandidate("x+y=0", 95);
  const low = scoreFallbackCandidate("x+y=0", 30);
  assert.ok(high > low, `high confidence ${high} should be > low confidence ${low}`);
});

test("scoreFallbackCandidate: long text penalized", () => {
  const short = scoreFallbackCandidate("x+y=0", 80);
  const long = scoreFallbackCandidate("x".repeat(30), 80);
  assert.ok(short > long, `short ${short} should be > long ${long}`);
});

// --- normalizeFallbackImageCandidates ---

test("normalizeFallbackImageCandidates: deduplicates", () => {
  const url = "data:image/png;base64," + "A".repeat(100);
  const result = normalizeFallbackImageCandidates(url, [url, url]);
  assert.equal(result.length, 1);
});

test("normalizeFallbackImageCandidates: filters non-data-url", () => {
  const result = normalizeFallbackImageCandidates("not-a-data-url", []);
  assert.equal(result.length, 0);
});

test("normalizeFallbackImageCandidates: respects max", () => {
  const urls = Array.from({ length: 10 }, (_, i) =>
    `data:image/png;base64,${"A".repeat(100)}${i}`
  );
  const result = normalizeFallbackImageCandidates(urls[0], urls.slice(1));
  assert.ok(result.length <= 3, `should be at most 3, got ${result.length}`);
});

// --- decodeImageDataUrl ---

test("decodeImageDataUrl: valid data URL returns Buffer", () => {
  const data = "data:image/png;base64,iVBOR";
  const result = decodeImageDataUrl(data);
  assert.ok(Buffer.isBuffer(result), "should return a Buffer");
});

test("decodeImageDataUrl: invalid returns null", () => {
  assert.equal(decodeImageDataUrl("not-a-data-url"), null);
  assert.equal(decodeImageDataUrl(null), null);
  assert.equal(decodeImageDataUrl(123), null);
});

// --- isSimpleFormula boundary ---

test("isSimpleFormula: boundary at 24 chars", () => {
  assert.equal(isSimpleFormula("x".repeat(24)), true);
  assert.equal(isSimpleFormula("x".repeat(25)), false);
});

test("isSimpleFormula: rejects backslash", () => {
  assert.equal(isSimpleFormula("\\frac{1}{2}"), false);
});

test("isSimpleFormula: accepts operators", () => {
  assert.equal(isSimpleFormula("a+b-c*d/e=f"), true);
});

// --- buildDecodeCandidates with different strategies ---

test("buildDecodeCandidates: top_p strategy", () => {
  const config = { decodeStrategy: "top_p", filterThres: 0.9, temperature: 1.0 };
  const candidates = buildDecodeCandidates(config);
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0].strategy, "top_p");
});

test("buildDecodeCandidates: candidates have all required fields", () => {
  const config = { decodeStrategy: "greedy", filterThres: 0.9, temperature: 1.0 };
  const candidates = buildDecodeCandidates(config);
  for (const c of candidates) {
    assert.ok(typeof c.strategy === "string", "strategy should be string");
    assert.ok(Number.isFinite(c.filterThres), "filterThres should be finite");
    assert.ok(Number.isFinite(c.temperature), "temperature should be finite");
    assert.ok(Number.isFinite(c.seedOffset), "seedOffset should be finite");
  }
});

// --- Scoring bonuses for equation structure ---

test("scoring: equation with = gets bonus", () => {
  const withEq = scoreLatexCandidate("x^{2}+3x+2=0");
  const noEq = scoreLatexCandidate("x^{2}+3x+2");
  assert.ok(withEq > noEq, `with = (${withEq}) should be > without (${noEq})`);
});

test("scoring: consecutive operators penalized", () => {
  const clean = scoreLatexCandidate("x+y=z");
  const degenerate = scoreLatexCandidate("x+++y===z");
  assert.ok(clean > degenerate, `clean (${clean}) should be > degenerate (${degenerate})`);
});

test("scoring: high backslash ratio penalized", () => {
  const normal = scoreLatexCandidate("\\frac{x}{y}");
  const garbled = scoreLatexCandidate("\\a\\b\\c\\d\\e");
  assert.ok(normal > garbled, `normal (${normal}) should be > garbled (${garbled})`);
});

// --- Dangling punctuation cleanup ---

test("pipeline: strips leading colon after text removal", () => {
  const raw = "Solve : x^{2} = 0";
  const result = simulateDecodePipeline(raw);
  assert.ok(!result.startsWith(":"), `should not start with colon: ${result}`);
  assert.ok(result.includes("x"), `should contain x: ${result}`);
});

test("pipeline: strips trailing period", () => {
  const raw = "x^{2} + y = 0 .";
  const result = simulateDecodePipeline(raw);
  assert.ok(!result.endsWith("."), `should not end with period: ${result}`);
});

// --- End-to-end token decode + strip + normalize ---

test("E2E: token decode → strip → normalize", () => {
  const tokenizer = {
    model: {
      vocab: {
        "Ġ\\": 0, "frac": 1, "{": 2, "x": 3, "}": 4,
        "Ġ+": 5, "Ġ1": 6, "<s>": 7, "</s>": 8,
      },
    },
  };
  const idToToken = buildIdToToken(tokenizer);
  const tokens = [7, 0, 1, 2, 3, 4, 2, 3, 5, 6, 4, 8];
  const decoded = decodeTokens(tokens, idToToken);
  const stripped = stripNonMathText(decoded);
  const normalized = normalizeDecodedLatex(stripped);
  assert.ok(normalized.includes("\\frac"), `should contain \\frac: ${normalized}`);
});

// --- Edge cases ---

test("pipeline: empty string through all stages", () => {
  assert.equal(simulateDecodePipeline(""), "");
});

test("pipeline: only whitespace", () => {
  assert.equal(simulateDecodePipeline("   "), "");
});

test("pipeline: preserves subscript text", () => {
  const raw = "x_{\\text{total}} + y_{\\text{max}}";
  const result = simulateDecodePipeline(raw);
  assert.ok(result.includes("\\text{total}"), `should keep \\text{total}: ${result}`);
  assert.ok(result.includes("\\text{max}"), `should keep \\text{max}: ${result}`);
});
