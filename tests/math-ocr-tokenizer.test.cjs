const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildIdToToken,
  decodeTokens,
} = require("../electron/services/math-ocr/tokenizer.cjs");

// --- buildIdToToken ---

test("buildIdToToken: builds array from vocab", () => {
  const tokenizer = {
    model: {
      vocab: { "x": 0, "y": 1, "+": 2, "=": 3 },
    },
  };
  const result = buildIdToToken(tokenizer);
  assert.equal(result[0], "x");
  assert.equal(result[1], "y");
  assert.equal(result[2], "+");
  assert.equal(result[3], "=");
});

test("buildIdToToken: handles flat vocab", () => {
  const tokenizer = {
    vocab: { "a": 0, "b": 1 },
  };
  const result = buildIdToToken(tokenizer);
  assert.equal(result[0], "a");
  assert.equal(result[1], "b");
});

test("buildIdToToken: empty tokenizer", () => {
  const result = buildIdToToken({});
  assert.equal(result.length, 0);
});

// --- decodeTokens ---

test("decodeTokens: basic decode", () => {
  const idToToken = ["x", "^", "{", "2", "}"];
  const result = decodeTokens([0, 1, 2, 3, 4], idToToken);
  assert.equal(result, "x^{2}");
});

test("decodeTokens: strips special tokens", () => {
  const idToToken = ["<pad>", "<s>", "x", "+", "y", "</s>"];
  const result = decodeTokens([0, 1, 2, 3, 4, 5], idToToken);
  assert.equal(result, "x+y");
});

test("decodeTokens: handles Ġ (GPT-style space)", () => {
  // Ġ replaced by single space, .trim() removes leading
  const idToToken = ["x", "Ġ+", "Ġy"];
  const result = decodeTokens([0, 1, 2], idToToken);
  assert.equal(result, "x + y");
});

test("decodeTokens: handles ▁ (sentencepiece space)", () => {
  // ▁ replaced by single space, .trim() removes leading
  const idToToken = ["▁x", "▁+", "▁y"];
  const result = decodeTokens([0, 1, 2], idToToken);
  assert.equal(result, "x + y");
});

test("decodeTokens: unknown token ids return empty string", () => {
  const idToToken = ["a", "b"];
  const result = decodeTokens([0, 1, 99], idToToken);
  assert.equal(result, "ab");
});

test("decodeTokens: strips <unk> and <mask>", () => {
  const idToToken = ["a", "<unk>", "b", "<mask>"];
  const result = decodeTokens([0, 1, 2, 3], idToToken);
  assert.equal(result, "ab");
});
