"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const code = fs.readFileSync(require.resolve("../web-src/app/pdf-live-status.ts"), "utf8");
const compiled = ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;
const exported = {};
new Function("exports", compiled)(exported);
const { stepPdfLiveStatusMark: step, PDF_LIVE_BEHIND_THRESHOLD_MS: threshold, resolvePdfLiveStatus } = exported;
const idle = { up: true, srcRev: 5, rev: 12, canonical: { rev: 5 } };
const presented = { now: 0, presentationPending: false, appliedSrcRev: 5 };

test("caught up, presented and idle is green in structured and opaque modes", () => {
  for (const mode of ["structured", "opaque"]) {
    assert.equal(step({ ...idle, mode }, presented).color, "green");
  }
});

for (const [name, extra] of Object.entries({
  "busy engine": { busy: true },
  "queued rendering": { render: { queued: [1] } },
  "active rendering": { render: { active: [1] } },
  "render pump": { render: { pumping: 1 } },
  "cold replay": { cold: { pending: [1] } },
  "shipping boot": { shipping: { retry: { state: "booting" } } },
  "canonical running": { canonical: { rev: 5, compiling: true } },
  "canonical in flight": { canonical: { rev: 5, inFlight: true } },
  "legacy canonical child": { canonical: { rev: 5, authorityChildren: 1 } },
  "canonical scheduled for a newer source": { canonical: { rev: 4, scheduledInMs: 20000 } },
  "canonical timer due now": { canonical: { rev: 5, scheduledInMs: 0 } },
  "canonical behind without a timer": { canonical: { rev: 4 } },
  "display demand": { canonical: { rev: 5, displayDemandRev: 5 } },
})) {
  test(`${name} is orange`, () => assert.equal(step({ ...idle, ...extra }, presented).color, "orange"));
}

test("waiting for presentation stays orange even when canonical has caught up", () => {
  assert.equal(step(idle, { ...presented, presentationPending: true }).color, "orange");
});

test("source ahead of the drawn revision turns red at the named threshold", () => {
  assert.equal(threshold, 3000);
  const options = { ...presented, appliedSrcRev: 4 };
  const first = step(idle, options);
  assert.equal(first.color, "orange");
  assert.equal(step(idle, { ...options, previous: first, now: threshold - 1 }).color, "orange");
  assert.equal(step(idle, { ...options, previous: first, now: threshold }).color, "red");
});

test("continued typing and layout updates cannot postpone overload without a newer presentation", () => {
  const first = step(idle, { ...presented, presentationPending: true });
  const next = step({ ...idle, srcRev: 6, rev: 30, busy: true }, {
    now: 2000, previous: first, appliedSrcRev: 6, presentationPending: true,
  });
  assert.equal(next.behindSince, 0);
  assert.equal(step({ ...idle, srcRev: 7, rev: 31, busy: true }, {
    now: threshold, previous: next, appliedSrcRev: 7, presentationPending: true,
  }).color, "red");
});

test("newer drawn source restarts the lag clock and catching up clears it", () => {
  const first = step({ ...idle, srcRev: 8 }, presented);
  const progress = step({ ...idle, srcRev: 8 }, { ...presented, appliedSrcRev: 6, previous: first, now: threshold });
  assert.equal(progress.color, "orange");
  assert.equal(progress.behindSince, threshold);
  const caught = step({ ...idle, srcRev: 8, canonical: { rev: 8 } }, {
    ...presented, appliedSrcRev: 8, previous: progress, now: threshold * 2,
  });
  assert.equal(caught.color, "green");
  assert.equal(caught.behindSince, null);
});

test("canonical cadence alone never makes current incremental paper red", () => {
  const scheduled = { ...idle, canonical: { rev: 4, scheduledInMs: 20000 } };
  const first = step(scheduled, presented);
  assert.equal(step(scheduled, { ...presented, previous: first, now: 60000 }).color, "orange");
});

test("a presentation wait for an already drawn source does not count as typing lag", () => {
  const first = step(idle, presented);
  const pending = step(idle, { ...presented, previous: first, presentationPending: true, now: 1 });
  assert.equal(step(idle, { ...presented, previous: pending, presentationPending: true, now: 60000 }).color, "orange");
});

test("current canonical errors are red even during rendering; older errors are not red", () => {
  const error = { ...idle, canonical: { rev: 5, error: "TeX error", errorRev: 5 } };
  assert.equal(step(error, presented).color, "red");
  assert.equal(step({ ...error, busy: true }, presented).color, "red");
  assert.equal(step({ ...error, canonical: { ...error.canonical, errorRev: 4 } }, presented).color, "green");
  assert.deepEqual(resolvePdfLiveStatus(error, false), { key: "liveError", tone: "error", detail: "TeX error" });
});

test("iframe edits newer than the status poll prevent false green and stale error red", () => {
  const status = { ...idle, canonical: { rev: 5, error: "old", errorRev: 5 } };
  assert.equal(step(status, { ...presented, appliedSrcRev: 6 }).color, "orange");
});

test("unknown status or presentation cannot turn green, and unavailable is red", () => {
  assert.equal(step(null, { now: 0 }).color, "orange");
  assert.equal(step({}, presented).color, "orange");
  assert.equal(step(idle, { now: 0 }).color, "orange");
  assert.equal(step({ up: false }, presented).color, "red");
});

test("a new document or rolled-back revision starts a fresh lag clock", () => {
  const previous = step(idle, { ...presented, appliedSrcRev: 4 });
  const status = { ...idle, srcRev: 1, canonical: { rev: 0 } };
  const options = { now: 60000, presentationPending: true, appliedSrcRev: 1 };
  assert.equal(step(status, { ...options, previous }).behindSince, 60000);
  assert.equal(step(idle, { ...options, previous: null }).color, "orange");
});
