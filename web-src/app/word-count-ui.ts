// File › Word Count…: one dialog with the counts of the document the active
// file belongs to (main file and every file it reads), of the active file
// when that is only part of it, and of the selection. Counting happens in
// the main process (electron/services/word-count.cjs) on the saved files,
// with the unsaved editor buffers sent along.

import { getUiLocale, uiText } from "./i18n.js";
import { explainedHeading } from "./explain.js";
import { markFocus, restoreFocus } from "./focus-key.js";
import type { EditorSessionApi } from "./editor-session.js";

type Counts = { words: number; characters: number; headings: number; inlineMath: number; displayMath: number };
type FileCounts = Counts & { path: string };
type CountResult = {
  ok: boolean;
  error?: string;
  document: { mainFile: string; files: FileCounts[]; total: Counts } | null;
  selection: Counts | null;
};

const bridge = (window as unknown as { tex64WordCount?: { count: (request: Record<string, unknown>) => Promise<CountResult> } }).tex64WordCount ?? null;

export const initWordCountUi = (deps: {
  editorSession: () => EditorSessionApi;
  documentFor: (path: string) => string | undefined;
}) => {
  let dialog: HTMLDialogElement | null = null;
  // Changing the scope rebuilds the dialog; the title's ▾ stays as the user left it.
  const explainOpen = new Set<string>();

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  };
  const number = (value: number) => value.toLocaleString();

  // The scope shown when the dialog last rendered; kept across re-renders.
  let scope: "document" | "file" | "selection" = "document";

  const stat = (value: string, name: string, major = false, unit = "") => {
    const box = el("div", `word-count-stat${major ? " is-major" : ""}`);
    const figure = el("span", "word-count-value", value);
    if (unit) figure.append(el("small", "", unit));
    box.append(figure, el("span", "word-count-name", name));
    return box;
  };

  const render = (result: CountResult | null, activePath: string | null) => {
    if (!dialog) return;
    const eyebrow = el("p", "tool-dialog-eyebrow", "Word count");
    let titleExplain = "";
    const title = el("h2", "tool-dialog-title", uiText("Word Count", "文字数"));
    title.id = "word-count-title";
    dialog.setAttribute("aria-labelledby", title.id);
    const body = el("div", "word-count-body");
    if (!result) {
      body.append(el("p", "tool-dialog-note", uiText("Counting…", "数えています…")));
    } else if (!result.ok) {
      body.append(el("p", "tool-dialog-error", result.error || uiText("Could not count.", "数えられませんでした。")));
    } else if (!result.document && !result.selection) {
      body.append(el("p", "tool-dialog-note", uiText("Open a .tex file first.", ".tex ファイルを開いてください。")));
    } else {
      const documentCounts = result.document && result.document.files.length ? result.document : null;
      // "This file" only for a part of the document, not for its main file.
      const active = documentCounts && activePath !== documentCounts.mainFile
        ? documentCounts.files.find((file) => file.path === activePath) ?? null
        : null;
      const scopes: Array<{ id: typeof scope; label: string; counts: Counts }> = [];
      if (documentCounts) scopes.push({ id: "document", label: uiText("Document", "文書全体"), counts: documentCounts.total });
      if (active) scopes.push({ id: "file", label: uiText("This file", "このファイル"), counts: active });
      if (result.selection) scopes.push({ id: "selection", label: uiText("Selection", "選択範囲"), counts: result.selection });
      if (!scopes.some((entry) => entry.id === scope)) scope = scopes[0].id;
      if (documentCounts) {
        const others = documentCounts.files.length - 1;
        const detail = el("span", "tool-dialog-eyebrow-detail", others > 0
          ? `· ${documentCounts.mainFile} + ${others}`
          : `· ${documentCounts.mainFile}`);
        detail.dataset.noI18n = "true";
        eyebrow.append(detail);
      }
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
      const counts = scopes.find((entry) => entry.id === scope)!.counts;
      const characters = stat(number(counts.characters), uiText("Characters (no spaces)", "文字（空白を除く）"), true);
      const words = stat(number(counts.words), uiText("Words", "単語"), true);
      const grid = el("div", "word-count-stats");
      // The measure Japanese manuscripts use comes first in Japanese.
      grid.append(...(getUiLocale() === "ja" ? [characters, words] : [words, characters]));
      grid.append(
        stat(number(counts.headings), uiText("Headings", "見出し")),
        stat(`${number(counts.inlineMath)} / ${number(counts.displayMath)}`, uiText("Math (inline / display)", "数式（行内 / 別行）")),
      );
      body.append(grid);
      const scopeNote = scope === "document" && documentCounts && documentCounts.files.length > 1
        ? uiText(`${documentCounts.mainFile} and the ${documentCounts.files.length - 1} file${documentCounts.files.length === 2 ? "" : "s"} it reads. `, `${documentCounts.mainFile} と読み込み先 ${documentCounts.files.length - 1} ファイル。`)
        : "";
      // Which files were counted is state; what is left out waits behind the title's ▾.
      if (scopeNote) {
        const note = el("p", "tool-dialog-note", scopeNote.trim());
        note.dataset.noI18n = "true";
        body.append(note);
      }
      titleExplain = uiText("Comments, math and commands are not counted.", "コメント・数式・コマンドは数えません。");
    }
    const actions = el("div", "tool-dialog-actions");
    const close = el("button", "tool-button", uiText("Close", "閉じる"));
    close.type = "button";
    close.addEventListener("click", () => dialog?.close());
    close.dataset.focusKey = "close";
    actions.append(close);
    // Changing the scope rebuilds the dialog: focus stays on the control the
    // user was on; Close takes it on opening.
    const focusMark = markFocus(dialog);
    dialog.replaceChildren(eyebrow, ...(titleExplain ? explainedHeading(title, titleExplain, { memory: explainOpen, key: "title" }) : [title]), body, actions);
    if (!restoreFocus(dialog, focusMark)) close.focus();
  };

  const open = async () => {
    if (!bridge) return;
    const editorSession = deps.editorSession();
    const activePath = editorSession.getActiveFilePath();
    const selection = editorSession.getActiveSelectionSnapshot();
    const buffers: Record<string, string> = {};
    for (const snapshot of editorSession.getOpenFileSnapshots({ onlyDirty: true, maxFiles: 0, maxChars: 8 * 1024 * 1024 }).snapshots) {
      if (!snapshot.truncated) buffers[snapshot.path] = snapshot.content;
    }
    if (!dialog) {
      dialog = el("dialog", "tool-dialog word-count-dialog");
      dialog.addEventListener("close", () => {
        dialog?.remove();
        dialog = null;
        explainOpen.clear();
      });
      document.body.append(dialog);
      dialog.showModal();
    }
    scope = "document";
    render(null, activePath);
    let result: CountResult;
    try {
      result = await bridge.count({
        activeFilePath: activePath && /\.tex$/i.test(activePath) ? activePath : "",
        documentMainFile: activePath ? deps.documentFor(activePath) ?? "" : "",
        selection: selection?.text?.trim() ? selection.text : "",
        buffers,
      });
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error), document: null, selection: null };
    }
    render(result, activePath);
  };

  return { open };
};
