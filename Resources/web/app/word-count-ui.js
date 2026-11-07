// File › Word Count…: one dialog with the counts of the document the active
// file belongs to (main file and every file it reads), of the active file
// when that is only part of it, and of the selection. Counting happens in
// the main process (electron/services/word-count.cjs) on the saved files,
// with the unsaved editor buffers sent along.
var _a;
import { getUiLocale, uiText } from "./i18n.js";
import { explainedHeading } from "./explain.js";
import { markFocus, restoreFocus } from "./focus-key.js";
const bridge = (_a = window.tex64WordCount) !== null && _a !== void 0 ? _a : null;
export const initWordCountUi = (deps) => {
    let dialog = null;
    // Changing the scope rebuilds the dialog; the title's ▾ stays as the user left it.
    const explainOpen = new Set();
    const el = (tag, className = "", text = "") => {
        const node = document.createElement(tag);
        if (className)
            node.className = className;
        node.textContent = text;
        return node;
    };
    const number = (value) => value.toLocaleString();
    // The scope shown when the dialog last rendered; kept across re-renders.
    let scope = "document";
    const stat = (value, name, major = false, unit = "") => {
        const box = el("div", `word-count-stat${major ? " is-major" : ""}`);
        const figure = el("span", "word-count-value", value);
        if (unit)
            figure.append(el("small", "", unit));
        box.append(figure, el("span", "word-count-name", name));
        return box;
    };
    const render = (result, activePath) => {
        var _a;
        if (!dialog)
            return;
        let titleExplain = "";
        const title = el("h2", "tool-dialog-title", uiText("Word Count", "文字数"));
        title.id = "word-count-title";
        dialog.setAttribute("aria-labelledby", title.id);
        const body = el("div", "word-count-body");
        if (!result) {
            body.append(el("p", "tool-dialog-note", uiText("Counting…", "集計中…")));
        }
        else if (!result.ok) {
            body.append(el("p", "tool-dialog-error", result.error || uiText("Could not count.", "数えられませんでした。")));
        }
        else if (!result.document && !result.selection) {
            body.append(el("p", "tool-dialog-note", uiText("Open a .tex file first.", ".tex ファイルを開いてください。")));
        }
        else {
            const documentCounts = result.document && result.document.files.length ? result.document : null;
            // "This file" only for a part of the document, not for its main file.
            const active = documentCounts && activePath !== documentCounts.mainFile
                ? (_a = documentCounts.files.find((file) => file.path === activePath)) !== null && _a !== void 0 ? _a : null
                : null;
            const scopes = [];
            if (documentCounts)
                scopes.push({ id: "document", label: uiText("Document", "文書全体"), counts: documentCounts.total });
            if (active)
                scopes.push({ id: "file", label: uiText("This file", "このファイル"), counts: active });
            if (result.selection)
                scopes.push({ id: "selection", label: uiText("Selection", "選択範囲"), counts: result.selection });
            if (!scopes.some((entry) => entry.id === scope))
                scope = scopes[0].id;
            if (scopes.length > 1) {
                const switcher = el("div", "tool-segmented word-count-scopes");
                switcher.setAttribute("role", "group");
                for (const entry of scopes) {
                    const option = el("button", "", entry.label);
                    option.type = "button";
                    option.setAttribute("aria-pressed", String(entry.id === scope));
                    option.dataset.focusKey = `scope-${entry.id}`;
                    option.addEventListener("click", () => {
                        scope = entry.id;
                        render(result, activePath);
                    });
                    switcher.append(option);
                }
                body.append(switcher);
            }
            const counts = scopes.find((entry) => entry.id === scope).counts;
            const characters = stat(number(counts.characters), uiText("Characters", "文字"), true);
            const words = stat(number(counts.words), uiText("Words", "単語"), true);
            const grid = el("div", "word-count-stats");
            // The measure Japanese manuscripts use comes first in Japanese.
            grid.append(...(getUiLocale() === "ja" ? [characters, words] : [words, characters]));
            grid.append(stat(number(counts.headings), uiText("Headings", "見出し")), stat(`${number(counts.inlineMath)} / ${number(counts.displayMath)}`, uiText("Math (inline / display)", "数式（行内 / 別行）")));
            body.append(grid);
            // Which files were counted is state; what is left out waits behind the title's ▾.
            if (scope === "document" && documentCounts) {
                const { mainFile } = documentCounts;
                const others = documentCounts.files.length - 1;
                const note = el("p", "tool-dialog-note", others > 0
                    ? uiText(`${mainFile} + ${others} file${others === 1 ? "" : "s"}`, `${mainFile} + ${others}ファイル`)
                    : mainFile);
                note.dataset.noI18n = "true";
                body.append(note);
            }
            titleExplain = uiText("Spaces, comments, math and commands are not counted.", "空白・コメント・数式・コマンドは数えません。");
        }
        const actions = el("div", "tool-dialog-actions");
        const close = el("button", "tool-button", uiText("Close", "閉じる"));
        close.type = "button";
        close.addEventListener("click", () => dialog === null || dialog === void 0 ? void 0 : dialog.close());
        close.dataset.focusKey = "close";
        actions.append(close);
        // Changing the scope rebuilds the dialog: focus stays on the control the
        // user was on; Close takes it on opening.
        const focusMark = markFocus(dialog);
        dialog.replaceChildren(...(titleExplain ? explainedHeading(title, titleExplain, { memory: explainOpen, key: "title" }) : [title]), body, actions);
        if (!restoreFocus(dialog, focusMark))
            close.focus();
    };
    const open = async () => {
        var _a, _b;
        if (!bridge)
            return;
        const editorSession = deps.editorSession();
        const activePath = editorSession.getActiveFilePath();
        const selection = editorSession.getActiveSelectionSnapshot();
        const buffers = {};
        for (const snapshot of editorSession.getOpenFileSnapshots({ onlyDirty: true, maxFiles: 0, maxChars: 8 * 1024 * 1024 }).snapshots) {
            if (!snapshot.truncated)
                buffers[snapshot.path] = snapshot.content;
        }
        if (!dialog) {
            dialog = el("dialog", "tool-dialog word-count-dialog");
            dialog.addEventListener("close", () => {
                dialog === null || dialog === void 0 ? void 0 : dialog.remove();
                dialog = null;
                explainOpen.clear();
            });
            document.body.append(dialog);
            dialog.showModal();
        }
        scope = "document";
        render(null, activePath);
        let result;
        try {
            result = await bridge.count({
                activeFilePath: activePath && /\.tex$/i.test(activePath) ? activePath : "",
                documentMainFile: activePath ? (_a = deps.documentFor(activePath)) !== null && _a !== void 0 ? _a : "" : "",
                selection: ((_b = selection === null || selection === void 0 ? void 0 : selection.text) === null || _b === void 0 ? void 0 : _b.trim()) ? selection.text : "",
                buffers,
            });
        }
        catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error), document: null, selection: null };
        }
        render(result, activePath);
    };
    return { open };
};
