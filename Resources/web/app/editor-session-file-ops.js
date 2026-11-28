import { isImageFilePath, isPdfFilePath, } from "./files.js";
import { buildLineDiff } from "./diff.js";
import { getUiLocale, uiText } from "./i18n.js";
import { trackLiveEditModel } from "./editor-session/live-edit-history.js";
import { rememberEditorModelPath } from "./editor-session/model-path.js";
import { applyHunks, rebaseHunks } from "./editor-session/text-merge.js";
import { notifySaveStatusChange } from "./save-status.js";
export const createEditorSessionFileOps = (ctx) => {
    var _a;
    let lastSaveErrorMessage = null;
    const contentConflicts = new Map();
    let reopenNextContentConflict = () => { };
    const { deps, editorGroups, monacoModels, dirtyFiles, state, getActiveEditorGroupKey, getActiveGroup, getEditorGroup, isActiveGroup, resolveAutoOpenGroupKey, findGroupKeyByPath, setSplitViewEnabled, cacheCurrentBuffer, clearJumpHighlight, clearTemporaryTabs, addOpenTab, updateDirtyState, restoreViewState, setEditorLanguage, updateBreadcrumbs, updateMiniOutline, revealLine, forEachEditorGroup, scheduleAfterComposition, getLanguageIdForPath, } = ctx;
    const now = (_a = ctx.now) !== null && _a !== void 0 ? _a : (() => Date.now());
    let nextOpenRequestId = 0;
    let openScope = 0;
    const latestOpen = new Map();
    const clearOpenRequests = () => {
        state.pendingOpenRequests.length = 0;
        latestOpen.clear();
        openScope += 1;
    };
    // When each model was last edited from the keyboard (or IME, or the live
    // preview), and where. Edits applied from outside the keyboard run with
    // isApplyingFile set on every group and are not typing.
    const typing = new WeakMap();
    const watchedForTyping = new WeakSet();
    const watchTyping = (model) => {
        if (watchedForTyping.has(model) || !model.onDidChangeContent)
            return;
        watchedForTyping.add(model);
        model.onDidChangeContent((event) => {
            var _a;
            if (event.isFlush)
                return;
            if (Object.values(editorGroups).some((group) => group.isApplyingFile))
                return;
            const change = (_a = event.changes) === null || _a === void 0 ? void 0 : _a[0];
            typing.set(model, { at: now(), offset: change ? change.rangeOffset + change.text.length : null });
        });
    };
    // Files whose autosave waits: an Axiom edit to the paragraph being typed is
    // held until a pause (outside-edits.ts), and until it is applied the editor
    // text is not based on the disk any more. `release` applies it (or shows the
    // conflict choices) at once; an explicit save or a Build calls it.
    const heldSaves = new Map();
    // Files whose save was refused because the disk changed: until when that
    // stays quiet (reportSaveError).
    const diskChangeQuietUntil = new Map();
    const DISK_CHANGE_QUIET_MS = 3000;
    // Why each file's last save failed. An entry lasts until that file saves
    // or stops being dirty: another file saving says nothing about it.
    const saveErrors = new Map();
    let lastSavedAt = null;
    // A failed file keeps trying on its own (2 s, 4 s, ... up to 30 s): the
    // cause is often passing (a sync client or a project operation holding it).
    let saveRetryTimer = null;
    let saveRetryDelayMs = 0;
    const hasFailedDirtyFile = () => Array.from(saveErrors.keys()).some((path) => dirtyFiles.has(path));
    const scheduleSaveRetry = () => {
        if (saveRetryTimer !== null)
            return;
        saveRetryDelayMs = Math.min(30000, saveRetryDelayMs > 0 ? saveRetryDelayMs * 2 : 2000);
        saveRetryTimer = window.setTimeout(() => {
            saveRetryTimer = null;
            if (hasFailedDirtyFile())
                void saveDirtyFiles({ auto: true }).catch(() => { });
        }, saveRetryDelayMs);
    };
    const reportSaveError = (message, path = null) => {
        // A file waiting for the person's choice (its conflict bar) or for a
        // typing pause (held Axiom edit) is a state, not a save failure: its
        // autosave being refused against the newer disk text says nothing new.
        if (path && (heldSaves.has(path) || contentConflicts.has(path)))
            return;
        // The disk changed under this save: the watcher's notice of that change
        // follows within a moment and either merges it into the buffer or opens
        // the conflict choices. Give it that moment before calling it a failure.
        if (path && /changed on disk/i.test(message)) {
            const quietUntil = diskChangeQuietUntil.get(path);
            if (quietUntil === undefined || now() < quietUntil) {
                if (quietUntil === undefined)
                    diskChangeQuietUntil.set(path, now() + DISK_CHANGE_QUIET_MS);
                window.setTimeout(() => {
                    if (dirtyFiles.has(path))
                        void saveDirtyFiles({ auto: true }).catch(() => { });
                }, DISK_CHANGE_QUIET_MS + 100);
                return;
            }
        }
        // A retry failing the same way leaves Issues alone: it would replace the
        // build's warnings every few seconds. (Retries differ only in the
        // temporary file name.) `lastSaveErrorMessage` is what Issues shows, so
        // a later success can take exactly that down.
        const kind = (text) => text.replace(/\.[^\s'"/\\]+\.tmp-[\w.-]+/g, "");
        const previous = path ? saveErrors.get(path) : lastSaveErrorMessage;
        if (typeof previous !== "string" || kind(previous) !== kind(message)) {
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
            lastSaveErrorMessage = message;
        }
        if (path) {
            saveErrors.set(path, message);
            scheduleSaveRetry();
        }
        notifySaveStatusChange();
    };
    // A save rejects with the host's message as a string.
    const saveFailureMessage = (error) => typeof error === "string" && error
        ? error
        : error instanceof Error && error.message
            ? error.message
            : "Saving failed.";
    // Save by hand (Cmd+S, Retry, Build/History/Git) on a file whose conflict
    // choices are open: say why, through the save status (its notice names the
    // file), not as an issue.
    const CONFLICT_SAVE_MESSAGE = uiText("Resolve the edit conflict before saving.", "保存する前に編集競合を解決してください。");
    const refuseConflictedSave = (path) => {
        saveErrors.set(path, CONFLICT_SAVE_MESSAGE);
        notifySaveStatusChange();
    };
    const clearOwnSaveError = () => {
        var _a;
        if (lastSaveErrorMessage === null)
            return;
        const snapshot = (_a = deps.getRecentIssuesSnapshot) === null || _a === void 0 ? void 0 : _a.call(deps);
        const stillOurs = !snapshot ||
            (snapshot.status === "error" &&
                snapshot.issues.length === 1 &&
                snapshot.issues[0].message === lastSaveErrorMessage);
        if (stillOurs)
            deps.updateIssues(0, "", "info", []);
        lastSaveErrorMessage = null;
        notifySaveStatusChange();
    };
    const clearContentConflicts = () => {
        var _a;
        contentConflicts.clear();
        notifySaveStatusChange();
        (_a = document.getElementById("ai-content-conflict-bar")) === null || _a === void 0 ? void 0 : _a.remove();
        clearOwnSaveError();
    };
    // `expectedContent` left out: what is on disk is whatever this editor last
    // saved, read when the save leaves the queue. Reading it when the save was
    // queued went stale once an earlier save of the same file landed, and the
    // host then reported a change "by another app" that was only our own save.
    const savePathContent = (path, value, timeoutMs = 8000, expectedContent) => new Promise((resolve, reject) => {
        var _a, _b;
        const identity = ((_b = (_a = window.tex64History) === null || _a === void 0 ? void 0 : _a.getIdentity) === null || _b === void 0 ? void 0 : _b.call(_a)) || {};
        const startedAt = Date.now();
        const enqueue = () => {
            var _a;
            if (state.pendingSave) {
                if (Date.now() - startedAt >= timeoutMs) {
                    reject("Waiting for save timed out.");
                    return;
                }
                window.setTimeout(enqueue, 25);
                return;
            }
            const lastSaved = (_a = monacoModels.get(path)) === null || _a === void 0 ? void 0 : _a.savedContent;
            if (expectedContent === undefined && typeof lastSaved === "string" && lastSaved === value) {
                // An earlier queued save already wrote exactly this.
                resolve(true);
                return;
            }
            const expected = expectedContent === undefined ? lastSaved : expectedContent;
            state.pendingSave = { path, content: value, resolve, reject };
            notifySaveStatusChange();
            const safetyTimer = window.setTimeout(() => {
                if (state.pendingSave && state.pendingSave.path === path) {
                    console.warn(`[file-ops] pendingSave safety timeout for "${path}"`);
                    state.pendingSave.reject("Timed out waiting for a save response.");
                    state.pendingSave = null;
                    notifySaveStatusChange();
                }
            }, 30000);
            const origResolve = resolve;
            const origReject = reject;
            state.pendingSave.resolve = (result) => {
                clearTimeout(safetyTimer);
                origResolve(result);
            };
            state.pendingSave.reject = (error) => {
                clearTimeout(safetyTimer);
                origReject(error);
            };
            const ok = deps.postToNative({
                ...identity,
                type: "saveFile",
                path,
                content: value,
                ...(typeof expected === "string" ? { expectedContent: expected } : {}),
                format: false,
            });
            if (!ok) {
                clearTimeout(safetyTimer);
                state.pendingSave = null;
                notifySaveStatusChange();
                reject("Native integration is not available.");
            }
        };
        enqueue();
    });
    /**
     * Replace model content via executeEdits (preserves undo stack) when available,
     * falling back to setValue (clears undo stack) otherwise.
     */
    const replaceContentViaEdits = (editor, model, newContent, source) => {
        var _a, _b, _c, _d;
        if ((editor === null || editor === void 0 ? void 0 : editor.executeEdits) && (model === null || model === void 0 ? void 0 : model.getFullModelRange)) {
            const fullRange = model.getFullModelRange();
            if (fullRange) {
                (_a = model.pushStackElement) === null || _a === void 0 ? void 0 : _a.call(model);
                editor.executeEdits(source, [
                    { range: fullRange, text: newContent, forceMoveMarkers: true },
                ]);
                (_b = model.pushStackElement) === null || _b === void 0 ? void 0 : _b.call(model);
                return;
            }
        }
        if ((model === null || model === void 0 ? void 0 : model.pushEditOperations) && model.getFullModelRange) {
            const fullRange = model.getFullModelRange();
            if (fullRange) {
                (_c = model.pushStackElement) === null || _c === void 0 ? void 0 : _c.call(model);
                model.pushEditOperations([], [{ range: fullRange, text: newContent, forceMoveMarkers: true }], () => null);
                (_d = model.pushStackElement) === null || _d === void 0 ? void 0 : _d.call(model);
                return;
            }
        }
        if (model === null || model === void 0 ? void 0 : model.setValue) {
            model.setValue(newContent);
            return;
        }
        if (editor === null || editor === void 0 ? void 0 : editor.setValue) {
            editor.setValue(newContent);
        }
    };
    // Keeps the first visible line's text where it is on screen when lines are
    // added or removed above it (a decoration follows that text through the
    // edit). Monaco itself keeps the pixel offset, which slides the page.
    const anchorViewport = (editor, model) => {
        var _a, _b, _c;
        const top = (_c = (_b = (_a = editor === null || editor === void 0 ? void 0 : editor.getVisibleRanges) === null || _a === void 0 ? void 0 : _a.call(editor)) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.startLineNumber;
        if (!top || !(editor === null || editor === void 0 ? void 0 : editor.getScrollTop) || !editor.setScrollTop || !editor.getTopForLineNumber ||
            !model.deltaDecorations || !model.getDecorationRange)
            return () => { };
        const offset = editor.getScrollTop() - editor.getTopForLineNumber(top);
        const [id] = model.deltaDecorations([], [{
                range: { startLineNumber: top, startColumn: 1, endLineNumber: top, endColumn: 1 },
                options: { stickiness: 1 }, // NeverGrowsWhenTypingAtEdges: stays with the text
            }]);
        return () => {
            const moved = id ? model.getDecorationRange(id) : null;
            if (id)
                model.deltaDecorations([id], []);
            if (moved && moved.startLineNumber !== top) {
                editor.setScrollTop(editor.getTopForLineNumber(moved.startLineNumber) + offset);
            }
        };
    };
    // Applies only the changed ranges, as one undo step. Monaco moves the caret,
    // selections, markers and decorations with the text they belong to, so a
    // writer outside the keyboard does not relocate the person typing. Returns
    // false when the model cannot take ranged edits.
    const applyRangedEdits = (editor, model, hunks, source) => {
        var _a, _b;
        if (!model.getPositionAt || (!(editor === null || editor === void 0 ? void 0 : editor.executeEdits) && !model.pushEditOperations))
            return false;
        if (hunks.length === 0)
            return true;
        const edits = hunks.map((hunk) => {
            const start = model.getPositionAt(hunk.start);
            const end = model.getPositionAt(hunk.end);
            return {
                range: {
                    startLineNumber: start.lineNumber,
                    startColumn: start.column,
                    endLineNumber: end.lineNumber,
                    endColumn: end.column,
                },
                text: hunk.text,
                forceMoveMarkers: false,
            };
        });
        const restoreViewport = anchorViewport(editor, model);
        (_a = model.pushStackElement) === null || _a === void 0 ? void 0 : _a.call(model);
        // A read-only editor (a project operation in progress) refuses
        // executeEdits; the disk changed regardless, so edit the model.
        const viaEditor = (editor === null || editor === void 0 ? void 0 : editor.executeEdits) ? editor.executeEdits(source, edits) !== false : false;
        if (!viaEditor) {
            if (!model.pushEditOperations) {
                restoreViewport();
                return false;
            }
            model.pushEditOperations([], edits, () => null);
        }
        (_b = model.pushStackElement) === null || _b === void 0 ? void 0 : _b.call(model);
        restoreViewport();
        return true;
    };
    // [start, end) of the blank-line delimited paragraph around `offset`.
    const paragraphAround = (text, offset) => {
        const lineIsBlank = (from, to) => text.slice(from, to).trim() === "";
        let start = text.lastIndexOf("\n", offset - 1) + 1;
        while (start > 0) {
            const previousStart = text.lastIndexOf("\n", start - 2) + 1;
            if (lineIsBlank(previousStart, start - 1))
                break;
            start = previousStart;
        }
        let end = text.indexOf("\n", offset);
        if (end < 0)
            end = text.length;
        while (end < text.length) {
            let nextEnd = text.indexOf("\n", end + 1);
            if (nextEnd < 0)
                nextEnd = text.length;
            if (lineIsBlank(end + 1, nextEnd))
                break;
            end = nextEnd;
        }
        return [start, end];
    };
    // Monaco hides an encoding BOM and keeps one line-break style; compare and
    // diff disk text in the model's form.
    const inModelForm = (model, bufferValue, text) => {
        var _a;
        const eol = ((_a = model.getEOL) === null || _a === void 0 ? void 0 : _a.call(model)) === "\r\n" ? "\r\n" : "\n";
        const unified = text.replace(/\r\n|\r|\n/g, eol);
        return unified.charCodeAt(0) === 0xfeff && bufferValue.charCodeAt(0) !== 0xfeff ? unified.slice(1) : unified;
    };
    const applyViewerFile = (group, path, kind, data, mimeType, position) => {
        group.currentFilePath = path;
        group.currentFileSavedContent = null;
        group.isDirty = false;
        dirtyFiles.delete(path);
        addOpenTab(group, path, position);
        clearTemporaryTabs(group, path);
        deps.editorTabs.render(group);
        if (isActiveGroup(group)) {
            deps.fileTree.setSelection(path, "file");
            updateBreadcrumbs();
            updateMiniOutline();
            deps.outline.render();
            deps.fileTree.render();
        }
        deps.setBlockPreviewActive(false);
        deps.setAutoDetectedUi(false);
        if (state.pendingReveal &&
            state.pendingReveal.path === path &&
            state.pendingReveal.group === group.key) {
            state.pendingReveal = null;
        }
        if (kind === "image") {
            group.viewer.showImageViewer(path, data, mimeType);
        }
        else {
            group.viewer.showPdfViewer(path, data, mimeType, !isActiveGroup(group));
        }
        if (isActiveGroup(group)) {
            deps.buildOps.updateSynctexButtonState();
            deps.fileTree.setTreeFocus(false);
        }
    };
    const applyUnsupportedFile = (group, path, position) => {
        group.currentFilePath = path;
        group.currentFileSavedContent = null;
        const keepDirty = monacoModels.has(path) && dirtyFiles.has(path);
        group.isDirty = keepDirty;
        if (!keepDirty) {
            dirtyFiles.delete(path);
        }
        addOpenTab(group, path, position);
        clearTemporaryTabs(group, path);
        deps.editorTabs.render(group);
        if (isActiveGroup(group)) {
            deps.fileTree.setSelection(path, "file");
            updateBreadcrumbs();
            updateMiniOutline();
            deps.outline.render();
            deps.fileTree.render();
        }
        deps.setBlockPreviewActive(false);
        deps.setAutoDetectedUi(false);
        if (state.pendingReveal &&
            state.pendingReveal.path === path &&
            state.pendingReveal.group === group.key) {
            state.pendingReveal = null;
        }
        group.viewer.showUnsupportedViewer();
        if (isActiveGroup(group)) {
            deps.buildOps.updateSynctexButtonState();
            deps.fileTree.setTreeFocus(false);
        }
    };
    const ensureModelEntry = (path, content, savedContent, plainText) => {
        var _a, _b;
        const monacoApi = deps.getMonacoApi();
        if (!monacoApi) {
            return null;
        }
        const entry = monacoModels.get(path);
        if (entry) {
            if (plainText !== undefined)
                entry.plainText = plainText;
            rememberEditorModelPath(entry.model, path);
            trackLiveEditModel(entry.model);
            watchTyping(entry.model);
            const isEntryDirty = dirtyFiles.has(path);
            if (!isEntryDirty && savedContent !== undefined && entry.savedContent !== savedContent) {
                entry.model.setValue(content);
                entry.savedContent = savedContent;
                updateDirtyState(path, content, savedContent);
            }
            return entry;
        }
        const monacoApiAny = monacoApi;
        if (!((_a = monacoApiAny.editor) === null || _a === void 0 ? void 0 : _a.createModel)) {
            return null;
        }
        // Create models with a file:// URI so the LSP layer (texlab) can identify
        // documents and resolve cross-file references (\input, .bib) by path.
        const uri = ((_b = monacoApiAny.Uri) === null || _b === void 0 ? void 0 : _b.file) ? monacoApiAny.Uri.file(path) : undefined;
        const existing = uri && monacoApiAny.editor.getModel ? monacoApiAny.editor.getModel(uri) : null;
        const model = (existing !== null && existing !== void 0 ? existing : monacoApiAny.editor.createModel(content, plainText ? "plaintext" : getLanguageIdForPath(path), uri));
        rememberEditorModelPath(model, path);
        trackLiveEditModel(model);
        watchTyping(model);
        const nextEntry = { model, savedContent: savedContent !== null && savedContent !== void 0 ? savedContent : content, plainText };
        monacoModels.set(path, nextEntry);
        updateDirtyState(path, content, nextEntry.savedContent);
        return nextEntry;
    };
    const applyFileContent = (group, path, entry, position) => {
        if (!group.editor || !entry) {
            deps.updateFallback("Editor is not ready.");
            return;
        }
        const editor = group.editor;
        group.viewer.hideViewer();
        if (isActiveGroup(group)) {
            clearJumpHighlight(group);
        }
        group.currentFilePath = path;
        group.currentFileSavedContent = entry.savedContent;
        group.isApplyingFile = true;
        try {
            editor.setModel(entry.model);
        }
        finally {
            group.isApplyingFile = false;
        }
        updateDirtyState(path, entry.model.getValue(), entry.savedContent);
        restoreViewState(group, path);
        addOpenTab(group, path, position);
        clearTemporaryTabs(group, path);
        deps.editorTabs.render(group);
        if (isActiveGroup(group)) {
            deps.fileTree.setSelection(path, "file");
            updateBreadcrumbs();
            updateMiniOutline();
            deps.outline.render();
            deps.fileTree.render();
        }
        deps.setBlockPreviewActive(false);
        deps.setAutoDetectedUi(false);
        if (state.pendingReveal &&
            state.pendingReveal.path === path &&
            state.pendingReveal.group === group.key) {
            revealLine(group, state.pendingReveal.line, {
                focus: state.pendingReveal.focus,
                className: state.pendingReveal.className,
                column: state.pendingReveal.column,
            });
            state.pendingReveal = null;
        }
        if (isActiveGroup(group) && editor.focus) {
            editor.focus();
            deps.fileTree.setTreeFocus(false);
        }
        if (isActiveGroup(group)) {
            deps.buildOps.updateSynctexButtonState();
        }
        if (contentConflicts.has(path))
            showPendingConflict(group, path);
    };
    // Track active AI diff decorations per editor group
    const aiDiffDecorations = new Map();
    const clearAiDiffDecorations = (group) => {
        const editorAny = group.editor;
        const key = group.key;
        const ids = aiDiffDecorations.get(key);
        if (ids && ids.length > 0 && (editorAny === null || editorAny === void 0 ? void 0 : editorAny.deltaDecorations)) {
            editorAny.deltaDecorations(ids, []);
            aiDiffDecorations.delete(key);
        }
        // Remove Undo/Keep bar
        const bar = document.getElementById("ai-undo-keep-bar");
        if (bar)
            bar.remove();
    };
    const applyFormattedContent = (group, path, content, options) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
        if (!group.editor) {
            return false;
        }
        const editor = group.editor;
        const entry = monacoModels.get(path);
        const currentValue = (_c = (_a = entry === null || entry === void 0 ? void 0 : entry.model.getValue()) !== null && _a !== void 0 ? _a : (_b = editor.getValue) === null || _b === void 0 ? void 0 : _b.call(editor)) !== null && _c !== void 0 ? _c : "";
        const targetIsVisible = group.currentFilePath === path;
        const viewState = targetIsVisible ? (_d = editor.saveViewState) === null || _d === void 0 ? void 0 : _d.call(editor) : undefined;
        const fileDeleted = (options === null || options === void 0 ? void 0 : options.fileDeleted) === true;
        // A new disk version from outside the keyboard (another program, Axiom).
        // `entry.savedContent` is the disk text this buffer was last in step
        // with, so savedContent → buffer is exactly the unsaved typing and
        // savedContent → content is everything that happened on disk. Carry the
        // latter over as ranged edits when it does not touch the former. A file
        // already in conflict stays in conflict: its buffer is not based on
        // savedContent any more.
        let rebased = null;
        if (entry &&
            !fileDeleted &&
            (options === null || options === void 0 ? void 0 : options.updateSaved) === true &&
            options.forceConflict !== true &&
            options.expectedFileMissing !== true &&
            (typeof options.expectedContent === "string" || options.externalChange === true) &&
            !contentConflicts.has(path)) {
            const base = inModelForm(entry.model, currentValue, (_f = (_e = entry.savedContent) !== null && _e !== void 0 ? _e : options.expectedContent) !== null && _f !== void 0 ? _f : "");
            const theirs = inModelForm(entry.model, currentValue, content);
            const hunks = rebaseHunks(base, currentValue, theirs);
            if (hunks) {
                const value = applyHunks(currentValue, hunks);
                rebased = { hunks, value, matchesDisk: value === theirs };
            }
        }
        // Codex edits the workspace on disk. If the user typed in the same open
        // buffer after the agent's source snapshot, never overwrite that newer
        // unsaved work. Updating savedContent below still records the new disk
        // baseline, so the retained buffer stays visibly dirty and can be saved or
        // reviewed by the user.
        const hasConcurrentEdit = (options === null || options === void 0 ? void 0 : options.forceConflict) === true ||
            (fileDeleted
                ? typeof (options === null || options === void 0 ? void 0 : options.expectedContent) === "string" &&
                    currentValue !== options.expectedContent
                : rebased === null &&
                    currentValue !== content &&
                    ((typeof (options === null || options === void 0 ? void 0 : options.expectedContent) === "string" &&
                        currentValue !== options.expectedContent) ||
                        (options === null || options === void 0 ? void 0 : options.expectedFileMissing) === true));
        if (hasConcurrentEdit) {
            const conversationId = typeof (options === null || options === void 0 ? void 0 : options.conversationId) === "string" && options.conversationId.trim()
                ? options.conversationId.trim()
                : null;
            contentConflicts.set(path, {
                diskContent: fileDeleted ? null : content,
                conversationId,
                externalChange: options === null || options === void 0 ? void 0 : options.externalChange,
            });
            const message = (options === null || options === void 0 ? void 0 : options.externalChange) ? uiText(`${path} changed outside TeX64. Your unsaved edits were kept.`, `${path}が外部で変更されました。未保存の編集は保持しています。`) : uiText(fileDeleted
                ? `Axiom deleted ${path} while it had unsaved edits. Choose which version to keep.`
                : `Axiom changed ${path} on disk while it had unsaved edits. Choose which version to keep.`, fileDeleted
                ? `未保存の編集中にAxiomが ${path} を削除しました。残す内容を選んでください。`
                : `未保存の編集中にAxiomが ${path} を変更しました。残す内容を選んでください。`);
            // The conflict bar is the notice. A failure already recorded for this
            // file (an autosave refused against the new disk text) is superseded.
            diskChangeQuietUntil.delete(path);
            if (saveErrors.delete(path) && !hasFailedDirtyFile())
                clearOwnSaveError();
            notifySaveStatusChange();
            // A conflict that arrives on its own (another program, Axiom) never
            // switches tabs: the person may be typing in another file. Its buttons
            // appear when that file is shown (applyFileContent). Moving on to the
            // next conflict after resolving one is the person's own action.
            const showsElsewhere = !targetIsVisible && !fileDeleted;
            if (showsElsewhere && (options === null || options === void 0 ? void 0 : options.forceConflict) === true) {
                requestOpenFile(path, group.key, true);
            }
            const editorDom = (_g = editor.getDomNode) === null || _g === void 0 ? void 0 : _g.call(editor);
            const editorContainer = showsElsewhere && (options === null || options === void 0 ? void 0 : options.forceConflict) !== true ? null : editorDom === null || editorDom === void 0 ? void 0 : editorDom.parentElement;
            if (editorContainer) {
                (_h = document.getElementById("ai-content-conflict-bar")) === null || _h === void 0 ? void 0 : _h.remove();
                const bar = document.createElement("div");
                bar.id = "ai-content-conflict-bar";
                bar.className = "ai-undo-keep-bar";
                // What happened, for hover and assistive technology.
                bar.title = message;
                (_j = bar.setAttribute) === null || _j === void 0 ? void 0 : _j.call(bar, "role", "group");
                (_k = bar.setAttribute) === null || _k === void 0 ? void 0 : _k.call(bar, "aria-label", message);
                const keepMine = document.createElement("button");
                keepMine.className = "ai-undo-keep-btn is-undo";
                keepMine.textContent = uiText("Keep mine", "自分の編集を残す");
                keepMine.addEventListener("click", () => {
                    var _a, _b, _c, _d;
                    const conflict = contentConflicts.get(path);
                    if (!conflict)
                        return;
                    const mine = (_c = (_a = entry === null || entry === void 0 ? void 0 : entry.model.getValue(undefined, entry.plainText)) !== null && _a !== void 0 ? _a : (_b = editor.getValue) === null || _b === void 0 ? void 0 : _b.call(editor)) !== null && _c !== void 0 ? _c : currentValue;
                    keepMine.disabled = true;
                    useAxiom.disabled = true;
                    void savePathContent(path, mine, 8000, conflict.diskContent === null ? null : (_d = monacoModels.get(path)) === null || _d === void 0 ? void 0 : _d.savedContent)
                        .then((saved) => {
                        if (!saved)
                            throw new Error("Saving failed.");
                        contentConflicts.delete(path);
                        notifySaveStatusChange();
                        bar.remove();
                        clearOwnSaveError();
                        if (conflict.conversationId) {
                            deps.postToNative({
                                type: "agent:contentConflictResolved",
                                conversationId: conflict.conversationId,
                                path,
                            });
                        }
                        reopenNextContentConflict();
                    })
                        .catch((error) => {
                        keepMine.disabled = false;
                        useAxiom.disabled = false;
                        reportSaveError(error instanceof Error ? error.message : String(error));
                    });
                });
                const useAxiom = document.createElement("button");
                useAxiom.className = "ai-undo-keep-btn is-keep";
                useAxiom.textContent =
                    ((_l = contentConflicts.get(path)) === null || _l === void 0 ? void 0 : _l.diskContent) === null
                        ? uiText("Keep deleted", "削除したまま")
                        : (options === null || options === void 0 ? void 0 : options.externalChange) ? uiText("Use disk version", "ディスクの内容を使う") : uiText("Use Axiom", "Axiomを使う");
                useAxiom.addEventListener("click", () => {
                    const conflict = contentConflicts.get(path);
                    if (!conflict)
                        return;
                    if (conflict.diskContent === null) {
                        contentConflicts.delete(path);
                        notifySaveStatusChange();
                        dirtyFiles.delete(path);
                        bar.remove();
                        clearOwnSaveError();
                        deps.postToNative({ type: "requestWorkspace" });
                        if (conflict.conversationId) {
                            deps.postToNative({
                                type: "agent:contentConflictResolved",
                                conversationId: conflict.conversationId,
                                path,
                            });
                        }
                        reopenNextContentConflict();
                        return;
                    }
                    keepMine.disabled = true;
                    useAxiom.disabled = true;
                    void savePathContent(path, conflict.diskContent)
                        .then((saved) => {
                        var _a;
                        if (!saved)
                            throw new Error("Saving failed.");
                        contentConflicts.delete(path);
                        notifySaveStatusChange();
                        group.isApplyingFile = true;
                        replaceContentViaEdits(group.currentFilePath === path ? editor : null, (_a = entry === null || entry === void 0 ? void 0 : entry.model) !== null && _a !== void 0 ? _a : null, conflict.diskContent, "ai-conflict");
                        group.isApplyingFile = false;
                        if (entry)
                            entry.savedContent = conflict.diskContent;
                        if (group.currentFilePath === path) {
                            group.currentFileSavedContent = conflict.diskContent;
                        }
                        updateDirtyState(path, conflict.diskContent, conflict.diskContent);
                        bar.remove();
                        clearOwnSaveError();
                        if (conflict.conversationId) {
                            deps.postToNative({
                                type: "agent:contentConflictResolved",
                                conversationId: conflict.conversationId,
                                path,
                            });
                        }
                        reopenNextContentConflict();
                        if (isActiveGroup(group)) {
                            updateBreadcrumbs();
                            deps.fileTree.render();
                        }
                    })
                        .catch((error) => {
                        keepMine.disabled = false;
                        useAxiom.disabled = false;
                        reportSaveError(error instanceof Error ? error.message : String(error));
                    });
                });
                bar.append(keepMine, useAxiom);
                editorContainer.appendChild(bar);
            }
        }
        if (fileDeleted) {
            updateDirtyState(path, currentValue, (_m = entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _m !== void 0 ? _m : currentValue);
            return hasConcurrentEdit;
        }
        const nextValue = rebased ? rebased.value : content;
        if (!hasConcurrentEdit && (rebased ? rebased.hunks.length > 0 : currentValue !== content)) {
            // Compute changed line numbers BEFORE replacing (for diff decorations).
            // Use LCS-based diff so that only truly added/modified lines are marked,
            // not lines that merely shifted position due to an insertion above.
            let changedLineNumbers = [];
            if (options === null || options === void 0 ? void 0 : options.showAiDiff) {
                const oldLines = currentValue.split("\n");
                const newLines = nextValue.split("\n");
                const diffResult = buildLineDiff(oldLines, newLines);
                let newLineNum = 0;
                for (const entry of diffResult) {
                    if (entry.type === "add" || entry.type === "same") {
                        newLineNum++;
                    }
                    if (entry.type === "add") {
                        changedLineNumbers.push(newLineNum); // Monaco lines are 1-indexed
                    }
                }
            }
            const source = (options === null || options === void 0 ? void 0 : options.showAiDiff) ? "ai-apply" : "format-on-save";
            // Every editor showing this model ignores the edit as typing; the dirty
            // state is set below.
            const groups = Object.values(editorGroups);
            const wasApplying = groups.map((each) => each.isApplyingFile);
            groups.forEach((each) => { each.isApplyingFile = true; });
            try {
                const ranged = rebased && entry &&
                    applyRangedEdits(targetIsVisible ? editor : null, entry.model, rebased.hunks, source);
                if (ranged && entry.model.getValue() !== nextValue) {
                    // Never expected; still never leave the buffer different from what
                    // was computed (the person's typing plus the disk change).
                    console.warn(`[file-ops] ranged apply diverged for "${path}"; replacing the buffer`);
                    replaceContentViaEdits(targetIsVisible ? editor : null, entry.model, nextValue, source);
                    if (targetIsVisible && viewState && editor.restoreViewState)
                        editor.restoreViewState(viewState);
                }
                else if (!ranged) {
                    replaceContentViaEdits(targetIsVisible ? editor : null, (_o = entry === null || entry === void 0 ? void 0 : entry.model) !== null && _o !== void 0 ? _o : null, nextValue, source);
                    if (targetIsVisible && viewState && editor.restoreViewState) {
                        editor.restoreViewState(viewState);
                    }
                }
            }
            finally {
                groups.forEach((each, index) => { each.isApplyingFile = wasApplying[index]; });
            }
            // Add AI diff decorations
            if (targetIsVisible &&
                (options === null || options === void 0 ? void 0 : options.showAiDiff) &&
                changedLineNumbers.length > 0 &&
                editor.deltaDecorations) {
                clearAiDiffDecorations(group);
                const decorations = changedLineNumbers.map((lineNumber) => ({
                    range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: 1 },
                    options: {
                        isWholeLine: true,
                        className: "ai-diff-added-line",
                        glyphMarginClassName: "ai-diff-added-glyph",
                    },
                }));
                const ids = editor.deltaDecorations([], decorations);
                aiDiffDecorations.set(group.key, ids);
                // The edit is already on disk and the chat card carries "元に戻す";
                // the editor only marks the changed lines until the next edit.
                // Auto-clear on next content change (user edit, undo, redo)
                if (editor.onDidChangeModelContent) {
                    const disposable = editor.onDidChangeModelContent(() => {
                        clearAiDiffDecorations(group);
                        disposable.dispose();
                    });
                }
            }
        }
        if (options === null || options === void 0 ? void 0 : options.updateSaved) {
            if (entry) {
                entry.savedContent = content;
            }
            if (group.currentFilePath === path) {
                group.currentFileSavedContent = content;
            }
        }
        const savedContent = (_q = (_p = (group.currentFilePath === path
            ? group.currentFileSavedContent
            : entry === null || entry === void 0 ? void 0 : entry.savedContent)) !== null && _p !== void 0 ? _p : entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _q !== void 0 ? _q : content;
        // A rebase that kept unsaved typing leaves the buffer dirty against the
        // new disk text; autosave then writes both, guarded by that text.
        const keptTyping = !hasConcurrentEdit && rebased !== null && !rebased.matchesDisk;
        updateDirtyState(path, hasConcurrentEdit ? currentValue : keptTyping ? nextValue : content, savedContent);
        if (keptTyping)
            scheduleAutoSave();
        if (isActiveGroup(group)) {
            updateBreadcrumbs();
            deps.fileTree.render();
        }
        return hasConcurrentEdit;
    };
    // Shows the resolution buttons of a conflict whose file has just come into
    // view (a conflict never switches tabs by itself).
    const showPendingConflict = (group, path) => {
        var _a, _b;
        const conflict = contentConflicts.get(path);
        if (!conflict || group.currentFilePath !== path)
            return;
        applyFormattedContent(group, path, (_a = conflict.diskContent) !== null && _a !== void 0 ? _a : "", {
            updateSaved: conflict.diskContent !== null,
            fileDeleted: conflict.diskContent === null,
            conversationId: (_b = conflict.conversationId) !== null && _b !== void 0 ? _b : undefined,
            forceConflict: true,
            externalChange: conflict.externalChange,
        });
    };
    reopenNextContentConflict = () => {
        var _a, _b;
        const next = contentConflicts.entries().next();
        if (next.done)
            return;
        const [nextPath, conflict] = next.value;
        const groupKey = findGroupKeyByPath(nextPath);
        if (!groupKey)
            return;
        applyFormattedContent(getEditorGroup(groupKey), nextPath, (_a = conflict.diskContent) !== null && _a !== void 0 ? _a : "", {
            updateSaved: conflict.diskContent !== null,
            fileDeleted: conflict.diskContent === null,
            conversationId: (_b = conflict.conversationId) !== null && _b !== void 0 ? _b : undefined,
            forceConflict: true,
            externalChange: conflict.externalChange,
        });
    };
    // Install a model only for the latest selection of this pane. Cache the
    // outgoing buffer at the swap, since it may have changed during a read or IME.
    const isCurrentOpen = (request) => latestOpen.get(request.group) === request &&
        (!request.wasOpen || getEditorGroup(request.group).openTabs.includes(request.path));
    const activateOpen = (group, request, apply, scope = openScope) => {
        if (scope !== openScope || (request && !isCurrentOpen(request)))
            return;
        if (group.isComposing) {
            scheduleAfterComposition(group, () => activateOpen(group, request, apply, scope));
            return;
        }
        cacheCurrentBuffer(group);
        apply();
    };
    const sendOpenRequest = (request) => {
        state.pendingOpenRequests.push(request);
        const ok = deps.postToNative({ type: "openFile", path: request.path, openRequestId: request.id });
        if (!ok) {
            const index = state.pendingOpenRequests.indexOf(request);
            if (index >= 0)
                state.pendingOpenRequests.splice(index, 1);
            deps.updateIssues(1, "Unable to open file.", "error", [
                { severity: "error", message: "Unable to open file." },
            ]);
        }
        return ok;
    };
    const requestOpenFile = (path, groupKey, force = false, position) => {
        var _a;
        const preferredGroup = getEditorGroup(groupKey);
        const preferredGroupHasPath = preferredGroup.currentFilePath === path || preferredGroup.openTabs.includes(path);
        const existingGroupKey = preferredGroupHasPath ? groupKey : findGroupKeyByPath(path);
        const resolvedGroupKey = force || preferredGroupHasPath
            ? groupKey
            : existingGroupKey !== null && existingGroupKey !== void 0 ? existingGroupKey : (isPdfFilePath(path) ? "secondary" : resolveAutoOpenGroupKey(groupKey));
        if (resolvedGroupKey === "secondary") {
            setSplitViewEnabled(true);
        }
        const group = getEditorGroup(resolvedGroupKey);
        const request = {
            id: ++nextOpenRequestId, path, group: resolvedGroupKey, position,
            wasOpen: group.openTabs.includes(path),
        };
        latestOpen.set(resolvedGroupKey, request);
        if (((_a = state.pendingReveal) === null || _a === void 0 ? void 0 : _a.group) === resolvedGroupKey && state.pendingReveal.path !== path) {
            state.pendingReveal = null;
        }
        if (group.currentFilePath === path && group.viewer.getViewerMode() !== "unsupported") {
            if (!position)
                return false;
            addOpenTab(group, path, position);
            deps.editorTabs.render(group);
            return true;
        }
        // Closed buffers can miss watcher updates. Open tabs already have the
        // current model, including any edits that have yet to reach the disk.
        if (existingGroupKey && monacoModels.has(path) && group.editor) {
            activateOpen(group, request, () => {
                const entry = monacoModels.get(path);
                if (entry)
                    applyFileContent(group, path, entry, position);
            });
            return true;
        }
        return sendOpenRequest(request);
    };
    const requestOpenFileInBackground = (path, group) => {
        if (monacoModels.has(path))
            return false;
        if (state.pendingOpenRequests.some((entry) => entry.background && entry.path === path))
            return true;
        return sendOpenRequest({ id: ++nextOpenRequestId, path, group, background: true });
    };
    const saveCurrentFileInternal = () => {
        var _a, _b;
        const activeGroup = getActiveGroup();
        const activePath = activeGroup.currentFilePath;
        // Saving by hand brings in an Axiom edit that waits for a typing pause.
        if (activePath)
            (_a = heldSaves.get(activePath)) === null || _a === void 0 ? void 0 : _a();
        if (!activePath || !activeGroup.editor || !monacoModels.has(activePath)) {
            const message = activePath
                ? "This file format cannot be edited."
                : "No files have been selected to save.";
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
            return Promise.resolve(false);
        }
        if ((_b = deps.collab) === null || _b === void 0 ? void 0 : _b.isBound(activePath)) {
            return deps.collab.flush();
        }
        const editor = activeGroup.editor;
        const entry = monacoModels.get(activePath);
        const content = (entry === null || entry === void 0 ? void 0 : entry.plainText) ? entry.model.getValue(undefined, true) : editor.getValue();
        if (contentConflicts.has(activePath)) {
            refuseConflictedSave(activePath);
            return Promise.resolve(false);
        }
        return savePathContent(activePath, content);
    };
    const saveCurrentFile = () => {
        const activeGroup = getActiveGroup();
        if (!activeGroup.isComposing) {
            return saveCurrentFileInternal();
        }
        return new Promise((resolve, reject) => {
            scheduleAfterComposition(activeGroup, () => {
                saveCurrentFileInternal().then(resolve).catch(reject);
            }, () => resolve(false));
        });
    };
    // One pass at a time: autosave, the retry timer and Retry can all ask at
    // once. A request during a pass gets one more pass after it, which sees
    // what changed meanwhile.
    // `auto`: autosave and its retries. They never end an IME composition and
    // leave a held file waiting; Save, Build, History and Git do neither.
    let saveDirtyRun = null;
    let saveDirtyAgain = null;
    let saveDirtyAgainAuto = true;
    const saveDirtyFiles = (options = {}) => {
        const auto = options.auto === true;
        if (!saveDirtyRun) {
            saveDirtyRun = saveDirtyFilesOnce(auto).finally(() => {
                saveDirtyRun = null;
            });
            return saveDirtyRun;
        }
        if (!auto)
            saveDirtyAgainAuto = false;
        saveDirtyAgain !== null && saveDirtyAgain !== void 0 ? saveDirtyAgain : (saveDirtyAgain = saveDirtyRun
            .catch(() => false)
            .then(() => {
            saveDirtyAgain = null;
            const again = saveDirtyAgainAuto;
            saveDirtyAgainAuto = true;
            return saveDirtyFiles({ auto: again });
        }));
        return saveDirtyAgain;
    };
    const saveDirtyFilesOnce = async (auto = false) => {
        if (!auto) {
            for (const release of Array.from(heldSaves.values()))
                release();
        }
        const allDirty = Array.from(dirtyFiles).filter((path) => monacoModels.has(path));
        const boundDirty = allDirty.filter((path) => { var _a; return (_a = deps.collab) === null || _a === void 0 ? void 0 : _a.isBound(path); });
        const dirtyPaths = allDirty.filter((path) => { var _a; return !((_a = deps.collab) === null || _a === void 0 ? void 0 : _a.isBound(path)); });
        if (dirtyPaths.length === 0) {
            return boundDirty.length ? deps.collab.flush() : true;
        }
        // A file in an edit conflict waits for the user; the others still save.
        const conflicted = dirtyPaths.filter((path) => contentConflicts.has(path));
        const activePath = getActiveGroup().currentFilePath;
        const ordered = dirtyPaths.filter((path) => !contentConflicts.has(path) && !heldSaves.has(path)).sort((a, b) => {
            if (a === activePath) {
                return -1;
            }
            if (b === activePath) {
                return 1;
            }
            return a.localeCompare(b, getUiLocale());
        });
        const readBuffer = (path) => {
            var _a, _b, _c;
            const entry = monacoModels.get(path);
            if ((_a = entry === null || entry === void 0 ? void 0 : entry.model) === null || _a === void 0 ? void 0 : _a.getValue) {
                return entry.model.getValue(undefined, entry.plainText);
            }
            const owner = Object.values(editorGroups).find((group) => group.currentFilePath === path);
            if (!(owner === null || owner === void 0 ? void 0 : owner.editor)) {
                return null;
            }
            const editor = owner.editor;
            return (_c = (_b = editor.getValue) === null || _b === void 0 ? void 0 : _b.call(editor)) !== null && _c !== void 0 ? _c : null;
        };
        const composingOwner = (path) => Object.values(editorGroups).find((group) => group.currentFilePath === path && group.isComposing);
        // False: the composition's model was replaced (a folder change), and
        // this buffer is no longer one to save.
        const waitForCompositionIfNeeded = (path) => new Promise((resolve) => {
            const owner = composingOwner(path);
            if (!owner) {
                resolve(true);
                return;
            }
            if (!auto) {
                scheduleAfterComposition(owner, () => resolve(true), () => resolve(false));
                return;
            }
            // Autosave waits for the composition to end by itself: ending it
            // (scheduleAfterComposition blurs the input) would commit a
            // half-converted word and take the caret away mid-sentence.
            const check = () => {
                if (composingOwner(path))
                    window.setTimeout(check, 100);
                else
                    resolve(true);
            };
            window.setTimeout(check, 100);
        });
        for (const path of ordered) {
            if (!dirtyFiles.has(path)) {
                continue;
            }
            if (!(await waitForCompositionIfNeeded(path))) {
                continue;
            }
            // An Axiom edit may have started waiting on this file meanwhile.
            if (heldSaves.has(path) || contentConflicts.has(path)) {
                continue;
            }
            const content = readBuffer(path);
            if (content === null) {
                reportSaveError(`Unable to retrieve content to save: ${path}`, path);
                return false;
            }
            try {
                await savePathContent(path, content);
            }
            catch (error) {
                reportSaveError(saveFailureMessage(error), path);
                return false;
            }
        }
        if (conflicted.length > 0) {
            // Autosave leaves a file with open conflict choices alone, silently.
            if (!auto)
                conflicted.forEach(refuseConflictedSave);
            return false;
        }
        if (boundDirty.length)
            return deps.collab.flush();
        return true;
    };
    const getSaveStatus = () => {
        // A file that is clean again (undone, reverted) has nothing left to save.
        for (const path of Array.from(saveErrors.keys())) {
            if (!dirtyFiles.has(path))
                saveErrors.delete(path);
        }
        if (saveErrors.size === 0 && saveRetryTimer !== null) {
            window.clearTimeout(saveRetryTimer);
            saveRetryTimer = null;
            saveRetryDelayMs = 0;
        }
        const dirtyPaths = Array.from(dirtyFiles).filter((path) => monacoModels.has(path));
        const failed = Array.from(saveErrors.entries());
        // A file with open conflict choices counts as unsaved, not as failed: the
        // bar is its notice (a save by hand records why it cannot, above).
        if (failed.length > 0) {
            const [path, message] = failed[0];
            return { kind: "error", message, path, count: failed.length };
        }
        if (state.pendingSave) {
            return { kind: "saving", path: state.pendingSave.path };
        }
        if (dirtyPaths.length > 0) {
            return { kind: "dirty", count: dirtyPaths.length };
        }
        return { kind: "saved", savedAt: lastSavedAt };
    };
    // ---- Axiom edits that wait for a typing pause (outside-edits.ts) ----
    const holdSaves = (path, release) => {
        heldSaves.set(path, release);
        // A save already sent may come back refused against Axiom's text; that
        // is expected while the edit waits, not something to report.
        saveErrors.delete(path);
        notifySaveStatusChange();
    };
    const unholdSaves = (path) => {
        if (heldSaves.delete(path))
            notifySaveStatusChange();
    };
    const lastTypedAt = (path) => {
        var _a, _b;
        const entry = monacoModels.get(path);
        return entry ? (_b = (_a = typing.get(entry.model)) === null || _a === void 0 ? void 0 : _a.at) !== null && _b !== void 0 ? _b : null : null;
    };
    // The new disk text of `path` as ranged edits onto the buffer: null when it
    // touches the unsaved typing (the conflict choices would be needed).
    const rebaseOntoBuffer = (path, content) => {
        var _a;
        const entry = monacoModels.get(path);
        if (!entry)
            return null;
        const mine = entry.model.getValue();
        return rebaseHunks(inModelForm(entry.model, mine, (_a = entry.savedContent) !== null && _a !== void 0 ? _a : ""), mine, inModelForm(entry.model, mine, content));
    };
    const mergesCleanly = (path, content) => !contentConflicts.has(path) && rebaseOntoBuffer(path, content) !== null;
    // Whether applying `content` now would change the text under the person's
    // fingers: they typed in this file within `withinMs`, and the change either
    // overlaps their unsaved typing or lands in the paragraph they are typing
    // in (blank-line delimited, around the last keystroke).
    const disturbsTyping = (path, content, withinMs) => {
        const entry = monacoModels.get(path);
        if (!entry || contentConflicts.has(path))
            return false;
        const typed = typing.get(entry.model);
        if (!typed || now() - typed.at >= withinMs)
            return false;
        const hunks = rebaseOntoBuffer(path, content);
        if (!hunks)
            return true;
        if (typed.offset === null)
            return false;
        const text = entry.model.getValue();
        const [start, end] = paragraphAround(text, Math.min(typed.offset, text.length));
        return hunks.some((hunk) => hunk.start <= end && hunk.end >= start);
    };
    const clearAutoSaveTimer = () => {
        if (state.autoSaveTimer) {
            window.clearTimeout(state.autoSaveTimer);
            state.autoSaveTimer = null;
        }
        state.autoSavePending = false;
    };
    const scheduleAutoSave = () => {
        // Check if any group (not just the active one) has dirty files. Files
        // bound to a collaboration session are written by that session.
        const hasDirty = Array.from(dirtyFiles).some((path) => { var _a; return !((_a = deps.collab) === null || _a === void 0 ? void 0 : _a.isBound(path)); });
        if (!hasDirty) {
            clearAutoSaveTimer();
            return;
        }
        if (state.pendingSave) {
            state.autoSavePending = true;
            return;
        }
        clearAutoSaveTimer();
        state.autoSavePending = false;
        state.autoSaveTimer = window.setTimeout(() => {
            state.autoSaveTimer = null;
            // Use saveDirtyFiles to save all dirty files across all groups.
            saveDirtyFiles({ auto: true }).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                reportSaveError(message);
            });
        }, 400);
    };
    const handleOpenFileResult = (payload) => {
        var _a, _b, _c, _d, _e;
        // Handle non-file-open message types before consuming pending requests.
        const type = payload.type;
        if (type === "searchResult") {
            deps.search.handleSearchUpdate(payload);
            return false;
        }
        if (type === "env:checkResult") {
            deps.settings.updateEnvStatus(payload.command, payload.available);
            return false;
        }
        if (type === "env:installResult") {
            const { target, success, message } = payload;
            console.log(`Install result for ${target}: ${success} - ${message}`);
            if (!success) {
                console.warn(`Environment install failed for ${target}: ${message}`);
            }
            return false;
        }
        if (!payload.path)
            return false;
        let pendingEntry = null;
        if (payload.openRequestId !== undefined) {
            const index = state.pendingOpenRequests.findIndex((entry) => entry.id === payload.openRequestId && entry.path === payload.path);
            if (index < 0)
                return false;
            [pendingEntry] = state.pendingOpenRequests.splice(index, 1);
            if (!pendingEntry.background && !isCurrentOpen(pendingEntry))
                return false;
        }
        let targetGroupKey = (_a = pendingEntry === null || pendingEntry === void 0 ? void 0 : pendingEntry.group) !== null && _a !== void 0 ? _a : getActiveEditorGroupKey();
        // Main owns text classification. Older internal senders provide content
        // without a kind (new files, settings, imported documents).
        const kind = (_b = payload.kind) !== null && _b !== void 0 ? _b : (isPdfFilePath(payload.path)
            ? "pdf"
            : isImageFilePath(payload.path)
                ? "image"
                : typeof payload.content === "string"
                    ? "text"
                    : "unsupported");
        const path = kind === "text" ? payload.fileIdentity || payload.path : payload.path;
        if (!pendingEntry) {
            if (kind === "pdf") {
                if (payload.buildPreview) {
                    // A build can finish while either editor pane is active.
                    const active = getActiveGroup();
                    targetGroupKey = active.viewer.getViewerMode() === "pdf"
                        ? active.key
                        : active.key === "primary" ? "secondary" : "primary";
                }
                else {
                    targetGroupKey = "secondary";
                }
                if (targetGroupKey === "secondary")
                    setSplitViewEnabled(true);
            }
            else {
                const existingGroupKey = findGroupKeyByPath(path);
                if (existingGroupKey) {
                    targetGroupKey = existingGroupKey;
                }
                else {
                    targetGroupKey = resolveAutoOpenGroupKey(targetGroupKey);
                }
            }
        }
        const targetGroup = getEditorGroup(targetGroupKey);
        if (payload.error) {
            if (state.pendingReveal &&
                state.pendingReveal.path === payload.path &&
                state.pendingReveal.group === targetGroupKey) {
                state.pendingReveal = null;
            }
            deps.updateIssues(1, payload.error, "error", [
                { severity: "error", message: payload.error },
            ]);
            return true;
        }
        if (pendingEntry === null || pendingEntry === void 0 ? void 0 : pendingEntry.background) {
            if (kind !== "text") {
                deps.updateIssues(1, "The live preview source is not editable.", "error", [
                    { severity: "error", message: "The live preview source is not editable." },
                ]);
                return true;
            }
            const entry = (_c = monacoModels.get(path)) !== null && _c !== void 0 ? _c : ensureModelEntry(path, (_d = payload.content) !== null && _d !== void 0 ? _d : "", (_e = payload.content) !== null && _e !== void 0 ? _e : "", payload.languageId === "plaintext");
            if (!entry) {
                deps.updateFallback("Editor is not ready.");
                return true;
            }
            addOpenTab(targetGroup, path);
            deps.editorTabs.render(targetGroup);
            return true;
        }
        if (payload.buildPreview === "previous" && targetGroup.currentFilePath === path &&
            targetGroup.viewer.getViewerMode() === "pdf")
            return true;
        const position = pendingEntry === null || pendingEntry === void 0 ? void 0 : pendingEntry.position;
        activateOpen(targetGroup, pendingEntry, () => {
            var _a, _b;
            if (((_a = state.pendingReveal) === null || _a === void 0 ? void 0 : _a.path) === payload.path && state.pendingReveal.group === targetGroupKey) {
                state.pendingReveal.path = path;
            }
            if (kind === "image" || kind === "pdf") {
                applyViewerFile(targetGroup, path, kind, payload.data, payload.mimeType, position);
            }
            else if (kind === "unsupported") {
                applyUnsupportedFile(targetGroup, path, position);
            }
            else {
                const cached = pendingEntry && findGroupKeyByPath(path) ? monacoModels.get(path) : null;
                const content = (_b = payload.content) !== null && _b !== void 0 ? _b : "";
                const entry = cached !== null && cached !== void 0 ? cached : ensureModelEntry(path, content, content, payload.languageId === "plaintext");
                applyFileContent(targetGroup, path, entry, position);
                if (entry && !cached)
                    setEditorLanguage(targetGroup, path);
            }
        });
        return true;
    };
    const handleSaveResult = (payload) => {
        var _a, _b;
        let savedContent = null;
        const saveErrorMessage = (_a = payload.error) !== null && _a !== void 0 ? _a : "Saving failed.";
        if (state.pendingSave) {
            if (state.pendingSave.path === payload.path) {
                if (payload.busy) {
                    state.pendingSave.resolve(false);
                }
                else if (payload.ok) {
                    if (payload.content) {
                        state.pendingSave.content = payload.content;
                    }
                    savedContent = state.pendingSave.content;
                    state.pendingSave.resolve(true);
                }
                else {
                    state.pendingSave.reject(saveErrorMessage);
                }
                state.pendingSave = null;
                notifySaveStatusChange();
            }
            else {
                // Path mismatch: the native side returned a result for a different path.
                // Log and leave pendingSave intact so the correct result can still arrive.
                console.warn(`[file-ops] handleSaveResult path mismatch: expected "${state.pendingSave.path}", got "${payload.path}"`);
            }
        }
        if (payload.busy) {
            scheduleAutoSave();
            return;
        }
        if (!payload.ok) {
            reportSaveError(saveErrorMessage, payload.path);
            return;
        }
        lastSavedAt = Date.now();
        saveErrors.delete(payload.path);
        diskChangeQuietUntil.delete(payload.path);
        if (!hasFailedDirtyFile()) {
            saveRetryDelayMs = 0;
            if (saveRetryTimer !== null) {
                window.clearTimeout(saveRetryTimer);
                saveRetryTimer = null;
            }
        }
        notifySaveStatusChange();
        if (lastSaveErrorMessage !== null && !hasFailedDirtyFile()) {
            const snapshot = (_b = deps.getRecentIssuesSnapshot) === null || _b === void 0 ? void 0 : _b.call(deps);
            const stillOurs = !snapshot ||
                (snapshot.status === "error" &&
                    snapshot.issues.length === 1 &&
                    snapshot.issues[0].message === lastSaveErrorMessage);
            if (stillOurs) {
                deps.updateIssues(0, "", "info", []);
            }
            lastSaveErrorMessage = null;
        }
        const entry = monacoModels.get(payload.path);
        let resolvedSavedContent = savedContent;
        if (resolvedSavedContent === null) {
            if (payload.content) {
                resolvedSavedContent = payload.content;
            }
            else if (entry) {
                resolvedSavedContent = entry.model.getValue();
            }
        }
        if (resolvedSavedContent !== null) {
            if (entry) {
                entry.savedContent = resolvedSavedContent;
            }
            dirtyFiles.delete(payload.path);
        }
        const groupsWithFile = Object.values(editorGroups).filter((group) => group.currentFilePath === payload.path);
        if (groupsWithFile.length > 0) {
            groupsWithFile.forEach((group) => {
                if (resolvedSavedContent !== null) {
                    group.currentFileSavedContent = resolvedSavedContent;
                }
                if (payload.content) {
                    applyFormattedContent(group, payload.path, payload.content, { updateSaved: true });
                }
                else if (group.editor && group.currentFileSavedContent !== null) {
                    const editor = group.editor;
                    const currentValue = editor.getValue();
                    updateDirtyState(payload.path, currentValue, group.currentFileSavedContent);
                }
                else {
                    group.isDirty = false;
                }
            });
        }
        const activeGroup = getActiveGroup();
        if (activeGroup.currentFilePath !== payload.path) {
            activeGroup.isDirty = activeGroup.currentFilePath
                ? dirtyFiles.has(activeGroup.currentFilePath)
                : false;
        }
        if (state.autoSavePending) {
            state.autoSavePending = false;
            if (activeGroup.currentFilePath && activeGroup.isDirty) {
                scheduleAutoSave();
            }
        }
        if (payload.formatError) {
            deps.buildOps.handleSaveFormatError(payload.formatError);
        }
        updateBreadcrumbs();
        deps.fileTree.render();
        forEachEditorGroup((group) => {
            if (group.openTabs.includes(payload.path)) {
                deps.editorTabs.render(group);
            }
        });
    };
    return {
        applyFormattedContent,
        requestOpenFile,
        requestOpenFileInBackground,
        saveCurrentFile,
        saveDirtyFiles,
        scheduleAutoSave,
        getSaveStatus,
        handleOpenFileResult,
        clearOpenRequests,
        handleSaveResult,
        clearContentConflicts,
        holdSaves,
        unholdSaves,
        lastTypedAt,
        mergesCleanly,
        disturbsTyping,
    };
};
