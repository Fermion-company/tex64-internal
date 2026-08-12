import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyScene } from "../Resources/web/app/pro-canvas/scene.js";
import { decodeFigureBlockAt, encodeFigureBlock, fnv1a32, listFigureBlocks } from "../Resources/web/app/pro-canvas/figure-codec.js";

test("figure blocks round-trip their scene", () => {
  const scene = createEmptyScene();
  scene.objects.push({ id: "r", type: "rect", from: { x: 0, y: 0 }, to: { x: 2, y: 3 }, style: {} });
  const lines = encodeFigureBlock(scene).trimEnd().split("\n");
  assert.deepEqual(decodeFigureBlockAt(lines, lines.length - 1)?.scene, scene);
  assert.equal(decodeFigureBlockAt(lines, 0)?.detached, false);
});

test("figure blocks round-trip symbols and instances", () => {
  const scene = createEmptyScene();
  scene.symbols = [{ id: "s", name: "ornament", objects: [{ id: "r", type: "rect", from: { x: 0, y: 0 }, to: { x: 2, y: 3 }, style: {} }] }];
  scene.objects.push({ id: "i", type: "instance", symbol: "s", transform: { tx: 5, ty: 6, rotate: 0, sx: 1, sy: 1 }, style: {} });
  const lines = encodeFigureBlock(scene).trimEnd().split("\n");
  assert.deepEqual(decodeFigureBlockAt(lines, lines.length - 1)?.scene, scene);
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

test("listFigureBlocks finds two blocks separated by ordinary text", () => {
  const first = createEmptyScene();
  const second = createEmptyScene();
  second.objects.push({ id: "r", type: "rect", from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, style: {} });
  const lines = ["before", ...encodeFigureBlock(first).trimEnd().split("\n"), "between", ...encodeFigureBlock(second).trimEnd().split("\n"), "after"];
  const blocks = listFigureBlocks(lines);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => block.scene), [first, second]);
  assert.ok(blocks[1].startLine > blocks[0].endLine);
});

test("listFigureBlocks skips a broken header and continues scanning", () => {
  const valid = encodeFigureBlock(createEmptyScene()).trimEnd().split("\n");
  const blocks = listFigureBlocks(["%% tex64-figure v1 broken", "ordinary", ...valid]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startLine, 2);
});

test("listFigureBlocks reports detached blocks", () => {
  const lines = encodeFigureBlock(createEmptyScene()).trimEnd().split("\n");
  const begin = lines.findIndex((line) => line.startsWith("\\begin{tikzpicture}"));
  lines[begin] += " ";
  assert.equal(listFigureBlocks(lines)[0]?.detached, true);
});
