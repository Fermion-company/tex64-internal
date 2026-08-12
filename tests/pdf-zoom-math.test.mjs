import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateZoomChange,
  clampZoomScale,
  wheelDeltaToZoomFactor,
} from "../Resources/web/pdf-zoom-math.mjs";

test("PDF zoom scale is clamped to viewer limits", () => {
  assert.equal(clampZoomScale(0.2, 0.4, 3), 0.4);
  assert.equal(clampZoomScale(4, 0.4, 3), 3);
  assert.equal(clampZoomScale(1.25, 0.4, 3), 1.25);
});

test("PDF zoom change returns the effective factor after clamping", () => {
  assert.deepEqual(calculateZoomChange(2.9, 2, 0.4, 3), {
    scale: 3,
    scaleFactor: 3 / 2.9,
  });
  assert.deepEqual(calculateZoomChange(0.5, 0.5, 0.4, 3), {
    scale: 0.4,
    scaleFactor: 0.8,
  });
});

test("wheel zoom is smooth, bounded per event, and directionally correct", () => {
  assert.equal(wheelDeltaToZoomFactor(0), 1);
  assert.ok(wheelDeltaToZoomFactor(-2) > 1);
  assert.ok(wheelDeltaToZoomFactor(2) < 1);
  assert.equal(wheelDeltaToZoomFactor(-1000), 1.06);
  assert.equal(wheelDeltaToZoomFactor(1000), 0.94);
});
