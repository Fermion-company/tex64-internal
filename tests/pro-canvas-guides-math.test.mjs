import test from "node:test";
import assert from "node:assert/strict";
import { alignDeltas, collectSnapLines, distributeDeltas, snapBoundsToLines } from "../Resources/web/app/pro-canvas/canvas-math.js";

const b = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY });

test("collectSnapLines includes object and artboard min/center/max lines", () => {
  const lines = collectSnapLines([b(10, 20, 30, 40)], { width: 100, height: 80 });
  assert.deepEqual(lines.x.slice(-3), [{ value: 0, kind: "min" }, { value: 50, kind: "center" }, { value: 100, kind: "max" }]);
  assert.deepEqual(lines.y.slice(-3), [{ value: 0, kind: "min" }, { value: 40, kind: "center" }, { value: 80, kind: "max" }]);
});

test("snapBoundsToLines handles threshold, center tie break, and axes independently", () => {
  const bounds = b(10, 10, 20, 20);
  assert.deepEqual(snapBoundsToLines(bounds, { x: [{ value: 21, kind: "max" }], y: [] }, 1), { dx: 1, dy: 0, guides: { x: 21 } });
  assert.deepEqual(snapBoundsToLines(bounds, { x: [{ value: 21.01, kind: "max" }], y: [] }, 1), { dx: 0, dy: 0, guides: {} });
  const tie = snapBoundsToLines(bounds, { x: [{ value: 9, kind: "min" }, { value: 16, kind: "center" }], y: [{ value: 22, kind: "max" }] }, 2);
  assert.deepEqual(tie, { dx: 1, dy: 2, guides: { x: 16, y: 22 } });
});

test("alignDeltas supports all six aggregate-bounds modes", () => {
  const bounds = [b(0, 0, 10, 10), b(20, 30, 40, 50)];
  assert.deepEqual(alignDeltas(bounds, "left"), [{ x: 0, y: 0 }, { x: -20, y: 0 }]);
  assert.deepEqual(alignDeltas(bounds, "centerX"), [{ x: 15, y: 0 }, { x: -10, y: 0 }]);
  assert.deepEqual(alignDeltas(bounds, "right"), [{ x: 30, y: 0 }, { x: 0, y: 0 }]);
  assert.deepEqual(alignDeltas(bounds, "top"), [{ x: 0, y: 40 }, { x: 0, y: 0 }]);
  assert.deepEqual(alignDeltas(bounds, "centerY"), [{ x: 0, y: 20 }, { x: 0, y: -15 }]);
  assert.deepEqual(alignDeltas(bounds, "bottom"), [{ x: 0, y: 0 }, { x: 0, y: -30 }]);
});

test("distributeDeltas spaces three objects, fixes endpoints, and zeros two", () => {
  assert.deepEqual(distributeDeltas([b(0, 0, 10, 10), b(12, 0, 22, 10), b(40, 0, 50, 10)], "x"), [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 0, y: 0 }]);
  assert.deepEqual(distributeDeltas([b(0, 0, 10, 10), b(20, 20, 30, 30)], "y"), [{ x: 0, y: 0 }, { x: 0, y: 0 }]);
});
