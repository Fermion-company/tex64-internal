import type { createViewer } from "../viewer.js";
import type { SaveStatus } from "../save-status.js";
import type {
  FormatSettingsPayload,
  IndexEntry,
  IssueItem,
  IssuesStatus,
  SearchResult,
} from "../types.js";

export type EditorGroupKey = "primary" | "secondary";

export type EditorGroupState = {
  key: EditorGroupKey;
  root: HTMLElement | null;
  tabs: HTMLElement | null;
  tabsList: HTMLElement | null;
  editorHost: HTMLElement | null;
  viewer: ReturnType<typeof createViewer>;
  editor: unknown | null;
  openTabs: string[];
  automaticPreviewPath?: string;
  currentFilePath: string | null;
  currentFileSavedContent: string | null;
  isDirty: boolean;
  viewStates: Map<string, unknown>;
  isApplyingFile: boolean;
  isComposing: boolean;
  compositionText: string;
  composingFilePath: string | null;
  compositionBaseline?: { model: MonacoModel; text: string; dirty: boolean };
  pendingCompositionAction: (() => void) | null;
};

export type MonacoModelContentChange = { rangeOffset: number; rangeLength: number; text: string };
export type ActiveFileSnapshot = { path: string; content: string; isDirty: boolean; modelRevision?: string };

export type MonacoModel = {
  readonly id?: string;
  getVersionId?: () => number;
  getPositionAt?: (offset: number) => { lineNumber: number; column: number };
  getValue: (eol?: number, preserveBOM?: boolean) => string;
  getEOL?: () => string;
  setValue: (value: string) => void;
  onDidChangeContent?: (listener: (event: {
    changes: MonacoModelContentChange[];
    isFlush?: boolean;
  }) => void) => { dispose: () => void };
  onWillDispose?: (listener: () => void) => { dispose: () => void };
  getFullModelRange?: () => unknown;
  pushStackElement?: () => void;
  pushEditOperations?: (
    beforeCursorState: unknown[],
    edits: Array<{ range: unknown; text: string; forceMoveMarkers?: boolean }>,
    cursorStateComputer: () => unknown[] | null
  ) => unknown;
};
export type FormatTarget = {
  path: string;
  content: string;
  isCurrent: () => boolean;
  apply: (formatted: string) => Promise<boolean>;
};

export type MonacoModelEntry = { model: MonacoModel; savedContent: string; plainText?: boolean };

export type LivePreviewEditPayload = {
  sessionId: string;
  regionId?: string;
  kind: "text" | "math";
  path: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
  baseValue: string;
  value?: string;
  replacement: string;
  cancel?: boolean;
  finish?: boolean;
  sourceRev?: number;
  sourceText?: string;
};

export type LivePreviewAnchorPayload = Pick<LivePreviewEditPayload,
  "sessionId" | "path" | "start" | "end" | "baseValue"> & { sourceText: string; previousSessionId?: string };

export type LivePreviewSourceAnchor = {
  sourceText: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
  baseValue: string;
};

export type EditorSessionDeps = {
  isLivePaper: (pdfPath: string) => boolean;
  getWorkspaceRoot: () => string | null;
  getWorkspaceFiles: () => string[];
  getRootFilePath: () => string | null;
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  updateIssues: (count: number, summary: string, status: IssuesStatus, issues: IssueItem[]) => void;
  getRecentIssuesSnapshot?: () => {
    count: number;
    summary: string;
    status: IssuesStatus;
    issues: IssueItem[];
    updatedAt: number;
  } | null;
  setAutoDetectedUi: (enabled: boolean, lineNumber?: number) => void;
  setBlockPreviewActive: (active: boolean) => void;
  updateFallback: (message: string) => void;
  fileTree: {
    setSelection: (path: string, kind: "file" | "dir") => void;
    clearSelection: () => void;
    render: () => void;
    loadOpenState: () => void;
    setTreeFocus: (focus: boolean) => void;
    handleRenameResult: (payload: { oldPath: string; newPath: string; isDirectory: boolean }) => void;
  };
  outline: {
    render: () => void;
  };
  editorTabs: {
    render: (group: EditorGroupState) => void;
  };
  buildOps: {
    updateSynctexButtonState: () => void;
    handleSaveFormatError: (error?: string) => void;
  };
  settings: {
    buildFormatSettingsPayload: () => FormatSettingsPayload;
    updateEnvStatus: (command: string, available: boolean) => void;
  };
  search: {
    handleSearchUpdate: (payload: {
      query: string;
      results?: SearchResult[];
      message?: string;
      requestId?: number;
    }) => void;
    handleRenameResult?: (payload: {
      ok: boolean;
      from?: string;
      to?: string;
      fileCount?: number;
      appliedCount?: number;
      skippedCount?: number;
      error?: string;
      conversationId?: string;
    }) => void;
  };
  getMonacoApi: () => Record<string, unknown> | null;
  onLivePreviewSourceChanged?: () => void;
  // Collaboration: a shared text file is written by the session layer, not by
  // the renderer autosave; saving it means asking the session to flush.
  collab?: {
    isBound: (path: string | null | undefined) => boolean;
    flush: () => Promise<boolean>;
  };
};

export type EditorSessionApi = {
  // Collaboration save ACK: the buffer is saved iff it still matches `digest`.
  markSavedExternally: (path: string, digest: string) => boolean;
  getSavedContent: (path: string) => string | null;
  getEditorGroup: (key: EditorGroupKey) => EditorGroupState;
  getEditorGroups: () => EditorGroupState[];
  getActiveGroup: () => EditorGroupState;
  getActiveEditorGroupKey: () => EditorGroupKey;
  getActiveFilePath: () => string | null;
  getActiveFileSnapshot: () => ActiveFileSnapshot | null;
  getActiveSelectionSnapshot: () => {
    path: string;
    text: string;
    isDirty: boolean;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  } | null;
  getOpenFileSnapshots: (options?: {
    readModelText?: (model: MonacoModel) => string;
    maxFiles?: number;
    maxChars?: number;
    onlyDirty?: boolean;
    excludePath?: string | null;
  }) => {
    files: Array<{ path: string; isDirty: boolean; isActive: boolean }>;
    snapshots: Array<{
      path: string;
      content: string;
      isDirty: boolean;
      truncated: boolean;
      contentLength: number;
      modelRevision?: string;
    }>;
  };
  isActiveGroup: (group: EditorGroupState) => boolean;
  forEachEditorGroup: (handler: (group: EditorGroupState) => void) => void;
  setEditorGroupEmptyState: (group: EditorGroupState, isEmpty: boolean) => void;
  isAnyGroupComposing: () => boolean;
  updateBreadcrumbs: () => void;
  updateMiniOutline: () => void;
  setActiveGroup: (key: EditorGroupKey, options?: { focusEditor?: boolean }) => void;
  setSplitViewEnabled: (enabled: boolean) => void;
  getSplitViewEnabled: () => boolean;
  cacheCurrentBuffer: (group: EditorGroupState) => void;
  addOpenTab: (group: EditorGroupState, path: string) => void;
  getHistoryBuffers: () => Array<{ path: string; content: string; savedContent: string }>;
  applyHistoryFiles: (files: Array<{ path: string; content: string | null }>) => void;
  closeTab: (group: EditorGroupState, path: string) => void;
  cancelPendingFirstPreview: () => void;
  openFirstPreview: (path: string, saved: boolean) => void;
  scheduleAfterComposition: (group: EditorGroupState, action: () => void) => void;
  handleCompositionEnd: (group: EditorGroupState) => void;
  updateDirtyState: (path: string, content: string, savedContent?: string) => void;
  clearJumpHighlight: (group: EditorGroupState) => void;
  scheduleAutoSave: () => void;
  getSaveStatus: () => SaveStatus;
  loadWorkspaceTextModel: (path: string) => Promise<boolean>;
  requestOpenFile: (path: string, groupKey: EditorGroupKey, force?: boolean) => boolean;
  jumpToFileLine: (
    path: string,
    line: number,
    groupKey: EditorGroupKey,
    options?: { force?: boolean; focus?: boolean; className?: string; column?: number }
  ) => void;
  jumpToLocation: (entry: IndexEntry) => void;
  applyFormattedContent: (
    group: EditorGroupState,
    path: string,
    content: string,
    options?: {
      updateSaved?: boolean;
      showAiDiff?: boolean;
      expectedContent?: string;
      expectedFileMissing?: boolean;
      fileDeleted?: boolean;
      conversationId?: string;
    }
  ) => boolean;
  applyContentToOpenFile: (
    path: string,
    content: string,
    options?: {
      updateSaved?: boolean;
      showAiDiff?: boolean;
      expectedContent?: string;
      expectedFileMissing?: boolean;
      fileDeleted?: boolean;
      conversationId?: string;
    }
  ) => { handled: boolean; conflict: boolean };
  applyLivePreviewEdit: (payload: LivePreviewEditPayload) => boolean;
  getLivePreviewSourceAnchor: (payload: LivePreviewAnchorPayload) => Promise<LivePreviewSourceAnchor | null>;
  handleExternalFileChange: (payload: { path: string; content: string | null; fileDeleted?: boolean }) => void;
  captureFormatTarget: () => FormatTarget | null;
  saveCurrentFile: () => Promise<boolean>;
  saveDirtyFiles: () => Promise<boolean>;
  requestInitialOpen: () => void;
  openPendingFileIfReady: () => void;
  clearIssueHighlight: () => void;
  syncIssueMarkers: (issues: IssueItem[]) => void;
  parseIssueDetail: (issue: IssueItem) => {
    path: string | null;
    line: number | null;
    column: number | null;
    message: string;
  };
  focusIssue: (issue: IssueItem, options?: { groupKey?: "primary" | "secondary" }) => void;
  handleOpenFileResult: (payload: {
    path: string;
    content?: string;
    error?: string;
    kind?: "text" | "image" | "pdf" | "unsupported";
    languageId?: "plaintext";
    data?: string;
    mimeType?: string;
    livePreview?: { generation: number; documentEpoch: number };
  }) => void;
  handleSaveResult: (payload: {
    path: string;
    ok: boolean;
    error?: string;
    content?: string;
    formatError?: string;
  }) => void;
  handleRenameResult: (payload: { oldPath: string; newPath: string; isDirectory: boolean }) => void;
  syncWorkspaceFiles: (payload: { workspaceFiles: string[]; rootChanged: boolean }) => void;
  getDirtyPaths: () => Set<string>;
  getStoredCursorPosition: (path: string) => { line: number; column: number } | null;
  recordCursorPosition: (path: string, position: { lineNumber: number; column: number }) => void;
};
