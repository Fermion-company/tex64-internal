import { insertAtEditorCursor } from "../pro-editor-insert.js";
import { buildIncludeGraphicsSnippet, chooseCaptureDirectory } from "../pro-capture-ui.js";
import { encodeFigureBlock } from "./figure-codec.js";
import { base64EncodeUtf8 } from "./figure-codec.js";
import { cloneScene, createEmptyScene, findSymbol, newObjectId, resolveStyle } from "./scene.js";
import { alignDeltas, boundsAfterHandleDrag, collectSnapLines, cornerInstanceTransforms, distributeDeltas, marqueeHits, mirrorInstanceTransform, resizeHandlePoint, resizePoint, samplePathPoints, sceneToScreen, screenToScene, snapBoundsToLines, snapToGrid, toggleSegmentKind, zoomAtPoint } from "./canvas-math.js";
import { buildStandaloneDoc } from "./standalone.js";
import { buildStyFile } from "./sty-export.js";
import { stripTikzWrapper } from "./code-import.js";
import { importSvg } from "./svg-import.js";
import { extractPreamble, scanTikzsetStyles } from "./project-context.js";
import { PLOT_PALETTE, astToPgf, autoRange, compileExpr, niceTicks, panRange, parseExpr, parsePoints, sampleParametric, samplePlot, snapRangeToNice, zoomRange } from "./plot-math.js";
import { exprToLatex, latexToExpr } from "./plot-latex.js";
const SVG_NS = "http://www.w3.org/2000/svg";
// TikZ の線幅は pt。SVG はシーン座標（unit）なので換算しないと近似が実描画とズレる。
const PT_IN_UNIT = { mm: 0.35146, cm: 0.035146, pt: 1 };
const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const LIVE_STORAGE_KEY = "tex64.proCanvas.live";
const DOC_STORAGE_KEY = "tex64.proCanvas.docPreamble";
let pdfjsLibPromise = null;
export const loadPdfjs = async () => {
    if (!pdfjsLibPromise)
        pdfjsLibPromise = (async () => {
            const lib = await import(new URL("../../pdfjs/pdf.min.mjs", import.meta.url).href);
            try {
                lib.GlobalWorkerOptions.workerSrc = new URL("../../pdfjs/pdf.worker.min.mjs", import.meta.url).href;
            }
            catch { }
            return lib;
        })();
    return pdfjsLibPromise;
};
const pdfOptions = (data) => ({ data, cMapUrl: new URL("../../pdfjs/cmaps/", import.meta.url).href, cMapPacked: true, standardFontDataUrl: new URL("../../pdfjs/standard_fonts/", import.meta.url).href, wasmUrl: new URL("../../pdfjs/wasm/", import.meta.url).href, useSystemFonts: true, disableFontFace: false });
const firstReportError = (report) => {
    var _a, _b, _c, _d;
    if (!report || typeof report !== "object")
        return null;
    const value = report, candidate = (_c = (_b = (_a = value.errors) !== null && _a !== void 0 ? _a : value.diagnostics) !== null && _b !== void 0 ? _b : value.error) !== null && _c !== void 0 ? _c : value.log;
    if (Array.isArray(candidate) && candidate.length) {
        const first = candidate[0];
        return String(typeof first === "object" && first ? (_d = first.message) !== null && _d !== void 0 ? _d : JSON.stringify(first) : first).split(/\r?\n/)[0];
    }
    return typeof candidate === "string" && candidate.trim() ? candidate.trim().split(/\r?\n/)[0] : null;
};
const pathOutlineD = (item) => { let d = `M ${item.start.x} ${item.start.y}`; item.segments.forEach(segment => { d += segment.type === "line" ? ` L ${segment.to.x} ${segment.to.y}` : ` C ${segment.c1.x} ${segment.c1.y} ${segment.c2.x} ${segment.c2.y} ${segment.to.x} ${segment.to.y}`; }); return item.closed ? d + " Z" : d; };
const isStraightLine = (item) => item.type === "path" && !item.closed && item.segments.length === 1 && item.segments[0].type === "line";
const plotKind = (series) => series.kind || "fn";
const previewSeries = (series, xmin, xmax) => { const kind = plotKind(series); if (kind === "points") {
    const src = (series.points || "").trim();
    if (!src)
        return { pieces: [], valid: true };
    const points = parsePoints(series.points || "");
    return { pieces: points.map(point => [point]), valid: points.length > 0 };
} const first = compileExpr(series.expr), second = kind === "parametric" ? compileExpr(series.expr2 || "") : null, domain = series.domain || (kind === "fn" ? { min: xmin, max: xmax } : { min: 0, max: 2 * Math.PI }); if (!first || (kind === "parametric" && !second))
    return { pieces: [], valid: false }; if (kind === "fn")
    return { pieces: samplePlot(first, domain.min, domain.max, series.samples), valid: true }; if (kind === "parametric")
    return { pieces: sampleParametric(first, second, domain.min, domain.max, series.samples), valid: true }; return { pieces: sampleParametric(t => first(t) * Math.cos(t), t => first(t) * Math.sin(t), domain.min, domain.max, series.samples), valid: true }; };
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
const objectBounds = (object, scene) => {
    var _a, _b;
    const points = allPoints(object, scene);
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
const timestampName = (now = new Date()) => {
    const pad = (n) => String(n).padStart(2, "0");
    return `figure-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
};
export const initProCanvasUi = (deps) => {
    let closeCurrent = null;
    const openButton = document.getElementById("pro-canvas-open");
    openButton === null || openButton === void 0 ? void 0 : openButton.addEventListener("click", () => window.dispatchEvent(new CustomEvent("tex64:pro-canvas-open")));
    const open = (detail = {}) => {
        closeCurrent === null || closeCurrent === void 0 ? void 0 : closeCurrent();
        let scene = cloneScene(detail.scene || createEmptyScene());
        const selection = { ids: new Set(), primaryId: null };
        let editingSymbolId = null, editingNodeId = null, anchorEdit = null, plotEdit = null, selectedAnchorIndex = 0, tool = "select", zoom = 1, panX = 0, panY = 0, space = false, hoveredId = null;
        let nodeEditor = null, nodeEditorOriginal = "", nodeEditorNew = false, nodeEditorBefore = null, plotCard = null, plotCardPos = null, plotCardSignature = "", plotCompileTimer = null, wheelUndoTimer = null, wheelBefore = null;
        let undo = [], redo = [];
        const plotPreviewCache = new Map(), plotTextModes = new Set(), plotDetailsOpen = new Set();
        const overlay = document.createElement("div");
        overlay.className = "pro-canvas-overlay";
        overlay.tabIndex = -1;
        overlay.innerHTML = `<div class="pro-canvas-toolbar pro-canvas-topbar" role="toolbar">
      <strong class="pro-canvas-title">図キャンバス</strong><span class="pro-canvas-zoom"><button data-action="zoom-out" title="縮小">−</button><button data-action="zoom-reset">100%</button><button data-action="zoom-in" title="拡大">+</button></span><span class="pro-canvas-topbar-spacer"></span>
      <span class="pro-canvas-segments"><button data-action="snap"></button><button data-action="live">Live</button><button data-action="doc-preamble">Doc</button></span><span class="pro-canvas-separator"></span>
      <button class="pro-canvas-icon-button" data-action="undo" title="元に戻す">↺</button><button class="pro-canvas-icon-button" data-action="redo" title="やり直す">↻</button></div>
      <div class="pro-canvas-main pro-canvas-body"><nav class="pro-canvas-rail pro-canvas-tools" aria-label="描画ツール"></nav><div class="pro-canvas-stage"><svg class="pro-canvas-svg" xmlns="http://www.w3.org/2000/svg"></svg><span class="pro-canvas-status pro-canvas-status-chip"></span></div><aside class="pro-canvas-inspector"><section class="pro-canvas-geometry-section"><h3>配置</h3><div class="pro-canvas-geometry"></div></section><section class="pro-canvas-style-section"><h3>スタイル</h3><div class="pro-canvas-style"></div></section><section><h3>スタイル集</h3><div class="pro-canvas-named"></div></section><section><h3>シンボル</h3><div class="pro-canvas-symbols"></div></section></aside></div><div class="pro-canvas-size-chip" hidden></div>
      <div class="pro-canvas-bottom pro-canvas-footer"><div class="pro-canvas-more"><button data-action="more" aria-expanded="false">⋯ その他</button><div class="pro-canvas-more-menu" hidden><button data-action="svg-import">SVG 取り込み</button><button data-action="ai-import">AI で TikZ 化</button><button data-action="sty">.sty へ書き出し</button></div></div><span class="pro-canvas-footer-spacer"></span><button class="pro-canvas-ghost" data-action="cancel">キャンセル</button>${detail.replaceRange ? "" : '<button class="pro-canvas-secondary" data-action="png">画像として挿入 (PNG)</button>'}<button class="pro-canvas-primary" data-action="tikz">${detail.replaceRange ? "TikZ を更新" : "TikZ を挿入"}</button></div>`;
        document.body.appendChild(overlay);
        overlay.focus();
        const svg = overlay.querySelector("svg");
        const stage = overlay.querySelector(".pro-canvas-stage");
        const status = overlay.querySelector(".pro-canvas-status");
        const sizeChip = overlay.querySelector(".pro-canvas-size-chip");
        const toolHost = overlay.querySelector(".pro-canvas-tools");
        const moreMenu = overlay.querySelector(".pro-canvas-more-menu"), moreButton = overlay.querySelector("[data-action=more]");
        const closeMore = () => { moreMenu.hidden = true; moreButton.setAttribute("aria-expanded", "false"); };
        const requestText = (label, initial = "") => new Promise(resolve => { const pop = document.createElement("div"); pop.className = "pro-canvas-code-popover pro-canvas-text-popover"; const title = document.createElement("label"); title.textContent = label; const input = document.createElement("input"); input.value = initial; const accept = document.createElement("button"); accept.textContent = "OK"; const cancel = document.createElement("button"); cancel.textContent = "キャンセル"; let done = false; const finish = (value) => { if (done)
            return; done = true; pop.remove(); resolve(value); }; accept.onclick = () => finish(input.value); cancel.onclick = () => finish(null); input.addEventListener("keydown", e => { if (e.key !== "Enter" && e.key !== "Escape")
            return; e.preventDefault(); e.stopPropagation(); finish(e.key === "Enter" ? input.value : null); }); pop.append(title, input, accept, cancel); overlay.append(pop); input.focus(); input.select(); });
        const toolIcons = { select: '<polyline points="3,2 3,13 6.5,9.5 9,14 11,13 8.5,8.5 13,8.5 3,2"/>', pen: '<line x1="3" y1="13" x2="11" y2="5"/><polyline points="9,3 13,7 11,9 7,5 9,3"/><line x1="3" y1="13" x2="7" y2="12"/>', line: '<line x1="3" y1="13" x2="13" y2="3"/>', rect: '<rect x="3" y="3" width="10" height="10"/>', ellipse: '<ellipse cx="8" cy="8" rx="5" ry="4"/>', node: '<line x1="3" y1="3" x2="13" y2="3"/><line x1="8" y1="3" x2="8" y2="13"/>', code: '<polyline points="6,4 2,8 6,12"/><polyline points="10,4 14,8 10,12"/>', plot: '<path d="M3 2v11h11"/><path d="M4 12c2.5-7 5 1 9-7"/>' };
        [['select', '選択', 'V'], ['pen', 'ペン', 'P'], ['line', '直線', 'L'], ['rect', '矩形', 'R'], ['ellipse', '楕円', 'E'], ['node', 'ノード', 'T'], ['code', 'コード', 'C'], ['plot', 'グラフ', 'G']].forEach(([id, label, key]) => { const b = document.createElement("button"); b.dataset.tool = id; b.title = `${label} (${key})`; b.setAttribute("aria-label", b.title); b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${toolIcons[id]}</svg>`; toolHost.appendChild(b); });
        const fermion = window.tex64Fermion;
        let live = localStorage.getItem(LIVE_STORAGE_KEY) !== "false" && Boolean(fermion === null || fermion === void 0 ? void 0 : fermion.canvasRender);
        let docPreamble = localStorage.getItem(DOC_STORAGE_KEY) === "true";
        let preamble = null, preambleReason = "プリアンブルを読み込み中です", projectStyles = [];
        let compiledImage = null, compileTimer = null, compileSequence = 0;
        const invalidateCompiled = () => { compileSequence += 1; compiledImage = null; };
        const renderPdf = async (pdfBase64) => { var _a; const binary = atob(pdfBase64), data = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i += 1)
            data[i] = binary.charCodeAt(i); const lib = await loadPdfjs(); const doc = await lib.getDocument(pdfOptions(data)).promise; try {
            const page = await doc.getPage(1), base = page.getViewport({ scale: 1 }), rect = svg.getBoundingClientRect(), artScale = Math.min(rect.width / scene.width, rect.height / scene.height) * zoom, viewport = page.getViewport({ scale: Math.max(.1, scene.width * artScale * 2 / base.width) }), canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.ceil(viewport.width));
            canvas.height = Math.max(1, Math.ceil(viewport.height));
            const context = canvas.getContext("2d");
            if (!context)
                throw new Error("Canvas is unavailable.");
            await page.render({ canvasContext: context, viewport }).promise;
            return canvas.toDataURL("image/png");
        }
        finally {
            await ((_a = doc.destroy) === null || _a === void 0 ? void 0 : _a.call(doc));
        } };
        const compileNow = async () => { if (!live || editingSymbolId || !(fermion === null || fermion === void 0 ? void 0 : fermion.canvasRender))
            return; const sequence = ++compileSequence; setStatus("コンパイル中…"); const run = async (usePreamble) => { const result = await fermion.canvasRender({ source: buildStandaloneDoc(scene, usePreamble && preamble ? { preamble } : undefined) }); const reportError = firstReportError(result === null || result === void 0 ? void 0 : result.report); if (!(result === null || result === void 0 ? void 0 : result.ok) || !result.pdfBase64 || reportError)
            throw new Error(reportError || (result === null || result === void 0 ? void 0 : result.error) || "コンパイルエラー"); return renderPdf(result.pdfBase64); }; try {
            let image;
            try {
                image = await run(docPreamble && Boolean(preamble));
            }
            catch (first) {
                if (!docPreamble || !preamble)
                    throw first;
                const firstLine = first instanceof Error ? first.message.split(/\r?\n/)[0] : "コンパイルエラー";
                image = await run(false);
                if (sequence !== compileSequence)
                    return;
                compiledImage = image;
                setStatus(`プリアンブル起因のエラーの可能性: ${firstLine}`);
                render();
                return;
            }
            if (sequence !== compileSequence)
                return;
            compiledImage = image;
            setStatus("");
            render();
        }
        catch (error) {
            if (sequence !== compileSequence)
                return;
            compiledImage = null;
            setStatus(error instanceof Error ? error.message.split(/\r?\n/)[0] : "コンパイルエラー", true);
            render();
        } };
        const scheduleCompile = () => { invalidateCompiled(); if (compileTimer)
            clearTimeout(compileTimer); if (live && !editingSymbolId)
            compileTimer = setTimeout(() => { compileTimer = null; void compileNow(); }, 600); };
        const snapshot = (compile = true) => { undo.push(cloneScene(scene)); if (undo.length > 80)
            undo.shift(); redo = []; if (compile)
            queueMicrotask(scheduleCompile); };
        const view = () => { const r = svg.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, sceneWidth: scene.width, sceneHeight: scene.height, zoom, panX, panY }; };
        const rawPoint = (event) => screenToScene({ x: event.clientX, y: event.clientY }, view());
        const snappedPoint = (event) => snapToGrid(rawPoint(event), scene.grid.size, scene.grid.snap && !event.altKey);
        const snappedDelta = (start, point, event) => snapToGrid({ x: point.x - start.x, y: point.y - start.y }, scene.grid.size, scene.grid.snap && !event.altKey);
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
            return; const point = sceneToScreen(object.at, view()), scale = Math.min(stage.clientWidth / scene.width, stage.clientHeight / scene.height) * zoom; nodeEditor.style.left = `${point.x}px`; nodeEditor.style.top = `${point.y}px`; nodeEditor.style.fontSize = `${Math.max(12, 4 * scale)}px`; };
        const finishNodeEdit = (commit) => { if (!editingNodeId || !nodeEditor)
            return; const id = editingNodeId, input = nodeEditor, object = nodeById(id), value = input.value; editingNodeId = null; nodeEditor = null; input.remove(); if ((object === null || object === void 0 ? void 0 : object.type) !== "node")
            return; if (!commit) {
            if (nodeEditorNew) {
                scene = nodeEditorBefore || scene;
                clearSelection();
                render();
            }
            return;
        } if (nodeEditorNew && !value.trim()) {
            scene = nodeEditorBefore || scene;
            clearSelection();
            render();
            return;
        } if (value !== nodeEditorOriginal) {
            if (nodeEditorNew && nodeEditorBefore) {
                undo.push(nodeEditorBefore);
                redo = [];
            }
            else
                snapshot(false);
            object.latex = value;
            render();
            scheduleCompile();
        }
        else
            render(); };
        const beginNodeEdit = (object, isNew = false, before = null) => { if (editingNodeId)
            finishNodeEdit(true); anchorEdit = null; editingNodeId = object.id; nodeEditorOriginal = object.latex; nodeEditorNew = isNew; nodeEditorBefore = before; replaceSelection(object.id); const input = document.createElement("input"); input.className = "pro-canvas-inline-editor"; input.dataset.role = "node-editor"; input.dataset.objectId = object.id; input.value = object.latex; let finished = false; const finish = (commit) => { if (finished)
            return; finished = true; finishNodeEdit(commit); }; input.addEventListener("keydown", e => { if (e.key !== "Enter" && e.key !== "Escape")
            return; e.preventDefault(); e.stopPropagation(); finish(e.key !== "Escape"); }); input.addEventListener("blur", () => finish(true)); overlay.append(input); nodeEditor = input; render(); requestAnimationFrame(() => { if (nodeEditor !== input)
            return; positionNodeEditor(); input.focus(); input.select(); }); };
        const stopPlotEdit = () => { if (!plotEdit)
            return; flushWheelUndo(); plotEdit = null; plotCard === null || plotCard === void 0 ? void 0 : plotCard.remove(); plotCard = null; plotCardPos = null; plotCardSignature = ""; scheduleCompile(); render(); };
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
        const positionPlotCard = () => { const object = plotObject(); if (!object || !plotCard)
            return; if (plotCardPos) {
            plotCard.style.left = `${plotCardPos.x}px`;
            plotCard.style.top = `${plotCardPos.y}px`;
            return;
        } const bl = sceneToScreen(object.at, view()), tr = sceneToScreen({ x: object.at.x + object.width, y: object.at.y + object.height }, view()), left = Math.min(bl.x, tr.x), right = Math.max(bl.x, tr.x), top = Math.min(bl.y, tr.y), bottom = Math.max(bl.y, tr.y), w = 320, gap = 10; let x = right + gap, y = top; if (x + w > innerWidth - 8)
            x = left - w - gap; if (x < 8) {
            x = Math.max(8, Math.min(innerWidth - w - 8, left));
            y = bottom + gap;
        } plotCard.style.left = `${x}px`; plotCard.style.top = `${Math.max(8, Math.min(innerHeight - plotCard.offsetHeight - 8, y))}px`; };
        const buildPlotCard = (object, focusIndex = -1) => {
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
            headTitle.textContent = "グラフを編集";
            const headClose = document.createElement("button");
            headClose.type = "button";
            headClose.textContent = "✕";
            headClose.title = "閉じる";
            headClose.setAttribute("aria-label", "閉じる");
            headClose.onclick = () => stopPlotEdit();
            header.append(headTitle, headClose);
            header.addEventListener("pointerdown", e => { if (e.target.closest("button"))
                return; e.preventDefault(); const rect = card.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, bx = rect.left, by = rect.top; const move = (ev) => { plotCardPos = { x: bx + ev.clientX - sx, y: by + ev.clientY - sy }; card.style.left = `${plotCardPos.x}px`; card.style.top = `${plotCardPos.y}px`; }; const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); });
            card.append(header);
            const field = (label, value, type, apply) => { const row = document.createElement("label"); row.textContent = label; const input = document.createElement("input"); input.type = type; input.value = value; input.title = label; if (type === "number")
                input.step = "any"; liveField(input, () => apply(input.value)); row.append(input); return { row, input }; };
            object.series.forEach((series, index) => {
                const kind = plotKind(series), wrap = document.createElement("div");
                wrap.className = `pro-canvas-plot-card-series${series.visible === false ? " is-muted" : ""}`;
                const main = document.createElement("div");
                main.className = "pro-canvas-plot-card-main";
                const chip = document.createElement("label");
                chip.className = "pro-canvas-color-chip";
                chip.title = `系列 ${index + 1} の色`;
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
                const addExpr = (labelText, key, placeholder) => { const label = document.createElement("label"), caption = document.createElement("span"), value = series[key] || "", varName = kind === "fn" ? "x" : "t", modeKey = `${object.id}:${index}:${key}`, latex = exprToLatex(value, varName), useMath = hasMathLive && latex !== null && !plotTextModes.has(modeKey), toggle = document.createElement("button"); caption.textContent = labelText; toggle.type = "button"; toggle.className = "pro-canvas-plot-input-toggle"; toggle.dataset.noI18n = ""; toggle.textContent = "⌨"; toggle.disabled = !hasMathLive || latex === null; toggle.title = !hasMathLive ? "数式入力を利用できません" : latex === null ? "この式は数式入力に変換できません" : useMath ? "テキストで編集" : "数式で編集"; toggle.setAttribute("aria-label", toggle.title); toggle.onclick = () => { if (toggle.disabled)
                    return; if (useMath)
                    plotTextModes.add(modeKey);
                else
                    plotTextModes.delete(modeKey); plotCardSignature = ""; render(); }; let editor; if (useMath) {
                    const mf = document.createElement("math-field");
                    mf.className = "pro-canvas-plot-expr";
                    mf.dataset.noI18n = "";
                    mf.title = `系列 ${index + 1} ${labelText}`;
                    mf.setAttribute("math-virtual-keyboard-policy", "manual");
                    mf.setAttribute("placeholder", placeholder);
                    try {
                        mf.menuItems = [];
                    }
                    catch { }
                    const injectMfStyle = () => { const sr = mf.shadowRoot; if (!sr || sr.querySelector("style[data-tex64-plot]"))
                        return; const st = document.createElement("style"); st.setAttribute("data-tex64-plot", ""); st.textContent = ".ML__content{overflow:visible!important;min-width:0!important;flex:1 1 auto!important}.ML__virtual-keyboard-toggle,button[part=virtual-keyboard-toggle],.ML__menu-toggle,button[part=menu-toggle]{display:none!important}"; sr.appendChild(st); };
                    injectMfStyle();
                    requestAnimationFrame(injectMfStyle);
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
                    catch { } const next = latexToExpr(raw, varName), bad = next === null; mf.classList.toggle("is-error", bad); error.hidden = !bad; if (next !== null)
                        series[key] = next; });
                    editor = mf;
                }
                else {
                    const input = document.createElement("input");
                    input.type = "text";
                    input.className = "pro-canvas-plot-expr";
                    input.placeholder = placeholder;
                    input.dataset.noI18n = "";
                    input.title = `系列 ${index + 1} ${labelText}`;
                    input.value = value;
                    liveField(input, () => { series[key] = input.value; const nextLatex = exprToLatex(input.value, varName); toggle.disabled = !hasMathLive || nextLatex === null; toggle.title = !hasMathLive ? "数式入力を利用できません" : nextLatex === null ? "この式は数式入力に変換できません" : "数式で編集"; toggle.setAttribute("aria-label", toggle.title); refreshError(); });
                    editor = input;
                } label.append(caption, editor, toggle); expressions.append(label); editors.push(editor); };
                if (kind === "points") {
                    const area = document.createElement("textarea");
                    area.className = "pro-canvas-plot-points";
                    area.rows = 3;
                    area.placeholder = "0,0\n1,1";
                    area.dataset.noI18n = "";
                    area.title = `系列 ${index + 1} の点列`;
                    area.value = series.points || "";
                    liveField(area, () => { series.points = area.value; refreshError(); });
                    expressions.append(area);
                    editors.push(area);
                }
                else if (kind === "parametric") {
                    addExpr("x(t)", "expr", "例: cos(deg(t))");
                    addExpr("y(t)", "expr2", "例: sin(deg(t))");
                }
                else if (kind === "polar")
                    addExpr("r(θ)", "expr", "例: 1+cos(deg(t))");
                else
                    addExpr("f(x)", "expr", "例: sin(deg(x))");
                const eye = document.createElement("button");
                eye.type = "button";
                eye.className = "pro-canvas-eye";
                eye.title = "表示/非表示";
                eye.setAttribute("aria-label", eye.title);
                eye.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M1.5 9s2.7-4 7.5-4 7.5 4 7.5 4-2.7 4-7.5 4-7.5-4-7.5-4Z"/><circle cx="9" cy="9" r="2"/></svg>';
                eye.onclick = () => { snapshot(false); series.visible = series.visible === false; wrap.classList.toggle("is-muted", series.visible === false); debouncePlotCompile(); render(); };
                const more = document.createElement("button");
                more.type = "button";
                more.textContent = "⋯";
                more.title = "系列の詳細";
                const remove = document.createElement("button");
                remove.type = "button";
                remove.textContent = "×";
                remove.title = "系列を削除";
                remove.disabled = object.series.length <= 1;
                remove.onclick = () => { snapshot(false); object.series.splice(index, 1); plotCardSignature = ""; debouncePlotCompile(); render(); };
                main.append(chip, expressions, eye, more, remove);
                const error = document.createElement("div");
                error.className = "pro-canvas-plot-error";
                error.textContent = kind === "points" ? "点列を解釈できません" : "式を解釈できません";
                error.hidden = valid();
                editors.forEach(editor => editor.classList.toggle("is-error", !error.hidden));
                const detailsKey = `${object.id}:${index}`, details = document.createElement("div");
                details.className = "pro-canvas-plot-details";
                details.hidden = !plotDetailsOpen.has(detailsKey);
                const kindLabel = document.createElement("label"), kindSelect = document.createElement("select");
                kindLabel.textContent = "種類";
                for (const [value, text] of [["fn", "関数 y=f(x)"], ["parametric", "媒介変数"], ["polar", "極座標 r(θ)"], ["points", "点列"]]) {
                    const option = document.createElement("option");
                    option.value = value;
                    option.textContent = text;
                    kindSelect.append(option);
                }
                kindSelect.value = kind;
                kindSelect.onchange = () => { snapshot(false); series.kind = kindSelect.value; const nextVar = series.kind === "fn" ? "x" : "t"; ["expr", "expr2"].forEach(key => { const src = series[key]; if (!src)
                    return; const ast = parseExpr(src); if (ast)
                    series[key] = astToPgf(ast, nextVar); }); if (series.kind === "parametric" && series.expr2 === undefined)
                    series.expr2 = "sin(deg(t))"; if (series.kind === "points" && series.points === undefined)
                    series.points = ""; plotDetailsOpen.add(detailsKey); plotCardSignature = ""; debouncePlotCompile(); render(); };
                kindLabel.append(kindSelect);
                const defaults = kind === "fn" ? { min: object.axis.xmin, max: object.axis.xmax } : { min: 0, max: 2 * Math.PI }, dmin = field("定義域 最小", series.domain === null ? "" : String(series.domain.min), "number", value => { var _a, _b; const n = Number(value); if (!value.trim())
                    series.domain = null;
                else if (Number.isFinite(n))
                    series.domain = { min: n, max: (_b = (_a = series.domain) === null || _a === void 0 ? void 0 : _a.max) !== null && _b !== void 0 ? _b : defaults.max }; }), dmax = field("定義域 最大", series.domain === null ? "" : String(series.domain.max), "number", value => { var _a, _b; const n = Number(value); if (!value.trim())
                    series.domain = null;
                else if (Number.isFinite(n))
                    series.domain = { min: (_b = (_a = series.domain) === null || _a === void 0 ? void 0 : _a.min) !== null && _b !== void 0 ? _b : defaults.min, max: n }; }), samples = field("分割数", String(series.samples), "number", value => series.samples = Math.max(2, Math.floor(Number(value) || 2))), legend = field("凡例", series.legend, "text", value => series.legend = value), thick = document.createElement("label"), thickInput = document.createElement("input");
                dmin.input.placeholder = String(Number(defaults.min.toPrecision(4)));
                dmax.input.placeholder = String(Number(defaults.max.toPrecision(4)));
                dmin.input.dataset.noI18n = "";
                dmax.input.dataset.noI18n = "";
                thick.textContent = "太線";
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
                    requestAnimationFrame(() => { const editor = editors[0]; editor === null || editor === void 0 ? void 0 : editor.focus(); editor instanceof HTMLInputElement && editor.select(); });
            });
            const add = document.createElement("button");
            add.type = "button";
            add.className = "pro-canvas-plot-add";
            add.textContent = "＋ 系列を追加";
            add.onclick = () => { snapshot(false); object.series.push({ kind: "fn", expr: "x", domain: null, samples: 100, color: PLOT_PALETTE[object.series.length % PLOT_PALETTE.length], thick: true, legend: "", visible: true }); plotCardSignature = ""; debouncePlotCompile(); render(); requestAnimationFrame(() => buildPlotCard(object, object.series.length - 1)); };
            card.append(add);
            const range = document.createElement("div");
            range.className = "pro-canvas-plot-range";
            const xmin = field("x:", String(Number(object.axis.xmin.toPrecision(4))), "number", v => { const n = Number(v); if (Number.isFinite(n) && n < object.axis.xmax)
                object.axis.xmin = n; }), xmax = field("〜", String(Number(object.axis.xmax.toPrecision(4))), "number", v => { const n = Number(v); if (Number.isFinite(n) && n > object.axis.xmin)
                object.axis.xmax = n; }), auto = document.createElement("label"), autoInput = document.createElement("input");
            auto.textContent = "y 自動";
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
                object.axis.ymin = n; }), ymax = field("〜", object.axis.ymax === null ? "" : String(Number(object.axis.ymax.toPrecision(4))), "number", v => { const n = Number(v); if (Number.isFinite(n))
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
            range.append(xmin.row, xmax.row, ymin.row, ymax.row, auto);
            card.append(range);
            const hint = document.createElement("p");
            hint.textContent = "プロット上: スクロールでズーム / ドラッグで移動";
            card.append(hint);
            const segments = (label, value, items, set) => { const row = document.createElement("div"); row.className = "pro-canvas-plot-segment-row"; row.append(document.createTextNode(label)); const group = document.createElement("span"); group.className = "pro-canvas-segments"; items.forEach(([key, text]) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.title = `${label}: ${text}`; b.classList.toggle("is-active", key === value); b.onclick = () => { snapshot(false); set(key); plotCardSignature = ""; debouncePlotCompile(); render(); }; group.append(b); }); row.append(group); card.append(row); };
            segments("軸線", object.axis.axisLines, [["box", "枠"], ["middle", "中央"], ["left", "左下"]], v => object.axis.axisLines = v);
            segments("グリッド", object.axis.grid, [["none", "なし"], ["major", "主"], ["both", "主+副"]], v => object.axis.grid = v);
            const eqRow = document.createElement("label");
            eqRow.className = "pro-canvas-plot-equal";
            const eqInput = document.createElement("input");
            eqInput.type = "checkbox";
            eqInput.checked = Boolean(object.axis.equal);
            eqInput.onchange = () => { snapshot(false); object.axis.equal = eqInput.checked || undefined; debouncePlotCompile(); render(); };
            eqRow.append(eqInput, document.createTextNode(" 等尺 (axis equal)"));
            card.append(eqRow);
            const disclosure = document.createElement("details"), summary = document.createElement("summary");
            summary.textContent = "詳細";
            disclosure.append(summary);
            for (const [label, key] of [["x ラベル", "xlabel"], ["y ラベル", "ylabel"], ["タイトル", "title"]]) {
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
        const symbolizeSelection = async (object, symmetric) => {
            const name = await requestText("Symbol name (letters and digits)");
            if (!name || !/^[A-Za-z][A-Za-z0-9]*$/.test(name) || (scene.symbols || []).some(s => s.name === name)) {
                setStatus("有効で重複しないシンボル名を指定してください", true);
                return;
            }
            snapshot();
            removeById(scene.objects, object.id);
            const symbol = { id: newObjectId(), name, objects: [object] };
            (scene.symbols || (scene.symbols = [])).push(symbol);
            const first = { id: newObjectId(), type: "instance", symbol: symbol.id, transform: { tx: 0, ty: 0, rotate: 0, sx: 1, sy: 1 }, style: {} };
            scene.objects.push(first);
            if (symmetric)
                scene.objects.push({ id: newObjectId(), type: "instance", symbol: symbol.id, transform: mirrorInstanceTransform(scene.width), style: {} });
            replaceSelection(first.id);
            render();
            scheduleCompile();
        };
        const editCode = (object) => { const pop = document.createElement("div"); pop.className = "pro-canvas-code-popover"; const area = document.createElement("textarea"); area.rows = 9; area.placeholder = "\\draw (0,0) -- (10,10);"; area.value = object.tikz; const save = document.createElement("button"); save.textContent = "適用"; save.onclick = () => { snapshot(); object.tikz = stripTikzWrapper(area.value); pop.remove(); render(); scheduleCompile(); }; const cancel = document.createElement("button"); cancel.textContent = "キャンセル"; cancel.onclick = () => pop.remove(); pop.append(area, save, cancel); overlay.append(pop); area.focus(); };
        const renderInspector = () => {
            var _a;
            var _b;
            const geometry = overlay.querySelector(".pro-canvas-geometry");
            const host = overlay.querySelector(".pro-canvas-style");
            const named = overlay.querySelector(".pro-canvas-named");
            const symbols = overlay.querySelector(".pro-canvas-symbols");
            const oneId = selectedIdOne(), object = oneId ? walk(currentObjects(), oneId) : null;
            const styleObjects = topLevelSelectedObjects().filter((item) => item.type !== "group" && item.type !== "code");
            geometry.replaceChildren();
            host.replaceChildren();
            named.replaceChildren();
            symbols.replaceChildren();
            (_a = overlay.querySelector(".pro-canvas-empty")) === null || _a === void 0 ? void 0 : _a.remove();
            overlay.querySelector(".pro-canvas-geometry-section").hidden = !selection.ids.size;
            overlay.querySelector(".pro-canvas-style-section").hidden = !object;
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
                const modes = [[['left', '左揃え'], ['centerX', '左右中央']], [['right', '右揃え'], ['top', '上揃え']], [['centerY', '上下中央'], ['bottom', '下揃え']], [['distributeX', '横等間隔'], ['distributeY', '縦等間隔']]], icons = { left: '<line x1="3" y1="2" x2="3" y2="14"/><line x1="3" y1="5" x2="12" y2="5"/><line x1="3" y1="11" x2="9" y2="11"/>', centerX: '<line x1="8" y1="2" x2="8" y2="14"/><line x1="3" y1="5" x2="13" y2="5"/><line x1="5" y1="11" x2="11" y2="11"/>', right: '<line x1="13" y1="2" x2="13" y2="14"/><line x1="4" y1="5" x2="13" y2="5"/><line x1="7" y1="11" x2="13" y2="11"/>', top: '<line x1="2" y1="3" x2="14" y2="3"/><line x1="5" y1="3" x2="5" y2="12"/><line x1="11" y1="3" x2="11" y2="9"/>', centerY: '<line x1="2" y1="8" x2="14" y2="8"/><line x1="5" y1="3" x2="5" y2="13"/><line x1="11" y1="5" x2="11" y2="11"/>', bottom: '<line x1="2" y1="13" x2="14" y2="13"/><line x1="5" y1="4" x2="5" y2="13"/><line x1="11" y1="7" x2="11" y2="13"/>', distributeX: '<rect x="2" y="3" width="2" height="10"/><rect x="7" y="3" width="2" height="10"/><rect x="12" y="3" width="2" height="10"/>', distributeY: '<rect x="3" y="2" width="10" height="2"/><rect x="3" y="7" width="10" height="2"/><rect x="3" y="12" width="10" height="2"/>' };
                modes.flat().forEach(([mode, title]) => { const button = document.createElement("button"); button.title = title; button.setAttribute("aria-label", title); button.dataset.align = mode; button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${icons[mode]}</svg>`; button.disabled = mode.startsWith("distribute") && selected.length < 3; button.onclick = () => { snapshot(); const bs = selected.map(o => objectBounds(o, scene)), deltas = mode === "distributeX" || mode === "distributeY" ? distributeDeltas(bs, mode === "distributeX" ? "x" : "y") : alignDeltas(bs, mode); selected.forEach((o, i) => moveObject(o, deltas[i].x, deltas[i].y)); render(); }; bar.append(button); });
                geometry.append(bar);
            }
            if (selected.length) {
                const order = document.createElement("div");
                order.className = "pro-canvas-command-grid";
                const icons = { front: '<rect x="3" y="5" width="8" height="8"/><rect x="6" y="2" width="7" height="7" style="fill:currentColor"/>', forward: '<rect x="3" y="5" width="8" height="8"/><rect x="6" y="2" width="7" height="7" style="fill:currentColor;fill-opacity:.55"/>', backward: '<rect x="6" y="2" width="7" height="7"/><rect x="3" y="5" width="8" height="8" style="fill:currentColor;fill-opacity:.55"/>', back: '<rect x="6" y="2" width="7" height="7"/><rect x="3" y="5" width="8" height="8" style="fill:currentColor"/>' };
                [['front', '最前面'], ['forward', '前面へ'], ['backward', '背面へ'], ['back', '最背面']].forEach(([mode, title]) => { const button = document.createElement("button"); button.title = title; button.setAttribute("aria-label", title); button.dataset.order = mode; button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${icons[mode]}</svg>`; button.onclick = () => changeOrder(mode); order.append(button); });
                geometry.append(order);
            }
            if (!object) {
                const empty = document.createElement("p");
                empty.className = "pro-canvas-empty";
                empty.textContent = selection.ids.size ? `${selection.ids.size} 個を選択中` : "オブジェクトを選択すると設定が表示されます";
                named.before(empty);
            }
            else if (object.type === "plot") {
                const hint = document.createElement("p");
                hint.className = "pro-canvas-empty";
                hint.textContent = "ダブルクリックでグラフを編集";
                host.append(hint);
            }
            else if (object.type === "group" || object.type === "code") {
                const note = document.createElement("div");
                note.textContent = object.type === "code" ? "Double-click to edit TikZ code" : "Group geometry";
                host.append(note);
            }
            else {
                const props = (_b = object.style).props || (_b.props = {});
                const effective = resolveStyle(scene, object.style);
                const color = (key, label) => { const row = document.createElement("label"); row.className = "pro-canvas-swatch"; const input = document.createElement("input"); input.type = "color"; input.value = effective[key] || "#000000"; const none = document.createElement("input"); none.type = "checkbox"; none.title = "なし"; none.checked = effective[key] === null; input.disabled = none.checked; input.onchange = () => { snapshot(); props[key] = input.value; render(); }; none.onchange = () => { snapshot(); props[key] = none.checked ? null : input.value; render(); }; const caption = document.createElement("span"); caption.textContent = label; row.append(input, none, caption); host.append(row); };
                color("draw", "線色");
                color("fill", "塗り色");
                const fields = [["線幅", "lineWidthPt", "number"], ["二重罫", "doubleDistancePt", "number"], ["破線", "dash", "select", ["solid", "dashed", "dotted"]], ["不透明度", "opacity", "number"], ["始点矢印", "arrowStart", "select", ["", "Stealth", "Latex", "Bar"]], ["終点矢印", "arrowEnd", "select", ["", "Stealth", "Latex", "Bar"]], ["角丸", "roundedCornersPt", "number"]];
                fields.forEach(([label, key, kind, options]) => { var _a; const row = document.createElement("label"); row.textContent = label; const input = kind === "select" ? document.createElement("select") : document.createElement("input"); if (input instanceof HTMLInputElement) {
                    input.type = "number";
                    input.step = key === "opacity" ? "0.1" : "0.1";
                } if (input instanceof HTMLSelectElement)
                    options.forEach(v => { const o = document.createElement("option"); o.value = v; o.textContent = v || "なし"; input.append(o); }); input.value = String((_a = effective[key]) !== null && _a !== void 0 ? _a : ""); input.onchange = () => { snapshot(); props[key] = kind === "number" ? Number(input.value) : input.value; render(); }; row.append(input); host.append(row); });
                if (object.type === "instance") {
                    [["左右反転", "sx"], ["上下反転", "sy"]].forEach(([label, key]) => { const button = document.createElement("button"); button.textContent = label; button.onclick = () => { snapshot(); object.transform[key] *= -1; render(); }; host.append(button); });
                }
                if (object.type === "repeat") {
                    const count = document.createElement("input");
                    count.type = "number";
                    count.min = "1";
                    count.value = String(object.count);
                    count.onchange = () => { snapshot(); object.count = Math.max(1, Math.floor(Number(count.value) || 1)); render(); };
                    const countRow = document.createElement("label");
                    countRow.textContent = "個数";
                    countRow.append(count);
                    host.append(countRow);
                    const align = document.createElement("input");
                    align.type = "checkbox";
                    align.checked = object.align;
                    align.onchange = () => { snapshot(); object.align = align.checked; render(); };
                    const alignRow = document.createElement("label");
                    alignRow.append(align, document.createTextNode(" パス方向に揃える"));
                    host.append(alignRow);
                }
            }
            scene.styles.forEach((style) => { const apply = document.createElement("button"); apply.className = "pro-canvas-chip"; apply.textContent = style.name; apply.classList.toggle("is-active", styleObjects.length > 0 && styleObjects.every(item => item.style.ref === style.name)); apply.disabled = !styleObjects.length; apply.onclick = () => { if (styleObjects.length) {
                snapshot();
                styleObjects.forEach(item => item.style = { ref: style.name });
                render();
            } }; named.append(apply); });
            const add = document.createElement("button");
            add.className = "pro-canvas-chip pro-canvas-chip-add";
            add.textContent = "＋";
            add.title = "新規スタイル";
            add.onclick = async () => { const name = await requestText("Style name (letters only)"); if (!name || !/^[A-Za-z]+$/.test(name) || scene.styles.some(s => s.name === name))
                return; snapshot(); scene.styles.push({ name, props: object && object.type !== "group" && object.type !== "code" ? { ...resolveStyle(scene, object.style) } : { draw: "#000000" } }); render(); };
            named.append(add);
            if (projectStyles.length) {
                const heading = document.createElement("div");
                heading.className = "pro-canvas-project-heading";
                heading.textContent = "Project";
                named.append(heading);
                projectStyles.forEach(name => { const apply = document.createElement("button"); apply.className = "pro-canvas-chip pro-canvas-project-chip"; apply.textContent = name; apply.title = "プロジェクト定義"; apply.classList.toggle("is-active", styleObjects.length > 0 && styleObjects.every(item => item.style.ref === name)); apply.disabled = !styleObjects.length; apply.onclick = () => { if (styleObjects.length) {
                    snapshot();
                    styleObjects.forEach(item => item.style = { ref: name });
                    render();
                } }; named.append(apply); });
            }
            if (editingSymbolId) {
                const done = document.createElement("button");
                done.textContent = "シンボル編集終了";
                done.onclick = () => { editingSymbolId = null; clearSelection(); render(); scheduleCompile(); };
                symbols.append(done);
                return;
            }
            const symbolize = document.createElement("button");
            symbolize.textContent = "選択をシンボル化";
            symbolize.disabled = !object || object.type === "instance" || object.type === "repeat";
            symbolize.onclick = () => { if (object)
                symbolizeSelection(object, false); };
            symbols.append(symbolize);
            const symmetric = document.createElement("button");
            symmetric.textContent = "選択を対称シンボル化";
            symmetric.disabled = symbolize.disabled;
            symmetric.onclick = () => { if (object)
                symbolizeSelection(object, true); };
            symbols.append(symmetric);
            for (const symbol of scene.symbols || []) {
                const row = document.createElement("div");
                row.className = "pro-canvas-symbol-row";
                row.append(document.createTextNode(symbol.name));
                const place = document.createElement("button");
                place.textContent = "配置";
                place.onclick = () => { snapshot(); const instance = { id: newObjectId(), type: "instance", symbol: symbol.id, transform: { tx: scene.width / 2, ty: scene.height / 2, rotate: 0, sx: 1, sy: 1 }, style: {} }; scene.objects.push(instance); replaceSelection(instance.id); render(); };
                const corners = document.createElement("button");
                corners.textContent = "四隅に配置";
                corners.onclick = async () => { const raw = await requestText("inset", "5"); if (raw === null)
                    return; const inset = Number(raw); if (!Number.isFinite(inset)) {
                    setStatus("inset は数値で指定してください", true);
                    return;
                } const identity = { id: "bounds", type: "instance", symbol: symbol.id, transform: { tx: 0, ty: 0, rotate: 0, sx: 1, sy: 1 }, style: {} }; const transforms = cornerInstanceTransforms(objectBounds(identity, scene), scene.width, scene.height, inset); snapshot(); const children = transforms.map(transform => ({ id: newObjectId(), type: "instance", symbol: symbol.id, transform, style: {} })); const group = { id: newObjectId(), type: "group", children, transform: { tx: 0, ty: 0, rotate: 0, sx: 1, sy: 1 } }; scene.objects.push(group); replaceSelection(group.id); render(); scheduleCompile(); };
                const edit = document.createElement("button");
                edit.textContent = "編集";
                edit.onclick = () => { editingSymbolId = symbol.id; clearSelection(); invalidateCompiled(); setStatus(""); render(); };
                const along = document.createElement("button");
                along.textContent = "選択パスに沿って配置";
                along.disabled = (object === null || object === void 0 ? void 0 : object.type) !== "path";
                along.onclick = async () => { if ((object === null || object === void 0 ? void 0 : object.type) !== "path")
                    return; const raw = await requestText("配置数", "5"); if (raw === null)
                    return; snapshot(); const repeat = { id: newObjectId(), type: "repeat", symbol: symbol.id, path: { start: { ...object.start }, segments: JSON.parse(JSON.stringify(object.segments)) }, count: Math.max(1, Math.floor(Number(raw) || 1)), align: true, style: {} }; scene.objects.push(repeat); replaceSelection(repeat.id); render(); };
                const remove = document.createElement("button");
                remove.textContent = "削除";
                remove.onclick = () => { var _a; const referenced = scene.objects.some(o => { let hit = false; const visit = (items) => items.forEach(item => { if ((item.type === "instance" || item.type === "repeat") && item.symbol === symbol.id)
                    hit = true;
                else if (item.type === "group")
                    visit(item.children); }); visit([o]); return hit; }); if (referenced) {
                    setStatus("配置またはリピートから参照されているため削除できません", true);
                    return;
                } snapshot(); scene.symbols = (_a = scene.symbols) === null || _a === void 0 ? void 0 : _a.filter(s => s.id !== symbol.id); render(); };
                row.append(place, corners, edit, along, remove);
                symbols.append(row);
            }
            const symbolLabels = { "配置": ["⊕", "配置"], "四隅に配置": ["⛶", "四隅"], "選択パスに沿って配置": ["∿", "パスに沿って"], "編集": ["✎", "編集"], "削除": ["×", "削除"] };
            symbols.querySelectorAll(".pro-canvas-symbol-row button").forEach(button => { const replacement = symbolLabels[button.textContent || ""]; if (replacement) {
                button.textContent = replacement[0];
                button.title = replacement[1];
                button.setAttribute("aria-label", replacement[1]);
            } });
        };
        const render = () => {
            var _a, _b;
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
            for (let x = 0; x <= scene.width; x += scene.grid.size)
                guides.append(svgEl("line", { x1: x, y1: 0, x2: x, y2: scene.height }));
            for (let y = 0; y <= scene.height; y += scene.grid.size)
                guides.append(svgEl("line", { x1: 0, y1: y, x2: scene.width, y2: y }));
            guides.append(svgEl("rect", { x: 0, y: 0, width: scene.width, height: scene.height, class: "pro-canvas-boundary" }));
            if (compiledImage)
                root.append(svgEl("image", { href: compiledImage, x: 0, y: -scene.height, width: scene.width, height: scene.height, transform: "scale(1,-1)", class: "pro-canvas-live-image", "pointer-events": "none" }));
            const objects = svgEl("g", { class: "pro-canvas-objects", opacity: compiledImage ? 0 : 1, "pointer-events": "all" });
            root.append(objects);
            const draw = (object, parent, interactive = true) => {
                var _a, _b, _c, _d, _e, _f;
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
                    else {
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
                    xt.forEach(value => { g.append(svgEl("line", { x1: mapX(value), y1: axisY - tl, x2: mapX(value), y2: axisY + tl, stroke: neutral, "stroke-width": .75, "vector-effect": "non-scaling-stroke" })); if (a.axisLines !== "middle" || value !== 0)
                        text(String(Number(value.toPrecision(4))), mapX(value), (a.axisLines === "middle" ? axisY : object.at.y) - lo); });
                    yt.forEach(value => { g.append(svgEl("line", { x1: axisX - tl, y1: mapY(value), x2: axisX + tl, y2: mapY(value), stroke: neutral, "stroke-width": .75, "vector-effect": "non-scaling-stroke" })); if (a.axisLines !== "middle" || value !== 0)
                        text(String(Number(value.toPrecision(4))), (a.axisLines === "middle" ? axisX : object.at.x) - 4 / scale, mapY(value) - 3 / scale, "end"); });
                    if (a.axisLines === "middle" && eq.xmin <= 0 && eq.xmax >= 0 && ymin <= 0 && ymax >= 0)
                        text("0", axisX - 3 / scale, axisY - lo, "end");
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
                        error.textContent = "式エラー";
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
                const style = resolveStyle(scene, object.style);
                const ptu = (_d = PT_IN_UNIT[scene.unit]) !== null && _d !== void 0 ? _d : 1;
                const lw = (style.lineWidthPt || .4) * ptu;
                const attrs = { ...(interactive ? { "data-id": object.id } : {}), fill: style.fill || "none", stroke: style.draw || "none", "stroke-width": lw, opacity: (_e = style.opacity) !== null && _e !== void 0 ? _e : 1, "stroke-dasharray": style.dash === "dashed" ? `${lw * 4} ${lw * 3}` : style.dash === "dotted" ? `${lw} ${lw * 2.5}` : "" };
                let el;
                if (object.type === "rect")
                    el = svgEl("rect", { ...attrs, x: Math.min(object.from.x, object.to.x), y: Math.min(object.from.y, object.to.y), width: Math.abs(object.to.x - object.from.x), height: Math.abs(object.to.y - object.from.y), rx: style.roundedCornersPt || 0 });
                else if (object.type === "ellipse")
                    el = svgEl("ellipse", { ...attrs, cx: object.center.x, cy: object.center.y, rx: object.rx, ry: object.ry });
                else if (object.type === "path") {
                    let d = `M ${object.start.x} ${object.start.y}`;
                    object.segments.forEach(s => { d += s.type === "line" ? ` L ${s.to.x} ${s.to.y}` : ` C ${s.c1.x} ${s.c1.y} ${s.c2.x} ${s.c2.y} ${s.to.x} ${s.to.y}`; });
                    if (object.closed)
                        d += " Z";
                    el = svgEl("path", { ...attrs, d });
                }
                else {
                    el = svgEl("text", { ...(interactive ? { "data-id": object.id } : {}), opacity: (_f = style.opacity) !== null && _f !== void 0 ? _f : 1, x: object.at.x, y: -object.at.y, transform: `scale(1,-1)`, class: "pro-canvas-node" });
                    el.textContent = object.latex;
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
            if (drag === null || drag === void 0 ? void 0 : drag.guides) {
                const smart = svgEl("g", { class: "pro-canvas-smart-guides pro-canvas-selection" });
                if (drag.guides.x !== undefined)
                    smart.append(svgEl("line", { x1: drag.guides.x, y1: 0, x2: drag.guides.x, y2: scene.height }));
                if (drag.guides.y !== undefined)
                    smart.append(svgEl("line", { x1: 0, y1: drag.guides.y, x2: scene.width, y2: drag.guides.y }));
                root.append(smart);
            }
            if (pen) {
                const penLayer = svgEl("g", { class: "pro-canvas-pen-feedback pro-canvas-selection" }), points = [pen.start, ...pen.segments.map(s => s.to)], close = penCursor && Math.hypot(penCursor.x - pen.start.x, penCursor.y - pen.start.y) < scene.grid.size * .4;
                points.forEach((point, index) => penLayer.append(svgEl("circle", { cx: point.x, cy: point.y, r: (index === 0 && close ? 4.5 : 3) / scale, class: `pro-canvas-pen-anchor${index === 0 && close ? " is-close" : ""}` })));
                if (penCursor) {
                    const last = points[points.length - 1];
                    penLayer.append(svgEl("line", { x1: last.x, y1: last.y, x2: penCursor.x, y2: penCursor.y, class: "pro-canvas-pen-ghost" }));
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
                selected.forEach(item => { if (item.type === "path")
                    select.append(svgEl("path", { d: pathOutlineD(item), class: "pro-canvas-selection-outline", fill: "none" }));
                else {
                    const b = objectBounds(item, scene);
                    select.append(svgEl("rect", { x: b.minX, y: b.minY, width: Math.max(b.maxX - b.minX, .01), height: Math.max(b.maxY - b.minY, .01), class: "pro-canvas-selection-outline" }));
                } });
                const b = selectionBounds();
                if (!anchorEdit) {
                    if (selected.length > 1)
                        select.append(svgEl("rect", { x: b.minX, y: b.minY, width: Math.max(b.maxX - b.minX, .01), height: Math.max(b.maxY - b.minY, .01), class: "pro-canvas-selection-bounds" }));
                    else if (isStraightLine(selected[0])) {
                        [selected[0].start, selected[0].segments[0].to].forEach((point, index) => { const size = 5 / scale, handle = svgEl("rect", { x: point.x - size / 2, y: point.y - size / 2, width: size, height: size, class: "pro-canvas-anchor" }); handle.dataset.anchorIndex = String(index); handle.dataset.pathId = selected[0].id; select.append(handle); });
                    }
                    else if (selected[0].type !== "node") {
                        handles.forEach(h => { const p = resizeHandlePoint(b, h), size = 7 / scale; const handle = svgEl("rect", { x: p.x - size / 2, y: p.y - size / 2, width: size, height: size, class: `pro-canvas-handle pro-canvas-handle-${h}` }); handle.dataset.handle = h; select.append(handle); });
                        if (selected[0].type !== "plot") {
                            const x = (b.minX + b.maxX) / 2, stemTop = b.maxY + 18 / scale;
                            select.append(svgEl("line", { x1: x, y1: b.maxY, x2: x, y2: stemTop, class: "pro-canvas-rotate-stem" }));
                            const rotate = svgEl("circle", { cx: x, cy: stemTop, r: 4 / scale, class: "pro-canvas-rotate" });
                            rotate.dataset.rotate = "true";
                            select.append(rotate);
                        }
                    }
                }
                root.append(select);
            }
            if (anchorEdit) {
                const object = walk(currentObjects(), anchorEdit.pathId);
                if ((object === null || object === void 0 ? void 0 : object.type) === "path") {
                    const layer = svgEl("g", { class: "pro-canvas-anchor-layer pro-canvas-selection" }), points = [object.start, ...object.segments.map(segment => segment.to)], anchor = (_a = points[selectedAnchorIndex]) !== null && _a !== void 0 ? _a : object.start;
                    const addControl = (segmentIndex, key) => { const segment = object.segments[segmentIndex]; if ((segment === null || segment === void 0 ? void 0 : segment.type) !== "cubic")
                        return; const point = segment[key]; layer.append(svgEl("line", { x1: anchor.x, y1: anchor.y, x2: point.x, y2: point.y, class: "pro-canvas-anchor-tether" })); const control = svgEl("circle", { cx: point.x, cy: point.y, r: 3 / scale, class: "pro-canvas-anchor-control" }); control.dataset.controlSegment = String(segmentIndex); control.dataset.controlKey = key; layer.append(control); };
                    if (selectedAnchorIndex > 0)
                        addControl(selectedAnchorIndex - 1, "c2");
                    if (selectedAnchorIndex < object.segments.length)
                        addControl(selectedAnchorIndex, "c1");
                    points.forEach((point, index) => { const size = 5 / scale, handle = svgEl("rect", { x: point.x - size / 2, y: point.y - size / 2, width: size, height: size, class: `pro-canvas-anchor${index === selectedAnchorIndex ? " is-selected" : ""}` }); handle.dataset.anchorIndex = String(index); layer.append(handle); });
                    root.append(layer);
                }
            }
            if ((drag === null || drag === void 0 ? void 0 : drag.kind) === "marquee" && drag.current) {
                const b = { minX: Math.min(drag.start.x, drag.current.x), minY: Math.min(drag.start.y, drag.current.y), maxX: Math.max(drag.start.x, drag.current.x), maxY: Math.max(drag.start.y, drag.current.y) };
                root.append(svgEl("rect", { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, class: "pro-canvas-marquee" }));
            }
            overlay.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("is-active", b.dataset.tool === tool));
            const snap = overlay.querySelector("[data-action=snap]");
            snap.textContent = `Snap ${scene.grid.snap ? "on" : "off"}`;
            snap.classList.toggle("is-active", scene.grid.snap);
            const liveButton = overlay.querySelector("[data-action=live]");
            liveButton.disabled = !(fermion === null || fermion === void 0 ? void 0 : fermion.canvasRender);
            liveButton.classList.toggle("is-active", live);
            liveButton.setAttribute("aria-pressed", String(live));
            const docButton = overlay.querySelector("[data-action=doc-preamble]");
            docButton.disabled = !preamble;
            docButton.title = preamble ? "" : preambleReason;
            docButton.classList.toggle("is-active", docPreamble);
            docButton.setAttribute("aria-pressed", String(docPreamble));
            overlay.querySelector("[data-action=zoom-reset]").textContent = `${Math.round(zoom * 100)}%`;
            overlay.querySelector("[data-action=zoom-reset]").title = "クリック: 100% / Shift+クリック: 選択にフィット";
            overlay.querySelector("[data-action=undo]").disabled = !undo.length;
            overlay.querySelector("[data-action=redo]").disabled = !redo.length;
            overlay.querySelector("[data-action=ai-import]").disabled = !((_b = window.tex64Texize) === null || _b === void 0 ? void 0 : _b.snippet);
            renderInspector();
            positionNodeEditor();
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
        };
        let drag = null;
        let lastClick = null;
        let penDrag = null;
        svg.addEventListener("pointerup", () => { if ((drag === null || drag === void 0 ? void 0 : drag.kind) !== "draw" || !drag.id || !drag.moved)
            return; const object = currentObjects().find(item => item.id === drag.id); if ((object === null || object === void 0 ? void 0 : object.type) === "plot") {
            object.width = Math.max(5, object.width);
            object.height = Math.max(5, object.height);
        } });
        let pen = null, penCursor = null;
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
            const raw = rawPoint(e), p = snappedPoint(e), handle = target.dataset.handle, id = (_a = target.closest("[data-id]")) === null || _a === void 0 ? void 0 : _a.dataset.id;
            if (plotEdit && id === plotEdit.id && !handle) {
                drag = { kind: "plot-pan", start: raw, startClient: client, before: cloneScene(scene), id };
                svg.setPointerCapture(e.pointerId);
                render();
                return;
            }
            if (plotEdit && id !== plotEdit.id && !handle && !target.dataset.rotate)
                stopPlotEdit();
            if (tool === "select" && target.dataset.pathId && target.dataset.anchorIndex !== undefined) {
                const path = walk(currentObjects(), target.dataset.pathId), anchorIndex = Number(target.dataset.anchorIndex);
                if ((path === null || path === void 0 ? void 0 : path.type) !== "path")
                    return;
                selectedAnchorIndex = anchorIndex;
                drag = { kind: "anchor", start: raw, startClient: client, before: cloneScene(scene), id: path.id, anchorIndex };
                hoveredId = null;
                svg.setPointerCapture(e.pointerId);
                render();
                return;
            }
            if (tool === "select") {
                const anchorIndex = target.dataset.anchorIndex === undefined ? undefined : Number(target.dataset.anchorIndex), controlSegment = target.dataset.controlSegment === undefined ? undefined : Number(target.dataset.controlSegment), controlKey = target.dataset.controlKey;
                if (anchorEdit && (anchorIndex !== undefined || controlSegment !== undefined)) {
                    const path = walk(currentObjects(), anchorEdit.pathId);
                    if ((path === null || path === void 0 ? void 0 : path.type) !== "path")
                        return;
                    if (anchorIndex !== undefined) {
                        selectedAnchorIndex = anchorIndex;
                        if (e.altKey && anchorIndex > 0) {
                            snapshot(false);
                            toggleSegmentKind(path, anchorIndex);
                            render();
                            scheduleCompile();
                            e.preventDefault();
                            return;
                        }
                    }
                    drag = { kind: "anchor", start: raw, startClient: client, before: cloneScene(scene), id: path.id, anchorIndex, controlSegment, controlKey };
                    hoveredId = null;
                    svg.setPointerCapture(e.pointerId);
                    render();
                    return;
                }
                if (anchorEdit && id !== anchorEdit.pathId)
                    anchorEdit = null;
                else if (anchorEdit && !id)
                    anchorEdit = null;
                const oneId = selectedIdOne();
                if (handle && oneId) {
                    const o = currentObjects().find(item => item.id === oneId);
                    drag = { kind: "resize", start: raw, startClient: client, before: cloneScene(scene), id: oneId, handle, bounds: objectBounds(o, scene) };
                }
                else if (target.dataset.rotate && oneId) {
                    const o = currentObjects().find(item => item.id === oneId);
                    drag = { kind: "rotate", start: raw, startClient: client, before: cloneScene(scene), id: oneId, bounds: objectBounds(o, scene), wrapperId: newObjectId() };
                }
                else if (id) {
                    if (e.shiftKey) {
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
                    clearSelection();
                    drag = { kind: "marquee", start: raw, startClient: client, before: cloneScene(scene), current: raw };
                }
                cacheDragLines();
                hoveredId = null;
                render();
                svg.setPointerCapture(e.pointerId);
                return;
            }
            if (tool === "node") {
                const before = cloneScene(scene), object = { id: newObjectId(), type: "node", at: p, latex: "", anchor: "center", style: {} };
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
            if (tool === "pen") {
                invalidateCompiled();
                if (!pen) {
                    snapshot();
                    pen = { id: newObjectId(), type: "path", start: p, segments: [], closed: false, style: { props: { lineWidthPt: 1 } } };
                    currentObjects().push(pen);
                }
                else if (Math.hypot(p.x - pen.start.x, p.y - pen.start.y) < scene.grid.size * .4) {
                    pen.closed = true;
                    pen = null;
                    scheduleCompile();
                }
                else {
                    const previous = pen.segments.length ? pen.segments[pen.segments.length - 1].to : pen.start;
                    pen.segments.push({ type: "line", to: p });
                    penDrag = { path: pen, index: pen.segments.length - 1, end: { ...p }, previous: { ...previous } };
                    svg.setPointerCapture(e.pointerId);
                    scheduleCompile();
                }
                render();
                return;
            }
            if (tool === "plot") {
                snapshot(false);
                invalidateCompiled();
                const object = { id: newObjectId(), type: "plot", at: { ...p }, width: .01, height: .01, axis: { xmin: -5, xmax: 5, ymin: null, ymax: null, axisLines: "middle", grid: "major", xlabel: "", ylabel: "", title: "" }, series: [{ kind: "fn", expr: "x^2", domain: null, samples: 100, color: PLOT_PALETTE[0], thick: true, legend: "", visible: true }], style: {} };
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
                const p = snappedPoint(e);
                if (Math.hypot(p.x - penDrag.end.x, p.y - penDrag.end.y) > .1)
                    penDrag.path.segments[penDrag.index] = { type: "cubic", c1: { ...penDrag.previous }, c2: { x: 2 * penDrag.end.x - p.x, y: 2 * penDrag.end.y - p.y }, to: { ...penDrag.end } };
                render();
                return;
            }
            if (!drag) {
                const target = e.target, nextHoveredId = (_b = (_a = target.closest("[data-id]")) === null || _a === void 0 ? void 0 : _a.dataset.id) !== null && _b !== void 0 ? _b : null, handle = target.dataset.handle;
                svg.style.cursor = target.dataset.rotate ? "grab" : handle ? `${handle}-resize` : nextHoveredId ? "move" : "default";
                if (nextHoveredId !== hoveredId) {
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
                if (["move", "resize", "rotate", "anchor", "plot-pan"].includes(drag.kind))
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
                    if ((segment === null || segment === void 0 ? void 0 : segment.type) === "cubic")
                        Object.assign(segment[drag.controlKey], raw);
                }
                else if (drag.anchorIndex !== undefined) {
                    const points = [path.start, ...path.segments.map(segment => segment.to)], point = points[drag.anchorIndex], target = snapToGrid(raw, scene.grid.size, scene.grid.snap), dx = target.x - point.x, dy = target.y - point.y;
                    point.x = target.x;
                    point.y = target.y;
                    const incoming = path.segments[drag.anchorIndex - 1], outgoing = path.segments[drag.anchorIndex];
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
            const completed = drag, changed = Boolean((completed === null || completed === void 0 ? void 0 : completed.moved) && ["move", "resize", "rotate", "anchor"].includes(completed.kind)), drewObject = Boolean((completed === null || completed === void 0 ? void 0 : completed.kind) === "draw" && completed.moved && completed.id);
            if (changed) {
                undo.push(completed.before);
                redo = [];
            }
            else if (completed && !completed.moved && ["move", "resize", "rotate", "anchor"].includes(completed.kind)) {
                scene = completed.before;
            }
            else if ((completed === null || completed === void 0 ? void 0 : completed.kind) === "draw" && !completed.moved && completed.id) {
                removeById(currentObjects(), completed.id);
                clearSelection();
                undo.pop();
            }
            drag = null;
            penDrag = null;
            if (svg.hasPointerCapture(e.pointerId))
                svg.releasePointerCapture(e.pointerId);
            render();
            if (changed || drewObject)
                scheduleCompile();
            // render() が DOM を差し替えるため native dblclick は当てにならない。クリック2連打を自前検出する。
            if (tool === "select" && completed && !completed.moved) {
                const now = performance.now();
                if (lastClick && now - lastClick.t < 400 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 6) {
                    lastClick = null;
                    const id = (_a = e.target.closest("[data-id]")) === null || _a === void 0 ? void 0 : _a.dataset.id;
                    const object = (_b = (id ? walk(currentObjects(), id) : null)) !== null && _b !== void 0 ? _b : (selection.ids.size === 1 ? walk(currentObjects(), selection.primaryId) : null);
                    activateForEdit(object);
                }
                else
                    lastClick = { t: now, x: e.clientX, y: e.clientY };
            }
            else
                lastClick = null;
        });
        svg.addEventListener("pointerleave", () => { if (!drag && hoveredId) {
            hoveredId = null;
            svg.style.cursor = "default";
            render();
        } });
        const close = () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("keydown", onToolKey, true); window.removeEventListener("keyup", onKeyUp, true); if (compileTimer)
            clearTimeout(compileTimer); if (plotCompileTimer)
            clearTimeout(plotCompileTimer); if (wheelUndoTimer)
            clearTimeout(wheelUndoTimer); compileSequence += 1; overlay.remove(); if (closeCurrent === close)
            closeCurrent = null; };
        closeCurrent = close;
        const undoOnce = () => { flushWheelUndo(); const prev = undo.pop(); if (!prev)
            return; redo.push(cloneScene(scene)); scene = prev; clearSelection(); if (plotEdit && walk(currentObjects(), plotEdit.id))
            replaceSelection(plotEdit.id); plotCardSignature = ""; render(); scheduleCompile(); };
        const redoOnce = () => { flushWheelUndo(); const next = redo.pop(); if (!next)
            return; undo.push(cloneScene(scene)); scene = next; clearSelection(); if (plotEdit && walk(currentObjects(), plotEdit.id))
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
                if (plotEdit) {
                    stopPlotEdit();
                    return;
                }
                if (anchorEdit) {
                    anchorEdit = null;
                    render();
                    return;
                }
                if (pen) {
                    pen = null;
                    render();
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
            if (e.key === "Enter" && pen) {
                pen = null;
                render();
                return;
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
            return; const next = { v: "select", p: "pen", l: "line", r: "rect", e: "ellipse", t: "node", c: "code", g: "plot" }[e.key.toLowerCase()]; if (next) {
            tool = next;
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
        const replaceOrInsert = () => {
            var _a, _b, _c, _d, _e, _f, _g;
            const editor = deps.getActiveGroup().editor;
            const block = encodeFigureBlock(scene);
            if (!detail.replaceRange) {
                // %% ヘッダ行が行頭に来ないとブロックが壊れるため、行中カーソルでは改行してから挿入する。
                const column = (_c = (_b = (_a = editor === null || editor === void 0 ? void 0 : editor.getPosition) === null || _a === void 0 ? void 0 : _a.call(editor)) === null || _b === void 0 ? void 0 : _b.column) !== null && _c !== void 0 ? _c : 1;
                insertAtEditorCursor(editor, column > 1 ? `\n${block}` : block, "pro-canvas");
                close();
                return;
            }
            const Range = (_d = window.monaco) === null || _d === void 0 ? void 0 : _d.Range;
            if (!(editor === null || editor === void 0 ? void 0 : editor.executeEdits) || !Range)
                throw new Error("No active text editor is available.");
            (_e = editor.pushUndoStop) === null || _e === void 0 ? void 0 : _e.call(editor);
            editor.executeEdits("pro-canvas", [{ range: new Range(detail.replaceRange.startLine, 1, detail.replaceRange.endLine + 1, 1), text: block, forceMoveMarkers: true }]);
            (_f = editor.pushUndoStop) === null || _f === void 0 ? void 0 : _f.call(editor);
            (_g = editor.focus) === null || _g === void 0 ? void 0 : _g.call(editor);
            close();
        };
        const exportSty = async () => { var _a; let name = (await requestText("ファイル名", "figures.sty") || "").trim(); if (!name)
            return; if (!name.toLowerCase().endsWith(".sty"))
            name += ".sty"; name = name.replace(/^.*[\\/]/, ""); const packageName = name.slice(0, -4); if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(packageName))
            throw new Error("有効なファイル名を指定してください"); const api = (_a = window.tex64Files) === null || _a === void 0 ? void 0 : _a.writeBase64; if (!api)
            throw new Error("File writing is not available."); const result = await api({ path: name, data: base64EncodeUtf8(buildStyFile(scene, packageName)) }); if (!result.ok)
            throw new Error(result.error || "The style file could not be saved."); setStatus(`\\usepackage{${packageName}} で使えます`); };
        const exportPng = async () => { var _a; const clone = svg.cloneNode(true); clone.querySelectorAll(".pro-canvas-guides,.pro-canvas-selection,.pro-canvas-hover,.pro-canvas-marquee").forEach(n => n.remove()); clone.setAttribute("viewBox", `0 ${-scene.height} ${scene.width} ${scene.height}`); const unit = scene.unit === "mm" ? 3.78 : scene.unit === "cm" ? 37.8 : 1.333; const width = Math.max(1, Math.round(scene.width * unit * 2)), height = Math.max(1, Math.round(scene.height * unit * 2)); clone.setAttribute("width", String(width)); clone.setAttribute("height", String(height)); const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }); const url = URL.createObjectURL(blob); try {
            const image = new Image();
            await new Promise((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("SVG export failed.")); image.src = url; });
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx)
                throw new Error("Canvas is unavailable.");
            ctx.drawImage(image, 0, 0, width, height);
            const data = canvas.toDataURL("image/png").split(",")[1];
            const api = (_a = window.tex64Files) === null || _a === void 0 ? void 0 : _a.writeBase64;
            if (!api)
                throw new Error("File writing is not available.");
            const dir = chooseCaptureDirectory(deps.getWorkspaceFiles()), path = `${dir}/${timestampName()}`;
            const result = await api({ path, data });
            if (!result.ok)
                throw new Error(result.error || "The image could not be saved.");
            insertAtEditorCursor(deps.getActiveGroup().editor, buildIncludeGraphicsSnippet(path, false), "pro-canvas-png");
            close();
        }
        finally {
            URL.revokeObjectURL(url);
        } };
        overlay.addEventListener("click", async (e) => { const button = e.target.closest("button"); if (!e.target.closest(".pro-canvas-more"))
            closeMore(); if (!button)
            return; if (button.dataset.tool) {
            tool = button.dataset.tool;
            render();
            return;
        } try {
            switch (button.dataset.action) {
                case "more":
                    moreMenu.hidden = !moreMenu.hidden;
                    moreButton.setAttribute("aria-expanded", String(!moreMenu.hidden));
                    break;
                case "cancel":
                    close();
                    break;
                case "live":
                    live = !live;
                    localStorage.setItem(LIVE_STORAGE_KEY, String(live));
                    if (live)
                        scheduleCompile();
                    else {
                        invalidateCompiled();
                        setStatus("");
                        render();
                    }
                    break;
                case "doc-preamble":
                    if (preamble) {
                        docPreamble = !docPreamble;
                        localStorage.setItem(DOC_STORAGE_KEY, String(docPreamble));
                        render();
                        scheduleCompile();
                    }
                    break;
                case "snap":
                    snapshot();
                    scene.grid.snap = !scene.grid.snap;
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
                case "sty":
                    await exportSty();
                    closeMore();
                    break;
                case "tikz":
                    replaceOrInsert();
                    break;
                case "png":
                    setStatus("書き出し中…");
                    await exportPng();
                    break;
            }
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : String(error), true);
        } });
        const pickFile = (accept) => new Promise(resolve => { const input = document.createElement("input"); input.type = "file"; input.accept = accept; input.onchange = () => { var _a; return resolve(((_a = input.files) === null || _a === void 0 ? void 0 : _a[0]) || null); }; input.click(); });
        const readDataUrl = (file) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error || new Error("File reading failed.")); reader.readAsDataURL(file); });
        const approximatePng = async () => { var _a; const clone = svg.cloneNode(true); clone.querySelectorAll(".pro-canvas-guides,.pro-canvas-selection,.pro-canvas-hover,.pro-canvas-marquee,.pro-canvas-live-image").forEach(n => n.remove()); clone.setAttribute("viewBox", `0 ${-scene.height} ${scene.width} ${scene.height}`); clone.setAttribute("width", "1200"); clone.setAttribute("height", String(Math.max(1, 1200 * scene.height / scene.width))); const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }), url = URL.createObjectURL(blob); try {
            const image = new Image();
            await new Promise((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("SVG rasterization failed.")); image.src = url; });
            const canvas = document.createElement("canvas");
            canvas.width = 1200;
            canvas.height = Math.max(1, Math.round(1200 * scene.height / scene.width));
            (_a = canvas.getContext("2d")) === null || _a === void 0 ? void 0 : _a.drawImage(image, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL("image/png").split(",")[1];
        }
        finally {
            URL.revokeObjectURL(url);
        } };
        const showAiPreview = (tikz) => { const pop = document.createElement("div"); pop.className = "pro-canvas-code-popover"; const area = document.createElement("textarea"); area.rows = 10; area.value = stripTikzWrapper(tikz); const place = document.createElement("button"); place.textContent = "コードオブジェクトとして配置"; place.onclick = () => { snapshot(); const object = { id: newObjectId(), type: "code", tikz: stripTikzWrapper(area.value), transform: { tx: scene.width / 2, ty: scene.height / 2, rotate: 0, sx: 1, sy: 1 } }; scene.objects.push(object); replaceSelection(object.id); pop.remove(); render(); scheduleCompile(); }; pop.append(area, place); overlay.append(pop); area.focus(); };
        const importSvgFile = async () => { const file = await pickFile(".svg,image/svg+xml"); if (!file)
            return; const result = importSvg(await file.text(), scene.width * .8); if (!result)
            throw new Error("SVG を読み込めませんでした"); snapshot(); const group = { id: newObjectId(), type: "group", children: result.objects, transform: { tx: scene.width / 2, ty: scene.height / 2, rotate: 0, sx: 1, sy: 1 } }; scene.objects.push(group); replaceSelection(group.id); setStatus(result.warnings.length ? `${result.warnings.length} 件の警告: ${result.warnings[0]}` : ""); render(); scheduleCompile(); };
        const importAi = async () => { var _a; const snippet = (_a = window.tex64Texize) === null || _a === void 0 ? void 0 : _a.snippet; if (!snippet)
            return; let imageBase64; if (confirm("OK: 画像ファイルを選ぶ / キャンセル: 今のキャンバスを下絵にする")) {
            const file = await pickFile("image/*");
            if (!file)
                return;
            imageBase64 = (await readDataUrl(file)).split(",")[1];
        }
        else
            imageBase64 = await approximatePng(); setStatus("TikZ 化中…"); const result = await snippet({ imageBase64 }); if (!(result === null || result === void 0 ? void 0 : result.ok))
            throw new Error((result === null || result === void 0 ? void 0 : result.error) || "texize failed."); setStatus(""); showAiPreview(result.tex || ""); };
        overlay.addEventListener("click", async (e) => { var _a; const action = (_a = e.target.closest("button")) === null || _a === void 0 ? void 0 : _a.dataset.action; try {
            if (action === "svg-import")
                await importSvgFile();
            else if (action === "ai-import")
                await importAi();
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
                anchorEdit = { pathId: object.id };
                selectedAnchorIndex = 0;
            }
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
        const loadProjectContext = async () => {
            var _a;
            const api = (_a = window.tex64Files) === null || _a === void 0 ? void 0 : _a.readText, rootPath = deps.getRootFilePath(), sources = [];
            if (!api) {
                preambleReason = "ファイル読み込み機能が利用できません";
                render();
                return;
            }
            if (!rootPath)
                preambleReason = "ルート文書が選択されていません";
            else
                try {
                    const root = await api({ path: rootPath });
                    if (!root.ok)
                        throw new Error(root.error || "ルート文書を読み込めません");
                    preamble = extractPreamble(root.text || "");
                    if (preamble)
                        sources.push(preamble);
                    else
                        preambleReason = "ルート文書からプリアンブルを取得できません";
                }
                catch (error) {
                    preambleReason = error instanceof Error ? error.message : "プリアンブルを読み込めません";
                }
            const styFiles = deps.getWorkspaceFiles().filter(path => { const normalized = path.replace(/\\/g, "/").replace(/^\.\//, ""); return normalized.toLowerCase().endsWith(".sty") && normalized.split("/").length <= 2; }).slice(0, 20);
            const reads = await Promise.all(styFiles.map(path => api({ path }).catch(() => ({ ok: false, text: undefined, error: undefined }))));
            reads.forEach(result => { if (result.ok && result.text)
                sources.push(result.text); });
            projectStyles = scanTikzsetStyles(sources.join("\n"));
            render();
            if (docPreamble && preamble)
                scheduleCompile();
        };
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
        new ResizeObserver(render).observe(stage);
        render();
        scheduleCompile();
        void loadProjectContext();
    };
    window.addEventListener("tex64:pro-canvas-open", ((event) => open(event.detail || {})));
    return { open, cancel: () => closeCurrent === null || closeCurrent === void 0 ? void 0 : closeCurrent() };
};
