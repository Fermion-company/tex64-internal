// Insert a citation key where the cursor is. Shared by the Zotero and arXiv
// flows: a new `\cite{key}` at the cursor, or `,key` appended when the cursor
// already sits inside the argument of a \cite-family command.
const CITE_COMMAND = /\\(?:[cC]ite(?:p|t|author|year|yearpar|alp|alt|num|title)?|parencite|textcite|autocite|footcite|footfullcite|fullcite|smartcite|supercite|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{$/;
/**
 * When `column` (1-based) lies inside the `{…}` argument of a \cite command on
 * `line`, the argument's bounds (1-based columns of the text between braces).
 */
export const findCiteArgumentAt = (line, column) => {
    const offset = column - 1;
    const before = line.slice(0, offset);
    const open = before.lastIndexOf("{");
    if (open < 0 || before.indexOf("}", open) >= 0)
        return null;
    if (!CITE_COMMAND.test(before.slice(0, open + 1)))
        return null;
    const close = line.indexOf("}", offset);
    if (close < 0)
        return null;
    const inside = line.slice(open + 1, close);
    return { start: open + 2, end: close + 1, keys: inside.split(",").map((key) => key.trim()).filter(Boolean) };
};
/** Insert `key` as a citation. Returns the text that was inserted, or null. */
export const insertCitation = (editor, key, source = "citation-insert") => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const model = (_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor);
    const position = (_b = editor === null || editor === void 0 ? void 0 : editor.getPosition) === null || _b === void 0 ? void 0 : _b.call(editor);
    const Range = (_c = window.monaco) === null || _c === void 0 ? void 0 : _c.Range;
    if (!(editor === null || editor === void 0 ? void 0 : editor.executeEdits) || !model || ((_d = model.isDisposed) === null || _d === void 0 ? void 0 : _d.call(model)) || !position || !Range)
        return null;
    if ((_f = (_e = editor.getRawOptions) === null || _e === void 0 ? void 0 : _e.call(editor)) === null || _f === void 0 ? void 0 : _f.readOnly)
        return null;
    const clean = key.trim();
    if (!clean)
        return null;
    const selection = (_g = editor.getSelection) === null || _g === void 0 ? void 0 : _g.call(editor);
    const hasSelection = selection && !(selection.isEmpty ? selection.isEmpty() : selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn);
    const line = model.getLineContent(position.lineNumber);
    const argument = hasSelection ? null : findCiteArgumentAt(line, position.column);
    let range;
    let text;
    if (argument) {
        if (argument.keys.includes(clean))
            return "";
        const column = argument.end;
        const trimmed = line.slice(argument.start - 1, argument.end - 1).trim();
        text = trimmed ? (trimmed.endsWith(",") ? clean : `,${clean}`) : clean;
        range = new Range(position.lineNumber, column, position.lineNumber, column);
    }
    else if (hasSelection && selection) {
        text = `\\cite{${clean}}`;
        range = new Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn);
    }
    else {
        text = `\\cite{${clean}}`;
        range = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
    }
    (_h = editor.pushUndoStop) === null || _h === void 0 ? void 0 : _h.call(editor);
    editor.executeEdits(source, [{ range, text, forceMoveMarkers: true }]);
    (_j = editor.pushUndoStop) === null || _j === void 0 ? void 0 : _j.call(editor);
    (_k = editor.focus) === null || _k === void 0 ? void 0 : _k.call(editor);
    return text;
};
