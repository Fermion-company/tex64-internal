const assert = require("node:assert/strict");
const test = require("node:test");

const {
  stripNonMathText,
  stripEdgeTextBlocks,
  stripBareTextFromSegments,
  MATH_FUNCTION_NAMES,
} = require("../electron/services/math-ocr/strip-text.cjs");

// --- stripEdgeTextBlocks ---

test("stripEdgeTextBlocks: removes leading \\text{...}", () => {
  assert.equal(
    stripEdgeTextBlocks("\\text{Solve} x^{2}+3x+2=0"),
    "x^{2}+3x+2=0"
  );
});

test("stripEdgeTextBlocks: removes trailing \\text{...}", () => {
  assert.equal(
    stripEdgeTextBlocks("x=5 \\text{を求めよ}"),
    "x=5"
  );
});

test("stripEdgeTextBlocks: removes both leading and trailing", () => {
  assert.equal(
    stripEdgeTextBlocks("\\text{問題} x^{2}=4 \\text{を解け}"),
    "x^{2}=4"
  );
});

test("stripEdgeTextBlocks: preserves interior \\text{...}", () => {
  const input = "x^{2} \\text{if} x>0";
  assert.equal(stripEdgeTextBlocks(input), input);
});

test("stripEdgeTextBlocks: preserves \\text inside \\frac", () => {
  const input = "\\frac{\\text{面積}}{\\text{時間}}";
  assert.equal(stripEdgeTextBlocks(input), input);
});

test("stripEdgeTextBlocks: removes leading \\mbox{...}", () => {
  assert.equal(
    stripEdgeTextBlocks("\\mbox{Given that} y=3"),
    "y=3"
  );
});

test("stripEdgeTextBlocks: removes multiple leading text blocks", () => {
  assert.equal(
    stripEdgeTextBlocks("\\text{Step 1:} \\text{Find} x+y=5"),
    "x+y=5"
  );
});

test("stripEdgeTextBlocks: handles empty input", () => {
  assert.equal(stripEdgeTextBlocks(""), "");
});

test("stripEdgeTextBlocks: handles text-only input", () => {
  assert.equal(stripEdgeTextBlocks("\\text{hello}"), "");
});

// --- stripBareTextFromSegments ---

test("stripBareTextFromSegments: removes English words 3+ letters", () => {
  assert.equal(
    stripBareTextFromSegments("Solve x + 3 = 0"),
    " x + 3 = 0"
  );
});

test("stripBareTextFromSegments: keeps single letters (variables)", () => {
  assert.equal(
    stripBareTextFromSegments("x y z"),
    "x y z"
  );
});

test("stripBareTextFromSegments: keeps two-letter combinations", () => {
  assert.equal(
    stripBareTextFromSegments("dx dy"),
    "dx dy"
  );
});

test("stripBareTextFromSegments: converts known function names", () => {
  assert.equal(
    stripBareTextFromSegments("sin x + cos y"),
    "\\sin x + \\cos y"
  );
});

test("stripBareTextFromSegments: keeps LaTeX commands", () => {
  assert.equal(
    stripBareTextFromSegments("\\frac{1}{2}"),
    "\\frac{1}{2}"
  );
});

test("stripBareTextFromSegments: keeps digits and operators", () => {
  assert.equal(
    stripBareTextFromSegments("3 + 4 = 7"),
    "3 + 4 = 7"
  );
});

test("stripBareTextFromSegments: strips mixed word prefix from math", () => {
  assert.equal(
    stripBareTextFromSegments("Solvex^{2}"),
    "x^{2}"
  );
});

test("stripBareTextFromSegments: removes multiple English words", () => {
  const result = stripBareTextFromSegments("Find the value x = 5");
  assert.ok(!result.includes("Find"));
  assert.ok(!result.includes("the"));
  assert.ok(!result.includes("value"));
  assert.ok(result.includes("x"));
  assert.ok(result.includes("5"));
});

// --- stripNonMathText (full pipeline) ---

test("stripNonMathText: full pipeline - text + math", () => {
  const result = stripNonMathText("\\text{Solve:} x^{2} + 3 x + 2 = 0");
  assert.ok(!result.includes("Solve"));
  assert.ok(result.includes("x^{2}"));
  assert.ok(result.includes("= 0"));
});

test("stripNonMathText: preserves interior \\text in cases env", () => {
  const input = "\\begin{cases} x & \\text{if} x>0 \\\\ 0 & \\text{otherwise} \\end{cases}";
  const result = stripNonMathText(input);
  assert.ok(result.includes("\\text{if}"));
  assert.ok(result.includes("\\text{otherwise}"));
});

test("stripNonMathText: preserves \\text inside \\frac", () => {
  const input = "\\frac{\\text{面積}}{\\text{長さ}}";
  const result = stripNonMathText(input);
  assert.equal(result, input);
});

test("stripNonMathText: pure math passes through unchanged", () => {
  const input = "\\frac{x^{2}+1}{x-1}";
  assert.equal(stripNonMathText(input), input);
});

test("stripNonMathText: empty input returns empty", () => {
  assert.equal(stripNonMathText(""), "");
  assert.equal(stripNonMathText(null), "");
  assert.equal(stripNonMathText(undefined), "");
});

test("stripNonMathText: text-only returns original (safety)", () => {
  // All content stripped → returns original as safety
  const input = "\\text{Hello World}";
  const result = stripNonMathText(input);
  // Edge text stripping removes leading+trailing \text, leaving ""
  // Safety fallback returns original
  assert.equal(result, input);
});

test("stripNonMathText: Japanese text with formula", () => {
  const result = stripNonMathText("\\text{次の式を解け} x^{2} - 4 = 0");
  assert.ok(!result.includes("次の式を解け"));
  assert.ok(result.includes("x^{2}"));
});

test("stripNonMathText: subscript with text preserved", () => {
  const input = "x_{\\text{total}} + y_{\\text{max}}";
  const result = stripNonMathText(input);
  assert.ok(result.includes("\\text{total}"));
  assert.ok(result.includes("\\text{max}"));
});

test("stripNonMathText: known math function conversion", () => {
  const result = stripNonMathText("sin x + cos y");
  assert.ok(result.includes("\\sin"));
  assert.ok(result.includes("\\cos"));
});
