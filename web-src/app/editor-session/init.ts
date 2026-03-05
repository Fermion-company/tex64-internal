import type { AppContext } from "../context.js";
import { createEditorSessionFileOps } from "../editor-session-file-ops.js";
import type { EditorSessionApi, EditorSessionDeps } from "./types.js";
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
    saveCurrentFile,
    saveDirtyFiles,
    scheduleAutoSave,
    handleOpenFileResult,
    handleSaveResult,
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
    saveCurrentFile,
    saveDirtyFiles,
    requestInitialOpen: initialOpenOps.requestInitialOpen,
    openPendingFileIfReady: initialOpenOps.openPendingFileIfReady,
    clearIssueHighlight: issueOps.clearIssueHighlight,
    syncIssueMarkers: issueOps.syncIssueMarkers,
    parseIssueDetail: issueOps.parseIssueDetail,
    focusIssue: issueFocusOps.focusIssue,
    handleOpenFileResult,
    handleSaveResult,
    handleRenameResult: workspaceOps.handleRenameResult,
    syncWorkspaceFiles: workspaceOps.syncWorkspaceFiles,
    getDirtyPaths: workspaceOps.getDirtyPaths,
    getStoredCursorPosition: cursorOps.getStoredCursorPosition,
    recordCursorPosition: cursorOps.recordCursorPosition,
  };
};

