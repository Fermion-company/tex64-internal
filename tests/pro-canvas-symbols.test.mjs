import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyScene, validateScene } from "../Resources/web/app/pro-canvas/scene.js";
import { samplePathPoints } from "../Resources/web/app/pro-canvas/canvas-math.js";
import { generateTikz } from "../Resources/web/app/pro-canvas/tikz-generate.js";

const transform = (overrides = {}) => ({ tx: 0, ty: 0, rotate: 0, sx: 1, sy: 1, ...overrides });
const symbol = (id, name) => ({ id, name, objects: [{ id: `${id}-r`, type: "rect", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, style: {} }] });

test("instances define used pics only and emit transforms", () => {
  const scene=createEmptyScene();scene.symbols=[symbol("s","ornament"),symbol("u","unused")];scene.objects.push({id:"i",type:"instance",symbol:"s",transform:transform({tx:4,ty:5,sx:-1}),style:{}});
  const code=generateTikz(scene).code;assert.match(code,/ornament\/\.pic=/);assert.doesNotMatch(code,/unused\/\.pic=/);assert.match(code,/\\pic\[shift=\{\(4,5\)\}, xscale=-1\] \{ornament\};/);
});

test("repeat emits aligned and unaligned foreach forms", () => {
  const scene=createEmptyScene();scene.symbols=[symbol("s","ornament")];const path={start:{x:0,y:0},segments:[{type:"line",to:{x:10,y:10}}]};scene.objects.push({id:"a",type:"repeat",symbol:"s",path,count:3,align:true,style:{}},{id:"b",type:"repeat",symbol:"s",path,count:2,align:false,style:{}});
  const code=generateTikz(scene).code;assert.match(code,/\\foreach \\p\/\\a in \{\(0,0\)\/45, \(5,5\)\/45, \(10,10\)\/45\}/);assert.match(code,/\\foreach \\p in \{\(0,0\), \(10,10\)\}/);
});

test("scene validation accepts symbols, dangling refs, and legacy scenes but rejects nested symbol instances", () => {
  const scene=createEmptyScene();scene.symbols=[symbol("s","ornament")];scene.objects.push({id:"i",type:"instance",symbol:"missing",transform:transform(),style:{}});assert.ok(validateScene(scene));assert.ok(validateScene(createEmptyScene()));
  scene.symbols[0].objects=[{id:"g",type:"group",transform:transform(),children:[{id:"i2",type:"instance",symbol:"s",transform:transform(),style:{}}]}];assert.equal(validateScene(scene),null);
});

test("samplePathPoints is arc-length uniform on a line", () => {
  assert.deepEqual(samplePathPoints({start:{x:0,y:0},segments:[{type:"line",to:{x:10,y:0}}]},3),[{point:{x:0,y:0},angleDeg:0},{point:{x:5,y:0},angleDeg:0},{point:{x:10,y:0},angleDeg:0}]);
});
