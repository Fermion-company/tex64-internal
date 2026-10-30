// "Find related papers on arXiv…": the editor's context-menu entry (.tex only)
// and its dialog. Searching and citing go through the tex64Arxiv bridge; no
// model call is involved.
import { uiText } from "./i18n.js";
import { buildArxivQuery } from "./arxiv-query.js";
import { insertCitation } from "./citation-insert.js";
const DEBOUNCE_MS = 3000;
const RESULT_COUNT = 10;
const CONTEXT_KEY = "tex64ArxivTexFile";
const bridge = () => window.tex64Arxiv;
const call = async (action, payload) => {
    const result = await bridge().call(action, payload);
    if (!(result === null || result === void 0 ? void 0 : result.ok))
        throw new Error((result === null || result === void 0 ? void 0 : result.error) || uiText("arXiv request failed.", "arXiv への要求に失敗しました。"));
    return result;
};
const isTexModel = (editor) => {
    var _a, _b, _c;
    const uriPath = ((_c = (_b = (_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) === null || _b === void 0 ? void 0 : _b.uri) === null || _c === void 0 ? void 0 : _c.path) || "";
    return /\.tex$/i.test(uriPath);
};
let modalOpen = false;
export const attachArxivSearch = (editor, group) => {
    var _a, _b;
    if (!bridge() || typeof (editor === null || editor === void 0 ? void 0 : editor.addAction) !== "function")
        return;
    const texKey = (_a = editor.createContextKey) === null || _a === void 0 ? void 0 : _a.call(editor, CONTEXT_KEY, isTexModel(editor));
    (_b = editor.onDidChangeModel) === null || _b === void 0 ? void 0 : _b.call(editor, () => texKey === null || texKey === void 0 ? void 0 : texKey.set(isTexModel(editor)));
    editor.addAction({
        id: "tex64.arxiv.search",
        label: uiText("Find related papers on arXiv…", "arXiv で関連文献を探す…"),
        contextMenuGroupId: "9_cite",
        contextMenuOrder: 1,
        precondition: texKey ? CONTEXT_KEY : undefined,
        run: () => openArxivSearch(editor, group),
    });
};
const authorsLabel = (authors) => {
    const shown = authors.slice(0, 3).join(", ");
    return authors.length > 3 ? uiText(`${shown} et al.`, `${shown} ほか`) : shown;
};
export const openArxivSearch = (editor, group) => {
    var _a, _b, _c, _d;
    if (modalOpen || !bridge() || !isTexModel(editor))
        return;
    const model = (_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor);
    if (!model)
        return;
    modalOpen = true;
    const selection = (_b = editor.getSelection) === null || _b === void 0 ? void 0 : _b.call(editor);
    const selectedText = selection && !((_c = selection.isEmpty) === null || _c === void 0 ? void 0 : _c.call(selection)) ? model.getValueInRange(selection) : "";
    const cursor = (_d = editor.getPosition) === null || _d === void 0 ? void 0 : _d.call(editor);
    const initialQuery = buildArxivQuery({
        selection: selectedText,
        lines: model.getValue().split(/\r?\n/),
        cursorLine: Math.max(0, ((cursor === null || cursor === void 0 ? void 0 : cursor.lineNumber) || 1) - 1),
    });
    const node = (tag, className = "", text = "") => {
        const value = document.createElement(tag);
        if (className)
            value.className = className;
        if (text)
            value.textContent = text;
        return value;
    };
    const button = (text, fn, className = "") => {
        const el = node("button", className, text);
        el.type = "button";
        el.addEventListener("click", (event) => { event.stopPropagation(); fn(); });
        return el;
    };
    const dialog = node("dialog", "snippets-dialog arxiv-dialog");
    const heading = node("h2", "", uiText("Related papers on arXiv", "arXiv の関連文献"));
    heading.id = "arxiv-search-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const query = node("input");
    query.type = "search";
    query.value = initialQuery;
    query.placeholder = uiText("Search arXiv", "arXiv を検索");
    query.setAttribute("aria-label", query.placeholder);
    query.spellcheck = false;
    const status = node("p", "arxiv-status");
    status.setAttribute("role", "status");
    const results = node("div", "arxiv-results");
    const actions = node("div", "snippets-actions");
    actions.append(button(uiText("Close", "閉じる"), () => dialog.close()));
    dialog.append(heading, query, status, results, actions);
    let searchSeq = 0;
    let inflight = false;
    let pending = null;
    let timer = null;
    const cited = new Map();
    let papers = [];
    const setStatus = (text) => { status.textContent = text; };
    const renderRow = (paper) => {
        const row = node("div", "arxiv-row");
        const head = node("div", "arxiv-row-head");
        const title = button(paper.title, () => { abstract.hidden = !abstract.hidden; title.setAttribute("aria-expanded", String(!abstract.hidden)); }, "arxiv-row-title");
        title.setAttribute("aria-expanded", "false");
        const meta = node("p", "arxiv-row-meta", [authorsLabel(paper.authors), paper.year].filter(Boolean).join(" · "));
        const text = node("div", "arxiv-row-text");
        text.append(title, meta);
        const side = node("div", "arxiv-row-side");
        head.append(text, side);
        const abstract = node("p", "arxiv-abstract", paper.abstract);
        abstract.hidden = true;
        row.append(head, abstract);
        const showCited = (result) => {
            side.replaceChildren();
            const key = node("code", "arxiv-cited", `\\cite{${result.key}}`);
            side.append(key);
            const note = result.duplicate
                ? uiText(`${result.key} was already in ${result.bibPath}.`, `${result.key} は ${result.bibPath} に既にありました。`)
                : result.created
                    ? uiText(`Created ${result.bibPath}.`, `${result.bibPath} を作成しました。`)
                    : "";
            if (note)
                side.append(node("p", "arxiv-row-meta", note));
        };
        const done = cited.get(paper.arxivId);
        if (done) {
            showCited(done);
            return row;
        }
        const cite = button(uiText("Cite", "引用する"), () => void (async () => {
            var _a, _b, _c;
            cite.disabled = true;
            setStatus("");
            try {
                const result = await call("cite", { arxivId: paper.arxivId, activeFilePath: group.currentFilePath });
                if (((_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) !== model || ((_b = model.isDisposed) === null || _b === void 0 ? void 0 : _b.call(model)) || ((_c = editor.getRawOptions) === null || _c === void 0 ? void 0 : _c.call(editor).readOnly)) {
                    throw new Error(uiText("The document changed. Close the dialog and place the cursor again.", "文書が変更されました。閉じてカーソル位置を選び直してください。"));
                }
                insertCitation(editor, result.key);
                cited.set(paper.arxivId, result);
                showCited(result);
            }
            catch (reason) {
                cite.disabled = false;
                setStatus(reason instanceof Error ? reason.message : String(reason));
            }
        })(), "is-primary");
        side.append(cite);
        return row;
    };
    const render = () => {
        results.replaceChildren(...papers.map(renderRow));
    };
    const search = async (text) => {
        const trimmed = text.trim();
        if (!trimmed) {
            papers = [];
            render();
            setStatus("");
            return;
        }
        if (inflight) {
            pending = trimmed;
            return;
        }
        inflight = true;
        const seq = ++searchSeq;
        setStatus(uiText("Searching…", "検索中…"));
        try {
            const result = await call("search", { query: trimmed, max: RESULT_COUNT });
            if (seq === searchSeq && !result.superseded) {
                papers = result.papers || [];
                render();
                setStatus(papers.length ? "" : uiText("No papers found.", "該当する論文はありません。"));
            }
        }
        catch (reason) {
            if (seq === searchSeq)
                setStatus(reason instanceof Error ? reason.message : String(reason));
        }
        finally {
            inflight = false;
            if (pending !== null && dialog.open) {
                const next = pending;
                pending = null;
                void search(next);
            }
        }
    };
    const scheduleSearch = () => {
        if (timer !== null)
            window.clearTimeout(timer);
        timer = window.setTimeout(() => { timer = null; void search(query.value); }, DEBOUNCE_MS);
    };
    query.addEventListener("input", scheduleSearch);
    query.addEventListener("keydown", (event) => {
        if (event.key !== "Enter")
            return;
        event.preventDefault();
        if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
        }
        void search(query.value);
    });
    dialog.addEventListener("close", () => {
        var _a;
        modalOpen = false;
        if (timer !== null)
            window.clearTimeout(timer);
        searchSeq += 1;
        dialog.remove();
        (_a = editor.focus) === null || _a === void 0 ? void 0 : _a.call(editor);
    });
    document.body.append(dialog);
    dialog.showModal();
    query.focus();
    query.setSelectionRange(query.value.length, query.value.length);
    void search(initialQuery);
};
