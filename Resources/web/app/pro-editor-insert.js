export const ensureTrailingNewline = (text) => text.endsWith("\n") ? text : `${text}\n`;
export const insertAtEditorCursor = (editor, text, source = "pro-stash") => {
    var _a, _b, _c, _d, _e;
    const position = (_a = editor === null || editor === void 0 ? void 0 : editor.getPosition) === null || _a === void 0 ? void 0 : _a.call(editor);
    const Range = (_b = window.monaco) === null || _b === void 0 ? void 0 : _b.Range;
    if (!(editor === null || editor === void 0 ? void 0 : editor.executeEdits) || !position || !Range)
        throw new Error("No active text editor is available.");
    (_c = editor.pushUndoStop) === null || _c === void 0 ? void 0 : _c.call(editor);
    editor.executeEdits(source, [{
            range: new Range(position.lineNumber, position.column, position.lineNumber, position.column),
            text: ensureTrailingNewline(text),
            forceMoveMarkers: true,
        }]);
    (_d = editor.pushUndoStop) === null || _d === void 0 ? void 0 : _d.call(editor);
    (_e = editor.focus) === null || _e === void 0 ? void 0 : _e.call(editor);
};
