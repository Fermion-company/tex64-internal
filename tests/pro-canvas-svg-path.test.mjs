import test from "node:test";
import assert from "node:assert/strict";
import { parseSvgPathData } from "../Resources/web/app/pro-canvas/svg-import.js";
test("SVG path lines, close, H/V and relative commands",()=>{let p=parseSvgPathData("M0 0 L10 0 L5 10 Z");assert.equal(p.closed,true);assert.equal(p.segments.length,2);p=parseSvgPathData("m 1 2 h 4 v 5 l -2 -1");assert.deepEqual(p.segments.map(s=>s.to),[{x:5,y:2},{x:5,y:7},{x:3,y:6}]);});
test("SVG cubic, smooth, and quadratic promotion",()=>{const p=parseSvgPathData("M0 0 C1 2 3 4 5 6 S8 9 10 10 Q12 12 14 10 T18 10");assert.ok(p);assert.equal(p.segments.length,4);assert.ok(p.segments.every(s=>s.type==="cubic"));assert.deepEqual(p.segments[2].c1,{x:34/3,y:34/3});});
test("SVG arcs are skipped with a warning and parsing continues",()=>{const p=parseSvgPathData("M0 0 A5 5 0 0 1 10 10 L20 20");assert.ok(p);assert.equal(p.segments.length,1);assert.equal(p.segments[0].to.x,20);assert.match(p.warnings[0],/arc/i);});
