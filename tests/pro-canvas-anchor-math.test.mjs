import test from "node:test";
import assert from "node:assert/strict";
import { toggleSegmentKind } from "../Resources/web/app/pro-canvas/canvas-math.js";

test("toggleSegmentKind converts a line to a cubic with controls at thirds", () => {
  const path = { start: { x: 0, y: 3 }, segments: [{ type: "line", to: { x: 9, y: 6 } }] };
  toggleSegmentKind(path, 1);
  assert.deepEqual(path.segments[0], {
    type: "cubic", c1: { x: 3, y: 4 }, c2: { x: 6, y: 5 }, to: { x: 9, y: 6 },
  });
});

test("toggleSegmentKind converts a cubic to a line and discards controls", () => {
  const path = { start: { x: 0, y: 0 }, segments: [{ type: "cubic", c1: { x: 1, y: 4 }, c2: { x: 8, y: 4 }, to: { x: 9, y: 0 } }] };
  toggleSegmentKind(path, 1);
  assert.deepEqual(path.segments[0], { type: "line", to: { x: 9, y: 0 } });
});

test("toggleSegmentKind ignores the start anchor", () => {
  const path = { start: { x: 1, y: 2 }, segments: [{ type: "line", to: { x: 4, y: 5 } }] };
  const before = structuredClone(path);
  toggleSegmentKind(path, 0);
  assert.deepEqual(path, before);
});
