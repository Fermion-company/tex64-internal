import type { NodeFontFamily, NodeFontSize } from "./scene.js";

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

const FAMILY_COMMAND: Record<NodeFontFamily, string> = {
  default: "", serif: "\\rmfamily", sans: "\\sffamily", mono: "\\ttfamily",
};
const SIZE_COMMAND: Record<NodeFontSize, string> = {
  tiny: "\\tiny", scriptsize: "\\scriptsize", footnotesize: "\\footnotesize", small: "\\small",
  normal: "", large: "\\large", Large: "\\Large", huge: "\\huge",
};

export const nodeFontOption = (family: NodeFontFamily = "default", size: NodeFontSize = "normal"): string | null => {
  const commands = `${FAMILY_COMMAND[family]}${SIZE_COMMAND[size]}`;
  return commands ? `font={${commands}}` : null;
};

export const nodeFontCssFamily = (family: NodeFontFamily = "default"): string => {
  if (family === "serif") return "Georgia, 'Times New Roman', serif";
  if (family === "sans") return "Arial, Helvetica, sans-serif";
  if (family === "mono") return "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  return "KaTeX_Math, 'STIX Two Math', 'Cambria Math', serif";
};

export const nodeFontScale = (size: NodeFontSize = "normal"): number => ({
  tiny: 0.6, scriptsize: 0.7, footnotesize: 0.8, small: 0.9,
  normal: 1, large: 1.2, Large: 1.44, huge: 2.07,
})[size];

export const nodeEditorWidthPx = (latex: string): number => {
  const visualLength = Array.from(latex).reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 1.7 : 1), 0);
  return Math.round(Math.max(44, Math.min(220, 22 + visualLength * 8)));
};
