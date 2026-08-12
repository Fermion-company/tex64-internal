import assert from "node:assert/strict";
import test from "node:test";
import { buildStandaloneDoc } from "../Resources/web/app/pro-canvas/standalone.js";
import { createEmptyScene } from "../Resources/web/app/pro-canvas/scene.js";

test("buildStandaloneDoc wraps arrow scenes and fixes the bounding box", () => {
  const scene=createEmptyScene();
  scene.objects.push({id:"arrow",type:"path",start:{x:0,y:0},segments:[{type:"line",to:{x:10,y:10}}],closed:false,style:{props:{draw:"#000000",arrowEnd:"Stealth"}}});
  const doc=buildStandaloneDoc(scene), lines=doc.split("\n"), begin=lines.findIndex(line=>line.startsWith("\\begin{tikzpicture}"));
  assert.ok(doc.startsWith("\\documentclass[margin=0pt]{standalone}"));
  assert.ok(doc.endsWith("\\end{document}"));
  assert.match(doc,/\\usetikzlibrary\{arrows\.meta\}/);
  assert.doesNotMatch(doc,/% requires/);
  assert.equal(lines[begin+1],"  \\useasboundingbox (0,0) rectangle (100,100);");
});

test("buildStandaloneDoc omits an empty tikz library declaration", () => {
  const doc=buildStandaloneDoc(createEmptyScene());
  assert.doesNotMatch(doc,/\\usetikzlibrary/);
});
