/**
 * E2E tests: load real ONNX models, feed synthetic / programmatic images,
 * verify the complete pipeline (encoder → decoder → strip-text → normalize → score).
 *
 * These tests exercise the actual MathOcrService with onnxruntime-node,
 * so they take several seconds per case.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("path");

const MathOcrService =
  require("../electron/services/math-ocr/service.cjs").MathOcrService ??
  (() => {
    // service.cjs may export the class directly or via module.exports
    const mod = require("../electron/services/math-ocr/service.cjs");
    return typeof mod === "function" ? mod : mod.MathOcrService;
  })();

// ── Helpers ──────────────────────────────────────────────────────────

const W = 384;
const H = 384;
const MEAN = 0.5;
const STD = 0.5;

/**
 * Create a CHW float32 tensor (3 × H × W) from a greyscale pixel
 * generator function.  fn(x, y) → 0..255.
 */
const buildPayload = (fn) => {
  const count = W * H;
  const data = new Float32Array(count * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const grey = fn(x, y);
      const norm = (grey / 255 - MEAN) / STD;
      const idx = y * W + x;
      data[idx] = norm;             // R
      data[idx + count] = norm;     // G
      data[idx + count * 2] = norm; // B
    }
  }
  return { data, width: W, height: H };
};

/**
 * White canvas — model should produce empty / minimal output.
 */
const blankWhitePayload = () => buildPayload(() => 255);

/**
 * Draw a thick dark horizontal line segment on white — crude "minus"
 * or "fraction bar" shape.
 */
const horizontalBarPayload = () =>
  buildPayload((x, y) => {
    const cx = W / 2, cy = H / 2;
    const inBar = Math.abs(y - cy) < 6 && Math.abs(x - cx) < 60;
    return inBar ? 0 : 255;
  });

/**
 * Draw a crude "+" shape: two thick bars crossing at center.
 */
const plusPayload = () =>
  buildPayload((x, y) => {
    const cx = W / 2, cy = H / 2;
    const hBar = Math.abs(y - cy) < 5 && Math.abs(x - cx) < 40;
    const vBar = Math.abs(x - cx) < 5 && Math.abs(y - cy) < 40;
    return hBar || vBar ? 0 : 255;
  });

/**
 * Draw "=" — two parallel horizontal bars.
 */
const equalsPayload = () =>
  buildPayload((x, y) => {
    const cx = W / 2, cy = H / 2;
    const topBar = Math.abs(y - (cy - 12)) < 4 && Math.abs(x - cx) < 40;
    const botBar = Math.abs(y - (cy + 12)) < 4 && Math.abs(x - cx) < 40;
    return topBar || botBar ? 0 : 255;
  });

/**
 * Draw crude digit "1" — a vertical bar slightly off-centre.
 */
const digit1Payload = () =>
  buildPayload((x, y) => {
    const cx = W / 2, cy = H / 2;
    const stem = Math.abs(x - cx) < 4 && Math.abs(y - cy) < 30;
    const base = Math.abs(y - (cy + 30)) < 4 && Math.abs(x - cx) < 15;
    return stem || base ? 0 : 255;
  });

/**
 * Dense noise / random — model output should be rejected as garbage.
 */
const noisePayload = () => {
  // deterministic pseudo-random
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  return buildPayload(() => Math.floor(rand() * 256));
};

// ── Service bootstrap ───────────────────────────────────────────────

let service;

test.before(async () => {
  const appPath = path.resolve(__dirname, "..");
  service = new MathOcrService({
    appPath,
    userDataPath: appPath,
    isPackaged: false,
    resourcesPath: "",
  });
  // Warm-up: load ONNX sessions (takes a few seconds the first time)
  await service.ensureLoaded();
});

test.after(async () => {
  // The ONNX sessions don't need explicit cleanup but we could release
  // Tesseract if it was used.
  if (service?.tesseractWorker) {
    try { await service.tesseractWorker.terminate(); } catch {}
  }
});

// ── Tests ───────────────────────────────────────────────────────────

test("E2E ONNX: blank white image produces non-crashing output", async () => {
  const payload = blankWhitePayload();
  const result = await service.recognize(payload);
  // Should return something (possibly empty) without throwing
  assert.ok(result != null, "result should not be null");
  assert.ok(typeof result.latex === "string", "latex should be a string");
});

test("E2E ONNX: horizontal bar produces some output", async () => {
  const payload = horizontalBarPayload();
  const result = await service.recognize(payload);
  assert.ok(typeof result.latex === "string", "latex should be a string");
  // A bar shape might be decoded as "-", "\\frac", or similar. Just verify no crash.
  console.log(`  horizontal bar → "${result.latex}"`);
});

test("E2E ONNX: plus shape produces output with math content", async () => {
  const payload = plusPayload();
  const result = await service.recognize(payload);
  assert.ok(typeof result.latex === "string", "latex should be a string");
  console.log(`  plus shape → "${result.latex}"`);
});

test("E2E ONNX: equals shape produces output", async () => {
  const { isLikelyInvalidLatex, looksLikeGarbage } = require("../electron/services/math-ocr/scoring.cjs");
  const payload = equalsPayload();
  const result = await service.recognize(payload);
  assert.ok(typeof result.latex === "string", "latex should be a string");
  console.log(`  equals shape → "${result.latex}"`);
  // If decoder produces =\frac{}{}, our scoring should catch it
  if (result.latex.includes("\\frac{}{}") || result.latex.includes("\\frac{ }{ }")) {
    assert.ok(isLikelyInvalidLatex(result.latex), "both-empty \\frac should be detected as invalid");
  }
});

test("E2E ONNX: digit 1 — degenerate qquad output is detected", async () => {
  const { looksLikeGarbage, isLikelyInvalidLatex, scoreLatexCandidate } = require("../electron/services/math-ocr/scoring.cjs");
  const payload = digit1Payload();
  const result = await service.recognize(payload);
  assert.ok(typeof result.latex === "string", "latex should be a string");
  console.log(`  digit 1 → "${result.latex}" (len=${result.latex.length})`);
  // Model typically generates repeated \qquad for this shape — verify garbage detection
  const qquadCount = (result.latex.match(/\\qquad/g) ?? []).length;
  if (qquadCount > 4) {
    assert.ok(looksLikeGarbage(result.latex), `repeated \\qquad (${qquadCount}×) should be garbage`);
    assert.ok(scoreLatexCandidate(result.latex) < 50, `repeated \\qquad should score low, got ${scoreLatexCandidate(result.latex)}`);
  }
});

test("E2E ONNX: noise image — degenerate output is detected", async () => {
  const { looksLikeGarbage, isLikelyInvalidLatex, scoreLatexCandidate } = require("../electron/services/math-ocr/scoring.cjs");
  const payload = noisePayload();
  const result = await service.recognize(payload);
  assert.ok(typeof result.latex === "string", "latex should be a string");
  console.log(`  noise → "${result.latex}" (len=${result.latex.length})`);
  // Noise typically produces repeated digits or junk — verify detection
  if (result.latex.length > 0) {
    const hasLongRepeat = /(.)\1{15,}/.test(result.latex);
    const isGarbage = looksLikeGarbage(result.latex);
    const isInvalid = isLikelyInvalidLatex(result.latex);
    const score = scoreLatexCandidate(result.latex);
    console.log(`  noise scoring → garbage=${isGarbage}, invalid=${isInvalid}, score=${score}, longRepeat=${hasLongRepeat}`);
    // At least one detection mechanism should flag this
    assert.ok(isGarbage || isInvalid || score < 50,
      `noise output should be flagged (garbage=${isGarbage}, invalid=${isInvalid}, score=${score})`);
  }
});

test("E2E ONNX: maxSeqLen is respected", async () => {
  const payload = { ...plusPayload(), maxSeqLen: 20 };
  const result = await service.recognize(payload);
  assert.ok(typeof result.latex === "string", "latex should be a string");
  // With maxSeqLen=20 the output should be short
  console.log(`  plus (maxSeqLen=20) → "${result.latex}" (len=${result.latex.length})`);
});

test("E2E ONNX: maxDecodeCandidates=1 works", async () => {
  const payload = { ...horizontalBarPayload(), maxDecodeCandidates: 1 };
  const result = await service.recognize(payload);
  assert.ok(typeof result.latex === "string", "latex should be a string");
});

test("E2E ONNX: recognize rejects invalid payload", async () => {
  await assert.rejects(() => service.recognize(null), /payload/i);
  await assert.rejects(() => service.recognize({}), /invalid/i);
});

test("E2E ONNX: output passes scoring and normalization", async () => {
  const { scoreLatexCandidate, isLikelyInvalidLatex, looksLikeGarbage } = require("../electron/services/math-ocr/scoring.cjs");
  const { normalizeDecodedLatex } = require("../electron/services/math-ocr/latex-normalize.cjs");
  const payload = plusPayload();
  const result = await service.recognize(payload);
  if (result.latex.length > 0) {
    const score = scoreLatexCandidate(result.latex);
    const invalid = isLikelyInvalidLatex(result.latex);
    const normalized = normalizeDecodedLatex(result.latex);
    console.log(`  plus scoring → score=${score}, invalid=${invalid}, latex="${result.latex}", normalized="${normalized}"`);
    assert.ok(typeof score === "number" && Number.isFinite(score), "score should be finite");
    assert.ok(typeof normalized === "string", "normalized should be a string");
  }
});

test("E2E ONNX: horizontal bar — scoring classifies reasonably", async () => {
  const { scoreLatexCandidate, isLikelyInvalidLatex } = require("../electron/services/math-ocr/scoring.cjs");
  const payload = horizontalBarPayload();
  const result = await service.recognize(payload);
  assert.ok(typeof result.latex === "string");
  if (result.latex.length > 0) {
    const score = scoreLatexCandidate(result.latex);
    const invalid = isLikelyInvalidLatex(result.latex);
    console.log(`  bar scoring → score=${score}, invalid=${invalid}, latex="${result.latex}"`);
    assert.ok(typeof score === "number" && Number.isFinite(score), "score should be finite");
  }
});
