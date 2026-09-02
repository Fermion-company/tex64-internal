import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeLiveToolbarSnapshot,
  stepLiveToolbarPage,
} from "../Resources/web/pdf-live-toolbar-state.mjs";

test("live PDF toolbar clamps page navigation to the reported page count", () => {
  assert.deepEqual(
    normalizeLiveToolbarSnapshot({}, { pageCount: 2, page: 9, zoom: 1.25 }),
    { pageCount: 2, page: 2, zoom: 1.25 }
  );
});

test("live PDF toolbar accepts partial snapshots without losing prior state", () => {
  const current = { pageCount: 3, page: 2, zoom: 1.1 };
  assert.deepEqual(normalizeLiveToolbarSnapshot(current, { zoom: 0.8 }), {
    pageCount: 3,
    page: 2,
    zoom: 0.8,
  });
});

test("live PDF toolbar resets to a safe empty state", () => {
  assert.deepEqual(normalizeLiveToolbarSnapshot(), {
    pageCount: 0,
    page: 1,
    zoom: 1,
  });
});

test("live PDF toolbar advances immediately and clamps repeated page clicks", () => {
  const start = { pageCount: 4, page: 2, zoom: 1 };
  assert.deepEqual(stepLiveToolbarPage(start, 1), {
    pageCount: 4,
    page: 3,
    zoom: 1,
  });
  assert.deepEqual(stepLiveToolbarPage(start, -9), {
    pageCount: 4,
    page: 1,
    zoom: 1,
  });
  assert.deepEqual(stepLiveToolbarPage(start, 9), {
    pageCount: 4,
    page: 4,
    zoom: 1,
  });
});

