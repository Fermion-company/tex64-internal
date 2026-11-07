// "Find related papers on arXiv…": the editor's context-menu entry (.tex only)
// and its dialog. Searching and citing go through the tex64Arxiv bridge; no
// model call is involved. The dialog follows the History dialog's grammar.
import { uiText } from "./i18n.js";
import { buildArxivQuery, plainLatex } from "./arxiv-query.js";
import { citationDocumentFor, insertCitation } from "./citation-insert.js";
import type { EditorGroupState } from "./editor-session/types.js";

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
const documentChanged = () =>
  uiText("The document changed. Place the cursor again.", "文書が変更されました。カーソル位置を選び直してください。");

const describe = (reason: unknown, retry: "search" | "cite" = "search", activeFilePath: string | null = null): string => {
  const code = reason instanceof ArxivError ? reason.code : "";
  const withRetry = (message: string) => (retry === "search" ? `${message} ${uiText("Press Enter to retry.", "Enter で再試行してください。")}` : message);
  // The project closed while arXiv answered; nothing was written.
  if (code === "STALE_WORKSPACE") return documentChanged();
  // The .bib is written under the same lease as saves; Axiom holds it.
  if (code === "AGENT_WORKSPACE_BUSY") return uiText("Axiom is editing this project. Try again when it finishes.", "Axiom がこのプロジェクトを編集中です。終わってからもう一度お試しください。");
  // The file belongs to several documents with different .bib files; Build's
  // chooser (or a % !TEX root line) settles which one.
  if (code === "BUILD_TARGET_CHOICE") {
    return activeFilePath
      ? uiText(`${activeFilePath} belongs to more than one document.`, `${activeFilePath} は複数の文書から読み込まれています。`)
      : uiText("This folder has several documents and no main file is set.", "このフォルダには文書が複数あり、メイン TeX が決まっていません。");
  }
  if (code === "NETWORK") return withRetry(uiText("Cannot reach arXiv.", "arXiv に接続できません。"));
  if (code === "RATE_LIMIT") return withRetry(uiText("arXiv is busy.", "arXiv が混み合っています。"));
  if (code === "TIMEOUT") return withRetry(uiText("arXiv did not answer in time.", "arXiv の応答がありません。"));
  return reason instanceof Error ? reason.message : String(reason);
};

/** What the document still needs so BibTeX / biber finds the appended entry. */
const bibHint = (result: CiteResult): string => {
  if (!result.suggestion) return "";
  const where = result.suggestion.place === "preamble"
    ? uiText("Add %s to the preamble.", "プリアンブルに %s を加えてください。")
    : uiText("Add %s before \\end{document}.", "\\end{document} の前に %s を加えてください。");
  const lines = result.suggestion.lines.join(uiText(" and ", " と "));
  const head = result.created
    ? uiText(`Created ${result.bibPath}.`, `${result.bibPath} を作成しました。`)
    : uiText(`Appended to ${result.bibPath}.`, `${result.bibPath} に追記しました。`);
  return `${head} ${where.replace("%s", lines)}`;
};

const isTexModel = (editor: any) => /\.tex$/i.test(editor?.getModel?.()?.uri?.path || "");

let modalOpen = false;

export const attachArxivSearch = (editor: any, group: EditorGroupState) => {
  if (!bridge() || typeof editor?.addAction !== "function") return;
  const texKey = editor.createContextKey?.(CONTEXT_KEY, isTexModel(editor));
  editor.onDidChangeModel?.(() => texKey?.set(isTexModel(editor)));
  editor.addAction({
    id: "tex64.arxiv.search",
    label: uiText("Search arXiv…", "arXiv を検索…"),
    contextMenuGroupId: "9_cite",
    contextMenuOrder: 1,
    // A view-only guest's .bib is the host's; nothing is cited from there.
    precondition: texKey ? `${CONTEXT_KEY} && !tex64CollabViewer` : "!tex64CollabViewer",
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
  const heading = el("h2", "", "arXiv");
  heading.id = "arxiv-search-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  const query = el("input", "history-name");
  query.type = "text";
  query.value = initialQuery;
  query.placeholder = uiText("Search in English", "英語で検索");
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
  // The "add \bibliography…" hint stays until the next search; later cites keep it.
  let hintShown = false;

  const setStatus = (text: string) => { status.textContent = text; };
  const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  const askForEnglish = () => {
    setStatus(uiText("Enter English words.", "英語で入力してください。"));
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
        side.append(el("p", "arxiv-row-meta", uiText(`Already in ${result.bibPath}.`, `${result.bibPath} に既にあります。`)));
      }
    };
    const done = cited.get(paper.arxivId);
    if (done) { showCited(done.result, done.inserted); return row; }

    const cite = button(uiText("Cite", "引用"), () => void (async () => {
      cite.disabled = true;
      if (!hintShown) setStatus("");
      const activeFilePath = group.currentFilePath;
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
        const hint = bibHint(result);
        if (hint) { setStatus(hint); hintShown = true; }
      } catch (reason) {
        cite.disabled = false;
        setStatus(describe(reason, "cite", activeFilePath));
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
    hintShown = false;
    const seq = ++searchSeq;
    setStatus(uiText("Searching…", "検索中…"));
    try {
      // Words are ANDed. An empty result drops the last word, up to MAX_RELAX
      // times, pausing between requests; the field then shows what was used.
      let terms = trimmed.split(/\s+/);
      let found: Paper[] = [];
      let used = trimmed;
      for (let attempt = 0; ; attempt += 1) {
        const result = await call<{ papers: Paper[]; query?: string; superseded?: boolean }>("search", { query: terms.join(" "), max: RESULT_COUNT });
        if (seq !== searchSeq || result.superseded) return;
        found = result.papers || [];
        used = result.query || terms.join(" ");
        if (found.length || attempt >= MAX_RELAX || terms.length < 2) break;
        terms = terms.slice(0, -1);
        setStatus(uiText(`Retrying with “${terms.join(" ")}”…`, `「${terms.join(" ")}」で再検索中…`));
        await wait(RELAX_PAUSE_MS);
        if (seq !== searchSeq || !dialog.open) return;
      }
      papers = found;
      // Only a hit replaces the field; an empty result leaves the user's words.
      if (found.length && used !== trimmed && query.value.trim() === trimmed) query.value = used;
      render();
      setStatus(found.length ? "" : uiText("No matches", "見つかりません"));
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
