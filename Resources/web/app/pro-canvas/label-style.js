export const NODE_FONT_FAMILIES = [
    { value: "default", en: "Math (default)", ja: "数式（既定）" },
    { value: "serif", en: "Serif", ja: "セリフ" },
    { value: "sans", en: "Sans", ja: "サンセリフ" },
    { value: "mono", en: "Mono", ja: "等幅" },
];
export const NODE_FONT_SIZES = [
    { value: "tiny", label: "Tiny" },
    { value: "scriptsize", label: "Script" },
    { value: "footnotesize", label: "Footnote" },
    { value: "small", label: "Small" },
    { value: "normal", label: "Normal" },
    { value: "large", label: "Large" },
    { value: "Large", label: "Larger" },
    { value: "huge", label: "Huge" },
];
export const NODE_FONT_SHAPES = [
    { value: "italic", en: "Italic", ja: "斜体" },
    { value: "upright", en: "Upright", ja: "立体" },
];
export const nodeFontShapeChoice = (shape) => shape === "upright" ? "upright" : "italic";
export const NODE_FONT_WEIGHTS = [
    { value: "normal", en: "Regular", ja: "標準" },
    { value: "bold", en: "Bold", ja: "太字" },
];
export const NODE_COMPASS_ANCHORS = [
    { value: "south west", en: "Bottom left", ja: "左下" },
    { value: "south", en: "Bottom", ja: "下" },
    { value: "south east", en: "Bottom right", ja: "右下" },
    { value: "west", en: "Left", ja: "左" },
    { value: "center", en: "Center", ja: "中央" },
    { value: "east", en: "Right", ja: "右" },
    { value: "north west", en: "Top left", ja: "左上" },
    { value: "north", en: "Top", ja: "上" },
    { value: "north east", en: "Top right", ja: "右上" },
];
/** TikZ が通常の node で公開している位置・ベースライン系アンカー一式。 */
export const NODE_ANCHORS = [
    ...NODE_COMPASS_ANCHORS,
    { value: "base west", en: "Baseline left", ja: "ベースライン左" },
    { value: "base", en: "Baseline center", ja: "ベースライン中央" },
    { value: "base east", en: "Baseline right", ja: "ベースライン右" },
    { value: "mid west", en: "Math axis left", ja: "数式軸左" },
    { value: "mid", en: "Math axis center", ja: "数式軸中央" },
    { value: "mid east", en: "Math axis right", ja: "数式軸右" },
    { value: "text west", en: "Text origin left", ja: "文字原点左" },
    { value: "text", en: "Text origin center", ja: "文字原点中央" },
    { value: "text east", en: "Text origin right", ja: "文字原点右" },
];
/** 数式ツールの新規配置だけは、図形全体の吸着設定と独立して非吸着から始める。 */
export const NODE_PLACEMENT_SNAP_DEFAULT = false;
const FAMILY_COMMAND = {
    default: "", serif: "\\rmfamily", sans: "\\sffamily", mono: "\\ttfamily",
};
const SIZE_COMMAND = {
    tiny: "\\tiny", scriptsize: "\\scriptsize", footnotesize: "\\footnotesize", small: "\\small",
    normal: "", large: "\\large", Large: "\\Large", huge: "\\huge",
};
export const nodeFontOption = (family = "default", size = "normal", shape = "auto", weight = "normal", monospace) => {
    const effectiveFamily = monospace === true ? "mono" : monospace === false && family === "mono" ? "default" : family;
    const shapeCommand = shape === "italic" ? "\\itshape" : shape === "upright" ? "\\upshape" : "";
    const weightCommand = weight === "bold" ? "\\bfseries\\boldmath" : "";
    const commands = `${FAMILY_COMMAND[effectiveFamily]}${shapeCommand}${weightCommand}${SIZE_COMMAND[size]}`;
    return commands ? `font={${commands}}` : null;
};
export const nodeFontContent = (latex, shape = "auto", monospace = false, family = "default") => {
    // Use the same standard LaTeX math alphabets that the canvas preview uses.
    // Font-family declarations such as \sffamily do not, by themselves, change
    // letters already inside math mode; the alphabet command must wrap the math.
    const command = monospace
        ? "\\mathtt"
        : family === "sans"
            ? "\\mathsf"
            : shape === "italic"
                ? "\\mathit"
                : shape === "upright"
                    ? "\\mathrm"
                    : "";
    let delimited = false;
    const converted = latex
        .replace(/(^|[^\\])\$([^$]*)\$/g, (_match, prefix, body) => { delimited = true; return `${prefix}$${command ? `${command}{${body}}` : body}$`; })
        .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body) => { delimited = true; return `\\(${command ? `${command}{${body}}` : body}\\)`; });
    if (delimited)
        return converted;
    return `$${command ? `${command}{${latex}}` : latex}$`;
};
const unwrapMathDelimiters = (latex) => {
    const value = latex.trim();
    if (value.startsWith("$") && value.endsWith("$") && !value.startsWith("$$") && value.length >= 2)
        return value.slice(1, -1);
    if (value.startsWith("\\(") && value.endsWith("\\)") && value.length >= 4)
        return value.slice(2, -2);
    return value;
};
/**
 * KaTeX へ渡す表示専用の式。TikZ の font/content と同じ選択を、実際の数式字形へ落とす。
 * 保存している LaTeX 自体は変更しない。
 */
export const nodePreviewExpression = (latex, family = "default", shape = "auto", weight = "normal", monospace) => {
    let expression = unwrapMathDelimiters(latex) || "\\phantom{x}";
    const mono = monospace === true || monospace === undefined && family === "mono";
    if (mono)
        expression = `\\mathtt{${expression}}`;
    else if (family === "sans")
        expression = `\\mathsf{${expression}}`;
    else if (shape === "upright")
        expression = `\\mathrm{${expression}}`;
    else if (shape === "italic")
        expression = `\\mathit{${expression}}`;
    if (weight === "bold")
        expression = `\\boldsymbol{${expression}}`;
    return expression;
};
export const nodeMiniMenuVisible = (tool, selectionCount, object, _editingNodeId, dragging) => (tool === "select" || tool === "node") && selectionCount === 1 && (object === null || object === void 0 ? void 0 : object.type) === "node" && !dragging;
export const nodeFontPreviewStyle = (family = "default", shape = "auto", weight = "normal", monospace) => {
    const mono = monospace === true || monospace === undefined && family === "mono";
    const mathItalic = !mono && shape === "auto" && (family === "default" || family === "serif");
    const fontFamily = mono
        ? "KaTeX_Typewriter, monospace"
        : family === "sans"
            ? "KaTeX_SansSerif, sans-serif"
            : mathItalic
                ? "KaTeX_Math, serif"
                : "KaTeX_Main, serif";
    const fontStyle = mono ? "normal" : shape === "italic" || mathItalic ? "italic" : "normal";
    return { fontFamily, fontStyle, fontWeight: weight === "bold" ? "700" : "400" };
};
export const nodeFontCssFamily = (family = "default", monospace, shape = "auto") => nodeFontPreviewStyle(family, shape, "normal", monospace).fontFamily;
export const nodeToolEditsExisting = (object) => (object === null || object === void 0 ? void 0 : object.type) === "node";
export const nodeSelectionOutlineVisible = (object, editingNodeId) => object.type !== "node" || object.id !== editingNodeId;
export const nodeEditCommitAction = (isNew, original, next, commit) => {
    if (!commit)
        return isNew ? "restore" : "noop";
    if (!next.trim())
        return isNew ? "restore" : "delete";
    return next === original ? "noop" : "update";
};
export const nodeFontScale = (size = "normal") => ({
    tiny: 0.6, scriptsize: 0.7, footnotesize: 0.8, small: 0.9,
    normal: 1, large: 1.2, Large: 1.44, huge: 2.07,
})[size];
const nodeVisualLength = (latex) => Array.from(latex).reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 1.7 : 1), 0);
/** SVG ラベル、選択枠、透明ヒット領域で共有する見た目上のボックス。 */
export const nodeLabelBoundsFromSize = (node, width, height) => {
    const east = node.anchor.includes("east"), west = node.anchor.includes("west");
    const north = node.anchor.includes("north"), south = node.anchor.includes("south");
    const minX = east ? node.at.x - width : west ? node.at.x : node.at.x - width / 2;
    const maxX = east ? node.at.x : west ? node.at.x + width : node.at.x + width / 2;
    const baseline = node.anchor.startsWith("base") || node.anchor.startsWith("text");
    const midline = node.anchor.startsWith("mid");
    const minY = north ? node.at.y - height : south ? node.at.y : baseline ? node.at.y - height * .22 : midline ? node.at.y - height * .45 : node.at.y - height / 2;
    const maxY = north ? node.at.y : south ? node.at.y + height : baseline ? node.at.y + height * .78 : midline ? node.at.y + height * .55 : node.at.y + height / 2;
    return { minX, minY, maxX, maxY };
};
/** DOM 実測前の初回描画用フォールバック。接続後は KaTeX の実寸へ置き換える。 */
export const nodeLabelBounds = (node) => {
    const scale = nodeFontScale(node.fontSize), width = Math.max(4, nodeVisualLength(node.latex) * 2.5) * scale, height = 5.2 * scale;
    return nodeLabelBoundsFromSize(node, width, height);
};
export const nodeEditorWidthPx = (latex) => {
    const visualLength = nodeVisualLength(latex);
    return Math.round(Math.max(26, Math.min(220, 18 + visualLength * 8)));
};
