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
export const nodeFontContent = (latex, shape = "auto", monospace = false) => {
    const command = monospace ? "\\mathtt" : shape === "italic" ? "\\mathit" : shape === "upright" ? "\\mathrm" : "";
    let delimited = false;
    const converted = latex
        .replace(/(^|[^\\])\$([^$]*)\$/g, (_match, prefix, body) => { delimited = true; return `${prefix}$${command ? `${command}{${body}}` : body}$`; })
        .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body) => { delimited = true; return `\\(${command ? `${command}{${body}}` : body}\\)`; });
    if (delimited)
        return converted;
    return `$${command ? `${command}{${latex}}` : latex}$`;
};
export const nodeFontPreviewStyle = (family = "default", shape = "auto", weight = "normal", monospace) => {
    const mono = monospace === true || monospace === undefined && family === "mono";
    const fontFamily = mono
        ? "KaTeX_Typewriter, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        : family === "serif"
            ? "Georgia, 'Times New Roman', serif"
            : family === "sans"
                ? "KaTeX_SansSerif, Arial, Helvetica, sans-serif"
                : shape === "auto"
                    ? "KaTeX_Math, 'STIX Two Math', 'Cambria Math', serif"
                    : "KaTeX_Main, 'STIX Two Math', 'Cambria Math', serif";
    const fontStyle = mono ? "normal" : shape === "italic" || shape === "auto" && family === "default" ? "italic" : "normal";
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
export const nodeLabelBounds = (node) => {
    const scale = nodeFontScale(node.fontSize), width = Math.max(4, nodeVisualLength(node.latex) * 2.5) * scale, height = 5.2 * scale;
    const east = node.anchor.includes("east"), west = node.anchor.includes("west");
    const north = node.anchor.includes("north"), south = node.anchor.includes("south");
    const minX = east ? node.at.x - width : west ? node.at.x : node.at.x - width / 2;
    const maxX = east ? node.at.x : west ? node.at.x + width : node.at.x + width / 2;
    const minY = north ? node.at.y - height : south ? node.at.y : node.at.y - height / 2;
    const maxY = north ? node.at.y : south ? node.at.y + height : node.at.y + height / 2;
    return { minX, minY, maxX, maxY };
};
export const nodeEditorWidthPx = (latex) => {
    const visualLength = nodeVisualLength(latex);
    return Math.round(Math.max(26, Math.min(220, 18 + visualLength * 8)));
};
