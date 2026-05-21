// LaTeX authoring ergonomics layered on a Monaco editor instance:
//   - Enter after a non-empty "\item" starts a new "\item " (an empty "\item"
//     is left untouched — Enter just inserts a normal newline)
//   - Enter right after "\begin{env}" inserts a matching "\end{env}" body
//   - Wrap-selection actions (\textbf, \textit, \emph, \texttt)
// Each behavior reads its flag from the editor settings store at call time, so
// toggling a feature on/off takes effect live without re-attaching.
import { editorSettings } from "./editor-settings/editor-settings-store.js";
const leadingWhitespace = (line) => (line.match(/^[ \t]*/) || [""])[0];
const suggestWidgetOpen = () => {
    try {
        return typeof document !== "undefined" && !!document.querySelector(".suggest-widget.visible");
    }
    catch {
        return false;
    }
};
export const attachEditorErgonomics = (monaco, editor, group) => {
    var _a;
    const KeyCode = monaco === null || monaco === void 0 ? void 0 : monaco.KeyCode;
    const KeyMod = monaco === null || monaco === void 0 ? void 0 : monaco.KeyMod;
    if (!editor || !KeyCode) {
        return;
    }
    (_a = editor.onKeyDown) === null || _a === void 0 ? void 0 : _a.call(editor, (event) => {
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
        if (suggestWidgetOpen()) {
            return; // let Enter accept the completion
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
            const beginMatch = before.match(/\\begin\{([^}]+)\}$/);
            if (beginMatch) {
                event.preventDefault();
                event.stopPropagation();
                const env = beginMatch[1];
                const insert = `\n${indent}  \n${indent}\\end{${env}}`;
                editor.executeEdits("ergo-env", [
                    { range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: insert },
                ]);
                editor.setPosition({ lineNumber: pos.lineNumber + 1, column: indent.length + 3 });
                return;
            }
        }
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
        addWrap("tex64.wrap.textbf", "LaTeX: Bold (\\textbf)", "textbf", KeyMod.CtrlCmd | KeyCode.KeyB);
        addWrap("tex64.wrap.textit", "LaTeX: Italic (\\textit)", "textit", KeyMod.CtrlCmd | KeyCode.KeyI);
        addWrap("tex64.wrap.emph", "LaTeX: Emphasize (\\emph)", "emph");
        addWrap("tex64.wrap.texttt", "LaTeX: Monospace (\\texttt)", "texttt");
    }
};
