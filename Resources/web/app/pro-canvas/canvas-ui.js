import { insertAtEditorCursor } from "../pro-editor-insert.js";
import { buildIncludeGraphicsSnippet, chooseCaptureDirectory } from "../pro-capture-ui.js";
import { encodeFigureBlock } from "./figure-codec.js";
import { base64EncodeUtf8 } from "./figure-codec.js";
import { cloneScene, createEmptyScene, findSymbol, newObjectId, resolveStyle } from "./scene.js";
import { alignDeltas, boundsAfterHandleDrag, collectSnapLines, cornerInstanceTransforms, distributeDeltas, marqueeHits, mirrorInstanceTransform, resizeHandlePoint, resizePoint, samplePathPoints, screenToScene, snapBoundsToLines, snapToGrid, zoomAtPoint } from "./canvas-math.js";
import { buildStandaloneDoc } from "./standalone.js";
import { buildStyFile } from "./sty-export.js";
import { stripTikzWrapper } from "./code-import.js";
import { importSvg } from "./svg-import.js";
import { extractPreamble, scanTikzsetStyles } from "./project-context.js";
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
const allPoints = (object, scene) => {
    var _a;
    if (object.type === "code") {
        const t = object.transform, rad = t.rotate * Math.PI / 180;
        return [{ x: -5, y: -5 }, { x: 5, y: 5 }].map(p => ({ x: t.tx + p.x * t.sx * Math.cos(rad) - p.y * t.sy * Math.sin(rad), y: t.ty + p.x * t.sx * Math.sin(rad) + p.y * t.sy * Math.cos(rad) }));
    }
    if (object.type === "rect")
        return [object.from, object.to];
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
        let editingSymbolId = null, tool = "select", zoom = 1, panX = 0, panY = 0, space = false, hoveredId = null;
        let undo = [], redo = [];
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
        const toolIcons = { select: '<polyline points="3,2 3,13 6.5,9.5 9,14 11,13 8.5,8.5 13,8.5 3,2"/>', pen: '<line x1="3" y1="13" x2="11" y2="5"/><polyline points="9,3 13,7 11,9 7,5 9,3"/><line x1="3" y1="13" x2="7" y2="12"/>', line: '<line x1="3" y1="13" x2="13" y2="3"/>', rect: '<rect x="3" y="3" width="10" height="10"/>', ellipse: '<ellipse cx="8" cy="8" rx="5" ry="4"/>', node: '<line x1="3" y1="3" x2="13" y2="3"/><line x1="8" y1="3" x2="8" y2="13"/>', code: '<polyline points="6,4 2,8 6,12"/><polyline points="10,4 14,8 10,12"/>' };
        [['select', '選択', 'V'], ['pen', 'ペン', 'P'], ['line', '直線', 'L'], ['rect', '矩形', 'R'], ['ellipse', '楕円', 'E'], ['node', 'ノード', 'T'], ['code', 'コード', 'C']].forEach(([id, label, key]) => { const b = document.createElement("button"); b.dataset.tool = id; b.title = `${label} (${key})`; b.setAttribute("aria-label", b.title); b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${toolIcons[id]}</svg>`; toolHost.appendChild(b); });
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
        const symbolizeSelection = (object, symmetric) => {
            const name = prompt("Symbol name (letters and digits)");
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
            add.onclick = () => { const name = prompt("Style name (letters only)"); if (!name || !/^[A-Za-z]+$/.test(name) || scene.styles.some(s => s.name === name))
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
                corners.onclick = () => { const raw = prompt("inset", "5"); if (raw === null)
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
                along.onclick = () => { if ((object === null || object === void 0 ? void 0 : object.type) !== "path")
                    return; const raw = prompt("配置数", "5"); if (raw === null)
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
            var _a;
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
                var _a, _b, _c, _d;
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
                    parent.append(g);
                    return;
                }
                const style = resolveStyle(scene, object.style);
                const ptu = (_b = PT_IN_UNIT[scene.unit]) !== null && _b !== void 0 ? _b : 1;
                const lw = (style.lineWidthPt || .4) * ptu;
                const attrs = { ...(interactive ? { "data-id": object.id } : {}), fill: style.fill || "none", stroke: style.draw || "none", "stroke-width": lw, opacity: (_c = style.opacity) !== null && _c !== void 0 ? _c : 1, "stroke-dasharray": style.dash === "dashed" ? `${lw * 4} ${lw * 3}` : style.dash === "dotted" ? `${lw} ${lw * 2.5}` : "" };
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
                    el = svgEl("text", { ...(interactive ? { "data-id": object.id } : {}), opacity: (_d = style.opacity) !== null && _d !== void 0 ? _d : 1, x: object.at.x, y: -object.at.y, transform: `scale(1,-1)`, class: "pro-canvas-node" });
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
                    const b = objectBounds(hovered, scene);
                    root.append(svgEl("rect", { x: b.minX, y: b.minY, width: Math.max(b.maxX - b.minX, .01), height: Math.max(b.maxY - b.minY, .01), class: "pro-canvas-hover" }));
                }
            }
            const selected = topLevelSelectedObjects();
            if (selected.length) {
                const select = svgEl("g", { class: "pro-canvas-selection" });
                selected.forEach(item => { const b = objectBounds(item, scene); select.append(svgEl("rect", { x: b.minX, y: b.minY, width: Math.max(b.maxX - b.minX, .01), height: Math.max(b.maxY - b.minY, .01), class: "pro-canvas-selection-outline" })); });
                const b = selectionBounds();
                if (selected.length > 1)
                    select.append(svgEl("rect", { x: b.minX, y: b.minY, width: Math.max(b.maxX - b.minX, .01), height: Math.max(b.maxY - b.minY, .01), class: "pro-canvas-selection-bounds" }));
                else {
                    handles.forEach(h => { const p = resizeHandlePoint(b, h), size = 7 / scale; const handle = svgEl("rect", { x: p.x - size / 2, y: p.y - size / 2, width: size, height: size, class: `pro-canvas-handle pro-canvas-handle-${h}` }); handle.dataset.handle = h; select.append(handle); });
                    const x = (b.minX + b.maxX) / 2, stemTop = b.maxY + 18 / scale;
                    select.append(svgEl("line", { x1: x, y1: b.maxY, x2: x, y2: stemTop, class: "pro-canvas-rotate-stem" }));
                    const rotate = svgEl("circle", { cx: x, cy: stemTop, r: 4 / scale, class: "pro-canvas-rotate" });
                    rotate.dataset.rotate = "true";
                    select.append(rotate);
                }
                root.append(select);
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
            overlay.querySelector("[data-action=ai-import]").disabled = !((_a = window.tex64Texize) === null || _a === void 0 ? void 0 : _a.snippet);
            renderInspector();
        };
        let drag = null;
        let penDrag = null;
        let pen = null, penCursor = null;
        const cacheDragLines = () => { if (drag && ["move", "resize", "draw"].includes(drag.kind))
            drag.lines = collectSnapLines(currentObjects().filter(o => !selection.ids.has(o.id)).map(o => objectBounds(o, scene)), scene); };
        svg.addEventListener("pointerdown", e => {
            var _a, _b, _c;
            const target = e.target, client = { x: e.clientX, y: e.clientY };
            if (space) {
                drag = { kind: "pan", start: { x: panX, y: panY }, startClient: client, before: cloneScene(scene), lastClient: client };
                hoveredId = null;
                svg.setPointerCapture(e.pointerId);
                render();
                return;
            }
            const raw = rawPoint(e), p = snappedPoint(e), handle = target.dataset.handle, id = (_a = target.closest("[data-id]")) === null || _a === void 0 ? void 0 : _a.dataset.id;
            if (tool === "select") {
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
                const latex = (_c = prompt("LaTeX", "")) !== null && _c !== void 0 ? _c : "";
                if (latex) {
                    snapshot();
                    invalidateCompiled();
                    currentObjects().push({ id: newObjectId(), type: "node", at: p, latex, anchor: "center", style: {} });
                }
                render();
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
        svg.addEventListener("pointermove", e => { var _a, _b, _c, _d; if (penDrag) {
            const p = snappedPoint(e);
            if (Math.hypot(p.x - penDrag.end.x, p.y - penDrag.end.y) > .1)
                penDrag.path.segments[penDrag.index] = { type: "cubic", c1: { ...penDrag.previous }, c2: { x: 2 * penDrag.end.x - p.x, y: 2 * penDrag.end.y - p.y }, to: { ...penDrag.end } };
            render();
            return;
        } if (!drag) {
            const target = e.target, nextHoveredId = (_b = (_a = target.closest("[data-id]")) === null || _a === void 0 ? void 0 : _a.dataset.id) !== null && _b !== void 0 ? _b : null, handle = target.dataset.handle;
            svg.style.cursor = target.dataset.rotate ? "grab" : handle ? `${handle}-resize` : nextHoveredId ? "move" : "default";
            if (nextHoveredId !== hoveredId) {
                hoveredId = nextHoveredId;
                render();
            }
            return;
        } if (drag.kind === "pan" && drag.lastClient) {
            panX = drag.start.x + e.clientX - drag.lastClient.x;
            panY = drag.start.y + e.clientY - drag.lastClient.y;
            render();
            return;
        } const raw = rawPoint(e), crossedThreshold = !drag.moved && Math.hypot(e.clientX - drag.startClient.x, e.clientY - drag.startClient.y) >= 4; if (crossedThreshold) {
            drag.moved = true;
            if (["move", "resize", "rotate"].includes(drag.kind))
                invalidateCompiled();
        } if (drag.kind === "marquee") {
            drag.current = raw;
            if (drag.moved) {
                const rect = { minX: Math.min(drag.start.x, raw.x), minY: Math.min(drag.start.y, raw.y), maxX: Math.max(drag.start.x, raw.x), maxY: Math.max(drag.start.y, raw.y) };
                selection.ids = new Set(marqueeHits(rect, currentObjects().map(item => ({ id: item.id, bounds: objectBounds(item, scene) }))));
                const ids = [...selection.ids];
                selection.primaryId = (_c = ids[ids.length - 1]) !== null && _c !== void 0 ? _c : null;
            }
            render();
            return;
        } scene = cloneScene(drag.before); const delta = snappedDelta(drag.start, raw, e), origin = (_d = drag.anchor) !== null && _d !== void 0 ? _d : drag.start, p = { x: origin.x + delta.x, y: origin.y + delta.y }; if (drag.kind === "move") {
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
            }
        } render(); });
        svg.addEventListener("pointerup", e => { const completed = drag, changed = Boolean((completed === null || completed === void 0 ? void 0 : completed.moved) && ["move", "resize", "rotate"].includes(completed.kind)), drewObject = Boolean((completed === null || completed === void 0 ? void 0 : completed.kind) === "draw" && completed.moved && completed.id); if (changed) {
            undo.push(completed.before);
            redo = [];
        }
        else if (completed && !completed.moved && ["move", "resize", "rotate"].includes(completed.kind)) {
            scene = completed.before;
        }
        else if ((completed === null || completed === void 0 ? void 0 : completed.kind) === "draw" && !completed.moved && completed.id) {
            removeById(currentObjects(), completed.id);
            clearSelection();
            undo.pop();
        } drag = null; penDrag = null; if (svg.hasPointerCapture(e.pointerId))
            svg.releasePointerCapture(e.pointerId); render(); if (changed || drewObject)
            scheduleCompile(); });
        svg.addEventListener("pointerleave", () => { if (!drag && hoveredId) {
            hoveredId = null;
            svg.style.cursor = "default";
            render();
        } });
        const close = () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("keydown", onToolKey, true); window.removeEventListener("keyup", onKeyUp, true); if (compileTimer)
            clearTimeout(compileTimer); compileSequence += 1; overlay.remove(); if (closeCurrent === close)
            closeCurrent = null; };
        closeCurrent = close;
        const undoOnce = () => { const prev = undo.pop(); if (!prev)
            return; redo.push(cloneScene(scene)); scene = prev; clearSelection(); render(); scheduleCompile(); };
        const redoOnce = () => { const next = redo.pop(); if (!next)
            return; undo.push(cloneScene(scene)); scene = next; clearSelection(); render(); scheduleCompile(); };
        const cloneWithNewIds = (object) => { const copy = JSON.parse(JSON.stringify(object)); const renew = (item) => { item.id = newObjectId(); if (item.type === "group")
            item.children.forEach(renew); }; renew(copy); return copy; };
        const onKey = (e) => {
            var _a, _b;
            const target = e.target;
            if (target === null || target === void 0 ? void 0 : target.closest("input,select,textarea,[contenteditable=true]"))
                return;
            e.stopPropagation();
            const command = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
            if (e.key === "Escape") {
                e.preventDefault();
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
        const onToolKey = (e) => { const target = e.target; if ((target === null || target === void 0 ? void 0 : target.closest("input,select,textarea,[contenteditable=true]")) || e.metaKey || e.ctrlKey || e.altKey)
            return; const next = { v: "select", p: "pen", l: "line", r: "rect", e: "ellipse", t: "node", c: "code" }[e.key.toLowerCase()]; if (next) {
            tool = next;
            e.preventDefault();
            render();
        } };
        const onKeyUp = (e) => { const target = e.target; if (target === null || target === void 0 ? void 0 : target.closest("input,select,textarea,[contenteditable=true]"))
            return; e.stopPropagation(); if (e.key === " ")
            space = false; };
        window.addEventListener("keydown", onToolKey, true);
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("keyup", onKeyUp, true);
        svg.addEventListener("wheel", e => { e.preventDefault(); if (e.ctrlKey || e.metaKey) {
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
        const exportSty = async () => { var _a; let name = (prompt("ファイル名", "figures.sty") || "").trim(); if (!name)
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
        svg.addEventListener("dblclick", e => { var _a; if (tool !== "select")
            return; const id = (_a = e.target.closest("[data-id]")) === null || _a === void 0 ? void 0 : _a.dataset.id, object = id ? walk(currentObjects(), id) : null; if ((object === null || object === void 0 ? void 0 : object.type) === "code") {
            replaceSelection(object.id);
            render();
            editCode(object);
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
