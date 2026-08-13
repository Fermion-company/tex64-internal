import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyScene } from "../Resources/web/app/pro-canvas/scene.js";
import { generateTikz } from "../Resources/web/app/pro-canvas/tikz-generate.js";

const rect = (style = {}) => ({ id: "r", type: "rect", from: { x: 1.23456, y: 2.0 }, to: { x: 4, y: 5 }, style });

test("empty mm scene emits only an optioned tikzpicture", () => {
  assert.equal(generateTikz(createEmptyScene()).code, "\\begin{tikzpicture}[x=1mm, y=1mm]\n\\end{tikzpicture}");
});

test("rect uses a named style and rounds coordinates", () => {
  const scene = createEmptyScene();
  scene.styles.push({ name: "outline", props: { draw: "#000000" } });
  scene.objects.push(rect({ ref: "outline" }));
  const code = generateTikz(scene).code;
  assert.match(code, /outline\/\.style=\{draw=black\}/);
  assert.match(code, /\\draw\[outline\] \(1\.235,2\) rectangle \(4,5\);/);
});

test("custom colors are defined once and black uses its basic name", () => {
  const scene = createEmptyScene();
  scene.styles.push({ name: "colors", props: { draw: "#000000", fill: "#3a7bd5" } });
  scene.objects.push(rect({ ref: "colors", props: { fill: "#3a7bd5" } }));
  const code = generateTikz(scene).code;
  assert.match(code, /draw=black/);
  assert.equal((code.match(/\\definecolor\{t643A7BD5\}/g) || []).length, 1);
});

test("arrows add TikZ syntax, requirement metadata, and comment", () => {
  const scene = createEmptyScene();
  scene.objects.push({ id: "p", type: "path", start: { x: 0, y: 0 }, segments: [{ type: "line", to: { x: 1, y: 1 } }], closed: false, style: { props: { arrowEnd: "Stealth" } } });
  const result = generateTikz(scene);
  assert.deepEqual(result.requires, ["arrows.meta"]);
  assert.match(result.code, /^% requires \\usetikzlibrary\{arrows\.meta\}/);
  assert.match(result.code, /\\draw\[-\{Stealth\}\]/);
});

test("closed paths end with -- cycle", () => {
  const scene = createEmptyScene();
  scene.objects.push({ id: "p", type: "path", start: { x: 0, y: 0 }, segments: [{ type: "line", to: { x: 1, y: 1 } }], closed: true, style: {} });
  assert.match(generateTikz(scene).code, /-- cycle;/);
});

test("groups emit non-identity transforms and elide identity scopes", () => {
  const scene = createEmptyScene();
  scene.objects.push({ id: "g", type: "group", transform: { tx: 10, ty: 5, rotate: 45, sx: 1, sy: 1 }, children: [rect()] });
  scene.objects.push({ id: "i", type: "group", transform: { tx: 0, ty: 0, rotate: 0, sx: 1, sy: 1 }, children: [rect()] });
  const code = generateTikz(scene).code;
  assert.match(code, /\\begin\{scope\}\[shift=\{\(10,5\)\}, rotate=45\]/);
  assert.equal((code.match(/\\begin\{scope\}/g) || []).length, 1);
});

test("fill-only and fill-plus-draw select fill and filldraw", () => {
  const scene = createEmptyScene();
  scene.objects.push(rect({ props: { draw: null, fill: "#ff0000" } }));
  scene.objects.push({ ...rect({ props: { draw: "#0000ff", fill: "#ff0000" } }), id: "r2" });
  const code = generateTikz(scene).code;
  assert.match(code, /\\fill\[fill=red\]/);
  assert.match(code, /\\filldraw\[draw=blue, fill=red\]/);
});
