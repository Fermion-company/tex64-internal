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

test("resize handles and affine point resize use scene coordinates", () => {
  const bounds = { minX: 10, minY: 20, maxX: 30, maxY: 60 };
  assert.deepEqual(resizeHandlePoint(bounds, "ne"), { x: 30, y: 60 });
  assert.deepEqual(resizeHandlePoint(bounds, "w"), { x: 10, y: 40 });
  assert.deepEqual(resizePoint({ x: 20, y: 40 }, bounds, { minX: 0, minY: 0, maxX: 40, maxY: 80 }), { x: 20, y: 40 });
  assert.deepEqual(boundsAfterHandleDrag(bounds, "se", { x: 50, y: 5 }), { minX: 10, minY: 5, maxX: 50, maxY: 60 });
});
