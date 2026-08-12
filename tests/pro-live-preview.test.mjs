import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFullReplacementEdit,
  createDebouncedTask,
} from "../Resources/web/app/pro-live-preview.js";

test("live preview builds the fermion /edit full replacement payload", () => {
  assert.deepEqual(buildFullReplacementEdit("old source", "new source"), {
    start: 0,
    end: 10,
    text: "new source",
  });
});

test("live preview debounce coalesces rapid edits", async () => {
  let calls = 0;
  const schedule = createDebouncedTask(() => { calls += 1; }, 20);
  schedule();
  schedule();
  schedule();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1);
});
