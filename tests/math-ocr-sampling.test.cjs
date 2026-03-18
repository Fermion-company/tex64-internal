const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clamp,
  softmax,
  filterTopK,
  filterTopP,
  createRng,
  sampleFromProbs,
  buildDecodeCandidates,
} = require("../electron/services/math-ocr/sampling.cjs");

// --- clamp ---

test("clamp: within range", () => {
  assert.equal(clamp(5, 0, 10), 5);
});

test("clamp: below min", () => {
  assert.equal(clamp(-5, 0, 10), 0);
});

test("clamp: above max", () => {
  assert.equal(clamp(15, 0, 10), 10);
});

// --- softmax ---

test("softmax: sums to 1", () => {
  const probs = softmax([1, 2, 3]);
  const sum = probs.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `sum should be ~1, got ${sum}`);
});

test("softmax: larger logit gets higher probability", () => {
  const probs = softmax([1, 2, 3]);
  assert.ok(probs[2] > probs[1], "index 2 should be > index 1");
  assert.ok(probs[1] > probs[0], "index 1 should be > index 0");
});

test("softmax: all same logits gives uniform", () => {
  const probs = softmax([5, 5, 5]);
  for (const p of probs) {
    assert.ok(Math.abs(p - 1 / 3) < 1e-6, `should be ~0.333, got ${p}`);
  }
});

// --- createRng ---

test("createRng: deterministic", () => {
  const rng1 = createRng(42);
  const rng2 = createRng(42);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(rng1(), rng2(), `iteration ${i} should match`);
  }
});

test("createRng: values in [0, 1)", () => {
  const rng = createRng(12345);
  for (let i = 0; i < 100; i += 1) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `value ${v} out of range`);
  }
});

test("createRng: different seeds give different sequences", () => {
  const rng1 = createRng(1);
  const rng2 = createRng(2);
  let same = 0;
  for (let i = 0; i < 10; i += 1) {
    if (rng1() === rng2()) same += 1;
  }
  assert.ok(same < 10, "different seeds should give different values");
});

// --- sampleFromProbs ---

test("sampleFromProbs: deterministic with fixed rng", () => {
  const probs = [0.1, 0.3, 0.6];
  const rng = () => 0.5; // should land in index 2 (cumulative: 0.1, 0.4, 1.0)
  assert.equal(sampleFromProbs(probs, rng), 2);
});

test("sampleFromProbs: low rng selects first", () => {
  const probs = [0.5, 0.3, 0.2];
  const rng = () => 0.01;
  assert.equal(sampleFromProbs(probs, rng), 0);
});

// --- filterTopK ---

test("filterTopK: keeps top entries", () => {
  const logits = [1, 5, 3, 2, 4];
  const filtered = filterTopK(logits, 0.6); // k = floor((1-0.6)*5) = 2
  const kept = filtered.filter((v) => v > -Infinity).length;
  assert.equal(kept, 2, `should keep 2 entries, got ${kept}`);
  assert.ok(filtered[1] > -Infinity, "index 1 (highest) should be kept");
  assert.ok(filtered[4] > -Infinity, "index 4 (second highest) should be kept");
});

// --- filterTopP ---

test("filterTopP: filters low probability tokens", () => {
  const logits = [10, 1, 1, 1, 1]; // softmax: ~0.99 for index 0
  const filtered = filterTopP(logits, 0.9);
  const kept = filtered.filter((v) => v > -Infinity).length;
  assert.ok(kept >= 1, `should keep at least 1 entry, got ${kept}`);
  assert.ok(filtered[0] > -Infinity, "highest probability token should be kept");
});

// --- buildDecodeCandidates ---

test("buildDecodeCandidates: respects MAX_DECODE_CANDIDATES", () => {
  const config = {
    decodeStrategy: "greedy",
    filterThres: 0.9,
    temperature: 1.0,
  };
  const candidates = buildDecodeCandidates(config);
  assert.ok(candidates.length <= 3, `should have at most 3 candidates, got ${candidates.length}`);
  assert.ok(candidates.length >= 1, `should have at least 1 candidate`);
});

test("buildDecodeCandidates: first candidate matches config", () => {
  const config = {
    decodeStrategy: "greedy",
    filterThres: 0.9,
    temperature: 1.0,
  };
  const candidates = buildDecodeCandidates(config);
  assert.equal(candidates[0].strategy, "greedy");
});

test("buildDecodeCandidates: no duplicates", () => {
  const config = {
    decodeStrategy: "top_p",
    filterThres: 0.9,
    temperature: 1.0,
  };
  const candidates = buildDecodeCandidates(config);
  const keys = candidates.map(
    (c) => `${c.strategy}:${c.filterThres.toFixed(4)}:${c.temperature.toFixed(4)}`
  );
  const unique = new Set(keys);
  assert.equal(unique.size, keys.length, "should have no duplicate candidates");
});
