// "Find related papers on arXiv…": the editor's context-menu entry (.tex only)
// and its dialog. Searching and citing go through the tex64Arxiv bridge; no
// model call is involved. The dialog follows the History dialog's grammar.
import { uiText } from "./i18n.js";
import { buildArxivQuery, plainLatex } from "./arxiv-query.js";
import { insertCitation } from "./citation-insert.js";
import type { EditorGroupState } from "./editor-session/types.js";

type Paper = {
  title: string;
  abstract: string;
  authors: string[];
  year: string;
  url: string;
  arxivId: string;
};
type CiteResult = { bibtex: string; key: string; bibPath: string; created: boolean; duplicate: boolean; suggestion?: string };

const DEBOUNCE_MS = 3000;
const RESULT_COUNT = 10;
const CONTEXT_KEY = "tex64ArxivTexFile";

const bridge = () => (window as any).tex64Arxiv as { call: (action: string, payload?: unknown) => Promise<any> } | undefined;

class ArxivError extends Error {
  code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}
const call = async <T,>(action: string, payload: unknown): Promise<T> => {
  const result = await bridge()!.call(action, payload);
  if (!result?.ok) throw new ArxivError(result?.error || "arXiv request failed.", String(result?.code || ""));
  return result as T;
};
const describe = (reason: unknown): string => {
  const code = reason instanceof ArxivError ? reason.code : "";
  if (code === "NETWORK") return uiText("Cannot reach arXiv. Check the connection and press Enter to retry.", "arXiv に接続できません。接続を確認して Enter で再試行してください。");
  if (code === "RATE_LIMIT") return uiText("arXiv is busy. Wait a moment and press Enter to retry.", "arXiv が混雑しています。しばらく待って Enter で再試行してください。");
  if (code === "TIMEOUT") return uiText("arXiv did not answer in time. Press Enter to retry.", "arXiv の応答がありません。Enter で再試行してください。");
  return reason instanceof Error ? reason.message : String(reason);
};

const isTexModel = (editor: any) => /\.tex$/i.test(editor?.getModel?.()?.uri?.path || "");

let modalOpen = false;

export const attachArxivSearch = (editor: any, group: EditorGroupState) => {
  if (!bridge() || typeof editor?.addAction !== "function") return;
  const texKey = editor.createContextKey?.(CONTEXT_KEY, isTexModel(editor));
  editor.onDidChangeModel?.(() => texKey?.set(isTexModel(editor)));
  editor.addAction({
    id: "tex64.arxiv.search",
    label: uiText("Find related papers on arXiv…", "arXiv で関連文献を探す…"),
    contextMenuGroupId: "9_cite",
    contextMenuOrder: 1,
    precondition: texKey ? CONTEXT_KEY : undefined,
    run: () => openArxivSearch(editor, group),
  });
};

const authorsLabel = (authors: string[]) => {
  const shown = authors.slice(0, 3).join(", ");
  return authors.length > 3 ? uiText(`${shown} et al.`, `${shown} ほか`) : shown;
};

export const openArxivSearch = (editor: any, group: EditorGroupState) => {
  if (modalOpen || !bridge() || !isTexModel(editor)) return;
  const model = editor.getModel?.();
  if (!model) return;
  modalOpen = true;

  const selection = editor.getSelection?.();
  const selectedText = selection && !selection.isEmpty?.() ? model.getValueInRange(selection) : "";
  const cursor = editor.getPosition?.();
  const initialQuery = buildArxivQuery({
    selection: selectedText,
    lines: model.getValue().split(/\r?\n/),
    cursorLine: Math.max(0, (cursor?.lineNumber || 1) - 1),
  });

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const button = (text: string, fn: () => void) => {
    const node = el("button", "history-button", text);
    node.type = "button";
    node.addEventListener("click", (event) => { event.stopPropagation(); fn(); });
    return node;
  };

  const dialog = el("dialog", "history-confirm arxiv-dialog");
  const heading = el("h2", "", uiText("Related papers on arXiv", "arXiv の関連文献"));
  heading.id = "arxiv-search-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  const query = el("input", "history-name");
  query.type = "text";
  query.value = initialQuery;
  query.placeholder = uiText("Search arXiv (English words)", "arXiv を検索（英語の語）");
  query.setAttribute("aria-label", query.placeholder);
  query.spellcheck = false;
  const status = el("div", "history-error arxiv-status");
  status.setAttribute("role", "status");
  const results = el("div", "arxiv-results");
  const actions = el("div", "history-confirm-actions");
  actions.append(button(uiText("Close", "閉じる"), () => dialog.close()));
  dialog.append(heading, query, status, results, actions);

  let searchSeq = 0;
  let inflight = false;
  let pending: string | null = null;
  let timer: number | null = null;
  const cited = new Map<string, { result: CiteResult; inserted: string }>();
  let papers: Paper[] = [];

  const setStatus = (text: string) => { status.textContent = text; };
  const askForEnglish = () => {
    setStatus(uiText("arXiv is searched in English. Enter English words.", "arXiv は英語で検索します。英語の語を入れてください。"));
    query.focus();
  };

  const renderRow = (paper: Paper) => {
    const row = el("div", "arxiv-row");
    const head = el("div", "arxiv-row-head");
    const title = button(plainLatex(paper.title), () => {
      abstract.hidden = !abstract.hidden;
      title.setAttribute("aria-expanded", String(!abstract.hidden));
    });
    title.className = "arxiv-row-title";
    title.setAttribute("aria-expanded", "false");
    const meta = el("p", "arxiv-row-meta", [authorsLabel(paper.authors), paper.year].filter(Boolean).join(" · "));
    const text = el("div", "arxiv-row-text");
    text.append(title, meta);
    const side = el("div", "arxiv-row-side");
    head.append(text, side);
    const abstract = el("p", "arxiv-abstract", plainLatex(paper.abstract));
    abstract.hidden = true;
    row.append(head, abstract);

    const showCited = (result: CiteResult, inserted: string) => {
      side.replaceChildren(el("code", "arxiv-cited", inserted));
      if (result.duplicate) {
        side.append(el("p", "arxiv-row-meta", uiText(`${result.key} was already in ${result.bibPath}.`, `${result.key} は ${result.bibPath} に既にありました。`)));
      }
    };
    const done = cited.get(paper.arxivId);
    if (done) { showCited(done.result, done.inserted); return row; }

    const cite = button(uiText("Cite", "引用する"), () => void (async () => {
      cite.disabled = true;
      setStatus("");
      try {
        const result = await call<CiteResult>("cite", { arxivId: paper.arxivId, activeFilePath: group.currentFilePath });
        if (editor.getModel?.() !== model || model.isDisposed?.() || editor.getRawOptions?.().readOnly) {
          throw new Error(uiText("The document changed. Close the dialog and place the cursor again.", "文書が変更されました。閉じてカーソル位置を選び直してください。"));
        }
        const how = insertCitation(editor, result.key);
        const inserted = how === "appended" ? `,${result.key}` : `\\cite{${result.key}}`;
        cited.set(paper.arxivId, { result, inserted });
        showCited(result, inserted);
        if (result.created && result.suggestion) {
          setStatus(uiText(`Created ${result.bibPath}. Add ${result.suggestion} to the preamble.`, `${result.bibPath} を作成しました。プリアンブルに ${result.suggestion} を加えてください。`));
        }
      } catch (reason) {
        cite.disabled = false;
        setStatus(describe(reason));
      }
    })());
    side.append(cite);
    return row;
  };

  const render = () => { results.replaceChildren(...papers.map(renderRow)); };

  const search = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) { papers = []; render(); askForEnglish(); return; }
    if (inflight) { pending = trimmed; return; }
    inflight = true;
    const seq = ++searchSeq;
    setStatus(uiText("Searching…", "検索中…"));
    try {
      const result = await call<{ papers: Paper[]; query?: string; superseded?: boolean }>("search", { query: trimmed, max: RESULT_COUNT });
      if (seq === searchSeq && !result.superseded) {
        papers = result.papers || [];
        // The main process may have dropped trailing words to get a hit; the
        // field shows the query that produced the list.
        if (result.query && result.query !== trimmed && query.value.trim() === trimmed) query.value = result.query;
        render();
        setStatus(papers.length ? "" : uiText("No papers found.", "該当する論文はありません。"));
      }
    } catch (reason) {
      if (seq === searchSeq) setStatus(describe(reason));
    } finally {
      inflight = false;
      if (pending !== null && dialog.open) { const next = pending; pending = null; void search(next); }
    }
  };
  const scheduleSearch = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => { timer = null; void search(query.value); }, DEBOUNCE_MS);
  };
  query.addEventListener("input", scheduleSearch);
  query.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (timer !== null) { window.clearTimeout(timer); timer = null; }
    void search(query.value);
  });

  dialog.addEventListener("close", () => {
    modalOpen = false;
    if (timer !== null) window.clearTimeout(timer);
    searchSeq += 1;
    dialog.remove();
    editor.focus?.();
  });
  document.body.append(dialog);
  dialog.showModal();
  query.focus();
  query.setSelectionRange(query.value.length, query.value.length);
  void search(initialQuery);
};
