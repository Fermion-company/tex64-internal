import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEmptyScene, validateScene } from "../Resources/web/app/pro-canvas/scene.js";
import { nodeEditorWidthPx, nodeFontOption } from "../Resources/web/app/pro-canvas/label-style.js";
import { generateTikz } from "../Resources/web/app/pro-canvas/tikz-generate.js";

const label = overrides => ({ id:"n", type:"node", at:{x:2,y:3}, latex:"$x$", anchor:"center", style:{}, ...overrides });

test("label font settings remain backward compatible and reject unknown values", () => {
  const oldScene=createEmptyScene();oldScene.objects.push(label({}));
  assert.ok(validateScene(oldScene));
  const styled=createEmptyScene();styled.objects.push(label({fontFamily:"sans",fontSize:"Large"}));
  assert.ok(validateScene(styled));
  const invalid=createEmptyScene();invalid.objects.push(label({fontFamily:"comic"}));
  assert.equal(validateScene(invalid),null);
});

test("label font settings emit only non-default TikZ font options", () => {
  assert.equal(nodeFontOption(),null);
  assert.equal(nodeFontOption("sans","Large"),"font={\\sffamily\\Large}");
  const plain=createEmptyScene();plain.objects.push(label({}));
  assert.doesNotMatch(generateTikz(plain).code,/font=/);
  const styled=createEmptyScene();styled.objects.push(label({fontFamily:"mono",fontSize:"small"}));
  assert.match(generateTikz(styled).code,/\\node\[font=\{\\ttfamily\\small\}\] at \(2,3\)/);
});

test("inline label editor width follows content and is clamped", () => {
  assert.equal(nodeEditorWidthPx("x"),44);
  assert.ok(nodeEditorWidthPx("x_1+x_2")>nodeEditorWidthPx("x"));
  assert.equal(nodeEditorWidthPx("a".repeat(100)),220);
});

test("canvas labels and their inline editor use the bundled math font", () => {
  const css=readFileSync(new URL("../Resources/web/theme.css",import.meta.url),"utf8");
  assert.match(css,/\.pro-canvas-node[^}]*KaTeX_Math/);
  assert.match(css,/\.pro-canvas-inline-editor[^}]*KaTeX_Math/);
});
