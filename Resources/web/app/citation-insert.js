// Inserts a citation into the editor. Shared by the arXiv search and Zotero
// dialogs: \cite{key} at the cursor, or ",key" appended when the cursor is
// already inside a \cite-like argument.
const CITE_COMMANDS = /\\(?:[cC]ite(?:p|t|author|year|yearpar|alp|alt|num|title)?|parencite|textcite|autocite|footcite|footfullcite|fullcite|smartcite|supercite|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]*)\}/g;
/** The \cite-like argument whose braces contain `column` (1-based), if any. */
export const findCiteArgumentAt = (lineText, column) => {
    CITE_COMMANDS.lastIndex = 0;
    for (let match = CITE_COMMANDS.exec(lineText); match; match = CITE_COMMANDS.exec(lineText)) {
        const open = match.index + match[0].lastIndexOf("{");
        const close = match.index + match[0].length - 1;
        const start = open + 2;
        const end = close + 1;
        // Inside the braces, or immediately after the closing brace (where the
        // caret lands after an earlier insertion).
        if (column >= start && column <= end + 1) {
            CITE_COMMANDS.lastIndex = 0;
            return { start, end, keys: match[1].split(",").map((key) => key.trim()).filter(Boolean) };
        }
    }
    return null;
};
/**
 * Insert `\cite{key}` at the caret (after the selection when there is one).
 * Inside an existing \cite{…} the key is appended instead.
 */
export const insertCitation = (editor, key) => {
    var _a, _b, _c, _d, _e, _f;
    const model = (_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor);
    if (!model || ((_b = model.isDisposed) === null || _b === void 0 ? void 0 : _b.call(model)) || !editor.executeEdits)
        return "unavailable";
    const selection = (_c = editor.getSelection) === null || _c === void 0 ? void 0 : _c.call(editor);
    const position = selection && selection.isEmpty && !selection.isEmpty() && selection.getEndPosition
        ? selection.getEndPosition()
        : (_d = editor.getPosition) === null || _d === void 0 ? void 0 : _d.call(editor);
    if (!position)
        return "unavailable";
    const lineText = model.getLineContent(position.lineNumber);
    const inside = findCiteArgumentAt(lineText, position.column);
    if (inside) {
        if (inside.keys.includes(key))
            return "present";
        const range = {
            startLineNumber: position.lineNumber,
            startColumn: inside.end,
            endLineNumber: position.lineNumber,
            endColumn: inside.end,
        };
        const text = inside.keys.length ? `,${key}` : key;
        editor.executeEdits("tex64.cite", [{ range, text }]);
        (_e = editor.setPosition) === null || _e === void 0 ? void 0 : _e.call(editor, { lineNumber: position.lineNumber, column: inside.end + text.length + 1 });
        return "appended";
    }
    const before = lineText.slice(0, position.column - 1);
    // A tie keeps the citation on the line of the word it follows.
    const prefix = /[A-Za-z0-9)\]]$/.test(before) ? "~" : "";
    const text = `${prefix}\\cite{${key}}`;
    const range = {
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
    };
    editor.executeEdits("tex64.cite", [{ range, text }]);
    (_f = editor.setPosition) === null || _f === void 0 ? void 0 : _f.call(editor, { lineNumber: position.lineNumber, column: position.column + text.length });
    return "inserted";
};
