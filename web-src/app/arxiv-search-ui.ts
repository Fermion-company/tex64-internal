// "Find related papers on arXiv…": the editor's context-menu entry (.tex only)
// and its dialog. Searching and citing go through the tex64Arxiv bridge; no
// model call is involved.
import { uiText } from "./i18n.js";
import { buildArxivQuery } from "./arxiv-query.js";
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
type CiteResult = { bibtex: string; key: string; bibPath: string; created: boolean; duplicate: boolean };

const DEBOUNCE_MS = 3000;
const RESULT_COUNT = 10;
const CONTEXT_KEY = "tex64ArxivTexFile";

const bridge = () => (window as any).tex64Arxiv as { call: (action: string, payload?: unknown) => Promise<any> } | undefined;
const call = async <T,>(action: string, payload: unknown): Promise<T> => {
  const result = await bridge()!.call(action, payload);
  if (!result?.ok) throw new Error(result?.error || uiText("arXiv request failed.", "arXiv への要求に失敗しました。"));
  return result as T;
};

const isTexModel = (editor: any) => {
  const uriPath: string = editor?.getModel?.()?.uri?.path || "";
  return /\.tex$/i.test(uriPath);
};

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

  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text) value.textContent = text;
    return value;
  };
  const button = (text: string, fn: () => void, className = "") => {
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
  let pending: string | null = null;
  let timer: number | null = null;
  const cited = new Map<string, CiteResult>();
  let papers: Paper[] = [];

  const setStatus = (text: string) => { status.textContent = text; };

  const renderRow = (paper: Paper) => {
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

    const showCited = (result: CiteResult) => {
      side.replaceChildren();
      const key = node("code", "arxiv-cited", `\\cite{${result.key}}`);
      side.append(key);
      const note = result.duplicate
        ? uiText(`${result.key} was already in ${result.bibPath}.`, `${result.key} は ${result.bibPath} に既にありました。`)
        : result.created
          ? uiText(`Created ${result.bibPath}.`, `${result.bibPath} を作成しました。`)
          : "";
      if (note) side.append(node("p", "arxiv-row-meta", note));
    };
    const done = cited.get(paper.arxivId);
    if (done) { showCited(done); return row; }

    const cite = button(uiText("Cite", "引用する"), () => void (async () => {
      cite.disabled = true;
      setStatus("");
      try {
        const result = await call<CiteResult>("cite", { arxivId: paper.arxivId, activeFilePath: group.currentFilePath });
        if (editor.getModel?.() !== model || model.isDisposed?.() || editor.getRawOptions?.().readOnly) {
          throw new Error(uiText("The document changed. Close the dialog and place the cursor again.", "文書が変更されました。閉じてカーソル位置を選び直してください。"));
        }
        insertCitation(editor, result.key);
        cited.set(paper.arxivId, result);
        showCited(result);
      } catch (reason) {
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

  const search = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) { papers = []; render(); setStatus(""); return; }
    if (inflight) { pending = trimmed; return; }
    inflight = true;
    const seq = ++searchSeq;
    setStatus(uiText("Searching…", "検索中…"));
    try {
      const result = await call<{ papers: Paper[]; superseded?: boolean }>("search", { query: trimmed, max: RESULT_COUNT });
      if (seq === searchSeq && !result.superseded) {
        papers = result.papers || [];
        render();
        setStatus(papers.length ? "" : uiText("No papers found.", "該当する論文はありません。"));
      }
    } catch (reason) {
      if (seq === searchSeq) setStatus(reason instanceof Error ? reason.message : String(reason));
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
