import test from "node:test";
import assert from "node:assert/strict";
import { marqueeHits, screenToScene, zoomAtPoint } from "../Resources/web/app/pro-canvas/canvas-math.js";

test("zoomAtPoint preserves the scene point beneath the cursor", () => {
  const base = { left: 30, top: 40, width: 800, height: 600, sceneWidth: 100, sceneHeight: 80 };
  const oldView = { ...base, zoom: 1.25, panX: 17, panY: -9 };
  const cursor = { x: 567, y: 241 };
  const offset = { x: cursor.x - (base.left + base.width / 2), y: cursor.y - (base.top + base.height / 2) };
  const pan = zoomAtPoint(oldView, offset, 2.5);
  const newView = { ...base, zoom: 2.5, ...pan };
  const before = screenToScene(cursor, oldView);
  const after = screenToScene(cursor, newView);
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  assert.ok(Math.abs(before.y - after.y) < 1e-9);
});

test("marqueeHits includes intersections and touching boundaries", () => {
  const rect = { minX: 10, minY: 10, maxX: 20, maxY: 20 };
  const objects = [
    { id: "inside", bounds: { minX: 12, minY: 12, maxX: 14, maxY: 14 } },
    { id: "contains", bounds: { minX: 0, minY: 0, maxX: 30, maxY: 30 } },
    { id: "edge", bounds: { minX: 20, minY: 13, maxX: 25, maxY: 18 } },
    { id: "corner", bounds: { minX: 20, minY: 20, maxX: 25, maxY: 25 } },
    { id: "outside", bounds: { minX: 20.001, minY: 10, maxX: 25, maxY: 15 } },
  ];
  assert.deepEqual(marqueeHits(rect, objects), ["inside", "contains", "edge", "corner"]);
});

test("marqueeHits treats zero-area rectangles as valid intersect tests", () => {
  assert.deepEqual(marqueeHits(
    { minX: 5, minY: 5, maxX: 5, maxY: 5 },
    [
      { id: "hit", bounds: { minX: 5, minY: 5, maxX: 5, maxY: 5 } },
      { id: "miss", bounds: { minX: 5.1, minY: 5, maxX: 6, maxY: 6 } },
    ],
  ), ["hit"]);
});
