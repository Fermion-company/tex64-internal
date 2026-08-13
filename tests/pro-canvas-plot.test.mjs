import assert from "node:assert/strict";
import test from "node:test";
import { autoRange, compileExpr, niceTicks, samplePlot } from "../Resources/web/app/pro-canvas/plot-math.js";
import { createEmptyScene, validateScene } from "../Resources/web/app/pro-canvas/scene.js";
import { generateTikz } from "../Resources/web/app/pro-canvas/tikz-generate.js";
import { buildStandaloneDoc } from "../Resources/web/app/pro-canvas/standalone.js";

const plot=()=>({id:"plot",type:"plot",at:{x:10,y:15},width:60,height:40,axis:{xmin:-5,xmax:5,ymin:null,ymax:null,axisLines:"middle",grid:"none",xlabel:"",ylabel:"",title:""},series:[{expr:"x^2",domain:null,samples:100,color:"#000000",thick:true,legend:""}],style:{}});

test("plot expressions implement pgf-compatible precedence and degree trig",()=>{assert.equal(compileExpr("x^2")?.(3),9);assert.ok(Math.abs(compileExpr("sin(90)")?.(0)-1)<1e-12);assert.ok(Math.abs(compileExpr("sin(deg(x))")?.(Math.PI/2)-1)<1e-12);assert.equal(compileExpr("-x^2")?.(3),-9);assert.equal(compileExpr("2^3^2")?.(0),512);assert.equal(compileExpr("x++"),null);assert.equal(compileExpr("foo(x)"),null);});
test("plot sampling splits discontinuities and range helpers are stable",()=>{const fn=compileExpr("1/x");assert.ok(fn);assert.ok(samplePlot(fn,-1,1,100).length>=2);const ticks=niceTicks(-5,5);assert.ok(ticks.includes(0));const step=ticks[1]-ticks[0],fraction=step/10**Math.floor(Math.log10(step));assert.ok([1,2,2.5,5,10].includes(fraction));assert.deepEqual(autoRange([]),{min:-1,max:1});});
test("plot TikZ emits pgfplots axis, series, legend, and requirement",()=>{const scene=createEmptyScene(),object=plot();object.series[0].legend="quadratic";scene.objects.push(object);const code=generateTikz(scene).code;assert.match(code,/^% requires: \\usepackage\{pgfplots\} \\pgfplotsset\{compat=1\.18\}/);assert.match(code,/\\begin\{axis\}\[/);assert.match(code,/domain=-5:5/);assert.match(code,/samples=100/);assert.match(code,/\{x\^2\};/);assert.match(code,/\\addlegendentry\{quadratic\}/);assert.match(code,/\\end\{axis\}/);assert.doesNotMatch(code,/ymin=/);});
test("standalone documents include pgfplots only for plot scenes",()=>{const scene=createEmptyScene();scene.objects.push(plot());assert.match(buildStandaloneDoc(scene),/\\usepackage\{pgfplots\}/);assert.doesNotMatch(buildStandaloneDoc(createEmptyScene()),/\\usepackage\{pgfplots\}/);});
test("plot scene validation accepts valid plots and rejects malformed geometry or series",()=>{const scene=createEmptyScene();scene.objects.push(plot());assert.ok(validateScene(scene));const badWidth=structuredClone(scene);badWidth.objects[0].width=-1;assert.equal(validateScene(badWidth),null);const badSeries=structuredClone(scene);badSeries.objects[0].series={};assert.equal(validateScene(badSeries),null);});
