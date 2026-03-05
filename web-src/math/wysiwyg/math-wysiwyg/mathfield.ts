import { resolveScopeRange } from "../math-wysiwyg-selection.js";
import { getMathfieldModeAtOffset, setMathfieldMode } from "../../mathfield-private-adapter.js";
import type { MathWysiwygRuntime } from "./runtime.js";

export const readMathfieldLatex = (
  mathfieldApi: any,
  ...args: [number, number, "latex"] | ["latex"]
): string | null => {
  if (typeof mathfieldApi?.getValue !== "function") {
    return null;
  }
  try {
    const value = mathfieldApi.getValue(...args);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

export const resolveCursorOffset = (
  mathfieldApi: any,
  selection: { start: number; end: number }
) => {
  const start = Number(selection.start);
  const end = Number(selection.end);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    return Math.max(0, Math.max(start, end));
  }
  if (Number.isFinite(end)) {
    return Math.max(0, end);
  }
  if (Number.isFinite(start)) {
    return Math.max(0, start);
  }
  const position = Number(mathfieldApi?.position);
  if (Number.isFinite(position)) {
    return Math.max(0, position);
  }
  return 0;
};

export const nowMs = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

export const clearEditAnchor = (runtime: MathWysiwygRuntime) => {
  runtime.editAnchorOffset = null;
};

export const resolveAnalysisRange = (
  runtime: MathWysiwygRuntime,
  mathfieldApi: any,
  cursorOffset: number
): { start: number; end: number } => {
  const scopeRange = resolveScopeRange(mathfieldApi, cursorOffset);
  if (runtime.editAnchorOffset === null) {
    return scopeRange;
  }
  if (!Number.isFinite(runtime.editAnchorOffset)) {
    clearEditAnchor(runtime);
    return scopeRange;
  }
  const anchor = Math.max(scopeRange.start, Math.min(scopeRange.end, runtime.editAnchorOffset));
  if (cursorOffset < anchor) {
    clearEditAnchor(runtime);
    return scopeRange;
  }
  // One-way input model: analyze only the active edit buffer.
  // Keep delimiter-only lookbehind (`//`, `\\`) to preserve command triggers
  // when the anchor was moved to just after the delimiter.
  let start = anchor;
  if (anchor > scopeRange.start) {
    const lookbehindStart = Math.max(scopeRange.start, anchor - 2);
    const lookbehind = readMathfieldLatex(mathfieldApi, lookbehindStart, anchor, "latex") ?? "";
    if (lookbehind.endsWith("//")) {
      start = Math.max(scopeRange.start, anchor - 2);
    } else if (lookbehind.endsWith("\\")) {
      start = Math.max(scopeRange.start, anchor - 1);
    }
  }
  return { start, end: scopeRange.end };
};

const getModeAtOffset = (mathfieldApi: any, offset: number): "math" | "text" | "latex" | null => {
  if (offset < 0) {
    return null;
  }
  if (typeof mathfieldApi?.getElementInfo === "function") {
    try {
      const info = mathfieldApi.getElementInfo(offset);
      const mode = info?.mode ?? null;
      if (mode === "math" || mode === "text" || mode === "latex") {
        return mode;
      }
    } catch {
      // ignore
    }
  }
  return getMathfieldModeAtOffset(mathfieldApi, offset);
};

export const syncMathfieldMode = (
  runtime: MathWysiwygRuntime,
  mathfieldApi: any,
  cursorOffset: number
) => {
  const currentMode =
    typeof mathfieldApi?.mode === "string"
      ? (mathfieldApi.mode as "math" | "text" | "latex")
      : null;
  if (!currentMode || currentMode === "latex") {
    runtime.forcedTextMode = false;
    return;
  }

  // If the user changed modes manually while we were forcing, stop managing it.
  if (runtime.forcedTextMode && currentMode !== "text") {
    runtime.forcedTextMode = false;
  }

  const modeAtCursor =
    getModeAtOffset(mathfieldApi, cursorOffset) ?? getModeAtOffset(mathfieldApi, cursorOffset - 1);
  const wantsText = modeAtCursor === "text";

  const setMode = (nextMode: "math" | "text") => setMathfieldMode(mathfieldApi, nextMode);

  if (wantsText) {
    if (currentMode !== "text") {
      if (setMode("text")) {
        runtime.forcedTextMode = true;
      }
    }
    return;
  }

  if (runtime.forcedTextMode && currentMode === "text") {
    if (nowMs() < runtime.holdTextModeUntil) {
      return;
    }
    setMode("math");
    runtime.forcedTextMode = false;
  }
};

