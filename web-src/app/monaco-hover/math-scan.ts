import { createLatexBlockDetector } from "../blocks/detect.js";
import { getHoverLine } from "./utils.js";

type MathMatchResult = {
  latex: string;
  startLineNumber: number;
  endLineNumber: number;
  startIndex: number;
  endIndex: number;
};

const getModelLineCount = (model: { getLineCount?: () => number }, fallback: number) => {
  const count = model.getLineCount?.();
  if (!Number.isFinite(count)) {
    return fallback;
  }
  return Math.max(fallback, Math.floor(count ?? fallback));
};

type MathScanWindow = {
  startLineNumber: number;
  endLineNumber: number;
  lines: string[];
  lineOffsets: number[];
  text: string;
};

const buildMathScanWindow = (
  model: { getLineContent: (lineNumber: number) => string; getLineCount?: () => number },
  centerLineNumber: number,
  options?: { radius?: number }
): MathScanWindow => {
  const lineCount = getModelLineCount(model, centerLineNumber);
  const radius = Number.isFinite(options?.radius) ? Math.max(20, Math.floor(options?.radius ?? 0)) : 320;
  const startLineNumber = Math.max(1, centerLineNumber - radius);
  const endLineNumber = Math.min(lineCount, centerLineNumber + radius);
  const lines: string[] = [];
  const lineOffsets: number[] = [];
  let text = "";
  for (let line = startLineNumber; line <= endLineNumber; line += 1) {
    lineOffsets.push(text.length);
    const content = getHoverLine(model.getLineContent(line) ?? "");
    lines.push(content);
    text += content;
    if (line < endLineNumber) {
      text += "\n";
    }
  }
  return {
    startLineNumber,
    endLineNumber,
    lines,
    lineOffsets,
    text,
  };
};

const offsetToLineIndex = (window: MathScanWindow, absoluteOffset: number) => {
  const clamped = Math.max(0, Math.min(window.text.length, absoluteOffset));
  let lineIndex = 0;
  while (
    lineIndex + 1 < window.lineOffsets.length &&
    window.lineOffsets[lineIndex + 1] <= clamped
  ) {
    lineIndex += 1;
  }
  const lineStart = window.lineOffsets[lineIndex] ?? 0;
  const lineText = window.lines[lineIndex] ?? "";
  const index = Math.max(0, Math.min(lineText.length, clamped - lineStart));
  return {
    lineNumber: window.startLineNumber + lineIndex,
    index,
  };
};

const mathEnvironments = new Set([
  "equation", "align", "alignat", "gather", "multline", "flalign", "eqnarray",
  "math", "displaymath", "split", "cases", "matrix", "pmatrix", "bmatrix",
  "vmatrix", "Vmatrix", "smallmatrix",
]);
const detector = createLatexBlockDetector({
  isEnvDisabled: (name) => !mathEnvironments.has(name),
  isMathEnvName: (name) => mathEnvironments.has(name),
});

export const findMathAt = (
  model: { getLineContent: (lineNumber: number) => string; getLineCount?: () => number },
  position: { lineNumber: number; column: number },
  cursorIndex: number
): MathMatchResult | null => {
  const window = buildMathScanWindow(model, position.lineNumber);
  const offset = window.lineOffsets[position.lineNumber - window.startLineNumber] + cursorIndex;
  const block = detector.detectLatexBlockAtOffset(window.text, offset);
  if (!block) return null;

  // Anchor inline hovers to their contents; display environments use their
  // full source range so the card stays open as the pointer crosses lines.
  const delimiterLength = block.inline ? (block.fullMatch.startsWith("$") ? 1 : 2) : 0;
  const start = offsetToLineIndex(window, block.start + delimiterLength);
  const end = offsetToLineIndex(window, block.end - delimiterLength);
  const latex = block.inline ? block.content : block.fullMatch;
  return latex ? {
    latex,
    startLineNumber: start.lineNumber,
    endLineNumber: end.lineNumber,
    startIndex: start.index,
    endIndex: end.index,
  } : null;
};
