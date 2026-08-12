import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyScene } from "../Resources/web/app/pro-canvas/scene.js";
import { buildStyFile } from "../Resources/web/app/pro-canvas/sty-export.js";

test("style export contains package metadata, named styles, every pic, and endinput", () => {
  const scene=createEmptyScene();scene.styles.push({name:"accent",props:{draw:"#123456"}});scene.symbols=[{id:"s",name:"ornament",objects:[{id:"r",type:"rect",from:{x:0,y:0},to:{x:1,y:1},style:{ref:"accent"}}]}];const sty=buildStyFile(scene,"figures");
  assert.match(sty,/\\ProvidesPackage\{figures\}/);assert.match(sty,/\\tikzset\{/);assert.match(sty,/ornament\/\.pic=/);assert.match(sty,/accent\/\.style=/);assert.match(sty,/\\endinput/);assert.doesNotMatch(sty,/\\usetikzlibrary/);
});

test("style export requests arrows.meta only when an arrow is used", () => {
  const scene=createEmptyScene();scene.symbols=[{id:"s",name:"arrowPic",objects:[{id:"p",type:"path",start:{x:0,y:0},segments:[{type:"line",to:{x:1,y:0}}],closed:false,style:{props:{arrowEnd:"Stealth"}}}]}];assert.match(buildStyFile(scene,"figures"),/\\usetikzlibrary\{arrows\.meta\}/);
});
