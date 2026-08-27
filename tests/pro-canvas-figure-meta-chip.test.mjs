import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { figureMetaLineNumbers } from "../Resources/web/app/pro-canvas/figure-meta-chip.js";

test("figure metadata lines are found without changing the model",()=>{
  assert.deepEqual(figureMetaLineNumbers(["a","%% tex64-figure v2 h=deadbeef AAAA","b","%% tex64-figure v1 h=deadbeef"]),[2,4]);
});

test("metadata uses hidden areas and one fixed-height zone instead of display:none",()=>{
  const source=readFileSync(new URL("../web-src/app/pro-canvas/figure-meta-chip.ts",import.meta.url),"utf8");
  const css=readFileSync(new URL("../Resources/web/theme.css",import.meta.url),"utf8");
  assert.match(source,/setHiddenAreas/);
  assert.match(source,/changeViewZones/);
  assert.match(source,/heightInPx: 22/);
  assert.match(source,/tex64:pro-canvas-open/);
  assert.match(css,/\.view-zones:has\(\.tex64-figure-meta-zone\)[^}]*z-index:\s*10/);
  assert.doesNotMatch(css,/\.tex64-figure-meta\s*\{[^}]*display:\s*none/s);
});
