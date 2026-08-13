import test from "node:test";
import assert from "node:assert/strict";
import { cornerInstanceTransforms, mirrorInstanceTransform } from "../Resources/web/app/pro-canvas/canvas-math.js";

test("mirrorInstanceTransform mirrors absolute coordinates across the artboard", () => {
  assert.deepEqual(mirrorInstanceTransform(100), { tx: 100, ty: 0, rotate: 0, sx: -1, sy: 1 });
});

test("cornerInstanceTransforms places mirrored bounds at all four insets", () => {
  const bounds = { minX: 10, minY: 20, maxX: 30, maxY: 40 };
  const transforms = cornerInstanceTransforms(bounds, 100, 80, 5);
  assert.deepEqual(transforms, [
    { tx: -5, ty: -15, rotate: 0, sx: 1, sy: 1 },
    { tx: 105, ty: -15, rotate: 0, sx: -1, sy: 1 },
    { tx: -5, ty: 95, rotate: 0, sx: 1, sy: -1 },
    { tx: 105, ty: 95, rotate: 0, sx: -1, sy: -1 },
  ]);
  const transformedBounds = transforms.map((transform) => {
    const points = [
      { x: transform.tx + bounds.minX * transform.sx, y: transform.ty + bounds.minY * transform.sy },
      { x: transform.tx + bounds.maxX * transform.sx, y: transform.ty + bounds.maxY * transform.sy },
    ];
    return {
      minX: Math.min(...points.map((point) => point.x)),
      minY: Math.min(...points.map((point) => point.y)),
      maxX: Math.max(...points.map((point) => point.x)),
      maxY: Math.max(...points.map((point) => point.y)),
    };
  });
  assert.deepEqual(transformedBounds.map(({ minX, minY, maxX, maxY }) => [minX, minY, maxX, maxY]), [
    [5, 5, 25, 25], [75, 5, 95, 25], [5, 55, 25, 75], [75, 55, 95, 75],
  ]);
});
