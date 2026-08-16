// ペンのクリック解釈（閉じる / 確定 / スキップ / 追加）の境界値を固定する。
// 判定は吸着前の生カーソル × 画面ピクセル — ズーム率や格子幅で「閉じやすさ」が
// 変わらないこと、吸着が判定に漏れないことがこのテストの主眼。
import assert from "node:assert/strict";
import test from "node:test";
import {
  PEN_CLOSE_PX,
  PEN_FINISH_PX,
  PEN_RESUME_PX,
  penClickAction,
} from "../Resources/web/app/pro-canvas/canvas-math.js";

const start = { x: 0, y: 0 };
const last = { x: 100, y: 0 };
const act = (rawPoint, snappedPoint, overrides = {}) =>
  penClickAction({ rawPoint, snappedPoint, start, last, scaleFactor: 1, segmentCount: 3, ...overrides });

test("radii form the intended hierarchy", () => {
  assert.ok(PEN_FINISH_PX < PEN_CLOSE_PX && PEN_CLOSE_PX < PEN_RESUME_PX);
});

test("close boundary is inclusive at 10 screen px, at two scale factors", () => {
  // scale 1: 1 artboard unit = 1 screen px
  assert.equal(act({ x: PEN_CLOSE_PX, y: 0 }, { x: PEN_CLOSE_PX, y: 0 }).action, "close");
  assert.equal(act({ x: PEN_CLOSE_PX + 0.01, y: 0 }, { x: PEN_CLOSE_PX + 0.01, y: 0 }).action, "add");
  // scale 4 (zoomed in): the same screen radius is a 4x smaller artboard distance
  assert.equal(act({ x: 2.5, y: 0 }, { x: 2.5, y: 0 }, { scaleFactor: 4 }).action, "close");
  assert.equal(act({ x: 2.6, y: 0 }, { x: 2.6, y: 0 }, { scaleFactor: 4 }).action, "add");
});

test("finish boundary is inclusive at 8 screen px, at two scale factors", () => {
  assert.equal(act({ x: 100 + PEN_FINISH_PX, y: 0 }, { x: 100 + PEN_FINISH_PX, y: 0 }).action, "finish");
  assert.equal(act({ x: 100 + PEN_FINISH_PX + 0.01, y: 0 }, { x: 100 + PEN_FINISH_PX + 0.01, y: 0 }).action, "add");
  assert.equal(act({ x: 102, y: 0 }, { x: 102, y: 0 }, { scaleFactor: 4 }).action, "finish");
  assert.equal(act({ x: 102.1, y: 0 }, { x: 102.1, y: 0 }, { scaleFactor: 4 }).action, "add");
});

test("close beats finish when both radii cover a short path", () => {
  const nearBoth = { x: 3, y: 0 };
  const result = penClickAction({
    rawPoint: nearBoth, snappedPoint: nearBoth,
    start: { x: 0, y: 0 }, last: { x: 6, y: 0 },
    scaleFactor: 1, segmentCount: 2,
  });
  assert.equal(result.action, "close");
});

test("close needs at least one committed segment", () => {
  assert.equal(act({ x: 1, y: 0 }, { x: 1, y: 0 }, { segmentCount: 0, last: null }).action, "add");
});

test("snap cannot trigger close or finish: the raw point decides", () => {
  // Raw click outside both radii; snap pulled the point inside / on top.
  // At 4x zoom the magnet capture range (grid*0.25) exceeds the gesture radii,
  // so this is a real situation, not a hypothetical.
  const raw = { x: 100 + 12, y: 0 }; // 12px from last, 112px from start
  assert.equal(act(raw, { x: 100 + 1, y: 0 }).action, "add"); // snapped near last but not equal
  const rawNearStart = { x: 12, y: 0 };
  assert.equal(act(rawNearStart, { x: 1, y: 0 }).action, "add"); // snapped near start
});

test("snapped point exactly on the last anchor skips instead of adding a zero-length segment", () => {
  const raw = { x: 100 + 12, y: 0 }; // outside the 8px finish radius
  assert.deepEqual(act(raw, { x: 100, y: 0 }), { action: "skip" });
});

test("snapped point exactly on the start (raw outside 10px) adds a plain anchor, no auto-close", () => {
  const raw = { x: 15, y: 0 }; // outside the 10px close radius
  const result = act(raw, { x: 0, y: 0 });
  assert.equal(result.action, "add");
  assert.deepEqual(result.point, { x: 0, y: 0 });
});

test("start and last coinciding: out-of-radius exact coincidence resolves to skip", () => {
  const p = { x: 0, y: 0 };
  const result = penClickAction({
    rawPoint: { x: 20, y: 0 }, snappedPoint: p,
    start: p, last: p, scaleFactor: 1, segmentCount: 1,
  });
  assert.deepEqual(result, { action: "skip" });
});

test("add returns the snapped point as a copy", () => {
  const snapped = { x: 40, y: 25 };
  const result = act({ x: 41, y: 26 }, snapped);
  assert.equal(result.action, "add");
  assert.deepEqual(result.point, snapped);
  assert.notEqual(result.point, snapped); // a copy, not the caller's object
});
