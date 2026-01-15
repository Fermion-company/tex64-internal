import type { AppContext } from "./context.js";
import type { createViewer } from "./viewer.js";
import {
  LATEX_FILE_EXTENSIONS,
  PINNED_TAB_EXTENSIONS,
  getFileExtension,
  isTextFilePath,
} from "./files.js";
import type {
  FormatSettingsPayload,
  IndexEntry,
  IssueItem,
  IssuesStatus,
  SearchResult,
} from "./types.js";
import {
  createEditorSessionFileOps,
  type FileOpsState,
} from "./editor-session-file-ops.js";

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
  postToNative: (
    payload: { type: string; [key: string]: unknown },
    silent?: boolean
  ) => boolean;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
  setAutoDetectedUi: (enabled: boolean, lineNumber?: number) => void;
  setBlockPreviewActive: (active: boolean) => void;
  updateFallback: (message: string) => void;
  fileTree: {
    setSelection: (path: string, kind: "file" | "dir") => void;
    clearSelection: () => void;
    render: () => void;
    loadOpenState: () => void;
    setTreeFocus: (focus: boolean) => void;
    handleRenameResult: (payload: {
      oldPath: string;
      newPath: string;
      isDirectory: boolean;
    }) => void;
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
    options?: { force?: boolean; focus?: boolean }
  ) => void;
  jumpToLocation: (entry: IndexEntry) => void;
  applyFormattedContent: (
    group: EditorGroupState,
    path: string,
    content: string,
    options?: { updateSaved?: boolean }
  ) => void;
  applyContentToOpenFile: (
    path: string,
    content: string,
    options?: { updateSaved?: boolean }
  ) => boolean;
  saveCurrentFile: () => Promise<boolean>;
  requestInitialOpen: () => void;
  openPendingFileIfReady: () => void;
  clearIssueHighlight: () => void;
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
  handleRenameResult: (payload: {
    oldPath: string;
    newPath: string;
    isDirectory: boolean;
  }) => void;
  syncWorkspaceFiles: (payload: { workspaceFiles: string[]; rootChanged: boolean }) => void;
  getDirtyPaths: () => Set<string>;
  getStoredCursorPosition: (path: string) => { line: number; column: number } | null;
  recordCursorPosition: (path: string, position: { lineNumber: number; column: number }) => void;
};

export const initEditorSession = (
  context: AppContext,
  deps: EditorSessionDeps
): EditorSessionApi => {
  const {
    editorGroups: editorGroupsRoot,
    editorTabs,
    editorTabsList,
    editorTabsSecondary,
    editorTabsListSecondary,
    editorHost,
    editorHostSecondary,
    editorSplitButton,
  } = context.dom;

  const editorGroupsRootEl =
    editorGroupsRoot instanceof HTMLElement ? editorGroupsRoot : null;
  const editorGroupPrimary =
    editorGroupsRootEl?.querySelector<HTMLElement>('[data-editor-group="primary"]') ?? null;
  const editorGroupSecondary =
    editorGroupsRootEl?.querySelector<HTMLElement>('[data-editor-group="secondary"]') ?? null;

  const editorGroups: Record<EditorGroupKey, EditorGroupState> = {
    primary: {
      key: "primary",
      root: editorGroupPrimary,
      tabs: editorTabs,
      tabsList: editorTabsList,
      editorHost,
      viewer: context.viewers.primary,
      editor: null,
      openTabs: [],
      currentFilePath: null,
      currentFileSavedContent: null,
      isDirty: false,
      viewStates: new Map(),
      isApplyingFile: false,
      isComposing: false,
      compositionText: "",
      composingFilePath: null,
      pendingCompositionAction: null,
    },
    secondary: {
      key: "secondary",
      root: editorGroupSecondary,
      tabs: editorTabsSecondary,
      tabsList: editorTabsListSecondary,
      editorHost: editorHostSecondary,
      viewer: context.viewers.secondary,
      editor: null,
      openTabs: [],
      currentFilePath: null,
      currentFileSavedContent: null,
      isDirty: false,
      viewStates: new Map(),
      isApplyingFile: false,
      isComposing: false,
      compositionText: "",
      composingFilePath: null,
      pendingCompositionAction: null,
    },
  };

  let activeEditorGroup: EditorGroupKey = "primary";
  let splitViewEnabled = false;
  const fileOpsState: FileOpsState = {
    pendingOpenRequests: [],
    pendingReveal: null,
    pendingSave: null,
    autoSaveTimer: null,
    autoSavePending: false,
  };
  let issueDecorations: string[] = [];
  const jumpDecorations: Record<EditorGroupKey, string[]> = {
    primary: [],
    secondary: [],
  };
  let pendingAutoOpenPath: string | null = null;
  const lastCursorPositions = new Map<string, { line: number; column: number }>();
  const monacoModels = new Map<string, MonacoModelEntry>();
  const dirtyFiles = new Set<string>();
  let emptyEditorModel: MonacoModel | null = null;

  const getEditorGroup = (key: EditorGroupKey) => editorGroups[key];
  const getActiveGroup = () => editorGroups[activeEditorGroup];
  const getActiveEditorGroupKey = () => activeEditorGroup;
  const getActiveFilePath = () => getActiveGroup().currentFilePath;
  const getActiveEditor = () => getActiveGroup().editor;
  const getActiveFileSnapshot = () => {
    const group = getActiveGroup();
    if (!group.currentFilePath || !isTextFilePath(group.currentFilePath)) {
      return null;
    }
    const entry = monacoModels.get(group.currentFilePath);
    const editor = group.editor as { getValue?: () => string } | null;
    const content = entry?.model?.getValue?.() ?? editor?.getValue?.() ?? null;
    if (content === null) {
      return null;
    }
    return { path: group.currentFilePath, content, isDirty: group.isDirty };
  };
  const getOpenFileSnapshots = (options?: { maxFiles?: number; maxChars?: number }) => {
    const rawMaxFiles = options?.maxFiles ?? 8;
    const maxFiles = rawMaxFiles > 0 ? rawMaxFiles : Number.POSITIVE_INFINITY;
    const rawMaxChars = options?.maxChars ?? 20000;
    const maxChars = rawMaxChars > 0 ? rawMaxChars : Number.POSITIVE_INFINITY;
    const files = new Map();
    const snapshots = [];
    const pushSnapshot = (path: string, isDirty: boolean) => {
      if (snapshots.length >= maxFiles || !isTextFilePath(path)) {
        return;
      }
      const entry = monacoModels.get(path);
      const editorGroupKey = findGroupKeyByPath(path);
      const group = editorGroupKey ? getEditorGroup(editorGroupKey) : null;
      const editor = group?.editor as { getValue?: () => string } | null;
      const rawContent = entry?.model?.getValue?.() ?? editor?.getValue?.() ?? null;
      if (rawContent === null) {
        return;
      }
      const truncated = Number.isFinite(maxChars) && rawContent.length > maxChars;
      const content = truncated ? rawContent.slice(0, maxChars) : rawContent;
      snapshots.push({
        path,
        content,
        isDirty,
        truncated,
        contentLength: rawContent.length,
      });
    };
    forEachEditorGroup((group) => {
      group.openTabs.forEach((path) => {
        if (!path) {
          return;
        }
        if (!files.has(path)) {
          files.set(path, {
            path,
            isDirty: dirtyFiles.has(path),
            isActive: group.currentFilePath === path,
          });
        } else {
          const entry = files.get(path);
          entry.isDirty = entry.isDirty || dirtyFiles.has(path);
          entry.isActive = entry.isActive || group.currentFilePath === path;
        }
      });
    });
    const entries = Array.from(files.values());
    entries.forEach((entry) => {
      if (entry.isDirty && !entry.isActive) {
        pushSnapshot(entry.path, entry.isDirty);
      }
    });
    entries.forEach((entry) => {
      if (!entry.isDirty && !entry.isActive) {
        pushSnapshot(entry.path, entry.isDirty);
      }
    });
    return { files: Array.from(files.values()), snapshots };
  };
  const isActiveGroup = (group: EditorGroupState) => group.key === activeEditorGroup;
  const getOtherGroupKey = (key: EditorGroupKey): EditorGroupKey =>
    key === "primary" ? "secondary" : "primary";
  const resolveAutoOpenGroupKey = (preferredKey: EditorGroupKey): EditorGroupKey => {
    if (!splitViewEnabled) {
      return preferredKey;
    }
    const preferred = getEditorGroup(preferredKey);
    if (preferred.openTabs.length === 0) {
      return preferredKey;
    }
    const otherKey = getOtherGroupKey(preferredKey);
    const other = getEditorGroup(otherKey);
    if (other.openTabs.length === 0) {
      return otherKey;
    }
    return preferredKey;
  };
  const findGroupKeyByPath = (path: string): EditorGroupKey | null => {
    const groups = Object.keys(editorGroups) as EditorGroupKey[];
    for (const key of groups) {
      if (editorGroups[key].openTabs.includes(path)) {
        return key;
      }
    }
    return null;
  };
  const findGroupKeyByCurrentPath = (path: string): EditorGroupKey | null => {
    const groups = Object.keys(editorGroups) as EditorGroupKey[];
    for (const key of groups) {
      if (editorGroups[key].currentFilePath === path) {
        return key;
      }
    }
    return null;
  };
  const resolveOpenTargetGroupKey = (
    path: string,
    preferredKey: EditorGroupKey
  ): EditorGroupKey => {
    if (getEditorGroup(preferredKey).currentFilePath === path) {
      return preferredKey;
    }
    const currentGroupKey = findGroupKeyByCurrentPath(path);
    if (currentGroupKey) {
      return currentGroupKey;
    }
    const existingGroupKey = findGroupKeyByPath(path);
    if (existingGroupKey) {
      return existingGroupKey;
    }
    return resolveAutoOpenGroupKey(preferredKey);
  };
  const forEachEditorGroup = (handler: (group: EditorGroupState) => void) => {
    (Object.keys(editorGroups) as EditorGroupKey[]).forEach((key) => {
      handler(editorGroups[key]);
    });
  };

  const setEditorGroupEmptyState = (group: EditorGroupState, isEmpty: boolean) => {
    if (group.root instanceof HTMLElement) {
      group.root.classList.toggle("is-empty", isEmpty);
    }
    if (!isEmpty && group.editor) {
      const editor = group.editor as { layout?: () => void };
      editor.layout?.();
    }
  };

  const isAnyGroupComposing = () =>
    Object.values(editorGroups).some((group) => group.isComposing);

  const clearIssueHighlight = () => {
    const activeGroup = getActiveGroup();
    const monacoApi = deps.getMonacoApi();
    if (!activeGroup.editor || !monacoApi || issueDecorations.length === 0) {
      return;
    }
    const editor = activeGroup.editor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    issueDecorations = editor.deltaDecorations(issueDecorations, []);
  };

  const parseIssueDetail = (issue: IssueItem) => {
    const trimmed = issue.message.trim();
    const filePattern = String.raw`((?:[A-Za-z]:)?[^:\s]+?\.[A-Za-z0-9]+)`;
    const match =
      trimmed.match(new RegExp(`^${filePattern}:(\\d+):(\\d+):\\s*(.+)$`)) ??
      trimmed.match(new RegExp(`^${filePattern}:(\\d+):\\s*(.+)$`));
    if (match) {
      const path = issue.path ?? match[1];
      const line = issue.line ?? Number.parseInt(match[2], 10);
      const column =
        issue.column ??
        (match.length > 4 && match[3] && /^\d+$/.test(match[3])
          ? Number.parseInt(match[3], 10)
          : null);
      let message = match.length > 4 ? match[4].trim() : match[3].trim();
      if (issue.path && issue.line) {
        const prefix = `${issue.path}:${issue.line}`;
        if (message.startsWith(prefix)) {
          message = message.slice(prefix.length).replace(/^:\s*/, "");
        }
      }
      return { path, line: Number.isFinite(line) ? line : null, column, message };
    }
    return {
      path: issue.path ?? null,
      line: issue.line ?? null,
      column: issue.column ?? null,
      message: trimmed,
    };
  };

  const focusIssue = (issue: IssueItem) => {
    const activeGroup = getActiveGroup();
    const monacoApi = deps.getMonacoApi();
    if (!activeGroup.editor || !monacoApi) {
      return;
    }
    const detail = parseIssueDetail(issue);
    if (detail.path && detail.line) {
      jumpToFileLine(detail.path, detail.line, activeEditorGroup);
      return;
    }
    if (detail.path && !detail.line) {
      requestOpenFile(detail.path, activeEditorGroup, true);
      return;
    }
    if (!detail.line) {
      return;
    }
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = activeGroup.editor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
      revealLineInCenter: (lineNumber: number) => void;
      setPosition: (position: { lineNumber: number; column: number }) => void;
      focus: () => void;
    };
    const className =
      issue.severity === "warning" ? "issue-line-warning" : "issue-line-highlight";
    issueDecorations = editor.deltaDecorations(issueDecorations, [
      {
        range: new monacoApiAny.Range(detail.line, 1, detail.line, 1),
        options: {
          isWholeLine: true,
          className,
        },
      },
    ]);
    editor.revealLineInCenter(detail.line);
    editor.setPosition({ lineNumber: detail.line, column: 1 });
    editor.focus();
  };

  const clearJumpHighlight = (group: EditorGroupState) => {
    const decorations = jumpDecorations[group.key];
    if (!group.editor || decorations.length === 0) {
      return;
    }
    const editor = group.editor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    jumpDecorations[group.key] = editor.deltaDecorations(decorations, []);
  };

  const revealLine = (
    group: EditorGroupState,
    line: number,
    options: { focus?: boolean } = {}
  ) => {
    const monacoApi = deps.getMonacoApi();
    if (!group.editor || !monacoApi) {
      return;
    }
    clearJumpHighlight(group);
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = group.editor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
      revealLineInCenter: (lineNumber: number) => void;
      setPosition: (position: { lineNumber: number; column: number }) => void;
      focus: () => void;
    };
    jumpDecorations[group.key] = editor.deltaDecorations(jumpDecorations[group.key], [
      {
        range: new monacoApiAny.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: "jump-line-highlight",
        },
      },
    ]);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    if (options.focus !== false) {
      editor.focus();
    }
  };

  const pickInitialFilePath = () => {
    const rootFilePath = deps.getRootFilePath();
    const workspaceFiles = deps.getWorkspaceFiles();
    if (rootFilePath && workspaceFiles.includes(rootFilePath)) {
      return rootFilePath;
    }
    const texFiles = workspaceFiles
      .filter((path) => path.toLowerCase().endsWith(".tex"))
      .sort((a, b) => a.localeCompare(b, "ja"));
    if (texFiles.length > 0) {
      return texFiles[0];
    }
    if (workspaceFiles.length > 0) {
      return workspaceFiles[0];
    }
    return null;
  };

  const requestInitialOpen = () => {
    const activeGroup = getActiveGroup();
    const workspaceFiles = deps.getWorkspaceFiles();
    const hasValidCurrent =
      activeGroup.currentFilePath !== null &&
      workspaceFiles.includes(activeGroup.currentFilePath);
    if (hasValidCurrent) {
      return;
    }
    const path = pickInitialFilePath();
    if (!path) {
      return;
    }
    if (!activeGroup.editor) {
      pendingAutoOpenPath = path;
      return;
    }
    pendingAutoOpenPath = null;
    requestOpenFile(path, activeEditorGroup);
  };

  const openPendingFileIfReady = () => {
    const activeGroup = getActiveGroup();
    if (!pendingAutoOpenPath || !activeGroup.editor) {
      return;
    }
    if (activeGroup.currentFilePath) {
      pendingAutoOpenPath = null;
      return;
    }
    const path = pendingAutoOpenPath;
    pendingAutoOpenPath = null;
    requestOpenFile(path, activeEditorGroup);
  };

  const updateBreadcrumbs = () => {
    deps.editorTabs.render(getActiveGroup());
  };

  const updateMiniOutline = () => {};

  const setActiveGroup = (
    nextKey: EditorGroupKey,
    options: { focusEditor?: boolean } = {}
  ) => {
    if (activeEditorGroup === nextKey) {
      return;
    }
    activeEditorGroup = nextKey;
    forEachEditorGroup((group) => {
      if (group.root instanceof HTMLElement) {
        group.root.classList.toggle("is-active", group.key === nextKey);
      }
    });
    updateBreadcrumbs();
    updateMiniOutline();
    deps.outline.render();
    deps.fileTree.render();
    deps.buildOps.updateSynctexButtonState();
    if (options.focusEditor) {
      const editor = getActiveEditor() as { focus?: () => void };
      editor?.focus?.();
    }
  };

  const setSplitViewEnabled = (enabled: boolean) => {
    splitViewEnabled = enabled;
    if (editorGroupsRootEl) {
      editorGroupsRootEl.dataset.split = enabled ? "true" : "false";
    }
    if (editorSplitButton instanceof HTMLElement) {
      editorSplitButton.classList.toggle("is-active", enabled);
      editorSplitButton.setAttribute("aria-pressed", enabled ? "true" : "false");
    }
    if (editorGroupSecondary instanceof HTMLElement) {
      editorGroupSecondary.setAttribute("aria-hidden", enabled ? "false" : "true");
    }
    if (!enabled && activeEditorGroup === "secondary") {
      setActiveGroup("primary", { focusEditor: false });
    }
    requestAnimationFrame(() => {
      forEachEditorGroup((group) => {
        const editor = group.editor as { layout?: () => void };
        editor?.layout?.();
      });
    });
  };

  const getSplitViewEnabled = () => splitViewEnabled;

  const getLanguageIdForPath = (path: string) => {
    const ext = getFileExtension(path);
    if (ext === "bib") {
      return "bibtex";
    }
    if (LATEX_FILE_EXTENSIONS.has(ext)) {
      return "latex";
    }
    return "plaintext";
  };

  const setEditorLanguage = (group: EditorGroupState, path: string) => {
    const monacoApi = deps.getMonacoApi();
    if (!monacoApi || !group.editor) {
      return;
    }
    if (!isTextFilePath(path)) {
      return;
    }
    const editor = group.editor as { getModel?: () => unknown };
    if (!editor.getModel) {
      return;
    }
    const model = editor.getModel();
    const monacoApiAny = monacoApi as {
      editor?: { setModelLanguage?: (model: unknown, languageId: string) => void };
    };
    const languageId = getLanguageIdForPath(path);
    if (model && monacoApiAny.editor?.setModelLanguage) {
      monacoApiAny.editor.setModelLanguage(model, languageId);
    }
  };

  const getEmptyEditorModel = () => {
    const monacoApi = deps.getMonacoApi();
    if (!monacoApi) {
      return null;
    }
    if (emptyEditorModel) {
      return emptyEditorModel;
    }
    const monacoApiAny = monacoApi as {
      editor?: { createModel?: (value: string, languageId: string) => unknown };
    };
    if (!monacoApiAny.editor?.createModel) {
      return null;
    }
    emptyEditorModel = monacoApiAny.editor.createModel("", "plaintext") as MonacoModel;
    return emptyEditorModel;
  };

  const clearEditorView = (group: EditorGroupState) => {
    if (!group.editor) {
      return;
    }
    const editor = group.editor as { setModel?: (model: unknown) => void };
    const emptyModel = getEmptyEditorModel();
    if (emptyModel && editor.setModel) {
      editor.setModel(emptyModel as unknown);
    }
  };

  const scheduleAfterComposition = (group: EditorGroupState, action: () => void) => {
    if (!group.isComposing) {
      action();
      return;
    }
    // Blur will trigger compositionend which handles recovery
    group.pendingCompositionAction = action;
    const input = group.editorHost?.querySelector<HTMLTextAreaElement>("textarea.inputarea");
    input?.blur();
  };

  const handleCompositionEnd = (group: EditorGroupState) => {
    if (!group.pendingCompositionAction) {
      return;
    }
    const action = group.pendingCompositionAction;
    group.pendingCompositionAction = null;
    requestAnimationFrame(() => {
      action();
    });
  };

  const updateDirtyState = (path: string, content: string, savedContent?: string) => {
    const entry = monacoModels.get(path);
    const groupSavedContent = Array.from(Object.values(editorGroups)).find(
      (group) => group.currentFilePath === path && group.currentFileSavedContent
    )?.currentFileSavedContent;
    const baseSaved = savedContent ?? entry?.savedContent ?? groupSavedContent ?? content;
    if (entry) {
      entry.savedContent = baseSaved;
    }
    if (content !== baseSaved) {
      dirtyFiles.add(path);
    } else {
      dirtyFiles.delete(path);
    }
    forEachEditorGroup((group) => {
      if (group.currentFilePath === path) {
        group.isDirty = dirtyFiles.has(path);
      }
    });
  };

  const storeViewState = (group: EditorGroupState, path: string) => {
    if (!group.editor) {
      return;
    }
    const editor = group.editor as { saveViewState?: () => unknown };
    if (!editor.saveViewState) {
      return;
    }
    const viewState = editor.saveViewState();
    if (viewState) {
      group.viewStates.set(path, viewState);
    }
  };

  const restoreViewState = (group: EditorGroupState, path: string) => {
    if (!group.editor) {
      return;
    }
    const viewState = group.viewStates.get(path);
    if (!viewState) {
      return;
    }
    const editor = group.editor as { restoreViewState?: (state: unknown) => void };
    editor.restoreViewState?.(viewState);
  };

  const cacheCurrentBuffer = (group: EditorGroupState) => {
    if (!group.currentFilePath || !group.editor || !isTextFilePath(group.currentFilePath)) {
      return;
    }
    const editor = group.editor as { getValue: () => string };
    const content = editor.getValue();
    updateDirtyState(group.currentFilePath, content);
    storeViewState(group, group.currentFilePath);
  };

  const addOpenTab = (group: EditorGroupState, path: string) => {
    if (!group.openTabs.includes(path)) {
      group.openTabs = [...group.openTabs, path];
    }
  };

  const closeTab = (group: EditorGroupState, path: string) => {
    const index = group.openTabs.indexOf(path);
    if (index === -1) {
      return;
    }
    if (path === group.currentFilePath && group.isComposing) {
      scheduleAfterComposition(group, () => {
        closeTab(group, path);
      });
      return;
    }
    if (path === group.currentFilePath) {
      cacheCurrentBuffer(group);
    }
    group.openTabs = group.openTabs.filter((entry) => entry !== path);
    if (path === group.currentFilePath) {
      if (group.openTabs.length > 0) {
        const nextIndex = Math.min(index, group.openTabs.length - 1);
        const nextPath = group.openTabs[nextIndex];
        requestOpenFile(nextPath, group.key, true);
      } else {
        group.currentFilePath = null;
        group.currentFileSavedContent = null;
        group.isDirty = false;
        group.viewer.hideViewer();
        clearEditorView(group);
        if (isActiveGroup(group)) {
          updateBreadcrumbs();
          updateMiniOutline();
          deps.outline.render();
          deps.fileTree.render();
        }
      }
    }
    deps.editorTabs.render(group);
  };

  const isPersistentTabPath = (path: string) => {
    const ext = getFileExtension(path);
    return PINNED_TAB_EXTENSIONS.has(ext);
  };

  const clearTemporaryTabs = (group: EditorGroupState, keepPath?: string) => {
    const nextTabs = group.openTabs.filter((entry) => {
      if (entry === keepPath) {
        return true;
      }
      if (!isPersistentTabPath(entry)) {
        return false;
      }
      if (dirtyFiles.has(entry)) {
        return false;
      }
      return true;
    });
    if (nextTabs.length === group.openTabs.length) {
      return;
    }
    group.openTabs = nextTabs;
    deps.editorTabs.render(group);
  };

  const {
    applyFormattedContent,
    requestOpenFile,
    saveCurrentFile,
    scheduleAutoSave,
    handleOpenFileResult,
    handleSaveResult,
  } = createEditorSessionFileOps({
    deps,
    editorGroups,
    monacoModels,
    dirtyFiles,
    state: fileOpsState,
    getActiveEditorGroupKey,
    getActiveGroup,
    getEditorGroup,
    isActiveGroup,
    resolveAutoOpenGroupKey,
    findGroupKeyByPath,
    setSplitViewEnabled,
    cacheCurrentBuffer,
    clearJumpHighlight,
    clearTemporaryTabs,
    addOpenTab,
    updateDirtyState,
    restoreViewState,
    setEditorLanguage,
    updateBreadcrumbs,
    updateMiniOutline,
    revealLine,
    forEachEditorGroup,
    scheduleAfterComposition,
    getLanguageIdForPath,
  });

  const applyContentToOpenFile = (
    path: string,
    content: string,
    options?: { updateSaved?: boolean }
  ) => {
    const targetGroupKey = findGroupKeyByPath(path);
    if (!targetGroupKey) {
      return false;
    }
    const targetGroup = getEditorGroup(targetGroupKey);
    applyFormattedContent(targetGroup, path, content, options);
    return true;
  };

  const jumpToFileLine = (
    path: string,
    line: number,
    groupKey: EditorGroupKey,
    options: { force?: boolean; focus?: boolean } = {}
  ) => {
    const forceOpen = options.force === true;
    const focus = options.focus;
    const targetGroupKey = forceOpen
      ? groupKey
      : resolveOpenTargetGroupKey(path, groupKey);
    const targetGroup = getEditorGroup(targetGroupKey);
    if (targetGroup.currentFilePath === path) {
      revealLine(targetGroup, line, { focus });
      return;
    }
    const requested = requestOpenFile(path, targetGroupKey, forceOpen);
    if (requested) {
      fileOpsState.pendingReveal = { path, line, group: targetGroupKey, focus };
    }
  };

  const jumpToLocation = (entry: IndexEntry) => {
    if (!entry.path || !entry.line) {
      return;
    }
    jumpToFileLine(entry.path, entry.line, activeEditorGroup);
  };

  const jumpToSearchResult = (result: SearchResult) => {
    jumpToFileLine(result.path, result.line, activeEditorGroup);
  };

  const handleRenameResult = (payload: {
    oldPath: string;
    newPath: string;
    isDirectory: boolean;
  }) => {
    const { oldPath, newPath } = payload;
    const remapPath = (path: string) => {
      if (payload.isDirectory) {
        if (path === oldPath || path.startsWith(`${oldPath}/`)) {
          return newPath + path.slice(oldPath.length);
        }
        return path;
      }
      return path === oldPath ? newPath : path;
    };
    deps.fileTree.handleRenameResult(payload);
    forEachEditorGroup((group) => {
      group.openTabs = group.openTabs.map((entry) => remapPath(entry));
      if (group.currentFilePath) {
        const nextPath = remapPath(group.currentFilePath);
        group.currentFilePath = nextPath;
      }
    });
    if (monacoModels.size > 0) {
      const updatedModels = new Map<string, MonacoModelEntry>();
      monacoModels.forEach((entry, path) => {
        updatedModels.set(remapPath(path), entry);
      });
      monacoModels.clear();
      updatedModels.forEach((entry, path) => monacoModels.set(path, entry));
    }
    forEachEditorGroup((group) => {
      if (group.viewStates.size > 0) {
        const updatedViewStates = new Map<string, unknown>();
        group.viewStates.forEach((state, path) => {
          updatedViewStates.set(remapPath(path), state);
        });
        group.viewStates.clear();
        updatedViewStates.forEach((state, path) => group.viewStates.set(path, state));
      }
    });
    if (dirtyFiles.size > 0) {
      const updatedDirty = new Set<string>();
      dirtyFiles.forEach((path) => {
        updatedDirty.add(remapPath(path));
      });
      dirtyFiles.clear();
      updatedDirty.forEach((path) => dirtyFiles.add(path));
    }
    forEachEditorGroup((group) => {
      if (group.currentFilePath) {
        group.isDirty = dirtyFiles.has(group.currentFilePath);
        setEditorLanguage(group, group.currentFilePath);
      }
      if (group.currentFilePath && !group.isDirty) {
        const entry = monacoModels.get(group.currentFilePath);
        if (entry) {
          group.currentFileSavedContent = entry.savedContent;
        } else if (group.editor) {
          const editor = group.editor as { getValue: () => string };
          group.currentFileSavedContent = editor.getValue();
        }
      }
    });
    updateBreadcrumbs();
    updateMiniOutline();
    deps.fileTree.render();
    forEachEditorGroup((group) => deps.editorTabs.render(group));
  };

  const syncWorkspaceFiles = (payload: { workspaceFiles: string[]; rootChanged: boolean }) => {
    const { workspaceFiles, rootChanged } = payload;
    if (rootChanged) {
      fileOpsState.pendingReveal = null;
      lastCursorPositions.clear();
      deps.fileTree.clearSelection();
      forEachEditorGroup((group) => {
        group.currentFilePath = null;
        group.currentFileSavedContent = null;
        group.isDirty = false;
        group.openTabs = [];
        group.viewStates.clear();
        group.viewer.hideViewer();
        clearEditorView(group);
      });
      monacoModels.clear();
      dirtyFiles.clear();
    }
    if (monacoModels.size > 0) {
      Array.from(monacoModels.keys()).forEach((path) => {
        if (!workspaceFiles.includes(path)) {
          monacoModels.delete(path);
          dirtyFiles.delete(path);
        }
      });
    }
    forEachEditorGroup((group) => {
      if (group.viewStates.size > 0) {
        Array.from(group.viewStates.keys()).forEach((path) => {
          if (!workspaceFiles.includes(path)) {
            group.viewStates.delete(path);
          }
        });
      }
      if (group.currentFilePath && !workspaceFiles.includes(group.currentFilePath)) {
        group.currentFilePath = null;
        group.currentFileSavedContent = null;
        group.isDirty = false;
        if (isActiveGroup(group)) {
          deps.fileTree.clearSelection();
        }
      }
      if (group.openTabs.length > 0) {
        group.openTabs = group.openTabs.filter((path) => workspaceFiles.includes(path));
        if (group.currentFilePath && !group.openTabs.includes(group.currentFilePath)) {
          group.currentFilePath = null;
          group.currentFileSavedContent = null;
          group.isDirty = false;
        }
      }
      if (group.currentFilePath) {
        group.isDirty = dirtyFiles.has(group.currentFilePath);
      } else {
        group.viewer.hideViewer();
        clearEditorView(group);
      }
    });
    deps.fileTree.loadOpenState();
    deps.fileTree.render();
    updateBreadcrumbs();
    forEachEditorGroup((group) => deps.editorTabs.render(group));
    deps.outline.render();
  };

  const getDirtyPaths = () => dirtyFiles;

  const getStoredCursorPosition = (path: string) => lastCursorPositions.get(path) ?? null;

  const recordCursorPosition = (
    path: string,
    position: { lineNumber: number; column: number }
  ) => {
    lastCursorPositions.set(path, {
      line: position.lineNumber,
      column: position.column,
    });
  };

  return {
    getEditorGroup,
    getEditorGroups: () => Object.values(editorGroups),
    getActiveGroup,
    getActiveEditorGroupKey,
    getActiveFilePath,
    getActiveFileSnapshot,
    getOpenFileSnapshots,
    isActiveGroup,
    forEachEditorGroup,
    setEditorGroupEmptyState,
    isAnyGroupComposing,
    updateBreadcrumbs,
    updateMiniOutline,
    setActiveGroup,
    setSplitViewEnabled,
    getSplitViewEnabled,
    cacheCurrentBuffer,
    addOpenTab,
    closeTab,
    scheduleAfterComposition,
    handleCompositionEnd,
    updateDirtyState,
    clearJumpHighlight,
    scheduleAutoSave,
    requestOpenFile,
    jumpToFileLine,
    jumpToLocation,
    applyFormattedContent,
    applyContentToOpenFile,
    saveCurrentFile,
    requestInitialOpen,
    openPendingFileIfReady,
    clearIssueHighlight,
    parseIssueDetail,
    focusIssue,
    handleOpenFileResult,
    handleSaveResult,
    handleRenameResult,
    syncWorkspaceFiles,
    getDirtyPaths,
    getStoredCursorPosition,
    recordCursorPosition,
  };
};
