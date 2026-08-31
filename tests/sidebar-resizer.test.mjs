import test from "node:test";
import assert from "node:assert/strict";

import { resolveSidebarDragLayout } from "../Resources/web/app/sidebar-resizer-ui.js";

test("sidebar drag collapses only near the left window edge", () => {
  assert.deepEqual(resolveSidebarDragLayout(100, 1200), {
    width: 0,
    collapse: true,
  });
  assert.deepEqual(resolveSidebarDragLayout(200, 1200), {
    width: 240,
    collapse: false,
  });
  assert.deepEqual(resolveSidebarDragLayout(500, 1200), {
    width: 448,
    collapse: false,
  });
});

test("sidebar drag keeps enough room for the editor", () => {
  assert.deepEqual(resolveSidebarDragLayout(1190, 1200), {
    width: 828,
    collapse: false,
  });
});
