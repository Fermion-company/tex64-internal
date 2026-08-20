let stableHoverAnchor = null;
const STABLE_HOVER_ANCHOR_TTL_MS = 12000;
export const rememberStableHoverAnchor = (payload) => {
    var _a;
    const startColumn = Math.max(1, payload.startIndex + 1);
    const endColumn = Math.max(startColumn, payload.endIndex + 1);
    const startLineNumber = Math.max(1, Math.floor(payload.startLineNumber));
    const normalizedEndLine = Number.isFinite(payload.endLineNumber)
        ? Math.max(startLineNumber, Math.floor((_a = payload.endLineNumber) !== null && _a !== void 0 ? _a : startLineNumber))
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
const getStableHoverAnchor = (payload) => {
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
export const shouldKeepStableHover = (payload) => {
    return Boolean(getStableHoverAnchor(payload));
};
export const getStableHoverTokenKey = (payload) => {
    var _a, _b;
    return (_b = (_a = getStableHoverAnchor(payload)) === null || _a === void 0 ? void 0 : _a.tokenKey) !== null && _b !== void 0 ? _b : null;
};
