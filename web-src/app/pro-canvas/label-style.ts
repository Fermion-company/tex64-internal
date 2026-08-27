import type { NodeAnchor, NodeFontFamily, NodeFontShape, NodeFontSize, NodeFontWeight, SceneObject, Vec } from "./scene.js";

export const NODE_FONT_FAMILIES: ReadonlyArray<{ value: NodeFontFamily; en: string; ja: string }> = [
  { value: "default", en: "Math (default)", ja: "数式（既定）" },
  { value: "serif", en: "Serif", ja: "セリフ" },
  { value: "sans", en: "Sans", ja: "サンセリフ" },
  { value: "mono", en: "Mono", ja: "等幅" },
];

export const NODE_FONT_SIZES: ReadonlyArray<{ value: NodeFontSize; label: string }> = [
  { value: "tiny", label: "Tiny" },
  { value: "scriptsize", label: "Script" },
  { value: "footnotesize", label: "Footnote" },
  { value: "small", label: "Small" },
  { value: "normal", label: "Normal" },
  { value: "large", label: "Large" },
  { value: "Large", label: "Larger" },
  { value: "huge", label: "Huge" },
];

export const NODE_FONT_SHAPES: ReadonlyArray<{ value: NodeFontShape; en: string; ja: string }> = [
  { value: "italic", en: "Italic", ja: "斜体" },
  { value: "upright", en: "Upright", ja: "立体" },
];

export const nodeFontShapeChoice = (shape?: NodeFontShape): Exclude<NodeFontShape, "auto"> =>
  shape === "upright" ? "upright" : "italic";

export const NODE_FONT_WEIGHTS: ReadonlyArray<{ value: NodeFontWeight; en: string; ja: string }> = [
  { value: "normal", en: "Regular", ja: "標準" },
  { value: "bold", en: "Bold", ja: "太字" },
];

const FAMILY_COMMAND: Record<NodeFontFamily, string> = {
  default: "", serif: "\\rmfamily", sans: "\\sffamily", mono: "\\ttfamily",
};
const SIZE_COMMAND: Record<NodeFontSize, string> = {
  tiny: "\\tiny", scriptsize: "\\scriptsize", footnotesize: "\\footnotesize", small: "\\small",
  normal: "", large: "\\large", Large: "\\Large", huge: "\\huge",
};

export const nodeFontOption = (
  family: NodeFontFamily = "default",
  size: NodeFontSize = "normal",
  shape: NodeFontShape = "auto",
  weight: NodeFontWeight = "normal",
  monospace?: boolean,
): string | null => {
  const effectiveFamily = monospace === true ? "mono" : monospace === false && family === "mono" ? "default" : family;
  const shapeCommand = shape === "italic" ? "\\itshape" : shape === "upright" ? "\\upshape" : "";
  const weightCommand = weight === "bold" ? "\\bfseries\\boldmath" : "";
  const commands = `${FAMILY_COMMAND[effectiveFamily]}${shapeCommand}${weightCommand}${SIZE_COMMAND[size]}`;
  return commands ? `font={${commands}}` : null;
};

export const nodeFontContent = (latex: string, shape: NodeFontShape = "auto", monospace = false): string => {
  const command = monospace ? "\\mathtt" : shape === "italic" ? "\\mathit" : shape === "upright" ? "\\mathrm" : "";
  let delimited = false;
  const converted = latex
    .replace(/(^|[^\\])\$([^$]*)\$/g, (_match, prefix: string, body: string) => { delimited = true; return `${prefix}$${command ? `${command}{${body}}` : body}$`; })
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => { delimited = true; return `\\(${command ? `${command}{${body}}` : body}\\)`; });
  if (delimited) return converted;
  return `$${command ? `${command}{${latex}}` : latex}$`;
};

export type NodeFontPreviewStyle = { fontFamily: string; fontStyle: "italic" | "normal"; fontWeight: "400" | "700" };

export const nodeFontPreviewStyle = (
  family: NodeFontFamily = "default",
  shape: NodeFontShape = "auto",
  weight: NodeFontWeight = "normal",
  monospace?: boolean,
): NodeFontPreviewStyle => {
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

export const nodeFontCssFamily = (family: NodeFontFamily = "default", monospace?: boolean, shape: NodeFontShape = "auto"): string =>
  nodeFontPreviewStyle(family, shape, "normal", monospace).fontFamily;

export const nodeToolEditsExisting = (object: SceneObject | null | undefined): object is Extract<SceneObject, { type: "node" }> =>
  object?.type === "node";

export const nodeSelectionOutlineVisible = (object: SceneObject, editingNodeId: string | null): boolean =>
  object.type !== "node" || object.id !== editingNodeId;

export type NodeEditCommitAction = "noop" | "restore" | "delete" | "update";
export const nodeEditCommitAction = (isNew: boolean, original: string, next: string, commit: boolean): NodeEditCommitAction => {
  if (!commit) return isNew ? "restore" : "noop";
  if (!next.trim()) return isNew ? "restore" : "delete";
  return next === original ? "noop" : "update";
};

export const nodeFontScale = (size: NodeFontSize = "normal"): number => ({
  tiny: 0.6, scriptsize: 0.7, footnotesize: 0.8, small: 0.9,
  normal: 1, large: 1.2, Large: 1.44, huge: 2.07,
})[size];

export type NodeLabelBounds = { minX: number; minY: number; maxX: number; maxY: number };

const nodeVisualLength = (latex: string): number => Array.from(latex).reduce(
  (sum, char) => sum + (char.charCodeAt(0) > 255 ? 1.7 : 1), 0,
);

/** SVG ラベル、選択枠、透明ヒット領域で共有する見た目上のボックス。 */
export const nodeLabelBounds = (node: {
  at: Vec; latex: string; anchor: NodeAnchor; fontSize?: NodeFontSize;
}): NodeLabelBounds => {
  const scale = nodeFontScale(node.fontSize), width = Math.max(4, nodeVisualLength(node.latex) * 2.5) * scale, height = 5.2 * scale;
  const east = node.anchor.includes("east"), west = node.anchor.includes("west");
  const north = node.anchor.includes("north"), south = node.anchor.includes("south");
  const minX = east ? node.at.x - width : west ? node.at.x : node.at.x - width / 2;
  const maxX = east ? node.at.x : west ? node.at.x + width : node.at.x + width / 2;
  const minY = north ? node.at.y - height : south ? node.at.y : node.at.y - height / 2;
  const maxY = north ? node.at.y : south ? node.at.y + height : node.at.y + height / 2;
  return { minX, minY, maxX, maxY };
};

export const nodeEditorWidthPx = (latex: string): number => {
  const visualLength = nodeVisualLength(latex);
  return Math.round(Math.max(26, Math.min(220, 18 + visualLength * 8)));
};
