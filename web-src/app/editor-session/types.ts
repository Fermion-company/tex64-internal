import type { createViewer } from "../viewer.js";
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
  currentFilePath: string | null;
  currentFileSavedContent: string | null;
  isDirty: boolean;
  viewStates: Map<string, unknown>;
  isApplyingFile: boolean;
  isComposing: boolean;
  compositionText: string;
  composingFilePath: string | null;
  pendingCompositionAction: (() => void) | null;
};

export type MonacoModel = { getValue: () => string; setValue: (value: string) => void };
export type MonacoModelEntry = { model: MonacoModel; savedContent: string };

export type EditorSessionDeps = {
  getWorkspaceFiles: () => string[];
  getRootFilePath: () => string | null;
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  updateIssues: (count: number, summary: string, status: IssuesStatus, issues: IssueItem[]) => void;
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
};

export type EditorSessionApi = {
  getEditorGroup: (key: EditorGroupKey) => EditorGroupState;
  getEditorGroups: () => EditorGroupState[];
  getActiveGroup: () => EditorGroupState;
  getActiveEditorGroupKey: () => EditorGroupKey;
  getActiveFilePath: () => string | null;
  getActiveFileSnapshot: () => { path: string; content: string; isDirty: boolean } | null;
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
    maxFiles?: number;
    maxChars?: number;
  }) => {
    files: Array<{ path: string; isDirty: boolean; isActive: boolean }>;
    snapshots: Array<{
      path: string;
      content: string;
      isDirty: boolean;
      truncated: boolean;
      contentLength: number;
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
  closeTab: (group: EditorGroupState, path: string) => void;
  scheduleAfterComposition: (group: EditorGroupState, action: () => void) => void;
  handleCompositionEnd: (group: EditorGroupState) => void;
  updateDirtyState: (path: string, content: string, savedContent?: string) => void;
  clearJumpHighlight: (group: EditorGroupState) => void;
  scheduleAutoSave: () => void;
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
    options?: { updateSaved?: boolean }
  ) => void;
  applyContentToOpenFile: (path: string, content: string, options?: { updateSaved?: boolean }) => boolean;
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
  focusIssue: (issue: IssueItem) => void;
  handleOpenFileResult: (payload: {
    path: string;
    content?: string;
    error?: string;
    kind?: "text" | "image" | "pdf" | "unsupported";
    data?: string;
    mimeType?: string;
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
