export const createEditorSessionCursorOps = (runtime) => {
    const getStoredCursorPosition = (path) => { var _a; return (_a = runtime.lastCursorPositions.get(path)) !== null && _a !== void 0 ? _a : null; };
    const recordCursorPosition = (path, position) => {
        runtime.lastCursorPositions.set(path, {
            line: position.lineNumber,
            column: position.column,
        });
    };
    return { getStoredCursorPosition, recordCursorPosition };
};
