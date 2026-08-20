import test from "node:test";
import assert from "node:assert/strict";
import {
  VARIANT_TOTAL_MS,
  formatRemaining,
  initialEtaState,
  nextEtaState,
  timeFractionForPercent,
} from "../Resources/web/app/onboarding-ui.js";

// The progress bar is not linear in time, so a naive "elapsed / percent"
// estimate would promise the light install is nearly done at 80% when in fact
// the long package phase has not started. These cover the mapping that fixes it.
test("the light install spends most of its time after the bar reaches 80%", () => {
  // install-tl finishes around bar 80% but only ~13% of the wall clock.
  assert.ok(timeFractionForPercent(80, "light") < 0.2);
  assert.ok(timeFractionForPercent(98, "light") > 0.85);
  assert.equal(timeFractionForPercent(0, "light"), 0);
  assert.equal(timeFractionForPercent(100, "light"), 1);
});

test("the full install is the opposite: the bar and the clock nearly agree", () => {
  assert.ok(timeFractionForPercent(80, "full") > 0.9);
});

test("the curve never goes backwards", () => {
  for (const variant of ["light", "full"]) {
    let previous = -1;
    for (let p = 0; p <= 100; p += 1) {
      const value = timeFractionForPercent(p, variant);
      assert.ok(value >= previous, `${variant} dipped at ${p}%`);
      previous = value;
    }
  }
});

test("percent outside 0-100 is clamped instead of producing nonsense", () => {
  assert.equal(timeFractionForPercent(-20, "light"), 0);
  assert.equal(timeFractionForPercent(400, "light"), 1);
  assert.equal(timeFractionForPercent(Number.NaN, "light"), 0);
});

test("before any real progress the estimate is the variant's known duration", () => {
  const state = nextEtaState(initialEtaState(), {
    percent: 0,
    now: 1000,
    variant: "light",
  });
  assert.equal(state.startedAt, 1000);
  assert.equal(Math.round(state.remainingMs), VARIANT_TOTAL_MS.light);
});

test("a run slower than the estimate is reported as slower", () => {
  const start = 0;
  let state = nextEtaState(initialEtaState(), { percent: 0, now: start, variant: "light" });
  // Bar at 80% but five minutes gone: this machine is far slower than the
  // reference run, so the remaining time must exceed the static estimate.
  for (let i = 0; i < 12; i += 1) {
    state = nextEtaState(state, { percent: 80, now: start + 5 * 60 * 1000, variant: "light" });
  }
  const projectedTotal = (5 * 60 * 1000) / timeFractionForPercent(80, "light");
  assert.ok(
    state.remainingMs > VARIANT_TOTAL_MS.light,
    `expected a slow run to read slower, got ${state.remainingMs}`
  );
  assert.ok(state.remainingMs < projectedTotal);
});

test("a run at the reference pace counts down, and the bar never rewinds", () => {
  let state = nextEtaState(initialEtaState(), { percent: 0, now: 0, variant: "light" });
  const first = state.remainingMs;
  // Replay the shape of a real light install: the clock advances in step with
  // the time curve, not with the bar. 60 is a late packet arriving out of order.
  const samples = [5, 20, 40, 80, 80, 60, 85, 90, 95, 98];
  for (const percent of samples) {
    const now = timeFractionForPercent(percent, "light") * VARIANT_TOTAL_MS.light;
    state = nextEtaState(state, { percent, now, variant: "light" });
  }
  // 110s into a 128s run: the estimate must be down to seconds, not still
  // quoting most of the original duration.
  assert.ok(state.remainingMs < first / 3, `expected a countdown, got ${state.remainingMs}`);
  assert.ok(state.remainingMs < 45_000);
  // A late, lower packet must not rewind the bar.
  assert.equal(state.percent, 98);
});

test("a rise in the estimate is damped, not a lurch", () => {
  let state = nextEtaState(initialEtaState(), { percent: 0, now: 0, variant: "light" });
  const before = state.remainingMs;
  // One packet saying the run is ten times slower than expected.
  state = nextEtaState(state, { percent: 8, now: 60_000, variant: "light" });
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
