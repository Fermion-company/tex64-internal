import { createLatexBlockDetector } from "../blocks/detect.js";
import { getHoverLine } from "./utils.js";
const getModelLineCount = (model, fallback) => {
    var _a;
    const count = (_a = model.getLineCount) === null || _a === void 0 ? void 0 : _a.call(model);
    if (!Number.isFinite(count)) {
        return fallback;
    }
    return Math.max(fallback, Math.floor(count !== null && count !== void 0 ? count : fallback));
};
const buildMathScanWindow = (model, centerLineNumber, options) => {
    var _a, _b;
    const lineCount = getModelLineCount(model, centerLineNumber);
    const radius = Number.isFinite(options === null || options === void 0 ? void 0 : options.radius) ? Math.max(20, Math.floor((_a = options === null || options === void 0 ? void 0 : options.radius) !== null && _a !== void 0 ? _a : 0)) : 320;
    const startLineNumber = Math.max(1, centerLineNumber - radius);
    const endLineNumber = Math.min(lineCount, centerLineNumber + radius);
    const lines = [];
    const lineOffsets = [];
    let text = "";
    for (let line = startLineNumber; line <= endLineNumber; line += 1) {
        lineOffsets.push(text.length);
        const content = getHoverLine((_b = model.getLineContent(line)) !== null && _b !== void 0 ? _b : "");
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
const offsetToLineIndex = (window, absoluteOffset) => {
    var _a, _b;
    const clamped = Math.max(0, Math.min(window.text.length, absoluteOffset));
    let lineIndex = 0;
    while (lineIndex + 1 < window.lineOffsets.length &&
        window.lineOffsets[lineIndex + 1] <= clamped) {
        lineIndex += 1;
    }
    const lineStart = (_a = window.lineOffsets[lineIndex]) !== null && _a !== void 0 ? _a : 0;
    const lineText = (_b = window.lines[lineIndex]) !== null && _b !== void 0 ? _b : "";
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
export const findMathAt = (model, position, cursorIndex) => {
    const window = buildMathScanWindow(model, position.lineNumber);
    const offset = window.lineOffsets[position.lineNumber - window.startLineNumber] + cursorIndex;
    const block = detector.detectLatexBlockAtOffset(window.text, offset);
    if (!block)
        return null;
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
