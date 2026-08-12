import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateAutoScrollDelta,
  calculateCaptureOutputSize,
  documentRectToViewportRect,
  viewportPointToDocumentPoint,
} from "../Resources/web/app/pdf-capture-math.js";

test("PDF capture coordinates follow scrolling in both directions", () => {
  const viewport = { left: 12, top: 44, scrollLeft: 30, scrollTop: 900 };
  assert.deepEqual(viewportPointToDocumentPoint({ x: 52, y: 144 }, viewport), { x: 70, y: 1000 });
  assert.deepEqual(documentRectToViewportRect({ x: 70, y: 1000, width: 80, height: 500 }, viewport), {
    x: 52, y: 144, width: 80, height: 500,
  });
});

test("auto-scroll accelerates near either viewport edge", () => {
  assert.equal(calculateAutoScrollDelta(250, 100, 300), 0);
  assert.equal(calculateAutoScrollDelta(100, 100, 300), -24);
  assert.equal(calculateAutoScrollDelta(400, 100, 300), 24);
  assert.equal(calculateAutoScrollDelta(124, 100, 300), -12);
  assert.equal(calculateAutoScrollDelta(376, 100, 300), 12);
});

test("capture output preserves aspect ratio and caps its long edge", () => {
  assert.deepEqual(calculateCaptureOutputSize(1000, 3000, 2, 8000), { width: 2000, height: 6000, scale: 2 });
  assert.deepEqual(calculateCaptureOutputSize(1000, 6000, 2, 8000), { width: 1333, height: 8000, scale: 4 / 3 });
  assert.equal(calculateCaptureOutputSize(0, 100, 2, 8000), null);
});
