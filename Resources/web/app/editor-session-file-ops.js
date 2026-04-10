import { isImageFilePath, isPdfFilePath, isTextFilePath } from "./files.js";
import { buildLineDiff } from "./diff.js";
export const createEditorSessionFileOps = (ctx) => {
    const { deps, editorGroups, monacoModels, dirtyFiles, state, getActiveEditorGroupKey, getActiveGroup, getEditorGroup, isActiveGroup, resolveAutoOpenGroupKey, findGroupKeyByPath, setSplitViewEnabled, cacheCurrentBuffer, clearJumpHighlight, clearTemporaryTabs, addOpenTab, updateDirtyState, restoreViewState, setEditorLanguage, updateBreadcrumbs, updateMiniOutline, revealLine, forEachEditorGroup, scheduleAfterComposition, getLanguageIdForPath, } = ctx;
    /**
     * Replace model content via executeEdits (preserves undo stack) when available,
     * falling back to setValue (clears undo stack) otherwise.
     */
    const replaceContentViaEdits = (editor, model, newContent, source) => {
        var _a, _b;
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
        group.viewer.showUnsupportedViewer();
        if (isActiveGroup(group)) {
            deps.buildOps.updateSynctexButtonState();
            deps.fileTree.setTreeFocus(false);
        }
    };
    const ensureModelEntry = (path, content, savedContent) => {
        var _a;
        const monacoApi = deps.getMonacoApi();
        if (!monacoApi) {
            return null;
        }
        const entry = monacoModels.get(path);
        if (entry) {
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
        const model = monacoApiAny.editor.createModel(content, getLanguageIdForPath(path));
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
        var _a, _b, _c, _d, _e, _f, _g, _h;
        if (!group.editor) {
            return;
        }
        const editor = group.editor;
        const entry = monacoModels.get(path);
        const currentValue = (_c = (_a = entry === null || entry === void 0 ? void 0 : entry.model.getValue()) !== null && _a !== void 0 ? _a : (_b = editor.getValue) === null || _b === void 0 ? void 0 : _b.call(editor)) !== null && _c !== void 0 ? _c : "";
        const viewState = (_d = editor.saveViewState) === null || _d === void 0 ? void 0 : _d.call(editor);
        if (currentValue !== content) {
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
            replaceContentViaEdits(editor, (_e = entry === null || entry === void 0 ? void 0 : entry.model) !== null && _e !== void 0 ? _e : null, content, (options === null || options === void 0 ? void 0 : options.showAiDiff) ? "ai-apply" : "format-on-save");
            group.isApplyingFile = false;
            if (viewState && editor.restoreViewState) {
                editor.restoreViewState(viewState);
            }
            // Add AI diff decorations
            if ((options === null || options === void 0 ? void 0 : options.showAiDiff) && changedLineNumbers.length > 0 && editor.deltaDecorations) {
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
                // Show Undo/Confirm bar
                const editorDom = (_f = editor.getDomNode) === null || _f === void 0 ? void 0 : _f.call(editor);
                const editorContainer = editorDom === null || editorDom === void 0 ? void 0 : editorDom.parentElement;
                if (editorContainer) {
                    const existing = document.getElementById("ai-undo-keep-bar");
                    if (existing)
                        existing.remove();
                    const bar = document.createElement("div");
                    bar.id = "ai-undo-keep-bar";
                    bar.className = "ai-undo-keep-bar";
                    const undoBtn = document.createElement("button");
                    undoBtn.className = "ai-undo-keep-btn is-undo";
                    undoBtn.textContent = "Undo";
                    undoBtn.addEventListener("click", () => {
                        var _a;
                        // Use Monaco's undo — the AI edit is on the undo stack
                        const editorTrigger = group.editor;
                        (_a = editorTrigger === null || editorTrigger === void 0 ? void 0 : editorTrigger.trigger) === null || _a === void 0 ? void 0 : _a.call(editorTrigger, "ai-undo-bar", "undo", null);
                        clearAiDiffDecorations(group);
                    });
                    const keepBtn = document.createElement("button");
                    keepBtn.className = "ai-undo-keep-btn is-keep";
                    keepBtn.textContent = "Confirm";
                    keepBtn.addEventListener("click", () => {
                        clearAiDiffDecorations(group);
                    });
                    bar.append(undoBtn, keepBtn);
                    editorContainer.appendChild(bar);
                }
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
        const savedContent = (_h = (_g = (group.currentFilePath === path
            ? group.currentFileSavedContent
            : entry === null || entry === void 0 ? void 0 : entry.savedContent)) !== null && _g !== void 0 ? _g : entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _h !== void 0 ? _h : content;
        updateDirtyState(path, content, savedContent);
        if (isActiveGroup(group)) {
            updateBreadcrumbs();
            deps.fileTree.render();
        }
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
                : existingGroupKey !== null && existingGroupKey !== void 0 ? existingGroupKey : resolveAutoOpenGroupKey(groupKey);
        const group = getEditorGroup(resolvedGroupKey);
        if (group.currentFilePath === path) {
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
    const saveCurrentFileInternal = () => {
        const activeGroup = getActiveGroup();
        const activePath = activeGroup.currentFilePath;
        if (!activePath || !activeGroup.editor || !isTextFilePath(activePath)) {
            const message = activePath
                ? "This file format cannot be edited."
                : "No files have been selected to save.";
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
            return Promise.resolve(false);
        }
        const editor = activeGroup.editor;
        const content = editor.getValue();
        const savePathContent = (path, value, timeoutMs = 8000) => new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const enqueue = () => {
                if (state.pendingSave) {
                    if (Date.now() - startedAt >= timeoutMs) {
                        reject("Waiting for save timed out.");
                        return;
                    }
                    window.setTimeout(enqueue, 25);
                    return;
                }
                state.pendingSave = { path, content: value, resolve, reject };
                // Safety timeout: if the native side never responds, release the lock so
                // subsequent saves are not blocked indefinitely.
                const safetyTimer = window.setTimeout(() => {
                    if (state.pendingSave && state.pendingSave.path === path) {
                        console.warn(`[file-ops] pendingSave safety timeout for "${path}"`);
                        state.pendingSave.reject("Timed out waiting for a save response.");
                        state.pendingSave = null;
                    }
                }, 30000);
                const origResolve = resolve;
                const origReject = reject;
                const wrappedResolve = (v) => { clearTimeout(safetyTimer); origResolve(v); };
                const wrappedReject = (e) => { clearTimeout(safetyTimer); origReject(e); };
                state.pendingSave.resolve = wrappedResolve;
                state.pendingSave.reject = wrappedReject;
                const ok = deps.postToNative({
                    type: "saveFile",
                    path,
                    content: value,
                    format: false,
                });
                if (!ok) {
                    clearTimeout(safetyTimer);
                    state.pendingSave = null;
                    reject("Native integration is not available.");
                }
            };
            enqueue();
        });
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
    const saveDirtyFiles = async () => {
        const dirtyPaths = Array.from(dirtyFiles).filter((path) => isTextFilePath(path));
        if (dirtyPaths.length === 0) {
            return true;
        }
        const activePath = getActiveGroup().currentFilePath;
        const ordered = dirtyPaths.slice().sort((a, b) => {
            if (a === activePath) {
                return -1;
            }
            if (b === activePath) {
                return 1;
            }
            return a.localeCompare(b, "ja");
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
                deps.updateIssues(1, `Unable to retrieve content to save: ${path}`, "error", [
                    { severity: "error", message: `Unable to retrieve content to save: ${path}` },
                ]);
                return false;
            }
            try {
                await new Promise((resolve, reject) => {
                    const startedAt = Date.now();
                    const enqueue = () => {
                        if (state.pendingSave) {
                            if (Date.now() - startedAt >= 8000) {
                                reject("Waiting for save timed out.");
                                return;
                            }
                            window.setTimeout(enqueue, 25);
                            return;
                        }
                        state.pendingSave = { path, content, resolve, reject };
                        const safetyTimer = window.setTimeout(() => {
                            if (state.pendingSave && state.pendingSave.path === path) {
                                console.warn(`[file-ops] pendingSave safety timeout for "${path}"`);
                                state.pendingSave.reject("Timed out waiting for a save response.");
                                state.pendingSave = null;
                            }
                        }, 30000);
                        const origResolve2 = resolve;
                        const origReject2 = reject;
                        state.pendingSave.resolve = (v) => { clearTimeout(safetyTimer); origResolve2(v); };
                        state.pendingSave.reject = (e) => { clearTimeout(safetyTimer); origReject2(e); };
                        const ok = deps.postToNative({
                            type: "saveFile",
                            path,
                            content,
                            format: false,
                        });
                        if (!ok) {
                            clearTimeout(safetyTimer);
                            state.pendingSave = null;
                            reject("Native integration is not available.");
                        }
                    };
                    enqueue();
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "Saving failed.";
                deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
                return false;
            }
        }
        return true;
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
                deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
            });
        }, 400);
    };
    const handleOpenFileResult = (payload) => {
        var _a, _b;
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
        let targetGroupKey = pendingIndex >= 0
            ? state.pendingOpenRequests.splice(pendingIndex, 1)[0].group
            : getActiveEditorGroupKey();
        if (!payload.path) {
            return;
        }
        const path = payload.path;
        const kind = (_a = payload.kind) !== null && _a !== void 0 ? _a : (isPdfFilePath(path)
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
        if (kind === "image" || kind === "pdf") {
            applyViewerFile(targetGroup, path, kind, payload.data, payload.mimeType);
            return;
        }
        if (kind === "unsupported") {
            applyUnsupportedFile(targetGroup, path);
            return;
        }
        const content = (_b = payload.content) !== null && _b !== void 0 ? _b : "";
        applyFileContent(targetGroup, path, content, content);
    };
    const handleSaveResult = (payload) => {
        var _a, _b, _c;
        let savedContent = null;
        if (state.pendingSave) {
            if (state.pendingSave.path === payload.path) {
                if (payload.ok) {
                    if (payload.content) {
                        state.pendingSave.content = payload.content;
                    }
                    savedContent = state.pendingSave.content;
                    state.pendingSave.resolve(true);
                }
                else {
                    state.pendingSave.reject((_a = payload.error) !== null && _a !== void 0 ? _a : "Saving failed.");
                }
                state.pendingSave = null;
            }
            else {
                // Path mismatch: the native side returned a result for a different path.
                // Log and leave pendingSave intact so the correct result can still arrive.
                console.warn(`[file-ops] handleSaveResult path mismatch: expected "${state.pendingSave.path}", got "${payload.path}"`);
            }
        }
        if (!payload.ok) {
            deps.updateIssues(1, (_b = payload.error) !== null && _b !== void 0 ? _b : "Saving failed.", "error", [
                { severity: "error", message: (_c = payload.error) !== null && _c !== void 0 ? _c : "Saving failed." },
            ]);
            return;
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
        saveCurrentFile,
        saveDirtyFiles,
        scheduleAutoSave,
        handleOpenFileResult,
        handleSaveResult,
    };
};
