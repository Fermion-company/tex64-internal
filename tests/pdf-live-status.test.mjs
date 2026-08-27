import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePdfLiveStatus } from "../Resources/web/app/pdf-live-status.js";

test("the exact canonical path has a distinct visible status", () => {
  assert.deepEqual(resolvePdfLiveStatus({
    up: true,
    busy: true,
    mode: "opaque",
    srcRev: 4,
    canonical: { inFlight: true },
  }), { key: "liveExactRendering", tone: "busy", detail: "" });
  assert.deepEqual(resolvePdfLiveStatus({ up: true, busy: true }), {
    key: "liveUpdating", tone: "busy", detail: "",
  });
});

test("live errors and settled exact pages retain their prior meanings", () => {
  assert.deepEqual(resolvePdfLiveStatus({
    up: true,
    mode: "structured",
    srcRev: 8,
    canonical: { error: "Undefined control sequence", errorRev: 8 },
  }), { key: "liveError", tone: "error", detail: "Undefined control sequence" });
  assert.equal(resolvePdfLiveStatus({ up: true, mode: "opaque" })?.key, "liveFullCompile");
  assert.equal(resolvePdfLiveStatus({ up: false })?.key, "liveUnavailable");
});

test("the embedded PDF toolbar keeps exact progress visible", () => {
  const html = readFileSync(new URL("../Resources/web/pdf-viewer.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../Resources/web/pdf-viewer.css", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("../Resources/web/pdf-viewer.js", import.meta.url), "utf8");
  assert.match(html, /pdf-toolbar-status/);
  assert.match(css, /body\.is-embedded:is\(\.is-live, \.is-live-pending\) \.pdf-toolbar-status/);
  assert.match(css, /\.pdf-status\.is-busy::before/);
  assert.match(viewer, /ja: "差分を描画中…"/);
  assert.match(viewer, /resolvePdfLiveStatus\(data\?\.status\)/);
});
