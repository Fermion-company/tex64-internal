// LaTeX authoring ergonomics layered on a Monaco editor instance:
//   - Enter after a non-empty "\item" starts a new "\item " (an empty "\item"
//     is left untouched — Enter just inserts a normal newline)
//   - Typing "\begin{env}" inserts a matching "\end{env}" body
//   - TeX math delimiters "\[" / "\(" receive their TeX-aware closers
//   - Wrap-selection actions (\textbf, \textit, \emph, \texttt)
// Each behavior reads its flag from the editor settings store at call time, so
// toggling a feature on/off takes effect live without re-attaching.
import { editorSettings } from "./editor-settings/editor-settings-store.js";
import { uiText } from "./i18n.js";
const leadingWhitespace = (line) => (line.match(/^[ \t]*/) || [""])[0];
export const planTexDelimiterCompletion = (typed, before, after) => {
    let slashCount = 0;
    for (let index = before.length - 2; index >= 0 && before[index] === "\\"; index -= 1) {
        slashCount += 1;
    }
    // "\\[" is a math opener, whereas "\\\\[" is a line break followed by
    // an ordinary bracket. Only an unescaped TeX command slash starts a pair.
    if (slashCount % 2 === 0) {
        return null;
    }
    const pair = typed === "[" && before.endsWith("\\[")
        ? { plainClose: "]", text: "\\]" }
        : typed === "(" && before.endsWith("\\(")
            ? { plainClose: ")", text: "\\)" }
            : null;
    if (!pair) {
        return null;
    }
    if (after.startsWith(pair.text)) {
        return null;
    }
    const displayLine = typed === "[" ? before.match(/^([ \t]*)\\\[$/) : null;
    if (displayLine) {
        const indent = displayLine[1];
        return {
            text: `\n${indent}  \n${indent}\\]`,
            replaceLength: after.startsWith(pair.plainClose) ? 1 : 0,
            cursorLineDelta: 1,
            cursorColumn: indent.length + 3,
        };
    }
    // Monaco has already inserted its ordinary bracket closer in the common
    // path ("\\[]" / "\\()"). Replace it instead of adding a second closer.
    return {
        text: pair.text,
        replaceLength: after.startsWith(pair.plainClose) ? 1 : 0,
    };
};
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripTexComment = (line) => {
    for (let index = 0; index < line.length; index += 1) {
        if (line[index] !== "%") {
            continue;
        }
        let slashes = 0;
        for (let back = index - 1; back >= 0 && line[back] === "\\"; back -= 1) {
            slashes += 1;
        }
        if (slashes % 2 === 0) {
            return line.slice(0, index);
        }
    }
    return line;
};
// Counts "\begin{env}" and "\end{env}" outside comments. When the document
// already has as many ends as begins, a new "\begin{env}" is closed by an end
// the user wrote (or a completion added earlier), and adding one more would
// leave a stray "\end" that stops the build.
export const countEnvironmentPairs = (text, env) => {
    const name = escapeRegExp(env);
    const beginRe = new RegExp(`\\\\begin\\s*\\{${name}\\}`, "g");
    const endRe = new RegExp(`\\\\end\\s*\\{${name}\\}`, "g");
    let begins = 0;
    let ends = 0;
    for (const raw of text.split(/\r?\n/)) {
        const line = stripTexComment(raw);
        begins += (line.match(beginRe) || []).length;
        ends += (line.match(endRe) || []).length;
    }
    return { begins, ends };
};
// After the user finishes typing "\end{env}" by hand right above the end a
// completion inserted, the document holds one end too many. Returns the line
// number (1-based) of that following end line to remove, or null.
export const planDuplicateEndRemoval = (before, after, lines, lineNumber, documentText) => {
    if (after.trim() !== "") {
        return null;
    }
    const endMatch = before.match(/^[ \t]*\\end\{([^{}\r\n]+)\}$/);
    if (!endMatch) {
        return null;
    }
    const env = endMatch[1];
    const { begins, ends } = countEnvironmentPairs(documentText, env);
    if (ends <= begins) {
        return null;
    }
    for (let index = lineNumber; index < lines.length; index += 1) {
        const next = lines[index];
        if (next.trim() === "") {
            continue;
        }
        return next.trim() === `\\end{${env}}` ? index + 1 : null;
    }
    return null;
};
export const planEnvironmentCompletion = (before, after, documentText) => {
    if (after.trim() !== "") {
        return null;
    }
    const beginMatch = before.match(/^([ \t]*)\\begin\{([^{}\r\n]+)\}$/);
    if (!beginMatch) {
        return null;
    }
    const indent = beginMatch[1];
    const env = beginMatch[2];
    if (typeof documentText === "string") {
        const { begins, ends } = countEnvironmentPairs(documentText, env);
        if (ends >= begins) {
            return null;
        }
    }
    return {
        text: `\n${indent}  \n${indent}\\end{${env}}`,
        cursorColumn: indent.length + 3,
    };
};
export const attachEditorErgonomics = (monaco, editor, group) => {
    var _a, _b, _c;
    const KeyCode = monaco === null || monaco === void 0 ? void 0 : monaco.KeyCode;
    const KeyMod = monaco === null || monaco === void 0 ? void 0 : monaco.KeyMod;
    if (!editor || !KeyCode) {
        return;
    }
    (_a = editor.onDidType) === null || _a === void 0 ? void 0 : _a.call(editor, (typed) => {
        var _a, _b, _c;
        if (group === null || group === void 0 ? void 0 : group.isComposing) {
            return;
        }
        const model = (_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor);
        const pos = (_b = editor.getPosition) === null || _b === void 0 ? void 0 : _b.call(editor);
        if (!model || !pos) {
            return;
        }
        const line = model.getLineContent(pos.lineNumber);
        const before = line.slice(0, pos.column - 1);
        const after = line.slice(pos.column - 1);
        const delimiter = planTexDelimiterCompletion(typed, before, after);
        if (delimiter) {
            editor.executeEdits("ergo-tex-delimiter", [
                {
                    range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column + delimiter.replaceLength),
                    text: delimiter.text,
                },
            ]);
            // Keep the caret inside the generated pair. A standalone display opener
            // gets the same indented blank body line as an environment completion.
            editor.setPosition(delimiter.cursorLineDelta
                ? {
                    lineNumber: pos.lineNumber + delimiter.cursorLineDelta,
                    column: (_c = delimiter.cursorColumn) !== null && _c !== void 0 ? _c : pos.column,
                }
                : pos);
            return;
        }
        if (typed !== "}" || !editorSettings.isEnabled("ergo.autoCloseEnvironment")) {
            return;
        }
        const documentText = model.getValue();
        const duplicateEnd = planDuplicateEndRemoval(before, after, model.getLinesContent ? model.getLinesContent() : documentText.split(/\r?\n/), pos.lineNumber, documentText);
        if (duplicateEnd) {
            editor.executeEdits("ergo-env-dedupe", [
                {
                    range: new monaco.Range(pos.lineNumber, line.length + 1, duplicateEnd, model.getLineContent(duplicateEnd).length + 1),
                    text: "",
                },
            ]);
            editor.setPosition(pos);
            return;
        }
        const environment = planEnvironmentCompletion(before, after, documentText);
        if (!environment) {
            return;
        }
        editor.executeEdits("ergo-env", [
            {
                // Consume trailing whitespace on the begin line so it does not wind up
                // after the generated end line.
                range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, line.length + 1),
                text: environment.text,
            },
        ]);
        editor.setPosition({
            lineNumber: pos.lineNumber + 1,
            column: environment.cursorColumn,
        });
    });
    (_b = editor.onKeyDown) === null || _b === void 0 ? void 0 : _b.call(editor, (event) => {
        var _a, _b;
        if (event.keyCode !== KeyCode.Enter) {
            return;
        }
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }
        if (group === null || group === void 0 ? void 0 : group.isComposing) {
            return; // don't fight IME composition
        }
        const model = (_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor);
        const pos = (_b = editor.getPosition) === null || _b === void 0 ? void 0 : _b.call(editor);
        if (!model || !pos) {
            return;
        }
        const line = model.getLineContent(pos.lineNumber);
        const before = line.slice(0, pos.column - 1);
        const after = line.slice(pos.column - 1);
        if (after.trim() !== "") {
            return; // only act when the caret is at the end of the line's content
        }
        const indent = leadingWhitespace(line);
        // "\item" continuation. Only act on a NON-empty item; an empty "\item" is
        // left as-is and Enter falls through to a normal newline (never delete the
        // user's "\item").
        if (editorSettings.isEnabled("ergo.itemOnEnter")) {
            const itemMatch = before.match(/^[ \t]*\\item\b[ \t]?(.*)$/);
            if (itemMatch && itemMatch[1].trim() !== "") {
                event.preventDefault();
                event.stopPropagation();
                const insert = `\n${indent}\\item `;
                editor.executeEdits("ergo-item", [
                    { range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: insert },
                ]);
                editor.setPosition({ lineNumber: pos.lineNumber + 1, column: indent.length + 7 });
                return;
            }
        }
        // "\begin{env}" -> insert body + matching "\end{env}".
        if (editorSettings.isEnabled("ergo.autoCloseEnvironment")) {
            const environment = planEnvironmentCompletion(before, after, model.getValue());
            if (environment) {
                event.preventDefault();
                event.stopPropagation();
                editor.executeEdits("ergo-env", [
                    {
                        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, line.length + 1),
                        text: environment.text,
                    },
                ]);
                editor.setPosition({
                    lineNumber: pos.lineNumber + 1,
                    column: environment.cursorColumn,
                });
                return;
            }
        }
    });
    (_c = editor.onDidChangeCursorPosition) === null || _c === void 0 ? void 0 : _c.call(editor, (event) => {
        var _a, _b, _c, _d, _e;
        if (!editorSettings.isEnabled("ergo.typewriterScroll")) {
            return;
        }
        // "Keep the cursor near the center WHILE WRITING": recentering must
        // never fire for mouse-originated cursor moves — with it, every click
        // yanked the clicked line to the vertical center and the whole view
        // visibly jumped (~12 lines for a click near the bottom edge).
        if ((event === null || event === void 0 ? void 0 : event.source) === "mouse") {
            return;
        }
        const position = (_a = event === null || event === void 0 ? void 0 : event.position) !== null && _a !== void 0 ? _a : (_b = editor.getPosition) === null || _b === void 0 ? void 0 : _b.call(editor);
        if (!position) {
            return;
        }
        const scrollType = (_d = (_c = monaco === null || monaco === void 0 ? void 0 : monaco.editor) === null || _c === void 0 ? void 0 : _c.ScrollType) === null || _d === void 0 ? void 0 : _d.Immediate;
        (_e = editor.revealPositionInCenter) === null || _e === void 0 ? void 0 : _e.call(editor, position, scrollType);
    });
    // Wrap-selection actions. Registered once; the run handler checks the flag so
    // it can be toggled live.
    if (KeyMod && KeyCode && typeof editor.addAction === "function") {
        const wrap = (command) => {
            var _a, _b, _c, _d;
            if (!editorSettings.isEnabled("ergo.wrapSelection")) {
                return;
            }
            const selection = (_a = editor.getSelection) === null || _a === void 0 ? void 0 : _a.call(editor);
            const model = (_b = editor.getModel) === null || _b === void 0 ? void 0 : _b.call(editor);
            if (!selection || !model) {
                return;
            }
            const selected = model.getValueInRange(selection);
            editor.executeEdits("ergo-wrap", [
                { range: selection, text: `\\${command}{${selected}}` },
            ]);
            if (!selected) {
                // Place the caret inside the braces: after "\command{".
                (_c = editor.setPosition) === null || _c === void 0 ? void 0 : _c.call(editor, {
                    lineNumber: selection.startLineNumber,
                    column: selection.startColumn + command.length + 2,
                });
            }
            (_d = editor.focus) === null || _d === void 0 ? void 0 : _d.call(editor);
        };
        const addWrap = (id, label, command, keybinding) => {
            editor.addAction({
                id,
                label,
                keybindings: typeof keybinding === "number" ? [keybinding] : [],
                contextMenuGroupId: "9_latex_wrap",
                run: () => wrap(command),
            });
        };
        addWrap("tex64.wrap.textbf", uiText("Bold", "太字"), "textbf", KeyMod.CtrlCmd | KeyCode.KeyB);
        addWrap("tex64.wrap.textit", uiText("Italic", "斜体"), "textit", KeyMod.CtrlCmd | KeyCode.KeyI);
        addWrap("tex64.wrap.emph", uiText("Emphasize", "強調"), "emph");
        addWrap("tex64.wrap.texttt", uiText("Monospace", "等幅"), "texttt");
    }
};
