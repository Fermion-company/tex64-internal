const stripMathDelimiters = (latex) => {
    const value = latex.trim();
    if (!value) {
        return "";
    }
    if (value.startsWith("\\(") && value.endsWith("\\)") && value.length > 4) {
        return value.slice(2, -2).trim();
    }
    if (value.startsWith("\\[") && value.endsWith("\\]") && value.length > 4) {
        return value.slice(2, -2).trim();
    }
    if (value.startsWith("$$") && value.endsWith("$$") && value.length > 4) {
        return value.slice(2, -2).trim();
    }
    if (value.startsWith("$") && value.endsWith("$") && !value.startsWith("$$") && value.length > 2) {
        return value.slice(1, -1).trim();
    }
    return value;
};
const normalizeLatexForMathLive = (latex) => {
    let value = latex.trim();
    if (!value) {
        return value;
    }
    // \label / \tag / numbering suppressors are document-level metadata that
    // MathLive either ignores or renders as literal text; drop them so the
    // hover preview shows only the formula itself.
    value = value.replace(/\\label\s*\{[^{}]*\}/g, "");
    value = value.replace(/\\tag\s*\*?\s*\{[^{}]*\}/g, "");
    value = value.replace(/\\(?:nonumber|notag)\b/g, "");
    // MathLive has weak support for alignat/flalign; map them to aligned for stable hover previews.
    value = value.replace(/\\begin\{alignat\*?\}\s*\{[^}]*\}/g, "\\begin{aligned}");
    value = value.replace(/\\end\{alignat\*?\}/g, "\\end{aligned}");
    const hadFlalign = /\\begin\{flalign\*?\}/.test(value) || /\\end\{flalign\*?\}/.test(value);
    if (hadFlalign) {
        value = value.replace(/\\begin\{flalign\*?\}/g, "\\begin{aligned}");
        value = value.replace(/\\end\{flalign\*?\}/g, "\\end{aligned}");
        // flalign commonly uses redundant && anchors that degrade in MathLive; collapse to aligned-style anchors.
        value = value.replace(/&&+/g, "&");
        value = value.replace(/&\s*(\\\\)/g, "$1");
        value = value.replace(/&\s*$/gm, "");
    }
    return value;
};
const sanitizeGeneratedMathHtml = (html) => html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+=(["']).*?\1/gi, "")
    .replace(/\shref=(["'])\s*javascript:[\s\S]*?\1/gi, "")
    .trim();
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const DOUBLE_BAR_TOKENS = new Set(["∥", "‖", "||", "\\|", "\\Vert", "\\lVert", "\\rVert"]);
const INVISIBLE_MATH_SPACING = /^[\s\u00a0\u2009\u200a\u2062]+$/;
const normalizeMathMlNodes = (root) => {
    var _a;
    const doc = root.ownerDocument;
    if (!doc) {
        return;
    }
    for (const node of Array.from(root.querySelectorAll("mo, mi, mtext"))) {
        const rawText = (_a = node.textContent) !== null && _a !== void 0 ? _a : "";
        const collapsed = rawText.replace(/\u2062/g, "").replace(/\s+/g, "").trim();
        if (!collapsed && INVISIBLE_MATH_SPACING.test(rawText)) {
            node.remove();
            continue;
        }
        if (!DOUBLE_BAR_TOKENS.has(collapsed)) {
            continue;
        }
        const row = doc.createElementNS(MATHML_NS, "mrow");
        const left = doc.createElementNS(MATHML_NS, "mo");
        left.textContent = "|";
        const right = doc.createElementNS(MATHML_NS, "mo");
        right.textContent = "|";
        row.append(left, right);
        node.replaceWith(row);
    }
};
const normalizeMathMlForSvg = (mathMl) => {
    if (typeof document === "undefined" || typeof XMLSerializer === "undefined") {
        return null;
    }
    const source = mathMl.replace(/&nbsp;/gi, "&#160;");
    const host = document.createElement("div");
    host.innerHTML = source;
    let root = host.querySelector("math");
    if (!root) {
        host.innerHTML = `<math xmlns="${MATHML_NS}" display="block">${source}</math>`;
        root = host.querySelector("math");
    }
    if (!root) {
        return null;
    }
    normalizeMathMlNodes(root);
    const serialized = new XMLSerializer().serializeToString(root).trim();
    return serialized || null;
};
// A pinned preview can open directly under the pointer in a narrow split.
let pointerX = 0;
let pointerY = 0;
let passThroughRow = null;
export function trackFormulaHoverPointer(event) {
    var _a;
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (passThroughRow && (pointerY < passThroughRow.top || pointerY >= passThroughRow.bottom)) {
        (_a = document.querySelector(".tex64-hover-over-source")) === null || _a === void 0 ? void 0 : _a.classList.remove("tex64-hover-over-source");
        passThroughRow = null;
    }
}
export function scrollFormulaHover(event) {
    if (event.ctrlKey || !event.cancelable)
        return;
    const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
    if (!delta)
        return;
    const target = event.target instanceof Element ? event.target.closest(".tex64-hover-formula") : null;
    const host = event.currentTarget;
    const formula = target !== null && target !== void 0 ? target : (passThroughRow && host instanceof Element ? host.querySelector(".tex64-hover-over-source") : null);
    if (!(formula instanceof HTMLElement) || !formula.isConnected || formula.scrollWidth <= formula.clientWidth)
        return;
    const rect = formula.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX >= rect.right ||
        event.clientY < rect.top || event.clientY >= rect.bottom)
        return;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? parseFloat(getComputedStyle(formula).fontSize)
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? formula.clientWidth : 1;
    formula.scrollLeft += delta * unit;
    event.preventDefault();
    event.stopPropagation();
}
function coversSourceText(host, card) {
    var _a;
    const range = document.createRange();
    for (const line of host.querySelectorAll(".view-lines .view-line")) {
        const row = line.getBoundingClientRect();
        if (row.bottom <= card.top || row.top >= card.bottom || !((_a = line.textContent) === null || _a === void 0 ? void 0 : _a.trim()))
            continue;
        range.selectNodeContents(line);
        if (Array.from(range.getClientRects()).some(r => r.width && r.left < card.right && r.right > card.left))
            return true;
    }
    return false;
}
function preserveSourceClick(preview) {
    var _a, _b;
    if (!preview.isConnected)
        return;
    const widget = preview.closest(".monaco-resizable-hover");
    if (!widget)
        return;
    const host = widget.closest(".editor-host");
    const card = widget.getBoundingClientRect();
    const surface = host === null || host === void 0 ? void 0 : host.closest(".editor-surface");
    if (surface && host && card.width && card.height && coversSourceText(host, card)) {
        const clearance = Math.ceil(card.bottom - surface.getBoundingClientRect().top + 4);
        host.style.setProperty("--tex64-hover-clearance", clearance + "px");
        preview.classList.add("tex64-hover-reserve");
        return;
    }
    if (pointerX < card.left || pointerX >= card.right || pointerY < card.top || pointerY >= card.bottom)
        return;
    if (passThroughRow) {
        (_a = document.querySelector(".tex64-hover-over-source")) === null || _a === void 0 ? void 0 : _a.classList.remove("tex64-hover-over-source");
        passThroughRow = null;
    }
    preview.classList.add("tex64-hover-over-source");
    const sourceLine = (_b = document.elementFromPoint(pointerX, pointerY)) === null || _b === void 0 ? void 0 : _b.closest(".view-line");
    if (!sourceLine || sourceLine.closest(".monaco-editor") !== widget.closest(".monaco-editor")) {
        preview.classList.remove("tex64-hover-over-source");
        return;
    }
    const line = sourceLine.getBoundingClientRect();
    passThroughRow = { top: line.top, bottom: line.bottom };
}
// Monaco sanitizes arbitrary Markdown HTML. Once its preview image loads,
// typeset the expression with the same bundled fonts as the rest of TeX64.
// The image remains the fallback for commands unsupported by KaTeX.
export const typesetMathHover = (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.src.endsWith("#tex64-math") ||
        !image.closest(".monaco-hover"))
        return;
    if (typeof katex === "undefined") {
        requestAnimationFrame(() => preserveSourceClick(image));
        return;
    }
    const formula = document.createElement("span");
    formula.className = "tex64-hover-formula";
    try {
        katex.render(normalizeLatexForMathLive(image.alt), formula, {
            displayMode: true, throwOnError: true, trust: false, strict: "ignore",
        });
    }
    catch {
        requestAnimationFrame(() => preserveSourceClick(image));
        return;
    }
    image.replaceWith(formula);
    requestAnimationFrame(() => preserveSourceClick(formula));
};
export const buildMathPreviewHtml = (latex) => {
    const MathLiveGlobal = window.MathLive;
    const convertToMathMl = MathLiveGlobal === null || MathLiveGlobal === void 0 ? void 0 : MathLiveGlobal.convertLatexToMathMl;
    const stripped = stripMathDelimiters(latex);
    if (!stripped) {
        return null;
    }
    const normalized = normalizeLatexForMathLive(stripped);
    if (!normalized) {
        return null;
    }
    try {
        const renderLatex = /^\\begin\{/.test(normalized) || /^\\displaystyle\b/.test(normalized)
            ? normalized
            : `\\displaystyle ${normalized}`;
        if (typeof convertToMathMl !== "function") {
            return null;
        }
        const mathMlRaw = convertToMathMl(renderLatex);
        if (typeof mathMlRaw !== "string" || !mathMlRaw.trim()) {
            return null;
        }
        const sanitized = sanitizeGeneratedMathHtml(mathMlRaw);
        if (!sanitized) {
            return null;
        }
        const renderRoot = normalizeMathMlForSvg(sanitized);
        if (!renderRoot) {
            return null;
        }
        // Measure and draw with the same typography. Let the SVG viewBox scale
        // both axes together when Monaco opens the preview in a narrow pane.
        const typography = "font:20px math;line-height:normal;display:inline-block;white-space:nowrap;";
        const probe = document.createElement("div");
        probe.style.cssText = typography + "position:fixed;left:-10000px;visibility:hidden;";
        probe.innerHTML = renderRoot;
        document.body.appendChild(probe);
        let rect;
        try {
            rect = probe.getBoundingClientRect();
        }
        finally {
            probe.remove();
        }
        if (!rect.width || !rect.height)
            return null;
        const width = Math.ceil(rect.width) + 4;
        const height = Math.ceil(rect.height) + 4;
        const svg = [
            `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
            `<foreignObject x="2" y="2" width="${width - 2}" height="${height - 2}">`,
            `<div xmlns="http://www.w3.org/1999/xhtml" style="${typography}color:black;">${renderRoot}</div>`,
            "</foreignObject></svg>",
        ].join("");
        const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}#tex64-math`;
        const alt = stripped.replace(/&/g, "&amp;").replace(/\r?\n/g, "&#10;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<img src="${dataUrl}" alt="${alt}" />`;
    }
    catch {
        return null;
    }
};
