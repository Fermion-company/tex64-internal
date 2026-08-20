import test from "node:test";
import assert from "node:assert/strict";
import {
  VARIANT_TOTAL_MS,
  formatRemaining,
  initialEtaState,
  nextEtaState,
  timeFractionForPercent,
} from "../Resources/web/app/onboarding-ui.js";

// The full install spends almost all of its time in install-tl, which ends at
// bar 80%; the final package/finalize steps are short.
test("the full-install progress curve matches its work distribution", () => {
  assert.ok(timeFractionForPercent(80, "full") > 0.9);
  assert.ok(timeFractionForPercent(98, "full") > 0.99);
  assert.equal(timeFractionForPercent(0, "full"), 0);
  assert.equal(timeFractionForPercent(100, "full"), 1);
});

test("the curve never goes backwards", () => {
  let previous = -1;
  for (let p = 0; p <= 100; p += 1) {
    const value = timeFractionForPercent(p, "full");
    assert.ok(value >= previous, `full dipped at ${p}%`);
    previous = value;
  }
});

test("percent outside 0-100 is clamped instead of producing nonsense", () => {
  assert.equal(timeFractionForPercent(-20, "full"), 0);
  assert.equal(timeFractionForPercent(400, "full"), 1);
  assert.equal(timeFractionForPercent(Number.NaN, "full"), 0);
});

test("before any real progress the estimate uses the known full-install duration", () => {
  const state = nextEtaState(initialEtaState(), {
    percent: 0,
    now: 1000,
    variant: "full",
  });
  assert.equal(state.startedAt, 1000);
  assert.equal(Math.round(state.remainingMs), VARIANT_TOTAL_MS.full);
});

test("a run slower than the estimate is reported as slower", () => {
  const start = 0;
  let state = nextEtaState(initialEtaState(), { percent: 0, now: start, variant: "full" });
  // Bar at 10% but fifteen minutes gone: this machine is far slower than the
  // reference run, so the remaining time must exceed the static estimate.
  for (let i = 0; i < 12; i += 1) {
    state = nextEtaState(state, { percent: 10, now: start + 15 * 60 * 1000, variant: "full" });
  }
  const projectedRemaining =
    (15 * 60 * 1000) / timeFractionForPercent(10, "full") - 15 * 60 * 1000;
  assert.ok(
    state.remainingMs > VARIANT_TOTAL_MS.full,
    `expected a slow run to read slower, got ${state.remainingMs}`
  );
  assert.ok(state.remainingMs < projectedRemaining);
});

test("a run at the reference pace counts down, and the bar never rewinds", () => {
  let state = nextEtaState(initialEtaState(), { percent: 0, now: 0, variant: "full" });
  const first = state.remainingMs;
  // Replay the shape of a full install: the clock advances in step with
  // the time curve, not with the bar. 60 is a late packet arriving out of order.
  const samples = [5, 20, 40, 80, 80, 60, 85, 90, 95, 98];
  for (const percent of samples) {
    const now = timeFractionForPercent(percent, "full") * VARIANT_TOTAL_MS.full;
    state = nextEtaState(state, { percent, now, variant: "full" });
  }
  assert.ok(state.remainingMs < first / 3, `expected a countdown, got ${state.remainingMs}`);
  assert.ok(state.remainingMs < 45_000);
  // A late, lower packet must not rewind the bar.
  assert.equal(state.percent, 98);
});

test("a rise in the estimate is damped, not a lurch", () => {
  let state = nextEtaState(initialEtaState(), { percent: 0, now: 0, variant: "full" });
  const before = state.remainingMs;
  // One packet saying the run is ten times slower than expected.
  state = nextEtaState(state, { percent: 10, now: 6 * 60_000, variant: "full" });
  assert.ok(state.remainingMs > before, "a slower run should read slower");
  assert.ok(
    state.remainingMs < before * 3,
    `a single packet should not lurch the estimate, got ${state.remainingMs}`
  );
});

test("reaching 100% means no time left", () => {
  let state = nextEtaState(initialEtaState(), { percent: 0, now: 0, variant: "full" });
  state = nextEtaState(state, { percent: 100, now: 60_000, variant: "full" });
  assert.equal(state.remainingMs, 0);
});

test("the remaining time is phrased the way a person would say it", () => {
  assert.match(formatRemaining(0), /almost done|まもなく/);
  assert.match(formatRemaining(8_000), /almost done|まもなく/);
  assert.match(formatRemaining(42_000), /40 seconds|40 秒/);
  assert.match(formatRemaining(61_000), /a minute|1 分/);
  assert.match(formatRemaining(7 * 60_000), /7 minutes|7 分/);
  assert.match(formatRemaining(95 * 60_000), /1 h 35|1 時間 35/);
  assert.match(formatRemaining(120 * 60_000), /2 h |2 時間/);
  assert.equal(formatRemaining(null), "");
  assert.equal(formatRemaining(Number.NaN), "");
});
