import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEmptyScene, validateScene } from "../Resources/web/app/pro-canvas/scene.js";
import { generateTikz } from "../Resources/web/app/pro-canvas/tikz-generate.js";

const rect = props => ({ id:"r", type:"rect", from:{x:0,y:0}, to:{x:10,y:10}, style:{props} });
const withStyle = props => { const scene=createEmptyScene(); scene.objects.push(rect(props)); return scene; };
const emitted = scene => [generateTikz(scene).code];

test("validateScene accepts valid patterns and shading",()=>{for(const props of [{pattern:{name:"north east lines",color:"#dc2626"}},{shading:{kind:"axis",top:"#ffffff",bottom:"#000000",angle:45}},{shading:{kind:"radial",inner:"#ffffff",outer:"#000000"}}])assert.ok(validateScene(withStyle(props)));});
test("validateScene rejects malformed patterns and shading",()=>{assert.equal(validateScene(withStyle({pattern:{name:"waves"}})),null);assert.equal(validateScene(withStyle({shading:{kind:"axis",top:"#fff",bottom:"#000",angle:Infinity}})),null);assert.equal(validateScene(withStyle({shading:{kind:"radial",inner:"#fff",outer:"#000",top:"#fff"}})),null);});

test("pattern emits library, color, and preserves fill ordering",()=>{const scene=withStyle({fill:"#ffffff",pattern:{name:"north east lines",color:"#dc2626"}}),generated=generateTikz(scene);assert.deepEqual(generated.requires,["patterns"]);for(const code of emitted(scene)){assert.match(code,/usetikzlibrary\{patterns\}/);assert.match(code,/pattern=north east lines/);assert.match(code,/pattern color=t64DC2626/);assert.ok(code.indexOf("fill=white")<code.indexOf("pattern=north east lines"));}});
test("axis shading uses draw or shade commands",()=>{for(const draw of ["#000000",null]){const scene=withStyle({draw,fill:"#dc2626",shading:{kind:"axis",top:"#ffffff",bottom:"#2563eb",angle:45}});for(const code of emitted(scene)){assert.match(code,draw===null?/\\shade\[/:/\\draw\[/);assert.match(code,/shade, top color=white, bottom color=t642563EB, shading angle=45/);assert.doesNotMatch(code,/fill=t64DC2626/);}}});
test("radial shading emits inner and outer colors",()=>{const scene=withStyle({shading:{kind:"radial",inner:"#ffffff",outer:"#000000"}});for(const code of emitted(scene))assert.match(code,/shade, inner color=white, outer color=black/);});
test("arrow syntax remains arrows.meta compatible",()=>{const scene=createEmptyScene();scene.objects.push({id:"p",type:"path",start:{x:0,y:0},segments:[{type:"line",to:{x:1,y:0}}],closed:false,style:{props:{arrowStart:"Stealth"}}});for(const code of emitted(scene))assert.match(code,/\{Stealth\}-/);});

test("dash spacing validates and emits an exact TikZ dash pattern",()=>{
  const dashed=withStyle({dash:"dashed",dashGapPt:7.5,lineWidthPt:0.5});
  assert.ok(validateScene(dashed));
  assert.match(generateTikz(dashed).code,/dash pattern=on 2pt off 7\.5pt/);
  const dotted=withStyle({dash:"dotted",dashGapPt:3});
  assert.match(generateTikz(dotted).code,/dash pattern=on 0pt off 3pt, line cap=round/);
  assert.equal(validateScene(withStyle({dash:"dashed",dashGapPt:-1})),null);
});

test("dash spacing is exposed in the selected-object inspector",()=>{
  const source=readFileSync(new URL("../web-src/app/pro-canvas/canvas-ui.ts",import.meta.url),"utf8");
  assert.match(source,/pro-canvas-dash-gap/);
  assert.match(source,/dashGapPt=value/);
});
