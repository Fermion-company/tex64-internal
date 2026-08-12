import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyScene } from "../Resources/web/app/pro-canvas/scene.js";
import { decodeFigureBlockAt, encodeFigureBlock, fnv1a32 } from "../Resources/web/app/pro-canvas/figure-codec.js";

test("figure blocks round-trip their scene", () => {
  const scene = createEmptyScene();
  scene.objects.push({ id: "r", type: "rect", from: { x: 0, y: 0 }, to: { x: 2, y: 3 }, style: {} });
  const lines = encodeFigureBlock(scene).trimEnd().split("\n");
  assert.deepEqual(decodeFigureBlockAt(lines, lines.length - 1)?.scene, scene);
  assert.equal(decodeFigureBlockAt(lines, 0)?.detached, false);
});

test("editing a body line marks the block detached", () => {
  const lines = encodeFigureBlock(createEmptyScene()).trimEnd().split("\n");
  const begin = lines.findIndex((line) => line.startsWith("\\begin{tikzpicture}"));
  lines[begin] += " ";
  assert.equal(decodeFigureBlockAt(lines, begin)?.detached, true);
});

test("editing a definecolor line marks the block detached", () => {
  const scene = createEmptyScene();
  scene.objects.push({ id: "r", type: "rect", from: { x: 0, y: 0 }, to: { x: 2, y: 3 }, style: { props: { fill: "#3a7bd5" } } });
  const lines = encodeFigureBlock(scene).trimEnd().split("\n");
  const definecolor = lines.findIndex((line) => line.startsWith("\\definecolor"));
  assert.notEqual(definecolor, -1);
  lines[definecolor] = lines[definecolor].replace("3A7BD5", "3A7BD6");
  assert.equal(decodeFigureBlockAt(lines, definecolor)?.detached, true);
});

test("cursor outside a block returns null", () => {
  const lines = [...encodeFigureBlock(createEmptyScene()).trimEnd().split("\n"), "outside"];
  assert.equal(decodeFigureBlockAt(lines, lines.length - 1), null);
});

test("broken base64 returns null", () => {
  const lines = encodeFigureBlock(createEmptyScene()).trimEnd().split("\n");
  const chunk = lines.findIndex((line) => line.startsWith("%% tex64-figure+"));
  lines[chunk] = "%% tex64-figure+ !!!";
  assert.equal(decodeFigureBlockAt(lines, chunk), null);
});

test("fnv1a32 has the standard empty-string value", () => {
  assert.equal(fnv1a32(""), "811c9dc5");
});
