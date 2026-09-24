import { isEditableTextFilePath, isImageFilePath, isPdfFilePath, isTextFilePath, } from "./files.js";
import { buildLineDiff } from "./diff.js";
import { getUiLocale, uiText } from "./i18n.js";
import { trackLiveEditModel } from "./editor-session/live-edit-history.js";
import { rememberEditorModelPath } from "./editor-session/model-path.js";
import { notifySaveStatusChange } from "./save-status.js";
export const createEditorSessionFileOps = (ctx) => {
    let lastSaveErrorMessage = null;
    const contentConflicts = new Map();
    let reopenNextContentConflict = () => { };
    const { deps, editorGroups, monacoModels, dirtyFiles, state, getActiveEditorGroupKey, getActiveGroup, getEditorGroup, isActiveGroup, resolveAutoOpenGroupKey, findGroupKeyByPath, setSplitViewEnabled, cacheCurrentBuffer, clearJumpHighlight, clearTemporaryTabs, addOpenTab, updateDirtyState, restoreViewState, setEditorLanguage, updateBreadcrumbs, updateMiniOutline, revealLine, forEachEditorGroup, scheduleAfterComposition, getLanguageIdForPath, } = ctx;
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
                void saveDirtyFiles().catch(() => { });
        }, saveRetryDelayMs);
    };
    const reportSaveError = (message, path = null) => {
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
    const applyViewerFile = (group, path, kind, data, mimeType) => {
        clearTemporaryTabs(group, path);
        group.currentFilePath = path;
        group.currentFileSavedContent = null;
        group.isDirty = false;
        dirtyFiles.delete(path);
        addOpenTab(group, path);
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
            group.viewer.showPdfViewer(path, data, mimeType);
        }
        if (isActiveGroup(group)) {
            deps.buildOps.updateSynctexButtonState();
            deps.fileTree.setTreeFocus(false);
        }
    };
    const applyUnsupportedFile = (group, path) => {
        clearTemporaryTabs(group, path);
        group.currentFilePath = path;
        group.currentFileSavedContent = null;
        const keepDirty = isEditableTextFilePath(path) && dirtyFiles.has(path);
        group.isDirty = keepDirty;
        if (!keepDirty) {
            dirtyFiles.delete(path);
        }
        addOpenTab(group, path);
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
    const ensureModelEntry = (path, content, savedContent) => {
        var _a, _b;
        const monacoApi = deps.getMonacoApi();
        if (!monacoApi) {
            return null;
        }
        const entry = monacoModels.get(path);
        if (entry) {
            rememberEditorModelPath(entry.model, path);
            trackLiveEditModel(entry.model);
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
        const model = (existing !== null && existing !== void 0 ? existing : monacoApiAny.editor.createModel(content, getLanguageIdForPath(path), uri));
        rememberEditorModelPath(model, path);
        trackLiveEditModel(model);
        const nextEntry = { model, savedContent: savedContent !== null && savedContent !== void 0 ? savedContent : content };
        monacoModels.set(path, nextEntry);
        updateDirtyState(path, content, nextEntry.savedContent);
        return nextEntry;
    };
    const applyFileContent = (group, path, content, savedContent) => {
        var _a, _b, _c;
        const monacoApi = deps.getMonacoApi();
        if (!group.editor || !monacoApi) {
            deps.updateFallback("Editor is not ready.");
            return;
        }
        const editor = group.editor;
        const entry = ensureModelEntry(path, content, savedContent !== null && savedContent !== void 0 ? savedContent : content);
        clearTemporaryTabs(group, path);
        group.viewer.hideViewer();
        if (isActiveGroup(group)) {
            clearJumpHighlight(group);
        }
        group.isApplyingFile = true;
        if (entry && editor.setModel) {
            editor.setModel(entry.model);
        }
        else if (editor.setValue) {
            editor.setValue(content);
        }
        group.isApplyingFile = false;
        group.currentFilePath = path;
        group.currentFileSavedContent = (_a = entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _a !== void 0 ? _a : (savedContent !== null && savedContent !== void 0 ? savedContent : content);
        if (entry) {
            updateDirtyState(path, entry.model.getValue(), entry.savedContent);
        }
        else if (editor.getValue) {
            updateDirtyState(path, editor.getValue(), (_b = group.currentFileSavedContent) !== null && _b !== void 0 ? _b : content);
        }
        else {
            updateDirtyState(path, content, (_c = group.currentFileSavedContent) !== null && _c !== void 0 ? _c : content);
        }
        restoreViewState(group, path);
        addOpenTab(group, path);
        setEditorLanguage(group, path);
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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
        if (!group.editor) {
            return false;
        }
        const editor = group.editor;
        const entry = monacoModels.get(path);
        const currentValue = (_c = (_a = entry === null || entry === void 0 ? void 0 : entry.model.getValue()) !== null && _a !== void 0 ? _a : (_b = editor.getValue) === null || _b === void 0 ? void 0 : _b.call(editor)) !== null && _c !== void 0 ? _c : "";
        const targetIsVisible = group.currentFilePath === path;
        const viewState = targetIsVisible ? (_d = editor.saveViewState) === null || _d === void 0 ? void 0 : _d.call(editor) : undefined;
        const fileDeleted = (options === null || options === void 0 ? void 0 : options.fileDeleted) === true;
        // Codex edits the workspace on disk. If the user typed in the same open
        // buffer after the agent's source snapshot, never overwrite that newer
        // unsaved work. Updating savedContent below still records the new disk
        // baseline, so the retained buffer stays visibly dirty and can be saved or
        // reviewed by the user.
        const hasConcurrentEdit = (options === null || options === void 0 ? void 0 : options.forceConflict) === true ||
            (fileDeleted
                ? typeof (options === null || options === void 0 ? void 0 : options.expectedContent) === "string" &&
                    currentValue !== options.expectedContent
                : currentValue !== content &&
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
            const message = (options === null || options === void 0 ? void 0 : options.externalChange) ? uiText(`${path} changed outside TeX64. Your unsaved edits were kept.`, `${path} が外部で変更されました。未保存の編集は保持しています。`) : uiText(fileDeleted
                ? `Axiom deleted ${path} while it had unsaved edits. Choose which version to keep.`
                : `Axiom changed ${path} on disk while it had unsaved edits. Choose which version to keep.`, fileDeleted
                ? `未保存の編集中にAxiomが ${path} を削除しました。残す内容を選んでください。`
                : `未保存の編集中にAxiomが ${path} を変更しました。残す内容を選んでください。`);
            reportSaveError(message);
            if (!targetIsVisible && !fileDeleted) {
                // Move the affected background tab into view so the two explicit
                // resolution buttons operate in the file the user is reviewing.
                requestOpenFile(path, group.key, true);
            }
            const editorDom = (_e = editor.getDomNode) === null || _e === void 0 ? void 0 : _e.call(editor);
            const editorContainer = editorDom === null || editorDom === void 0 ? void 0 : editorDom.parentElement;
            if (editorContainer) {
                (_f = document.getElementById("ai-content-conflict-bar")) === null || _f === void 0 ? void 0 : _f.remove();
                const bar = document.createElement("div");
                bar.id = "ai-content-conflict-bar";
                bar.className = "ai-undo-keep-bar";
                const keepMine = document.createElement("button");
                keepMine.className = "ai-undo-keep-btn is-undo";
                keepMine.textContent = uiText("Keep mine", "自分の編集を残す");
                keepMine.addEventListener("click", () => {
                    var _a, _b, _c, _d;
                    const conflict = contentConflicts.get(path);
                    if (!conflict)
                        return;
                    const mine = (_c = (_a = entry === null || entry === void 0 ? void 0 : entry.model.getValue()) !== null && _a !== void 0 ? _a : (_b = editor.getValue) === null || _b === void 0 ? void 0 : _b.call(editor)) !== null && _c !== void 0 ? _c : currentValue;
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
                    ((_g = contentConflicts.get(path)) === null || _g === void 0 ? void 0 : _g.diskContent) === null
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
            updateDirtyState(path, currentValue, (_h = entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _h !== void 0 ? _h : currentValue);
            return hasConcurrentEdit;
        }
        if (!hasConcurrentEdit && currentValue !== content) {
            // Compute changed line numbers BEFORE replacing (for diff decorations).
            // Use LCS-based diff so that only truly added/modified lines are marked,
            // not lines that merely shifted position due to an insertion above.
            let changedLineNumbers = [];
            if (options === null || options === void 0 ? void 0 : options.showAiDiff) {
                const oldLines = currentValue.split("\n");
                const newLines = content.split("\n");
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
            group.isApplyingFile = true;
            replaceContentViaEdits(targetIsVisible ? editor : null, (_j = entry === null || entry === void 0 ? void 0 : entry.model) !== null && _j !== void 0 ? _j : null, content, (options === null || options === void 0 ? void 0 : options.showAiDiff) ? "ai-apply" : "format-on-save");
            group.isApplyingFile = false;
            if (targetIsVisible && viewState && editor.restoreViewState) {
                editor.restoreViewState(viewState);
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
        const savedContent = (_l = (_k = (group.currentFilePath === path
            ? group.currentFileSavedContent
            : entry === null || entry === void 0 ? void 0 : entry.savedContent)) !== null && _k !== void 0 ? _k : entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _l !== void 0 ? _l : content;
        updateDirtyState(path, hasConcurrentEdit ? currentValue : content, savedContent);
        if (isActiveGroup(group)) {
            updateBreadcrumbs();
            deps.fileTree.render();
        }
        return hasConcurrentEdit;
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
    const requestOpenFile = (path, groupKey, force = false) => {
        const preferredGroupHasPath = !force
            ? (() => {
                const preferredGroup = getEditorGroup(groupKey);
                return (preferredGroup.currentFilePath === path ||
                    preferredGroup.openTabs.includes(path));
            })()
            : false;
        const existingGroupKey = !force && !preferredGroupHasPath ? findGroupKeyByPath(path) : null;
        const resolvedGroupKey = force
            ? groupKey
            : preferredGroupHasPath
                ? groupKey
                : existingGroupKey !== null && existingGroupKey !== void 0 ? existingGroupKey : (isPdfFilePath(path) ? "secondary" : resolveAutoOpenGroupKey(groupKey));
        if (resolvedGroupKey === "secondary") {
            setSplitViewEnabled(true);
        }
        const group = getEditorGroup(resolvedGroupKey);
        if (group.currentFilePath === path && group.viewer.getViewerMode() !== "unsupported") {
            return false;
        }
        // Always cache buffer immediately (preserves IME composition text)
        if (!force) {
            cacheCurrentBuffer(group);
        }
        const requestEntry = { path, group: resolvedGroupKey };
        state.pendingOpenRequests.push(requestEntry);
        const ok = deps.postToNative({ type: "openFile", path });
        if (!ok) {
            const index = state.pendingOpenRequests.indexOf(requestEntry);
            if (index >= 0) {
                state.pendingOpenRequests.splice(index, 1);
            }
            deps.updateIssues(1, "Unable to open file.", "error", [
                { severity: "error", message: "Unable to open file." },
            ]);
        }
        return ok;
    };
    const requestOpenFileInBackground = (path, groupKey) => {
        if (monacoModels.has(path))
            return false;
        if (state.pendingOpenRequests.some((entry) => entry.path === path))
            return true;
        const requestEntry = { path, group: groupKey, background: true };
        state.pendingOpenRequests.push(requestEntry);
        const ok = deps.postToNative({ type: "openFile", path });
        if (!ok) {
            const index = state.pendingOpenRequests.indexOf(requestEntry);
            if (index >= 0)
                state.pendingOpenRequests.splice(index, 1);
            deps.updateIssues(1, "Unable to open file.", "error", [
                { severity: "error", message: "Unable to open file." },
            ]);
        }
        return ok;
    };
    const saveCurrentFileInternal = () => {
        const activeGroup = getActiveGroup();
        const activePath = activeGroup.currentFilePath;
        if (!activePath || !activeGroup.editor || !isEditableTextFilePath(activePath)) {
            const message = activePath
                ? "This file format cannot be edited."
                : "No files have been selected to save.";
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
            return Promise.resolve(false);
        }
        const editor = activeGroup.editor;
        const content = editor.getValue();
        if (contentConflicts.has(activePath)) {
            reportSaveError(uiText("Resolve the edit conflict before saving.", "保存する前に編集競合を解決してください。"));
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
            });
        });
    };
    // One pass at a time: autosave, the retry timer and Retry can all ask at
    // once. A request during a pass gets one more pass after it, which sees
    // what changed meanwhile.
    let saveDirtyRun = null;
    let saveDirtyAgain = null;
    const saveDirtyFiles = () => {
        if (!saveDirtyRun) {
            saveDirtyRun = saveDirtyFilesOnce().finally(() => {
                saveDirtyRun = null;
            });
            return saveDirtyRun;
        }
        saveDirtyAgain !== null && saveDirtyAgain !== void 0 ? saveDirtyAgain : (saveDirtyAgain = saveDirtyRun
            .catch(() => false)
            .then(() => {
            saveDirtyAgain = null;
            return saveDirtyFiles();
        }));
        return saveDirtyAgain;
    };
    const saveDirtyFilesOnce = async () => {
        const dirtyPaths = Array.from(dirtyFiles).filter((path) => isEditableTextFilePath(path));
        if (dirtyPaths.length === 0) {
            return true;
        }
        // A file in an edit conflict waits for the user; the others still save.
        const conflicted = dirtyPaths.filter((path) => contentConflicts.has(path));
        const activePath = getActiveGroup().currentFilePath;
        const ordered = dirtyPaths.filter((path) => !contentConflicts.has(path)).sort((a, b) => {
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
                return entry.model.getValue();
            }
            const owner = Object.values(editorGroups).find((group) => group.currentFilePath === path);
            if (!(owner === null || owner === void 0 ? void 0 : owner.editor)) {
                return null;
            }
            const editor = owner.editor;
            return (_c = (_b = editor.getValue) === null || _b === void 0 ? void 0 : _b.call(editor)) !== null && _c !== void 0 ? _c : null;
        };
        const waitForCompositionIfNeeded = (path) => new Promise((resolve) => {
            const owner = Object.values(editorGroups).find((group) => group.currentFilePath === path);
            if (!(owner === null || owner === void 0 ? void 0 : owner.isComposing)) {
                resolve();
                return;
            }
            scheduleAfterComposition(owner, () => resolve());
        });
        for (const path of ordered) {
            if (!dirtyFiles.has(path)) {
                continue;
            }
            await waitForCompositionIfNeeded(path);
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
            reportSaveError(uiText("Resolve the edit conflict before saving.", "保存する前に編集競合を解決してください。"));
            return false;
        }
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
        const dirtyPaths = Array.from(dirtyFiles).filter((path) => isEditableTextFilePath(path));
        const failed = Array.from(saveErrors.entries());
        const conflicted = dirtyPaths.filter((path) => contentConflicts.has(path));
        if (failed.length > 0) {
            const [path, message] = failed[0];
            return { kind: "error", message, path, count: failed.length + conflicted.length };
        }
        if (conflicted.length > 0) {
            return {
                kind: "error",
                message: "Resolve the edit conflict before saving.",
                path: conflicted[0],
                count: conflicted.length,
            };
        }
        if (state.pendingSave) {
            return { kind: "saving", path: state.pendingSave.path };
        }
        if (dirtyPaths.length > 0) {
            return { kind: "dirty", count: dirtyPaths.length };
        }
        return { kind: "saved", savedAt: lastSavedAt };
    };
    const clearAutoSaveTimer = () => {
        if (state.autoSaveTimer) {
            window.clearTimeout(state.autoSaveTimer);
            state.autoSaveTimer = null;
        }
        state.autoSavePending = false;
    };
    const scheduleAutoSave = () => {
        // Check if any group (not just the active one) has dirty files.
        const hasDirty = dirtyFiles.size > 0;
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
            saveDirtyFiles().catch((error) => {
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
            return;
        }
        if (type === "env:checkResult") {
            deps.settings.updateEnvStatus(payload.command, payload.available);
            return;
        }
        if (type === "env:installResult") {
            const { target, success, message } = payload;
            console.log(`Install result for ${target}: ${success} - ${message}`);
            if (!success) {
                console.warn(`Environment install failed for ${target}: ${message}`);
            }
            return;
        }
        const pendingIndex = state.pendingOpenRequests.findIndex((entry) => entry.path === payload.path);
        const pendingEntry = pendingIndex >= 0
            ? state.pendingOpenRequests.splice(pendingIndex, 1)[0]
            : null;
        let targetGroupKey = (_a = pendingEntry === null || pendingEntry === void 0 ? void 0 : pendingEntry.group) !== null && _a !== void 0 ? _a : getActiveEditorGroupKey();
        if (!payload.path) {
            return;
        }
        const path = payload.path;
        const kind = payload.kind === "text" && !isTextFilePath(path)
            ? "unsupported"
            : (_b = payload.kind) !== null && _b !== void 0 ? _b : (isPdfFilePath(path)
                ? "pdf"
                : isImageFilePath(path)
                    ? "image"
                    : isTextFilePath(path)
                        ? "text"
                        : "unsupported");
        if (pendingIndex < 0) {
            if (kind === "pdf") {
                setSplitViewEnabled(true);
                targetGroupKey = "secondary";
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
            return;
        }
        if (pendingEntry === null || pendingEntry === void 0 ? void 0 : pendingEntry.background) {
            if (kind !== "text") {
                deps.updateIssues(1, "The live preview source is not editable.", "error", [
                    { severity: "error", message: "The live preview source is not editable." },
                ]);
                return;
            }
            const entry = ensureModelEntry(path, (_c = payload.content) !== null && _c !== void 0 ? _c : "", (_d = payload.content) !== null && _d !== void 0 ? _d : "");
            if (!entry) {
                deps.updateFallback("Editor is not ready.");
                return;
            }
            addOpenTab(targetGroup, path);
            deps.editorTabs.render(targetGroup);
            return;
        }
        if (kind === "image" || kind === "pdf") {
            applyViewerFile(targetGroup, path, kind, payload.data, payload.mimeType);
            return;
        }
        if (kind === "unsupported") {
            applyUnsupportedFile(targetGroup, path);
            return;
        }
        const content = (_e = payload.content) !== null && _e !== void 0 ? _e : "";
        applyFileContent(targetGroup, path, content, content);
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
        handleSaveResult,
        clearContentConflicts,
    };
};
