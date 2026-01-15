import type {
  EditorGroupKey,
  EditorGroupState,
  EditorSessionDeps,
  MonacoModel,
  MonacoModelEntry,
} from "./editor-session.js";
import { isImageFilePath, isPdfFilePath, isTextFilePath } from "./files.js";

type PendingSave = {
  path: string;
  content: string;
  resolve: (value: boolean) => void;
  reject: (reason?: string) => void;
};

type PendingReveal = {
  path: string;
  line: number;
  group: EditorGroupKey;
  focus?: boolean;
};

export type FileOpsState = {
  pendingOpenRequests: Array<{ path: string; group: EditorGroupKey }>;
  pendingReveal: PendingReveal | null;
  pendingSave: PendingSave | null;
  autoSaveTimer: number | null;
  autoSavePending: boolean;
};

type FileOpsDeps = {
  deps: EditorSessionDeps;
  editorGroups: Record<EditorGroupKey, EditorGroupState>;
  monacoModels: Map<string, MonacoModelEntry>;
  dirtyFiles: Set<string>;
  state: FileOpsState;
  getActiveEditorGroupKey: () => EditorGroupKey;
  getActiveGroup: () => EditorGroupState;
  getEditorGroup: (key: EditorGroupKey) => EditorGroupState;
  isActiveGroup: (group: EditorGroupState) => boolean;
  resolveAutoOpenGroupKey: (preferredKey: EditorGroupKey) => EditorGroupKey;
  findGroupKeyByPath: (path: string) => EditorGroupKey | null;
  setSplitViewEnabled: (enabled: boolean) => void;
  cacheCurrentBuffer: (group: EditorGroupState) => void;
  clearJumpHighlight: (group: EditorGroupState) => void;
  clearTemporaryTabs: (group: EditorGroupState, keepPath?: string) => void;
  addOpenTab: (group: EditorGroupState, path: string) => void;
  updateDirtyState: (path: string, content: string, savedContent?: string) => void;
  restoreViewState: (group: EditorGroupState, path: string) => void;
  setEditorLanguage: (group: EditorGroupState, path: string) => void;
  updateBreadcrumbs: () => void;
  updateMiniOutline: () => void;
  revealLine: (
    group: EditorGroupState,
    line: number,
    options?: { focus?: boolean }
  ) => void;
  forEachEditorGroup: (handler: (group: EditorGroupState) => void) => void;
  scheduleAfterComposition: (group: EditorGroupState, action: () => void) => void;
  getLanguageIdForPath: (path: string) => string;
};

export const createEditorSessionFileOps = (ctx: FileOpsDeps) => {
  const {
    deps,
    editorGroups,
    monacoModels,
    dirtyFiles,
    state,
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
  } = ctx;

  const applyViewerFile = (
    group: EditorGroupState,
    path: string,
    kind: "image" | "pdf",
    data?: string,
    mimeType?: string
  ) => {
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
    if (
      state.pendingReveal &&
      state.pendingReveal.path === path &&
      state.pendingReveal.group === group.key
    ) {
      state.pendingReveal = null;
    }
    if (kind === "image") {
      group.viewer.showImageViewer(path, data, mimeType);
    } else {
      group.viewer.showPdfViewer(path, data, mimeType);
    }
    if (isActiveGroup(group)) {
      deps.buildOps.updateSynctexButtonState();
      deps.fileTree.setTreeFocus(false);
    }
  };

  const applyUnsupportedFile = (group: EditorGroupState, path: string) => {
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
    if (
      state.pendingReveal &&
      state.pendingReveal.path === path &&
      state.pendingReveal.group === group.key
    ) {
      state.pendingReveal = null;
    }
    group.viewer.showUnsupportedViewer();
    if (isActiveGroup(group)) {
      deps.buildOps.updateSynctexButtonState();
      deps.fileTree.setTreeFocus(false);
    }
  };

  const ensureModelEntry = (path: string, content: string, savedContent?: string) => {
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
    const monacoApiAny = monacoApi as {
      editor?: { createModel?: (value: string, languageId: string) => unknown };
    };
    if (!monacoApiAny.editor?.createModel) {
      return null;
    }
    const model = monacoApiAny.editor.createModel(
      content,
      getLanguageIdForPath(path)
    ) as MonacoModel;
    const nextEntry = { model, savedContent: savedContent ?? content };
    monacoModels.set(path, nextEntry);
    updateDirtyState(path, content, nextEntry.savedContent);
    return nextEntry;
  };

  const applyFileContent = (
    group: EditorGroupState,
    path: string,
    content: string,
    savedContent?: string
  ) => {
    const monacoApi = deps.getMonacoApi();
    if (!group.editor || !monacoApi) {
      deps.updateFallback("エディタの準備が完了していません。");
      return;
    }
    const editor = group.editor as {
      setModel?: (model: unknown) => void;
      setValue?: (value: string) => void;
      getValue?: () => string;
      restoreViewState?: (state: unknown) => void;
      focus?: () => void;
    };
    const entry = ensureModelEntry(path, content, savedContent ?? content);
    clearTemporaryTabs(group, path);
    group.viewer.hideViewer();
    if (isActiveGroup(group)) {
      clearJumpHighlight(group);
    }
    group.isApplyingFile = true;
    if (entry && editor.setModel) {
      editor.setModel(entry.model as unknown);
    } else if (editor.setValue) {
      editor.setValue(content);
    }
    group.isApplyingFile = false;
    group.currentFilePath = path;
    group.currentFileSavedContent = entry?.savedContent ?? (savedContent ?? content);
    if (entry) {
      updateDirtyState(path, entry.model.getValue(), entry.savedContent);
    } else if (editor.getValue) {
      updateDirtyState(path, editor.getValue(), group.currentFileSavedContent ?? content);
    } else {
      updateDirtyState(path, content, group.currentFileSavedContent ?? content);
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
    if (
      state.pendingReveal &&
      state.pendingReveal.path === path &&
      state.pendingReveal.group === group.key
    ) {
      revealLine(group, state.pendingReveal.line, { focus: state.pendingReveal.focus });
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

  const applyFormattedContent = (
    group: EditorGroupState,
    path: string,
    content: string,
    options?: { updateSaved?: boolean }
  ) => {
    if (!group.editor) {
      return;
    }
    const editor = group.editor as {
      getValue?: () => string;
      setValue?: (value: string) => void;
      saveViewState?: () => unknown;
      restoreViewState?: (state: unknown) => void;
    };
    const entry = monacoModels.get(path);
    const currentValue = entry?.model.getValue() ?? editor.getValue?.() ?? "";
    const viewState = editor.saveViewState?.();
    if (currentValue !== content) {
      group.isApplyingFile = true;
      if (entry?.model.setValue) {
        entry.model.setValue(content);
      } else if (editor.setValue) {
        editor.setValue(content);
      }
      group.isApplyingFile = false;
      if (viewState && editor.restoreViewState) {
        editor.restoreViewState(viewState);
      }
    }
    if (options?.updateSaved) {
      if (entry) {
        entry.savedContent = content;
      }
      if (group.currentFilePath === path) {
        group.currentFileSavedContent = content;
      }
    }
    const savedContent =
      (group.currentFilePath === path
        ? group.currentFileSavedContent
        : entry?.savedContent) ??
      entry?.savedContent ??
      content;
    updateDirtyState(path, content, savedContent);
    if (isActiveGroup(group)) {
      updateBreadcrumbs();
      deps.fileTree.render();
    }
  };

  const requestOpenFile = (path: string, groupKey: EditorGroupKey, force = false) => {
    const existingGroupKey = !force ? findGroupKeyByPath(path) : null;
    const resolvedGroupKey = force
      ? groupKey
      : existingGroupKey ?? resolveAutoOpenGroupKey(groupKey);
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
    const editor = activeGroup.editor as { getValue: () => string };
    const content = editor.getValue();
    return new Promise<boolean>((resolve, reject) => {
      state.pendingSave = { path: activePath as string, content, resolve, reject };
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
    return new Promise<boolean>((resolve, reject) => {
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
      saveCurrentFile().catch((message: string) => {
        deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
      });
    }, 400);
  };

  const handleOpenFileResult = (payload: {
    path: string;
    content?: string;
    error?: string;
    kind?: "text" | "image" | "pdf" | "unsupported";
    data?: string;
    mimeType?: string;
  }) => {
    const pendingIndex = state.pendingOpenRequests.findIndex(
      (entry) => entry.path === payload.path
    );
    let targetGroupKey: EditorGroupKey =
      pendingIndex >= 0
        ? state.pendingOpenRequests.splice(pendingIndex, 1)[0].group
        : getActiveEditorGroupKey();
    const type = (payload as any).type;
    if (type === "searchResult") {
      deps.search.handleSearchUpdate(payload as any);
      return;
    }
    if (type === "env:checkResult") {
      deps.settings.updateEnvStatus((payload as any).command, (payload as any).available);
      return;
    }
    if (type === "env:installResult") {
      const { target, success, message } = payload as any;
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
    const kind =
      payload.kind ??
      (isPdfFilePath(path)
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
      } else {
        const existingGroupKey = findGroupKeyByPath(path);
        if (existingGroupKey) {
          targetGroupKey = existingGroupKey;
        } else {
          targetGroupKey = resolveAutoOpenGroupKey(targetGroupKey);
        }
      }
    }
    const targetGroup = getEditorGroup(targetGroupKey);
    if (payload.error) {
      if (
        state.pendingReveal &&
        state.pendingReveal.path === payload.path &&
        state.pendingReveal.group === targetGroupKey
      ) {
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
    const content = payload.content ?? "";
    applyFileContent(targetGroup, path, content, content);
  };

  const handleSaveResult = (payload: {
    path: string;
    ok: boolean;
    error?: string;
    content?: string;
    formatError?: string;
  }) => {
    let savedContent: string | null = null;
    if (state.pendingSave && state.pendingSave.path === payload.path) {
      if (payload.ok) {
        if (payload.content) {
          state.pendingSave.content = payload.content;
        }
        savedContent = state.pendingSave.content;
        state.pendingSave.resolve(true);
      } else {
        state.pendingSave.reject(payload.error ?? "保存に失敗しました。");
      }
      state.pendingSave = null;
    }
    if (!payload.ok) {
      deps.updateIssues(1, payload.error ?? "保存に失敗しました。", "error", [
        { severity: "error", message: payload.error ?? "保存に失敗しました。" },
      ]);
      return;
    }
    const entry = monacoModels.get(payload.path);
    let resolvedSavedContent = savedContent;
    if (resolvedSavedContent === null) {
      if (payload.content) {
        resolvedSavedContent = payload.content;
      } else if (entry) {
        resolvedSavedContent = entry.model.getValue();
      }
    }
    if (resolvedSavedContent !== null) {
      if (entry) {
        entry.savedContent = resolvedSavedContent;
      }
      dirtyFiles.delete(payload.path);
    }
    const groupsWithFile = Object.values(editorGroups).filter(
      (group) => group.currentFilePath === payload.path
    );
    if (groupsWithFile.length > 0) {
      groupsWithFile.forEach((group) => {
        if (resolvedSavedContent !== null) {
          group.currentFileSavedContent = resolvedSavedContent;
        }
        if (payload.content) {
          applyFormattedContent(group, payload.path, payload.content, { updateSaved: true });
        } else if (group.editor && group.currentFileSavedContent !== null) {
          const editor = group.editor as { getValue: () => string };
          const currentValue = editor.getValue();
          updateDirtyState(payload.path, currentValue, group.currentFileSavedContent);
        } else {
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
