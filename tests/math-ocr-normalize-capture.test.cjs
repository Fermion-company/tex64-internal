/**
 * Unit test for the normalizeMathCaptureText logic in main-math-capture.ts.
 *
 * The function is not exported, so we duplicate the critical whitespace-
 * normalization logic here for testing.
 *
 * Run:  node --test tests/math-ocr-normalize-capture.test.cjs
 */

const assert = require("node:assert/strict");
const test = require("node:test");

// ---------- Duplicated normalization helpers (from main-math-capture.ts) ----------

const stripMathCaptureWrapper = (value) => {
  const trimmed = value.trim();
  const wrappers = [
    ["$$", "$$"],
    ["$", "$"],
    ["\\(", "\\)"],
    ["\\[", "\\]"],
  ];
  for (const [start, end] of wrappers) {
    if (trimmed.startsWith(start) && trimmed.endsWith(end)) {
      const inner = trimmed.slice(start.length, -end.length).trim();
      if (inner) return inner;
    }
  }
  return trimmed;
};

const TEXT_PLACEHOLDER_PREFIX = "\x00TXTBLK";

const protectTextBlocks = (value) => {
  const blocks = [];
  const textCmdPattern = /\\(?:text|mbox|textnormal|textrm|textsf|texttt|textbf|textit)\s*\{/g;
  let result = "";
  let lastIndex = 0;
  let match;
  while ((match = textCmdPattern.exec(value)) !== null) {
    result += value.slice(lastIndex, match.index);
    const braceStart = match.index + match[0].length - 1;
    let depth = 0;
    let braceEnd = -1;
    for (let i = braceStart; i < value.length; i += 1) {
      if (value[i] === "{") depth += 1;
      if (value[i] === "}") {
        depth -= 1;
        if (depth === 0) { braceEnd = i; break; }
      }
    }
    if (braceEnd >= 0) {
      const fullBlock = value.slice(match.index, braceEnd + 1);
      blocks.push(fullBlock);
      result += `${TEXT_PLACEHOLDER_PREFIX}${blocks.length - 1}\x00`;
      lastIndex = braceEnd + 1;
      textCmdPattern.lastIndex = lastIndex;
    } else {
      result += value[match.index];
      lastIndex = match.index + 1;
      textCmdPattern.lastIndex = lastIndex;
    }
  }
  result += value.slice(lastIndex);
  return { result, blocks };
};

const restoreTextBlocks = (value, blocks) =>
  value.replace(
    new RegExp(`${TEXT_PLACEHOLDER_PREFIX.replace(/\x00/g, "\\x00")}(\\d+)\\x00`, "g"),
    (_match, idx) => blocks[parseInt(idx, 10)] ?? ""
  );

const normalizeMathCaptureText = (value) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const unwrapped = stripMathCaptureWrapper(trimmed);

  // Preserve LaTeX command boundaries when stripping whitespace.
  const noWhitespace = unwrapped
    .replace(/(\\[A-Za-z]+)\s+(?=[A-Za-z])/g, "$1{}")
    .replace(/\s+/g, "");

  const { result: withPlaceholders, blocks } = protectTextBlocks(noWhitespace);
  let cleaned = withPlaceholders;
  cleaned = cleaned.replace(/\\newline/g, "").replace(/\\\\/g, "");
  cleaned = cleaned.replace(/[^A-Za-z0-9\\{}_^=+\-*/().,\[\]|<>!:\x00TXTBLK]/g, "");
  cleaned = restoreTextBlocks(cleaned, blocks);
  return cleaned;
};

// ---------- Tests ----------

test("\\pi G → \\pi{}G (command boundary preserved)", () => {
  assert.equal(normalizeMathCaptureText("\\pi G"), "\\pi{}G");
});

test("8\\pi G → 8\\pi{}G", () => {
  assert.equal(normalizeMathCaptureText("8\\pi G"), "8\\pi{}G");
});

test("\\Lambda g → \\Lambda{}g", () => {
  assert.equal(normalizeMathCaptureText("\\Lambda g"), "\\Lambda{}g");
});

test("\\sin x → \\sin{}x", () => {
  assert.equal(normalizeMathCaptureText("\\sin x"), "\\sin{}x");
});

test("\\mu \\nu → \\mu\\nu (backslash separates commands naturally)", () => {
  assert.equal(normalizeMathCaptureText("\\mu \\nu"), "\\mu\\nu");
});

test("\\frac{1}{2} → unchanged", () => {
  assert.equal(normalizeMathCaptureText("\\frac{1}{2}"), "\\frac{1}{2}");
});

test("x + y → x+y (regular spaces stripped)", () => {
  assert.equal(normalizeMathCaptureText("x + y"), "x+y");
});

test("\\pi 2 → \\pi2 (digit after command is fine)", () => {
  assert.equal(normalizeMathCaptureText("\\pi 2"), "\\pi2");
});

test("full Einstein equation: \\pi G preserved", () => {
  const input =
    "R_{\\mu \\nu} - \\frac{1}{2} R g_{\\mu \\nu} + \\Lambda g_{\\mu \\nu} = \\frac{8 \\pi G}{c^{4}} T_{\\mu \\nu}";
  const result = normalizeMathCaptureText(input);
  assert.ok(result.includes("\\pi{}G"), `Expected \\pi{}G in result: ${result}`);
  assert.ok(result.includes("\\Lambda{}g"), `Expected \\Lambda{}g in result: ${result}`);
  assert.ok(!result.includes("\\piG"), `Should NOT have \\piG: ${result}`);
  assert.ok(!result.includes("\\Lambdag"), `Should NOT have \\Lambdag: ${result}`);
});

test("dollar-wrapped input is unwrapped", () => {
  assert.equal(normalizeMathCaptureText("$\\pi G$"), "\\pi{}G");
});

test("\\text{...} blocks are preserved (whitespace inside may be stripped)", () => {
  const result = normalizeMathCaptureText("\\text{hello world} + x");
  // The text block content has its spaces stripped (pre-existing behavior)
  // but the \text{...} wrapper is preserved.
  assert.ok(result.includes("\\text{"), `\\text block wrapper should be preserved: ${result}`);
  assert.ok(result.includes("+x"), `Rest should be normalized: ${result}`);
});

test("empty input returns empty string", () => {
  assert.equal(normalizeMathCaptureText(""), "");
  assert.equal(normalizeMathCaptureText("   "), "");
});

test("\\alpha x → \\alpha{}x", () => {
  assert.equal(normalizeMathCaptureText("\\alpha x"), "\\alpha{}x");
});

test("\\beta \\gamma → \\beta\\gamma (both commands, no issue)", () => {
  assert.equal(normalizeMathCaptureText("\\beta \\gamma"), "\\beta\\gamma");
});
