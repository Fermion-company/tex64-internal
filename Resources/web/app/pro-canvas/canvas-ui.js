import { insertAtEditorCursor } from "../pro-editor-insert.js";
import { buildIncludeGraphicsSnippet, chooseCaptureDirectory } from "../pro-capture-ui.js";
import { encodeFigureBlock } from "./figure-codec.js";
import { base64EncodeUtf8 } from "./figure-codec.js";
import { cloneScene, createEmptyScene, findSymbol, newObjectId, resolveStyle } from "./scene.js";
import { boundsAfterHandleDrag, resizeHandlePoint, resizePoint, samplePathPoints, screenToScene, snapToGrid } from "./canvas-math.js";
import { buildStandaloneDoc } from "./standalone.js";
import { buildStyFile } from "./sty-export.js";
const SVG_NS = "http://www.w3.org/2000/svg";
const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const LIVE_STORAGE_KEY = "tex64.proCanvas.live";
let pdfjsLibPromise = null;
const loadPdfjs = async () => {
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
        let selectedId = null, editingSymbolId = null, tool = "select", zoom = 1, panX = 0, panY = 0, space = false;
        let undo = [], redo = [];
        const overlay = document.createElement("div");
        overlay.className = "pro-canvas-overlay";
        overlay.tabIndex = -1;
        overlay.innerHTML = `<div class="pro-canvas-toolbar" role="toolbar">
      <span class="pro-canvas-tools"></span><button data-action="snap"></button><button data-action="live">Live</button><span class="pro-canvas-separator"></span>
      <button data-action="zoom-out">−</button><button data-action="zoom-reset">100%</button><button data-action="zoom-in">+</button>
      <span class="pro-canvas-separator"></span><button data-action="undo">Undo</button><button data-action="redo">Redo</button></div>
      <div class="pro-canvas-main"><div class="pro-canvas-stage"><svg class="pro-canvas-svg" xmlns="http://www.w3.org/2000/svg"></svg></div><aside class="pro-canvas-inspector"><h3>Style</h3><div class="pro-canvas-style"></div><h3>Named styles</h3><div class="pro-canvas-named"></div><h3>Symbols</h3><div class="pro-canvas-symbols"></div></aside></div>
      <div class="pro-canvas-bottom"><span class="pro-canvas-status"></span><button data-action="sty">.sty へ書き出し</button><button data-action="tikz">${detail.replaceRange ? "更新" : "TikZ を挿入"}</button>${detail.replaceRange ? "" : '<button data-action="png">画像として挿入 (PNG)</button>'}<button data-action="cancel">キャンセル</button></div>`;
        document.body.appendChild(overlay);
        overlay.focus();
        const svg = overlay.querySelector("svg");
        const stage = overlay.querySelector(".pro-canvas-stage");
        const status = overlay.querySelector(".pro-canvas-status");
        const toolHost = overlay.querySelector(".pro-canvas-tools");
        [['select', '選択'], ['pen', 'ペン'], ['line', '直線'], ['rect', '矩形'], ['ellipse', '楕円'], ['node', 'ノード']].forEach(([id, label]) => { const b = document.createElement("button"); b.dataset.tool = id; b.textContent = label; toolHost.appendChild(b); });
        const fermion = window.tex64Fermion;
        let live = localStorage.getItem(LIVE_STORAGE_KEY) !== "false" && Boolean(fermion === null || fermion === void 0 ? void 0 : fermion.canvasRender);
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
            return; const sequence = ++compileSequence; setStatus("コンパイル中…"); try {
            const result = await fermion.canvasRender({ source: buildStandaloneDoc(scene) });
            if (sequence !== compileSequence)
                return;
            const reportError = firstReportError(result === null || result === void 0 ? void 0 : result.report);
            if (!(result === null || result === void 0 ? void 0 : result.ok) || !result.pdfBase64 || reportError)
                throw new Error(reportError || (result === null || result === void 0 ? void 0 : result.error) || "コンパイルエラー");
            const image = await renderPdf(result.pdfBase64);
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
        const snapshot = () => { undo.push(cloneScene(scene)); if (undo.length > 80)
            undo.shift(); redo = []; queueMicrotask(scheduleCompile); };
        const view = () => { const r = svg.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, sceneWidth: scene.width, sceneHeight: scene.height, zoom, panX, panY }; };
        const point = (event) => snapToGrid(screenToScene({ x: event.clientX, y: event.clientY }, view()), scene.grid.size, scene.grid.snap && !event.altKey);
        const setStatus = (message, error = false) => { status.textContent = message; status.classList.toggle("is-error", error); };
        const currentObjects = () => { var _a; return editingSymbolId ? ((_a = findSymbol(scene, editingSymbolId)) === null || _a === void 0 ? void 0 : _a.objects) || [] : scene.objects; };
        const renderInspector = () => {
            var _a;
            const host = overlay.querySelector(".pro-canvas-style");
            const named = overlay.querySelector(".pro-canvas-named");
            const symbols = overlay.querySelector(".pro-canvas-symbols");
            const object = selectedId ? walk(currentObjects(), selectedId) : null;
            host.replaceChildren();
            named.replaceChildren();
            symbols.replaceChildren();
            if (!object || object.type === "group")
                host.textContent = "Select a drawable object";
            else {
                const props = (_a = object.style).props || (_a.props = {});
                const effective = resolveStyle(scene, object.style);
                const color = (key, label) => { const row = document.createElement("label"); row.textContent = label; const input = document.createElement("input"); input.type = "color"; input.value = effective[key] || "#000000"; const none = document.createElement("input"); none.type = "checkbox"; none.checked = effective[key] === null; input.disabled = none.checked; input.onchange = () => { snapshot(); props[key] = input.value; render(); }; none.onchange = () => { snapshot(); props[key] = none.checked ? null : input.value; render(); }; row.append(input, none, document.createTextNode("なし")); host.append(row); };
                color("draw", "線色");
                color("fill", "塗り色");
                const fields = [["線幅", "lineWidthPt", "number"], ["破線", "dash", "select", ["solid", "dashed", "dotted"]], ["不透明度", "opacity", "number"], ["始点矢印", "arrowStart", "select", ["", "Stealth", "Latex", "Bar"]], ["終点矢印", "arrowEnd", "select", ["", "Stealth", "Latex", "Bar"]], ["角丸", "roundedCornersPt", "number"]];
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
            scene.styles.forEach((style) => { const row = document.createElement("div"); row.className = "pro-canvas-style-row"; row.textContent = style.name; const apply = document.createElement("button"); apply.textContent = "適用"; apply.disabled = !object || object.type === "group"; apply.onclick = () => { if (object && object.type !== "group") {
                snapshot();
                object.style.ref = style.name;
                render();
            } }; row.append(apply); named.append(row); });
            const add = document.createElement("button");
            add.textContent = "＋ 新規";
            add.onclick = () => { const name = prompt("Style name (letters only)"); if (!name || !/^[A-Za-z]+$/.test(name) || scene.styles.some(s => s.name === name))
                return; snapshot(); scene.styles.push({ name, props: object && object.type !== "group" ? { ...resolveStyle(scene, object.style) } : { draw: "#000000" } }); render(); };
            named.append(add);
            if (editingSymbolId) {
                const done = document.createElement("button");
                done.textContent = "シンボル編集終了";
                done.onclick = () => { editingSymbolId = null; selectedId = null; render(); scheduleCompile(); };
                symbols.append(done);
                return;
            }
            const symbolize = document.createElement("button");
            symbolize.textContent = "選択をシンボル化";
            symbolize.disabled = !object || object.type === "instance" || object.type === "repeat";
            symbolize.onclick = () => { if (!object)
                return; const name = prompt("Symbol name (letters and digits)"); if (!name || !/^[A-Za-z][A-Za-z0-9]*$/.test(name) || (scene.symbols || []).some(s => s.name === name)) {
                setStatus("有効で重複しないシンボル名を指定してください", true);
                return;
            } snapshot(); removeById(scene.objects, object.id); const symbol = { id: newObjectId(), name, objects: [object] }; (scene.symbols || (scene.symbols = [])).push(symbol); const instance = { id: newObjectId(), type: "instance", symbol: symbol.id, transform: { tx: 0, ty: 0, rotate: 0, sx: 1, sy: 1 }, style: {} }; scene.objects.push(instance); selectedId = instance.id; render(); };
            symbols.append(symbolize);
            for (const symbol of scene.symbols || []) {
                const row = document.createElement("div");
                row.className = "pro-canvas-symbol-row";
                row.append(document.createTextNode(symbol.name));
                const place = document.createElement("button");
                place.textContent = "配置";
                place.onclick = () => { snapshot(); const instance = { id: newObjectId(), type: "instance", symbol: symbol.id, transform: { tx: scene.width / 2, ty: scene.height / 2, rotate: 0, sx: 1, sy: 1 }, style: {} }; scene.objects.push(instance); selectedId = instance.id; render(); };
                const edit = document.createElement("button");
                edit.textContent = "編集";
                edit.onclick = () => { editingSymbolId = symbol.id; selectedId = null; invalidateCompiled(); setStatus(""); render(); };
                const along = document.createElement("button");
                along.textContent = "選択パスに沿って配置";
                along.disabled = (object === null || object === void 0 ? void 0 : object.type) !== "path";
                along.onclick = () => { if ((object === null || object === void 0 ? void 0 : object.type) !== "path")
                    return; const raw = prompt("配置数", "5"); if (raw === null)
                    return; snapshot(); const repeat = { id: newObjectId(), type: "repeat", symbol: symbol.id, path: { start: { ...object.start }, segments: JSON.parse(JSON.stringify(object.segments)) }, count: Math.max(1, Math.floor(Number(raw) || 1)), align: true, style: {} }; scene.objects.push(repeat); selectedId = repeat.id; render(); };
                const remove = document.createElement("button");
                remove.textContent = "削除";
                remove.onclick = () => { var _a; const referenced = scene.objects.some(o => { let hit = false; const visit = (items) => items.forEach(item => { if ((item.type === "instance" || item.type === "repeat") && item.symbol === symbol.id)
                    hit = true;
                else if (item.type === "group")
                    visit(item.children); }); visit([o]); return hit; }); if (referenced) {
                    setStatus("配置またはリピートから参照されているため削除できません", true);
                    return;
                } snapshot(); scene.symbols = (_a = scene.symbols) === null || _a === void 0 ? void 0 : _a.filter(s => s.id !== symbol.id); render(); };
                row.append(place, edit, along, remove);
                symbols.append(row);
            }
        };
        const render = () => {
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
                var _a, _b, _c;
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
                const style = resolveStyle(scene, object.style);
                const attrs = { ...(interactive ? { "data-id": object.id } : {}), fill: style.fill || "none", stroke: style.draw || "none", "stroke-width": style.lineWidthPt || .4, opacity: (_b = style.opacity) !== null && _b !== void 0 ? _b : 1, "stroke-dasharray": style.dash === "dashed" ? "3 2" : style.dash === "dotted" ? "1 2" : "" };
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
                    el = svgEl("text", { ...(interactive ? { "data-id": object.id } : {}), opacity: (_c = style.opacity) !== null && _c !== void 0 ? _c : 1, x: object.at.x, y: -object.at.y, transform: `scale(1,-1)`, class: "pro-canvas-node" });
                    el.textContent = object.latex;
                }
                parent.append(el);
            };
            currentObjects().forEach(o => draw(o, objects));
            const object = selectedId ? walk(currentObjects(), selectedId) : null;
            if (object) {
                const b = objectBounds(object, scene);
                const select = svgEl("g", { class: "pro-canvas-selection" });
                select.append(svgEl("rect", { x: b.minX, y: b.minY, width: Math.max(b.maxX - b.minX, .01), height: Math.max(b.maxY - b.minY, .01) }));
                handles.forEach(h => { const p = resizeHandlePoint(b, h); const c = svgEl("circle", { cx: p.x, cy: p.y, r: 4 / scale, class: "pro-canvas-handle" }); c.dataset.handle = h; select.append(c); });
                const rotate = svgEl("circle", { cx: (b.minX + b.maxX) / 2, cy: b.maxY + 18 / scale, r: 4 / scale, class: "pro-canvas-rotate" });
                rotate.dataset.rotate = "true";
                select.append(rotate);
                root.append(select);
            }
            overlay.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("is-active", b.dataset.tool === tool));
            const snap = overlay.querySelector("[data-action=snap]");
            snap.textContent = `Snap ${scene.grid.snap ? "on" : "off"}`;
            snap.classList.toggle("is-active", scene.grid.snap);
            const liveButton = overlay.querySelector("[data-action=live]");
            liveButton.disabled = !(fermion === null || fermion === void 0 ? void 0 : fermion.canvasRender);
            liveButton.classList.toggle("is-active", live);
            liveButton.setAttribute("aria-pressed", String(live));
            overlay.querySelector("[data-action=zoom-reset]").textContent = `${Math.round(zoom * 100)}%`;
            overlay.querySelector("[data-action=undo]").disabled = !undo.length;
            overlay.querySelector("[data-action=redo]").disabled = !redo.length;
            renderInspector();
        };
        let drag = null;
        let penDrag = null;
        let pen = null;
        svg.addEventListener("pointerdown", e => {
            var _a, _b;
            invalidateCompiled();
            render();
            const target = e.target;
            if (space) {
                drag = { kind: "pan", start: { x: panX, y: panY }, before: cloneScene(scene), lastClient: { x: e.clientX, y: e.clientY } };
                svg.setPointerCapture(e.pointerId);
                return;
            }
            const p = point(e);
            const handle = target.dataset.handle;
            const id = (_a = target.closest("[data-id]")) === null || _a === void 0 ? void 0 : _a.dataset.id;
            if (tool === "select") {
                if (handle && selectedId) {
                    const o = walk(currentObjects(), selectedId);
                    drag = { kind: "resize", start: p, before: cloneScene(scene), id: selectedId, handle, bounds: objectBounds(o, scene) };
                }
                else if (target.dataset.rotate && selectedId) {
                    drag = { kind: "rotate", start: p, before: cloneScene(scene), id: selectedId, bounds: objectBounds(walk(currentObjects(), selectedId), scene) };
                }
                else if (id) {
                    selectedId = id;
                    const object = walk(currentObjects(), id);
                    drag = { kind: e.shiftKey ? "rotate" : "move", start: p, before: cloneScene(scene), id, bounds: objectBounds(object, scene) };
                }
                else
                    selectedId = null;
                render();
                svg.setPointerCapture(e.pointerId);
                return;
            }
            if (tool === "node") {
                snapshot();
                const latex = (_b = prompt("LaTeX", "")) !== null && _b !== void 0 ? _b : "";
                if (latex)
                    currentObjects().push({ id: newObjectId(), type: "node", at: p, latex, anchor: "center", style: { props: { draw: "#000000" } } });
                render();
                return;
            }
            if (tool === "pen") {
                if (!pen) {
                    snapshot();
                    pen = { id: newObjectId(), type: "path", start: p, segments: [], closed: false, style: { props: { draw: "#000000" } } };
                    currentObjects().push(pen);
                }
                else if (Math.hypot(p.x - pen.start.x, p.y - pen.start.y) < scene.grid.size * .4) {
                    pen.closed = true;
                    pen = null;
                }
                else {
                    const previous = pen.segments.length ? pen.segments[pen.segments.length - 1].to : pen.start;
                    pen.segments.push({ type: "line", to: p });
                    penDrag = { path: pen, index: pen.segments.length - 1, end: { ...p }, previous: { ...previous } };
                    svg.setPointerCapture(e.pointerId);
                }
                render();
                return;
            }
            snapshot();
            const object = tool === "line" ? { id: newObjectId(), type: "path", start: p, segments: [{ type: "line", to: p }], closed: false, style: { props: { draw: "#000000" } } } : tool === "rect" ? { id: newObjectId(), type: "rect", from: p, to: { ...p }, style: { props: { draw: "#000000" } } } : { id: newObjectId(), type: "ellipse", center: p, rx: 0, ry: 0, style: { props: { draw: "#000000" } } };
            currentObjects().push(object);
            selectedId = object.id;
            drag = { kind: "draw", start: p, before: cloneScene(scene), id: object.id };
            svg.setPointerCapture(e.pointerId);
            render();
        });
        svg.addEventListener("pointermove", e => { if (penDrag) {
            const p = point(e);
            if (Math.hypot(p.x - penDrag.end.x, p.y - penDrag.end.y) > .1)
                penDrag.path.segments[penDrag.index] = { type: "cubic", c1: { ...penDrag.previous }, c2: { x: 2 * penDrag.end.x - p.x, y: 2 * penDrag.end.y - p.y }, to: { ...penDrag.end } };
            render();
            return;
        } if (!drag)
            return; if (drag.kind === "pan" && drag.lastClient) {
            panX = drag.start.x + e.clientX - drag.lastClient.x;
            panY = drag.start.y + e.clientY - drag.lastClient.y;
            render();
            return;
        } const p = point(e); if (p.x !== drag.start.x || p.y !== drag.start.y)
            drag.moved = true; scene = cloneScene(drag.before); const o = drag.id ? walk(currentObjects(), drag.id) : null; if (!o)
            return; if (drag.kind === "move")
            moveObject(o, p.x - drag.start.x, p.y - drag.start.y);
        else if (drag.kind === "resize" && drag.bounds && drag.handle)
            resizeObject(o, drag.bounds, boundsAfterHandleDrag(drag.bounds, drag.handle, p));
        else if (drag.kind === "rotate") {
            const b = drag.bounds;
            const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
            const angle = (Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(drag.start.y - c.y, drag.start.x - c.x)) * 180 / Math.PI;
            if (o.type === "group" || o.type === "instance")
                rotateTransformAround(o.transform, c, angle);
            else if (o.type === "rect" || o.type === "ellipse") {
                const wrapper = { id: `rot-${o.id}`, type: "group", children: [o], transform: { tx: 0, ty: 0, rotate: 0, sx: 1, sy: 1 } };
                rotateTransformAround(wrapper.transform, c, angle);
                replaceById(currentObjects(), o.id, wrapper);
                selectedId = wrapper.id;
            }
            else {
                const rad = angle * Math.PI / 180;
                allPoints(o, scene).forEach(q => { const x = q.x - c.x, y = q.y - c.y; q.x = c.x + x * Math.cos(rad) - y * Math.sin(rad); q.y = c.y + x * Math.sin(rad) + y * Math.cos(rad); });
            }
        }
        else if (drag.kind === "draw") {
            if (o.type === "rect")
                o.to = p;
            else if (o.type === "ellipse") {
                o.center = { x: (drag.start.x + p.x) / 2, y: (drag.start.y + p.y) / 2 };
                o.rx = Math.abs(p.x - drag.start.x) / 2;
                o.ry = Math.abs(p.y - drag.start.y) / 2;
            }
            else if (o.type === "path")
                o.segments[0] = { type: "line", to: p };
        } render(); });
        svg.addEventListener("pointerup", e => { if (drag && drag.moved && ["move", "resize", "rotate"].includes(drag.kind)) {
            undo.push(drag.before);
            redo = [];
        }
        else if (drag && drag.kind === "draw" && !drag.moved && drag.id) {
            removeById(currentObjects(), drag.id);
            selectedId = null;
            undo.pop();
        } drag = null; penDrag = null; if (svg.hasPointerCapture(e.pointerId))
            svg.releasePointerCapture(e.pointerId); render(); scheduleCompile(); });
        const close = () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("keyup", onKeyUp, true); if (compileTimer)
            clearTimeout(compileTimer); compileSequence += 1; overlay.remove(); if (closeCurrent === close)
            closeCurrent = null; };
        closeCurrent = close;
        const undoOnce = () => { const prev = undo.pop(); if (!prev)
            return; redo.push(cloneScene(scene)); scene = prev; selectedId = null; render(); scheduleCompile(); };
        const redoOnce = () => { const next = redo.pop(); if (!next)
            return; undo.push(cloneScene(scene)); scene = next; selectedId = null; render(); scheduleCompile(); };
        const onKey = (e) => { e.stopPropagation(); if (e.key === " ") {
            space = true;
            e.preventDefault();
        } if (e.key === "Escape") {
            if (pen) {
                pen = null;
                render();
            }
            else if (editingSymbolId) {
                editingSymbolId = null;
                selectedId = null;
                render();
            }
            else
                close();
        } if (e.key === "Enter" && pen) {
            pen = null;
            render();
        } if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
            snapshot();
            removeById(currentObjects(), selectedId);
            selectedId = null;
            render();
            e.preventDefault();
        } if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
            e.preventDefault();
            e.shiftKey ? redoOnce() : undoOnce();
        } if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
            e.preventDefault();
            const objects = currentObjects();
            if (e.shiftKey && selectedId) {
                const g = walk(objects, selectedId);
                if ((g === null || g === void 0 ? void 0 : g.type) === "group") {
                    snapshot();
                    const i = objects.indexOf(g);
                    if (i >= 0)
                        objects.splice(i, 1, ...g.children);
                    selectedId = null;
                    render();
                }
            }
            else if (selectedId) {
                const o = walk(objects, selectedId);
                if (o) {
                    snapshot();
                    removeById(objects, selectedId);
                    const group = { id: newObjectId(), type: "group", children: [o], transform: { tx: 0, ty: 0, rotate: 0, sx: 1, sy: 1 } };
                    objects.push(group);
                    selectedId = group.id;
                    render();
                }
            }
        } };
        const onKeyUp = (e) => { e.stopPropagation(); if (e.key === " ")
            space = false; };
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("keyup", onKeyUp, true);
        const replaceOrInsert = () => { var _a, _b, _c, _d; const editor = deps.getActiveGroup().editor; const block = encodeFigureBlock(scene); if (!detail.replaceRange) {
            insertAtEditorCursor(editor, block, "pro-canvas");
            close();
            return;
        } const Range = (_a = window.monaco) === null || _a === void 0 ? void 0 : _a.Range; if (!(editor === null || editor === void 0 ? void 0 : editor.executeEdits) || !Range)
            throw new Error("No active text editor is available."); (_b = editor.pushUndoStop) === null || _b === void 0 ? void 0 : _b.call(editor); editor.executeEdits("pro-canvas", [{ range: new Range(detail.replaceRange.startLine, 1, detail.replaceRange.endLine + 1, 1), text: block, forceMoveMarkers: true }]); (_c = editor.pushUndoStop) === null || _c === void 0 ? void 0 : _c.call(editor); (_d = editor.focus) === null || _d === void 0 ? void 0 : _d.call(editor); close(); };
        const exportSty = async () => { var _a; let name = (prompt("ファイル名", "figures.sty") || "").trim(); if (!name)
            return; if (!name.toLowerCase().endsWith(".sty"))
            name += ".sty"; name = name.replace(/^.*[\\/]/, ""); const packageName = name.slice(0, -4); if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(packageName))
            throw new Error("有効なファイル名を指定してください"); const api = (_a = window.tex64Files) === null || _a === void 0 ? void 0 : _a.writeBase64; if (!api)
            throw new Error("File writing is not available."); const result = await api({ path: name, data: base64EncodeUtf8(buildStyFile(scene, packageName)) }); if (!result.ok)
            throw new Error(result.error || "The style file could not be saved."); setStatus(`\\usepackage{${packageName}} で使えます`); };
        const exportPng = async () => { var _a; const clone = svg.cloneNode(true); clone.querySelectorAll(".pro-canvas-guides,.pro-canvas-selection").forEach(n => n.remove()); clone.setAttribute("viewBox", `0 ${-scene.height} ${scene.width} ${scene.height}`); const unit = scene.unit === "mm" ? 3.78 : scene.unit === "cm" ? 37.8 : 1.333; const width = Math.max(1, Math.round(scene.width * unit * 2)), height = Math.max(1, Math.round(scene.height * unit * 2)); clone.setAttribute("width", String(width)); clone.setAttribute("height", String(height)); const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }); const url = URL.createObjectURL(blob); try {
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
        overlay.addEventListener("click", async (e) => { const button = e.target.closest("button"); if (!button)
            return; if (button.dataset.tool) {
            tool = button.dataset.tool;
            render();
            return;
        } try {
            switch (button.dataset.action) {
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
        new ResizeObserver(render).observe(stage);
        render();
        scheduleCompile();
    };
    window.addEventListener("tex64:pro-canvas-open", ((event) => open(event.detail || {})));
    return { open, cancel: () => closeCurrent === null || closeCurrent === void 0 ? void 0 : closeCurrent() };
};
