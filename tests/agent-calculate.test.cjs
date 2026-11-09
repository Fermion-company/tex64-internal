const { test } = require("node:test");
const assert = require("node:assert/strict");
const { calculate, calculateBatch } = require("../electron/services/openprism/calculate.cjs");

test("school counting and integer functions", () => {
  assert.equal(calculate("comb(10,3)"), 120);
  assert.equal(calculate("comb(5,7)"), 0);
  assert.equal(calculate("perm(6,3)"), 120);
  assert.equal(calculate("fact(0)"), 1);
  assert.equal(calculate("fact(10)"), 3628800);
  assert.equal(calculate("gcd(84,36)"), 12);
  assert.equal(calculate("lcm(4,6,10)"), 60);
  assert.equal(calculate("floor(-2.5)+ceil(2.1)+round(2.5)"), 3);
  assert.equal(calculate("log2(8)"), 3);
  assert.throws(() => calculate("fact(2.5)"), /whole numbers/);
});

test("simple fractions come back exact", () => {
  const [prob, half, irrational, integer] = calculateBatch({ expressions: ["comb(3,1)*comb(4,1)/comb(7,2)", "0.5", "sqrt(3)", "6/3"] }).results;
  assert.equal(prob.fraction, "4/7");
  assert.equal(half.fraction, "1/2");
  assert.equal(irrational.fraction, undefined);
  assert.equal(integer.fraction, undefined);
});
