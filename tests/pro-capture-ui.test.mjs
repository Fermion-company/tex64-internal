import test from "node:test";
import assert from "node:assert/strict";
import { buildIncludeGraphicsSnippet, chooseCaptureDirectory, mapSelectionToImagePixels, normalizeCaptureRect } from "../Resources/web/app/pro-capture-ui.js";

test("capture rectangles normalize reverse drags", () => {
  assert.deepEqual(normalizeCaptureRect(40, 30, 10, 5), { x: 10, y: 5, width: 30, height: 25 });
});

test("selection maps through a contained image and clips letterboxing", () => {
  assert.deepEqual(mapSelectionToImagePixels({ x: 0, y: 20, width: 200, height: 60 }, { x: 0, y: 0, width: 200, height: 100 }, 100, 100), { x: 0, y: 20, width: 100, height: 60 });
  assert.equal(mapSelectionToImagePixels({ x: 0, y: 0, width: 20, height: 100 }, { x: 0, y: 0, width: 200, height: 100 }, 100, 100), null);
});

test("capture directory follows project convention and defaults to assets", () => {
  assert.equal(chooseCaptureDirectory(["src/main.tex", "figures/plot.pdf"]), "figures");
  assert.equal(chooseCaptureDirectory(["main.tex"]), "assets");
});

test("includegraphics can be wrapped in a figure", () => {
  assert.equal(buildIncludeGraphicsSnippet("assets/a.png", false), "\\includegraphics[width=0.8\\linewidth]{assets/a.png}\n");
  assert.match(buildIncludeGraphicsSnippet("figures/a.png", true), /\\begin\{figure\}[\s\S]*\\centering[\s\S]*\\end\{figure\}/);
});
