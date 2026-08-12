import type { BridgeWindow } from "../types.js";
import { insertAtEditorCursor, type ProEditorLike } from "../pro-editor-insert.js";
import { buildIncludeGraphicsSnippet, chooseCaptureDirectory } from "../pro-capture-ui.js";
import { encodeFigureBlock } from "./figure-codec.js";
import { cloneScene, createEmptyScene, newObjectId, resolveStyle, type Scene, type SceneObject, type StyleProps, type Transform, type Vec } from "./scene.js";
import { boundsAfterHandleDrag, resizeHandlePoint, resizePoint, screenToScene, snapToGrid, type Bounds, type ResizeHandle } from "./canvas-math.js";

type CanvasDeps = { getActiveGroup: () => { editor: unknown | null }; getWorkspaceFiles: () => string[] };
type OpenDetail = { scene?: Scene; replaceRange?: { startLine: number; endLine: number } };
type Tool = "select" | "pen" | "line" | "rect" | "ellipse" | "node";
const SVG_NS = "http://www.w3.org/2000/svg";
const handles: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const allPoints = (object: SceneObject): Vec[] => {
  if (object.type === "rect") return [object.from, object.to];
  if (object.type === "ellipse") return [{ x: object.center.x - object.rx, y: object.center.y - object.ry }, { x: object.center.x + object.rx, y: object.center.y + object.ry }];
  if (object.type === "node") return [object.at];
  if (object.type === "path") return [object.start, ...object.segments.flatMap((seg) => seg.type === "line" ? [seg.to] : [seg.c1, seg.c2, seg.to])];
  const t = object.transform; const rad = t.rotate * Math.PI / 180;
  return object.children.flatMap(allPoints).map((p) => {
    const x = p.x * t.sx, y = p.y * t.sy;
    return { x: t.tx + x * Math.cos(rad) - y * Math.sin(rad), y: t.ty + x * Math.sin(rad) + y * Math.cos(rad) };
  });
};
const objectBounds = (object: SceneObject): Bounds => {
  const points = allPoints(object);
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x = xs[0] ?? 0, y = ys[0] ?? 0;
  return { minX: Math.min(...xs, x), minY: Math.min(...ys, y), maxX: Math.max(...xs, x), maxY: Math.max(...ys, y) };
};
const walk = (objects: SceneObject[], id: string): SceneObject | null => {
  for (const object of objects) {
    if (object.id === id) return object;
    if (object.type === "group") { const found = walk(object.children, id); if (found) return found; }
  }
  return null;
};
const removeById = (objects: SceneObject[], id: string): boolean => {
  const index = objects.findIndex((object) => object.id === id);
  if (index >= 0) { objects.splice(index, 1); return true; }
  return objects.some((object) => object.type === "group" && removeById(object.children, id));
};
const replaceById = (objects: SceneObject[], id: string, replacement: SceneObject): boolean => {
  const index = objects.findIndex((object) => object.id === id);
  if (index >= 0) { objects.splice(index, 1, replacement); return true; }
  return objects.some((object) => object.type === "group" && replaceById(object.children, id, replacement));
};
// 境界中心 c を軸に δ 度回す変換を既存 Transform に合成する（T' = Rot_c(δ) ∘ T）。
const rotateTransformAround = (t: Transform, c: Vec, angle: number) => {
  const rad = angle * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const nx = t.tx * cos - t.ty * sin + c.x - (c.x * cos - c.y * sin);
  const ny = t.tx * sin + t.ty * cos + c.y - (c.x * sin + c.y * cos);
  t.rotate += angle; t.tx = nx; t.ty = ny;
};
const moveObject = (object: SceneObject, dx: number, dy: number) => {
  const move = (p: Vec) => { p.x += dx; p.y += dy; };
  if (object.type === "rect") { move(object.from); move(object.to); }
  else if (object.type === "ellipse") move(object.center);
  else if (object.type === "node") move(object.at);
  else if (object.type === "path") { move(object.start); object.segments.forEach((s) => { move(s.to); if (s.type === "cubic") { move(s.c1); move(s.c2); } }); }
  else { object.transform.tx += dx; object.transform.ty += dy; }
};
const resizeObject = (object: SceneObject, before: Bounds, after: Bounds) => {
  const set = (p: Vec) => Object.assign(p, resizePoint(p, before, after));
  if (object.type === "rect") { set(object.from); set(object.to); }
  else if (object.type === "ellipse") { object.center = resizePoint(object.center, before, after); object.rx = (after.maxX - after.minX) / 2; object.ry = (after.maxY - after.minY) / 2; }
  else if (object.type === "node") set(object.at);
  else if (object.type === "path") { set(object.start); object.segments.forEach((s) => { set(s.to); if (s.type === "cubic") { set(s.c1); set(s.c2); } }); }
  else { object.transform.tx += after.minX - before.minX; object.transform.ty += after.minY - before.minY; object.transform.sx *= (after.maxX - after.minX) / Math.max(before.maxX - before.minX, 0.01); object.transform.sy *= (after.maxY - after.minY) / Math.max(before.maxY - before.minY, 0.01); }
};

const svgEl = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}) => {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
};
const timestampName = (now = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `figure-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
};

export const initProCanvasUi = (deps: CanvasDeps) => {
  let closeCurrent: (() => void) | null = null;
  const openButton = document.getElementById("pro-canvas-open");
  openButton?.addEventListener("click", () => window.dispatchEvent(new CustomEvent("tex64:pro-canvas-open")));

  const open = (detail: OpenDetail = {}) => {
    closeCurrent?.();
    let scene = cloneScene(detail.scene || createEmptyScene());
    let selectedId: string | null = null, tool: Tool = "select", zoom = 1, panX = 0, panY = 0, space = false;
    let undo: Scene[] = [], redo: Scene[] = [];
    const overlay = document.createElement("div"); overlay.className = "pro-canvas-overlay"; overlay.tabIndex = -1;
    overlay.innerHTML = `<div class="pro-canvas-toolbar" role="toolbar">
      <span class="pro-canvas-tools"></span><button data-action="snap"></button><span class="pro-canvas-separator"></span>
      <button data-action="zoom-out">−</button><button data-action="zoom-reset">100%</button><button data-action="zoom-in">+</button>
      <span class="pro-canvas-separator"></span><button data-action="undo">Undo</button><button data-action="redo">Redo</button></div>
      <div class="pro-canvas-main"><div class="pro-canvas-stage"><svg class="pro-canvas-svg" xmlns="http://www.w3.org/2000/svg"></svg></div><aside class="pro-canvas-inspector"><h3>Style</h3><div class="pro-canvas-style"></div><h3>Named styles</h3><div class="pro-canvas-named"></div></aside></div>
      <div class="pro-canvas-bottom"><span class="pro-canvas-status"></span><button data-action="tikz">${detail.replaceRange ? "更新" : "TikZ を挿入"}</button>${detail.replaceRange ? "" : '<button data-action="png">画像として挿入 (PNG)</button>'}<button data-action="cancel">キャンセル</button></div>`;
    document.body.appendChild(overlay); overlay.focus();
    const svg = overlay.querySelector("svg")!; const stage = overlay.querySelector<HTMLElement>(".pro-canvas-stage")!;
    const status = overlay.querySelector<HTMLElement>(".pro-canvas-status")!;
    const toolHost = overlay.querySelector<HTMLElement>(".pro-canvas-tools")!;
    ([['select','選択'],['pen','ペン'],['line','直線'],['rect','矩形'],['ellipse','楕円'],['node','ノード']] as Array<[Tool,string]>).forEach(([id,label]) => { const b=document.createElement("button"); b.dataset.tool=id; b.textContent=label; toolHost.appendChild(b); });
    const snapshot = () => { undo.push(cloneScene(scene)); if (undo.length > 80) undo.shift(); redo = []; };
    const view = () => { const r=svg.getBoundingClientRect(); return { left:r.left, top:r.top, width:r.width, height:r.height, sceneWidth:scene.width, sceneHeight:scene.height, zoom, panX, panY }; };
    const point = (event: PointerEvent) => snapToGrid(screenToScene({ x:event.clientX, y:event.clientY }, view()), scene.grid.size, scene.grid.snap && !event.altKey);
    const setStatus = (message: string, error=false) => { status.textContent=message; status.classList.toggle("is-error", error); };
    const renderInspector = () => {
      const host=overlay.querySelector<HTMLElement>(".pro-canvas-style")!; const named=overlay.querySelector<HTMLElement>(".pro-canvas-named")!;
      const object=selectedId ? walk(scene.objects,selectedId) : null; host.replaceChildren(); named.replaceChildren();
      if (!object || object.type === "group") host.textContent="Select a drawable object";
      else {
        const props=object.style.props ||= {}; const effective=resolveStyle(scene,object.style);
        const color=(key:"draw"|"fill",label:string)=>{ const row=document.createElement("label"); row.textContent=label; const input=document.createElement("input"); input.type="color"; input.value=(effective[key] as string)||"#000000"; const none=document.createElement("input"); none.type="checkbox"; none.checked=effective[key]===null; input.disabled=none.checked; input.onchange=()=>{snapshot(); props[key]=input.value; render();}; none.onchange=()=>{snapshot(); props[key]=none.checked?null:input.value; render();}; row.append(input,none,document.createTextNode("なし")); host.append(row);};
        color("draw","線色"); color("fill","塗り色");
        const fields: Array<[string,keyof StyleProps,"number"|"select",string[]?]>=[["線幅","lineWidthPt","number"],["破線","dash","select",["solid","dashed","dotted"]],["不透明度","opacity","number"],["始点矢印","arrowStart","select",["","Stealth","Latex","Bar"]],["終点矢印","arrowEnd","select",["","Stealth","Latex","Bar"]],["角丸","roundedCornersPt","number"]];
        fields.forEach(([label,key,kind,options])=>{ const row=document.createElement("label"); row.textContent=label; const input=kind==="select"?document.createElement("select"):document.createElement("input"); if(input instanceof HTMLInputElement){input.type="number"; input.step=key==="opacity"?"0.1":"0.1";} if(input instanceof HTMLSelectElement) options!.forEach(v=>{const o=document.createElement("option");o.value=v;o.textContent=v||"なし";input.append(o);}); input.value=String(effective[key]??""); input.onchange=()=>{snapshot(); (props as Record<string,unknown>)[key]=kind==="number"?Number(input.value):input.value; render();}; row.append(input); host.append(row); });
      }
      scene.styles.forEach((style)=>{const row=document.createElement("div");row.className="pro-canvas-style-row";row.textContent=style.name;const apply=document.createElement("button");apply.textContent="適用";apply.disabled=!object||object.type==="group";apply.onclick=()=>{if(object&&object.type!=="group"){snapshot();object.style.ref=style.name;render();}};row.append(apply);named.append(row);});
      const add=document.createElement("button");add.textContent="＋ 新規";add.onclick=()=>{const name=prompt("Style name (letters only)");if(!name||!/^[A-Za-z]+$/.test(name)||scene.styles.some(s=>s.name===name))return; snapshot();scene.styles.push({name,props:object&&object.type!=="group"?{...resolveStyle(scene,object.style)}:{draw:"#000000"}});render();};named.append(add);
    };
    const render = () => {
      svg.replaceChildren();
      const scale=Math.min(stage.clientWidth/scene.width,stage.clientHeight/scene.height)*zoom;
      const visibleW=stage.clientWidth/scale, visibleH=stage.clientHeight/scale;
      const px=panX/scale, py=panY/scale;
      svg.setAttribute("viewBox",`${(scene.width-visibleW)/2-px} ${-(scene.height+visibleH)/2-py} ${visibleW} ${visibleH}`);
      const root=svgEl("g",{transform:"scale(1,-1)"}); svg.append(root);
      const guides=svgEl("g",{class:"pro-canvas-guides"}); root.append(guides);
      guides.append(svgEl("rect",{x:0,y:0,width:scene.width,height:scene.height,class:"pro-canvas-paper"}));
      for(let x=0;x<=scene.width;x+=scene.grid.size) guides.append(svgEl("line",{x1:x,y1:0,x2:x,y2:scene.height}));
      for(let y=0;y<=scene.height;y+=scene.grid.size) guides.append(svgEl("line",{x1:0,y1:y,x2:scene.width,y2:y}));
      guides.append(svgEl("rect",{x:0,y:0,width:scene.width,height:scene.height,class:"pro-canvas-boundary"}));
      const draw=(object:SceneObject,parent:SVGGElement)=>{ if(object.type==="group"){const g=svgEl("g",{transform:`translate(${object.transform.tx} ${object.transform.ty}) rotate(${object.transform.rotate}) scale(${object.transform.sx} ${object.transform.sy})`});g.dataset.id=object.id;parent.append(g);object.children.forEach(c=>draw(c,g));return;} const style=resolveStyle(scene,object.style);const attrs:Record<string,string|number>={"data-id":object.id,fill:style.fill||"none",stroke:style.draw||"none","stroke-width":style.lineWidthPt||.4,opacity:style.opacity??1,"stroke-dasharray":style.dash==="dashed"?"3 2":style.dash==="dotted"?"1 2":""};let el:SVGElement;
        if(object.type==="rect") el=svgEl("rect",{...attrs,x:Math.min(object.from.x,object.to.x),y:Math.min(object.from.y,object.to.y),width:Math.abs(object.to.x-object.from.x),height:Math.abs(object.to.y-object.from.y),rx:style.roundedCornersPt||0});
        else if(object.type==="ellipse") el=svgEl("ellipse",{...attrs,cx:object.center.x,cy:object.center.y,rx:object.rx,ry:object.ry});
        else if(object.type==="path"){let d=`M ${object.start.x} ${object.start.y}`;object.segments.forEach(s=>{d+=s.type==="line"?` L ${s.to.x} ${s.to.y}`:` C ${s.c1.x} ${s.c1.y} ${s.c2.x} ${s.c2.y} ${s.to.x} ${s.to.y}`});if(object.closed)d+=" Z";el=svgEl("path",{...attrs,d});}
        else {el=svgEl("text",{"data-id":object.id,opacity:style.opacity??1,x:object.at.x,y:-object.at.y,transform:`scale(1,-1)`,class:"pro-canvas-node"});el.textContent=object.latex;}
        parent.append(el);
      }; scene.objects.forEach(o=>draw(o,root));
      const object=selectedId?walk(scene.objects,selectedId):null;if(object){const b=objectBounds(object);const select=svgEl("g",{class:"pro-canvas-selection"});select.append(svgEl("rect",{x:b.minX,y:b.minY,width:Math.max(b.maxX-b.minX,.01),height:Math.max(b.maxY-b.minY,.01)}));handles.forEach(h=>{const p=resizeHandlePoint(b,h);const c=svgEl("circle",{cx:p.x,cy:p.y,r:4/scale,class:"pro-canvas-handle"});c.dataset.handle=h;select.append(c)});const rotate=svgEl("circle",{cx:(b.minX+b.maxX)/2,cy:b.maxY+18/scale,r:4/scale,class:"pro-canvas-rotate"});rotate.dataset.rotate="true";select.append(rotate);root.append(select);}
      overlay.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach(b=>b.classList.toggle("is-active",b.dataset.tool===tool));
      const snap=overlay.querySelector<HTMLButtonElement>("[data-action=snap]")!;snap.textContent=`Snap ${scene.grid.snap?"on":"off"}`;snap.classList.toggle("is-active",scene.grid.snap);
      overlay.querySelector<HTMLButtonElement>("[data-action=zoom-reset]")!.textContent=`${Math.round(zoom*100)}%`;
      overlay.querySelector<HTMLButtonElement>("[data-action=undo]")!.disabled=!undo.length;overlay.querySelector<HTMLButtonElement>("[data-action=redo]")!.disabled=!redo.length;
      renderInspector();
    };
    let drag: null|{kind:"pan"|"move"|"draw"|"resize"|"rotate";start:Vec;before:Scene;id?:string;handle?:ResizeHandle;bounds?:Bounds;lastClient?:Vec;moved?:boolean}=null;
    let penDrag: null|{path:Extract<SceneObject,{type:"path"}>;index:number;end:Vec;previous:Vec}=null;
    let pen: Extract<SceneObject,{type:"path"}>|null=null;
    svg.addEventListener("pointerdown",e=>{const target=e.target as SVGElement;if(space){drag={kind:"pan",start:{x:panX,y:panY},before:cloneScene(scene),lastClient:{x:e.clientX,y:e.clientY}};svg.setPointerCapture(e.pointerId);return;}const p=point(e);const handle=target.dataset.handle as ResizeHandle|undefined;const id=target.closest<SVGElement>("[data-id]")?.dataset.id;
      if(tool==="select"){if(handle&&selectedId){const o=walk(scene.objects,selectedId)!;drag={kind:"resize",start:p,before:cloneScene(scene),id:selectedId,handle,bounds:objectBounds(o)};}else if(target.dataset.rotate&&selectedId){drag={kind:"rotate",start:p,before:cloneScene(scene),id:selectedId,bounds:objectBounds(walk(scene.objects,selectedId)!)};}else if(id){selectedId=id;const object=walk(scene.objects,id)!;drag={kind:e.shiftKey?"rotate":"move",start:p,before:cloneScene(scene),id,bounds:objectBounds(object)};}else selectedId=null;render();svg.setPointerCapture(e.pointerId);return;}
      if(tool==="node"){snapshot();const latex=prompt("LaTeX","")??"";if(latex)scene.objects.push({id:newObjectId(),type:"node",at:p,latex,anchor:"center",style:{props:{draw:"#000000"}}});render();return;}
      if(tool==="pen"){if(!pen){snapshot();pen={id:newObjectId(),type:"path",start:p,segments:[],closed:false,style:{props:{draw:"#000000"}}};scene.objects.push(pen);}else if(Math.hypot(p.x-pen.start.x,p.y-pen.start.y)<scene.grid.size*.4){pen.closed=true;pen=null;}else {const previous=pen.segments.length?pen.segments[pen.segments.length-1].to:pen.start;pen.segments.push({type:"line",to:p});penDrag={path:pen,index:pen.segments.length-1,end:{...p},previous:{...previous}};svg.setPointerCapture(e.pointerId);}render();return;}
      snapshot();const object:SceneObject=tool==="line"?{id:newObjectId(),type:"path",start:p,segments:[{type:"line",to:p}],closed:false,style:{props:{draw:"#000000"}}}:tool==="rect"?{id:newObjectId(),type:"rect",from:p,to:{...p},style:{props:{draw:"#000000"}}}:{id:newObjectId(),type:"ellipse",center:p,rx:0,ry:0,style:{props:{draw:"#000000"}}};scene.objects.push(object);selectedId=object.id;drag={kind:"draw",start:p,before:cloneScene(scene),id:object.id};svg.setPointerCapture(e.pointerId);render();});
    svg.addEventListener("pointermove",e=>{if(penDrag){const p=point(e);if(Math.hypot(p.x-penDrag.end.x,p.y-penDrag.end.y)>.1)penDrag.path.segments[penDrag.index]={type:"cubic",c1:{...penDrag.previous},c2:{x:2*penDrag.end.x-p.x,y:2*penDrag.end.y-p.y},to:{...penDrag.end}};render();return;}if(!drag)return;if(drag.kind==="pan"&&drag.lastClient){panX=drag.start.x+e.clientX-drag.lastClient.x;panY=drag.start.y+e.clientY-drag.lastClient.y;render();return;}const p=point(e);if(p.x!==drag.start.x||p.y!==drag.start.y)drag.moved=true;scene=cloneScene(drag.before);const o=drag.id?walk(scene.objects,drag.id):null;if(!o)return;if(drag.kind==="move")moveObject(o,p.x-drag.start.x,p.y-drag.start.y);else if(drag.kind==="resize"&&drag.bounds&&drag.handle)resizeObject(o,drag.bounds,boundsAfterHandleDrag(drag.bounds,drag.handle,p));else if(drag.kind==="rotate"){const b=drag.bounds!;const c={x:(b.minX+b.maxX)/2,y:(b.minY+b.maxY)/2};const angle=(Math.atan2(p.y-c.y,p.x-c.x)-Math.atan2(drag.start.y-c.y,drag.start.x-c.x))*180/Math.PI;if(o.type==="group")rotateTransformAround(o.transform,c,angle);else if(o.type==="rect"||o.type==="ellipse"){const wrapper:SceneObject={id:`rot-${o.id}`,type:"group",children:[o],transform:{tx:0,ty:0,rotate:0,sx:1,sy:1}};rotateTransformAround(wrapper.transform,c,angle);replaceById(scene.objects,o.id,wrapper);selectedId=wrapper.id;}else {const rad=angle*Math.PI/180;allPoints(o).forEach(q=>{const x=q.x-c.x,y=q.y-c.y;q.x=c.x+x*Math.cos(rad)-y*Math.sin(rad);q.y=c.y+x*Math.sin(rad)+y*Math.cos(rad);});}}else if(drag.kind==="draw"){if(o.type==="rect")o.to=p;else if(o.type==="ellipse"){o.center={x:(drag.start.x+p.x)/2,y:(drag.start.y+p.y)/2};o.rx=Math.abs(p.x-drag.start.x)/2;o.ry=Math.abs(p.y-drag.start.y)/2;}else if(o.type==="path")o.segments[0]={type:"line",to:p};}render();});
    svg.addEventListener("pointerup",e=>{if(drag&&drag.moved&&["move","resize","rotate"].includes(drag.kind)){undo.push(drag.before);redo=[];}else if(drag&&drag.kind==="draw"&&!drag.moved&&drag.id){removeById(scene.objects,drag.id);selectedId=null;undo.pop();}drag=null;penDrag=null;if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId);render();});
    const close=()=>{window.removeEventListener("keydown",onKey,true);window.removeEventListener("keyup",onKeyUp,true);overlay.remove();if(closeCurrent===close)closeCurrent=null;};closeCurrent=close;
    const undoOnce=()=>{const prev=undo.pop();if(!prev)return;redo.push(cloneScene(scene));scene=prev;selectedId=null;render();};const redoOnce=()=>{const next=redo.pop();if(!next)return;undo.push(cloneScene(scene));scene=next;selectedId=null;render();};
    const onKey=(e:KeyboardEvent)=>{e.stopPropagation();if(e.key===" "){space=true;e.preventDefault();}if(e.key==="Escape"){if(pen){pen=null;render();}else close();}if(e.key==="Enter"&&pen){pen=null;render();}if((e.key==="Delete"||e.key==="Backspace")&&selectedId){snapshot();removeById(scene.objects,selectedId);selectedId=null;render();e.preventDefault();}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="z"){e.preventDefault();e.shiftKey?redoOnce():undoOnce();}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="g"){e.preventDefault();if(e.shiftKey&&selectedId){const g=walk(scene.objects,selectedId);if(g?.type==="group"){snapshot();const i=scene.objects.indexOf(g);if(i>=0)scene.objects.splice(i,1,...g.children);selectedId=null;render();}}else if(selectedId){const o=walk(scene.objects,selectedId);if(o){snapshot();removeById(scene.objects,selectedId);const group:SceneObject={id:newObjectId(),type:"group",children:[o],transform:{tx:0,ty:0,rotate:0,sx:1,sy:1}};scene.objects.push(group);selectedId=group.id;render();}}}};
    const onKeyUp=(e:KeyboardEvent)=>{e.stopPropagation();if(e.key===" ")space=false;};window.addEventListener("keydown",onKey,true);window.addEventListener("keyup",onKeyUp,true);
    const replaceOrInsert=()=>{const editor=deps.getActiveGroup().editor as ProEditorLike|null;const block=encodeFigureBlock(scene);if(!detail.replaceRange){insertAtEditorCursor(editor,block,"pro-canvas");close();return;}const Range=(window as any).monaco?.Range;if(!editor?.executeEdits||!Range)throw new Error("No active text editor is available.");editor.pushUndoStop?.();editor.executeEdits("pro-canvas",[{range:new Range(detail.replaceRange.startLine,1,detail.replaceRange.endLine+1,1),text:block,forceMoveMarkers:true}]);editor.pushUndoStop?.();editor.focus?.();close();};
    const exportPng=async()=>{const clone=svg.cloneNode(true) as SVGSVGElement;clone.querySelectorAll(".pro-canvas-guides,.pro-canvas-selection").forEach(n=>n.remove());clone.setAttribute("viewBox",`0 ${-scene.height} ${scene.width} ${scene.height}`);const unit=scene.unit==="mm"?3.78:scene.unit==="cm"?37.8:1.333;const width=Math.max(1,Math.round(scene.width*unit*2)),height=Math.max(1,Math.round(scene.height*unit*2));clone.setAttribute("width",String(width));clone.setAttribute("height",String(height));const blob=new Blob([new XMLSerializer().serializeToString(clone)],{type:"image/svg+xml"});const url=URL.createObjectURL(blob);try{const image=new Image();await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error("SVG export failed."));image.src=url;});const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const ctx=canvas.getContext("2d");if(!ctx)throw new Error("Canvas is unavailable.");ctx.drawImage(image,0,0,width,height);const data=canvas.toDataURL("image/png").split(",")[1];const api=(window as BridgeWindow).tex64Files?.writeBase64;if(!api)throw new Error("File writing is not available.");const dir=chooseCaptureDirectory(deps.getWorkspaceFiles()),path=`${dir}/${timestampName()}`;const result=await api({path,data});if(!result.ok)throw new Error(result.error||"The image could not be saved.");insertAtEditorCursor(deps.getActiveGroup().editor as ProEditorLike|null,buildIncludeGraphicsSnippet(path,false),"pro-canvas-png");close();}finally{URL.revokeObjectURL(url);}};
    overlay.addEventListener("click",async e=>{const button=(e.target as Element).closest<HTMLButtonElement>("button");if(!button)return;if(button.dataset.tool){tool=button.dataset.tool as Tool;render();return;}try{switch(button.dataset.action){case"cancel":close();break;case"snap":snapshot();scene.grid.snap=!scene.grid.snap;render();break;case"zoom-out":zoom=Math.max(.25,zoom/1.25);render();break;case"zoom-in":zoom=Math.min(4,zoom*1.25);render();break;case"zoom-reset":zoom=1;panX=panY=0;render();break;case"undo":undoOnce();break;case"redo":redoOnce();break;case"tikz":replaceOrInsert();break;case"png":setStatus("書き出し中…");await exportPng();break;}}catch(error){setStatus(error instanceof Error?error.message:String(error),true);}});
    new ResizeObserver(render).observe(stage);render();
  };
  window.addEventListener("tex64:pro-canvas-open",((event:CustomEvent<OpenDetail>)=>open(event.detail||{})) as EventListener);
  return { open, cancel:()=>closeCurrent?.() };
};
