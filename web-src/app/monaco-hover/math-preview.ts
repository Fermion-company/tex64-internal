const stripMathDelimiters = (latex: string) => {
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

const normalizeLatexForMathLive = (latex: string) => {
  let value = latex.trim();
  if (!value) {
    return value;
  }

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

const sanitizeGeneratedMathHtml = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+=(["']).*?\1/gi, "")
    .replace(/\shref=(["'])\s*javascript:[\s\S]*?\1/gi, "")
    .trim();

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const DOUBLE_BAR_TOKENS = new Set(["∥", "‖", "||", "\\|", "\\Vert", "\\lVert", "\\rVert"]);
const INVISIBLE_MATH_SPACING = /^[\s\u00a0\u2009\u200a\u2062]+$/;

const normalizeMathMlNodes = (root: Element) => {
  const doc = root.ownerDocument;
  if (!doc) {
    return;
  }
  for (const node of Array.from(root.querySelectorAll("mo, mi, mtext"))) {
    const rawText = node.textContent ?? "";
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

const normalizeMathMlForSvg = (mathMl: string) => {
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

export const buildMathPreviewHtml = (latex: string) => {
  const MathLiveGlobal = (window as any).MathLive;
  const convertToMathMl = MathLiveGlobal?.convertLatexToMathMl;
  const stripped = stripMathDelimiters(latex);
  if (!stripped) {
    return null;
  }
  const normalized = normalizeLatexForMathLive(stripped);
  if (!normalized) {
    return null;
  }
  try {
    const renderLatex =
      /^\\begin\{/.test(normalized) || /^\\displaystyle\b/.test(normalized)
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

    const padX = 6;
    const padY = 4;
    let width = 240;
    let height = 92;
    try {
      const probeHost = document.createElement("div");
      probeHost.style.position = "fixed";
      probeHost.style.left = "-10000px";
      probeHost.style.top = "-10000px";
      probeHost.style.pointerEvents = "none";
      probeHost.style.opacity = "0";
      probeHost.style.whiteSpace = "nowrap";
      probeHost.style.margin = "0";
      probeHost.style.padding = "0";
      const probeInner = document.createElement("div");
      probeInner.style.display = "inline-block";
      probeInner.style.margin = "0";
      probeInner.style.padding = "0";
      probeInner.style.lineHeight = "1.15";
      probeInner.innerHTML = renderRoot;
      probeHost.appendChild(probeInner);
      document.body.appendChild(probeHost);
      const rect = probeInner.getBoundingClientRect();
      probeHost.remove();
      if (rect.width > 1 && rect.height > 1) {
        width = Math.max(34, Math.min(360, Math.ceil(rect.width) + padX * 2));
        height = Math.max(30, Math.min(140, Math.ceil(rect.height) + padY * 2));
      }
    } catch {
      // Keep fallback size when DOM measurement fails.
    }

    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<foreignObject x="0" y="0" width="${width}" height="${height}">`,
      `<div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;align-items:center;justify-content:center;width:${width}px;height:${height}px;background:rgba(39,54,84,0.98);color:rgba(247,250,255,0.99);font-family:'STIX Two Math','Cambria Math','Latin Modern Math','Times New Roman',serif;padding:${padY}px ${padX}px;box-sizing:border-box;overflow:hidden;">`,
      renderRoot,
      `</div>`,
      `</foreignObject>`,
      `</svg>`,
    ].join("");
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}#tex64-math`;
    const escaped = dataUrl.replace(/"/g, "&quot;");
    return `<div class="tex64-hover-preview tex64-hover-preview-math" data-tex64-preview="math"><img src="${escaped}" alt="" /></div>`;
  } catch {
    return null;
  }
};

