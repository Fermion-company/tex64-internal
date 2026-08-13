import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyScene, validateScene } from "../Resources/web/app/pro-canvas/scene.js";
import { generateTikz } from "../Resources/web/app/pro-canvas/tikz-generate.js";
import { buildStyFile } from "../Resources/web/app/pro-canvas/sty-export.js";

const line = (id, props = {}) => ({ id, type: "path", start: { x: 0, y: 0 }, segments: [{ type: "line", to: { x: 1, y: 1 } }], closed: false, style: { props } });

test("double distance is emitted for named and object styles", () => {
  const scene = createEmptyScene();
  scene.styles.push({ name: "rail", props: { doubleDistancePt: 1.2 } });
  scene.objects.push(line("direct", { doubleDistancePt: 1.2 }));
  const code = generateTikz(scene).code;
  assert.match(code, /rail\/\.style=\{double, double distance=1\.2pt\}/);
  assert.match(code, /\\draw\[double, double distance=1\.2pt\]/);
  assert.match(buildStyFile(scene, "rails"), /double, double distance=1\.2pt/);
});

test("zero and omitted double distances do not change output", () => {
  const omitted = createEmptyScene();
  omitted.objects.push(line("line"));
  const zero = structuredClone(omitted);
  zero.objects[0].style.props.doubleDistancePt = 0;
  assert.equal(generateTikz(zero).code, generateTikz(omitted).code);
  assert.equal(buildStyFile(zero, "same"), buildStyFile(omitted, "same"));
  assert.doesNotMatch(generateTikz(zero).code, /double/);
});

test("validateScene rejects negative double distances", () => {
  const scene = createEmptyScene();
  scene.objects.push(line("bad", { doubleDistancePt: -0.1 }));
  assert.equal(validateScene(scene), null);
});
