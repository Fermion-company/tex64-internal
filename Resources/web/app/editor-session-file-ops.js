import { isImageFilePath, isPdfFilePath, isTextFilePath } from "./files.js";
export const createEditorSessionFileOps = (ctx) => {
    const { deps, editorGroups, monacoModels, dirtyFiles, state, getActiveEditorGroupKey, getActiveGroup, getEditorGroup, isActiveGroup, resolveAutoOpenGroupKey, findGroupKeyByPath, cacheCurrentBuffer, clearJumpHighlight, clearTemporaryTabs, addOpenTab, updateDirtyState, restoreViewState, setEditorLanguage, updateBreadcrumbs, updateMiniOutline, revealLine, forEachEditorGroup, scheduleAfterComposition, getLanguageIdForPath, } = ctx;
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
            deps.updateFallback("エディタの準備が完了していません。");
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
            revealLine(group, state.pendingReveal.line);
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
    const applyFormattedContent = (group, path, content, options) => {
        var _a, _b, _c, _d, _e, _f;
        if (!group.editor) {
            return;
        }
        const editor = group.editor;
        const entry = monacoModels.get(path);
        const currentValue = (_c = (_a = entry === null || entry === void 0 ? void 0 : entry.model.getValue()) !== null && _a !== void 0 ? _a : (_b = editor.getValue) === null || _b === void 0 ? void 0 : _b.call(editor)) !== null && _c !== void 0 ? _c : "";
        const viewState = (_d = editor.saveViewState) === null || _d === void 0 ? void 0 : _d.call(editor);
        if (currentValue !== content) {
            group.isApplyingFile = true;
            if (entry === null || entry === void 0 ? void 0 : entry.model.setValue) {
                entry.model.setValue(content);
            }
            else if (editor.setValue) {
                editor.setValue(content);
            }
            group.isApplyingFile = false;
            if (viewState && editor.restoreViewState) {
                editor.restoreViewState(viewState);
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
        const savedContent = (_f = (_e = (group.currentFilePath === path
            ? group.currentFileSavedContent
            : entry === null || entry === void 0 ? void 0 : entry.savedContent)) !== null && _e !== void 0 ? _e : entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _f !== void 0 ? _f : content;
        updateDirtyState(path, content, savedContent);
        if (isActiveGroup(group)) {
            updateBreadcrumbs();
            deps.fileTree.render();
        }
    };
    const requestOpenFile = (path, groupKey, force = false) => {
        const existingGroupKey = !force ? findGroupKeyByPath(path) : null;
        const resolvedGroupKey = force
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
            deps.updateIssues(1, "ファイルを開けません。", "error", [
                { severity: "error", message: "ファイルを開けません。" },
            ]);
        }
        return ok;
    };
    const saveCurrentFileInternal = () => {
        const activeGroup = getActiveGroup();
        const activePath = activeGroup.currentFilePath;
        if (!activePath || !activeGroup.editor || !isTextFilePath(activePath)) {
            const message = activePath
                ? "このファイル形式は編集できません。"
                : "保存するファイルが選択されていません。";
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
            return Promise.resolve(false);
        }
        const editor = activeGroup.editor;
        const content = editor.getValue();
        return new Promise((resolve, reject) => {
            state.pendingSave = { path: activePath, content, resolve, reject };
            const shouldFormat = false;
            const ok = deps.postToNative({
                type: "saveFile",
                path: activePath,
                content,
                format: shouldFormat,
                formatSource: "save",
                formatSettings: deps.settings.buildFormatSettingsPayload(),
            });
            if (!ok) {
                state.pendingSave = null;
                reject("ネイティブ連携が利用できません。");
            }
        });
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
    const clearAutoSaveTimer = () => {
        if (state.autoSaveTimer) {
            window.clearTimeout(state.autoSaveTimer);
            state.autoSaveTimer = null;
        }
        state.autoSavePending = false;
    };
    const scheduleAutoSave = () => {
        const activeGroup = getActiveGroup();
        const activePath = activeGroup.currentFilePath;
        if (!activePath || !isTextFilePath(activePath)) {
            clearAutoSaveTimer();
            return;
        }
        if (!activeGroup.isDirty) {
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
            saveCurrentFile().catch((message) => {
                deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
            });
        }, 400);
    };
    const handleOpenFileResult = (payload) => {
        var _a, _b;
        const pendingIndex = state.pendingOpenRequests.findIndex((entry) => entry.path === payload.path);
        let targetGroupKey = pendingIndex >= 0
            ? state.pendingOpenRequests.splice(pendingIndex, 1)[0].group
            : getActiveEditorGroupKey();
        if (pendingIndex < 0 && payload.path) {
            const existingGroupKey = findGroupKeyByPath(payload.path);
            if (existingGroupKey) {
                targetGroupKey = existingGroupKey;
            }
            else {
                targetGroupKey = resolveAutoOpenGroupKey(targetGroupKey);
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
                alert(message);
            }
            return;
        }
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
        if (state.pendingSave && state.pendingSave.path === payload.path) {
            if (payload.ok) {
                if (payload.content) {
                    state.pendingSave.content = payload.content;
                }
                savedContent = state.pendingSave.content;
                state.pendingSave.resolve(true);
            }
            else {
                state.pendingSave.reject((_a = payload.error) !== null && _a !== void 0 ? _a : "保存に失敗しました。");
            }
            state.pendingSave = null;
        }
        if (!payload.ok) {
            deps.updateIssues(1, (_b = payload.error) !== null && _b !== void 0 ? _b : "保存に失敗しました。", "error", [
                { severity: "error", message: (_c = payload.error) !== null && _c !== void 0 ? _c : "保存に失敗しました。" },
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
            if (activeGroup.currentFilePath === payload.path && activeGroup.isDirty) {
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
        scheduleAutoSave,
        handleOpenFileResult,
        handleSaveResult,
    };
};
