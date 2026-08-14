import test from "node:test";
import assert from "node:assert/strict";
import { sceneToScreen, screenToScene, snapToGrid, resizeHandlePoint, resizePoint, boundsAfterHandleDrag } from "../Resources/web/app/pro-canvas/canvas-math.js";

const view = { left: 10, top: 20, width: 400, height: 400, sceneWidth: 100, sceneHeight: 100, zoom: 1 };

test("scene and screen coordinates round-trip with an upward scene y axis", () => {
  assert.deepEqual(sceneToScreen({ x: 0, y: 0 }, view), { x: 10, y: 420 });
  assert.deepEqual(sceneToScreen({ x: 100, y: 100 }, view), { x: 410, y: 20 });
  const point = { x: 23.5, y: 71.25 };
  assert.deepEqual(screenToScene(sceneToScreen(point, view), view), point);
});

test("pan and zoom participate in both directions", () => {
  const transformed = { ...view, zoom: 2, panX: 15, panY: -10 };
  const point = { x: 40, y: 60 };
  const back = screenToScene(sceneToScreen(point, transformed), transformed);
  assert.ok(Math.abs(back.x - point.x) < 1e-9);
  assert.ok(Math.abs(back.y - point.y) < 1e-9);
});

test("grid snapping can be enabled or bypassed", () => {
  assert.deepEqual(snapToGrid({ x: 12.6, y: -7.4 }, 5), { x: 15, y: -5 });
  assert.deepEqual(snapToGrid({ x: 12.6, y: -7.4 }, 5, false), { x: 12.6, y: -7.4 });
});

test("磁石式の吸着は格子の近くだけ引き寄せ、軸ごとに独立して効く", () => {
  // 5mm グリッド・pull .25 なら、格子から 1.25mm 以内だけ吸い付く。
  assert.deepEqual(snapToGrid({ x: 11, y: 12.6 }, 5, true, 0.25), { x: 10, y: 12.6 });
  assert.deepEqual(snapToGrid({ x: 13.75, y: 16.25 }, 5, true, 0.25), { x: 15, y: 15 });
  // 既定（pull 1）は今まで通り常に最寄りの格子へ。
  assert.deepEqual(snapToGrid({ x: 12.6, y: -7.4 }, 5, true, 1), { x: 15, y: -5 });
});

test("resize handles and affine point resize use scene coordinates", () => {
  const bounds = { minX: 10, minY: 20, maxX: 30, maxY: 60 };
  assert.deepEqual(resizeHandlePoint(bounds, "ne"), { x: 30, y: 60 });
  assert.deepEqual(resizeHandlePoint(bounds, "w"), { x: 10, y: 40 });
  assert.deepEqual(resizePoint({ x: 20, y: 40 }, bounds, { minX: 0, minY: 0, maxX: 40, maxY: 80 }), { x: 20, y: 40 });
  assert.deepEqual(boundsAfterHandleDrag(bounds, "se", { x: 50, y: 5 }), { minX: 10, minY: 5, maxX: 50, maxY: 60 });
});
