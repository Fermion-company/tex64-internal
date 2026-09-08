import { createEditorSessionFileOps } from "../editor-session-file-ops.js";
import { createEditorSessionRuntime } from "./runtime.js";
import { createEditorSessionCoreOps } from "./core-ops.js";
import { createEditorSessionSplitViewOps } from "./split-view-ops.js";
import { createEditorSessionIssueOps } from "./issue-ops.js";
import { createEditorSessionBufferOps } from "./buffer-ops.js";
import { createEditorSessionTabStateOps } from "./tab-state-ops.js";
import { createEditorSessionTabOps } from "./tab-ops.js";
import { createEditorSessionNavigationOps } from "./navigation-ops.js";
import { createEditorSessionInitialOpenOps } from "./initial-open-ops.js";
import { createEditorSessionWorkspaceOps } from "./workspace-ops.js";
import { createEditorSessionCursorOps } from "./cursor-ops.js";
import { createEditorSessionIssueFocusOps } from "./issue-focus.js";
export const initEditorSession = (context, deps) => {
    const runtime = createEditorSessionRuntime(context, deps);
    const coreOps = createEditorSessionCoreOps(runtime);
    const splitViewOps = createEditorSessionSplitViewOps(runtime, coreOps);
    const issueOps = createEditorSessionIssueOps(runtime, coreOps);
    const bufferOps = createEditorSessionBufferOps(runtime, coreOps);
    const tabStateOps = createEditorSessionTabStateOps(runtime);
    const { applyFormattedContent, requestOpenFile, requestOpenFileInBackground, saveCurrentFile, saveDirtyFiles, scheduleAutoSave, handleOpenFileResult, handleSaveResult, clearContentConflicts, } = createEditorSessionFileOps({
        deps: runtime.deps,
        editorGroups: runtime.editorGroups,
        monacoModels: runtime.monacoModels,
        dirtyFiles: runtime.dirtyFiles,
        state: runtime.fileOpsState,
        getActiveEditorGroupKey: coreOps.getActiveEditorGroupKey,
        getActiveGroup: coreOps.getActiveGroup,
        getEditorGroup: coreOps.getEditorGroup,
        isActiveGroup: coreOps.isActiveGroup,
        resolveAutoOpenGroupKey: coreOps.resolveAutoOpenGroupKey,
        findGroupKeyByPath: coreOps.findGroupKeyByPath,
        setSplitViewEnabled: splitViewOps.setSplitViewEnabled,
        cacheCurrentBuffer: bufferOps.cacheCurrentBuffer,
        clearJumpHighlight: issueOps.clearJumpHighlight,
        clearTemporaryTabs: tabStateOps.clearTemporaryTabs,
        addOpenTab: tabStateOps.addOpenTab,
        updateDirtyState: bufferOps.updateDirtyState,
        restoreViewState: bufferOps.restoreViewState,
        setEditorLanguage: bufferOps.setEditorLanguage,
        updateBreadcrumbs: splitViewOps.updateBreadcrumbs,
        updateMiniOutline: splitViewOps.updateMiniOutline,
        revealLine: issueOps.revealLine,
        forEachEditorGroup: coreOps.forEachEditorGroup,
        scheduleAfterComposition: bufferOps.scheduleAfterComposition,
        getLanguageIdForPath: bufferOps.getLanguageIdForPath,
    });
    const tabOps = createEditorSessionTabOps(runtime, coreOps, splitViewOps, bufferOps, {
        requestOpenFile,
    });
    const navigationOps = createEditorSessionNavigationOps(runtime, coreOps, issueOps, {
        applyFormattedContent,
        requestOpenFile,
    });
    const initialOpenOps = createEditorSessionInitialOpenOps(runtime, coreOps, {
        requestOpenFile,
    });
    const workspaceOps = createEditorSessionWorkspaceOps(runtime, coreOps, splitViewOps, bufferOps);
    const cursorOps = createEditorSessionCursorOps(runtime);
    const issueFocusOps = createEditorSessionIssueFocusOps(runtime, coreOps, issueOps, navigationOps, { requestOpenFile });
    // A direct edit from the live PDF changes the same Monaco model as the
    // source editor. Keep one stable source anchor per overlay session so each
    // keystroke replaces the previous value instead of drifting through the
    // document. The first and last edits form one Monaco undo step.
    const liveEditSessions = new Map();
    const pendingLiveEdits = new Map();
    const openingLivePaths = new Set();
    const offsetAt = (text, position) => {
        const targetLine = Math.max(1, Math.floor(Number(position.line) || 1));
        const targetColumn = Math.max(1, Math.floor(Number(position.column) || 1));
        let line = 1;
        let offset = 0;
        while (line < targetLine && offset < text.length) {
            const newline = text.indexOf("\n", offset);
            if (newline < 0)
                return text.length;
            offset = newline + 1;
            line += 1;
        }
        const lineEnd = text.indexOf("\n", offset);
        return Math.min(lineEnd < 0 ? text.length : lineEnd, offset + targetColumn - 1);
    };
    const positionAt = (text, rawOffset) => {
        var _a, _b;
        const offset = Math.max(0, Math.min(text.length, rawOffset));
        const prefix = text.slice(0, offset);
        const lines = prefix.split("\n");
        return { lineNumber: lines.length, column: ((_b = (_a = lines[lines.length - 1]) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) + 1 };
    };
    const replaceModelRange = (path, startOffset, endOffset, replacement) => {
        var _a;
        const entry = runtime.monacoModels.get(path);
        if (!entry)
            return false;
        const current = entry.model.getValue();
        const start = positionAt(current, startOffset);
        const end = positionAt(current, endOffset);
        const range = {
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
        };
        if (entry.model.pushEditOperations) {
            entry.model.pushEditOperations([], [{ range, text: replacement, forceMoveMarkers: true }], () => null);
        }
        else {
            const owner = Object.values(runtime.editorGroups).find((group) => group.currentFilePath === path);
            const editor = owner === null || owner === void 0 ? void 0 : owner.editor;
            if (editor === null || editor === void 0 ? void 0 : editor.executeEdits) {
                editor.executeEdits("live-pdf-edit", [
                    { range, text: replacement, forceMoveMarkers: true },
                ]);
            }
            else {
                entry.model.setValue(current.slice(0, startOffset) + replacement + current.slice(endOffset));
            }
        }
        bufferOps.updateDirtyState(path, entry.model.getValue(), entry.savedContent);
        (_a = deps.onLivePreviewSourceChanged) === null || _a === void 0 ? void 0 : _a.call(deps);
        scheduleAutoSave();
        return true;
    };
    const applyLoadedLiveEdit = (payload) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const entry = runtime.monacoModels.get(payload.path);
        if (!entry)
            return false;
        const existing = liveEditSessions.get(payload.sessionId);
        if (existing && existing.path !== payload.path)
            return false;
        if (payload.finish &&
            !payload.cancel &&
            existing &&
            payload.replacement === existing.lastReplacement) {
            (_b = (_a = entry.model).pushStackElement) === null || _b === void 0 ? void 0 : _b.call(_a);
            liveEditSessions.delete(payload.sessionId);
            return true;
        }
        const current = entry.model.getValue();
        let startOffset = (_c = existing === null || existing === void 0 ? void 0 : existing.startOffset) !== null && _c !== void 0 ? _c : offsetAt(current, payload.start);
        const expected = (_d = existing === null || existing === void 0 ? void 0 : existing.lastReplacement) !== null && _d !== void 0 ? _d : payload.baseValue;
        if (current.slice(startOffset, startOffset + expected.length) !== expected) {
            // A source edit can race the preview click. Relocate only when the old
            // span is unique near the mapped line; never guess across the document.
            const lo = Math.max(0, startOffset - 800);
            const hi = Math.min(current.length, startOffset + expected.length + 800);
            const windowText = current.slice(lo, hi);
            const first = windowText.indexOf(expected);
            const second = first < 0
                ? -1
                : windowText.indexOf(expected, first + Math.max(1, expected.length));
            if (first < 0 || second >= 0)
                return false;
            startOffset = lo + first;
        }
        if (!existing) {
            (_f = (_e = entry.model).pushStackElement) === null || _f === void 0 ? void 0 : _f.call(_e);
            liveEditSessions.set(payload.sessionId, {
                path: payload.path,
                startOffset,
                lastReplacement: expected,
            });
        }
        const replacement = payload.cancel ? payload.baseValue : payload.replacement;
        if (!replaceModelRange(payload.path, startOffset, startOffset + expected.length, replacement)) {
            return false;
        }
        const session = liveEditSessions.get(payload.sessionId);
        if (payload.cancel || payload.finish) {
            (_h = (_g = entry.model).pushStackElement) === null || _h === void 0 ? void 0 : _h.call(_g);
            liveEditSessions.delete(payload.sessionId);
        }
        else if (session) {
            session.lastReplacement = replacement;
        }
        return true;
    };
    const flushPendingLiveEdits = (path) => {
        openingLivePaths.delete(path);
        for (const [sessionId, payload] of [...pendingLiveEdits]) {
            if (payload.path !== path)
                continue;
            if (applyLoadedLiveEdit(payload))
                pendingLiveEdits.delete(sessionId);
        }
    };
    const applyLivePreviewEdit = (payload) => {
        if (!(payload === null || payload === void 0 ? void 0 : payload.sessionId) || !payload.path || !payload.start || !payload.end)
            return false;
        if (applyLoadedLiveEdit(payload)) {
            pendingLiveEdits.delete(payload.sessionId);
            return true;
        }
        if (payload.cancel) {
            pendingLiveEdits.delete(payload.sessionId);
            return false;
        }
        // An edit can finish before an unopened child file has loaded. Keep only
        // that session's latest value and apply it after the normal open path has
        // created the Monaco model.
        pendingLiveEdits.set(payload.sessionId, payload);
        if (!openingLivePaths.has(payload.path)) {
            openingLivePaths.add(payload.path);
            // Load an unopened child into a background Monaco model. Switching the
            // visible primary editor would blur and close the live PDF overlay.
            const requested = requestOpenFileInBackground(payload.path, "primary");
            if (!requested) {
                openingLivePaths.delete(payload.path);
                window.setTimeout(() => flushPendingLiveEdits(payload.path), 0);
            }
        }
        return true;
    };
    const handleOpenFileResultWithLiveEdit = (payload) => {
        handleOpenFileResult(payload);
        if (payload.error) {
            openingLivePaths.delete(payload.path);
            for (const [sessionId, pending] of pendingLiveEdits) {
                if (pending.path === payload.path)
                    pendingLiveEdits.delete(sessionId);
            }
            return;
        }
        queueMicrotask(() => flushPendingLiveEdits(payload.path));
    };
    const clearLivePreviewEdits = () => {
        var _a, _b, _c;
        for (const session of liveEditSessions.values()) {
            (_c = (_a = runtime.monacoModels.get(session.path)) === null || _a === void 0 ? void 0 : (_b = _a.model).pushStackElement) === null || _c === void 0 ? void 0 : _c.call(_b);
        }
        liveEditSessions.clear();
        pendingLiveEdits.clear();
        openingLivePaths.clear();
    };
    const pendingExternalChanges = new Map();
    const handleExternalFileChange = (payload) => {
        const entry = runtime.monacoModels.get(payload.path);
        const groupKey = coreOps.findGroupKeyByPath(payload.path);
        if (!entry || !groupKey)
            return;
        const group = coreOps.getEditorGroup(groupKey);
        pendingExternalChanges.set(payload.path, payload);
        const apply = () => {
            var _a, _b, _c;
            if (pendingExternalChanges.get(payload.path) !== payload)
                return;
            if (runtime.monacoModels.get(payload.path) !== entry) {
                pendingExternalChanges.delete(payload.path);
                return;
            }
            if (group.isComposing) {
                window.setTimeout(apply, 100);
                return;
            }
            pendingExternalChanges.delete(payload.path);
            if (!payload.fileDeleted && payload.content === entry.savedContent)
                return;
            if (!payload.fileDeleted && ((_a = runtime.fileOpsState.pendingSave) === null || _a === void 0 ? void 0 : _a.path) === payload.path &&
                runtime.fileOpsState.pendingSave.content === payload.content)
                return;
            applyFormattedContent(group, payload.path, (_b = payload.content) !== null && _b !== void 0 ? _b : "", {
                updateSaved: true,
                showAiDiff: false,
                expectedContent: entry.savedContent,
                fileDeleted: payload.fileDeleted,
                externalChange: true,
            });
            (_c = deps.onLivePreviewSourceChanged) === null || _c === void 0 ? void 0 : _c.call(deps);
        };
        apply();
    };
    return {
        getEditorGroup: coreOps.getEditorGroup,
        getEditorGroups: () => Object.values(runtime.editorGroups),
        getActiveGroup: coreOps.getActiveGroup,
        getActiveEditorGroupKey: coreOps.getActiveEditorGroupKey,
        getActiveFilePath: coreOps.getActiveFilePath,
        getActiveFileSnapshot: coreOps.getActiveFileSnapshot,
        getActiveSelectionSnapshot: coreOps.getActiveSelectionSnapshot,
        getOpenFileSnapshots: coreOps.getOpenFileSnapshots,
        getHistoryBuffers: () => Array.from(runtime.monacoModels.entries()).map(([path, entry]) => ({ path, content: entry.model.getValue(), savedContent: entry.savedContent })),
        applyHistoryFiles: (files) => {
            var _a, _b;
            for (const file of files) {
                const entry = runtime.monacoModels.get(file.path);
                if (!entry)
                    continue;
                if (entry.model.getValue() !== entry.savedContent)
                    throw new Error("An editor changed during restoration. Its unsaved content has been retained.");
                const groups = Object.values(runtime.editorGroups);
                if (file.content === null) {
                    for (const group of groups)
                        if (group.openTabs.includes(file.path))
                            tabOps.closeTab(group, file.path);
                    (_b = (_a = entry.model).dispose) === null || _b === void 0 ? void 0 : _b.call(_a);
                    runtime.monacoModels.delete(file.path);
                    runtime.dirtyFiles.delete(file.path);
                    continue;
                }
                for (const group of groups)
                    group.isApplyingFile = true;
                try {
                    entry.model.setValue(file.content);
                    entry.savedContent = file.content;
                    bufferOps.updateDirtyState(file.path, file.content, file.content);
                    for (const group of groups)
                        if (group.currentFilePath === file.path)
                            group.currentFileSavedContent = file.content;
                }
                finally {
                    for (const group of groups)
                        group.isApplyingFile = false;
                }
            }
            splitViewOps.updateBreadcrumbs();
            deps.fileTree.render();
        },
        isActiveGroup: coreOps.isActiveGroup,
        forEachEditorGroup: coreOps.forEachEditorGroup,
        setEditorGroupEmptyState: splitViewOps.setEditorGroupEmptyState,
        isAnyGroupComposing: splitViewOps.isAnyGroupComposing,
        updateBreadcrumbs: splitViewOps.updateBreadcrumbs,
        updateMiniOutline: splitViewOps.updateMiniOutline,
        setActiveGroup: splitViewOps.setActiveGroup,
        setSplitViewEnabled: splitViewOps.setSplitViewEnabled,
        getSplitViewEnabled: splitViewOps.getSplitViewEnabled,
        cacheCurrentBuffer: bufferOps.cacheCurrentBuffer,
        addOpenTab: tabStateOps.addOpenTab,
        closeTab: tabOps.closeTab,
        scheduleAfterComposition: bufferOps.scheduleAfterComposition,
        handleCompositionEnd: bufferOps.handleCompositionEnd,
        updateDirtyState: bufferOps.updateDirtyState,
        clearJumpHighlight: issueOps.clearJumpHighlight,
        scheduleAutoSave,
        requestOpenFile,
        jumpToFileLine: navigationOps.jumpToFileLine,
        jumpToLocation: navigationOps.jumpToLocation,
        applyFormattedContent,
        applyContentToOpenFile: navigationOps.applyContentToOpenFile,
        applyLivePreviewEdit,
        handleExternalFileChange,
        saveCurrentFile,
        saveDirtyFiles,
        requestInitialOpen: initialOpenOps.requestInitialOpen,
        openPendingFileIfReady: initialOpenOps.openPendingFileIfReady,
        clearIssueHighlight: issueOps.clearIssueHighlight,
        syncIssueMarkers: issueOps.syncIssueMarkers,
        parseIssueDetail: issueOps.parseIssueDetail,
        focusIssue: issueFocusOps.focusIssue,
        handleOpenFileResult: handleOpenFileResultWithLiveEdit,
        handleSaveResult,
        handleRenameResult: workspaceOps.handleRenameResult,
        syncWorkspaceFiles: (payload) => {
            if (payload.rootChanged) {
                clearContentConflicts();
                clearLivePreviewEdits();
                pendingExternalChanges.clear();
            }
            workspaceOps.syncWorkspaceFiles(payload);
        },
        getDirtyPaths: workspaceOps.getDirtyPaths,
        getStoredCursorPosition: cursorOps.getStoredCursorPosition,
        recordCursorPosition: cursorOps.recordCursorPosition,
    };
};
