import { uiText } from "../i18n.js";
import { insertAtEditorCursor } from "../pro-editor-insert.js";
import { encodeFigureBlock } from "./figure-codec.js";
import { planFigureInsert } from "./insert-plan.js";
import { generateTikz } from "./tikz-generate.js";
import { cloneScene, createEmptyScene, findSymbol, newObjectId, resolveStyle, sceneHasPlot } from "./scene.js";
import { alignDeltas, anchorControlMetrics, anchorPointMetrics, bendSegment, boundsAfterHandleDrag, collectSnapLines, distributeDeltas, drawingToolSelectsExistingObject, isMirrorPair, marqueeHits, mirroredControl, nearestOnPath, normalizeCanvasMeasurement, pathTightPoints, PEN_RESUME_PX, penClickAction, removeAnchor, reversePath, resizeHandlePoint, resizePoint, samplePathPoints, sceneToScreen, screenToScene, snapBoundsToLines, snapToGrid, splitSegmentAt, straightLineEndpoints, toggleSegmentKind, visibleGridStep, zoomAtPoint } from "./canvas-math.js";
import { stripTikzWrapper } from "./code-import.js";
import { PLOT_PALETTE, astToPgf, autoRange, compileExpr, niceTicks, normalizePlotDimension, panRange, parseExpr, parsePoints, sampleParametric, samplePlot, snapRangeToNice, zoomRange } from "./plot-math.js";
import { exprToLatex, latexToExpr } from "./plot-latex.js";
import { buildPenSegments, penSeedFromEnd } from "./pen-math.js";
import { arrowMetrics, arrowShape, endTangent, isArrowKind, trimPathForArrows } from "./arrow-math.js";
import { NODE_ANCHORS, NODE_FONT_SHAPES, NODE_FONT_SIZES, NODE_FONT_WEIGHTS, NODE_PLACEMENT_SNAP_DEFAULT, nodeEditCommitAction, nodeEditorWidthPx, nodeFontPreviewStyle, nodeFontScale, nodeFontShapeChoice, nodeLabelBounds, nodeLabelBoundsFromSize, nodeMiniMenuVisible, nodePreviewExpression, nodeSelectionOutlineVisible, nodeToolEditsExisting } from "./label-style.js";
import { enclosedRegionAt, enclosedRegions } from "./path-regions.js";
const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
// TikZ の線幅は pt。SVG はシーン座標（unit）なので換算しないと近似が実描画とズレる。
const PT_IN_UNIT = { mm: 0.35146, cm: 0.035146, pt: 1 };
// グリッド吸着は磁石式。格子から ±25%（5mm グリッドなら 1.25mm）の中でだけ引き寄せ、
// 残り半分は素通しにする。全点が格子に乗ると、格子に沿わない線が引けなくなるため。
const GRID_PULL = 0.25;
const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const pathOutlineD = (item) => { let d = `M ${item.start.x} ${item.start.y}`; item.segments.forEach(segment => { d += segment.type === "line" ? ` L ${segment.to.x} ${segment.to.y}` : ` C ${segment.c1.x} ${segment.c1.y} ${segment.c2.x} ${segment.c2.y} ${segment.to.x} ${segment.to.y}`; }); return item.closed ? d + " Z" : d; };
const isStraightLine = (item) => item.type === "path" && Boolean(straightLineEndpoints(item));
const plotKind = (series) => series.kind || "fn";
const previewSeries = (series, xmin, xmax) => { const kind = plotKind(series); if (kind === "points") {
    const src = (series.points || "").trim();
    if (!src)
        return { pieces: [], valid: true };
    const points = parsePoints(series.points || "");
    return { pieces: points.map(point => [point]), valid: points.length > 0 };
} if (kind === "fn" && !series.expr.trim())
    return { pieces: [], valid: true }; if (kind === "polar" && !series.expr.trim())
    return { pieces: [], valid: true }; if (kind === "parametric" && !series.expr.trim() && !(series.expr2 || "").trim())
    return { pieces: [], valid: true }; if (kind === "parametric" && (!series.expr.trim() || !(series.expr2 || "").trim()))
    return { pieces: [], valid: false }; const first = compileExpr(series.expr), second = kind === "parametric" ? compileExpr(series.expr2 || "") : null, domain = series.domain || (kind === "fn" ? { min: xmin, max: xmax } : { min: 0, max: 2 * Math.PI }); if (!first || (kind === "parametric" && !second))
    return { pieces: [], valid: false }; if (kind === "fn")
    return { pieces: samplePlot(first, domain.min, domain.max, series.samples), valid: true }; if (kind === "parametric")
    return { pieces: sampleParametric(first, second, domain.min, domain.max, series.samples), valid: true }; return { pieces: sampleParametric(t => first(t) * Math.cos(t), t => first(t) * Math.sin(t), domain.min, domain.max, series.samples), valid: true }; };
const plotIsEmpty = (object) => object.series.every(series => { const kind = plotKind(series); if (kind === "points")
    return !(series.points || "").trim(); if (kind === "parametric")
    return !series.expr.trim() && !(series.expr2 || "").trim(); return !series.expr.trim(); });
const identityAffine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const transformAffine = (transform) => { const rad = transform.rotate * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad); return { a: cos * transform.sx, b: sin * transform.sx, c: -sin * transform.sy, d: cos * transform.sy, e: transform.tx, f: transform.ty }; };
const composeAffine = (outer, inner) => ({ a: outer.a * inner.a + outer.c * inner.b, b: outer.b * inner.a + outer.d * inner.b, c: outer.a * inner.c + outer.c * inner.d, d: outer.b * inner.c + outer.d * inner.d, e: outer.a * inner.e + outer.c * inner.f + outer.e, f: outer.b * inner.e + outer.d * inner.f + outer.f });
const affinePoint = (transform, point) => ({ x: transform.a * point.x + transform.c * point.y + transform.e, y: transform.b * point.x + transform.d * point.y + transform.f });
const transformBoundary = (path, transform) => ({ start: affinePoint(transform, path.start), closed: path.closed, segments: path.segments.map(segment => segment.type === "line" ? { type: "line", to: affinePoint(transform, segment.to) } : { type: "cubic", c1: affinePoint(transform, segment.c1), c2: affinePoint(transform, segment.c2), to: affinePoint(transform, segment.to) }) });
const boundaryPaths = (objects, scene, parent = identityAffine) => { var _a; const result = []; const add = (path) => result.push(transformBoundary(path, parent)); for (const object of objects) {
    if (object.type === "group" || object.type === "instance") {
        const children = object.type === "group" ? object.children : ((_a = findSymbol(scene, object.symbol)) === null || _a === void 0 ? void 0 : _a.objects) || [];
        result.push(...boundaryPaths(children, scene, composeAffine(parent, transformAffine(object.transform))));
        continue;
    }
    if (object.type === "path" && resolveStyle(scene, object.style).draw !== null)
        add(object);
    else if (object.type === "rect" && resolveStyle(scene, object.style).draw !== null) {
        const minX = Math.min(object.from.x, object.to.x), maxX = Math.max(object.from.x, object.to.x), minY = Math.min(object.from.y, object.to.y), maxY = Math.max(object.from.y, object.to.y);
        add({ start: { x: minX, y: minY }, segments: [{ type: "line", to: { x: maxX, y: minY } }, { type: "line", to: { x: maxX, y: maxY } }, { type: "line", to: { x: minX, y: maxY } }, { type: "line", to: { x: minX, y: minY } }], closed: true });
    }
    else if (object.type === "ellipse" && resolveStyle(scene, object.style).draw !== null) {
        const { x, y } = object.center, rx = object.rx, ry = object.ry, k = .5522847498307936;
        add({ start: { x: x + rx, y }, segments: [{ type: "cubic", c1: { x: x + rx, y: y + k * ry }, c2: { x: x + k * rx, y: y + ry }, to: { x, y: y + ry } }, { type: "cubic", c1: { x: x - k * rx, y: y + ry }, c2: { x: x - rx, y: y + k * ry }, to: { x: x - rx, y } }, { type: "cubic", c1: { x: x - rx, y: y - k * ry }, c2: { x: x - k * rx, y: y - ry }, to: { x, y: y - ry } }, { type: "cubic", c1: { x: x + k * rx, y: y - ry }, c2: { x: x + rx, y: y - k * ry }, to: { x: x + rx, y } }], closed: true });
    }
} return result; };
const ensurePlotMathLive = () => { var _a; const global = window.MathLive, ctor = (_a = global === null || global === void 0 ? void 0 : global.MathfieldElement) !== null && _a !== void 0 ? _a : window.MathfieldElement, keyboard = window.mathVirtualKeyboard; try {
    if (ctor) {
        ctor.soundsDirectory = null;
        ctor.keypressSound = null;
        ctor.plonkSound = null;
        ctor.keypressVibration = false;
    }
    if (keyboard) {
        keyboard.keypressSound = null;
        keyboard.plonkSound = null;
        keyboard.keypressVibration = false;
    }
}
catch { } if (!customElements.get("math-field") && (global === null || global === void 0 ? void 0 : global.MathfieldElement))
    try {
        customElements.define("math-field", global.MathfieldElement);
    }
    catch { } return Boolean(customElements.get("math-field")); };
const allPoints = (object, scene) => {
    var _a;
    if (object.type === "code") {
        const t = object.transform, rad = t.rotate * Math.PI / 180;
        return [{ x: -5, y: -5 }, { x: 5, y: 5 }].map(p => ({ x: t.tx + p.x * t.sx * Math.cos(rad) - p.y * t.sy * Math.sin(rad), y: t.ty + p.x * t.sx * Math.sin(rad) + p.y * t.sy * Math.cos(rad) }));
    }
    if (object.type === "rect")
        return [object.from, object.to];
    if (object.type === "plot")
        return [object.at, { x: object.at.x + object.width, y: object.at.y + object.height }];
    if (object.type === "ellipse")
        return [{ x: object.center.x - object.rx, y: object.center.y - object.ry }, { x: object.center.x + object.rx, y: object.center.y + object.ry }];
    if (object.type === "node")
        return [object.at];
    if (object.type === "path")
        return [object.start, ...object.segments.flatMap((seg) => seg.type === "line" ? [seg.to] : [seg.c1, seg.c2, seg.to])];
    if (object.type === "repeat")
        return samplePathPoints(object.path, object.count).map((sample) => sample.point);
    const children = object.type === "group" ? object.children : ((_a = findSymbol(scene, object.symbol)) === null || _a === void 0 ? void 0 : _a.objects) || [];
    const t = object.transform;
    const rad = t.rotate * Math.PI / 180;
    return children.flatMap((child) => allPoints(child, scene)).map((p) => {
        const x = p.x * t.sx, y = p.y * t.sy;
        return { x: t.tx + x * Math.cos(rad) - y * Math.sin(rad), y: t.ty + x * Math.sin(rad) + y * Math.cos(rad) };
    });
};
const boundsPoints = (object, scene) => {
    var _a;
    if (object.type === "path")
        return pathTightPoints(object);
    if (object.type === "repeat")
        return samplePathPoints(object.path, object.count).map(sample => sample.point);
    if (object.type !== "group" && object.type !== "instance")
        return allPoints(object, scene);
    const children = object.type === "group" ? object.children : ((_a = findSymbol(scene, object.symbol)) === null || _a === void 0 ? void 0 : _a.objects) || [], t = object.transform, rad = t.rotate * Math.PI / 180;
    return children.flatMap(child => boundsPoints(child, scene)).map(p => { const x = p.x * t.sx, y = p.y * t.sy; return { x: t.tx + x * Math.cos(rad) - y * Math.sin(rad), y: t.ty + x * Math.sin(rad) + y * Math.cos(rad) }; });
};
const measuredNodeBounds = new WeakMap();
const objectBounds = (object, scene) => {
    var _a, _b;
    if (object.type === "node")
        return measuredNodeBounds.get(object) || nodeLabelBounds(object);
    const points = boundsPoints(object, scene);
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const x = (_a = xs[0]) !== null && _a !== void 0 ? _a : 0, y = (_b = ys[0]) !== null && _b !== void 0 ? _b : 0;
    return { minX: Math.min(...xs, x), minY: Math.min(...ys, y), maxX: Math.max(...xs, x), maxY: Math.max(...ys, y) };
};
const walk = (objects, id) => {
    for (const object of objects) {
        if (object.id === id)
            return object;
        if (object.type === "group") {
            const found = walk(object.children, id);
            if (found)
                return found;
        }
    }
    return null;
};
const removeById = (objects, id) => {
    const index = objects.findIndex((object) => object.id === id);
    if (index >= 0) {
        objects.splice(index, 1);
        return true;
    }
    return objects.some((object) => object.type === "group" && removeById(object.children, id));
};
const replaceById = (objects, id, replacement) => {
    const index = objects.findIndex((object) => object.id === id);
    if (index >= 0) {
        objects.splice(index, 1, replacement);
        return true;
    }
    return objects.some((object) => object.type === "group" && replaceById(object.children, id, replacement));
};
// 境界中心 c を軸に δ 度回す変換を既存 Transform に合成する（T' = Rot_c(δ) ∘ T）。
const rotateTransformAround = (t, c, angle) => {
    const rad = angle * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const nx = t.tx * cos - t.ty * sin + c.x - (c.x * cos - c.y * sin);
    const ny = t.tx * sin + t.ty * cos + c.y - (c.x * sin + c.y * cos);
    t.rotate += angle;
    t.tx = nx;
    t.ty = ny;
};
const moveObject = (object, dx, dy) => {
    const move = (p) => { p.x += dx; p.y += dy; };
    if (object.type === "rect") {
        move(object.from);
        move(object.to);
    }
    else if (object.type === "plot")
        move(object.at);
    else if (object.type === "ellipse")
        move(object.center);
    else if (object.type === "node")
        move(object.at);
    else if (object.type === "path") {
        move(object.start);
        object.segments.forEach((s) => { move(s.to); if (s.type === "cubic") {
            move(s.c1);
            move(s.c2);
        } });
    }
    else if (object.type === "repeat") {
        move(object.path.start);
        object.path.segments.forEach((s) => { move(s.to); if (s.type === "cubic") {
            move(s.c1);
            move(s.c2);
        } });
    }
    else {
        object.transform.tx += dx;
        object.transform.ty += dy;
    }
};
const resizeObject = (object, before, after) => {
    const set = (p) => Object.assign(p, resizePoint(p, before, after));
    if (object.type === "rect") {
        set(object.from);
        set(object.to);
    }
    else if (object.type === "plot") {
        object.at = { x: after.minX, y: after.minY };
        object.width = Math.max(.01, after.maxX - after.minX);
        object.height = Math.max(.01, after.maxY - after.minY);
    }
    else if (object.type === "ellipse") {
        object.center = resizePoint(object.center, before, after);
        object.rx = (after.maxX - after.minX) / 2;
        object.ry = (after.maxY - after.minY) / 2;
    }
    else if (object.type === "node")
        set(object.at);
    else if (object.type === "path") {
        set(object.start);
        object.segments.forEach((s) => { set(s.to); if (s.type === "cubic") {
            set(s.c1);
            set(s.c2);
        } });
    }
    else if (object.type === "repeat") {
        const setPath = (p) => Object.assign(p, resizePoint(p, before, after));
        setPath(object.path.start);
        object.path.segments.forEach(s => { setPath(s.to); if (s.type === "cubic") {
            setPath(s.c1);
            setPath(s.c2);
        } });
    }
    else {
        object.transform.tx += after.minX - before.minX;
        object.transform.ty += after.minY - before.minY;
        object.transform.sx *= (after.maxX - after.minX) / Math.max(before.maxX - before.minX, 0.01);
        object.transform.sy *= (after.maxY - after.minY) / Math.max(before.maxY - before.minY, 0.01);
    }
};
const svgEl = (name, attrs = {}) => {
    const element = document.createElementNS(SVG_NS, name);
    Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
};
export const initProCanvasUi = (deps) => {
    let closeCurrent = null;
    const openButton = document.getElementById("pro-canvas-open");
    openButton === null || openButton === void 0 ? void 0 : openButton.addEventListener("click", () => window.dispatchEvent(new CustomEvent("tex64:pro-canvas-open")));
    const open = (detail = {}) => {
        var _a;
        closeCurrent === null || closeCurrent === void 0 ? void 0 : closeCurrent();
        // 挿入先はキャンバスを開いた瞬間の編集タブとカーソルに固定する。閉じるまでに
        // 別のグループがアクティブになっても、ユーザーが見ていた場所に入るように。
        const anchorEditor = deps.getActiveGroup().editor;
        const anchorPosition = ((_a = anchorEditor === null || anchorEditor === void 0 ? void 0 : anchorEditor.getPosition) === null || _a === void 0 ? void 0 : _a.call(anchorEditor)) || null;
        let scene = cloneScene(detail.scene || createEmptyScene());
        const selection = { ids: new Set(), primaryId: null };
        let editingSymbolId = null, editingNodeId = null, anchorEdit = null, plotEdit = null, selectedAnchorIndex = 0, tool = "select", nodePlacementSnap = NODE_PLACEMENT_SNAP_DEFAULT, zoom = 1, panX = 0, panY = 0, space = false, hoveredId = null, paintRegions = null, paintPreview = null;
        let nodeEditor = null, nodeEditorOriginal = "", nodeEditorNew = false, nodeEditorBefore = null, nodeMenu = null, plotCard = null, plotCardPos = null, plotCardSignature = "", plotCompileTimer = null, wheelUndoTimer = null, wheelBefore = null;
        let undo = [], redo = [];
        const plotPreviewCache = new Map(), plotTextModes = new Set(), plotDetailsOpen = new Set();
        const overlay = document.createElement("div");
        overlay.className = "pro-canvas-overlay";
        overlay.tabIndex = -1;
        overlay.innerHTML = `<div class="pro-canvas-toolbar pro-canvas-topbar" role="toolbar">
      <strong class="pro-canvas-title">${uiText("Figure canvas", "図キャンバス")}</strong><span class="pro-canvas-zoom"><button data-action="zoom-out" title="${uiText("Zoom out", "縮小")}">−</button><button data-action="zoom-reset">100%</button><button data-action="zoom-in" title="${uiText("Zoom in", "拡大")}">+</button></span><span class="pro-canvas-topbar-spacer"></span>
      <span class="pro-canvas-segments"><button data-action="canvas-settings" aria-haspopup="dialog" aria-expanded="false">${uiText("Canvas", "キャンバス")}</button><button data-action="snap"></button></span><span class="pro-canvas-separator"></span>
      <button class="pro-canvas-icon-button" data-action="undo" title="${uiText("Undo", "元に戻す")}">↺</button><button class="pro-canvas-icon-button" data-action="redo" title="${uiText("Redo", "やり直す")}">↻</button></div>
      <div class="pro-canvas-main pro-canvas-body"><nav class="pro-canvas-rail pro-canvas-tools" aria-label="${uiText("Drawing tools", "描画ツール")}"></nav><div class="pro-canvas-stage"><svg class="pro-canvas-svg" xmlns="http://www.w3.org/2000/svg"></svg><span class="pro-canvas-status pro-canvas-status-chip"></span><div class="pro-canvas-hintbar"></div></div><aside class="pro-canvas-inspector"><section class="pro-canvas-geometry-section"><h3>${uiText("Placement", "配置")}</h3><div class="pro-canvas-geometry"></div></section><section class="pro-canvas-style-section"><h3>${uiText("Style", "スタイル")}</h3><div class="pro-canvas-style"></div></section><p class="pro-canvas-empty pro-canvas-inspector-empty" hidden></p></aside></div><div class="pro-canvas-size-chip" hidden></div>
      <div class="pro-canvas-bottom pro-canvas-footer"><span class="pro-canvas-footer-spacer"></span><button class="pro-canvas-ghost" data-action="cancel">${uiText("Cancel", "キャンセル")}</button><button class="pro-canvas-primary" data-action="tikz">${detail.replaceRange ? uiText("Update TikZ code", "TikZ コードを更新") : uiText("Insert TikZ code", "TikZ コードを挿入")}</button></div>`;
        document.body.appendChild(overlay);
        overlay.focus();
        const svg = overlay.querySelector("svg");
        const stage = overlay.querySelector(".pro-canvas-stage");
        const status = overlay.querySelector(".pro-canvas-status");
        const hintbar = overlay.querySelector(".pro-canvas-hintbar");
        const sizeChip = overlay.querySelector(".pro-canvas-size-chip");
        const toolHost = overlay.querySelector(".pro-canvas-tools");
        const toolIcons = { select: '<polyline points="3,2 3,13 6.5,9.5 9,14 11,13 8.5,8.5 13,8.5 3,2"/>', pen: '<path d="M2 12C5 3.5 11 3.5 14 12"/><line x1="2" y1="12" x2="6" y2="5"/><circle cx="6" cy="5" r="1.4"/><circle cx="2" cy="12" r="1.2" style="fill:currentColor"/><circle cx="14" cy="12" r="1.2" style="fill:currentColor"/>', line: '<line x1="3" y1="13" x2="13" y2="3"/>', rect: '<rect x="3" y="3" width="10" height="10"/>', ellipse: '<ellipse cx="8" cy="8" rx="5" ry="4"/>', fill: '<path d="M4 3l7 7-4 4-5-5z"/><path d="M8.5 4.5l2-2"/><path d="M10 12.5c1.5-2 2.5-2 4 0-.4 1.2-1.1 1.8-2 1.8s-1.6-.6-2-1.8z"/>', node: '<line x1="3" y1="3" x2="13" y2="3"/><line x1="8" y1="3" x2="8" y2="13"/>', code: '<polyline points="6,4 2,8 6,12"/><polyline points="10,4 14,8 10,12"/>', plot: '<path d="M3 2v11h11"/><path d="M4 12c2.5-7 5 1 9-7"/>' };
        [['select', uiText("Select", "選択"), uiText("Select", "選択"), 'V'], ['pen', uiText("Curve", "曲線"), uiText("Curve (pen)", "曲線（ペン）"), 'P'], ['plot', uiText("Function", "関数"), uiText("Function curve", "関数から曲線"), 'G'], ['line', uiText("Line", "直線"), uiText("Line", "直線"), 'L'], ['rect', uiText("Rect", "矩形"), uiText("Rectangle", "矩形"), 'R'], ['ellipse', uiText("Oval", "楕円"), uiText("Ellipse", "楕円"), 'E'], ['fill', uiText("Fill", "塗り"), uiText("Fill an enclosed region", "囲まれた領域を塗る"), 'F'], ['node', uiText("Math", "数式"), uiText("Math label", "数式ラベル"), 'T']].forEach(([id, label, tooltip, key]) => { const b = document.createElement("button"); b.dataset.tool = id; b.dataset.noI18n = ""; b.title = `${tooltip} (${key})`; b.setAttribute("aria-label", b.title); b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${toolIcons[id]}</svg><span>${label}</span>`; toolHost.appendChild(b); });
        // The canvas is self-contained: its SVG approximation is the preview.
        // Keep this hook while the editing code is compact so callers do not need
        // engine-specific branches.
        const invalidateCompiled = () => { };
        const scheduleCompile = () => { };
        const invalidatePaintRegions = () => { paintRegions = null; paintPreview = null; };
        const snapshot = (compile = true) => { undo.push(cloneScene(scene)); if (undo.length > 80)
            undo.shift(); redo = []; invalidatePaintRegions(); if (compile)
            queueMicrotask(scheduleCompile); };
        const view = () => { const r = svg.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, sceneWidth: scene.width, sceneHeight: scene.height, zoom, panX, panY }; };
        const rawPoint = (event) => screenToScene({ x: event.clientX, y: event.clientY }, view());
        /** シーン単位あたりの画面 px。当たり判定の「画面上 N px」をシーン単位に直すのに使う。 */
        const scaleFactor = () => Math.min(stage.clientWidth / scene.width, stage.clientHeight / scene.height) * zoom || 1;
        const activeSnap = () => tool === "node" ? nodePlacementSnap : scene.grid.snap;
        const snappedPoint = (event) => snapToGrid(rawPoint(event), scene.grid.size, activeSnap() && !event.altKey, GRID_PULL);
        const snappedDelta = (start, point, event) => snapToGrid({ x: point.x - start.x, y: point.y - start.y }, scene.grid.size, scene.grid.snap && !event.altKey, GRID_PULL);
        const setStatus = (message, error = false) => { status.textContent = message; status.classList.toggle("is-error", error); };
        const currentObjects = () => { var _a; return editingSymbolId ? ((_a = findSymbol(scene, editingSymbolId)) === null || _a === void 0 ? void 0 : _a.objects) || [] : scene.objects; };
        const replaceSelection = (id) => { selection.ids = new Set([id]); selection.primaryId = id; };
        const toggleSelection = (id) => { var _a; if (selection.ids.has(id)) {
            selection.ids.delete(id);
            if (selection.primaryId === id) {
                const ids = [...selection.ids];
                selection.primaryId = (_a = ids[ids.length - 1]) !== null && _a !== void 0 ? _a : null;
            }
        }
        else {
            selection.ids.add(id);
            selection.primaryId = id;
        } };
        const clearSelection = () => { selection.ids.clear(); selection.primaryId = null; };
        const selectedIdOne = () => selection.ids.size === 1 ? selection.primaryId : null;
        const nodeById = (id) => id ? walk(currentObjects(), id) : null;
        const positionNodeEditor = () => { if (!editingNodeId || !nodeEditor)
            return; const object = nodeById(editingNodeId); if ((object === null || object === void 0 ? void 0 : object.type) !== "node")
            return; const point = sceneToScreen(object.at, view()), scale = Math.min(stage.clientWidth / scene.width, stage.clientHeight / scene.height) * zoom, font = nodeFontPreviewStyle(object.fontFamily, object.fontShape, object.fontWeight, object.monospace), fontSize = Math.max(12, 4 * scale * nodeFontScale(object.fontSize)); nodeEditor.style.left = `${point.x}px`; nodeEditor.style.top = `${point.y}px`; nodeEditor.style.fontFamily = font.fontFamily; nodeEditor.style.fontStyle = font.fontStyle; nodeEditor.style.fontWeight = font.fontWeight; nodeEditor.style.fontSize = `${fontSize}px`; let width = nodeEditorWidthPx(nodeEditor.value); try {
            const context = document.createElement("canvas").getContext("2d");
            if (context) {
                context.font = `${font.fontStyle} ${font.fontWeight} ${fontSize}px ${font.fontFamily}`;
                width = Math.max(width, Math.ceil(context.measureText(nodeEditor.value || "x").width + 14));
            }
        }
        catch { } nodeEditor.style.width = `${Math.min(220, width)}px`; };
        const finishNodeEdit = (commit) => { if (!editingNodeId || !nodeEditor)
            return; const id = editingNodeId, input = nodeEditor, object = nodeById(id), value = input.value, action = nodeEditCommitAction(nodeEditorNew, nodeEditorOriginal, value, commit); editingNodeId = null; nodeEditor = null; input.remove(); const dropEditedSelection = () => { var _a; if (!selection.ids.has(id))
            return; selection.ids.delete(id); if (selection.primaryId === id) {
            const ids = [...selection.ids];
            selection.primaryId = (_a = ids[ids.length - 1]) !== null && _a !== void 0 ? _a : null;
        } }; if ((object === null || object === void 0 ? void 0 : object.type) !== "node")
            return; if (action === "restore") {
            scene = nodeEditorBefore || scene;
            dropEditedSelection();
            render();
            return;
        } if (action === "delete") {
            snapshot(false);
            removeById(currentObjects(), id);
            dropEditedSelection();
            render();
            scheduleCompile();
            return;
        } if (action === "update") {
            if (nodeEditorNew && nodeEditorBefore) {
                undo.push(nodeEditorBefore);
                redo = [];
            }
            else
                snapshot(false);
            object.latex = value;
            render();
            scheduleCompile();
            return;
        } render(); };
        const beginNodeEdit = (object, isNew = false, before = null) => { if (editingNodeId)
            finishNodeEdit(true); anchorEdit = null; editingNodeId = object.id; nodeEditorOriginal = object.latex; nodeEditorNew = isNew; nodeEditorBefore = before; replaceSelection(object.id); const input = document.createElement("input"); input.className = "pro-canvas-inline-editor"; input.dataset.role = "node-editor"; input.dataset.objectId = object.id; input.value = object.latex; let finished = false; const finish = (commit) => { if (finished)
            return; finished = true; finishNodeEdit(commit); }; input.addEventListener("input", positionNodeEditor); input.addEventListener("keydown", e => { if (e.key !== "Enter" && e.key !== "Escape")
            return; e.preventDefault(); e.stopPropagation(); finish(e.key !== "Escape"); }); input.addEventListener("blur", e => { if (nodeMenu === null || nodeMenu === void 0 ? void 0 : nodeMenu.contains(e.relatedTarget))
            return; finish(true); }); overlay.append(input); nodeEditor = input; render(); requestAnimationFrame(() => { if (nodeEditor !== input)
            return; positionNodeEditor(); input.focus(); input.select(); }); };
        const stopPlotEdit = () => { if (!plotEdit)
            return; flushWheelUndo(); const object = plotObject(), emptyUndoDepth = plotEdit.emptyUndoDepth; if (object && emptyUndoDepth !== undefined && plotIsEmpty(object)) {
            removeById(currentObjects(), object.id);
            clearSelection();
            undo.splice(emptyUndoDepth);
            redo = [];
        } plotEdit = null; plotCard === null || plotCard === void 0 ? void 0 : plotCard.remove(); plotCard = null; plotCardPos = null; plotCardSignature = ""; scheduleCompile(); render(); };
        const plotObject = () => { const object = plotEdit ? nodeById(plotEdit.id) : null; return (object === null || object === void 0 ? void 0 : object.type) === "plot" ? object : null; };
        const debouncePlotCompile = () => { invalidateCompiled(); if (plotCompileTimer)
            clearTimeout(plotCompileTimer); plotCompileTimer = setTimeout(() => { plotCompileTimer = null; scheduleCompile(); }, 400); };
        const flushWheelUndo = () => { if (wheelUndoTimer) {
            clearTimeout(wheelUndoTimer);
            wheelUndoTimer = null;
        } if (wheelBefore) {
            undo.push(wheelBefore);
            redo = [];
            wheelBefore = null;
        } };
        const liveField = (input, apply) => { let before = null, pushed = false; input.addEventListener("focus", () => { before = cloneScene(scene); pushed = false; }); input.addEventListener("input", () => { if (!pushed && before) {
            flushWheelUndo();
            undo.push(before);
            redo = [];
            pushed = true;
        } apply(); debouncePlotCompile(); render(); }); const commit = () => { before = null; pushed = false; }; input.addEventListener("change", commit); input.addEventListener("blur", commit); };
        const positionPlotCard = () => { var _a; const object = plotObject(); if (!object || !plotCard)
            return; if (plotCardPos) {
            plotCard.style.left = `${plotCardPos.x}px`;
            plotCard.style.top = `${plotCardPos.y}px`;
            return;
        } const bl = sceneToScreen(object.at, view()), tr = sceneToScreen({ x: object.at.x + object.width, y: object.at.y + object.height }, view()), left = Math.min(bl.x, tr.x), right = Math.max(bl.x, tr.x), top = Math.min(bl.y, tr.y), bottom = Math.max(bl.y, tr.y), w = 320, gap = 10; let x = right + gap, y = top; if (x + w > innerWidth - 8)
            x = left - w - gap; if (x < 8) {
            x = Math.max(8, Math.min(innerWidth - w - 8, left));
            y = bottom + gap;
        } plotCard.style.left = `${x}px`; const footer = overlay.querySelector(".pro-canvas-footer"), limit = ((_a = footer === null || footer === void 0 ? void 0 : footer.getBoundingClientRect().top) !== null && _a !== void 0 ? _a : innerHeight) - 8; plotCard.style.top = `${Math.max(8, Math.min(limit - plotCard.offsetHeight, y))}px`; };
        const buildPlotCard = (object, focusIndex = -1) => {
            var _a;
            plotCard === null || plotCard === void 0 ? void 0 : plotCard.remove();
            const hasMathLive = ensurePlotMathLive(), card = document.createElement("div");
            card.className = "pro-canvas-plot-card";
            card.addEventListener("pointerdown", e => e.stopPropagation());
            card.addEventListener("click", e => e.stopPropagation());
            card.addEventListener("keydown", e => { var _a, _b; if (e.key !== "Escape")
                return; e.preventDefault(); e.stopPropagation(); (_b = (_a = e.target).blur) === null || _b === void 0 ? void 0 : _b.call(_a); stopPlotEdit(); });
            const header = document.createElement("div");
            header.className = "pro-canvas-plot-card-header";
            const headTitle = document.createElement("strong");
            headTitle.textContent = object.axis.axisLines === "none" ? uiText("Edit function curve", "関数曲線を編集") : uiText("Edit graph", "グラフを編集");
            const headClose = document.createElement("button");
            headClose.type = "button";
            headClose.textContent = "✕";
            headClose.title = uiText("Close", "閉じる");
            headClose.setAttribute("aria-label", uiText("Close", "閉じる"));
            headClose.onclick = () => stopPlotEdit();
            header.append(headTitle, headClose);
            header.addEventListener("pointerdown", e => { if (e.target.closest("button"))
                return; e.preventDefault(); const rect = card.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, bx = rect.left, by = rect.top; const move = (ev) => { plotCardPos = { x: bx + ev.clientX - sx, y: by + ev.clientY - sy }; card.style.left = `${plotCardPos.x}px`; card.style.top = `${plotCardPos.y}px`; }; const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); });
            card.append(header);
            const field = (label, value, type, apply) => { const row = document.createElement("label"); row.textContent = label; const input = document.createElement("input"); input.type = type; input.value = value; input.title = label; if (type === "number")
                input.step = "any"; liveField(input, () => apply(input.value)); row.append(input); return { row, input }; };
            const dimensions = document.createElement("div");
            dimensions.className = "pro-canvas-plot-dimensions";
            const dimensionTitle = document.createElement("span");
            dimensionTitle.className = "pro-canvas-plot-range-title";
            dimensionTitle.textContent = object.axis.axisLines === "none" ? uiText("Curve size", "曲線の大きさ") : uiText("Axis length", "軸の長さ");
            const plotWidth = field(`${uiText("Width", "幅")} (${scene.unit})`, String(Number(object.width.toPrecision(4))), "number", value => object.width = normalizePlotDimension(value, object.width)), plotHeight = field(`${uiText("Height", "高さ")} (${scene.unit})`, String(Number(object.height.toPrecision(4))), "number", value => object.height = normalizePlotDimension(value, object.height));
            plotWidth.input.min = plotHeight.input.min = "0.01";
            plotWidth.input.dataset.noI18n = "";
            plotHeight.input.dataset.noI18n = "";
            dimensions.append(dimensionTitle, plotWidth.row, plotHeight.row);
            card.append(dimensions);
            object.series.forEach((series, index) => {
                const kind = plotKind(series), wrap = document.createElement("div");
                wrap.className = `pro-canvas-plot-card-series${series.visible === false ? " is-muted" : ""}`;
                const main = document.createElement("div");
                main.className = "pro-canvas-plot-card-main";
                const chip = document.createElement("label");
                chip.className = "pro-canvas-color-chip";
                chip.title = uiText(`Series ${index + 1} color`, `系列 ${index + 1} の色`);
                chip.setAttribute("aria-label", chip.title);
                chip.style.background = series.color;
                chip.tabIndex = 0;
                const color = document.createElement("input");
                color.type = "color";
                color.value = series.color;
                liveField(color, () => { series.color = color.value; chip.style.background = color.value; });
                chip.append(color);
                const expressions = document.createElement("div");
                expressions.className = "pro-canvas-plot-expressions";
                const editors = [], valid = () => previewSeries(series, object.axis.xmin, object.axis.xmax).valid, refreshError = () => { const bad = !valid(); editors.forEach(editor => editor.classList.toggle("is-error", bad)); error.hidden = !bad; };
                const addExpr = (labelText, key, placeholder) => { const label = document.createElement("label"), caption = document.createElement("span"), value = series[key] || "", varName = kind === "fn" ? "x" : "t", modeKey = `${object.id}:${index}:${key}`, latex = value.trim() ? exprToLatex(value, varName) : "", useMath = hasMathLive && latex !== null && !plotTextModes.has(modeKey), toggle = document.createElement("button"); caption.textContent = labelText; toggle.type = "button"; toggle.className = "pro-canvas-plot-input-toggle"; toggle.dataset.noI18n = ""; toggle.textContent = "⌨"; toggle.disabled = !hasMathLive || latex === null; toggle.title = !hasMathLive ? uiText("Formula input is unavailable", "数式入力を利用できません") : latex === null ? uiText("This expression cannot be shown as a formula", "この式は数式入力に変換できません") : useMath ? uiText("Edit as text", "テキストで編集") : uiText("Edit as a formula", "数式で編集"); toggle.setAttribute("aria-label", toggle.title); toggle.onclick = () => { if (toggle.disabled)
                    return; if (useMath)
                    plotTextModes.add(modeKey);
                else
                    plotTextModes.delete(modeKey); plotCardSignature = ""; render(); }; let editor; if (useMath) {
                    const mf = document.createElement("math-field");
                    mf.className = "pro-canvas-plot-expr";
                    mf.dataset.noI18n = "";
                    mf.title = uiText(`Series ${index + 1} ${labelText}`, `系列 ${index + 1} ${labelText}`);
                    mf.setAttribute("math-virtual-keyboard-policy", "manual");
                    mf.setAttribute("placeholder", placeholder);
                    try {
                        mf.menuItems = [];
                    }
                    catch { }
                    const injectMfStyle = () => { try {
                        mf.menuItems = [];
                    }
                    catch { } const sr = mf.shadowRoot; if (!sr || sr.querySelector("style[data-tex64-plot]"))
                        return; const st = document.createElement("style"); st.setAttribute("data-tex64-plot", ""); st.textContent = ".ML__content{overflow:visible!important;min-width:0!important;flex:1 1 auto!important}.ML__virtual-keyboard-toggle,button[part=virtual-keyboard-toggle],.ML__menu-toggle,button[part=menu-toggle]{display:none!important}"; sr.appendChild(st); };
                    injectMfStyle();
                    requestAnimationFrame(injectMfStyle);
                    mf.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); }, true);
                    mf.addEventListener("keydown", e => { var _a; if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey)
                        return; e.preventDefault(); e.stopImmediatePropagation(); try {
                        const m = mf;
                        if ((_a = m.selectionIsCollapsed) !== null && _a !== void 0 ? _a : true)
                            m.executeCommand("extendSelectionBackward");
                        m.executeCommand(["insert", "\\frac{#@}{#?}"]);
                    }
                    catch {
                        try {
                            mf.insert("\\frac{#@}{#?}");
                        }
                        catch { }
                    } }, true);
                    mf.value = latex;
                    mf.addEventListener("keydown", e => { if (e.key !== "Escape")
                        return; e.preventDefault(); e.stopPropagation(); stopPlotEdit(); });
                    liveField(mf, () => { var _a, _b; let raw = mf.value; try {
                        raw = (_b = (_a = mf.getValue) === null || _a === void 0 ? void 0 : _a.call(mf, "latex")) !== null && _b !== void 0 ? _b : raw;
                    }
                    catch { } const next = raw.trim() ? latexToExpr(raw, varName) : "", bad = next === null; mf.classList.toggle("is-error", bad); error.hidden = !bad; if (next !== null)
                        series[key] = next; });
                    editor = mf;
                }
                else {
                    const input = document.createElement("input");
                    input.type = "text";
                    input.className = "pro-canvas-plot-expr";
                    input.placeholder = placeholder;
                    input.dataset.noI18n = "";
                    input.title = uiText(`Series ${index + 1} ${labelText}`, `系列 ${index + 1} ${labelText}`);
                    input.value = value;
                    liveField(input, () => { series[key] = input.value; const nextLatex = exprToLatex(input.value, varName); toggle.disabled = !hasMathLive || nextLatex === null; toggle.title = !hasMathLive ? uiText("Formula input is unavailable", "数式入力を利用できません") : nextLatex === null ? uiText("This expression cannot be shown as a formula", "この式は数式入力に変換できません") : uiText("Edit as a formula", "数式で編集"); toggle.setAttribute("aria-label", toggle.title); refreshError(); });
                    editor = input;
                } label.append(caption, editor, toggle); expressions.append(label); editors.push(editor); };
                if (kind === "points") {
                    const area = document.createElement("textarea");
                    area.className = "pro-canvas-plot-points";
                    area.rows = 3;
                    area.placeholder = "0,0\n1,1";
                    area.dataset.noI18n = "";
                    area.title = uiText(`Series ${index + 1} points`, `系列 ${index + 1} の点列`);
                    area.value = series.points || "";
                    liveField(area, () => { series.points = area.value; refreshError(); });
                    expressions.append(area);
                    editors.push(area);
                }
                else if (kind === "parametric") {
                    addExpr("x(t)", "expr", uiText("e.g. cos(deg(t))", "例: cos(deg(t))"));
                    addExpr("y(t)", "expr2", uiText("e.g. sin(deg(t))", "例: sin(deg(t))"));
                }
                else if (kind === "polar")
                    addExpr("r(θ)", "expr", uiText("e.g. 1+cos(deg(t))", "例: 1+cos(deg(t))"));
                else
                    addExpr("f(x)", "expr", plotTextModes.has(`${object.id}:${index}:expr`) ? uiText("e.g. sin(deg(x))", "例: sin(deg(x))") : uiText("e.g. sin(x)", "例: sin(x)"));
                const eye = document.createElement("button");
                eye.type = "button";
                eye.className = "pro-canvas-eye";
                eye.title = uiText("Show / hide", "表示/非表示");
                eye.setAttribute("aria-label", eye.title);
                eye.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M1.5 9s2.7-4 7.5-4 7.5 4 7.5 4-2.7 4-7.5 4-7.5-4-7.5-4Z"/><circle cx="9" cy="9" r="2"/></svg>';
                eye.onclick = () => { snapshot(false); series.visible = series.visible === false; wrap.classList.toggle("is-muted", series.visible === false); debouncePlotCompile(); render(); };
                const more = document.createElement("button");
                more.type = "button";
                more.textContent = "⋯";
                more.title = uiText("Series details", "系列の詳細");
                const remove = document.createElement("button");
                remove.type = "button";
                remove.textContent = "×";
                remove.title = uiText("Remove series", "系列を削除");
                remove.disabled = object.series.length <= 1;
                remove.onclick = () => { snapshot(false); object.series.splice(index, 1); plotCardSignature = ""; debouncePlotCompile(); render(); };
                main.append(chip, expressions, eye, more, remove);
                const error = document.createElement("div");
                error.className = "pro-canvas-plot-error";
                error.textContent = kind === "points" ? uiText("That point list cannot be interpreted", "点列を解釈できません") : uiText("That expression cannot be interpreted", "式を解釈できません");
                error.hidden = valid();
                editors.forEach(editor => editor.classList.toggle("is-error", !error.hidden));
                const detailsKey = `${object.id}:${index}`, details = document.createElement("div");
                details.className = "pro-canvas-plot-details";
                details.hidden = !plotDetailsOpen.has(detailsKey);
                const kindLabel = document.createElement("label"), kindSelect = document.createElement("select");
                kindLabel.textContent = uiText("Kind", "種類");
                for (const [value, text] of [["fn", uiText("Function y=f(x)", "関数 y=f(x)")], ["parametric", uiText("Parametric", "媒介変数")], ["polar", uiText("Polar r(θ)", "極座標 r(θ)")], ["points", uiText("Point list", "点列")]]) {
                    const option = document.createElement("option");
                    option.value = value;
                    option.textContent = text;
                    kindSelect.append(option);
                }
                kindSelect.value = kind;
                kindSelect.onchange = () => { snapshot(false); series.kind = kindSelect.value; const nextVar = series.kind === "fn" ? "x" : "t"; ["expr", "expr2"].forEach(key => { const src = series[key]; if (!src)
                    return; const ast = parseExpr(src); if (ast)
                    series[key] = astToPgf(ast, nextVar); }); if (series.kind === "parametric" && series.expr2 === undefined)
                    series.expr2 = ""; if (series.kind === "points" && series.points === undefined)
                    series.points = ""; plotDetailsOpen.add(detailsKey); plotCardSignature = ""; debouncePlotCompile(); render(); };
                kindLabel.append(kindSelect);
                const defaults = kind === "fn" ? { min: object.axis.xmin, max: object.axis.xmax } : { min: 0, max: 2 * Math.PI }, dmin = field(uiText("Domain min", "定義域 最小"), series.domain === null ? "" : String(series.domain.min), "number", value => { var _a, _b; const n = Number(value); if (!value.trim())
                    series.domain = null;
                else if (Number.isFinite(n))
                    series.domain = { min: n, max: (_b = (_a = series.domain) === null || _a === void 0 ? void 0 : _a.max) !== null && _b !== void 0 ? _b : defaults.max }; }), dmax = field(uiText("Domain max", "定義域 最大"), series.domain === null ? "" : String(series.domain.max), "number", value => { var _a, _b; const n = Number(value); if (!value.trim())
                    series.domain = null;
                else if (Number.isFinite(n))
                    series.domain = { min: (_b = (_a = series.domain) === null || _a === void 0 ? void 0 : _a.min) !== null && _b !== void 0 ? _b : defaults.min, max: n }; }), samples = field(uiText("Steps", "分割数"), String(series.samples), "number", value => series.samples = Math.max(2, Math.floor(Number(value) || 2))), legend = field(uiText("Legend", "凡例"), series.legend, "text", value => series.legend = value), thick = document.createElement("label"), thickInput = document.createElement("input");
                dmin.input.placeholder = String(Number(defaults.min.toPrecision(4)));
                dmax.input.placeholder = String(Number(defaults.max.toPrecision(4)));
                dmin.input.dataset.noI18n = "";
                dmax.input.dataset.noI18n = "";
                thick.textContent = uiText("Thick", "太線");
                thickInput.type = "checkbox";
                thickInput.checked = series.thick;
                liveField(thickInput, () => series.thick = thickInput.checked);
                thick.append(thickInput);
                if (kind === "points")
                    dmin.row.hidden = dmax.row.hidden = samples.row.hidden = true;
                details.append(kindLabel, dmin.row, dmax.row, samples.row, legend.row, thick);
                more.onclick = () => { details.hidden = !details.hidden; if (details.hidden)
                    plotDetailsOpen.delete(detailsKey);
                else
                    plotDetailsOpen.add(detailsKey); };
                wrap.append(main, error, details);
                card.append(wrap);
                if (index === focusIndex)
                    requestAnimationFrame(() => { var _a; const editor = editors[0]; editor === null || editor === void 0 ? void 0 : editor.focus(); if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement)
                        editor.select();
                    else
                        try {
                            (_a = editor === null || editor === void 0 ? void 0 : editor.executeCommand) === null || _a === void 0 ? void 0 : _a.call(editor, "selectAll");
                        }
                        catch { } });
            });
            const add = document.createElement("button");
            add.type = "button";
            add.className = "pro-canvas-plot-add";
            add.textContent = uiText("＋ Add series", "＋ 系列を追加");
            add.onclick = () => { snapshot(false); object.series.push({ kind: "fn", expr: "", domain: null, samples: 100, color: PLOT_PALETTE[object.series.length % PLOT_PALETTE.length], thick: true, legend: "", visible: true }); plotCardSignature = ""; debouncePlotCompile(); render(); requestAnimationFrame(() => buildPlotCard(object, object.series.length - 1)); };
            card.append(add);
            const range = document.createElement("div");
            range.className = "pro-canvas-plot-range";
            const rangeTitle = document.createElement("span");
            rangeTitle.className = "pro-canvas-plot-range-title";
            rangeTitle.textContent = uiText("x range", "x 範囲");
            const xmin = field(uiText("Min", "最小"), String(Number(object.axis.xmin.toPrecision(4))), "number", v => { const n = Number(v); if (Number.isFinite(n) && n < object.axis.xmax)
                object.axis.xmin = n; }), xmax = field(uiText("to", "〜"), String(Number(object.axis.xmax.toPrecision(4))), "number", v => { const n = Number(v); if (Number.isFinite(n) && n > object.axis.xmin)
                object.axis.xmax = n; }), auto = document.createElement("label"), autoInput = document.createElement("input");
            auto.textContent = uiText("auto y", "y 自動");
            autoInput.type = "checkbox";
            autoInput.checked = object.axis.ymin === null || object.axis.ymax === null;
            autoInput.onchange = () => { snapshot(false); if (autoInput.checked) {
                object.axis.ymin = object.axis.ymax = null;
            }
            else {
                object.axis.ymin = -5;
                object.axis.ymax = 5;
            } plotCardSignature = ""; debouncePlotCompile(); render(); };
            auto.append(autoInput);
            const ymin = field("y:", object.axis.ymin === null ? "" : String(Number(object.axis.ymin.toPrecision(4))), "number", v => { const n = Number(v); if (Number.isFinite(n))
                object.axis.ymin = n; }), ymax = field(uiText("to", "〜"), object.axis.ymax === null ? "" : String(Number(object.axis.ymax.toPrecision(4))), "number", v => { const n = Number(v); if (Number.isFinite(n))
                object.axis.ymax = n; });
            [xmin, xmax, ymin, ymax].forEach(f => f.input.dataset.noI18n = "");
            xmin.input.dataset.plotRange = "xmin";
            xmax.input.dataset.plotRange = "xmax";
            ymin.input.dataset.plotRange = "ymin";
            ymax.input.dataset.plotRange = "ymax";
            ymin.input.disabled = ymax.input.disabled = autoInput.checked;
            if (autoInput.checked) {
                const values = object.series.filter(s => s.visible !== false).flatMap(s => previewSeries(s, object.axis.xmin, object.axis.xmax).pieces.flat().map(p => p.y)), r = autoRange(values);
                ymin.input.placeholder = String(Number(r.min.toPrecision(4)));
                ymax.input.placeholder = String(Number(r.max.toPrecision(4)));
            }
            range.append(rangeTitle, xmin.row, xmax.row, ymin.row, ymax.row, auto);
            (_a = (card.querySelector(".pro-canvas-plot-add") || card.lastElementChild)) === null || _a === void 0 ? void 0 : _a.before(range); // 系列ラッパの外に置く（中だと複数系列で「系列1専用の軸設定」に見え、is-muted も巻き添えになる）
            const hint = document.createElement("p");
            hint.textContent = uiText("On the curve: scroll to change the range · drag to pan · use the selection handles to scale", "曲線上: スクロールで範囲変更 / ドラッグで移動 / 選択ハンドルで拡大縮小");
            card.append(hint);
            const segments = (label, value, items, set) => { const row = document.createElement("div"); row.className = "pro-canvas-plot-segment-row"; row.append(document.createTextNode(label)); const group = document.createElement("span"); group.className = "pro-canvas-segments"; items.forEach(([key, text]) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.title = `${label}: ${text}`; b.classList.toggle("is-active", key === value); b.onclick = () => { snapshot(false); set(key); plotCardSignature = ""; debouncePlotCompile(); render(); }; group.append(b); }); row.append(group); card.append(row); };
            segments(uiText("Axis lines", "軸線"), object.axis.axisLines, [["none", uiText("Curve only", "曲線のみ")], ["box", uiText("Border", "枠")], ["middle", uiText("Center", "中央")], ["left", uiText("Bottom left", "左下")]], v => object.axis.axisLines = v);
            segments(uiText("Grid", "グリッド"), object.axis.grid, [["none", uiText("None", "なし")], ["major", uiText("Major", "主")], ["both", uiText("Major+minor", "主+副")]], v => object.axis.grid = v);
            const eqRow = document.createElement("label");
            eqRow.className = "pro-canvas-plot-equal";
            const eqInput = document.createElement("input");
            eqInput.type = "checkbox";
            eqInput.checked = Boolean(object.axis.equal);
            eqInput.onchange = () => { snapshot(false); object.axis.equal = eqInput.checked || undefined; debouncePlotCompile(); render(); };
            eqRow.append(eqInput, document.createTextNode(uiText(" Equal scale (axis equal)", " 等尺 (axis equal)")));
            card.append(eqRow);
            const disclosure = document.createElement("details"), summary = document.createElement("summary");
            summary.textContent = uiText("Details", "詳細");
            disclosure.append(summary);
            for (const [label, key] of [[uiText("x label", "x ラベル"), "xlabel"], [uiText("y label", "y ラベル"), "ylabel"], [uiText("Title", "タイトル"), "title"]]) {
                const f = field(label, object.axis[key], "text", v => object.axis[key] = v);
                disclosure.append(f.row);
            }
            card.append(disclosure);
            overlay.append(card);
            plotCard = card;
            plotCardSignature = `${object.id}:${object.series.length}:${object.series.map(plotKind).join(",")}:${autoInput.checked}:${object.axis.axisLines}:${object.axis.grid}`;
            requestAnimationFrame(positionPlotCard);
        };
        const topLevelSelectedObjects = () => currentObjects().filter(object => selection.ids.has(object.id));
        const selectionBounds = () => { const selected = topLevelSelectedObjects(); if (!selected.length)
            return null; const bounds = selected.map(object => objectBounds(object, scene)); return { minX: Math.min(...bounds.map(b => b.minX)), minY: Math.min(...bounds.map(b => b.minY)), maxX: Math.max(...bounds.map(b => b.maxX)), maxY: Math.max(...bounds.map(b => b.maxY)) }; };
        const changeOrder = (mode) => { const objects = currentObjects(), selected = objects.filter(o => selection.ids.has(o.id)); if (!selected.length)
            return; snapshot(); if (mode === "front" || mode === "back") {
            const rest = objects.filter(o => !selection.ids.has(o.id));
            objects.splice(0, objects.length, ...(mode === "front" ? [...rest, ...selected] : [...selected, ...rest]));
        }
        else if (mode === "forward") {
            for (let i = objects.length - 2; i >= 0; i--)
                if (selection.ids.has(objects[i].id) && !selection.ids.has(objects[i + 1].id))
                    [objects[i], objects[i + 1]] = [objects[i + 1], objects[i]];
        }
        else
            for (let i = 1; i < objects.length; i++)
                if (selection.ids.has(objects[i].id) && !selection.ids.has(objects[i - 1].id))
                    [objects[i], objects[i - 1]] = [objects[i - 1], objects[i]]; render(); };
        const replaceSelectedId = (oldId, newId) => { if (!selection.ids.delete(oldId))
            return; selection.ids.add(newId); if (selection.primaryId === oldId)
            selection.primaryId = newId; };
        const editCode = (object) => { const pop = document.createElement("div"); pop.className = "pro-canvas-code-popover"; const area = document.createElement("textarea"); area.rows = 9; area.placeholder = "\\draw (0,0) -- (10,10);"; area.dataset.noI18n = ""; area.value = object.tikz; const save = document.createElement("button"); save.className = "is-primary"; save.textContent = uiText("Apply", "適用"); save.onclick = () => { snapshot(); object.tikz = stripTikzWrapper(area.value); window.removeEventListener("keydown", onPopKey, true); pop.remove(); render(); scheduleCompile(); }; const onPopKey = (e) => { if (e.key !== "Escape" || !pop.isConnected)
            return; e.preventDefault(); e.stopImmediatePropagation(); dismiss(); }; const dismiss = () => { window.removeEventListener("keydown", onPopKey, true); pop.remove(); if (!object.tikz.trim()) {
            removeById(currentObjects(), object.id);
            clearSelection();
            render();
        } }; window.addEventListener("keydown", onPopKey, true); const cancel = document.createElement("button"); cancel.textContent = uiText("Cancel", "キャンセル"); cancel.onclick = dismiss; pop.append(area, save, cancel); overlay.append(pop); area.focus(); };
        let stageObserver = null;
        let colorPop = null, canvasPop = null;
        const closeColorPop = () => { colorPop === null || colorPop === void 0 ? void 0 : colorPop.remove(); colorPop = null; };
        const closeCanvasPop = () => { var _a; canvasPop === null || canvasPop === void 0 ? void 0 : canvasPop.remove(); canvasPop = null; (_a = overlay.querySelector("[data-action=canvas-settings]")) === null || _a === void 0 ? void 0 : _a.setAttribute("aria-expanded", "false"); };
        const fillMemory = new Map();
        const presets = ["#000000", "#ffffff", "#6b7280", "#dc2626", "#ea580c", "#eab308", "#16a34a", "#2563eb", "#4f46e5", "#9333ea", "#ec4899", "#92400e", "#0891b2", "#65a30d", "#64748b", "#1e3a8a"], recentKey = "tex64.proCanvas.recentColors.v1", recent = () => { try {
            return JSON.parse(localStorage.getItem(recentKey) || "[]").filter((v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)).slice(0, 8);
        }
        catch {
            return [];
        } }, remember = (v) => localStorage.setItem(recentKey, JSON.stringify([v, ...recent().filter(c => c.toLowerCase() !== v.toLowerCase())].slice(0, 8)));
        const colorWell = (label, get, set, allowNone) => { const wrap = document.createElement("label"), button = document.createElement("button"); wrap.className = "pro-canvas-color-field"; wrap.append(document.createTextNode(label)); button.type = "button"; button.className = "pro-canvas-color-well"; button.title = label; button.dataset.noI18n = ""; button.setAttribute("aria-label", label); const value = get(); if (value)
            button.style.background = value;
        else
            button.classList.add("is-none"); button.onclick = e => { e.stopPropagation(); closeColorPop(); const pop = document.createElement("div"); pop.className = "pro-canvas-color-pop"; pop.addEventListener("pointerdown", ev => ev.stopPropagation()); pop.addEventListener("keydown", ev => { if (ev.key === "Escape") {
            ev.stopPropagation();
            closeColorPop();
        } }); const choose = (v) => { snapshot(false); if (v)
            remember(v); set(v); render(); scheduleCompile(); }, grid = document.createElement("div"); grid.className = "pro-canvas-color-grid"; const currentValue = (get() || "").toLowerCase(); [...presets, ...recent().filter(c => !presets.includes(c))].forEach(c => { const b = document.createElement("button"); b.type = "button"; b.title = c; b.dataset.noI18n = ""; b.style.background = c; if (c.toLowerCase() === currentValue)
            b.classList.add("is-active"); b.onclick = () => choose(c); grid.append(b); }); pop.append(grid); const picker = document.createElement("input"); picker.type = "color"; picker.value = value || "#000000"; picker.title = uiText("Color picker", "カラーピッカー"); picker.dataset.noI18n = ""; let pickerPushed = false; picker.oninput = () => { if (!pickerPushed) {
            snapshot(false);
            pickerPushed = true;
        } set(picker.value); render(); scheduleCompile(); }; picker.onchange = () => { remember(picker.value); }; pop.append(picker); if (allowNone) {
            const none = document.createElement("button");
            none.type = "button";
            none.textContent = uiText("None", "なし");
            none.onclick = () => choose(null);
            pop.append(none);
        } pop.addEventListener("click", ev => { if (ev.target === pop)
            closeColorPop(); }); overlay.append(pop); colorPop = pop; const r = button.getBoundingClientRect(), pw = pop.offsetWidth || 202; let px = r.left - pw - 10; if (px < 8)
            px = Math.min(innerWidth - pw - 8, r.right + 10); pop.style.left = `${px}px`; pop.style.top = `${Math.max(8, Math.min(innerHeight - (pop.offsetHeight || 260) - 8, r.top - 6))}px`; }; wrap.append(button); return wrap; };
        overlay.addEventListener("pointerdown", e => { if (canvasPop && !canvasPop.contains(e.target) && !e.target.closest("[data-action=canvas-settings]"))
            closeCanvasPop(); if (!colorPop || colorPop.contains(e.target) || e.target.closest(".pro-canvas-color-well"))
            return; closeColorPop(); if (e.target.closest(".pro-canvas-stage")) {
            e.preventDefault();
            e.stopPropagation();
        } }, true);
        const openCanvasSettings = (button) => {
            if (canvasPop) {
                closeCanvasPop();
                return;
            }
            closeColorPop();
            const pop = document.createElement("div");
            pop.className = "pro-canvas-canvas-popover";
            pop.setAttribute("role", "dialog");
            pop.setAttribute("aria-label", uiText("Canvas settings", "キャンバス設定"));
            pop.addEventListener("pointerdown", e => e.stopPropagation());
            pop.addEventListener("keydown", e => { if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeCanvasPop();
                button.focus();
            } });
            const heading = document.createElement("div");
            heading.className = "pro-canvas-canvas-popover-title";
            heading.textContent = uiText("Canvas settings", "キャンバス設定");
            const closeButton = document.createElement("button");
            closeButton.type = "button";
            closeButton.textContent = "✕";
            closeButton.title = uiText("Close", "閉じる");
            closeButton.onclick = () => closeCanvasPop();
            heading.append(closeButton);
            pop.append(heading);
            const sizeTitle = document.createElement("strong");
            sizeTitle.textContent = uiText("Canvas coordinates", "キャンバス座標");
            const dimensions = document.createElement("div");
            dimensions.className = "pro-canvas-canvas-dimensions";
            const inputs = {};
            let refresh = () => { };
            const numberField = (labelText, key) => { const label = document.createElement("label"), input = document.createElement("input"), unit = document.createElement("span"); label.append(document.createTextNode(labelText)); input.type = "number"; input.min = "0.1"; input.max = "10000"; input.step = scene.unit === "pt" ? "1" : "0.1"; input.dataset.canvasDimension = key; unit.textContent = scene.unit; label.append(input, unit); inputs[key] = input; input.onchange = () => { const next = normalizeCanvasMeasurement(input.value, scene[key]); if (next === scene[key]) {
                input.value = String(scene[key]);
                return;
            } snapshot(false); scene[key] = next; zoom = 1; panX = panY = 0; refresh(); render(); scheduleCompile(); }; return label; };
            dimensions.append(numberField(uiText("Width", "幅"), "width"), numberField(uiText("Height", "高さ"), "height"));
            const gridTitle = document.createElement("strong");
            gridTitle.textContent = uiText("Grid spacing", "グリッド間隔");
            const gridRow = document.createElement("div");
            gridRow.className = "pro-canvas-canvas-grid";
            const gridInput = document.createElement("input"), gridUnit = document.createElement("span"), gridPresets = document.createElement("div");
            gridInput.type = "number";
            gridInput.min = "0.1";
            gridInput.max = "10000";
            gridInput.step = scene.unit === "pt" ? "1" : "0.1";
            gridInput.dataset.canvasGrid = "";
            gridUnit.textContent = scene.unit;
            gridPresets.className = "pro-canvas-canvas-grid-presets";
            [1, 2, 5, 10].forEach(value => { const item = document.createElement("button"); item.type = "button"; item.textContent = String(value); item.dataset.gridPreset = String(value); item.onclick = () => { if (scene.grid.size === value)
                return; snapshot(false); scene.grid.size = value; refresh(); render(); scheduleCompile(); }; gridPresets.append(item); });
            gridInput.onchange = () => { const next = normalizeCanvasMeasurement(gridInput.value, scene.grid.size); if (next === scene.grid.size) {
                gridInput.value = String(scene.grid.size);
                return;
            } snapshot(false); scene.grid.size = next; refresh(); render(); scheduleCompile(); };
            gridRow.append(gridInput, gridUnit, gridPresets);
            const outputTitle = document.createElement("strong");
            outputTitle.textContent = uiText("Width on the page", "紙面上の幅");
            const outputRow = document.createElement("div");
            outputRow.className = "pro-canvas-output-width";
            const outputMode = document.createElement("select"), outputValue = document.createElement("input");
            outputMode.title = uiText("Width reference", "幅の基準");
            outputMode.add(new Option(uiText("Natural size", "実寸（指定なし）"), "natural"));
            for (const reference of ["linewidth", "textwidth", "columnwidth"])
                outputMode.add(new Option(`\\${reference}`, reference));
            outputValue.type = "number";
            outputValue.min = "0.01";
            outputValue.max = "10";
            outputValue.step = "0.05";
            outputValue.title = uiText("Multiplier", "倍率");
            const setOutput = () => { snapshot(false); if (outputMode.value === "natural")
                scene.outputWidth = { mode: "natural" };
            else
                scene.outputWidth = { mode: "relative", value: Math.max(.01, Math.min(10, Number(outputValue.value) || 1)), reference: outputMode.value }; refresh(); render(); scheduleCompile(); };
            outputMode.onchange = setOutput;
            outputValue.onchange = setOutput;
            outputRow.append(outputValue, outputMode);
            const note = document.createElement("p");
            note.textContent = uiText("Canvas coordinates control drawing space. Page width can independently use 0.8\\linewidth, \\textwidth, and similar LaTeX-relative widths.", "キャンバス座標は作図空間です。紙面上の幅は 0.8\\linewidth や \\textwidth などで独立して指定できます。");
            pop.append(sizeTitle, dimensions, gridTitle, gridRow, outputTitle, outputRow, note);
            overlay.append(pop);
            canvasPop = pop;
            button.setAttribute("aria-expanded", "true");
            refresh = () => { inputs.width.value = String(Number(scene.width.toFixed(4))); inputs.height.value = String(Number(scene.height.toFixed(4))); gridInput.value = String(Number(scene.grid.size.toFixed(4))); gridPresets.querySelectorAll("[data-grid-preset]").forEach(item => item.classList.toggle("is-active", Number(item.dataset.gridPreset) === scene.grid.size)); const output = scene.outputWidth || { mode: "natural" }; outputMode.value = output.mode === "relative" ? output.reference : "natural"; outputValue.value = String(output.mode === "relative" ? output.value : 1); outputValue.disabled = output.mode !== "relative"; };
            refresh();
            const rect = button.getBoundingClientRect();
            pop.style.top = `${rect.bottom + 8}px`;
            pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, rect.right - pop.offsetWidth))}px`;
        };
        const removeNodeMenu = () => { nodeMenu === null || nodeMenu === void 0 ? void 0 : nodeMenu.remove(); nodeMenu = null; };
        const syncNodeMenu = () => {
            var _a, _b;
            removeNodeMenu();
            const object = selection.ids.size === 1 ? nodeById(selection.primaryId) : null;
            if (!nodeMiniMenuVisible(tool, selection.ids.size, object, editingNodeId, Boolean(drag)))
                return;
            const menu = document.createElement("div");
            menu.className = "pro-canvas-node-menu";
            menu.dataset.role = "node-mini-menu";
            menu.dataset.objectId = object.id;
            menu.setAttribute("role", "dialog");
            menu.setAttribute("aria-label", uiText("Math label settings", "数式ラベル設定"));
            menu.addEventListener("pointerdown", e => e.stopPropagation());
            menu.addEventListener("click", e => e.stopPropagation());
            const apply = (change) => { const refocus = editingNodeId === object.id && nodeEditor; snapshot(false); change(); render(); scheduleCompile(); if (refocus)
                requestAnimationFrame(() => nodeEditor === null || nodeEditor === void 0 ? void 0 : nodeEditor.focus()); };
            const anchorSection = document.createElement("div");
            anchorSection.className = "pro-canvas-node-menu-anchor";
            const anchorGrid = document.createElement("div");
            anchorGrid.className = "pro-canvas-node-anchor-grid";
            anchorGrid.dataset.role = "node-anchor";
            anchorGrid.setAttribute("role", "radiogroup");
            anchorGrid.setAttribute("aria-label", uiText("Label anchor", "ラベルのアンカー"));
            NODE_ANCHORS.forEach((item, index) => { const button = document.createElement("button"); button.type = "button"; button.dataset.anchor = item.value; button.dataset.anchorGroup = index < 9 ? "compass" : item.value.split(" ")[0]; button.title = `${item.value} — ${uiText(item.en, item.ja)}`; button.setAttribute("aria-label", button.title); button.setAttribute("role", "radio"); button.setAttribute("aria-checked", String(object.anchor === item.value)); button.classList.toggle("is-active", object.anchor === item.value); button.innerHTML = '<span aria-hidden="true"></span>'; button.onclick = () => { if (object.anchor !== item.value)
                apply(() => object.anchor = item.value); }; anchorGrid.append(button); });
            anchorSection.append(anchorGrid);
            const fontSection = document.createElement("div");
            fontSection.className = "pro-canvas-node-menu-font";
            const fontTitle = document.createElement("strong");
            fontTitle.textContent = uiText("Font", "フォント");
            fontSection.append(fontTitle);
            const segment = (label, role, value, items, change) => { const row = document.createElement("div"); row.className = "pro-canvas-node-font-row"; const caption = document.createElement("span"); caption.textContent = label; const buttons = document.createElement("span"); buttons.className = "pro-canvas-segments"; buttons.dataset.role = role; items.forEach(item => { const button = document.createElement("button"); button.type = "button"; button.textContent = uiText(item.en, item.ja); button.classList.toggle("is-active", item.value === value); button.onclick = () => { if (item.value !== value)
                apply(() => change(item.value)); }; buttons.append(button); }); row.append(caption, buttons); return row; };
            const sizeRow = document.createElement("label"), size = document.createElement("select");
            sizeRow.className = "pro-canvas-node-font-row";
            sizeRow.append(document.createTextNode(uiText("Size", "サイズ")));
            size.dataset.role = "node-font-size";
            NODE_FONT_SIZES.forEach(item => size.add(new Option(item.label, item.value)));
            size.value = object.fontSize || "normal";
            size.onchange = () => apply(() => object.fontSize = size.value);
            sizeRow.append(size);
            const effectiveMono = (_a = object.monospace) !== null && _a !== void 0 ? _a : object.fontFamily === "mono";
            fontSection.append(sizeRow, segment(uiText("Shape", "字形"), "node-font-shape", nodeFontShapeChoice(object.fontShape), NODE_FONT_SHAPES, value => { object.fontShape = value; if (value === "italic" && effectiveMono) {
                object.monospace = false;
                object.fontFamily = "default";
            } }), segment(uiText("Weight", "太さ"), "node-font-weight", object.fontWeight || "normal", NODE_FONT_WEIGHTS, value => object.fontWeight = value), segment(uiText("Spacing", "字幅"), "node-font-spacing", effectiveMono ? "mono" : "proportional", [{ value: "proportional", en: "Proportional", ja: "通常" }, { value: "mono", en: "Mono", ja: "等幅" }], value => { object.monospace = value === "mono"; object.fontFamily = "default"; if (value === "mono" && object.fontShape === "italic")
                object.fontShape = "upright"; }));
            menu.append(anchorSection, fontSection);
            overlay.append(menu);
            nodeMenu = menu;
            const rendered = svg.querySelector(`[data-role="node-render"][data-object-id="${CSS.escape(object.id)}"]`), point = sceneToScreen(object.at, view()), target = (_b = rendered === null || rendered === void 0 ? void 0 : rendered.getBoundingClientRect()) !== null && _b !== void 0 ? _b : { left: point.x, right: point.x, top: point.y, bottom: point.y, width: 0, height: 0, x: point.x, y: point.y, toJSON: () => ({}) }, stageRect = stage.getBoundingClientRect(), gap = 10, width = menu.offsetWidth, height = menu.offsetHeight;
            let left = (target.left + target.right - width) / 2, top = target.top - height - gap;
            if (top < stageRect.top + 8)
                top = target.bottom + gap;
            left = Math.max(stageRect.left + 8, Math.min(stageRect.right - width - 8, left));
            top = Math.max(stageRect.top + 8, Math.min(stageRect.bottom - height - 8, top));
            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
        };
        const renderInspector = () => {
            var _a, _b;
            const geometry = overlay.querySelector(".pro-canvas-geometry");
            const host = overlay.querySelector(".pro-canvas-style");
            const emptyNote = overlay.querySelector(".pro-canvas-inspector-empty");
            const oneId = selectedIdOne(), object = oneId ? walk(currentObjects(), oneId) : null, styleObjects = [], collect = (item) => { if (item.type === "group")
                item.children.forEach(collect);
            else if (item.type !== "code" && item.type !== "plot")
                styleObjects.push(item); };
            topLevelSelectedObjects().forEach(collect);
            const targets = styleObjects;
            geometry.replaceChildren();
            host.replaceChildren();
            emptyNote.hidden = true;
            emptyNote.textContent = "";
            overlay.querySelector(".pro-canvas-geometry-section").hidden = !selection.ids.size;
            overlay.querySelector(".pro-canvas-style-section").hidden = !targets.length && !object;
            if (object) {
                const b = objectBounds(object, scene), values = [b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY];
                ["X", "Y", "W", "H"].forEach((label, index) => { const row = document.createElement("label"), input = document.createElement("input"); row.textContent = label; input.type = "number"; input.step = "0.1"; input.value = String(Number(values[index].toFixed(3))); input.onchange = () => { const value = Number(input.value); if (!Number.isFinite(value) || (index >= 2 && value < .01)) {
                    input.value = String(Number(values[index].toFixed(3)));
                    return;
                } snapshot(); const before = objectBounds(object, scene); if (index < 2)
                    moveObject(object, index === 0 ? value - before.minX : 0, index === 1 ? value - before.minY : 0);
                else
                    resizeObject(object, before, index === 2 ? { ...before, maxX: before.minX + value } : { ...before, maxY: before.minY + value }); render(); }; row.append(input); geometry.append(row); });
            }
            const selected = topLevelSelectedObjects();
            if (selected.length > 1) {
                const bar = document.createElement("div");
                bar.className = "pro-canvas-command-grid";
                const modes = [[['left', uiText("Align left", "左揃え")], ['centerX', uiText("Center horizontally", "左右中央")]], [['right', uiText("Align right", "右揃え")], ['top', uiText("Align top", "上揃え")]], [['centerY', uiText("Center vertically", "上下中央")], ['bottom', uiText("Align bottom", "下揃え")]], [['distributeX', uiText("Distribute horizontally", "横等間隔")], ['distributeY', uiText("Distribute vertically", "縦等間隔")]]], icons = { left: '<line x1="3" y1="2" x2="3" y2="14"/><line x1="3" y1="5" x2="12" y2="5"/><line x1="3" y1="11" x2="9" y2="11"/>', centerX: '<line x1="8" y1="2" x2="8" y2="14"/><line x1="3" y1="5" x2="13" y2="5"/><line x1="5" y1="11" x2="11" y2="11"/>', right: '<line x1="13" y1="2" x2="13" y2="14"/><line x1="4" y1="5" x2="13" y2="5"/><line x1="7" y1="11" x2="13" y2="11"/>', top: '<line x1="2" y1="3" x2="14" y2="3"/><line x1="5" y1="3" x2="5" y2="12"/><line x1="11" y1="3" x2="11" y2="9"/>', centerY: '<line x1="2" y1="8" x2="14" y2="8"/><line x1="5" y1="3" x2="5" y2="13"/><line x1="11" y1="5" x2="11" y2="11"/>', bottom: '<line x1="2" y1="13" x2="14" y2="13"/><line x1="5" y1="4" x2="5" y2="13"/><line x1="11" y1="7" x2="11" y2="13"/>', distributeX: '<rect x="2" y="3" width="2" height="10"/><rect x="7" y="3" width="2" height="10"/><rect x="12" y="3" width="2" height="10"/>', distributeY: '<rect x="3" y="2" width="10" height="2"/><rect x="3" y="7" width="10" height="2"/><rect x="3" y="12" width="10" height="2"/>' };
                modes.flat().forEach(([mode, title]) => { const button = document.createElement("button"); button.title = title; button.setAttribute("aria-label", title); button.dataset.align = mode; button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${icons[mode]}</svg>`; button.disabled = mode.startsWith("distribute") && selected.length < 3; button.onclick = () => { snapshot(); const bs = selected.map(o => objectBounds(o, scene)), deltas = mode === "distributeX" || mode === "distributeY" ? distributeDeltas(bs, mode === "distributeX" ? "x" : "y") : alignDeltas(bs, mode); selected.forEach((o, i) => moveObject(o, deltas[i].x, deltas[i].y)); render(); }; bar.append(button); });
                geometry.append(bar);
            }
            if (selected.length) {
                const order = document.createElement("div");
                order.className = "pro-canvas-command-grid";
                const icons = { front: '<rect x="3" y="5" width="8" height="8"/><rect x="6" y="2" width="7" height="7" style="fill:currentColor"/>', forward: '<rect x="3" y="5" width="8" height="8"/><rect x="6" y="2" width="7" height="7" style="fill:currentColor;fill-opacity:.55"/>', backward: '<rect x="6" y="2" width="7" height="7"/><rect x="3" y="5" width="8" height="8" style="fill:currentColor;fill-opacity:.55"/>', back: '<rect x="6" y="2" width="7" height="7"/><rect x="3" y="5" width="8" height="8" style="fill:currentColor"/>' };
                [['front', uiText("Bring to front", "最前面")], ['forward', uiText("Bring forward", "前面へ")], ['backward', uiText("Send backward", "背面へ")], ['back', uiText("Send to back", "最背面")]].forEach(([mode, title]) => { const button = document.createElement("button"); button.title = title; button.setAttribute("aria-label", title); button.dataset.order = mode; button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${icons[mode]}</svg>`; button.onclick = () => changeOrder(mode); order.append(button); });
                geometry.append(order);
            }
            if (!object && !targets.length) {
                emptyNote.hidden = false;
                emptyNote.textContent = selection.ids.size ? uiText(`${selection.ids.size} selected`, `${selection.ids.size} 個を選択中`) : uiText("Select an object", "オブジェクトを選択してください");
            }
            else if (!targets.length && (object === null || object === void 0 ? void 0 : object.type) === "plot") {
                const hint = document.createElement("p");
                hint.className = "pro-canvas-empty";
                hint.textContent = uiText("Double-click to edit the graph", "ダブルクリックでグラフを編集");
                host.append(hint);
            }
            else if (!targets.length && (object === null || object === void 0 ? void 0 : object.type) === "code") {
                const note = document.createElement("div");
                note.textContent = "Double-click to edit TikZ code";
                host.append(note);
            }
            else if (targets.length) {
                const effective = resolveStyle(scene, targets[0].style), apply = (key, value, only = targets) => { snapshot(false); only.forEach(target => target.style.props = { ...(target.style.props || {}), [key]: value }); render(); scheduleCompile(); }, seg = (value, items, set) => { const group = document.createElement("span"); group.className = "pro-canvas-segments"; items.forEach(([key, text, icon]) => { const b = document.createElement("button"); b.type = "button"; b.title = text; b.dataset.noI18n = ""; b.classList.toggle("is-active", key === value); if (icon)
                    b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${icon}</svg>`;
                else
                    b.textContent = text; b.onclick = () => set(key); group.append(b); }); return group; };
                if (targets.length > 1) {
                    const badge = document.createElement("span");
                    badge.className = "pro-canvas-style-badge";
                    badge.textContent = uiText(`Applies to ${targets.length}`, `${targets.length} 個に適用`);
                    host.append(badge);
                }
                const line = document.createElement("div");
                line.className = "pro-canvas-style-line";
                line.append(colorWell(uiText("Stroke", "線"), () => { var _a; return (_a = effective.draw) !== null && _a !== void 0 ? _a : null; }, v => targets.forEach(t => { var _a; return ((_a = t.style).props || (_a.props = {})).draw = v; }), true));
                const widthUnit = document.createElement("span");
                widthUnit.className = "pro-canvas-unit";
                widthUnit.textContent = "pt";
                const width = document.createElement("input");
                width.type = "number";
                width.min = "0";
                width.step = "0.2";
                width.value = String((_a = effective.lineWidthPt) !== null && _a !== void 0 ? _a : .4);
                width.title = uiText("Line width (pt)", "線幅 (pt)");
                width.dataset.noI18n = "";
                width.onchange = () => apply("lineWidthPt", Math.max(0, Number(width.value) || 0));
                line.append(width, widthUnit, seg(effective.dash || "solid", [["solid", uiText("Solid", "実線"), '<line x1="2" y1="8" x2="14" y2="8"/>'], ["dashed", uiText("Dashed", "破線"), '<line x1="2" y1="8" x2="14" y2="8" stroke-dasharray="4 2"/>'], ["dotted", uiText("Dotted", "点線"), '<line x1="2" y1="8" x2="14" y2="8" stroke-dasharray="1 2"/>']], v => apply("dash", v)));
                host.append(line);
                const paths = targets.filter((t) => t.type === "path");
                if (paths.length) {
                    const first = resolveStyle(scene, paths[0].style), mixedTips = Boolean(first.arrowStart && first.arrowEnd && first.arrowStart !== first.arrowEnd), shape = first.arrowStart || first.arrowEnd || "Stealth", arrowRow = document.createElement("div");
                    arrowRow.className = "pro-canvas-style-row";
                    const state = first.arrowStart && first.arrowEnd ? "both" : first.arrowStart ? "start" : first.arrowEnd ? "end" : "none", arrowIcon = '<line x1="2" y1="8" x2="14" y2="8"/><path d="M11 5l3 3-3 3"/>';
                    const select = document.createElement("select");
                    ["Stealth", "Latex", "Bar"].forEach(v => select.add(new Option(v, v)));
                    if (mixedTips) {
                        const option = new Option(uiText("Mixed", "混在"), "__mixed");
                        select.add(option, 0);
                    }
                    select.value = mixedTips ? "__mixed" : shape;
                    select.title = mixedTips ? uiText("The start and end arrow heads differ (choosing one applies it to both)", "始点と終点で矢頭が異なります（選ぶと両端に適用）") : uiText("Arrow head", "矢頭の形");
                    select.dataset.noI18n = "";
                    select.onchange = () => { if (state === "none" || select.value === "__mixed")
                        return; snapshot(false); paths.forEach(p => { var _a; const props = (_a = p.style).props || (_a.props = {}); if (props.arrowStart)
                        props.arrowStart = select.value; if (props.arrowEnd)
                        props.arrowEnd = select.value; }); render(); scheduleCompile(); };
                    arrowRow.append(document.createTextNode(uiText("Arrows", "矢印")), seg(state, [["none", "—", '<line x1="2" y1="8" x2="14" y2="8"/>'], ["end", "→", arrowIcon], ["start", "←", '<line x1="2" y1="8" x2="14" y2="8"/><path d="M5 5L2 8l3 3"/>'], ["both", "↔", '<line x1="2" y1="8" x2="14" y2="8"/><path d="M5 5L2 8l3 3M11 5l3 3-3 3"/>']], v => { const tip = (select.value === "__mixed" ? shape : select.value || "Stealth"); snapshot(false); paths.forEach(p => { var _a; const props = (_a = p.style).props || (_a.props = {}); props.arrowStart = v === "start" || v === "both" ? tip : ""; props.arrowEnd = v === "end" || v === "both" ? tip : ""; }); render(); scheduleCompile(); }), select);
                    host.append(arrowRow);
                }
                const mode = effective.shading ? "gradient" : effective.pattern ? "pattern" : effective.fill ? "solid" : "none", fillSeg = document.createElement("div");
                fillSeg.className = "pro-canvas-fill-seg";
                fillSeg.append(document.createTextNode(uiText("Fill", "塗り")), seg(mode, [["none", uiText("None", "なし")], ["solid", uiText("Solid color", "単色")], ["pattern", uiText("Hatch", "編みかけ")], ["gradient", uiText("Gradient", "グラデ")]], v => { snapshot(false); targets.forEach(t => { var _a, _b, _c; var _d; const p = (_d = t.style).props || (_d.props = {}); const mem = { ...fillMemory.get(t.id) }; if (p.fill != null)
                    mem.fill = p.fill; if (p.pattern)
                    mem.pattern = p.pattern; if (p.shading)
                    mem.shading = p.shading; fillMemory.set(t.id, mem); if (v === "none") {
                    p.fill = null;
                    p.pattern = null;
                    p.shading = null;
                }
                else if (v === "solid") {
                    p.pattern = null;
                    p.shading = null;
                    if (!p.fill)
                        p.fill = (_a = mem.fill) !== null && _a !== void 0 ? _a : "#dbeafe";
                }
                else if (v === "pattern") {
                    p.shading = null;
                    p.pattern || (p.pattern = (_b = mem.pattern) !== null && _b !== void 0 ? _b : { name: "north east lines" });
                }
                else {
                    p.pattern = null;
                    p.shading || (p.shading = (_c = mem.shading) !== null && _c !== void 0 ? _c : { kind: "axis", top: "#93c5fd", bottom: "#1d4ed8" });
                } }); render(); scheduleCompile(); }));
                host.append(fillSeg);
                if (mode === "solid")
                    host.append(colorWell(uiText("Color", "色"), () => { var _a; return (_a = effective.fill) !== null && _a !== void 0 ? _a : "#dbeafe"; }, v => targets.forEach(t => { var _a; return ((_a = t.style).props || (_a.props = {})).fill = v; }), false));
                else if (mode === "pattern") {
                    const names = ["horizontal lines", "vertical lines", "north east lines", "north west lines", "grid", "crosshatch", "dots", "crosshatch dots"], grid = document.createElement("div");
                    grid.className = "pro-canvas-pattern-grid";
                    names.forEach(name => { var _a; const b = document.createElement("button"); b.type = "button"; b.title = name; b.dataset.noI18n = ""; b.classList.toggle("is-active", ((_a = effective.pattern) === null || _a === void 0 ? void 0 : _a.name) === name); const patIcons = { "horizontal lines": '<path d="M0 6h34M0 13h34M0 20h34"/>', "vertical lines": '<path d="M8 0v26M17 0v26M26 0v26"/>', "north east lines": '<path d="M0 26L26 0M10 26L34 2M0 16L16 0"/>', "north west lines": '<path d="M0 0L26 26M10 0L34 24M0 10L16 26"/>', grid: '<path d="M0 8h34M0 18h34M10 0v26M22 0v26"/>', crosshatch: '<path d="M0 26L26 0M10 26L34 2M0 12L12 0M0 0L26 26M10 0L34 24M0 14L12 26"/>', dots: '<circle cx="7" cy="7" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="7" r="1.7" fill="currentColor" stroke="none"/><circle cx="31" cy="7" r="1.7" fill="currentColor" stroke="none"/><circle cx="13" cy="17" r="1.7" fill="currentColor" stroke="none"/><circle cx="25" cy="17" r="1.7" fill="currentColor" stroke="none"/><circle cx="7" cy="17" r="1.7" fill="currentColor" stroke="none"/>', "crosshatch dots": '<circle cx="5" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="13" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="21" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="29" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none"/><circle cx="17" cy="13" r="1.2" fill="currentColor" stroke="none"/><circle cx="25" cy="13" r="1.2" fill="currentColor" stroke="none"/><circle cx="5" cy="21" r="1.2" fill="currentColor" stroke="none"/><circle cx="13" cy="21" r="1.2" fill="currentColor" stroke="none"/><circle cx="21" cy="21" r="1.2" fill="currentColor" stroke="none"/><circle cx="29" cy="21" r="1.2" fill="currentColor" stroke="none"/>' }; b.innerHTML = `<svg viewBox="0 0 34 26">${patIcons[name]}</svg>`; b.onclick = () => apply("pattern", { ...(effective.pattern || {}), name }); grid.append(b); });
                    host.append(grid, colorWell(uiText("Pattern color", "パターン色"), () => { var _a; return ((_a = effective.pattern) === null || _a === void 0 ? void 0 : _a.color) || effective.draw || "#000000"; }, v => { var _a; return apply("pattern", { name: ((_a = effective.pattern) === null || _a === void 0 ? void 0 : _a.name) || "north east lines", ...(v ? { color: v } : {}) }); }, false), colorWell(uiText("Base color", "下地色"), () => { var _a; return (_a = effective.fill) !== null && _a !== void 0 ? _a : null; }, v => targets.forEach(t => { var _a; return ((_a = t.style).props || (_a.props = {})).fill = v; }), true));
                }
                else if (mode === "gradient" && effective.shading) {
                    const s = effective.shading, grad = document.createElement("div");
                    grad.className = "pro-canvas-gradient-controls";
                    grad.append(seg(s.kind, [['axis', uiText("Linear", "線形")], ['radial', uiText("Radial", "放射")]], v => apply("shading", v === "axis" ? { kind: "axis", top: s.kind === "axis" ? s.top : s.inner, bottom: s.kind === "axis" ? s.bottom : s.outer } : { kind: "radial", inner: s.kind === "radial" ? s.inner : s.top, outer: s.kind === "radial" ? s.outer : s.bottom })));
                    if (s.kind === "axis") {
                        grad.append(colorWell(uiText("Top", "上"), () => s.top, v => v && apply("shading", { ...s, top: v }), false), colorWell(uiText("Bottom", "下"), () => s.bottom, v => v && apply("shading", { ...s, bottom: v }), false), seg(String(s.angle || 0), [["0", "0°"], ["45", "45°"], ["90", "90°"], ["135", "135°"]], v => apply("shading", { ...s, angle: Number(v) })));
                    }
                    else
                        grad.append(colorWell(uiText("Inside", "内"), () => s.inner, v => v && apply("shading", { ...s, inner: v }), false), colorWell(uiText("Outside", "外"), () => s.outer, v => v && apply("shading", { ...s, outer: v }), false));
                    host.append(grad);
                }
                const details = document.createElement("details"), summary = document.createElement("summary");
                summary.textContent = uiText("Details", "詳細");
                details.append(summary);
                const fields = [[uiText("Opacity", "不透明度"), "opacity", "number"], [uiText("Corner radius", "角丸"), "roundedCornersPt", "number"], [uiText("Double rule", "二重罫"), "doubleDistancePt", "number"], ["cap", "cap", "select", ["butt", "round", "rect"]], ["join", "join", "select", ["miter", "round", "bevel"]], [uiText("Start arrow", "始点矢印"), "arrowStart", "select", ["", "Stealth", "Latex", "Bar"]], [uiText("End arrow", "終点矢印"), "arrowEnd", "select", ["", "Stealth", "Latex", "Bar"]]];
                fields.forEach(([label, key, kind, options]) => { var _a; const row = document.createElement("label"), input = kind === "select" ? document.createElement("select") : document.createElement("input"); row.textContent = label; if (input instanceof HTMLInputElement) {
                    input.type = "number";
                    input.step = key === "opacity" ? "0.1" : "0.1";
                    input.min = "0";
                }
                else
                    options.forEach(v => input.add(new Option(v || uiText("None", "なし"), v))); input.value = String((_a = effective[key]) !== null && _a !== void 0 ? _a : ""); input.onchange = () => apply(key, kind === "number" ? Number(input.value) : input.value); row.append(input); details.append(row); });
                host.append(details);
            }
            if (targets.length) {
                const dash = resolveStyle(scene, targets[0].style);
                if (dash.dash && dash.dash !== "solid") {
                    const gapRow = document.createElement("label"), gap = document.createElement("input"), unit = document.createElement("span");
                    gapRow.className = "pro-canvas-dash-gap";
                    gapRow.append(document.createTextNode(uiText("Dash spacing", "線の間隔")));
                    gap.type = "number";
                    gap.min = "0.1";
                    gap.max = "100";
                    gap.step = "0.2";
                    gap.value = String(dash.dashGapPt && dash.dashGapPt > 0 ? dash.dashGapPt : dash.dash === "dashed" ? 3 : 2);
                    gap.title = uiText("Gap between dashes or dots (pt)", "破線・点線どうしの間隔 (pt)");
                    gap.onchange = () => { const value = Math.max(.1, Math.min(100, Number(gap.value) || 1)); snapshot(false); targets.forEach(target => { var _a; return ((_a = target.style).props || (_a.props = {})).dashGapPt = value; }); render(); scheduleCompile(); };
                    unit.textContent = "pt";
                    gapRow.append(gap, unit);
                    (_b = host.querySelector(".pro-canvas-style-line")) === null || _b === void 0 ? void 0 : _b.after(gapRow);
                }
            }
        };
        // 単一パス選択 = 頂点・ハンドルが見える状態。描画ツール中でも表示は出す（掴めるのは select のときだけ）。
        const syncAnchorEdit = () => {
            const one = !pen && !plotEdit && !editingNodeId && selection.ids.size === 1 ? walk(currentObjects(), selection.primaryId) : null;
            if ((one === null || one === void 0 ? void 0 : one.type) !== "path") {
                anchorEdit = null;
                return;
            }
            if ((anchorEdit === null || anchorEdit === void 0 ? void 0 : anchorEdit.pathId) !== one.id) {
                anchorEdit = { pathId: one.id, deep: false };
                selectedAnchorIndex = 0;
            }
            // undo でパスが縮むと selectedAnchorIndex が範囲外のまま残る。範囲外で Delete すると removeAnchor が「何もせず false」を返し、
            // 呼び出し側がそれを「退化した」と誤読してパスごと消す（データ損失）。毎 render でクランプして範囲外を作らない。
            selectedAnchorIndex = Math.max(0, Math.min(selectedAnchorIndex, one.closed ? one.segments.length - 1 : one.segments.length));
        };
        const render = () => {
            var _a, _b, _c;
            syncAnchorEdit();
            if (tool !== "select")
                svg.style.cursor = "crosshair";
            // 閉じた直後や幅ゼロのときに描くと viewBox が NaN、プロット座標が ±Infinity になる。
            if (!stage.isConnected || stage.clientWidth < 1 || stage.clientHeight < 1)
                return;
            svg.replaceChildren();
            const scale = Math.min(stage.clientWidth / scene.width, stage.clientHeight / scene.height) * zoom;
            const visibleW = stage.clientWidth / scale, visibleH = stage.clientHeight / scale;
            const px = panX / scale, py = panY / scale;
            svg.setAttribute("viewBox", `${(scene.width - visibleW) / 2 - px} ${-(scene.height + visibleH) / 2 - py} ${visibleW} ${visibleH}`);
            const root = svgEl("g", { transform: "scale(1,-1)" });
            svg.append(root);
            const guides = svgEl("g", { class: "pro-canvas-guides" });
            root.append(guides);
            guides.append(svgEl("rect", { x: 0, y: 0, width: scene.width, height: scene.height, class: "pro-canvas-paper" }));
            const gridStep = visibleGridStep(scene.grid.size, scale);
            for (let x = 0; x <= scene.width; x += gridStep)
                guides.append(svgEl("line", { x1: x, y1: 0, x2: x, y2: scene.height }));
            for (let y = 0; y <= scene.height; y += gridStep)
                guides.append(svgEl("line", { x1: 0, y1: y, x2: scene.width, y2: y }));
            guides.append(svgEl("rect", { x: 0, y: 0, width: scene.width, height: scene.height, class: "pro-canvas-boundary" }));
            const paintDefs = svgEl("defs"), paintIds = new Set();
            root.append(paintDefs);
            const safeColor = (value) => value.replace(/[^0-9a-z]/gi, "").toLowerCase(), paint = (style) => { if (style.shading) {
                const s = style.shading, id = `pcgrad-${s.kind}-${safeColor(s.kind === "axis" ? s.top : s.inner)}-${safeColor(s.kind === "axis" ? s.bottom : s.outer)}${s.kind === "axis" ? `-${s.angle || 0}` : ""}`;
                if (!paintIds.has(id)) {
                    paintIds.add(id);
                    if (s.kind === "axis") {
                        const g = svgEl("linearGradient", { id, x1: "0%", y1: "0%", x2: "0%", y2: "100%", gradientTransform: `rotate(${s.angle || 0} .5 .5)` });
                        g.append(svgEl("stop", { offset: "0%", "stop-color": s.bottom }), svgEl("stop", { offset: "100%", "stop-color": s.top }));
                        paintDefs.append(g);
                    }
                    else {
                        const g = svgEl("radialGradient", { id });
                        g.append(svgEl("stop", { offset: "0%", "stop-color": s.inner }), svgEl("stop", { offset: "100%", "stop-color": s.outer }));
                        paintDefs.append(g);
                    }
                }
                return { base: `url(#${id})`, pattern: null };
            } if (style.pattern) {
                const color = style.pattern.color || style.draw || "#000000", id = `pcpat-${style.pattern.name.replace(/\s+/g, "-")}-${safeColor(color)}`;
                if (!paintIds.has(id)) {
                    paintIds.add(id);
                    const p = svgEl("pattern", { id, width: 1.6, height: 1.6, patternUnits: "userSpaceOnUse", ...(style.pattern.name.includes("north east") ? { patternTransform: "rotate(45)" } : style.pattern.name.includes("north west") ? { patternTransform: "rotate(-45)" } : {}) }), line = (x1, y1, x2, y2) => p.append(svgEl("line", { x1, y1, x2, y2, stroke: color, "stroke-width": .15 }));
                    if (style.pattern.name === "dots")
                        p.append(svgEl("circle", { cx: .8, cy: .8, r: .18, fill: color }));
                    if (style.pattern.name === "crosshatch dots") {
                        p.append(svgEl("circle", { cx: .4, cy: .4, r: .15, fill: color }));
                        p.append(svgEl("circle", { cx: 1.2, cy: 1.2, r: .15, fill: color }));
                    }
                    if (["horizontal lines", "grid", "north east lines", "north west lines"].includes(style.pattern.name))
                        line(0, .8, 1.6, .8);
                    if (["vertical lines", "grid"].includes(style.pattern.name))
                        line(.8, 0, .8, 1.6);
                    if (style.pattern.name === "crosshatch") {
                        line(0, 0, 1.6, 1.6);
                        line(0, 1.6, 1.6, 0);
                    }
                    paintDefs.append(p);
                }
                return { base: style.fill || "none", pattern: `url(#${id})` };
            } return { base: style.fill || "none", pattern: null }; };
            const objects = svgEl("g", { class: "pro-canvas-objects", "pointer-events": "all" });
            root.append(objects);
            const draw = (object, parent, interactive = true) => {
                var _a, _b, _c, _d, _e, _f, _g;
                if (object.type === "group" || object.type === "instance") {
                    const t = object.transform, g = svgEl("g", { transform: `translate(${t.tx} ${t.ty}) rotate(${t.rotate}) scale(${t.sx} ${t.sy})` });
                    if (interactive)
                        g.dataset.id = object.id;
                    parent.append(g);
                    const children = object.type === "group" ? object.children : ((_a = findSymbol(scene, object.symbol)) === null || _a === void 0 ? void 0 : _a.objects) || [];
                    children.forEach(c => draw(c, g, false));
                    return;
                }
                if (object.type === "repeat") {
                    const symbol = findSymbol(scene, object.symbol);
                    if (!symbol)
                        return;
                    const container = svgEl("g");
                    if (interactive)
                        container.dataset.id = object.id;
                    parent.append(container);
                    samplePathPoints(object.path, object.count).forEach(sample => { const g = svgEl("g", { transform: `translate(${sample.point.x} ${sample.point.y}) rotate(${object.align ? sample.angleDeg : 0})` }); container.append(g); symbol.objects.forEach(c => draw(c, g, false)); });
                    return;
                }
                if (object.type === "code") {
                    const t = object.transform, g = svgEl("g", { transform: `translate(${t.tx} ${t.ty}) rotate(${t.rotate}) scale(${t.sx} ${t.sy})` });
                    if (interactive)
                        g.dataset.id = object.id;
                    g.append(svgEl("rect", { x: -5, y: -5, width: 10, height: 10, fill: "none", stroke: "currentColor", "stroke-dasharray": "2 1", "vector-effect": "non-scaling-stroke" }));
                    const label = svgEl("text", { x: 0, y: 1, transform: "scale(1,-1)", "text-anchor": "middle", class: "pro-canvas-node" });
                    label.textContent = "</>";
                    g.append(label);
                    const preview = svgEl("text", { x: 0, y: -2, transform: "scale(1,-1)", "text-anchor": "middle", class: "pro-canvas-code-preview" });
                    preview.textContent = object.tikz.replace(/\s+/g, " ").trim().slice(0, 20);
                    g.append(preview);
                    parent.append(g);
                    return;
                }
                if (object.type === "plot") {
                    const g = svgEl("g", interactive ? { "data-id": object.id } : {}), a = object.axis, xmin = a.xmin, xmax = a.xmax, compiled = object.series.filter(series => series.visible !== false).map(series => ({ series, preview: previewSeries(series, xmin, xmax) })), cache = plotPreviewCache.get(object.id), sampled = compiled.map(({ series, preview }, i) => preview.valid ? preview.pieces : plotKind(series) === "points" ? [] : (cache === null || cache === void 0 ? void 0 : cache.pieces[i]) || []), finiteYs = sampled.flat(2).map(point => point.y).filter(Number.isFinite), auto = finiteYs.length ? autoRange(finiteYs) : cache ? { min: cache.ymin, max: cache.ymax } : autoRange([]), ymin0 = (_b = a.ymin) !== null && _b !== void 0 ? _b : auto.min, ymax0 = (_c = a.ymax) !== null && _c !== void 0 ? _c : auto.max, eq = a.equal ? (() => { const ux = object.width / Math.max(xmax - xmin, 1e-9), uy = object.height / Math.max(ymax0 - ymin0, 1e-9), u = Math.min(ux, uy), xc = (xmin + xmax) / 2, yc = (ymin0 + ymax0) / 2, hw = object.width / u / 2, hh = object.height / u / 2; return { xmin: xc - hw, xmax: xc + hw, ymin: yc - hh, ymax: yc + hh }; })() : { xmin, xmax, ymin: ymin0, ymax: ymax0 }, ymin = eq.ymin, ymax = eq.ymax, mapX = (x) => object.at.x + (x - eq.xmin) / Math.max(eq.xmax - eq.xmin, 1e-9) * object.width, mapY = (y) => object.at.y + (y - ymin) / Math.max(ymax - ymin, 1e-9) * object.height, xt = niceTicks(eq.xmin, eq.xmax), yt = niceTicks(ymin, ymax), neutral = "#64748b", clipId = `pro-canvas-plot-${object.id}`;
                    parent.append(g);
                    if (compiled.every(entry => entry.preview.valid))
                        plotPreviewCache.set(object.id, { ymin, ymax, pieces: sampled });
                    const defs = svgEl("defs"), clip = svgEl("clipPath", { id: clipId });
                    clip.append(svgEl("rect", { x: object.at.x, y: object.at.y, width: object.width, height: object.height }));
                    defs.append(clip);
                    g.append(defs);
                    if (a.grid !== "none") {
                        xt.forEach(value => g.append(svgEl("line", { x1: mapX(value), y1: object.at.y, x2: mapX(value), y2: object.at.y + object.height, stroke: neutral, "stroke-opacity": .18, "stroke-width": .5, "vector-effect": "non-scaling-stroke" })));
                        yt.forEach(value => g.append(svgEl("line", { x1: object.at.x, y1: mapY(value), x2: object.at.x + object.width, y2: mapY(value), stroke: neutral, "stroke-opacity": .18, "stroke-width": .5, "vector-effect": "non-scaling-stroke" })));
                    }
                    const axisX = a.axisLines === "middle" ? mapX(Math.max(eq.xmin, Math.min(eq.xmax, 0))) : object.at.x, axisY = a.axisLines === "middle" ? mapY(Math.max(ymin, Math.min(ymax, 0))) : object.at.y;
                    if (a.axisLines === "box")
                        g.append(svgEl("rect", { x: object.at.x, y: object.at.y, width: object.width, height: object.height, fill: "none", stroke: neutral, "stroke-width": .7, "vector-effect": "non-scaling-stroke" }));
                    else if (a.axisLines !== "none") {
                        g.append(svgEl("line", { x1: object.at.x, y1: axisY, x2: object.at.x + object.width, y2: axisY, stroke: neutral, "stroke-width": .7, "vector-effect": "non-scaling-stroke" }));
                        g.append(svgEl("line", { x1: axisX, y1: object.at.y, x2: axisX, y2: object.at.y + object.height, stroke: neutral, "stroke-width": .7, "vector-effect": "non-scaling-stroke" }));
                    }
                    if (a.axisLines === "middle") {
                        const al = 6 / scale, aw = 1.8 / scale;
                        g.append(svgEl("polygon", { points: `${object.at.x + object.width},${axisY} ${object.at.x + object.width - al},${axisY - aw} ${object.at.x + object.width - al},${axisY + aw}`, fill: neutral }));
                        g.append(svgEl("polygon", { points: `${axisX},${object.at.y + object.height} ${axisX - aw},${object.at.y + object.height - al} ${axisX + aw},${object.at.y + object.height - al}`, fill: neutral }));
                    }
                    const text = (value, x, y, anchor = "middle") => { const el = svgEl("text", { x, y: -y, transform: "scale(1,-1)", "text-anchor": anchor, fill: neutral, "font-size": 9.5 / scale }); el.textContent = value; g.append(el); };
                    const tl = 2.5 / scale, lo = 12 / scale;
                    if (a.axisLines !== "none") {
                        xt.forEach(value => { g.append(svgEl("line", { x1: mapX(value), y1: axisY - tl, x2: mapX(value), y2: axisY + tl, stroke: neutral, "stroke-width": .75, "vector-effect": "non-scaling-stroke" })); if (a.axisLines !== "middle" || value !== 0)
                            text(String(Number(value.toPrecision(4))), mapX(value), (a.axisLines === "middle" ? axisY : object.at.y) - lo); });
                        yt.forEach(value => { g.append(svgEl("line", { x1: axisX - tl, y1: mapY(value), x2: axisX + tl, y2: mapY(value), stroke: neutral, "stroke-width": .75, "vector-effect": "non-scaling-stroke" })); if (a.axisLines !== "middle" || value !== 0)
                            text(String(Number(value.toPrecision(4))), (a.axisLines === "middle" ? axisX : object.at.x) - 4 / scale, mapY(value) - 3 / scale, "end"); });
                        if (a.axisLines === "middle" && eq.xmin <= 0 && eq.xmax >= 0 && ymin <= 0 && ymax >= 0)
                            text("0", axisX - 3 / scale, axisY - lo, "end");
                    }
                    const legendLayer = svgEl("g"), legendEntries = compiled.filter(entry => entry.series.legend);
                    if (legendEntries.length) {
                        const pad = 4 / scale, rowHeight = 12 / scale, boxWidth = Math.max(...legendEntries.map(entry => [...entry.series.legend].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 10.5 : 5.5), 0) / scale + 24 / scale)), boxHeight = legendEntries.length * rowHeight + 2 * pad, left = object.at.x + object.width - boxWidth - pad, bottom = object.at.y + object.height - boxHeight - pad;
                        legendLayer.append(svgEl("rect", { x: left, y: bottom, width: boxWidth, height: boxHeight, fill: "#ffffff", "fill-opacity": .85, stroke: neutral, "stroke-width": .5, "vector-effect": "non-scaling-stroke" }));
                        legendEntries.forEach((entry, index) => { const y = bottom + boxHeight - pad - rowHeight * (index + .5), x = left + pad; if (plotKind(entry.series) === "points")
                            legendLayer.append(svgEl("circle", { cx: x + 5 / scale, cy: y, r: 2 / scale, fill: entry.series.color }));
                        else
                            legendLayer.append(svgEl("line", { x1: x, y1: y, x2: x + 10 / scale, y2: y, stroke: entry.series.color, "stroke-width": entry.series.thick ? 1.2 : .7, "vector-effect": "non-scaling-stroke" })); const label = svgEl("text", { x: x + 14 / scale, y: -(y - 3 / scale), transform: "scale(1,-1)", "text-anchor": "start", fill: "#334155", "font-size": 9 / scale }); label.textContent = entry.series.legend; legendLayer.append(label); });
                    }
                    sampled.forEach((pieces, index) => { const entry = compiled[index]; if (plotKind(entry.series) === "points")
                        pieces.flat().forEach(point => g.append(svgEl("circle", { cx: mapX(point.x), cy: mapY(point.y), r: 2 / scale, fill: entry.series.color, "fill-opacity": entry.preview.valid ? 1 : .35, "clip-path": `url(#${clipId})` })));
                    else
                        pieces.forEach(piece => g.append(svgEl("polyline", { points: piece.map(point => `${mapX(point.x)},${mapY(point.y)}`).join(" "), fill: "none", stroke: entry.series.color, "stroke-width": entry.series.thick ? 1.2 : .7, "stroke-opacity": entry.preview.valid ? 1 : .35, "vector-effect": "non-scaling-stroke", "clip-path": `url(#${clipId})` }))); });
                    g.append(legendLayer);
                    if (compiled.some(entry => !entry.preview.valid)) {
                        const error = svgEl("text", { x: object.at.x + 6 / scale, y: -(object.at.y + object.height - 14 / scale), transform: "scale(1,-1)", "text-anchor": "start", fill: "#dc2626", "font-size": 11 / scale });
                        error.textContent = uiText("Expression error", "式エラー");
                        g.append(error);
                    }
                    if (a.title)
                        text(a.title, object.at.x + object.width / 2, object.at.y + object.height + 8 / scale);
                    if (a.xlabel)
                        text(a.xlabel, object.at.x + object.width / 2, object.at.y - 26 / scale);
                    if (a.ylabel)
                        text(a.ylabel, object.at.x - 8 / scale, object.at.y + object.height / 2, "end");
                    g.append(svgEl("rect", { x: object.at.x, y: object.at.y, width: object.width, height: object.height, fill: "rgba(0,0,0,0.001)", stroke: (plotEdit === null || plotEdit === void 0 ? void 0 : plotEdit.id) === object.id ? "var(--accent)" : "none", "stroke-width": 1, "vector-effect": "non-scaling-stroke", "pointer-events": "all", ...(interactive ? { "data-id": object.id } : {}) }));
                    return;
                }
                const style = resolveStyle(scene, object.style), fills = paint(style);
                const ptu = (_d = PT_IN_UNIT[scene.unit]) !== null && _d !== void 0 ? _d : 1;
                const lw = (style.lineWidthPt || .4) * ptu;
                const attrs = { ...(interactive ? { "data-id": object.id } : {}), fill: fills.base, stroke: style.draw || "none", "stroke-width": lw, opacity: (_e = style.opacity) !== null && _e !== void 0 ? _e : 1, "stroke-dasharray": style.dash === "dashed" ? `${lw * 4} ${lw * 3}` : style.dash === "dotted" ? `${lw} ${lw * 2.5}` : "" };
                let el;
                let pathShape = null;
                const tipOf = (value) => isArrowKind(value) ? value : null;
                const tipMetrics = (kind) => arrowMetrics(kind, style.lineWidthPt || .4, ptu);
                if (style.dash && style.dash !== "solid" && style.dashGapPt && style.dashGapPt > 0) {
                    const gap = style.dashGapPt * ptu;
                    attrs["stroke-dasharray"] = style.dash === "dashed" ? `${Math.max(lw * 4, 1.2 * ptu)} ${gap}` : `${Math.max(lw * .01, .001)} ${gap}`;
                    if (style.dash === "dotted" && (style.cap === undefined || style.cap === "butt"))
                        attrs["stroke-linecap"] = "round";
                }
                if (object.type === "rect")
                    el = svgEl("rect", { ...attrs, x: Math.min(object.from.x, object.to.x), y: Math.min(object.from.y, object.to.y), width: Math.abs(object.to.x - object.from.x), height: Math.abs(object.to.y - object.from.y), rx: style.roundedCornersPt || 0 });
                else if (object.type === "ellipse")
                    el = svgEl("ellipse", { ...attrs, cx: object.center.x, cy: object.center.y, rx: object.rx, ry: object.ry });
                else if (object.type === "path") {
                    // ペン描画中はカーソルを仮ノードに含めた provisional 形状で描く（確定時のジャンプ・ゴーストとの二又を根絶）。始点付近では閉じた形を予告。
                    let segs = object.segments, closedNow = object.closed;
                    if (pen && pen.path.id === object.id && !object.closed) {
                        if (penDrag)
                            segs = penSegments([...pen.nodes, { p: { ...penDrag.anchor }, kind: penDrag.handle ? "manual" : "auto", out: penDrag.handle ? { ...penDrag.handle } : null }], false);
                        else if (penCursor) {
                            const act = penHoverAction();
                            if ((act === null || act === void 0 ? void 0 : act.action) === "close" && pen.nodes.length >= 2) {
                                segs = penSegments(pen.nodes, true);
                                closedNow = true;
                            }
                            else if (act && (act.action === "add" || act.action === "finish")) {
                                const tip = act.action === "add" ? act.point : penCursor, lastP = pen.nodes[pen.nodes.length - 1].p;
                                // 確定ゾーン（finish）でもラバーバンドは伸ばし続ける（消すと「途中で伸びなくなる」）。クリックで確定することは最終アンカーのリングが予告する。
                                if (Math.hypot(tip.x - lastP.x, tip.y - lastP.y) > 1e-9)
                                    segs = penSegments([...pen.nodes, { p: { ...tip }, kind: "auto", out: null }], false);
                            }
                        }
                    }
                    pathShape = { start: object.start, segments: segs, closed: closedNow };
                    // 矢頭は線の上に乗せるのではなく、TikZ と同じく矢頭の手前で線を止める。
                    // 止めないと Stealth の切り欠きが線で埋まり、実際の組版結果とズレる。
                    const startTip = closedNow ? null : tipOf(style.arrowStart), endTip = closedNow ? null : tipOf(style.arrowEnd);
                    const shown = startTip || endTip ? trimPathForArrows(pathShape, startTip ? tipMetrics(startTip).trim : 0, endTip ? tipMetrics(endTip).trim : 0) : pathShape;
                    let d = `M ${shown.start.x} ${shown.start.y}`;
                    shown.segments.forEach(s => { d += s.type === "line" ? ` L ${s.to.x} ${s.to.y}` : ` C ${s.c1.x} ${s.c1.y} ${s.c2.x} ${s.c2.y} ${s.to.x} ${s.to.y}`; });
                    if (closedNow)
                        d += " Z";
                    el = svgEl("path", { ...attrs, d });
                }
                else {
                    const fallback = measuredNodeBounds.get(object) || nodeLabelBounds(object), width = Math.max(fallback.maxX - fallback.minX, .01), height = Math.max(fallback.maxY - fallback.minY, .01);
                    const foreign = svgEl("foreignObject", { ...(interactive ? { "data-id": object.id } : {}), "data-role": "node-render", "data-object-id": object.id, opacity: (_f = style.opacity) !== null && _f !== void 0 ? _f : 1, x: fallback.minX, y: -fallback.maxY, width, height, transform: "scale(1,-1)", overflow: "visible", class: "pro-canvas-node-foreign" });
                    const content = document.createElementNS(XHTML_NS, "div"), font = nodeFontPreviewStyle(object.fontFamily, object.fontShape, object.fontWeight, object.monospace);
                    content.className = `pro-canvas-node-render${object.fontWeight === "bold" ? " is-bold" : ""}`;
                    content.dataset.objectId = object.id;
                    content.style.fontFamily = font.fontFamily;
                    content.style.fontStyle = font.fontStyle;
                    content.style.fontWeight = font.fontWeight;
                    content.style.fontSize = `${4 * nodeFontScale(object.fontSize)}px`;
                    try {
                        if (typeof katex !== "undefined")
                            content.innerHTML = katex.renderToString(nodePreviewExpression(object.latex, object.fontFamily, object.fontShape, object.fontWeight, object.monospace), { throwOnError: false, strict: "ignore", trust: false });
                        else
                            content.textContent = object.latex;
                    }
                    catch {
                        content.textContent = object.latex;
                    }
                    foreign.append(content);
                    el = foreign;
                    if (object.id === editingNodeId) {
                        foreign.setAttribute("visibility", "hidden");
                        foreign.setAttribute("pointer-events", "none");
                    }
                    else {
                        parent.append(foreign);
                        const measured = ((_g = content.querySelector(".katex")) === null || _g === void 0 ? void 0 : _g.getBoundingClientRect()) || content.getBoundingClientRect();
                        if (measured.width > 0 && measured.height > 0) {
                            const pad = 2 / scale, bounds = nodeLabelBoundsFromSize(object, measured.width / scale + pad, measured.height / scale + pad);
                            measuredNodeBounds.set(object, bounds);
                            foreign.setAttribute("x", String(bounds.minX));
                            foreign.setAttribute("y", String(-bounds.maxY));
                            foreign.setAttribute("width", String(Math.max(bounds.maxX - bounds.minX, .01)));
                            foreign.setAttribute("height", String(Math.max(bounds.maxY - bounds.minY, .01)));
                        }
                    }
                }
                const distance = style.doubleDistancePt || 0;
                if (distance > 0 && object.type !== "node") {
                    const fill = el.cloneNode(true);
                    fill.setAttribute("stroke", "none");
                    parent.append(fill);
                    el.setAttribute("fill", "none");
                    el.setAttribute("stroke-width", String((2 * (style.lineWidthPt || .4) + distance) * ptu));
                    parent.append(el);
                    const inner = el.cloneNode(true);
                    inner.removeAttribute("data-id");
                    inner.setAttribute("stroke", "#ffffff");
                    inner.setAttribute("stroke-width", String(distance * ptu));
                    parent.append(inner);
                }
                else
                    parent.append(el);
                if (fills.pattern && object.type !== "node") {
                    const patternEl = el.cloneNode(true);
                    patternEl.removeAttribute("data-id");
                    patternEl.setAttribute("fill", fills.pattern);
                    patternEl.setAttribute("stroke", "none");
                    patternEl.setAttribute("pointer-events", "none");
                    parent.append(patternEl);
                }
                if (pathShape && pathShape.segments.length) {
                    // 矢頭の寸法・形は arrows.meta の実測式（arrow-math.ts）。TikZ は多角形を
                    // 塗ったうえで同じ線幅で縁取るので、こちらも fill と stroke を両方掛ける。
                    const tip = (kind, at, direction) => { var _a; if (!direction)
                        return; const shape = arrowShape(kind, at, direction, tipMetrics(kind)); if (!shape)
                        return; const color = style.draw || "#000000"; parent.append(svgEl("path", { d: shape.d, fill: shape.filled ? color : "none", stroke: color, "stroke-width": lw, "stroke-linejoin": "miter", "stroke-miterlimit": 10, opacity: (_a = style.opacity) !== null && _a !== void 0 ? _a : 1, "pointer-events": "none" })); };
                    const startTip = tipOf(style.arrowStart), endTip = tipOf(style.arrowEnd);
                    if (startTip)
                        tip(startTip, pathShape.start, endTangent(pathShape, "start"));
                    if (endTip)
                        tip(endTip, pathShape.segments[pathShape.segments.length - 1].to, endTangent(pathShape, "end"));
                }
                // 細線でも掴めるよう、透明の太ストロークでヒット領域を確保する。
                if (interactive && object.type !== "node") {
                    const hit = el.cloneNode(true);
                    hit.setAttribute("class", "pro-canvas-hit");
                    hit.setAttribute("fill", "none");
                    hit.setAttribute("stroke", "rgba(0,0,0,0.001)");
                    hit.setAttribute("stroke-width", String(Math.max(lw * 2.5, 1.4 * 2.845 * ptu)));
                    hit.setAttribute("stroke-dasharray", "");
                    hit.setAttribute("pointer-events", "stroke");
                    parent.append(hit);
                }
            };
            currentObjects().forEach(o => draw(o, objects));
            if (tool === "fill" && paintPreview)
                root.append(svgEl("path", { d: pathOutlineD(paintPreview), class: "pro-canvas-fill-preview", "pointer-events": "none" }));
            if (drag === null || drag === void 0 ? void 0 : drag.guides) {
                const smart = svgEl("g", { class: "pro-canvas-smart-guides pro-canvas-selection" });
                if (drag.guides.x !== undefined)
                    smart.append(svgEl("line", { x1: drag.guides.x, y1: 0, x2: drag.guides.x, y2: scene.height }));
                if (drag.guides.y !== undefined)
                    smart.append(svgEl("line", { x1: 0, y1: drag.guides.y, x2: scene.width, y2: drag.guides.y }));
                root.append(smart);
            }
            if (pen || penDrag || (tool === "pen" && penCursor)) {
                const penLayer = svgEl("g", { class: "pro-canvas-pen-feedback pro-canvas-selection" }), path = pen === null || pen === void 0 ? void 0 : pen.path, points = path ? [path.start, ...path.segments.map(s => s.to)] : [], penAct = penDrag ? null : penHoverAction(), close = (penAct === null || penAct === void 0 ? void 0 : penAct.action) === "close", finish = (penAct === null || penAct === void 0 ? void 0 : penAct.action) === "finish";
                points.forEach((point, index) => { const ring = (index === 0 && close) || (index === points.length - 1 && finish); penLayer.append(svgEl("circle", { cx: point.x, cy: point.y, r: (ring ? 4.5 : 3) / scale, class: `pro-canvas-pen-anchor${ring ? " is-close" : ""}` })); });
                // 次のアンカーが落ちる位置（＝いまの終端）は、ドラッグ前でも点線の丸で予告する。
                if (penCursor && !penDrag && !close && (!pen || (penAct === null || penAct === void 0 ? void 0 : penAct.action) === "add")) {
                    const resuming = Boolean(penResume && !pen), target = resuming ? penResume.point : (penAct === null || penAct === void 0 ? void 0 : penAct.action) === "add" ? penAct.point : penCursor;
                    penLayer.append(svgEl("circle", { cx: target.x, cy: target.y, r: (resuming ? 5.5 : 4) / scale, class: `pro-canvas-pen-ghost${resuming ? " is-resume" : ""}` }));
                }
                const committed = svgEl("g", { class: "pro-canvas-pen-committed" });
                let prevAnchor = (_a = path === null || path === void 0 ? void 0 : path.start) !== null && _a !== void 0 ? _a : { x: 0, y: 0 };
                ((_b = path === null || path === void 0 ? void 0 : path.segments) !== null && _b !== void 0 ? _b : []).forEach(seg => { if (seg.type === "cubic")
                    [[prevAnchor, seg.c1], [seg.to, seg.c2]].forEach(([anchor, control]) => { if (Math.hypot(control.x - anchor.x, control.y - anchor.y) <= 1e-6)
                        return; committed.append(svgEl("line", { x1: anchor.x, y1: anchor.y, x2: control.x, y2: control.y, class: "pro-canvas-pen-handle-line" })); committed.append(svgEl("circle", { cx: control.x, cy: control.y, r: 2.5 / scale, class: "pro-canvas-pen-handle-dot" })); }); prevAnchor = seg.to; });
                if (committed.childNodes.length)
                    penLayer.append(committed);
                if (penDrag) {
                    const a = penDrag.anchor, h = penDrag.handle;
                    penLayer.append(svgEl("circle", { cx: a.x, cy: a.y, r: 3 / scale, class: "pro-canvas-pen-anchor" }));
                    if (h)
                        penLayer.append(svgEl("line", { x1: a.x - h.x, y1: a.y - h.y, x2: a.x + h.x, y2: a.y + h.y, class: "pro-canvas-pen-handle-line" }), svgEl("circle", { cx: a.x - h.x, cy: a.y - h.y, r: 3 / scale, class: "pro-canvas-pen-handle-dot" }), svgEl("circle", { cx: a.x + h.x, cy: a.y + h.y, r: 3 / scale, class: "pro-canvas-pen-handle-dot" }));
                }
                else if (penCursor && (pen === null || pen === void 0 ? void 0 : pen.lastOut) && points.length) {
                    const last = points[points.length - 1];
                    penLayer.append(svgEl("line", { x1: last.x, y1: last.y, x2: last.x + pen.lastOut.x, y2: last.y + pen.lastOut.y, class: "pro-canvas-pen-handle-line" }), svgEl("circle", { cx: last.x + pen.lastOut.x, cy: last.y + pen.lastOut.y, r: 3 / scale, class: "pro-canvas-pen-handle-dot" }));
                }
                root.append(penLayer);
            }
            if (hoveredId && !drag) {
                const hovered = currentObjects().find(item => item.id === hoveredId);
                if (hovered) {
                    if (hovered.type === "path")
                        root.append(svgEl("path", { d: pathOutlineD(hovered), class: "pro-canvas-hover" }));
                    else {
                        const b = objectBounds(hovered, scene);
                        root.append(svgEl("rect", { x: b.minX, y: b.minY, width: Math.max(b.maxX - b.minX, .01), height: Math.max(b.maxY - b.minY, .01), class: "pro-canvas-hover" }));
                    }
                }
            }
            const selected = topLevelSelectedObjects();
            if (selected.length) {
                const select = svgEl("g", { class: "pro-canvas-selection" });
                selected.forEach(item => { if (!nodeSelectionOutlineVisible(item, editingNodeId))
                    return; if (item.type === "path")
                    select.append(svgEl("path", { d: pathOutlineD(item), class: "pro-canvas-selection-outline", fill: "none" }));
                else {
                    const b = objectBounds(item, scene);
                    select.append(svgEl("rect", { x: b.minX, y: b.minY, width: Math.max(b.maxX - b.minX, .01), height: Math.max(b.maxY - b.minY, .01), class: "pro-canvas-selection-outline" }));
                } if (item.type === "node")
                    select.append(svgEl("circle", { cx: item.at.x, cy: item.at.y, r: 3.5 / scale, class: "pro-canvas-node-anchor-marker" })); });
                const b = selectionBounds(), addRotate = () => { const x = (b.minX + b.maxX) / 2, stemTop = b.maxY + 18 / scale; select.append(svgEl("line", { x1: x, y1: b.maxY, x2: x, y2: stemTop, class: "pro-canvas-rotate-stem" })); const rotate = svgEl("circle", { cx: x, cy: stemTop, r: 4 / scale, class: "pro-canvas-rotate" }); rotate.dataset.rotate = "true"; select.append(rotate); };
                if (!(anchorEdit === null || anchorEdit === void 0 ? void 0 : anchorEdit.deep)) {
                    if (selected.length > 1)
                        select.append(svgEl("rect", { x: b.minX, y: b.minY, width: Math.max(b.maxX - b.minX, .01), height: Math.max(b.maxY - b.minY, .01), class: "pro-canvas-selection-bounds" }));
                    else if (selected[0].type === "path") {
                        const endpoints = straightLineEndpoints(selected[0]);
                        if (endpoints) {
                            endpoints.forEach((point, index) => { const size = 7 / scale, handle = svgEl("rect", { x: point.x - size / 2, y: point.y - size / 2, width: size, height: size, class: "pro-canvas-handle pro-canvas-line-end" }); handle.dataset.lineEndpoint = String(index); select.append(handle); });
                            addRotate();
                        }
                        else {
                            ["nw", "ne", "se", "sw"].forEach(h => { const p = resizeHandlePoint(b, h), handle = svgEl("circle", { cx: p.x, cy: p.y, r: 3 / scale, class: `pro-canvas-handle pro-canvas-handle-${h} is-path-corner` }); handle.dataset.handle = h; select.append(handle); });
                            addRotate();
                        }
                    }
                    else if (selected[0].type !== "node") {
                        handles.forEach(h => { const p = resizeHandlePoint(b, h), size = 7 / scale, handle = svgEl("rect", { x: p.x - size / 2, y: p.y - size / 2, width: size, height: size, class: `pro-canvas-handle pro-canvas-handle-${h}` }); handle.dataset.handle = h; select.append(handle); });
                        if (selected[0].type !== "plot")
                            addRotate();
                    }
                }
                root.append(select);
            }
            if (anchorEdit) {
                const object = walk(currentObjects(), anchorEdit.pathId);
                if ((object === null || object === void 0 ? void 0 : object.type) === "path") {
                    const layer = svgEl("g", { class: `pro-canvas-anchor-layer pro-canvas-selection${tool === "select" ? "" : " is-inert"}` }), points = [object.start, ...object.segments.map(segment => segment.to)], strong = (i, key) => (key === "c1" && i === selectedAnchorIndex) || (key === "c2" && i + 1 === selectedAnchorIndex);
                    object.segments.forEach((segment, i) => { if (segment.type !== "cubic")
                        return; ["c1", "c2"].forEach(key => { const anchor = key === "c1" ? (i === 0 ? object.start : object.segments[i - 1].to) : segment.to, point = segment[key], emphasis = strong(i, key), metrics = anchorControlMetrics(emphasis); if (Math.hypot(point.x - anchor.x, point.y - anchor.y) < 1e-6)
                        return; layer.append(svgEl("line", { x1: anchor.x, y1: anchor.y, x2: point.x, y2: point.y, class: `pro-canvas-anchor-tether${emphasis ? "" : " is-faint"}` })); const hit = svgEl("circle", { cx: point.x, cy: point.y, r: metrics.hitRadiusPx / scale, class: "pro-canvas-anchor-hit" }), control = svgEl("circle", { cx: point.x, cy: point.y, r: metrics.visibleRadiusPx / scale, class: `pro-canvas-anchor-control${emphasis ? "" : " is-faint"}` }); for (const element of [hit, control]) {
                        element.dataset.controlSegment = String(i);
                        element.dataset.controlKey = key;
                    } layer.append(hit, control); }); });
                    points.slice(0, object.closed ? -1 : undefined).forEach((point, index) => { const end = !object.closed && (index === 0 || index === points.length - 1), metrics = anchorPointMetrics(end), hitSize = metrics.hitSizePx / scale, size = metrics.visibleSizePx / scale, hit = svgEl("rect", { x: point.x - hitSize / 2, y: point.y - hitSize / 2, width: hitSize, height: hitSize, class: "pro-canvas-anchor-hit" }), handle = svgEl("rect", { x: point.x - size / 2, y: point.y - size / 2, width: size, height: size, class: `pro-canvas-anchor${index === selectedAnchorIndex ? " is-selected" : ""}${end ? " is-end" : ""}` }); for (const element of [hit, handle])
                        element.dataset.anchorIndex = String(index); layer.append(hit, handle); });
                    // 追加できる場所には ＋、消せる頂点には − を重ねる。どちらもダブルクリックの予告。
                    if (pathHint && tool === "select" && !drag) {
                        const r = (pathHint.kind === "add" ? 5.5 : 7) / scale, hint = svgEl("g", { class: `pro-canvas-anchor-hint is-${pathHint.kind}` });
                        hint.append(svgEl("circle", { cx: pathHint.point.x, cy: pathHint.point.y, r }));
                        const arm = r * .5;
                        hint.append(svgEl("line", { x1: pathHint.point.x - arm, y1: pathHint.point.y, x2: pathHint.point.x + arm, y2: pathHint.point.y }));
                        if (pathHint.kind === "add")
                            hint.append(svgEl("line", { x1: pathHint.point.x, y1: pathHint.point.y - arm, x2: pathHint.point.x, y2: pathHint.point.y + arm }));
                        layer.append(hint);
                    }
                    root.append(layer);
                }
            }
            if ((drag === null || drag === void 0 ? void 0 : drag.kind) === "marquee" && drag.current) {
                const b = { minX: Math.min(drag.start.x, drag.current.x), minY: Math.min(drag.start.y, drag.current.y), maxX: Math.max(drag.start.x, drag.current.x), maxY: Math.max(drag.start.y, drag.current.y) };
                root.append(svgEl("rect", { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, class: "pro-canvas-marquee" }));
            }
            overlay.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("is-active", b.dataset.tool === tool));
            const snap = overlay.querySelector("[data-action=snap]"), snapEnabled = activeSnap();
            snap.textContent = snapEnabled ? uiText("Snap on", "吸着 オン") : uiText("Snap off", "吸着 オフ");
            snap.title = tool === "node" ? uiText("Math label placement snap (off by default)", "数式ラベル配置の吸着（既定はオフ）") : uiText("Snaps to the grid and to other shapes' edges and centers (hold Alt to suspend)", "グリッドと他の図形の端・中心に吸着します（Alt を押しながらで一時解除）");
            snap.dataset.noI18n = "";
            snap.classList.toggle("is-active", snapEnabled);
            const canvasButton = overlay.querySelector("[data-action=canvas-settings]");
            canvasButton.title = uiText(`Canvas ${scene.width} × ${scene.height} ${scene.unit} · grid ${scene.grid.size} ${scene.unit}`, `キャンバス ${scene.width} × ${scene.height} ${scene.unit}・グリッド ${scene.grid.size} ${scene.unit}`);
            canvasButton.setAttribute("aria-expanded", String(Boolean(canvasPop)));
            overlay.querySelector("[data-action=zoom-reset]").textContent = `${Math.round(zoom * 100)}%`;
            overlay.querySelector("[data-action=zoom-reset]").title = uiText("Click: 100% · Shift+click: fit selection", "クリック: 100% / Shift+クリック: 選択にフィット");
            overlay.querySelector("[data-action=undo]").disabled = !undo.length;
            overlay.querySelector("[data-action=redo]").disabled = !redo.length;
            renderInspector();
            positionNodeEditor();
            syncNodeMenu();
            const edited = plotObject();
            if (edited) {
                const signature = `${edited.id}:${edited.series.length}:${edited.series.map(plotKind).join(",")}:${edited.axis.ymin === null || edited.axis.ymax === null}:${edited.axis.axisLines}:${edited.axis.grid}`;
                if (!plotCard || signature !== plotCardSignature)
                    buildPlotCard(edited);
                else {
                    plotCard.querySelectorAll("input[data-plot-range]").forEach(el => { const input = el; if (document.activeElement === input)
                        return; const key = input.dataset.plotRange; const value = edited.axis[key]; input.value = value === null ? "" : String(Number(value.toPrecision(4))); if (value === null) {
                        const cached = plotPreviewCache.get(edited.id);
                        if (cached)
                            input.placeholder = String(Number((key === "ymin" ? cached.ymin : cached.ymax).toPrecision(4)));
                    } });
                    requestAnimationFrame(positionPlotCard);
                }
            }
            else if (plotCard) {
                plotCard.remove();
                plotCard = null;
                plotCardSignature = "";
            }
            const one = selection.ids.size === 1 ? nodeById(selection.primaryId) : null;
            hintbar.textContent = edited ? (plotIsEmpty(edited) ? uiText("Enter an expression to draw it", "式を入力すると描画されます") : uiText("Type / while entering a formula for a fraction · Esc to finish editing", "式の入力中に / で分数　Esc で編集を終了")) : (anchorEdit === null || anchorEdit === void 0 ? void 0 : anchorEdit.deep) ? uiText("Double-click ＋ on the line to add a point · Double-click − on a point to remove it · Drag points and handles · Drag a segment to bend it · Alt+click toggles straight ⇄ curved · Esc to finish", "線上の＋をダブルクリック：頂点追加　頂点の−をダブルクリック：削除　ドラッグ：頂点・ハンドル　セグメントをドラッグ：曲げ　Alt+クリック：直線⇄曲線　Esc で終了") : tool !== "select" ? (_c = { line: uiText("Drag to draw a line · Shift for horizontal/vertical/45° · Alt to suspend snapping", "ドラッグで直線　Shift で水平・垂直・45°　Alt で吸着オフ"), rect: uiText("Drag to draw · Shift for a square · Alt to suspend snapping", "ドラッグで作成　Shift で正方形　Alt で吸着オフ"), ellipse: uiText("Drag to draw · Shift for a circle · Alt to suspend snapping", "ドラッグで作成　Shift で正円　Alt で吸着オフ"), fill: uiText("Move over an enclosed region to preview · Click to fill · Adjust color or hatch in Style", "囲まれた領域にカーソルを置いて確認　クリックで塗り　色・網掛けはスタイルで調整"), pen: uiText("Click: smooth point · Alt+click: corner · Drag: shape the handles · Click an end □ to continue that path · Click the start point to close · Enter to finish", "クリック：なめらかな曲線　Alt+クリック：角　ドラッグ：ハンドルで調整　既存の端点□をクリック：続きを描く　始点クリックで閉じる　Enter で確定"), node: uiText("Click to place a math label", "クリックした位置に数式ラベルを置きます"), plot: uiText("Click or drag to place a function curve, then enter y=f(x) and its range", "クリックまたはドラッグで関数曲線を配置し、式 y=f(x) と範囲を指定します"), code: uiText("Click to write TikZ code at that spot", "クリックした位置にTikZコードを直接書けます") }[tool]) !== null && _c !== void 0 ? _c : "" : selection.ids.size > 1 ? uiText("Drag to move · Cmd+G to group · Arrow keys to nudge", "ドラッグ：平行移動　Cmd+G：グループ化　矢印キー：微調整") : (one === null || one === void 0 ? void 0 : one.type) === "plot" ? uiText("Drag to move · Handles resize · Double-click to edit the function and range", "ドラッグ：平行移動　周囲の□：拡大縮小　ダブルクリック：式と範囲を編集") : (one === null || one === void 0 ? void 0 : one.type) === "node" ? uiText("Drag to move · Double-click to edit the formula", "ドラッグ：平行移動　ダブルクリック：数式編集") : (one === null || one === void 0 ? void 0 : one.type) === "path" ? (isStraightLine(one) ? uiText("Drag to move · End squares resize · Top circle rotates", "線をドラッグ：平行移動　端の□：拡大縮小　上の○：回転") : uiText("Drag to move · Corners resize · Top circle rotates · Double-click edits points", "線をドラッグ：平行移動　四隅：拡大縮小　上の○：回転　ダブルクリック：頂点編集")) : uiText("Drag to move · Handles resize · Top circle rotates · Double-click to edit", "図形をドラッグ：平行移動　周囲の□：拡大縮小　上の○：回転　ダブルクリック：編集");
        };
        let drag = null;
        let lastClick = null;
        let penDrag = null;
        svg.addEventListener("pointerup", () => { if ((drag === null || drag === void 0 ? void 0 : drag.kind) !== "draw" || !drag.id || !drag.moved)
            return; const object = currentObjects().find(item => item.id === drag.id); if ((object === null || object === void 0 ? void 0 : object.type) === "plot") {
            object.width = Math.max(5, object.width);
            object.height = Math.max(5, object.height);
        } });
        // base は「続きを描く」モードで手前に残す既存セグメント。既存部分は作り直さず
        // 後ろに足すだけなので、拾い上げても元の曲線は歪まない。
        let pen = null, penCursor = null, penRawCursor = null;
        // pointerdown とプレビューが必ず同じ判定を共有する（予告と実挙動の乖離防止）。
        const penHoverAction = () => pen && penCursor && penRawCursor ? penClickAction({ rawPoint: penRawCursor, snappedPoint: penCursor, start: pen.path.start, last: pen.nodes[pen.nodes.length - 1].p, scaleFactor: scaleFactor(), segmentCount: pen.path.segments.length }) : null;
        let penResume = null;
        /** ポインタ由来の一時的な印（ペンのゴースト・頂点の＋−）を消す。道具を替えたときなど。 */
        const clearPointerMarkers = () => { if (!pen) {
            penCursor = null;
            penRawCursor = null;
        } penResume = null; pathHint = null; };
        /** 深い編集で、いま頂点を足せる／消せる場所。ホバーの度に更新して印を出す。 */
        let pathHint = null;
        // 頂点を消すとパス自体が退化する（＝丸ごと消える）ときは、消せる印を出さない。
        const canRemoveAnchor = (path) => path.closed ? path.segments.length > 2 : path.segments.length > 1;
        const hintAt = (target, point) => {
            const object = anchorEdit ? walk(currentObjects(), anchorEdit.pathId) : null;
            if ((object === null || object === void 0 ? void 0 : object.type) !== "path" || !object.segments.length)
                return null;
            const anchors = [object.start, ...object.segments.map(seg => seg.to)];
            const over = target.dataset.anchorIndex;
            if (over !== undefined)
                return canRemoveAnchor(object) && anchors[Number(over)] ? { kind: "remove", point: { ...anchors[Number(over)] }, index: Number(over) } : null;
            if (target.dataset.controlKey)
                return null;
            const near = nearestOnPath(object, point);
            // 追加のダブルクリック判定と同じ 8px。印が出るのに追加できない、をなくす。
            if (near.dist > 8 / scaleFactor())
                return null;
            // 既存の頂点に近すぎる位置は「追加」ではなく、その頂点を掴む場所。
            if (anchors.some(anchor => Math.hypot(anchor.x - near.point.x, anchor.y - near.point.y) < 8 / scaleFactor()))
                return null;
            return { kind: "add", point: near.point, index: near.segIndex };
        };
        const penSegments = (nodes, closed) => (pen === null || pen === void 0 ? void 0 : pen.base) ? [...pen.base, ...buildPenSegments(nodes, false)] : buildPenSegments(nodes, closed);
        const rebuildPenPath = () => { if (!pen)
            return; if (!pen.base)
            pen.path.start = { ...pen.nodes[0].p }; pen.path.segments = penSegments(pen.nodes, pen.path.closed); };
        /** 続きを描ける端点（開いたパスの両端）を、画面上 12px 以内で拾う。 */
        const openPathEndNear = (point) => {
            const reach = PEN_RESUME_PX / scaleFactor();
            let best = null;
            for (const object of currentObjects()) {
                if (object.type !== "path" || object.closed || !object.segments.length)
                    continue;
                const ends = [[true, object.start], [false, object.segments[object.segments.length - 1].to]];
                for (const [atStart, end] of ends) {
                    const distance = Math.hypot(point.x - end.x, point.y - end.y);
                    if (distance <= reach && (!best || distance < best.distance))
                        best = { path: object, atStart, point: end, distance };
                }
            }
            return best;
        };
        /** その端点からペンを再開する。始点側を掴んだときは向きを反転して末尾に揃える。 */
        const startPenFromEnd = (target, atStart) => {
            if (atStart) {
                const reversed = reversePath(target);
                target.start = reversed.start;
                target.segments = reversed.segments;
                const props = target.style.props;
                if (props && (props.arrowStart || props.arrowEnd)) {
                    const swap = props.arrowStart;
                    props.arrowStart = props.arrowEnd;
                    props.arrowEnd = swap;
                }
            }
            const seed = penSeedFromEnd(target);
            pen = { path: target, nodes: [seed], lastOut: seed.out, base: target.segments.slice() };
            penCursor = { ...seed.p };
            penRawCursor = null;
            replaceSelection(target.id);
        };
        svg.addEventListener("pointerup", e => { if (!penDrag)
            return; const { anchor, handle, alt } = penDrag, node = { p: { ...anchor }, kind: handle ? "manual" : alt ? "corner" : "auto", out: handle }; if (!pen) {
            const path = { id: newObjectId(), type: "path", start: { ...anchor }, segments: [], closed: false, style: { props: { lineWidthPt: 1 } } };
            currentObjects().push(path);
            pen = { path, nodes: [node], lastOut: handle, base: null };
        }
        else {
            pen.nodes.push(node);
            pen.lastOut = handle;
            rebuildPenPath();
        } penDrag = null; penCursor = { ...anchor }; penRawCursor = null; if (svg.hasPointerCapture(e.pointerId))
            svg.releasePointerCapture(e.pointerId); render(); scheduleCompile(); });
        const cacheDragLines = () => { if (drag && ["move", "resize", "draw"].includes(drag.kind))
            drag.lines = collectSnapLines(currentObjects().filter(o => !selection.ids.has(o.id)).map(o => objectBounds(o, scene)), scene); };
        svg.addEventListener("pointerdown", e => {
            var _a, _b;
            flushWheelUndo();
            const target = e.target, client = { x: e.clientX, y: e.clientY };
            if (space) {
                drag = { kind: "pan", start: { x: panX, y: panY }, startClient: client, before: cloneScene(scene), lastClient: client };
                hoveredId = null;
                svg.setPointerCapture(e.pointerId);
                render();
                return;
            }
            const raw = rawPoint(e), p = snappedPoint(e), handle = target.dataset.handle, lineEndpoint = target.dataset.lineEndpoint, id = (_a = target.closest("[data-id]")) === null || _a === void 0 ? void 0 : _a.dataset.id;
            if (tool === "node" && editingNodeId && id !== editingNodeId) {
                finishNodeEdit(true);
                const existing = id ? walk(currentObjects(), id) : null;
                if (nodeToolEditsExisting(existing))
                    beginNodeEdit(existing);
                return;
            }
            if (plotEdit && id === plotEdit.id && !handle) {
                drag = { kind: "plot-pan", start: raw, startClient: client, before: cloneScene(scene), id };
                svg.setPointerCapture(e.pointerId);
                render();
                return;
            }
            if (plotEdit && id !== plotEdit.id && !handle && !target.dataset.rotate)
                stopPlotEdit();
            if (tool === "select") {
                const anchorIndex = target.dataset.anchorIndex === undefined ? undefined : Number(target.dataset.anchorIndex), controlSegment = target.dataset.controlSegment === undefined ? undefined : Number(target.dataset.controlSegment), controlKey = target.dataset.controlKey;
                if (anchorEdit && (anchorIndex !== undefined || controlSegment !== undefined)) {
                    const path = walk(currentObjects(), anchorEdit.pathId);
                    if ((path === null || path === void 0 ? void 0 : path.type) !== "path")
                        return;
                    if (anchorIndex !== undefined) {
                        selectedAnchorIndex = anchorIndex;
                        if (e.altKey && (anchorIndex > 0 || path.closed)) {
                            snapshot(false);
                            toggleSegmentKind(path, anchorIndex > 0 ? anchorIndex : path.segments.length);
                            render();
                            scheduleCompile();
                            e.preventDefault();
                            return;
                        }
                    }
                    let mirrorSegment, mirrorKey, mirrorLength;
                    if (controlSegment !== undefined && controlKey) {
                        const n = path.segments.length, oppIndex = controlKey === "c1" ? (controlSegment > 0 ? controlSegment - 1 : path.closed ? n - 1 : -1) : (controlSegment < n - 1 ? controlSegment + 1 : path.closed ? 0 : -1), oppKey = controlKey === "c1" ? "c2" : "c1", anchor = controlKey === "c1" ? (controlSegment === 0 ? path.start : path.segments[controlSegment - 1].to) : path.segments[controlSegment].to, dragged = path.segments[controlSegment], opp = oppIndex >= 0 ? path.segments[oppIndex] : undefined;
                        if ((dragged === null || dragged === void 0 ? void 0 : dragged.type) === "cubic" && (opp === null || opp === void 0 ? void 0 : opp.type) === "cubic" && isMirrorPair(anchor, dragged[controlKey], opp[oppKey])) {
                            mirrorSegment = oppIndex;
                            mirrorKey = oppKey;
                            mirrorLength = Math.hypot(opp[oppKey].x - anchor.x, opp[oppKey].y - anchor.y);
                        }
                    }
                    drag = { kind: "anchor", start: raw, startClient: client, before: cloneScene(scene), id: path.id, anchorIndex, controlSegment, controlKey, mirrorSegment, mirrorKey, mirrorLength };
                    hoveredId = null;
                    svg.setPointerCapture(e.pointerId);
                    render();
                    return;
                }
                if ((anchorEdit === null || anchorEdit === void 0 ? void 0 : anchorEdit.deep) && id === anchorEdit.pathId && !handle && !target.dataset.rotate) {
                    const editPath = walk(currentObjects(), anchorEdit.pathId);
                    if ((editPath === null || editPath === void 0 ? void 0 : editPath.type) === "path") {
                        const scale = Math.min(stage.clientWidth / scene.width, stage.clientHeight / scene.height) * zoom, hit = nearestOnPath(editPath, raw);
                        if (hit.dist <= 8 / scale) {
                            drag = { kind: "bend", start: raw, startClient: client, before: cloneScene(scene), id: editPath.id, segIndex: hit.segIndex, t: Math.max(.15, Math.min(.85, hit.t)) };
                            hoveredId = null;
                            svg.setPointerCapture(e.pointerId);
                            render();
                            return;
                        }
                    }
                }
                const oneId = selectedIdOne();
                if (lineEndpoint !== undefined && oneId) {
                    const path = currentObjects().find(item => item.id === oneId);
                    if ((path === null || path === void 0 ? void 0 : path.type) === "path" && straightLineEndpoints(path)) {
                        drag = { kind: "anchor", start: raw, startClient: client, before: cloneScene(scene), id: path.id, anchorIndex: Number(lineEndpoint) };
                        hoveredId = null;
                        svg.setPointerCapture(e.pointerId);
                        render();
                        return;
                    }
                }
                if (handle && oneId) {
                    const o = currentObjects().find(item => item.id === oneId);
                    drag = { kind: "resize", start: raw, startClient: client, before: cloneScene(scene), id: oneId, handle, bounds: objectBounds(o, scene) };
                }
                else if (target.dataset.rotate && oneId) {
                    const o = currentObjects().find(item => item.id === oneId);
                    drag = { kind: "rotate", start: raw, startClient: client, before: cloneScene(scene), id: oneId, bounds: objectBounds(o, scene), wrapperId: newObjectId() };
                }
                else if (id) {
                    if ((anchorEdit === null || anchorEdit === void 0 ? void 0 : anchorEdit.pathId) !== id)
                        anchorEdit = null;
                    if (e.shiftKey) {
                        anchorEdit = null;
                        toggleSelection(id);
                        hoveredId = null;
                        render();
                        return;
                    }
                    if (!selection.ids.has(id))
                        replaceSelection(id);
                    drag = { kind: "move", start: raw, startClient: client, before: cloneScene(scene), ids: [...selection.ids], bounds: (_b = selectionBounds()) !== null && _b !== void 0 ? _b : undefined };
                }
                else {
                    anchorEdit = null;
                    clearSelection();
                    drag = { kind: "marquee", start: raw, startClient: client, before: cloneScene(scene), current: raw };
                }
                cacheDragLines();
                hoveredId = null;
                render();
                svg.setPointerCapture(e.pointerId);
                return;
            }
            if (tool === "fill") {
                const candidates = paintRegions !== null && paintRegions !== void 0 ? paintRegions : enclosedRegions(boundaryPaths(currentObjects(), scene));
                paintRegions = candidates;
                const region = paintPreview !== null && paintPreview !== void 0 ? paintPreview : enclosedRegionAt(candidates, raw);
                if (!region) {
                    setStatus(uiText("No enclosed region here", "ここには囲まれた領域がありません"), true);
                    return;
                }
                const previous = selection.ids.size === 1 ? nodeById(selection.primaryId) : null, previousStyle = (previous === null || previous === void 0 ? void 0 : previous.type) === "path" && previous.closed && resolveStyle(scene, previous.style).draw === null ? previous.style.props : null;
                const props = previousStyle ? JSON.parse(JSON.stringify(previousStyle)) : { draw: null, fill: "#dbeafe", lineWidthPt: .4 };
                props.draw = null;
                snapshot(false);
                paintRegions = candidates;
                invalidateCompiled();
                const object = { id: newObjectId(), type: "path", start: { ...region.start }, segments: region.segments.map(segment => segment.type === "line" ? { type: "line", to: { ...segment.to } } : { type: "cubic", c1: { ...segment.c1 }, c2: { ...segment.c2 }, to: { ...segment.to } }), closed: true, style: { props } };
                currentObjects().unshift(object);
                replaceSelection(object.id);
                paintPreview = region;
                setStatus(uiText("Region filled — adjust color or hatch in Style", "領域を塗りました。色・網掛けはスタイルで調整できます"));
                render();
                scheduleCompile();
                return;
            }
            const resumablePath = tool === "pen" && !pen ? openPathEndNear(raw) : null;
            if (drawingToolSelectsExistingObject(tool, id, tool === "pen" && Boolean(pen || resumablePath))) {
                replaceSelection(id);
                tool = "select";
                anchorEdit = null;
                hoveredId = null;
                render();
                return;
            }
            if (tool === "node") {
                const hit = id ? walk(currentObjects(), id) : null;
                if (nodeToolEditsExisting(hit)) {
                    beginNodeEdit(hit);
                    return;
                }
                const before = cloneScene(scene), object = { id: newObjectId(), type: "node", at: p, latex: "", anchor: "center", fontShape: "italic", style: {} };
                invalidateCompiled();
                currentObjects().push(object);
                beginNodeEdit(object, true, before);
                return;
            }
            if (tool === "code") {
                snapshot();
                invalidateCompiled();
                const object = { id: newObjectId(), type: "code", tikz: "", transform: { tx: p.x, ty: p.y, rotate: 0, sx: 1, sy: 1 } };
                currentObjects().push(object);
                replaceSelection(object.id);
                render();
                editCode(object);
                return;
            }
            // 曲線は吸着させない: 磁石のスティック↔解放ジャンプは、弾性プレビューでは「点がカーソルから外れる」と見える（実使用の指摘で確定）。格子に沿わせたい直線は直線ツールが担う。
            if (tool === "pen") {
                invalidateCompiled();
                if (pen) {
                    const act = penClickAction({ rawPoint: raw, snappedPoint: raw, start: pen.path.start, last: pen.nodes[pen.nodes.length - 1].p, scaleFactor: scaleFactor(), segmentCount: pen.path.segments.length });
                    if (act.action === "close") {
                        pen.path.closed = true;
                        rebuildPenPath();
                        finishPen();
                        return;
                    }
                    if (act.action === "finish") {
                        finishPen();
                        return;
                    }
                    if (act.action === "skip")
                        return;
                }
                // 既存の開いたパスの端点を掴んだら、新しい線を始めるのではなく続きを描く。
                if (!pen && resumablePath) {
                    snapshot();
                    startPenFromEnd(resumablePath.path, resumablePath.atStart);
                    render();
                    return;
                }
                if (!pen)
                    snapshot();
                penDrag = { anchor: { ...raw }, handle: null, startClient: client, alt: e.altKey };
                penCursor = { ...raw };
                penRawCursor = null;
                svg.setPointerCapture(e.pointerId);
                render();
                return;
            }
            if (tool === "plot") {
                snapshot(false);
                invalidateCompiled();
                const object = { id: newObjectId(), type: "plot", at: { ...p }, width: .01, height: .01, axis: { xmin: -1, xmax: 2, ymin: null, ymax: null, axisLines: "none", grid: "none", xlabel: "", ylabel: "", title: "" }, series: [{ kind: "fn", expr: "x^2", domain: null, samples: 100, color: PLOT_PALETTE[0], thick: true, legend: "", visible: true }], style: {} };
                currentObjects().push(object);
                replaceSelection(object.id);
                drag = { kind: "draw", start: raw, anchor: p, startClient: client, before: cloneScene(scene), id: object.id };
                cacheDragLines();
                svg.setPointerCapture(e.pointerId);
                render();
                return;
            }
            snapshot(false);
            invalidateCompiled();
            const object = tool === "line" ? { id: newObjectId(), type: "path", start: p, segments: [{ type: "line", to: p }], closed: false, style: { props: { lineWidthPt: 1 } } } : tool === "rect" ? { id: newObjectId(), type: "rect", from: p, to: { ...p }, style: { props: { lineWidthPt: 1 } } } : { id: newObjectId(), type: "ellipse", center: p, rx: 0, ry: 0, style: { props: { lineWidthPt: 1 } } };
            currentObjects().push(object);
            replaceSelection(object.id);
            drag = { kind: "draw", start: raw, anchor: p, startClient: client, before: cloneScene(scene), id: object.id };
            cacheDragLines();
            svg.setPointerCapture(e.pointerId);
            render();
        });
        svg.addEventListener("pointermove", e => {
            var _a, _b, _c, _d;
            if (penDrag) {
                const cursor = rawPoint(e);
                penDrag.handle = Math.hypot(e.clientX - penDrag.startClient.x, e.clientY - penDrag.startClient.y) >= 4 ? { x: cursor.x - penDrag.anchor.x, y: cursor.y - penDrag.anchor.y } : null;
                penCursor = cursor;
                render();
                return;
            }
            if (pen && !drag) {
                const rawCursor = rawPoint(e);
                penCursor = rawCursor;
                penRawCursor = rawCursor;
                penResume = openPathEndNear(rawCursor);
                render();
                return;
            }
            if (tool === "fill" && !drag) {
                const regions = paintRegions !== null && paintRegions !== void 0 ? paintRegions : enclosedRegions(boundaryPaths(currentObjects(), scene)), next = enclosedRegionAt(regions, rawPoint(e));
                paintRegions = regions;
                svg.style.cursor = next ? "crosshair" : "not-allowed";
                if (next !== paintPreview) {
                    paintPreview = next;
                    render();
                }
                return;
            }
            // 1 点目を置く前もカーソル位置に印を出す。どこに落ちるか・どの端点から続けられるかを先に見せる。
            if (tool === "pen" && !penDrag && !drag) {
                const rawCursor = rawPoint(e), next = rawCursor, resume = openPathEndNear(rawCursor);
                if (!penCursor || penCursor.x !== next.x || penCursor.y !== next.y || (penRawCursor === null || penRawCursor === void 0 ? void 0 : penRawCursor.x) !== rawCursor.x || (penRawCursor === null || penRawCursor === void 0 ? void 0 : penRawCursor.y) !== rawCursor.y || (penResume === null || penResume === void 0 ? void 0 : penResume.path.id) !== (resume === null || resume === void 0 ? void 0 : resume.path.id) || (penResume === null || penResume === void 0 ? void 0 : penResume.atStart) !== (resume === null || resume === void 0 ? void 0 : resume.atStart)) {
                    penCursor = next;
                    penRawCursor = rawCursor;
                    penResume = resume;
                    render();
                }
                return;
            }
            if (!drag) {
                const target = e.target, nextHoveredId = (_b = (_a = target.closest("[data-id]")) === null || _a === void 0 ? void 0 : _a.dataset.id) !== null && _b !== void 0 ? _b : null, handle = target.dataset.handle;
                svg.style.cursor = target.dataset.rotate ? "grab" : handle ? `${handle}-resize` : (anchorEdit === null || anchorEdit === void 0 ? void 0 : anchorEdit.deep) && nextHoveredId === anchorEdit.pathId ? "crosshair" : nextHoveredId ? "move" : "default";
                // 深い編集では「ここをダブルクリックすると頂点が増える／減る」を印で先に見せる。
                const nextHint = (anchorEdit === null || anchorEdit === void 0 ? void 0 : anchorEdit.deep) ? hintAt(target, rawPoint(e)) : null;
                const changed = ((pathHint === null || pathHint === void 0 ? void 0 : pathHint.kind) !== (nextHint === null || nextHint === void 0 ? void 0 : nextHint.kind)) || ((pathHint === null || pathHint === void 0 ? void 0 : pathHint.index) !== (nextHint === null || nextHint === void 0 ? void 0 : nextHint.index)) || (nextHint && pathHint && Math.hypot(nextHint.point.x - pathHint.point.x, nextHint.point.y - pathHint.point.y) > .05);
                pathHint = nextHint;
                if (nextHoveredId !== hoveredId || changed) {
                    hoveredId = nextHoveredId;
                    render();
                }
                return;
            }
            if (drag.kind === "pan" && drag.lastClient) {
                panX = drag.start.x + e.clientX - drag.lastClient.x;
                panY = drag.start.y + e.clientY - drag.lastClient.y;
                render();
                return;
            }
            const raw = rawPoint(e), crossedThreshold = !drag.moved && Math.hypot(e.clientX - drag.startClient.x, e.clientY - drag.startClient.y) >= 4;
            if (crossedThreshold) {
                drag.moved = true;
                if (["move", "resize", "rotate", "anchor", "bend", "plot-pan"].includes(drag.kind))
                    invalidateCompiled();
            }
            if (drag.kind === "marquee") {
                drag.current = raw;
                if (drag.moved) {
                    const rect = { minX: Math.min(drag.start.x, raw.x), minY: Math.min(drag.start.y, raw.y), maxX: Math.max(drag.start.x, raw.x), maxY: Math.max(drag.start.y, raw.y) };
                    selection.ids = new Set(marqueeHits(rect, currentObjects().map(item => ({ id: item.id, bounds: objectBounds(item, scene) }))));
                    const ids = [...selection.ids];
                    selection.primaryId = (_c = ids[ids.length - 1]) !== null && _c !== void 0 ? _c : null;
                }
                render();
                return;
            }
            scene = cloneScene(drag.before);
            if (drag.kind === "plot-pan") {
                const object = drag.id ? walk(currentObjects(), drag.id) : null;
                if ((object === null || object === void 0 ? void 0 : object.type) !== "plot")
                    return;
                const bl = sceneToScreen(object.at, view()), tr = sceneToScreen({ x: object.at.x + object.width, y: object.at.y + object.height }, view()), width = Math.max(1, Math.abs(tr.x - bl.x)), height = Math.max(1, Math.abs(tr.y - bl.y)), xr = panRange(object.axis.xmin, object.axis.xmax, -(e.clientX - drag.startClient.x) / width);
                object.axis.xmin = xr.min;
                object.axis.xmax = xr.max;
                if (object.axis.ymin !== null && object.axis.ymax !== null) {
                    const yr = panRange(object.axis.ymin, object.axis.ymax, (e.clientY - drag.startClient.y) / height);
                    object.axis.ymin = yr.min;
                    object.axis.ymax = yr.max;
                }
                render();
                return;
            }
            if (drag.kind === "anchor") {
                const path = drag.id ? walk(currentObjects(), drag.id) : null;
                if ((path === null || path === void 0 ? void 0 : path.type) !== "path")
                    return;
                if (drag.controlSegment !== undefined && drag.controlKey) {
                    const segment = path.segments[drag.controlSegment];
                    if ((segment === null || segment === void 0 ? void 0 : segment.type) === "cubic") {
                        Object.assign(segment[drag.controlKey], raw);
                        if (drag.mirrorSegment !== undefined && drag.mirrorKey && drag.mirrorLength !== undefined && !e.altKey) {
                            const anchor = drag.controlKey === "c1" ? (drag.controlSegment === 0 ? path.start : path.segments[drag.controlSegment - 1].to) : segment.to, opp = path.segments[drag.mirrorSegment];
                            if ((opp === null || opp === void 0 ? void 0 : opp.type) === "cubic")
                                Object.assign(opp[drag.mirrorKey], mirroredControl(anchor, raw, drag.mirrorLength));
                        }
                    }
                }
                else if (drag.anchorIndex !== undefined) {
                    const points = [path.start, ...path.segments.map(segment => segment.to)], point = points[drag.anchorIndex], target = snapToGrid(raw, scene.grid.size, scene.grid.snap && !e.altKey, GRID_PULL), dx = target.x - point.x, dy = target.y - point.y;
                    point.x = target.x;
                    point.y = target.y;
                    const closed0 = path.closed && drag.anchorIndex === 0, incoming = closed0 ? path.segments[path.segments.length - 1] : path.segments[drag.anchorIndex - 1], outgoing = path.segments[drag.anchorIndex];
                    if (closed0 && incoming) {
                        incoming.to.x = target.x;
                        incoming.to.y = target.y;
                    }
                    if ((incoming === null || incoming === void 0 ? void 0 : incoming.type) === "cubic") {
                        incoming.c2.x += dx;
                        incoming.c2.y += dy;
                    }
                    if ((outgoing === null || outgoing === void 0 ? void 0 : outgoing.type) === "cubic") {
                        outgoing.c1.x += dx;
                        outgoing.c1.y += dy;
                    }
                }
                render();
                return;
            }
            if (drag.kind === "bend") {
                const path = drag.id ? walk(currentObjects(), drag.id) : null;
                if ((path === null || path === void 0 ? void 0 : path.type) !== "path" || drag.segIndex === undefined || drag.t === undefined)
                    return;
                let seg = path.segments[drag.segIndex];
                if (!seg)
                    return;
                if (seg.type === "line") {
                    const from = drag.segIndex === 0 ? path.start : path.segments[drag.segIndex - 1].to;
                    seg = { type: "cubic", c1: { x: from.x + (seg.to.x - from.x) / 3, y: from.y + (seg.to.y - from.y) / 3 }, c2: { x: from.x + (seg.to.x - from.x) * 2 / 3, y: from.y + (seg.to.y - from.y) * 2 / 3 }, to: { ...seg.to } };
                    path.segments[drag.segIndex] = seg;
                }
                bendSegment(seg, drag.t, { x: raw.x - drag.start.x, y: raw.y - drag.start.y });
                render();
                return;
            }
            const delta = snappedDelta(drag.start, raw, e), origin = (_d = drag.anchor) !== null && _d !== void 0 ? _d : drag.start, p = { x: origin.x + delta.x, y: origin.y + delta.y };
            if (drag.kind === "move") {
                for (const id of drag.ids || []) {
                    const object = currentObjects().find(item => item.id === id);
                    if (object)
                        moveObject(object, delta.x, delta.y);
                }
            }
            else {
                const o = drag.id ? currentObjects().find(item => item.id === drag.id) : null;
                if (!o)
                    return;
                if (drag.kind === "resize" && drag.bounds && drag.handle)
                    resizeObject(o, drag.bounds, boundsAfterHandleDrag(drag.bounds, drag.handle, p));
                else if (drag.kind === "rotate") {
                    const b = drag.bounds, c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, angle = (Math.atan2(raw.y - c.y, raw.x - c.x) - Math.atan2(drag.start.y - c.y, drag.start.x - c.x)) * 180 / Math.PI;
                    if (o.type === "group" || o.type === "instance" || o.type === "code")
                        rotateTransformAround(o.transform, c, angle);
                    else if (o.type === "rect" || o.type === "ellipse") {
                        const wrapper = { id: drag.wrapperId, type: "group", children: [o], transform: { tx: 0, ty: 0, rotate: 0, sx: 1, sy: 1 } };
                        rotateTransformAround(wrapper.transform, c, angle);
                        replaceById(currentObjects(), o.id, wrapper);
                        replaceSelectedId(o.id, wrapper.id);
                    }
                    else {
                        const rad = angle * Math.PI / 180, points = o.type === "repeat" ? [o.path.start, ...o.path.segments.flatMap(segment => segment.type === "line" ? [segment.to] : [segment.c1, segment.c2, segment.to])] : allPoints(o, scene);
                        points.forEach(q => { const x = q.x - c.x, y = q.y - c.y; q.x = c.x + x * Math.cos(rad) - y * Math.sin(rad); q.y = c.y + x * Math.sin(rad) + y * Math.cos(rad); });
                    }
                }
                else if (drag.kind === "draw") {
                    if (o.type === "rect")
                        o.to = p;
                    else if (o.type === "ellipse") {
                        o.center = { x: (origin.x + p.x) / 2, y: (origin.y + p.y) / 2 };
                        o.rx = Math.abs(p.x - origin.x) / 2;
                        o.ry = Math.abs(p.y - origin.y) / 2;
                    }
                    else if (o.type === "path")
                        o.segments[0] = { type: "line", to: p };
                    else if (o.type === "plot") {
                        o.at = { x: Math.min(origin.x, p.x), y: Math.min(origin.y, p.y) };
                        o.width = Math.max(.01, Math.abs(p.x - origin.x));
                        o.height = Math.max(.01, Math.abs(p.y - origin.y));
                    }
                }
            }
            render();
        });
        svg.addEventListener("pointerup", () => { if ((drag === null || drag === void 0 ? void 0 : drag.kind) === "plot-pan" && drag.moved) {
            undo.push(drag.before);
            redo = [];
            scheduleCompile();
        } });
        svg.addEventListener("pointerup", e => {
            var _a, _b;
            const completed = drag, changed = Boolean((completed === null || completed === void 0 ? void 0 : completed.moved) && ["move", "resize", "rotate", "anchor", "bend"].includes(completed.kind));
            const drawn = (completed === null || completed === void 0 ? void 0 : completed.kind) === "draw" && completed.id ? currentObjects().find(item => item.id === completed.id) : null, plotDrawn = (drawn === null || drawn === void 0 ? void 0 : drawn.type) === "plot" ? drawn : null;
            if (plotDrawn && !completed.moved) {
                plotDrawn.width = 60;
                plotDrawn.height = 45;
                plotDrawn.at = { x: Math.max(0, Math.min(scene.width - 60, plotDrawn.at.x - 30)), y: Math.max(0, Math.min(scene.height - 45, plotDrawn.at.y - 22.5)) };
            } // plot はクリックのみでも既定サイズで配置（他ツールの「未ドラッグ=キャンセル」を適用しない）
            const drewObject = Boolean(drawn && (completed.moved || plotDrawn));
            if (changed) {
                undo.push(completed.before);
                redo = [];
            }
            else if (completed && !completed.moved && ["move", "resize", "rotate", "anchor", "bend"].includes(completed.kind)) {
                scene = completed.before;
            }
            else if ((completed === null || completed === void 0 ? void 0 : completed.kind) === "draw" && !completed.moved && completed.id && !plotDrawn) {
                removeById(currentObjects(), completed.id);
                clearSelection();
                undo.pop();
            }
            drag = null;
            penDrag = null;
            if (svg.hasPointerCapture(e.pointerId))
                svg.releasePointerCapture(e.pointerId);
            if (plotDrawn) {
                tool = "select";
                anchorEdit = null;
                plotEdit = { id: plotDrawn.id, emptyUndoDepth: undo.length - 1 };
                replaceSelection(plotDrawn.id);
                plotCardSignature = "";
            } // 配置直後に編集カードを開く（mathcha 同様）。ツールは select へ戻す
            render();
            if (changed || drewObject)
                scheduleCompile();
            if (plotDrawn)
                requestAnimationFrame(() => buildPlotCard(plotDrawn, 0));
            // render() が DOM を差し替えるため native dblclick は当てにならない。クリック2連打を自前検出する。
            if (tool === "select" && completed && !completed.moved) {
                const now = performance.now();
                if (lastClick && now - lastClick.t < 400 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 6) {
                    lastClick = null;
                    const id = (_a = e.target.closest("[data-id]")) === null || _a === void 0 ? void 0 : _a.dataset.id;
                    const deepPath = (anchorEdit === null || anchorEdit === void 0 ? void 0 : anchorEdit.deep) ? walk(currentObjects(), anchorEdit.pathId) : null;
                    // 頂点の上でのダブルクリックは削除。＋−の印で予告しているので、実際に効くこと。
                    // pointer capture 中の pointerup は e.target が svg になるため、掴んだ頂点は
                    // pointerdown 時に記録した drag（completed）から取る。
                    const removeIndex = completed.kind === "anchor" && completed.controlKey === undefined ? completed.anchorIndex : undefined;
                    if (removeIndex !== undefined && (deepPath === null || deepPath === void 0 ? void 0 : deepPath.type) === "path" && canRemoveAnchor(deepPath)) {
                        snapshot();
                        const index = removeIndex;
                        if (!removeAnchor(deepPath, index))
                            removeById(currentObjects(), deepPath.id);
                        pathHint = null;
                        selectedAnchorIndex = Math.max(0, Math.min(index, deepPath.segments.length - (deepPath.closed ? 1 : 0)));
                        render();
                        scheduleCompile();
                        return;
                    }
                    const editPath = (anchorEdit === null || anchorEdit === void 0 ? void 0 : anchorEdit.deep) && completed.kind === "bend" ? walk(currentObjects(), anchorEdit.pathId) : null;
                    if ((editPath === null || editPath === void 0 ? void 0 : editPath.type) === "path") {
                        const scale = Math.min(stage.clientWidth / scene.width, stage.clientHeight / scene.height) * zoom, hit = nearestOnPath(editPath, rawPoint(e));
                        if (hit.dist <= 8 / scale) {
                            snapshot();
                            const from = hit.segIndex === 0 ? editPath.start : editPath.segments[hit.segIndex - 1].to, [first, second] = splitSegmentAt(from, editPath.segments[hit.segIndex], hit.t);
                            editPath.segments.splice(hit.segIndex, 1, first, second);
                            selectedAnchorIndex = hit.segIndex + 1;
                            render();
                            scheduleCompile();
                        }
                    }
                    else {
                        const object = (_b = (id ? walk(currentObjects(), id) : null)) !== null && _b !== void 0 ? _b : (selection.ids.size === 1 ? walk(currentObjects(), selection.primaryId) : null);
                        activateForEdit(object);
                    }
                }
                else
                    lastClick = { t: now, x: e.clientX, y: e.clientY };
            }
            else
                lastClick = null;
        });
        svg.addEventListener("pointerleave", () => { if (drag || penDrag)
            return; const had = hoveredId || penResume || pathHint || paintPreview || (!pen && penCursor); if (!had)
            return; hoveredId = null; paintPreview = null; svg.style.cursor = "default"; clearPointerMarkers(); render(); });
        const close = () => { stageObserver === null || stageObserver === void 0 ? void 0 : stageObserver.disconnect(); window.removeEventListener("keydown", onKey, true); window.removeEventListener("keydown", onToolKey, true); window.removeEventListener("keyup", onKeyUp, true); if (plotCompileTimer)
            clearTimeout(plotCompileTimer); if (wheelUndoTimer)
            clearTimeout(wheelUndoTimer); overlay.remove(); if (closeCurrent === close)
            closeCurrent = null; };
        closeCurrent = close;
        const finishPen = () => { if (!pen)
            return; const path = pen.path; pen = null; penDrag = null; penCursor = null; penRawCursor = null; penResume = null; if (!path.segments.length) {
            removeById(currentObjects(), path.id);
            clearSelection();
        }
        else {
            replaceSelection(path.id);
            tool = "select";
            anchorEdit = { pathId: path.id, deep: true };
            selectedAnchorIndex = 0;
        } invalidatePaintRegions(); render(); scheduleCompile(); };
        const abortPen = () => { if (pen && !pen.path.segments.length)
            removeById(currentObjects(), pen.path.id); pen = null; penDrag = null; penCursor = null; penRawCursor = null; penResume = null; };
        const retainSelection = () => { var _a; selection.ids = new Set([...selection.ids].filter(id => walk(currentObjects(), id))); selection.primaryId = selection.primaryId && selection.ids.has(selection.primaryId) ? selection.primaryId : (_a = [...selection.ids][0]) !== null && _a !== void 0 ? _a : null; };
        const undoOnce = () => { flushWheelUndo(); pen = null; penDrag = null; penCursor = null; penRawCursor = null; const prev = undo.pop(); if (!prev)
            return; redo.push(cloneScene(scene)); scene = prev; invalidatePaintRegions(); retainSelection(); if (plotEdit && walk(currentObjects(), plotEdit.id))
            replaceSelection(plotEdit.id); plotCardSignature = ""; render(); scheduleCompile(); };
        const redoOnce = () => { flushWheelUndo(); pen = null; penDrag = null; penCursor = null; penRawCursor = null; const next = redo.pop(); if (!next)
            return; undo.push(cloneScene(scene)); scene = next; invalidatePaintRegions(); retainSelection(); if (plotEdit && walk(currentObjects(), plotEdit.id))
            replaceSelection(plotEdit.id); plotCardSignature = ""; render(); scheduleCompile(); };
        const cloneWithNewIds = (object) => { const copy = JSON.parse(JSON.stringify(object)); const renew = (item) => { item.id = newObjectId(); if (item.type === "group")
            item.children.forEach(renew); }; renew(copy); return copy; };
        const onKey = (e) => {
            var _a, _b;
            if (editingNodeId)
                return;
            const target = e.target;
            if (target === null || target === void 0 ? void 0 : target.closest("input,select,textarea,math-field,[contenteditable=true]"))
                return;
            e.stopPropagation();
            const command = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
            if (e.key === "Escape") {
                e.preventDefault();
                if (canvasPop) {
                    closeCanvasPop();
                    return;
                }
                if (colorPop) {
                    closeColorPop();
                    return;
                }
                if (plotEdit) {
                    stopPlotEdit();
                    return;
                }
                if (anchorEdit === null || anchorEdit === void 0 ? void 0 : anchorEdit.deep) {
                    anchorEdit.deep = false;
                    render();
                    return;
                }
                if (pen || penDrag) {
                    penDrag = null;
                    finishPen();
                    return;
                }
                if (editingSymbolId) {
                    editingSymbolId = null;
                    clearSelection();
                    render();
                    scheduleCompile();
                    return;
                }
                if (selection.ids.size) {
                    clearSelection();
                    render();
                }
                return;
            }
            if (e.key === " ") {
                space = true;
                e.preventDefault();
                return;
            }
            if (e.key === "Enter" && (pen || penDrag)) {
                penDrag = null;
                finishPen();
                return;
            }
            if ((e.key === "Delete" || e.key === "Backspace") && (anchorEdit === null || anchorEdit === void 0 ? void 0 : anchorEdit.deep)) {
                const path = walk(currentObjects(), anchorEdit.pathId);
                if ((path === null || path === void 0 ? void 0 : path.type) === "path") {
                    snapshot();
                    if (!removeAnchor(path, selectedAnchorIndex)) {
                        removeById(currentObjects(), path.id);
                        anchorEdit = null;
                        clearSelection();
                    }
                    else
                        selectedAnchorIndex = Math.max(0, Math.min(selectedAnchorIndex, path.closed ? path.segments.length - 1 : path.segments.length));
                    render();
                    scheduleCompile();
                    e.preventDefault();
                    return;
                }
            }
            if ((e.key === "Delete" || e.key === "Backspace") && selection.ids.size) {
                snapshot();
                const ids = [...selection.ids];
                ids.forEach(id => removeById(currentObjects(), id));
                clearSelection();
                render();
                e.preventDefault();
                return;
            }
            if (command && key === "z") {
                e.preventDefault();
                e.shiftKey ? redoOnce() : undoOnce();
                return;
            }
            if (command && key === "d" && selection.ids.size) {
                e.preventDefault();
                snapshot();
                const copies = topLevelSelectedObjects().map(cloneWithNewIds), offset = scene.grid.size;
                copies.forEach(copy => moveObject(copy, offset, offset));
                currentObjects().push(...copies);
                selection.ids = new Set(copies.map(copy => copy.id));
                selection.primaryId = (_b = (_a = copies[copies.length - 1]) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : null;
                render();
                return;
            }
            if (command && key === "g") {
                e.preventDefault();
                const objects = currentObjects(), oneId = selectedIdOne();
                if (e.shiftKey && oneId) {
                    const group = objects.find(item => item.id === oneId);
                    if ((group === null || group === void 0 ? void 0 : group.type) === "group") {
                        snapshot();
                        const index = objects.indexOf(group);
                        objects.splice(index, 1, ...group.children);
                        clearSelection();
                        render();
                    }
                }
                else {
                    const selected = topLevelSelectedObjects();
                    if (selected.length) {
                        snapshot();
                        const indices = selected.map(item => objects.indexOf(item)).filter(index => index >= 0), index = Math.min(...indices);
                        selected.forEach(item => removeById(objects, item.id));
                        const group = { id: newObjectId(), type: "group", children: selected, transform: { tx: 0, ty: 0, rotate: 0, sx: 1, sy: 1 } };
                        objects.splice(index, 0, group);
                        replaceSelection(group.id);
                        render();
                    }
                }
                return;
            }
            if (command && (e.key === "]" || e.key === "[") && selection.ids.size) {
                e.preventDefault();
                changeOrder(e.key === "]" ? (e.shiftKey ? "front" : "forward") : (e.shiftKey ? "back" : "backward"));
                return;
            }
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) && selection.ids.size) {
                e.preventDefault();
                const amount = e.shiftKey ? scene.grid.size : 1, dx = e.key === "ArrowLeft" ? -amount : e.key === "ArrowRight" ? amount : 0, dy = e.key === "ArrowDown" ? -amount : e.key === "ArrowUp" ? amount : 0;
                snapshot();
                topLevelSelectedObjects().forEach(object => moveObject(object, dx, dy));
                render();
                return;
            }
        };
        const onToolKey = (e) => { const target = e.target; if ((target === null || target === void 0 ? void 0 : target.closest("input,select,textarea,math-field,[contenteditable=true]")) || e.metaKey || e.ctrlKey || e.altKey)
            return; const next = { v: "select", p: "pen", g: "plot", l: "line", r: "rect", e: "ellipse", f: "fill", t: "node" }[e.key.toLowerCase()]; if (next) {
            if (next !== "pen")
                abortPen();
            if (next === "select")
                anchorEdit = null;
            tool = next;
            invalidatePaintRegions();
            clearPointerMarkers();
            e.preventDefault();
            render();
        } };
        const onKeyUp = (e) => { const target = e.target; if (target === null || target === void 0 ? void 0 : target.closest("input,select,textarea,math-field,[contenteditable=true]"))
            return; e.stopPropagation(); if (e.key === " ")
            space = false; };
        window.addEventListener("keydown", onToolKey, true);
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("keyup", onKeyUp, true);
        svg.addEventListener("wheel", e => { const object = plotObject(), point = screenToScene({ x: e.clientX, y: e.clientY }, view()); if (object && point.x >= object.at.x && point.x <= object.at.x + object.width && point.y >= object.at.y && point.y <= object.at.y + object.height) {
            e.preventDefault();
            if (!wheelBefore)
                wheelBefore = cloneScene(scene);
            const tx = (point.x - object.at.x) / object.width, ty = (point.y - object.at.y) / object.height, factor = Math.exp(e.deltaY * .002), xr = zoomRange(object.axis.xmin, object.axis.xmax, tx, factor);
            object.axis.xmin = xr.min;
            object.axis.xmax = xr.max;
            if (object.axis.ymin !== null && object.axis.ymax !== null) {
                const yr = zoomRange(object.axis.ymin, object.axis.ymax, ty, factor);
                object.axis.ymin = yr.min;
                object.axis.ymax = yr.max;
            }
            debouncePlotCompile();
            render();
            if (wheelUndoTimer)
                clearTimeout(wheelUndoTimer);
            wheelUndoTimer = setTimeout(() => { const snappedX = snapRangeToNice(object.axis.xmin, object.axis.xmax); object.axis.xmin = snappedX.min; object.axis.xmax = snappedX.max; if (object.axis.ymin !== null && object.axis.ymax !== null) {
                const snappedY = snapRangeToNice(object.axis.ymin, object.axis.ymax);
                object.axis.ymin = snappedY.min;
                object.axis.ymax = snappedY.max;
            } if (wheelBefore) {
                undo.push(wheelBefore);
                redo = [];
                wheelBefore = null;
            } wheelUndoTimer = null; debouncePlotCompile(); render(); }, 600);
            return;
        } e.preventDefault(); if (e.ctrlKey || e.metaKey) {
            const rect = svg.getBoundingClientRect(), oldZoom = zoom, newZoom = Math.max(.25, Math.min(4, zoom * Math.exp(-e.deltaY * .002))), cursor = { x: e.clientX - (rect.left + rect.width / 2), y: e.clientY - (rect.top + rect.height / 2) }, next = zoomAtPoint({ panX, panY, zoom: oldZoom }, cursor, newZoom);
            zoom = newZoom;
            panX = next.panX;
            panY = next.panY;
        }
        else {
            panX -= e.deltaX;
            panY -= e.deltaY;
        } render(); }, { passive: false });
        // 図がどこへ入ったかは、カーソルを置いて画面に出し、数秒だけ行を光らせて示す。
        // カーソル位置に入れられないとき（プリアンブル・数式環境の中など）に、黙って
        // 別の場所へ落ちるのが一番わかりにくいので、必ず見える形で着地させる。
        const showInserted = (editor, startLine, lineCount, relocated = false) => {
            var _a, _b, _c, _d, _e;
            const target = editor, Range = (_a = window.monaco) === null || _a === void 0 ? void 0 : _a.Range;
            if (!target || !Range || lineCount < 1)
                return;
            const endLine = startLine + lineCount - 1;
            (_b = target.setPosition) === null || _b === void 0 ? void 0 : _b.call(target, { lineNumber: Math.min(startLine + 1, endLine), column: 1 });
            // カーソル位置に入れられなかったときは、必ず画面中央まで送って着地点を見せる。
            if (relocated)
                (_c = target.revealLineInCenter) === null || _c === void 0 ? void 0 : _c.call(target, startLine);
            else
                (_d = target.revealLineInCenterIfOutsideViewport) === null || _d === void 0 ? void 0 : _d.call(target, startLine);
            const ids = (_e = target.deltaDecorations) === null || _e === void 0 ? void 0 : _e.call(target, [], [{ range: new Range(startLine, 1, endLine, 1), options: { isWholeLine: true, className: "pro-canvas-inserted-line" } }]);
            if (ids === null || ids === void 0 ? void 0 : ids.length)
                setTimeout(() => { var _a; return (_a = target.deltaDecorations) === null || _a === void 0 ? void 0 : _a.call(target, ids, []); }, 2200);
        };
        const replaceOrInsert = () => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
            const editor = anchorEditor;
            const block = encodeFigureBlock(scene), blockLines = block.split("\n").length - 1;
            if (!detail.replaceRange) {
                // %% ヘッダ行が行頭に来ないとブロックが壊れるため、行中カーソルでは改行してから挿入する。
                const model = (_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor), text = (_b = model === null || model === void 0 ? void 0 : model.getValue) === null || _b === void 0 ? void 0 : _b.call(model), cursor = anchorPosition !== null && anchorPosition !== void 0 ? anchorPosition : { lineNumber: 1, column: 1 }, Range = (_c = window.monaco) === null || _c === void 0 ? void 0 : _c.Range;
                if (typeof text === "string" && Range && (editor === null || editor === void 0 ? void 0 : editor.executeEdits)) {
                    // 未クリックのエディタはカーソルが 1:1 のまま。そこへ入れると \documentclass の前に図が入って文書が壊れる。
                    const generated = generateTikz(scene), plan = planFigureInsert(text, cursor, generated.requires, sceneHasPlot(scene), generated.needsGraphicx), edits = [{ range: new Range(plan.body.lineNumber, plan.body.column, plan.body.lineNumber, plan.body.column), text: plan.body.column > 1 ? `\n${block}` : block, forceMoveMarkers: true }];
                    if (plan.preamble)
                        edits.push({ range: new Range(plan.preamble.lineNumber, 1, plan.preamble.lineNumber, 1), text: plan.preamble.text, forceMoveMarkers: true });
                    (_d = editor.pushUndoStop) === null || _d === void 0 ? void 0 : _d.call(editor);
                    editor.executeEdits("pro-canvas", edits);
                    (_e = editor.pushUndoStop) === null || _e === void 0 ? void 0 : _e.call(editor);
                    (_f = editor.focus) === null || _f === void 0 ? void 0 : _f.call(editor);
                    const shift = plan.preamble ? plan.preamble.text.split("\n").length - 1 : 0;
                    showInserted(editor, plan.body.lineNumber + (plan.body.column > 1 ? 1 : 0) + shift, blockLines, plan.moved !== null);
                    close();
                    return;
                }
                insertAtEditorCursor(editor, cursor.column > 1 ? `\n${block}` : block, "pro-canvas");
                close();
                return;
            }
            const Range = (_g = window.monaco) === null || _g === void 0 ? void 0 : _g.Range;
            if (!(editor === null || editor === void 0 ? void 0 : editor.executeEdits) || !Range)
                throw new Error("No active text editor is available.");
            (_h = editor.pushUndoStop) === null || _h === void 0 ? void 0 : _h.call(editor);
            editor.executeEdits("pro-canvas", [{ range: new Range(detail.replaceRange.startLine, 1, detail.replaceRange.endLine + 1, 1), text: block, forceMoveMarkers: true }]);
            (_j = editor.pushUndoStop) === null || _j === void 0 ? void 0 : _j.call(editor);
            (_k = editor.focus) === null || _k === void 0 ? void 0 : _k.call(editor);
            showInserted(editor, detail.replaceRange.startLine, blockLines);
            close();
        };
        overlay.addEventListener("click", e => { const button = e.target.closest("button"); if (!button)
            return; if (button.dataset.tool) {
            if (button.dataset.tool !== "pen")
                abortPen();
            if (button.dataset.tool === "select")
                anchorEdit = null;
            tool = button.dataset.tool;
            invalidatePaintRegions();
            clearPointerMarkers();
            render();
            return;
        } try {
            switch (button.dataset.action) {
                case "cancel":
                    close();
                    break;
                case "canvas-settings":
                    openCanvasSettings(button);
                    break;
                case "snap":
                    if (tool === "node")
                        nodePlacementSnap = !nodePlacementSnap;
                    else {
                        snapshot();
                        scene.grid.snap = !scene.grid.snap;
                    }
                    render();
                    break;
                case "zoom-out":
                    zoom = Math.max(.25, zoom / 1.25);
                    render();
                    break;
                case "zoom-in":
                    zoom = Math.min(4, zoom * 1.25);
                    render();
                    break;
                case "zoom-reset":
                    zoom = 1;
                    panX = panY = 0;
                    render();
                    break;
                case "undo":
                    undoOnce();
                    break;
                case "redo":
                    redoOnce();
                    break;
                case "tikz":
                    replaceOrInsert();
                    break;
            }
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : String(error), true);
        } });
        const activateForEdit = (object) => { if (!object)
            return; if (object.type === "node") {
            if (editingNodeId !== object.id)
                beginNodeEdit(object);
            return;
        } if (object.type === "plot") {
            anchorEdit = null;
            plotEdit = { id: object.id };
            replaceSelection(object.id);
            render();
            return;
        } if (object.type === "path") {
            replaceSelection(object.id);
            if ((anchorEdit === null || anchorEdit === void 0 ? void 0 : anchorEdit.pathId) !== object.id) {
                anchorEdit = { pathId: object.id, deep: true };
                selectedAnchorIndex = 0;
            }
            else
                anchorEdit.deep = true;
            render();
            return;
        } if (object.type === "code") {
            anchorEdit = null;
            replaceSelection(object.id);
            render();
            editCode(object);
        } };
        svg.addEventListener("dblclick", e => { var _a, _b; if (tool !== "select")
            return; const id = (_a = e.target.closest("[data-id]")) === null || _a === void 0 ? void 0 : _a.dataset.id, object = (_b = (id ? walk(currentObjects(), id) : null)) !== null && _b !== void 0 ? _b : (selection.ids.size === 1 ? walk(currentObjects(), selection.primaryId) : null); if (object) {
            activateForEdit(object);
            e.preventDefault();
        } });
        svg.addEventListener("pointermove", e => { var _a; if (!drag || !["move", "resize", "draw"].includes(drag.kind) || !drag.moved)
            return; drag.client = { x: e.clientX, y: e.clientY }; const object = drag.id ? currentObjects().find(o => o.id === drag.id) : null, origin = (_a = drag.anchor) !== null && _a !== void 0 ? _a : drag.start; let bounds = drag.kind === "move" ? selectionBounds() : object ? objectBounds(object, scene) : null; if (e.shiftKey && drag.kind === "draw" && object) {
            const raw = rawPoint(e), dx = raw.x - origin.x, dy = raw.y - origin.y;
            if (object.type === "path") {
                const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, length = Math.hypot(dx, dy);
                object.segments[0] = { type: "line", to: { x: origin.x + Math.cos(angle) * length, y: origin.y + Math.sin(angle) * length } };
            }
            else {
                const side = Math.max(Math.abs(dx), Math.abs(dy)), p = { x: origin.x + (dx < 0 ? -side : side), y: origin.y + (dy < 0 ? -side : side) };
                if (object.type === "rect")
                    object.to = p;
                else if (object.type === "ellipse") {
                    object.center = { x: (origin.x + p.x) / 2, y: (origin.y + p.y) / 2 };
                    object.rx = object.ry = side / 2;
                }
            }
            bounds = objectBounds(object, scene);
        }
        else if (e.shiftKey && drag.kind === "resize" && object && drag.bounds && drag.handle && drag.handle.length === 2) {
            const b = drag.bounds, ratio = (b.maxX - b.minX) / Math.max(b.maxY - b.minY, .01), candidate = objectBounds(object, scene), width = candidate.maxX - candidate.minX, height = candidate.maxY - candidate.minY;
            if (width / Math.max(height, .01) > ratio) {
                const wanted = width / ratio;
                if (drag.handle.includes("n"))
                    candidate.maxY = candidate.minY + wanted;
                else
                    candidate.minY = candidate.maxY - wanted;
            }
            else {
                const wanted = height * ratio;
                if (drag.handle.includes("e"))
                    candidate.maxX = candidate.minX + wanted;
                else
                    candidate.minX = candidate.maxX - wanted;
            }
            resizeObject(object, objectBounds(object, scene), candidate);
            bounds = candidate;
        } drag.guides = {}; if (bounds && drag.lines && !e.altKey) {
            const hit = snapBoundsToLines(bounds, drag.lines, 5 / (Math.min(stage.clientWidth / scene.width, stage.clientHeight / scene.height) * zoom));
            drag.guides = hit.guides;
            if (hit.dx || hit.dy) {
                if (drag.kind === "move")
                    for (const id of drag.ids || []) {
                        const selected = currentObjects().find(o => o.id === id);
                        if (selected)
                            moveObject(selected, hit.dx, hit.dy);
                    }
                else if (object)
                    moveObject(object, hit.dx, hit.dy);
                bounds = { minX: bounds.minX + hit.dx, minY: bounds.minY + hit.dy, maxX: bounds.maxX + hit.dx, maxY: bounds.maxY + hit.dy };
            }
        } if (bounds) {
            sizeChip.hidden = false;
            sizeChip.style.left = `${Math.min(innerWidth - 130, e.clientX + 12)}px`;
            sizeChip.style.top = `${Math.min(innerHeight - 36, e.clientY + 12)}px`;
            sizeChip.textContent = drag.kind === "move" ? `${bounds.minX.toFixed(1)}, ${bounds.minY.toFixed(1)} ${scene.unit}` : `${(bounds.maxX - bounds.minX).toFixed(1)} × ${(bounds.maxY - bounds.minY).toFixed(1)} ${scene.unit}`;
        } render(); });
        svg.addEventListener("pointerup", () => { sizeChip.hidden = true; });
        overlay.querySelector("[data-action=zoom-reset]").addEventListener("click", e => { if (!e.shiftKey)
            return; e.stopImmediatePropagation(); const bounds = selectionBounds(); if (!bounds) {
            zoom = 1;
            panX = panY = 0;
            render();
            return;
        } const width = Math.max(bounds.maxX - bounds.minX, .01), height = Math.max(bounds.maxY - bounds.minY, .01), base = Math.min(stage.clientWidth / scene.width, stage.clientHeight / scene.height); zoom = Math.max(.25, Math.min(4, .7 * Math.min(stage.clientWidth / (width * base), stage.clientHeight / (height * base)))); const scale = base * zoom; panX = (scene.width / 2 - (bounds.minX + bounds.maxX) / 2) * scale; panY = ((bounds.minY + bounds.maxY) / 2 - scene.height / 2) * scale; render(); });
        stageObserver = new ResizeObserver(render);
        stageObserver.observe(stage);
        render();
    };
    window.addEventListener("tex64:pro-canvas-open", ((event) => open(event.detail || {})));
    return { open, cancel: () => closeCurrent === null || closeCurrent === void 0 ? void 0 : closeCurrent() };
};
