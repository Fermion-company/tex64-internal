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
    const { applyFormattedContent, requestOpenFile, saveCurrentFile, saveDirtyFiles, scheduleAutoSave, handleOpenFileResult, handleSaveResult, } = createEditorSessionFileOps({
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
    // PDF direct-edit sessions operate on Monaco models, not on disk.  A
    // session keeps one stable source anchor while the replacement grows and
    // brackets all keystrokes with a single undo-stack boundary.  If the
    // target is an unopened child file, only the newest pending value is kept
    // while the normal open-file path loads its model.
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
            line++;
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
                editor.executeEdits("live-pdf-edit", [{ range, text: replacement, forceMoveMarkers: true }]);
            }
            else {
                entry.model.setValue(current.slice(0, startOffset) + replacement + current.slice(endOffset));
            }
        }
        bufferOps.updateDirtyState(path, entry.model.getValue(), entry.savedContent);
        scheduleAutoSave();
        return true;
    };
    const applyLoadedLiveEdit = (payload) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const entry = runtime.monacoModels.get(payload.path);
        if (!entry)
            return false;
        const existing = liveEditSessions.get(payload.sessionId);
        if (payload.finish && existing) {
            (_b = (_a = entry.model).pushStackElement) === null || _b === void 0 ? void 0 : _b.call(_a);
            liveEditSessions.delete(payload.sessionId);
            return true;
        }
        const current = entry.model.getValue();
        let startOffset = (_c = existing === null || existing === void 0 ? void 0 : existing.startOffset) !== null && _c !== void 0 ? _c : offsetAt(current, payload.start);
        const expected = (_d = existing === null || existing === void 0 ? void 0 : existing.lastReplacement) !== null && _d !== void 0 ? _d : payload.baseValue;
        if (current.slice(startOffset, startOffset + expected.length) !== expected) {
            // The editor may have changed just before the preview click.  Relocate
            // only when the expected span is unique near the mapped line; never
            // guess across the whole document and risk editing the wrong sentence.
            const lo = Math.max(0, startOffset - 800);
            const hi = Math.min(current.length, startOffset + expected.length + 800);
            const windowText = current.slice(lo, hi);
            const first = windowText.indexOf(expected);
            const second = first < 0 ? -1 : windowText.indexOf(expected, first + Math.max(1, expected.length));
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
        if (!replaceModelRange(payload.path, startOffset, startOffset + expected.length, replacement))
            return false;
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
            // The model can become available between two messages from the same
            // PDF edit session.  Do not let an older queued replacement replay
            // after the newer value has already been applied to that model.
            pendingLiveEdits.delete(payload.sessionId);
            return true;
        }
        if (payload.cancel) {
            pendingLiveEdits.delete(payload.sessionId);
            return false;
        }
        // A fast in-place edit can finish before an unopened child model has
        // loaded. Keep the finish payload itself: it contains the final
        // replacement, so flushPendingLiveEdits can apply it once and close the
        // undo group instead of silently discarding the last value.
        pendingLiveEdits.set(payload.sessionId, payload);
        if (!openingLivePaths.has(payload.path)) {
            openingLivePaths.add(payload.path);
            const requested = requestOpenFile(payload.path, coreOps.getActiveEditorGroupKey());
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
    return {
        getEditorGroup: coreOps.getEditorGroup,
        getEditorGroups: () => Object.values(runtime.editorGroups),
        getActiveGroup: coreOps.getActiveGroup,
        getActiveEditorGroupKey: coreOps.getActiveEditorGroupKey,
        getActiveFilePath: coreOps.getActiveFilePath,
        getActiveFileSnapshot: coreOps.getActiveFileSnapshot,
        getActiveSelectionSnapshot: coreOps.getActiveSelectionSnapshot,
        getOpenFileSnapshots: coreOps.getOpenFileSnapshots,
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
        syncWorkspaceFiles: workspaceOps.syncWorkspaceFiles,
        getDirtyPaths: workspaceOps.getDirtyPaths,
        getStoredCursorPosition: cursorOps.getStoredCursorPosition,
        recordCursorPosition: cursorOps.recordCursorPosition,
    };
};
