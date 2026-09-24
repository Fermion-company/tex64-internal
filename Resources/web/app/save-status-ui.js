// The Save button shows whether edits are on disk: "Saved" (time in the
// tooltip), "Save" with a dot while autosave is pending, "Saving…" when a save
// takes long enough to see, or "Not saved" in red with the reason. A failure
// also says so under the button, with Retry, since the Issues panel that used
// to carry it is often closed.
import { showEditorNotice } from "./editor-notice.js";
import { getUiLocale, onUiLocaleChange, setLocalizedAttribute, uiText } from "./i18n.js";
import { onSaveStatusChange } from "./save-status.js";
const fileName = (path) => (path ? path.split(/[\\/]/).pop() || path : null);
const SAVE_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd+S" : "Ctrl+S";
export const describeSaveFailure = (message) => {
    if (/EACCES|EPERM|permission denied|read-only|operation not permitted/i.test(message)) {
        return uiText("The file cannot be written (permission denied).", "ファイルに書き込めません（書き込みが許可されていません）。");
    }
    if (/ENOSPC|no space left/i.test(message)) {
        return uiText("The disk is full.", "ディスクの空き容量が足りません。");
    }
    if (/changed on disk/i.test(message)) {
        return uiText("The file was changed by another app. Your text is kept in the editor.", "ほかのアプリがファイルを書き換えました。編集中の内容はエディタに残っています。");
    }
    if (/edit conflict/i.test(message)) {
        return uiText("Resolve the edit conflict first.", "先に編集の競合を解決してください。");
    }
    if (/project operation is protecting|save has expired/i.test(message)) {
        return uiText("A project operation is in progress. Saving will resume when it finishes.", "プロジェクトの操作中です。終わると保存を再開します。");
    }
    if (/timed out/i.test(message)) {
        return uiText("The save did not finish in time.", "保存が時間内に終わりませんでした。");
    }
    return message;
};
const labelFor = (kind) => {
    switch (kind) {
        case "saved":
            return uiText("Saved", "保存済み");
        case "dirty":
            return uiText("Save", "保存");
        case "saving":
            return uiText("Saving…", "保存中…");
        case "error":
            return uiText("Not saved", "保存できません");
    }
};
export const setupSaveStatusUi = (deps) => {
    const button = deps.button;
    if (!(button instanceof HTMLButtonElement))
        return;
    const label = button.querySelector("span");
    // Translated here per state; the page-wide translator must not rewrite it.
    label === null || label === void 0 ? void 0 : label.setAttribute("data-no-i18n", "");
    let lastKind = null;
    let lastStatus = null;
    let lastEdited = null;
    let dismissFailureNotice = null;
    // One width for Saved / Save• / Saving… in the current language, so the
    // toolbar does not shift while typing. ("Not saved" may be wider; it is
    // rare and should stand out.)
    const fitLabelWidth = () => {
        if (!label)
            return;
        const style = getComputedStyle(label);
        const context = document.createElement("canvas").getContext("2d");
        if (!context)
            return;
        context.font = style.font;
        const spacing = Number.parseFloat(style.letterSpacing) || 0;
        const width = (text) => context.measureText(text).width + spacing * text.length;
        const dotWidth = 11; // the pending dot and its margin (theme.css)
        const widest = Math.max(width(labelFor("saved")), width(labelFor("dirty")) + dotWidth, width(labelFor("saving")));
        label.style.minWidth = `${Math.ceil(widest)}px`;
    };
    const formatTime = (ms) => {
        try {
            return new Date(ms).toLocaleTimeString(getUiLocale(), { hour: "2-digit", minute: "2-digit" });
        }
        catch {
            return new Date(ms).toLocaleTimeString();
        }
    };
    const showFailure = (status) => {
        if (status.kind !== "error")
            return;
        const name = fileName(status.path);
        dismissFailureNotice === null || dismissFailureNotice === void 0 ? void 0 : dismissFailureNotice();
        dismissFailureNotice = showEditorNotice(button, `${uiText("Could not save", "保存できませんでした")}${name ? `: ${name}` : ""} — ${describeSaveFailure(status.message)}`, {
            tone: "error",
            owner: "save",
            action: { label: uiText("Retry", "再試行"), run: retry },
            durationMs: 10000,
        });
    };
    const retry = () => {
        void deps.saveDirtyFiles().then((ok) => {
            // Say it again when the retry fails too; a silent retry reads as
            // "nothing happened".
            if (!ok)
                showFailure(deps.getStatus());
        });
    };
    // A save usually finishes within a frame or two; "Saving…" only shows
    // when one takes long enough to be seen, not as a flicker per pause.
    const SAVING_VISIBLE_AFTER_MS = 300;
    let savingSince = null;
    let savingTimer = null;
    const render = () => {
        var _a, _b;
        let status = deps.getStatus();
        if (status.kind === "saving") {
            savingSince !== null && savingSince !== void 0 ? savingSince : (savingSince = Date.now());
            if (Date.now() - savingSince < SAVING_VISIBLE_AFTER_MS) {
                if (savingTimer === null) {
                    savingTimer = window.setTimeout(() => {
                        savingTimer = null;
                        render();
                    }, SAVING_VISIBLE_AFTER_MS);
                }
                // Keep showing what was there (normally "Save" with its dot).
                status = lastStatus && lastStatus.kind !== "saved" ? lastStatus : { kind: "dirty", count: 1 };
            }
        }
        else {
            savingSince = null;
            if (savingTimer !== null) {
                window.clearTimeout(savingTimer);
                savingTimer = null;
            }
        }
        lastStatus = status;
        button.dataset.saveState = status.kind;
        let title;
        switch (status.kind) {
            case "saved":
                title = status.savedAt
                    ? `${uiText("All changes saved", "すべて保存済み")} (${formatTime(status.savedAt)})`
                    : uiText("No unsaved changes", "未保存の変更はありません");
                break;
            case "dirty":
                title = uiText("Unsaved changes. Saving automatically…", "未保存の変更があります。自動で保存します…");
                if (status.count > 1)
                    title += ` (${status.count})`;
                break;
            case "saving":
                title = `${uiText("Saving…", "保存中…")} ${(_a = fileName(status.path)) !== null && _a !== void 0 ? _a : ""}`.trim();
                break;
            case "error": {
                const name = fileName(status.path);
                title = `${name ? `${name}: ` : ""}${describeSaveFailure(status.message)}`;
                break;
            }
        }
        if (label)
            label.textContent = labelFor(status.kind);
        // Already localized; recorded as the attributes' source so the page-wide
        // translator does not put back the static "Save (Cmd+S)".
        setLocalizedAttribute(button, "title", `${title} (${SAVE_SHORTCUT})`);
        setLocalizedAttribute(button, "aria-label", `${uiText("Save", "保存")}: ${title}`);
        if (status.kind === "error" && lastKind !== "error")
            showFailure(status);
        if (status.kind === "saved" && dismissFailureNotice) {
            // Saved after all: the failure note is out of date.
            dismissFailureNotice();
            dismissFailureNotice = null;
        }
        lastKind = status.kind;
        const edited = status.kind !== "saved";
        if (edited !== lastEdited) {
            lastEdited = edited;
            (_b = deps.setDocumentEdited) === null || _b === void 0 ? void 0 : _b.call(deps, edited);
        }
    };
    // After a failure the button retries every unsaved file, not just the
    // active one.
    button.addEventListener("click", (event) => {
        if (deps.getStatus().kind !== "error")
            return;
        event.stopImmediatePropagation();
        retry();
    }, true);
    onSaveStatusChange(render);
    onUiLocaleChange(() => {
        fitLabelWidth();
        render();
    });
    fitLabelWidth();
    render();
};
