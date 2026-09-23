// The Save button shows whether edits are on disk: "Saved" with the time,
// "Save" with a dot while autosave is pending, "Saving…", or "Not saved" in
// red with the reason. A failed save also says so under the button, once,
// with a retry, since the Issues panel that used to carry it is often closed.

import { showEditorNotice } from "./editor-notice.js";
import { getUiLocale, onUiLocaleChange, setLocalizedAttribute, uiText } from "./i18n.js";
import { onSaveStatusChange, type SaveStatus } from "./save-status.js";

type SaveStatusUiDeps = {
  button: HTMLElement | null;
  getStatus: () => SaveStatus;
  saveDirtyFiles: () => Promise<boolean>;
  // macOS marks the window's close button while anything is unsaved.
  setDocumentEdited?: (edited: boolean) => void;
};

const fileName = (path: string | null) => (path ? path.split(/[\\/]/).pop() || path : null);

export const describeSaveFailure = (message: string) => {
  if (/EACCES|EPERM|permission denied|read-only|operation not permitted/i.test(message)) {
    return uiText("The file cannot be written (permission denied).", "ファイルに書き込めません（書き込みが許可されていません）。");
  }
  if (/ENOSPC|no space left/i.test(message)) {
    return uiText("The disk is full.", "ディスクの空き容量が足りません。");
  }
  if (/changed on disk/i.test(message)) {
    return uiText(
      "The file was changed by another app. Your text is kept in the editor.",
      "ほかのアプリがファイルを書き換えました。編集中の内容はエディタに残っています。",
    );
  }
  if (/edit conflict/i.test(message)) {
    return uiText("Resolve the edit conflict first.", "先に編集の競合を解決してください。");
  }
  if (/timed out/i.test(message)) {
    return uiText("The save did not finish in time.", "保存が時間内に終わりませんでした。");
  }
  return message;
};

export const setupSaveStatusUi = (deps: SaveStatusUiDeps) => {
  const button = deps.button;
  if (!(button instanceof HTMLButtonElement)) return;
  const label = button.querySelector<HTMLElement>("span");
  // Translated here per state; the page-wide translator must not rewrite it.
  label?.setAttribute("data-no-i18n", "");
  let lastKind: SaveStatus["kind"] | null = null;
  let lastStatus: SaveStatus | null = null;
  let dismissFailureNotice: (() => void) | null = null;
  let lastEdited: boolean | null = null;

  const formatTime = (ms: number) => {
    try {
      return new Date(ms).toLocaleTimeString(getUiLocale(), { hour: "2-digit", minute: "2-digit" });
    } catch {
      return new Date(ms).toLocaleTimeString();
    }
  };

  const retry = () => {
    void deps.saveDirtyFiles();
  };

  // A save usually finishes within a frame or two; "Saving…" only shows
  // when one takes long enough to be seen, not as a flicker per pause.
  const SAVING_VISIBLE_AFTER_MS = 300;
  let savingSince: number | null = null;
  let savingTimer: number | null = null;

  const render = () => {
    let status = deps.getStatus();
    if (status.kind === "saving") {
      savingSince ??= Date.now();
      if (Date.now() - savingSince < SAVING_VISIBLE_AFTER_MS) {
        if (savingTimer === null) {
          savingTimer = window.setTimeout(() => {
            savingTimer = null;
            render();
          }, SAVING_VISIBLE_AFTER_MS);
        }
        // Keep showing what was there (normally "Save" with its dot).
        status = lastKind === "saved" || lastKind === null
          ? { kind: "dirty", count: 1 }
          : lastStatus ?? { kind: "dirty", count: 1 };
      }
    } else {
      savingSince = null;
      if (savingTimer !== null) {
        window.clearTimeout(savingTimer);
        savingTimer = null;
      }
    }
    lastStatus = status;
    button.dataset.saveState = status.kind;
    let text: string;
    let title: string;
    switch (status.kind) {
      case "saved":
        text = uiText("Saved", "保存済み");
        title = status.savedAt
          ? uiText(`All changes saved (${formatTime(status.savedAt)})`, `すべて保存済み（${formatTime(status.savedAt)}）`)
          : uiText("No unsaved changes", "未保存の変更はありません");
        break;
      case "dirty":
        text = uiText("Save", "保存");
        title = uiText(
          `${status.count} file(s) not saved yet. Saving automatically…`,
          `未保存のファイルが ${status.count} 件あります。自動で保存します…`,
        );
        break;
      case "saving":
        text = uiText("Saving…", "保存中…");
        title = uiText(`Saving ${fileName(status.path)}…`, `${fileName(status.path)} を保存中…`);
        break;
      case "error": {
        text = uiText("Not saved", "保存できません");
        const name = fileName(status.path);
        title = `${name ? `${name}: ` : ""}${describeSaveFailure(status.message)}`;
        break;
      }
    }
    if (label) label.textContent = text;
    // Already localized; recorded as the attribute's source so the page-wide
    // translator does not put back the static "Save (Cmd+S)".
    setLocalizedAttribute(button, "title", `${title} (${uiText("Cmd+S to save", "Cmd+S で保存")})`);
    setLocalizedAttribute(button, "aria-label", title);
    if (status.kind !== "error" && dismissFailureNotice) {
      // Saved after all: the failure note is out of date.
      if (status.kind === "saved") {
        dismissFailureNotice();
        dismissFailureNotice = null;
      }
    }
    if (status.kind === "error" && lastKind !== "error") {
      const name = fileName(status.path);
      dismissFailureNotice = showEditorNotice(
        button,
        uiText(
          `Not saved${name ? `: ${name}` : ""}. ${describeSaveFailure(status.message)}`,
          `${name ? `${name} を` : ""}保存できませんでした。${describeSaveFailure(status.message)}`,
        ),
        { tone: "error", action: { label: uiText("Retry", "再試行"), run: retry }, durationMs: 10000 },
      );
    }
    lastKind = status.kind;
    const edited = status.kind !== "saved";
    if (edited !== lastEdited) {
      lastEdited = edited;
      deps.setDocumentEdited?.(edited);
    }
  };

  // After a failure the button retries every unsaved file, not just the
  // active one.
  button.addEventListener(
    "click",
    (event) => {
      if (deps.getStatus().kind !== "error") return;
      event.stopImmediatePropagation();
      retry();
    },
    true,
  );
  onSaveStatusChange(render);
  onUiLocaleChange(() => render());
  render();
};
