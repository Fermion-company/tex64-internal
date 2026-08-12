import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyScene, validateScene } from "../Resources/web/app/pro-canvas/scene.js";
import { generateTikz } from "../Resources/web/app/pro-canvas/tikz-generate.js";
import { encodeFigureBlock, decodeFigureBlockAt } from "../Resources/web/app/pro-canvas/figure-codec.js";

const identity={tx:0,ty:0,rotate:0,sx:1,sy:1};
test("code objects emit verbatim or in a transformed scope",()=>{const scene=createEmptyScene();scene.objects=[{id:"c",type:"code",tikz:"  \\draw (0,0) -- (1,1);\n  \\fill (2,2) circle (1);",transform:identity}];let result=generateTikz(scene);assert.match(result.code,/  \\draw \(0,0\)/);assert.doesNotMatch(result.code,/begin\{scope\}/);scene.objects[0].transform={tx:4,ty:2,rotate:30,sx:2,sy:2};result=generateTikz(scene);assert.match(result.code,/\\begin\{scope\}\[shift=\{\(4,2\)\}, rotate=30, scale=2\]/);});
test("code arrows add arrows.meta",()=>{const scene=createEmptyScene();scene.objects=[{id:"c",type:"code",tikz:"\\draw[-{Stealth}] (0,0)--(1,1);",transform:identity}];assert.deepEqual(generateTikz(scene).requires,["arrows.meta"]);});
test("code validates and round trips",()=>{const scene=createEmptyScene();scene.objects=[{id:"c",type:"code",tikz:"\\draw (0,0);",transform:identity}];assert.ok(validateScene(scene));const block=encodeFigureBlock(scene),decoded=decodeFigureBlockAt(block.trimEnd().split("\n"),0);assert.deepEqual(decoded?.scene,scene);});
