"use strict";
// tex64-internal #121: a document reset covers Live with the static PDF and
// hands the reader's place to the rebuilt paper. The handoff keeps that
// place until the frame stands there and has painted it, follows a paper
// that is still being built or rendered, reloads a stalled frame once per
// reset, and lets go of the place after a stall no reload helps: the frame is
// revealed at its nearest page once presentable. The cover is drawn at the
// live paper's own width. The snapshots below have the shape
// the frame posts (tdom-engine web/app.js postEmbedSnapshot).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const code = fs.readFileSync(require.resolve("../web-src/app/pdf-live-handoff.ts"), "utf8");
const compiled = ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;
const exported = {};
new Function("exports", compiled)(exported);
const {
  LIVE_RESET_STALL_MS: stall,
  coverHoldsReaderPage,
  coverScaleFor,
  livePaperPresentableFor: presentableFor,
  liveHandoffSyncFor,
  liveReaderPlace,
  resolveLiveViewportTarget,
  stepLiveViewportHandoff: step,
} = exported;

const sync = (page) => ({ page, x: 0, y: 400, blockY: 400, blockHeight: 0, marker: false, viewportToken: "a:1" });
// a frame snapshot: its paper unpainted and still pending unless said otherwise
const frame = (fields) => ({
  viewportToken: null, page: 1, pageCount: 30, ready: false, painted: false, presentationPending: true,
  srcRev: 9, status: { rev: 100 }, ...fields,
});
const reset = (page) => ({ sync: sync(page), stallMs: stall });
// the viewer's own gate for a reset (no Build revision to wait for)
const at = (handoff, snapshot, now, more = {}) => step(handoff, snapshot, {
  now, presentable: presentableFor(snapshot, null), authoritative: false, ...more,
});

test("a reset rebuilt from zero pages, then five, then the whole paper ends on the reader's page, painted", () => {
  const handoff = reset(29);
  let t = 0;
  // the new paper has nothing yet: wait, nothing to send
  assert.deepEqual(at(handoff, frame({ pageCount: 0 }), t),
    { done: false, goto: null, positioned: false, stalled: false, reload: false });
  // five pages placed and painted: page 29 is not clamped to 5, the frame is not moved
  t += 1500;
  assert.deepEqual(at(handoff, frame({ pageCount: 5, ready: true, painted: true }), t),
    { done: false, goto: null, positioned: false, stalled: false, reload: false });
  // the paper keeps growing: no stall while it does
  t += stall - 1;
  assert.equal(at(handoff, frame({ pageCount: 12 }), t).stalled, false);
  // the reader's page exists: the frame is sent to it, with the same point
  t += 500;
  assert.deepEqual(at(handoff, frame({ pageCount: 30 }), t),
    { done: false, goto: 29, positioned: false, stalled: false, reload: false });
  // there, an empty shell: still covered
  t += 200;
  const there = { pageCount: 30, page: 28, viewportToken: "a:1" };
  assert.deepEqual(at(handoff, frame(there), t), { done: false, goto: 29, positioned: true, stalled: false, reload: false });
  // painted there: the cover lifts
  t += 200;
  assert.deepEqual(at(handoff, frame({ ...there, ready: true, painted: true, presentationPending: false }), t),
    { done: true, goto: null, positioned: true, stalled: false, reload: false });
});

test("paper the frame has not painted is never revealed, whatever else says it is presentable", () => {
  const unpainted = { srcRev: 12, ready: false, painted: false, presentationPending: true, status: { canonical: { rev: 12 } } };
  // after a Build: a canonical generation past the accepted revision, but an empty shell in sight
  assert.equal(presentableFor(unpainted, 11), false);
  assert.equal(presentableFor({ ...unpainted, painted: true }, 11), true, "the same, painted");
  assert.equal(presentableFor({ ...unpainted, painted: true, ready: false, presentationPending: false, status: null }, 11), true);
  assert.equal(presentableFor({ ...unpainted, painted: true, srcRev: 10 }, 11), false, "the accepted revision not applied yet");
  // other activations wait for an exact paint
  assert.equal(presentableFor({ ready: true, painted: false }, null), false);
  assert.equal(presentableFor({ ready: true, painted: true }, null), true);
  assert.equal(presentableFor({ ready: true }, null), true, "a frame that does not report paint");
  assert.equal(presentableFor(null, null), false);
});

test("the place is clamped only by a complete paper that is shorter", () => {
  assert.equal(resolveLiveViewportTarget(sync(29), frame({ pageCount: 5 }), false), null);
  assert.equal(resolveLiveViewportTarget(sync(29), frame({ pageCount: 27 }), true), 27);
  const handoff = reset(29);
  assert.deepEqual(step(handoff, frame({ pageCount: 27 }), { now: 0, presentable: false, authoritative: true }),
    { done: false, goto: 27, positioned: false, stalled: false, reload: false });
});

test("rendering at a fixed page count is progress; a stall short of the place reloads once, then the place is let go", () => {
  const handoff = reset(29);
  const building = frame({ pageCount: 30, page: 1, viewportToken: "a:1" });
  at(handoff, building, 0, { reloadAvailable: true });
  // the engine lands render after render at the same count: no stall
  for (let k = 1; k <= 4; k++) {
    assert.equal(at(handoff, { ...building, status: { rev: 100 + k } }, k * (stall - 1), { reloadAvailable: true }).stalled, false);
  }
  // then nothing changes for the stall time: the frame, not at the place, is reloaded
  const last = { ...building, status: { rev: 104 } };
  const quiet = 4 * (stall - 1) + stall;
  assert.deepEqual(at(handoff, last, quiet, { reloadAvailable: true }),
    { done: false, goto: 29, positioned: false, stalled: true, reload: true });
  // the reset has had its reload (the viewer keeps that on the reset, not on
  // the handoff a moved cover replaces): stalled again, the place is let go;
  // the cover stays only while the paper is not presentable
  assert.deepEqual(at(handoff, last, quiet + stall, { reloadAvailable: false }),
    { done: false, goto: 29, positioned: false, stalled: true, reload: false });
  assert.equal(handoff.released, true);
  assert.deepEqual(at(handoff, { ...last, ready: true, painted: true }, quiet + stall + 1, { reloadAvailable: false }),
    { done: true, goto: 29, positioned: false, stalled: true, reload: false }, "revealed where it is, its paper painted");
  // at the place but never painted: no reload; revealed once painted
  const unpainted = reset(29);
  const there = frame({ page: 28, viewportToken: "a:1" });
  at(unpainted, there, 0, { reloadAvailable: true });
  assert.deepEqual(at(unpainted, there, stall, { reloadAvailable: true }),
    { done: false, goto: 29, positioned: true, stalled: true, reload: false });
});

test("an outer paper's sheets are compared in goto-sync's numbering", () => {
  // the reader handed back to Build sheet 31; the chapter grew a page, so the
  // sheet stands 32nd in the frame's own count
  const handoff = { sync: sync(31) };
  const shown = frame({ page: 32, pageCount: 41, syncPage: 31, syncPageCount: 40, viewportToken: "a:1", ready: true, painted: true });
  assert.deepEqual(step(handoff, shown, { now: 0, presentable: true, authoritative: true }),
    { done: true, goto: null, positioned: true, stalled: false, reload: false });
  // a shrunk chapter: the Build's last sheet is still a sheet
  assert.equal(resolveLiveViewportTarget(sync(40), frame({ pageCount: 39, syncPageCount: 40 }), true), 40);
});

test("the frame's word on the very sheet it acknowledged decides, not a nearby number", () => {
  const sheet6 = { sync: sync(6) };
  // the chapter grew by two sheets: live sheet 7 is at the top while Build
  // sheet 6 stands centred, the sheet the token was acknowledged for
  const grown = frame({ page: 9, syncPage: 7, syncPageCount: 10, viewportToken: "a:1", tokenSheetShown: true,
    ready: true, painted: true });
  assert.deepEqual(step(sheet6, grown, { now: 0, presentable: true, authoritative: true }),
    { done: true, goto: null, positioned: true, stalled: false, reload: false });
  // a nearby live page in view under the same token (an older frame would have been taken within the slack)
  const nearby = frame({ page: 5, syncPage: 5, syncPageCount: 8, viewportToken: "a:1", tokenSheetShown: false,
    ready: true, painted: true });
  assert.equal(step({ sync: sync(6) }, nearby, { now: 0, presentable: true, authoritative: true }).positioned, false);
  // a frame that does not say is judged by its top page within the slack, as before
  const older = frame({ page: 5, syncPage: 5, viewportToken: "a:1", ready: true, painted: true });
  assert.equal(step({ sync: sync(6) }, older, { now: 0, presentable: true, authoritative: true }).positioned, true);
});

test("a live page a complete chapter no longer has hands the reader to the chapter's last page, under a new token", () => {
  // two Build sheets before the chapter; the reader was on its live page 4
  const handoff = { sync: { ...sync(6), livePage: 4 }, stallMs: stall };
  // the rebuilt chapter has three live pages, still being built: wait
  const building = frame({ pageCount: 10, syncPageCount: 8, livePageCount: 3, viewportToken: null });
  assert.equal(step(handoff, building, { now: 0, presentable: false, authoritative: false }).goto, 6);
  assert.equal(handoff.sync.livePage, 4, "not resolved before the chapter is complete");
  // complete with three: page 4 never arrives; live page 3 (sheet 5) it is
  const complete = frame({ pageCount: 10, syncPageCount: 8, livePageCount: 3, viewportToken: "a:1" });
  const moved = step(handoff, complete, { now: 1, presentable: true, authoritative: true });
  assert.equal(moved.goto, 5);
  assert.deepEqual([handoff.sync.page, handoff.sync.livePage], [5, 3]);
  assert.notEqual(handoff.sync.viewportToken, "a:1", "a token of its own");
  assert.equal(moved.positioned, false, "the old token's acknowledgement does not count");
  // the frame acknowledges the new token on live page 3
  const there = frame({ pageCount: 10, syncPageCount: 8, livePageCount: 3, viewportToken: handoff.sync.viewportToken,
    tokenSheetShown: true, ready: true, painted: true, presentationPending: false });
  assert.deepEqual(step(handoff, there, { now: 2, presentable: true, authoritative: true }),
    { done: true, goto: null, positioned: true, stalled: false, reload: false });
});

test("a place the static Build viewer took in a chapter that shrank goes to the chapter's last live page", () => {
  // two Build sheets, the chapter's four (3..6), trailing sheets from 7; the
  // static viewer only knows sheet 6 (audit/scratch boundaries.mjs)
  const handoff = { sync: sync(6) };
  const chapter = { from: 3, to: 6 };
  const complete = frame({ pageCount: 10, syncPageCount: 8, livePageCount: 3, chapter, viewportToken: "a:1",
    ready: true, painted: true, presentationPending: false });
  const moved = step(handoff, complete, { now: 0, presentable: true, authoritative: true });
  assert.equal(moved.goto, 5, "live page 3: sheet 5");
  assert.deepEqual([handoff.sync.page, handoff.sync.livePage], [5, 3]);
  assert.notEqual(handoff.sync.viewportToken, "a:1");
  // a sheet before the chapter is the Build's own: left as it is
  const before = { sync: sync(2) };
  step(before, { ...complete, viewportToken: null }, { now: 0, presentable: true, authoritative: true });
  assert.deepEqual([before.sync.page, before.sync.livePage, before.sync.viewportToken], [2, undefined, "a:1"]);
});

test("a count the frame says is settled while canonical fails resolves a vanished page all the same", () => {
  const handoff = { sync: { ...sync(6), livePage: 4 }, stallMs: stall };
  const failing = frame({ pageCount: 10, syncPageCount: 8, livePageCount: 3, viewportToken: null,
    pageCountAuthoritative: false, pageCountSettled: true });
  assert.equal(step(handoff, failing, { now: 0, presentable: false, authoritative: false }).goto, 5);
  // not while pages still owe their layout
  const owed = { sync: { ...sync(6), livePage: 4 }, stallMs: stall };
  step(owed, { ...failing, pageCountSettled: false }, { now: 0, presentable: false, authoritative: false });
  assert.equal(owed.sync.livePage, 4);
});

test("an activation's handoff waits for a page a cold paper is still building, and lets go after a stall, without a reload", () => {
  const handoff = { sync: sync(28) };
  const opts = (now) => ({ now, presentable: true, authoritative: false, reloadAvailable: true });
  // the paper grows: no stall, nothing to send yet
  for (const [now, pageCount] of [[0, 3], [stall - 1, 6], [2 * stall - 2, 9]]) {
    assert.deepEqual(step(handoff, frame({ pageCount, ready: true, painted: true }), opts(now)),
      { done: false, goto: null, positioned: false, stalled: false, reload: false });
  }
  // nothing more for the stall time: the nearest page, under a token of its own, revealed
  // (audit/scratch r7 points.mjs: the first edit's handoff had no clock, the cover stayed)
  assert.deepEqual(step(handoff, frame({ pageCount: 9, ready: true, painted: true }), opts(3 * stall)),
    { done: true, goto: 9, positioned: false, stalled: true, reload: false });
  assert.equal(liveHandoffSyncFor(handoff, 9).viewportToken, "a:1@9");
});

// audit/scratch r7 points.mjs: page 10 asked, the paper settled at 5 and the
// frame acknowledged 5; the paper grew to 10 and 5's acknowledgement, under
// the same token, was taken for 10.
test("every page the handoff is sent to has a token of its own", () => {
  const handoff = { sync: sync(10) };
  const settled = frame({ pageCount: 5, pageCountSettled: true, ready: true, painted: true, presentationPending: false });
  const clamped = step(handoff, settled, { now: 0, presentable: true, authoritative: true });
  assert.equal(clamped.goto, 5);
  const sent = liveHandoffSyncFor(handoff, 5);
  assert.deepEqual([sent.page, sent.viewportToken, sent.y], [5, "a:1@5", 400]);
  assert.equal(handoff.sync.page, 10, "the place itself is kept");
  const at5 = { ...settled, page: 5, viewportToken: sent.viewportToken, tokenSheetShown: true, tokenPointShown: true };
  assert.equal(step(handoff, at5, { now: 1, presentable: true, authoritative: true }).done, true);
  // the paper grows to ten before the reveal: page 5's word does not answer for 10
  const grown = { ...at5, pageCount: 10 };
  assert.deepEqual(step(handoff, grown, { now: 2, presentable: true, authoritative: true }),
    { done: false, goto: 10, positioned: false, stalled: false, reload: false });
  assert.deepEqual([liveHandoffSyncFor(handoff, 10).viewportToken], ["a:1"]);
});

test("the reader's place is the frame's viewport centre, without a landing marker", () => {
  assert.deepEqual(liveReaderPlace({ page: 28, y: 512.25, paperPx: 640 }),
    { page: 28, x: 0, y: 512.25, blockY: 512.25, blockHeight: 0, marker: false });
  // a live page of an outer paper keeps the frame's own number for it
  assert.deepEqual(liveReaderPlace({ page: 6, livePage: 4, y: 10 }),
    { page: 6, x: 0, y: 10, blockY: 10, blockHeight: 0, marker: false, livePage: 4 });
  for (const center of [null, undefined, {}, { page: 0, y: 3 }, { page: 2.5, y: 3 }, { page: 2, y: -1 }, { page: 2, y: "x" }]) {
    assert.equal(liveReaderPlace(center), null, JSON.stringify(center));
  }
});

test("the toolbar keeps the reader's page while the cover stands where the reset put it", () => {
  const handoff = { sync: sync(29), coverScrollTop: 12_000 };
  // PDF.js reports its most visible page (29) while the cover settles: the live page (28) stays
  assert.equal(coverHoldsReaderPage(handoff, 12_000), true);
  assert.equal(coverHoldsReaderPage(handoff, 12_001.5), true);
  // the reader scrolls the cover: the toolbar follows it
  assert.equal(coverHoldsReaderPage(handoff, 12_400), false);
  assert.equal(coverHoldsReaderPage({ sync: sync(29) }, 12_000), false, "not a reset's cover");
  assert.equal(coverHoldsReaderPage(null, 0), false);
});

test("the cover is drawn as wide as the live paper, not at PDF.js's page width", () => {
  // A4-ish page: 595.28 pt is 793.7 CSS px at scale 1
  const unit = 595.28 * 96 / 72;
  // a wide pane: Live's paper is capped at 640 px (times zoom 1)
  assert.equal(Math.round(coverScaleFor(640, unit) * unit), 640);
  // zoomed to 130%: 832 px
  assert.equal(Math.round(coverScaleFor(832, unit) * unit), 832);
  assert.equal(coverScaleFor(undefined, unit), null);
  assert.equal(coverScaleFor(640, 0), null);
});

// The viewer's own reveal (Resources/web/pdf-viewer.js), run against
// snapshots: two animation frames lie between the snapshot that confirms the
// handoff and the stacking change, and the frame keeps posting meanwhile
// (audit/scratch boundaries.mjs).
test("the handoff holds until the reveal: a snapshot that loses the point calls the staged reveal off", () => {
  const vm = require("node:vm");
  const host = fs.readFileSync(require.resolve("../Resources/web/pdf-viewer.js"), "utf8");
  const span = (a, b) => host.slice(host.indexOf(a), host.indexOf(b, host.indexOf(a) + a.length));
  const frames = [];
  const noop = () => {};
  const state = vm.createContext({
    stepLiveViewportHandoff: step, liveHandoffSyncFor, performance: { now: () => 0 }, postLive: noop, reloadLiveFrame: noop,
    liveFrame: { dataset: {}, setAttribute: noop }, liveActivation: { id: "a", pendingDocumentEpoch: 3 },
    liveRevealSequence: 0, liveViewportHandoff: { sync: { page: 4, viewportToken: "abc" } }, liveViewportCenter: null,
    isLivePending: () => true, requestAnimationFrame: (fn) => frames.push(fn),
    livePaperPresentable: (d) => d.painted && d.ready, livePaperHasAuthoritativePageCount: () => true,
    renderLiveStatus: noop, renderLiveToolbar: noop, document: { body: { classList: { remove: noop, add: noop } } },
    setStatus: noop, pendingLiveSync: null, isFindOpen: () => false, bridge: null,
    // (no reset cover stands: the scale mode it overrode has nothing to give back)
    scaleModeBeforeCover: null, applyScaleMode: noop,
  });
  vm.runInContext(span("  const cancelLiveReveal =", "  const cancelLiveErrorSurface =") +
    span("  const liveViewportPositioned =", "  // After a Build") +
    span("  const activateLive =", "  // The static PDF stands in") + "\nthis.accept = activateLive;", state);
  const shown = { activationId: "a", documentEpoch: 3, page: 4, pageCount: 4, painted: true, ready: true,
    viewportToken: "abc", tokenSheetShown: true, viewportCenter: { page: 4, y: 300, paperPx: 600 } };
  state.accept(shown);
  frames.shift()();
  state.accept({ ...shown, tokenSheetShown: false });
  while (frames.length) frames.shift()();
  assert.notEqual(state.liveFrame.dataset.livePhase, "active", "not revealed off the point");
  assert.ok(state.liveViewportHandoff, "the handoff is kept");
  state.accept(shown);
  while (frames.length) frames.shift()();
  assert.equal(state.liveFrame.dataset.livePhase, "active");
  assert.equal(state.liveViewportHandoff, null, "ended at the reveal");
  assert.deepEqual(state.liveViewportCenter, shown.viewportCenter, "the reader's place from the reveal on");
});

// audit/scratch boundaries.mjs: after a Build, a frame still on source 2
// (three chapter pages) sent the reader from Build sheet 6 to sheet 5, and
// source 3, the revision the first edit became, had four.
test("after a Build only the expected revision's paper settles a shorter chapter", () => {
  const chapter = { from: 3, to: 6 };
  const handoff = { sync: sync(6) };
  const opts = (now) => ({ now, presentable: false, authoritative: false, expectedSrcRev: 3 });
  const stale = frame({ pageCount: 10, syncPageCount: 8, livePageCount: 3, chapter, srcRev: 2, pageCountSettled: true });
  assert.equal(step(handoff, stale, opts(0)).goto, 6, "the reader's sheet, not 5");
  assert.deepEqual([handoff.sync.page, handoff.sync.viewportToken], [6, "a:1"]);
  // source 3 has four chapter pages: sheet 6 is reached under the original token
  const current = frame({ pageCount: 10, syncPageCount: 8, livePageCount: 4, chapter, srcRev: 3, pageCountSettled: true,
    viewportToken: "a:1", tokenSheetShown: true, tokenPointShown: true, ready: true, painted: true, presentationPending: false });
  assert.deepEqual(step(handoff, current, { ...opts(1), presentable: true }),
    { done: true, goto: null, positioned: true, stalled: false, reload: false });
  // a settled shrink of the expected revision still resolves to the chapter's last page
  const shrunk = { sync: sync(6) };
  step(shrunk, { ...current, livePageCount: 3, viewportToken: null }, opts(2));
  assert.deepEqual([shrunk.sync.page, shrunk.sync.livePage], [5, 3]);
});

test("a shorter chapter resolves the reader's place without replacing it", () => {
  const chapter = { from: 3, to: 6 };
  const handoff = { sync: sync(6) };
  // settled at three chapter pages (no Build revision to wait for): sheet 5
  const three = frame({ pageCount: 10, syncPageCount: 8, livePageCount: 3, chapter, pageCountSettled: true });
  assert.equal(step(handoff, three, { now: 0, presentable: false, authoritative: false }).goto, 5);
  const clamped = handoff.sync.viewportToken;
  assert.notEqual(clamped, "a:1");
  // the frame acknowledges sheet 5, then the chapter has its fourth page again
  const four = frame({ pageCount: 10, syncPageCount: 8, livePageCount: 4, chapter, pageCountSettled: true,
    viewportToken: clamped, tokenSheetShown: true, tokenPointShown: true, ready: true, painted: true, presentationPending: false });
  const back = step(handoff, four, { now: 1, presentable: true, authoritative: false });
  assert.deepEqual(back, { done: false, goto: 6, positioned: false, stalled: false, reload: false },
    "sheet 6 again; sheet 5's acknowledgement does not count");
  assert.deepEqual([handoff.sync.page, handoff.sync.viewportToken], [6, "a:1"]);
});

// audit/scratch first-failure.mjs: the document's first canonical failed;
// the frame now calls its count settled, and the vanished sheet resolves at
// once instead of a stall, a reload and a wait for good.
test("after a first canonical failure a vanished sheet resolves without a stall", () => {
  const handoff = { sync: { ...sync(6), y: 300 }, stallMs: stall };
  const data = frame({ chapter: { from: 3, to: 6 }, syncPageCount: 8, livePageCount: 3, srcRev: 3, pageCountSettled: true,
    ready: true, painted: true, tokenSheetShown: false, viewportToken: null });
  const moved = step(handoff, data, { now: 0, presentable: true, authoritative: false, reloadAvailable: true });
  assert.deepEqual(moved, { done: false, goto: 5, positioned: false, stalled: false, reload: false }, "sheet 5 at once");
  // the frame stands there before any stall clock runs out
  const there = { ...data, viewportToken: handoff.sync.viewportToken, tokenSheetShown: true, tokenPointShown: true };
  assert.deepEqual(step(handoff, there, { now: 500, presentable: true, authoritative: false, reloadAvailable: true }),
    { done: true, goto: null, positioned: true, stalled: false, reload: false });
  // (without the settled count the place stays 6, the sheet that is gone)
  const unsettled = { sync: { ...sync(6), y: 300 }, stallMs: stall };
  assert.equal(step(unsettled, { ...data, pageCountSettled: false }, { now: 0, presentable: true, authoritative: false }).goto, 6);
});

// audit/scratch boundaries.mjs: the token proved only the sheet, so a centre
// that drifted from y=300 to y=500 on it still confirmed the handoff.
test("the frame's word on the acknowledged point decides over its word on the sheet", () => {
  const handoff = { sync: sync(5) };
  const drifted = frame({ page: 5, syncPage: 5, syncPageCount: 8, viewportToken: "a:1", tokenSheetShown: true,
    tokenPointShown: false, ready: true, painted: true, presentationPending: false });
  assert.deepEqual(step(handoff, drifted, { now: 0, presentable: true, authoritative: true }),
    { done: false, goto: 5, positioned: false, stalled: false, reload: false }, "sent to the point again");
  assert.equal(step(handoff, { ...drifted, tokenPointShown: true }, { now: 1, presentable: true, authoritative: true }).done, true);
  // a frame that reports only the sheet is taken at that
  const { tokenPointShown, ...older } = drifted;
  assert.equal(step({ sync: sync(5) }, older, { now: 2, presentable: true, authoritative: true }).done, true);
});
