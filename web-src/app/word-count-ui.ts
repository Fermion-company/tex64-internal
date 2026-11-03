// File › Word Count…: one dialog with the counts of the document the active
// file belongs to (main file and every file it reads), of the active file
// when that is only part of it, and of the selection. Counting happens in
// the main process (electron/services/word-count.cjs) on the saved files,
// with the unsaved editor buffers sent along.

import { uiText } from "./i18n.js";
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

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  };
  const number = (value: number) => value.toLocaleString();

  const render = (result: CountResult | null, activePath: string | null) => {
    if (!dialog) return;
    const title = el("h2", "", uiText("Word Count", "文字数"));
    title.id = "word-count-title";
    dialog.setAttribute("aria-labelledby", title.id);
    const body = el("div", "word-count-body");
    if (!result) {
      body.append(el("p", "history-local", uiText("Counting…", "数えています…")));
    } else if (!result.ok) {
      body.append(el("p", "history-error", result.error || uiText("Could not count.", "数えられませんでした。")));
    } else if (!result.document && !result.selection) {
      body.append(el("p", "history-local", uiText("Open a .tex file first.", ".tex ファイルを開いてください。")));
    } else {
      const columns: Array<{ label: string; counts: Counts }> = [];
      const documentCounts = result.document;
      if (documentCounts && documentCounts.files.length) {
        columns.push({ label: uiText("Document", "文書全体"), counts: documentCounts.total });
        const active = documentCounts.files.find((file) => file.path === activePath);
        if (active && documentCounts.files.length > 1) columns.push({ label: uiText("This file", "このファイル"), counts: active });
      }
      if (result.selection) columns.push({ label: uiText("Selection", "選択範囲"), counts: result.selection });
      const table = el("table", "word-count-table");
      const head = el("tr");
      head.append(el("th"));
      for (const column of columns) head.append(el("th", "", column.label));
      table.append(head);
      const rows: Array<[string, (counts: Counts) => string]> = [
        [uiText("Words", "単語"), (counts) => number(counts.words)],
        [uiText("Characters (no spaces)", "文字（空白を除く）"), (counts) => number(counts.characters)],
        [uiText("Headings", "見出し"), (counts) => number(counts.headings)],
        [uiText("Math (inline / display)", "数式（行内 / 別行）"), (counts) => `${number(counts.inlineMath)} / ${number(counts.displayMath)}`],
      ];
      for (const [label, value] of rows) {
        const row = el("tr");
        row.append(el("th", "", label));
        for (const column of columns) row.append(el("td", "", value(column.counts)));
        table.append(row);
      }
      body.append(table);
      if (documentCounts && documentCounts.files.length) {
        const others = documentCounts.files.length - 1;
        const scope = el("p", "history-local", others > 0
          ? uiText(`${documentCounts.mainFile} and the ${others} file${others === 1 ? "" : "s"} it reads. Comments, math and commands are not counted.`, `${documentCounts.mainFile} と読み込み先 ${others} ファイル。コメント・数式・コマンドは数えません。`)
          : uiText(`${documentCounts.mainFile}. Comments, math and commands are not counted.`, `${documentCounts.mainFile}。コメント・数式・コマンドは数えません。`));
        scope.dataset.noI18n = "true";
        body.append(scope);
      }
    }
    const actions = el("div", "history-confirm-actions");
    const close = el("button", "history-button", uiText("Close", "閉じる"));
    close.type = "button";
    close.addEventListener("click", () => dialog?.close());
    actions.append(close);
    dialog.replaceChildren(title, body, actions);
    close.focus();
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
      dialog = el("dialog", "history-confirm word-count-dialog");
      dialog.addEventListener("close", () => {
        dialog?.remove();
        dialog = null;
      });
      document.body.append(dialog);
      dialog.showModal();
    }
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
