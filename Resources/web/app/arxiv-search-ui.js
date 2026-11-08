// The arXiv section of the "Insert citation…" dialog (zotero-ui.ts): related
// papers for the words around the cursor, or for what is typed in the dialog's
// field. Searching and citing go through the tex64Arxiv bridge; no model call
// is involved. arXiv needs the network, so the section appears only when
// results (or a failure) arrive.
import { uiText } from "./i18n.js";
import { buildArxivQuery, plainLatex } from "./arxiv-query.js";
import { citationDocumentFor, insertCitation } from "./citation-insert.js";
const DEBOUNCE_MS = 3000;
const RESULT_COUNT = 10;
export const ARXIV_CONTEXT_KEY = "tex64ArxivTexFile";
export const arxivBridge = () => window.tex64Arxiv;
class ArxivError extends Error {
    constructor(message, code) { super(message); this.code = code; }
}
const call = async (action, payload) => {
    const result = await arxivBridge().call(action, payload);
    if (!(result === null || result === void 0 ? void 0 : result.ok))
        throw new ArxivError((result === null || result === void 0 ? void 0 : result.error) || "arXiv request failed.", String((result === null || result === void 0 ? void 0 : result.code) || ""));
    return result;
};
const documentChanged = () => uiText("The document changed. Place the cursor again.", "文書が変更されました。カーソル位置を選び直してください。");
// A failed search shows a Retry button beside the message.
const describe = (reason, activeFilePath = null) => {
    const code = reason instanceof ArxivError ? reason.code : "";
    // The project closed while arXiv answered; nothing was written.
    if (code === "STALE_WORKSPACE")
        return documentChanged();
    // The .bib is written under the same lease as saves; Axiom holds it.
    if (code === "AGENT_WORKSPACE_BUSY")
        return uiText("Axiom is editing this project. Try again when it finishes.", "Axiomがこのプロジェクトを編集中です。終わってからもう一度お試しください。");
    // The file belongs to several documents with different .bib files; Build's
    // chooser (or a % !TEX root line) settles which one.
    if (code === "BUILD_TARGET_CHOICE") {
        return activeFilePath
            ? uiText(`${activeFilePath} belongs to more than one document.`, `${activeFilePath}は複数の文書から読み込まれています。`)
            : uiText("This folder has several documents and no main file is set.", "このフォルダには文書が複数あり、メインTeXが決まっていません。");
    }
    if (code === "NETWORK")
        return uiText("Cannot reach arXiv.", "arXivに接続できません。");
    if (code === "RATE_LIMIT")
        return uiText("arXiv is busy.", "arXivが混み合っています。");
    if (code === "TIMEOUT")
        return uiText("arXiv did not answer in time.", "arXivの応答がありません。");
    return reason instanceof Error ? reason.message : String(reason);
};
/** What the document still needs so BibTeX / biber finds the appended entry. */
const bibHint = (result) => {
    if (!result.suggestion)
        return "";
    const where = result.suggestion.place === "preamble"
        ? uiText("Add %s to the preamble.", "プリアンブルに%sを加えてください。")
        : uiText("Add %s before \\end{document}.", "\\end{document}の前に%sを加えてください。");
    const lines = result.suggestion.lines.join(uiText(" and ", " と "));
    const head = result.created
        ? uiText(`Created ${result.bibPath}.`, `${result.bibPath}を作成しました。`)
        : uiText(`Appended to ${result.bibPath}.`, `${result.bibPath}に追記しました。`);
    return `${head} ${where.replace("%s", lines)}`;
};
export const isArxivTexModel = (editor) => { var _a, _b, _c; return /\.tex$/i.test(((_c = (_b = (_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) === null || _b === void 0 ? void 0 : _b.uri) === null || _c === void 0 ? void 0 : _c.path) || ""); };
const authorsLabel = (authors) => {
    const shown = authors.slice(0, 3).join(", ");
    return authors.length > 3 ? uiText(`${shown} et al.`, `${shown}ほか`) : shown;
};
// Latin letters to search with: arXiv indexes English.
const hasLatin = (text) => /[A-Za-z]/.test(text);
/**
 * The arXiv part of the citation dialog, or null when the editor does not show
 * a .tex file (or there is no bridge). `report` writes the dialog's shared
 * status line (what a citation added, or why it failed).
 */
export const createArxivSection = (editor, getActiveFilePath, report) => {
    var _a, _b, _c, _d;
    if (!arxivBridge() || !isArxivTexModel(editor))
        return null;
    const model = (_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor);
    if (!model)
        return null;
    const selection = (_b = editor.getSelection) === null || _b === void 0 ? void 0 : _b.call(editor);
    const selectedText = selection && !((_c = selection.isEmpty) === null || _c === void 0 ? void 0 : _c.call(selection)) ? model.getValueInRange(selection) : "";
    const cursor = (_d = editor.getPosition) === null || _d === void 0 ? void 0 : _d.call(editor);
    const contextQuery = buildArxivQuery({
        selection: selectedText,
        lines: model.getValue().split(/\r?\n/),
        cursorLine: Math.max(0, ((cursor === null || cursor === void 0 ? void 0 : cursor.lineNumber) || 1) - 1),
    });
    const el = (tag, className = "", text = "") => {
        const node = document.createElement(tag);
        node.className = className;
        if (text)
            node.textContent = text;
        return node;
    };
    const button = (text, fn, className = "tool-button") => {
        const node = el("button", className, text);
        node.type = "button";
        node.addEventListener("click", (event) => { event.stopPropagation(); fn(); });
        return node;
    };
    const element = el("section", "cite-section cite-arxiv");
    element.hidden = true;
    const label = el("p", "tool-dialog-label cite-section-label", "arXiv");
    // The words arXiv was searched with: the field's, or those around the cursor.
    const usedQuery = el("span", "cite-section-detail");
    usedQuery.dataset.noI18n = "true";
    label.append(usedQuery);
    const status = el("p", "cite-section-status");
    status.setAttribute("role", "status");
    const results = el("div", "arxiv-results");
    element.append(label, status, results);
    let disposed = false;
    let searchSeq = 0;
    let inflight = false;
    let pending = null;
    let timer = null;
    let wanted = contextQuery;
    let searched = null;
    const cited = new Map();
    let papers = [];
    const sync = () => { element.hidden = papers.length === 0 && !status.textContent; };
    const fail = (message) => {
        status.replaceChildren(el("span", "", message), button(uiText("Retry", "再試行"), () => searchNow(), "cite-section-retry"));
        sync();
    };
    const clearFailure = () => { status.replaceChildren(); sync(); };
    const renderRow = (paper) => {
        const row = el("div", "arxiv-row");
        const head = el("div", "arxiv-row-head");
        const title = button(plainLatex(paper.title), () => {
            abstract.hidden = !abstract.hidden;
            title.setAttribute("aria-expanded", String(!abstract.hidden));
        }, "arxiv-row-title");
        title.setAttribute("aria-expanded", "false");
        const meta = el("p", "arxiv-row-meta", [authorsLabel(paper.authors), paper.year].filter(Boolean).join(" · "));
        const text = el("div", "arxiv-row-text");
        text.append(title, meta);
        const side = el("div", "arxiv-row-side");
        head.append(text, side);
        const abstract = el("p", "arxiv-abstract", plainLatex(paper.abstract));
        abstract.hidden = true;
        // Titles and abstracts are the papers' own words; labels come translated.
        row.dataset.noI18n = "true";
        row.append(head, abstract);
        const showCited = (result, inserted) => {
            side.replaceChildren(el("code", "arxiv-cited", inserted));
            if (result.duplicate) {
                side.append(el("p", "arxiv-row-meta", uiText(`Already in ${result.bibPath}.`, `${result.bibPath}に既にあります。`)));
            }
        };
        const done = cited.get(paper.arxivId);
        if (done) {
            showCited(done.result, done.inserted);
            return row;
        }
        const cite = button(uiText("Cite", "引用"), () => void (async () => {
            var _a, _b, _c;
            cite.disabled = true;
            const activeFilePath = getActiveFilePath();
            try {
                const result = await call("cite", {
                    arxivId: paper.arxivId,
                    activeFilePath,
                    documentMainFile: citationDocumentFor(activeFilePath),
                });
                if (((_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) !== model || ((_b = model.isDisposed) === null || _b === void 0 ? void 0 : _b.call(model)) || ((_c = editor.getRawOptions) === null || _c === void 0 ? void 0 : _c.call(editor).readOnly)) {
                    throw new Error(documentChanged());
                }
                const how = insertCitation(editor, result.key);
                const inserted = how === "appended" ? `,${result.key}` : `\\cite{${result.key}}`;
                cited.set(paper.arxivId, { result, inserted });
                showCited(result, inserted);
                // What the document still needs for BibTeX / biber to find the entry.
                const hint = bibHint(result);
                if (hint)
                    report(hint);
            }
            catch (reason) {
                cite.disabled = false;
                report(describe(reason, activeFilePath), true);
            }
        })());
        side.append(cite);
        return row;
    };
    const render = () => {
        results.replaceChildren(...papers.map(renderRow));
        sync();
    };
    const search = async (text) => {
        const trimmed = text.trim();
        searched = trimmed;
        if (!trimmed) {
            searchSeq += 1;
            papers = [];
            usedQuery.textContent = "";
            clearFailure();
            render();
            return;
        }
        if (inflight) {
            pending = trimmed;
            return;
        }
        inflight = true;
        const seq = ++searchSeq;
        try {
            // Words are ANDed, and the words are the reader's: an empty result is
            // said, not widened by dropping words.
            const result = await call("search", { query: trimmed, max: RESULT_COUNT });
            if (seq !== searchSeq || disposed || result.superseded)
                return;
            const found = result.papers || [];
            papers = found;
            usedQuery.textContent = found.length ? (result.query || trimmed) : "";
            clearFailure();
            // Typed words that find nothing get one line; the words around the
            // cursor finding nothing leave the section away.
            if (!found.length && trimmed !== contextQuery.trim())
                status.append(el("span", "cite-section-empty", uiText("No papers found", "見つかりません")));
            render();
        }
        catch (reason) {
            if (seq === searchSeq && !disposed) {
                papers = [];
                render();
                fail(describe(reason));
            }
        }
        finally {
            inflight = false;
            if (pending !== null && !disposed) {
                const next = pending;
                pending = null;
                void search(next);
            }
        }
    };
    const cancelTimer = () => {
        if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
        }
    };
    const searchNow = () => {
        cancelTimer();
        searched = null;
        void search(wanted);
    };
    const setQuery = (text) => {
        const typed = text.trim();
        // Only Latin words go to arXiv; with nothing typed, the words around the cursor.
        wanted = typed ? (hasLatin(typed) ? typed : "") : contextQuery;
        cancelTimer();
        if (wanted === searched)
            return;
        timer = window.setTimeout(() => { timer = null; void search(wanted); }, DEBOUNCE_MS);
    };
    const dispose = () => {
        disposed = true;
        cancelTimer();
        searchSeq += 1;
    };
    void search(contextQuery);
    return { element, setQuery, searchNow, dispose };
};
