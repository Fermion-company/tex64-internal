import type { StableHoverAnchor } from "./types.js";

let stableHoverAnchor: StableHoverAnchor | null = null;
const STABLE_HOVER_ANCHOR_TTL_MS = 12000;

export const rememberStableHoverAnchor = (payload: {
  filePath: string;
  startLineNumber: number;
  endLineNumber?: number;
  startIndex: number;
  endIndex: number;
  tokenKey: string;
}) => {
  const startColumn = Math.max(1, payload.startIndex + 1);
  const endColumn = Math.max(startColumn, payload.endIndex + 1);
  const startLineNumber = Math.max(1, Math.floor(payload.startLineNumber));
  const normalizedEndLine = Number.isFinite(payload.endLineNumber)
    ? Math.max(startLineNumber, Math.floor(payload.endLineNumber ?? startLineNumber))
    : startLineNumber;
  stableHoverAnchor = {
    filePath: payload.filePath,
    startLineNumber,
    endLineNumber: normalizedEndLine,
    startColumn,
    endColumn,
    tokenKey: payload.tokenKey,
    updatedAt: Date.now(),
  };
};

const getStableHoverAnchor = (payload: { filePath: string; lineNumber: number; column: number }) => {
  const anchor = stableHoverAnchor;
  if (!anchor) {
    return null;
  }
  if (anchor.filePath !== payload.filePath) {
    return null;
  }
  if (payload.lineNumber < anchor.startLineNumber || payload.lineNumber > anchor.endLineNumber) {
    return null;
  }
  if (Date.now() - anchor.updatedAt > STABLE_HOVER_ANCHOR_TTL_MS) {
    return null;
  }
  const column = Math.max(1, payload.column);
  if (anchor.startLineNumber === anchor.endLineNumber) {
    return column >= anchor.startColumn && column <= anchor.endColumn ? anchor : null;
  }
  if (payload.lineNumber === anchor.startLineNumber) {
    return column >= anchor.startColumn ? anchor : null;
  }
  if (payload.lineNumber === anchor.endLineNumber) {
    return column <= anchor.endColumn ? anchor : null;
  }
  return anchor;
};

export const shouldKeepStableHover = (payload: { filePath: string; lineNumber: number; column: number }) => {
  return Boolean(getStableHoverAnchor(payload));
};

export const getStableHoverTokenKey = (payload: { filePath: string; lineNumber: number; column: number }) => {
  return getStableHoverAnchor(payload)?.tokenKey ?? null;
};

