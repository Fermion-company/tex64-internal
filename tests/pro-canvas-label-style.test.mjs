import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEmptyScene, validateScene } from "../Resources/web/app/pro-canvas/scene.js";
import { NODE_ANCHORS, NODE_COMPASS_ANCHORS, NODE_FONT_SHAPES, NODE_PLACEMENT_SNAP_DEFAULT, nodeEditCommitAction, nodeEditorWidthPx, nodeFontContent, nodeFontPreviewStyle, nodeFontOption, nodeFontShapeChoice, nodeLabelBounds, nodeLabelBoundsFromSize, nodeMiniMenuVisible, nodePreviewExpression, nodeSelectionOutlineVisible, nodeToolEditsExisting } from "../Resources/web/app/pro-canvas/label-style.js";
import { generateTikz } from "../Resources/web/app/pro-canvas/tikz-generate.js";

const label = overrides => ({ id:"n", type:"node", at:{x:2,y:3}, latex:"$x$", anchor:"center", style:{}, ...overrides });

test("label font settings remain backward compatible and reject unknown values", () => {
  const oldScene=createEmptyScene();oldScene.objects.push(label({}));
  assert.ok(validateScene(oldScene));
  const styled=createEmptyScene();styled.objects.push(label({fontFamily:"sans",fontSize:"Large",fontShape:"upright",fontWeight:"bold",monospace:false}));
  assert.ok(validateScene(styled));
  const invalid=createEmptyScene();invalid.objects.push(label({fontFamily:"comic"}));
  assert.equal(validateScene(invalid),null);
  const invalidShape=createEmptyScene();invalidShape.objects.push(label({fontShape:"slanted"}));
  assert.equal(validateScene(invalidShape),null);
  const baseline=createEmptyScene();baseline.objects.push(label({anchor:"base east"}));
  assert.ok(validateScene(baseline));
});

test("label shape UI offers only italic and upright while legacy auto reads as italic", () => {
  assert.deepEqual(NODE_FONT_SHAPES.map(item => item.value), ["italic", "upright"]);
  assert.equal(nodeFontShapeChoice(), "italic");
  assert.equal(nodeFontShapeChoice("auto"), "italic");
  assert.equal(nodeFontShapeChoice("upright"), "upright");
});

test("label font settings emit only non-default TikZ font options", () => {
  assert.equal(nodeFontOption(),null);
  assert.equal(nodeFontOption("sans","Large"),"font={\\sffamily\\Large}");
  assert.equal(nodeFontOption("default","normal","upright","bold",false),"font={\\upshape\\bfseries\\boldmath}");
  assert.equal(nodeFontOption("default","normal","upright","bold",true),"font={\\ttfamily\\upshape\\bfseries\\boldmath}");
  const plain=createEmptyScene();plain.objects.push(label({}));
  assert.doesNotMatch(generateTikz(plain).code,/font=/);
  const styled=createEmptyScene();styled.objects.push(label({fontFamily:"mono",fontSize:"small"}));
  assert.match(generateTikz(styled).code,/\\node\[anchor=center, font=\{\\ttfamily\\small\}\] at \(2,3\)/);
});

test("math label shape and spacing emit math alphabet commands without changing stored LaTeX", () => {
  assert.equal(nodeFontContent("$x+y$", "italic", false), "$\\mathit{x+y}$");
  assert.equal(nodeFontContent("$x$ and \\(y\\)", "upright", false), "$\\mathrm{x}$ and \\(\\mathrm{y}\\)");
  assert.equal(nodeFontContent("$x$", "italic", true), "$\\mathtt{x}$");
  assert.equal(nodeFontContent("O", "auto", false), "$O$");
  assert.equal(nodeFontContent("O", "upright", false), "$\\mathrm{O}$");
  assert.equal(nodeFontContent("x_1", "italic", false), "$\\mathit{x_1}$");
  assert.equal(nodeFontContent("x_1", "auto", false, "sans"), "$\\mathsf{x_1}$");
  const scene=createEmptyScene();scene.objects.push(label({fontShape:"upright",fontWeight:"bold",monospace:false}));
  assert.match(generateTikz(scene).code,/font=\{\\upshape\\bfseries\\boldmath\}/);
  assert.match(generateTikz(scene).code,/\{\$\\mathrm\{x\}\$\}/);
  assert.equal(scene.objects[0].latex,"$x$");
  const raw=createEmptyScene();raw.objects.push(label({latex:"O",fontShape:"upright"}));
  assert.match(generateTikz(raw).code,/\{\$\\mathrm\{O\}\$\}/);
});

test("canvas preview expressions change actual KaTeX math alphabets", () => {
  assert.equal(nodePreviewExpression("$x_1+y$","default","italic","normal",false),"\\mathit{x_1+y}");
  assert.equal(nodePreviewExpression("x_1+y","default","upright","bold",false),"\\boldsymbol{\\mathrm{x_1+y}}");
  assert.equal(nodePreviewExpression("\\(x_1+y\\)","default","upright","normal",true),"\\mathtt{x_1+y}");
  assert.equal(nodePreviewExpression("x","sans","auto","normal"),"\\mathsf{x}");
});

test("new math-label placement starts unsnapped without changing the scene-wide default", () => {
  assert.equal(NODE_PLACEMENT_SNAP_DEFAULT,false);
  assert.equal(createEmptyScene().grid.snap,true);
});

test("the math tool gives an existing math label priority over creating another label", () => {
  assert.equal(nodeToolEditsExisting(label({})),true);
  assert.equal(nodeToolEditsExisting({id:"r",type:"rect",from:{x:0,y:0},to:{x:1,y:1},style:{}}),false);
  assert.equal(nodeToolEditsExisting(null),false);
});

test("the math-label tool drags an existing label and reserves editing for double-click", () => {
  const source=readFileSync(new URL("../web-src/app/pro-canvas/canvas-ui.ts",import.meta.url),"utf8");
  assert.match(source,/if\(nodeToolEditsExisting\(hit\)\)\{[\s\S]*?drag=\{kind:"move"/);
  assert.doesNotMatch(source,/if\(nodeToolEditsExisting\(hit\)\)\{beginNodeEdit\(hit\)/);
  assert.match(source,/\(tool==="select"\|\|tool==="node"\)&&completed&&!completed\.moved/);
  assert.match(source,/if\(tool!=="select"&&tool!=="node"\)return/);
  assert.match(source,/nodeToolHasSelectedLabel=tool==="node"&&one\?\.type==="node"/);
});

test("an actively edited label hides its second selection box", () => {
  const node = label({});
  assert.equal(nodeSelectionOutlineVisible(node, "n"), false);
  assert.equal(nodeSelectionOutlineVisible(node, "other"), true);
  assert.equal(nodeSelectionOutlineVisible({ id:"r", type:"rect", from:{x:0,y:0}, to:{x:1,y:1}, style:{} }, "r"), true);
});

test("inline label editor width follows content and is clamped", () => {
  assert.equal(nodeEditorWidthPx("x"),26);
  assert.ok(nodeEditorWidthPx("x_1+x_2")>nodeEditorWidthPx("x"));
  assert.equal(nodeEditorWidthPx("a".repeat(100)),220);
});

test("clearing an existing label deletes it instead of leaving an empty box", () => {
  assert.equal(nodeEditCommitAction(false,"x","",true),"delete");
  assert.equal(nodeEditCommitAction(true,"","",true),"restore");
  assert.equal(nodeEditCommitAction(false,"x","x",true),"noop");
  assert.equal(nodeEditCommitAction(false,"x","y",true),"update");
  assert.equal(nodeEditCommitAction(false,"x","",false),"noop");
});

test("math labels expose a selectable box around the whole visible label", () => {
  assert.deepEqual(nodeLabelBounds({at:{x:10,y:20},latex:"x",anchor:"center"}),{minX:8,minY:17.4,maxX:12,maxY:22.6});
  const wide=nodeLabelBounds({at:{x:10,y:20},latex:"x_1+x_2",anchor:"center"});
  assert.ok(wide.maxX-wide.minX>4);
  assert.deepEqual(nodeLabelBounds({at:{x:10,y:20},latex:"x",anchor:"north east"}),{minX:6,minY:14.8,maxX:10,maxY:20});
  const baseline=nodeLabelBounds({at:{x:10,y:20},latex:"x",anchor:"base east"});
  assert.equal(baseline.maxX,10);
  assert.ok(baseline.minY<20&&baseline.maxY>20);
});

test("measured label bounds use the actual rendered dimensions", () => {
  assert.deepEqual(nodeLabelBoundsFromSize({at:{x:10,y:20},anchor:"center"},6,4),{minX:7,minY:18,maxX:13,maxY:22});
  assert.deepEqual(nodeLabelBoundsFromSize({at:{x:10,y:20},anchor:"north east"},6,4),{minX:4,minY:16,maxX:10,maxY:20});
});

test("math labels always export their selected TikZ anchor", () => {
  const centered=createEmptyScene();centered.objects.push(label({anchor:"center"}));
  assert.match(generateTikz(centered).code,/\\node\[anchor=center\]/);
  const corner=createEmptyScene();corner.objects.push(label({anchor:"north east"}));
  assert.match(generateTikz(corner).code,/\\node\[anchor=north east\]/);
  const baseline=createEmptyScene();baseline.objects.push(label({anchor:"base east"}));
  assert.match(generateTikz(baseline).code,/\\node\[anchor=base east\]/);
});

test("the selected-label menu exposes compass and baseline TikZ anchors", () => {
  const source=readFileSync(new URL("../web-src/app/pro-canvas/canvas-ui.ts",import.meta.url),"utf8");
  const compass=["south west","south","south east","west","center","east","north west","north","north east"];
  assert.deepEqual(NODE_COMPASS_ANCHORS.map(item=>item.value),compass);
  assert.deepEqual(NODE_ANCHORS.map(item=>item.value),[
    ...compass,"base west","base","base east","mid west","mid","mid east","text west","text","text east",
  ]);
  assert.match(source,/dataset\.role="node-anchor"/);
  assert.doesNotMatch(source,/node-anchor-select/);
  assert.match(source,/NODE_ANCHORS\.forEach/);
  assert.match(source,/dataset\.role="node-mini-menu"/);
  assert.match(source,/nodeMiniMenuVisible\(/);
});

test("the label font menu stays available while selecting or editing a math label", () => {
  const node=label({});
  assert.equal(nodeMiniMenuVisible("select",1,node,null,false),true);
  assert.equal(nodeMiniMenuVisible("node",1,node,null,false),true);
  assert.equal(nodeMiniMenuVisible("select",2,node,null,false),false);
  assert.equal(nodeMiniMenuVisible("select",1,node,"n",false),true);
  assert.equal(nodeMiniMenuVisible("node",1,node,"n",false),true);
  assert.equal(nodeMiniMenuVisible("select",1,node,null,true),false);
  assert.equal(nodeMiniMenuVisible("select",1,{id:"r",type:"rect",from:{x:0,y:0},to:{x:1,y:1},style:{}},null,false),false);
});

test("every label font control maps to the matching bundled preview face", () => {
  assert.deepEqual(nodeFontPreviewStyle("default","auto","normal",false),{
    fontFamily:"KaTeX_Math, serif",fontStyle:"italic",fontWeight:"400",
  });
  assert.deepEqual(nodeFontPreviewStyle("default","italic","bold",false),{
    fontFamily:"KaTeX_Main, serif",fontStyle:"italic",fontWeight:"700",
  });
  assert.deepEqual(nodeFontPreviewStyle("default","upright","normal",false),{
    fontFamily:"KaTeX_Main, serif",fontStyle:"normal",fontWeight:"400",
  });
  assert.deepEqual(nodeFontPreviewStyle("default","upright","bold",true),{
    fontFamily:"KaTeX_Typewriter, monospace",fontStyle:"normal",fontWeight:"700",
  });
  assert.deepEqual(nodeFontPreviewStyle("serif","auto","normal",false),{
    fontFamily:"KaTeX_Math, serif",fontStyle:"italic",fontWeight:"400",
  });
});

test("canvas labels use KaTeX markup and their inline editor keeps the bundled math font", () => {
  const css=readFileSync(new URL("../Resources/web/theme.css",import.meta.url),"utf8");
  const source=readFileSync(new URL("../web-src/app/pro-canvas/canvas-ui.ts",import.meta.url),"utf8");
  assert.match(source,/svgEl\("foreignObject"/);
  assert.match(source,/katex\.renderToString\(nodePreviewExpression/);
  assert.match(source,/measuredNodeBounds\.set\(object,bounds\)/);
  assert.match(source,/foreign\.setAttribute\("visibility","hidden"\)/);
  assert.match(css,/\.pro-canvas-node-render[^}]*display:\s*flex/);
  assert.match(css,/\.pro-canvas-inline-editor[^}]*font-family:\s*KaTeX_Math, serif/);
  assert.doesNotMatch(source,/content\.style\.fontFamily=font\.fontFamily/);
});
