import type { AppContext } from "../context.js";
import { createEditorSessionFileOps } from "../editor-session-file-ops.js";
import type { EditorSessionApi, EditorSessionDeps, LivePreviewEditPayload,
  LivePreviewAnchorPayload, LivePreviewSourceAnchor } from "./types.js";
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
import { uiText } from "../i18n.js";
import {
  anchorFromLiveEditSnapshot,
  captureLiveEditAnchor,
  rebaseLiveEditAnchor,
  type LiveEditAnchor,
} from "./live-edit-history.js";

export const initEditorSession = (context: AppContext, deps: EditorSessionDeps): EditorSessionApi => {
  const runtime = createEditorSessionRuntime(context, deps);

  const coreOps = createEditorSessionCoreOps(runtime);
  const splitViewOps = createEditorSessionSplitViewOps(runtime, coreOps);
  const issueOps = createEditorSessionIssueOps(runtime, coreOps);
  const bufferOps = createEditorSessionBufferOps(runtime, coreOps);
  const tabStateOps = createEditorSessionTabStateOps(runtime);

  const {
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
  } = createEditorSessionFileOps({
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
  const issueFocusOps = createEditorSessionIssueFocusOps(
    runtime,
    coreOps,
    issueOps,
    navigationOps,
    { requestOpenFile }
  );

  // A direct edit from the live PDF changes the same Monaco model as the
  // source editor. Keep one stable source anchor per overlay session so each
  // keystroke replaces the previous value instead of drifting through the
  // document. The first and last edits form one Monaco undo step.
  type LiveSourceSession = {
    path: string;
    anchor: LiveEditAnchor;
    baseValue: string;
    lastReplacement: string;
    sourceText: string;
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  const liveEditSessions = new Map<string, LiveSourceSession>();
  // Old PDF pixels may still show a region the user already edited and left.
  // Retain its exact, accepted source lineage without keeping an undo step open.
  const completedLiveEditSessions = new Map<string, LiveSourceSession>();
  const rememberCompletedLiveEdit = (id: string, session: LiveSourceSession) => {
    completedLiveEditSessions.delete(id);
    completedLiveEditSessions.set(id, session);
    let cost = [...completedLiveEditSessions.values()].reduce((sum, item) => sum + item.sourceText.length, 0);
    while (completedLiveEditSessions.size > 32 || cost > 4 * 1024 * 1024) {
      const oldest = completedLiveEditSessions.keys().next().value;
      if (oldest === undefined) break;
      cost -= completedLiveEditSessions.get(oldest)!.sourceText.length;
      completedLiveEditSessions.delete(oldest);
    }
  };
  const pendingLiveEdits = new Map<string, LivePreviewEditPayload>();
  const pendingLiveAnchors = new Map<string, {
    payload: LivePreviewAnchorPayload;
    resolve: (anchor: LivePreviewSourceAnchor | null) => void;
  }>();
  const openingLivePaths = new Set<string>();

  const offsetAt = (text: string, position: { line: number; column: number }) => {
    const targetLine = Number(position.line);
    const targetColumn = Number(position.column);
    if (!Number.isInteger(targetLine) || !Number.isInteger(targetColumn) || targetLine < 1 || targetColumn < 1) return null;
    let line = 1;
    let offset = 0;
    while (line < targetLine && offset < text.length) {
      const newline = text.indexOf("\n", offset);
      if (newline < 0) return null;
      offset = newline + 1;
      line += 1;
    }
    if (line !== targetLine) return null;
    const newline = text.indexOf("\n", offset);
    const lineEnd = newline < 0 ? text.length : newline - (text[newline - 1] === "\r" ? 1 : 0);
    const result = offset + targetColumn - 1;
    return result <= lineEnd ? result : null;
  };

  const positionAt = (text: string, rawOffset: number) => {
    const offset = Math.max(0, Math.min(text.length, rawOffset));
    const prefix = text.slice(0, offset);
    const lines = prefix.split("\n");
    return { lineNumber: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
  };

  const replaceModelRange = (
    path: string,
    startOffset: number,
    endOffset: number,
    replacement: string
  ) => {
    const entry = runtime.monacoModels.get(path);
    if (!entry) return false;
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
      entry.model.pushEditOperations(
        [],
        [{ range, text: replacement, forceMoveMarkers: true }],
        () => null
      );
    } else {
      const owner = Object.values(runtime.editorGroups).find(
        (group) => group.currentFilePath === path
      );
      const editor = owner?.editor as {
        executeEdits?: (
          source: string,
          edits: Array<{ range: unknown; text: string; forceMoveMarkers?: boolean }>
        ) => void;
      } | null;
      if (editor?.executeEdits) {
        editor.executeEdits("live-pdf-edit", [
          { range, text: replacement, forceMoveMarkers: true },
        ]);
      } else {
        entry.model.setValue(current.slice(0, startOffset) + replacement + current.slice(endOffset));
      }
    }
    bufferOps.updateDirtyState(path, entry.model.getValue(), entry.savedContent);
    deps.onLivePreviewSourceChanged?.();
    scheduleAutoSave();
    return true;
  };

  const applyLoadedLiveEdit = (payload: LivePreviewEditPayload) => {
    const entry = runtime.monacoModels.get(payload.path);
    if (!entry) return false;
    const existing = liveEditSessions.get(payload.sessionId);
    if (existing && existing.path !== payload.path) return false;
    const current = entry.model.getValue();
    const expected = existing?.lastReplacement ?? payload.baseValue;
    let anchor: LiveEditAnchor | null;
    if (existing) {
      anchor = rebaseLiveEditAnchor(entry.model, existing.anchor);
    } else {
      // Offsets and even a unique nearby string cannot prove which occurrence
      // the displayed PDF refers to. Older senders without a snapshot must wait
      // for a compatible preview instead of guessing against the latest model.
      if (typeof payload.sourceText !== "string") return false;
      const start = offsetAt(payload.sourceText, payload.start);
      const end = offsetAt(payload.sourceText, payload.end);
      if (start === null || end === null || end < start || payload.sourceText.slice(start, end) !== expected) return false;
      anchor = anchorFromLiveEditSnapshot(entry.model, payload.sourceText, start, end);
    }
    if (!anchor || current.slice(anchor.startOffset, anchor.endOffset) !== expected) return false;
    const startOffset = anchor.startOffset;
    if (!existing) {
      entry.model.pushStackElement?.();
      liveEditSessions.set(payload.sessionId, {
        path: payload.path,
        anchor,
        baseValue: payload.baseValue,
        lastReplacement: expected,
        sourceText: payload.sourceText!,
        start: { ...payload.start },
        end: { ...payload.end },
      });
    }
    const requestedReplacement = payload.cancel ? (existing?.baseValue ?? payload.baseValue) : payload.replacement;
    const eol = entry.model.getEOL?.();
    const replacement = eol ? requestedReplacement.replace(/\r\n|\r|\n/g, eol) : requestedReplacement;
    if (replacement !== expected && !replaceModelRange(payload.path, startOffset, anchor.endOffset, replacement)) {
      return false;
    }
    const session = liveEditSessions.get(payload.sessionId);
    if (payload.cancel || payload.finish) {
      entry.model.pushStackElement?.();
      const updatedAnchor = captureLiveEditAnchor(entry.model, startOffset, startOffset + replacement.length);
      if (session && updatedAnchor) rememberCompletedLiveEdit(payload.sessionId,
        { ...session, anchor: updatedAnchor, lastReplacement: replacement });
      liveEditSessions.delete(payload.sessionId);
    } else if (session) {
      const updatedAnchor = captureLiveEditAnchor(entry.model, startOffset, startOffset + replacement.length);
      if (!updatedAnchor) return false;
      session.anchor = updatedAnchor;
      session.lastReplacement = replacement;
    }
    return true;
  };

  const loadedLivePreviewSourceAnchor = (payload: LivePreviewAnchorPayload): LivePreviewSourceAnchor | null => {
    const entry = runtime.monacoModels.get(payload.path);
    if (!entry) return null;
    const previous = payload.previousSessionId
      ? completedLiveEditSessions.get(payload.previousSessionId) : undefined;
    if (payload.previousSessionId && (!previous || previous.path !== payload.path ||
        previous.sourceText !== payload.sourceText || previous.baseValue !== payload.baseValue ||
        previous.start.line !== payload.start.line || previous.start.column !== payload.start.column ||
        previous.end.line !== payload.end.line || previous.end.column !== payload.end.column)) return null;
    const existing = liveEditSessions.get(payload.sessionId) ?? previous;
    if (existing && existing.path !== payload.path) return null;
    const current = entry.model.getValue();
    const expected = existing?.lastReplacement ?? payload.baseValue;
    let anchor: LiveEditAnchor | null;
    if (existing) {
      // The first keystroke may overtake a child-file load or this query.
      // Its tracked anchor already names the accepted replacement.
      anchor = rebaseLiveEditAnchor(entry.model, existing.anchor);
    } else {
      const start = offsetAt(payload.sourceText, payload.start);
      const end = offsetAt(payload.sourceText, payload.end);
      if (start === null || end === null || end < start ||
          payload.sourceText.slice(start, end) !== expected) return null;
      anchor = anchorFromLiveEditSnapshot(entry.model, payload.sourceText, start, end);
    }
    if (!anchor || current.slice(anchor.startOffset, anchor.endOffset) !== expected) return null;
    const start = positionAt(current, anchor.startOffset);
    const end = positionAt(current, anchor.endOffset);
    // Read-only: returning this immutable pair neither creates an edit
    // session nor alters the model or its undo boundaries.
    return { sourceText: current, baseValue: expected,
      start: { line: start.lineNumber, column: start.column },
      end: { line: end.lineNumber, column: end.column } };
  };

  const flushPendingLiveEdits = (path: string) => {
    openingLivePaths.delete(path);
    for (const [sessionId, payload] of [...pendingLiveEdits]) {
      if (payload.path !== path) continue;
      pendingLiveEdits.delete(sessionId);
      if (!applyLoadedLiveEdit(payload)) {
        const message = uiText(
          "The source changed. Click the text again to edit it.",
          "ソースが更新されています。文字をもう一度クリックしてください。"
        );
        deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
      }
    }
    for (const [sessionId, pending] of [...pendingLiveAnchors]) {
      if (pending.payload.path !== path) continue;
      pendingLiveAnchors.delete(sessionId);
      pending.resolve(loadedLivePreviewSourceAnchor(pending.payload));
    }
  };

  const getLivePreviewSourceAnchor = (payload: LivePreviewAnchorPayload): Promise<LivePreviewSourceAnchor | null> => {
    if (!payload?.sessionId || !payload.path || typeof payload.sourceText !== "string" ||
        !payload.start || !payload.end) return Promise.resolve(null);
    if (runtime.monacoModels.has(payload.path)) {
      return Promise.resolve(loadedLivePreviewSourceAnchor(payload));
    }
    return new Promise((resolve) => {
      pendingLiveAnchors.get(payload.sessionId)?.resolve(null);
      pendingLiveAnchors.set(payload.sessionId, { payload, resolve });
      if (!openingLivePaths.has(payload.path)) {
        openingLivePaths.add(payload.path);
        const requested = requestOpenFileInBackground(payload.path, "primary");
        if (!requested) {
          openingLivePaths.delete(payload.path);
          window.setTimeout(() => flushPendingLiveEdits(payload.path), 0);
        }
      }
    });
  };

  const applyLivePreviewEdit = (payload: LivePreviewEditPayload) => {
    if (!payload?.sessionId || !payload.path || !payload.start || !payload.end) return false;
    if (applyLoadedLiveEdit(payload)) {
      pendingLiveEdits.delete(payload.sessionId);
      return true;
    }
    if (payload.cancel || runtime.monacoModels.has(payload.path)) {
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

  const handleOpenFileResultWithLiveEdit = (
    payload: Parameters<typeof handleOpenFileResult>[0]
  ) => {
    handleOpenFileResult(payload);
    if (payload.error) {
      openingLivePaths.delete(payload.path);
      for (const [sessionId, pending] of pendingLiveEdits) {
        if (pending.path === payload.path) pendingLiveEdits.delete(sessionId);
      }
      for (const [sessionId, pending] of pendingLiveAnchors) {
        if (pending.payload.path !== payload.path) continue;
        pendingLiveAnchors.delete(sessionId);
        pending.resolve(null);
      }
      return;
    }
    queueMicrotask(() => flushPendingLiveEdits(payload.path));
  };

  const clearLivePreviewEdits = () => {
    for (const session of liveEditSessions.values()) {
      runtime.monacoModels.get(session.path)?.model.pushStackElement?.();
    }
    liveEditSessions.clear();
    completedLiveEditSessions.clear();
    pendingLiveEdits.clear();
    for (const pending of pendingLiveAnchors.values()) pending.resolve(null);
    pendingLiveAnchors.clear();
    openingLivePaths.clear();
  };

  const pendingExternalChanges = new Map<string, object>();
  const handleExternalFileChange = (payload: { path: string; content: string | null; fileDeleted?: boolean }) => {
    const entry = runtime.monacoModels.get(payload.path);
    const groupKey = coreOps.findGroupKeyByPath(payload.path);
    if (!entry || !groupKey) return;
    const group = coreOps.getEditorGroup(groupKey);
    pendingExternalChanges.set(payload.path, payload);
    const apply = () => {
      if (pendingExternalChanges.get(payload.path) !== payload) return;
      if (runtime.monacoModels.get(payload.path) !== entry) {
        pendingExternalChanges.delete(payload.path);
        return;
      }
      if (group.isComposing) {
        window.setTimeout(apply, 100);
        return;
      }
      pendingExternalChanges.delete(payload.path);
      if (!payload.fileDeleted && payload.content === entry.savedContent) return;
      if (!payload.fileDeleted && runtime.fileOpsState.pendingSave?.path === payload.path &&
        runtime.fileOpsState.pendingSave.content === payload.content) return;
      applyFormattedContent(group, payload.path, payload.content ?? "", {
        updateSaved: true,
        showAiDiff: false,
        expectedContent: entry.savedContent,
        fileDeleted: payload.fileDeleted,
        externalChange: true,
      });
      deps.onLivePreviewSourceChanged?.();
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
      for (const file of files) {
        const entry = runtime.monacoModels.get(file.path);
        if (!entry) continue;
        if (entry.model.getValue() !== entry.savedContent) throw new Error("An editor changed during restoration. Its unsaved content has been retained.");
        const groups = Object.values(runtime.editorGroups);
        if (file.content === null) {
          for (const group of groups) if (group.openTabs.includes(file.path)) tabOps.closeTab(group, file.path);
          (entry.model as any).dispose?.();
          runtime.monacoModels.delete(file.path);
          runtime.dirtyFiles.delete(file.path);
          continue;
        }
        for (const group of groups) group.isApplyingFile = true;
        try {
          entry.model.setValue(file.content);
          entry.savedContent = file.content;
          bufferOps.updateDirtyState(file.path, file.content, file.content);
          for (const group of groups) if (group.currentFilePath === file.path) group.currentFileSavedContent = file.content;
        } finally { for (const group of groups) group.isApplyingFile = false; }
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
    getSaveStatus,
    requestOpenFile,
    jumpToFileLine: navigationOps.jumpToFileLine,
    jumpToLocation: navigationOps.jumpToLocation,
    applyFormattedContent,
    applyContentToOpenFile: navigationOps.applyContentToOpenFile,
    applyLivePreviewEdit,
    getLivePreviewSourceAnchor,
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
