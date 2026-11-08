// The arXiv section of the "Insert citation…" dialog (zotero-ui.ts): related
// papers for the words around the cursor, or for what is typed in the dialog's
// field. Searching and citing go through the tex64Arxiv bridge; no model call
// is involved. arXiv needs the network, so the section appears only when
// results (or a failure) arrive.
import { uiText } from "./i18n.js";
import { buildArxivQuery, plainLatex } from "./arxiv-query.js";
import { citationDocumentFor, insertCitation } from "./citation-insert.js";

type Paper = {
  title: string;
  abstract: string;
  authors: string[];
  year: string;
  url: string;
  arxivId: string;
};
type CiteResult = {
  bibtex: string; key: string; bibPath: string; created: boolean; duplicate: boolean; referenced: boolean;
  suggestion?: { place: "preamble" | "end"; lines: string[] };
};

const DEBOUNCE_MS = 3000;
// arXiv asks for one request every 3 s; relaxing an empty result waits that long.
const RELAX_PAUSE_MS = 3000;
const MAX_RELAX = 2;
const RESULT_COUNT = 10;
export const ARXIV_CONTEXT_KEY = "tex64ArxivTexFile";

export const arxivBridge = () => (window as any).tex64Arxiv as { call: (action: string, payload?: unknown) => Promise<any> } | undefined;

class ArxivError extends Error {
  code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}
const call = async <T,>(action: string, payload: unknown): Promise<T> => {
  const result = await arxivBridge()!.call(action, payload);
  if (!result?.ok) throw new ArxivError(result?.error || "arXiv request failed.", String(result?.code || ""));
  return result as T;
};
const documentChanged = () =>
  uiText("The document changed. Place the cursor again.", "文書が変更されました。カーソル位置を選び直してください。");

// A failed search shows a Retry button beside the message.
const describe = (reason: unknown, activeFilePath: string | null = null): string => {
  const code = reason instanceof ArxivError ? reason.code : "";
  // The project closed while arXiv answered; nothing was written.
  if (code === "STALE_WORKSPACE") return documentChanged();
  // The .bib is written under the same lease as saves; Axiom holds it.
  if (code === "AGENT_WORKSPACE_BUSY") return uiText("Axiom is editing this project. Try again when it finishes.", "Axiomがこのプロジェクトを編集中です。終わってからもう一度お試しください。");
  // The file belongs to several documents with different .bib files; Build's
  // chooser (or a % !TEX root line) settles which one.
  if (code === "BUILD_TARGET_CHOICE") {
    return activeFilePath
      ? uiText(`${activeFilePath} belongs to more than one document.`, `${activeFilePath}は複数の文書から読み込まれています。`)
      : uiText("This folder has several documents and no main file is set.", "このフォルダには文書が複数あり、メインTeXが決まっていません。");
  }
  if (code === "NETWORK") return uiText("Cannot reach arXiv.", "arXivに接続できません。");
  if (code === "RATE_LIMIT") return uiText("arXiv is busy.", "arXivが混み合っています。");
  if (code === "TIMEOUT") return uiText("arXiv did not answer in time.", "arXivの応答がありません。");
  return reason instanceof Error ? reason.message : String(reason);
};

/** What the document still needs so BibTeX / biber finds the appended entry. */
const bibHint = (result: CiteResult): string => {
  if (!result.suggestion) return "";
  const where = result.suggestion.place === "preamble"
    ? uiText("Add %s to the preamble.", "プリアンブルに%sを加えてください。")
    : uiText("Add %s before \\end{document}.", "\\end{document}の前に%sを加えてください。");
  const lines = result.suggestion.lines.join(uiText(" and ", " と "));
  const head = result.created
    ? uiText(`Created ${result.bibPath}.`, `${result.bibPath}を作成しました。`)
    : uiText(`Appended to ${result.bibPath}.`, `${result.bibPath}に追記しました。`);
  return `${head} ${where.replace("%s", lines)}`;
};

export const isArxivTexModel = (editor: any) => /\.tex$/i.test(editor?.getModel?.()?.uri?.path || "");

const authorsLabel = (authors: string[]) => {
  const shown = authors.slice(0, 3).join(", ");
  return authors.length > 3 ? uiText(`${shown} et al.`, `${shown}ほか`) : shown;
};

// Latin letters to search with: arXiv indexes English.
const hasLatin = (text: string) => /[A-Za-z]/.test(text);

export type ArxivSection = {
  element: HTMLElement;
  // The text in the dialog's field; empty falls back to the words around the cursor.
  setQuery: (text: string) => void;
  // Search now instead of after the pause arXiv asks for.
  searchNow: () => void;
  dispose: () => void;
};

/**
 * The arXiv part of the citation dialog, or null when the editor does not show
 * a .tex file (or there is no bridge). `report` writes the dialog's shared
 * status line (what a citation added, or why it failed).
 */
export const createArxivSection = (
  editor: any,
  getActiveFilePath: () => string | null,
  report: (text: string, isError?: boolean) => void,
): ArxivSection | null => {
  if (!arxivBridge() || !isArxivTexModel(editor)) return null;
  const model = editor.getModel?.();
  if (!model) return null;

  const selection = editor.getSelection?.();
  const selectedText = selection && !selection.isEmpty?.() ? model.getValueInRange(selection) : "";
  const cursor = editor.getPosition?.();
  const contextQuery = buildArxivQuery({
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
  const button = (text: string, fn: () => void, className = "tool-button") => {
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
  let pending: string | null = null;
  let timer: number | null = null;
  let wanted = contextQuery;
  let searched: string | null = null;
  const cited = new Map<string, { result: CiteResult; inserted: string }>();
  let papers: Paper[] = [];

  const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  const sync = () => { element.hidden = papers.length === 0 && !status.textContent; };
  const fail = (message: string) => {
    status.replaceChildren(el("span", "", message), button(uiText("Retry", "再試行"), () => searchNow(), "cite-section-retry"));
    sync();
  };
  const clearFailure = () => { status.replaceChildren(); sync(); };

  const renderRow = (paper: Paper) => {
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

    const showCited = (result: CiteResult, inserted: string) => {
      side.replaceChildren(el("code", "arxiv-cited", inserted));
      if (result.duplicate) {
        side.append(el("p", "arxiv-row-meta", uiText(`Already in ${result.bibPath}.`, `${result.bibPath}に既にあります。`)));
      }
    };
    const done = cited.get(paper.arxivId);
    if (done) { showCited(done.result, done.inserted); return row; }

    const cite = button(uiText("Cite", "引用"), () => void (async () => {
      cite.disabled = true;
      const activeFilePath = getActiveFilePath();
      try {
        const result = await call<CiteResult>("cite", {
          arxivId: paper.arxivId,
          activeFilePath,
          documentMainFile: citationDocumentFor(activeFilePath),
        });
        if (editor.getModel?.() !== model || model.isDisposed?.() || editor.getRawOptions?.().readOnly) {
          throw new Error(documentChanged());
        }
        const how = insertCitation(editor, result.key);
        const inserted = how === "appended" ? `,${result.key}` : `\\cite{${result.key}}`;
        cited.set(paper.arxivId, { result, inserted });
        showCited(result, inserted);
        // What the document still needs for BibTeX / biber to find the entry.
        const hint = bibHint(result);
        if (hint) report(hint);
      } catch (reason) {
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

  const search = async (text: string) => {
    const trimmed = text.trim();
    searched = trimmed;
    if (!trimmed) { searchSeq += 1; papers = []; usedQuery.textContent = ""; clearFailure(); render(); return; }
    if (inflight) { pending = trimmed; return; }
    inflight = true;
    const seq = ++searchSeq;
    try {
      // Words are ANDed. An empty result drops the last word, up to MAX_RELAX
      // times, pausing between requests; the label then shows what was used.
      let terms = trimmed.split(/\s+/);
      let found: Paper[] = [];
      let used = trimmed;
      for (let attempt = 0; ; attempt += 1) {
        const result = await call<{ papers: Paper[]; query?: string; superseded?: boolean }>("search", { query: terms.join(" "), max: RESULT_COUNT });
        if (seq !== searchSeq || disposed || result.superseded) return;
        found = result.papers || [];
        used = result.query || terms.join(" ");
        if (found.length || attempt >= MAX_RELAX || terms.length < 2) break;
        terms = terms.slice(0, -1);
        await wait(RELAX_PAUSE_MS);
        if (seq !== searchSeq || disposed) return;
      }
      papers = found;
      usedQuery.textContent = found.length ? used : "";
      clearFailure();
      render();
    } catch (reason) {
      if (seq === searchSeq && !disposed) {
        papers = [];
        render();
        fail(describe(reason));
      }
    } finally {
      inflight = false;
      if (pending !== null && !disposed) { const next = pending; pending = null; void search(next); }
    }
  };

  const cancelTimer = () => {
    if (timer !== null) { window.clearTimeout(timer); timer = null; }
  };
  const searchNow = () => {
    cancelTimer();
    searched = null;
    void search(wanted);
  };
  const setQuery = (text: string) => {
    const typed = text.trim();
    // Only Latin words go to arXiv; with nothing typed, the words around the cursor.
    wanted = typed ? (hasLatin(typed) ? typed : "") : contextQuery;
    cancelTimer();
    if (wanted === searched) return;
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
