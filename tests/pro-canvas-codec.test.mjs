import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyScene } from "../Resources/web/app/pro-canvas/scene.js";
import { decodeFigureBlockAt, encodeFigureBlock, fnv1a32, lzssCompress, lzssDecompress } from "../Resources/web/app/pro-canvas/figure-codec.js";

/** 旧形式（v1）のブロック。後方互換の回帰用に固定文字列で持つ。 */
const v1Block = [
  "%% tex64-figure v1 h=5be9bfb7",
  "%% tex64-figure+ eyJ2IjoxLCJ1bml0IjoibW0iLCJ3aWR0aCI6MTAwLCJoZWlnaHQiOjEwMCwiZ3JpZCI6eyJzaXplIjo1LCJzbmFwIjp0cnVlfSwi",
  "%% tex64-figure+ c3R5bGVzIjpbXSwib2JqZWN0cyI6W3siaWQiOiJyIiwidHlwZSI6InJlY3QiLCJmcm9tIjp7IngiOjAsInkiOjB9LCJ0byI6eyJ4",
  "%% tex64-figure+ IjoyLCJ5IjozfSwic3R5bGUiOnt9fV19",
  "\\begin{tikzpicture}[x=1mm, y=1mm]",
  "  \\draw (0,0) rectangle (2,3);",
  "\\end{tikzpicture}",
];

const curveScene = (count) => {
  const scene = createEmptyScene(), segments = [], r6 = (value) => Math.round(value * 1e6) / 1e6;
  let x = 1, y = 1;
  for (let i = 0; i < count; i++) {
    const nx = r6(x + 0.73 + Math.sin(i) * 0.4), ny = r6(y + Math.cos(i * 1.3) * 0.9);
    segments.push({ type: "cubic", c1: { x: r6(x + 0.2), y: r6(y + 0.31) }, c2: { x: r6(nx - 0.24), y: r6(ny - 0.11) }, to: { x: nx, y: ny } });
    x = nx; y = ny;
  }
  scene.objects.push({ id: "p", type: "path", style: { props: {} }, start: { x: 1, y: 1 }, segments, closed: false });
  return scene;
};

test("figure blocks round-trip their scene", () => {
  const scene = createEmptyScene();
  scene.objects.push({ id: "r", type: "rect", from: { x: 0, y: 0 }, to: { x: 2, y: 3 }, style: {} });
  const lines = encodeFigureBlock(scene).trimEnd().split("\n");
  assert.deepEqual(decodeFigureBlockAt(lines, lines.length - 1)?.scene, scene);
  assert.equal(decodeFigureBlockAt(lines, 0)?.detached, false);
});

test("relative-width figure blocks include and decode their resizebox wrapper", () => {
  const scene=createEmptyScene();
  scene.outputWidth={mode:"relative",value:.75,reference:"textwidth"};
  const lines=encodeFigureBlock(scene).trimEnd().split("\n");
  assert.match(lines[1],/^\\resizebox\{0\.75\\textwidth\}/);
  assert.equal(lines.at(-1),"}");
  const decoded=decodeFigureBlockAt(lines,lines.length-1);
  assert.deepEqual(decoded?.scene,scene);
  assert.equal(decoded?.endLine,lines.length-1);
  assert.equal(decoded?.detached,false);
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

test("broken payload returns null", () => {
  const lines = encodeFigureBlock(createEmptyScene()).trimEnd().split("\n");
  lines[0] = `${lines[0].slice(0, -8)}!!!!`;
  assert.equal(decodeFigureBlockAt(lines, 0), null);
});

test("fnv1a32 has the standard empty-string value", () => {
  assert.equal(fnv1a32(""), "811c9dc5");
});

test("a figure carries exactly one comment line, however long the curve", () => {
  for (const count of [1, 8, 40, 120]) {
    const comments = encodeFigureBlock(curveScene(count)).split("\n").filter((line) => line.startsWith("%"));
    assert.equal(comments.length, 1, `${count} セグメントで ${comments.length} 行`);
  }
});

test("a long curve round-trips through the one-line payload", () => {
  const scene = curveScene(40), lines = encodeFigureBlock(scene).trimEnd().split("\n");
  const decoded = decodeFigureBlockAt(lines, lines.length - 1);
  assert.deepEqual(decoded?.scene, scene);
  assert.equal(decoded?.detached, false);
});

test("the inserted block carries no % requires line", () => {
  const scene = createEmptyScene();
  scene.objects.push({ id: "p", type: "path", style: { props: { arrowEnd: "Stealth" } }, start: { x: 0, y: 0 }, segments: [{ type: "line", to: { x: 3, y: 2 } }], closed: false });
  assert.doesNotMatch(encodeFigureBlock(scene), /^% requires/m);
});

test("v1 blocks still decode", () => {
  const decoded = decodeFigureBlockAt(v1Block, 5);
  assert.equal(decoded?.scene.objects[0].type, "rect");
  assert.equal(decoded?.detached, false);
});

test("lzss round-trips text, bytes, and degenerate inputs", () => {
  const roundTrip = (bytes) => assert.deepEqual([...lzssDecompress(lzssCompress(bytes))], [...bytes]);
  roundTrip(new Uint8Array(0));
  roundTrip(Uint8Array.of(65));
  roundTrip(new Uint8Array(5000).fill(97));
  roundTrip(new TextEncoder().encode(JSON.stringify(curveScene(40))));
  let seed = 12345;
  roundTrip(Uint8Array.from({ length: 4096 }, () => (seed = (seed * 1103515245 + 12345) % 2147483648) >> 16 & 255));
});
