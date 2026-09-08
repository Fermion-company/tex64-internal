import type {
  EditorGroupKey,
  EditorGroupState,
  EditorSessionDeps,
  MonacoModel,
  MonacoModelEntry,
} from "./editor-session.js";
import {
  isEditableTextFilePath,
  isImageFilePath,
  isPdfFilePath,
  isTextFilePath,
} from "./files.js";
import { buildLineDiff } from "./diff.js";
import { getUiLocale, uiText } from "./i18n.js";

type PendingSave = {
  path: string;
  content: string;
  resolve: (value: boolean) => void;
  reject: (reason?: string) => void;
};

type PendingReveal = {
  path: string;
  line: number;
  column?: number;
  group: EditorGroupKey;
  focus?: boolean;
  className?: string;
};

export type FileOpsState = {
  pendingOpenRequests: Array<{
    path: string;
    group: EditorGroupKey;
    background?: boolean;
  }>;
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
    options?: { focus?: boolean; className?: string; column?: number }
  ) => void;
  forEachEditorGroup: (handler: (group: EditorGroupState) => void) => void;
  scheduleAfterComposition: (group: EditorGroupState, action: () => void) => void;
  getLanguageIdForPath: (path: string) => string;
};

export const createEditorSessionFileOps = (ctx: FileOpsDeps) => {
  let lastSaveErrorMessage: string | null = null;
  const contentConflicts = new Map<
    string,
    { diskContent: string | null; conversationId: string | null; externalChange?: boolean }
  >();
  let reopenNextContentConflict = () => {};
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

  const reportSaveError = (message: string) => {
    lastSaveErrorMessage = message;
    deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
  };

  const clearOwnSaveError = () => {
    if (lastSaveErrorMessage === null) return;
    const snapshot = deps.getRecentIssuesSnapshot?.();
    const stillOurs =
      !snapshot ||
      (snapshot.status === "error" &&
        snapshot.issues.length === 1 &&
        snapshot.issues[0].message === lastSaveErrorMessage);
    if (stillOurs) deps.updateIssues(0, "", "info", []);
    lastSaveErrorMessage = null;
  };

  const clearContentConflicts = () => {
    contentConflicts.clear();
    document.getElementById("ai-content-conflict-bar")?.remove();
    clearOwnSaveError();
  };

  const savePathContent = (
    path: string,
    value: string,
    timeoutMs = 8000,
    expectedContent: string | null | undefined = monacoModels.get(path)?.savedContent,
  ): Promise<boolean> =>
    new Promise<boolean>((resolve, reject) => {
      const identity = (window as any).tex64History?.getIdentity?.() || {};
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
        const safetyTimer = window.setTimeout(() => {
          if (state.pendingSave && state.pendingSave.path === path) {
            console.warn(`[file-ops] pendingSave safety timeout for "${path}"`);
            state.pendingSave.reject("Timed out waiting for a save response.");
            state.pendingSave = null;
          }
        }, 30_000);
        const origResolve = resolve;
        const origReject = reject;
        state.pendingSave.resolve = (result: boolean) => {
          clearTimeout(safetyTimer);
          origResolve(result);
        };
        state.pendingSave.reject = (error: unknown) => {
          clearTimeout(safetyTimer);
          origReject(error);
        };
        const ok = deps.postToNative({
          ...identity,
          type: "saveFile",
          path,
          content: value,
          ...(typeof expectedContent === "string" ? { expectedContent } : {}),
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

  /**
   * Replace model content via executeEdits (preserves undo stack) when available,
   * falling back to setValue (clears undo stack) otherwise.
   */
  const replaceContentViaEdits = (
    editor: {
      executeEdits?: (
        source: string,
        edits: Array<{ range: unknown; text: string; forceMoveMarkers?: boolean }>,
      ) => void;
      setValue?: (value: string) => void;
    } | null,
    model: MonacoModel | null,
    newContent: string,
    source: string,
  ): void => {
    if (editor?.executeEdits && model?.getFullModelRange) {
      const fullRange = model.getFullModelRange();
      if (fullRange) {
        model.pushStackElement?.();
        editor.executeEdits(source, [
          { range: fullRange, text: newContent, forceMoveMarkers: true },
        ]);
        model.pushStackElement?.();
        return;
      }
    }
    if (model?.pushEditOperations && model.getFullModelRange) {
      const fullRange = model.getFullModelRange();
      if (fullRange) {
        model.pushStackElement?.();
        model.pushEditOperations(
          [],
          [{ range: fullRange, text: newContent, forceMoveMarkers: true }],
          () => null,
        );
        model.pushStackElement?.();
        return;
      }
    }
    if (model?.setValue) { model.setValue(newContent); return; }
    if (editor?.setValue) { editor.setValue(newContent); }
  };

  const applyViewerFile = (
    group: EditorGroupState,
    path: string,
    kind: "image" | "pdf",
    data?: string,
    mimeType?: string,
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
    const keepDirty = isEditableTextFilePath(path) && dirtyFiles.has(path);
    group.isDirty = keepDirty;
    if (!keepDirty) {
      dirtyFiles.delete(path);
    }
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
      editor?: {
        createModel?: (value: string, languageId: string, uri?: unknown) => unknown;
        getModel?: (uri: unknown) => unknown;
      };
      Uri?: { file?: (path: string) => unknown };
    };
    if (!monacoApiAny.editor?.createModel) {
      return null;
    }
    // Create models with a file:// URI so the LSP layer (texlab) can identify
    // documents and resolve cross-file references (\input, .bib) by path.
    const uri = monacoApiAny.Uri?.file ? monacoApiAny.Uri.file(path) : undefined;
    const existing = uri && monacoApiAny.editor.getModel ? monacoApiAny.editor.getModel(uri) : null;
    const model = (existing ??
      monacoApiAny.editor.createModel(content, getLanguageIdForPath(path), uri)) as MonacoModel;
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
      deps.updateFallback("Editor is not ready.");
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
  const aiDiffDecorations = new Map<string, string[]>();

  const clearAiDiffDecorations = (group: EditorGroupState) => {
    const editorAny = group.editor as { deltaDecorations?: (old: string[], n: unknown[]) => string[] };
    const key = group.key;
    const ids = aiDiffDecorations.get(key);
    if (ids && ids.length > 0 && editorAny?.deltaDecorations) {
      editorAny.deltaDecorations(ids, []);
      aiDiffDecorations.delete(key);
    }
    // Remove Undo/Keep bar
    const bar = document.getElementById("ai-undo-keep-bar");
    if (bar) bar.remove();
  };

  const applyFormattedContent = (
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
      forceConflict?: boolean;
      externalChange?: boolean;
    }
  ) => {
    if (!group.editor) {
      return false;
    }
    const editor = group.editor as {
      getValue?: () => string;
      setValue?: (value: string) => void;
      saveViewState?: () => unknown;
      restoreViewState?: (state: unknown) => void;
      deltaDecorations?: (oldDecorations: string[], newDecorations: unknown[]) => string[];
      getDomNode?: () => HTMLElement | null;
      onDidChangeModelContent?: (listener: () => void) => { dispose: () => void };
      executeEdits?: (
        source: string,
        edits: Array<{ range: unknown; text: string; forceMoveMarkers?: boolean }>,
      ) => void;
    };
    const entry = monacoModels.get(path);
    const currentValue = entry?.model.getValue() ?? editor.getValue?.() ?? "";
    const targetIsVisible = group.currentFilePath === path;
    const viewState = targetIsVisible ? editor.saveViewState?.() : undefined;
    const fileDeleted = options?.fileDeleted === true;
    // Codex edits the workspace on disk. If the user typed in the same open
    // buffer after the agent's source snapshot, never overwrite that newer
    // unsaved work. Updating savedContent below still records the new disk
    // baseline, so the retained buffer stays visibly dirty and can be saved or
    // reviewed by the user.
    const hasConcurrentEdit =
      options?.forceConflict === true ||
      (fileDeleted
        ? typeof options?.expectedContent === "string" &&
          currentValue !== options.expectedContent
        : currentValue !== content &&
          ((typeof options?.expectedContent === "string" &&
            currentValue !== options.expectedContent) ||
            options?.expectedFileMissing === true));

    if (hasConcurrentEdit) {
      const conversationId =
        typeof options?.conversationId === "string" && options.conversationId.trim()
          ? options.conversationId.trim()
          : null;
      contentConflicts.set(path, {
        diskContent: fileDeleted ? null : content,
        conversationId,
        externalChange: options?.externalChange,
      });
      const message = options?.externalChange ? uiText(
        `${path} changed outside TeX64. Your unsaved edits were kept.`,
        `${path} が外部で変更されました。未保存の編集は保持しています。`,
      ) : uiText(
        fileDeleted
          ? `Axiom deleted ${path} while it had unsaved edits. Choose which version to keep.`
          : `Axiom changed ${path} on disk while it had unsaved edits. Choose which version to keep.`,
        fileDeleted
          ? `未保存の編集中にAxiomが ${path} を削除しました。残す内容を選んでください。`
          : `未保存の編集中にAxiomが ${path} を変更しました。残す内容を選んでください。`,
      );
      reportSaveError(message);

      if (!targetIsVisible && !fileDeleted) {
        // Move the affected background tab into view so the two explicit
        // resolution buttons operate in the file the user is reviewing.
        requestOpenFile(path, group.key, true);
      }

      const editorDom = editor.getDomNode?.();
      const editorContainer = editorDom?.parentElement;
      if (editorContainer) {
        document.getElementById("ai-content-conflict-bar")?.remove();
        const bar = document.createElement("div");
        bar.id = "ai-content-conflict-bar";
        bar.className = "ai-undo-keep-bar";

        const keepMine = document.createElement("button");
        keepMine.className = "ai-undo-keep-btn is-undo";
        keepMine.textContent = uiText("Keep mine", "自分の編集を残す");
        keepMine.addEventListener("click", () => {
          const conflict = contentConflicts.get(path);
          if (!conflict) return;
          const mine = entry?.model.getValue() ?? editor.getValue?.() ?? currentValue;
          keepMine.disabled = true;
          useAxiom.disabled = true;
          void savePathContent(
            path,
            mine,
            8000,
            conflict.diskContent === null ? null : monacoModels.get(path)?.savedContent,
          )
            .then((saved) => {
              if (!saved) throw new Error("Saving failed.");
              contentConflicts.delete(path);
              bar.remove();
              clearOwnSaveError();
              if (conflict.conversationId) {
                deps.postToNative({
                  type: "agent:contentConflictResolved",
                  conversationId: conflict.conversationId,
                  path,
                });
              }
              reopenNextContentConflict();
            })
            .catch((error: unknown) => {
              keepMine.disabled = false;
              useAxiom.disabled = false;
              reportSaveError(error instanceof Error ? error.message : String(error));
            });
        });

        const useAxiom = document.createElement("button");
        useAxiom.className = "ai-undo-keep-btn is-keep";
        useAxiom.textContent =
          contentConflicts.get(path)?.diskContent === null
            ? uiText("Keep deleted", "削除したまま")
            : options?.externalChange ? uiText("Use disk version", "ディスクの内容を使う") : uiText("Use Axiom", "Axiomを使う");
        useAxiom.addEventListener("click", () => {
          const conflict = contentConflicts.get(path);
          if (!conflict) return;
          if (conflict.diskContent === null) {
            contentConflicts.delete(path);
            dirtyFiles.delete(path);
            bar.remove();
            clearOwnSaveError();
            deps.postToNative({ type: "requestWorkspace" });
            if (conflict.conversationId) {
              deps.postToNative({
                type: "agent:contentConflictResolved",
                conversationId: conflict.conversationId,
                path,
              });
            }
            reopenNextContentConflict();
            return;
          }
          keepMine.disabled = true;
          useAxiom.disabled = true;
          void savePathContent(path, conflict.diskContent)
            .then((saved) => {
              if (!saved) throw new Error("Saving failed.");
              contentConflicts.delete(path);
              group.isApplyingFile = true;
              replaceContentViaEdits(
                group.currentFilePath === path ? editor : null,
                entry?.model ?? null,
                conflict.diskContent,
                "ai-conflict",
              );
              group.isApplyingFile = false;
              if (entry) entry.savedContent = conflict.diskContent;
              if (group.currentFilePath === path) {
                group.currentFileSavedContent = conflict.diskContent;
              }
              updateDirtyState(path, conflict.diskContent, conflict.diskContent);
              bar.remove();
              clearOwnSaveError();
              if (conflict.conversationId) {
                deps.postToNative({
                  type: "agent:contentConflictResolved",
                  conversationId: conflict.conversationId,
                  path,
                });
              }
              reopenNextContentConflict();
              if (isActiveGroup(group)) {
                updateBreadcrumbs();
                deps.fileTree.render();
              }
            })
            .catch((error: unknown) => {
              keepMine.disabled = false;
              useAxiom.disabled = false;
              reportSaveError(error instanceof Error ? error.message : String(error));
            });
        });

        bar.append(keepMine, useAxiom);
        editorContainer.appendChild(bar);
      }
    }

    if (fileDeleted) {
      updateDirtyState(path, currentValue, entry?.savedContent ?? currentValue);
      return hasConcurrentEdit;
    }

    if (!hasConcurrentEdit && currentValue !== content) {
      // Compute changed line numbers BEFORE replacing (for diff decorations).
      // Use LCS-based diff so that only truly added/modified lines are marked,
      // not lines that merely shifted position due to an insertion above.
      let changedLineNumbers: number[] = [];
      if (options?.showAiDiff) {
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
      replaceContentViaEdits(
        targetIsVisible ? editor : null,
        entry?.model ?? null,
        content,
        options?.showAiDiff ? "ai-apply" : "format-on-save",
      );
      group.isApplyingFile = false;
      if (targetIsVisible && viewState && editor.restoreViewState) {
        editor.restoreViewState(viewState);
      }

      // Add AI diff decorations
      if (
        targetIsVisible &&
        options?.showAiDiff &&
        changedLineNumbers.length > 0 &&
        editor.deltaDecorations
      ) {
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

        // The edit is already on disk and the chat card carries "元に戻す";
        // the editor only marks the changed lines until the next edit.

        // Auto-clear on next content change (user edit, undo, redo)
        if (editor.onDidChangeModelContent) {
          const disposable = editor.onDidChangeModelContent(() => {
            clearAiDiffDecorations(group);
            disposable.dispose();
          });
        }
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
    updateDirtyState(path, hasConcurrentEdit ? currentValue : content, savedContent);
    if (isActiveGroup(group)) {
      updateBreadcrumbs();
      deps.fileTree.render();
    }
    return hasConcurrentEdit;
  };

  reopenNextContentConflict = () => {
    const next = contentConflicts.entries().next();
    if (next.done) return;
    const [nextPath, conflict] = next.value;
    const groupKey = findGroupKeyByPath(nextPath);
    if (!groupKey) return;
    applyFormattedContent(
      getEditorGroup(groupKey),
      nextPath,
      conflict.diskContent ?? "",
      {
        updateSaved: conflict.diskContent !== null,
        fileDeleted: conflict.diskContent === null,
        conversationId: conflict.conversationId ?? undefined,
        forceConflict: true,
        externalChange: conflict.externalChange,
      },
    );
  };

  const requestOpenFile = (path: string, groupKey: EditorGroupKey, force = false) => {
    const preferredGroupHasPath = !force
      ? (() => {
          const preferredGroup = getEditorGroup(groupKey);
          return (
            preferredGroup.currentFilePath === path ||
            preferredGroup.openTabs.includes(path)
          );
        })()
      : false;
    const existingGroupKey =
      !force && !preferredGroupHasPath ? findGroupKeyByPath(path) : null;
    const resolvedGroupKey = force
      ? groupKey
      : preferredGroupHasPath
      ? groupKey
      : existingGroupKey ?? resolveAutoOpenGroupKey(groupKey);
    const group = getEditorGroup(resolvedGroupKey);
    if (group.currentFilePath === path && group.viewer.getViewerMode() !== "unsupported") {
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

  const requestOpenFileInBackground = (path: string, groupKey: EditorGroupKey) => {
    if (monacoModels.has(path)) return false;
    if (state.pendingOpenRequests.some((entry) => entry.path === path)) return true;
    const requestEntry = { path, group: groupKey, background: true };
    state.pendingOpenRequests.push(requestEntry);
    const ok = deps.postToNative({ type: "openFile", path });
    if (!ok) {
      const index = state.pendingOpenRequests.indexOf(requestEntry);
      if (index >= 0) state.pendingOpenRequests.splice(index, 1);
      deps.updateIssues(1, "Unable to open file.", "error", [
        { severity: "error", message: "Unable to open file." },
      ]);
    }
    return ok;
  };

  const saveCurrentFileInternal = () => {
    const activeGroup = getActiveGroup();
    const activePath = activeGroup.currentFilePath;
    if (!activePath || !activeGroup.editor || !isEditableTextFilePath(activePath)) {
      const message = activePath
        ? "This file format cannot be edited."
        : "No files have been selected to save.";
      deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
      return Promise.resolve(false);
    }
    const editor = activeGroup.editor as { getValue: () => string };
    const content = editor.getValue();
    if (contentConflicts.has(activePath)) {
      reportSaveError(
        uiText(
          "Resolve the edit conflict before saving.",
          "保存する前に編集競合を解決してください。",
        ),
      );
      return Promise.resolve(false);
    }
    return savePathContent(activePath as string, content);
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

  const saveDirtyFiles = async () => {
    const dirtyPaths = Array.from(dirtyFiles).filter((path) => isEditableTextFilePath(path));
    if (dirtyPaths.length === 0) {
      return true;
    }
    if (dirtyPaths.some((path) => contentConflicts.has(path))) {
      reportSaveError(
        uiText(
          "Resolve the edit conflict before saving.",
          "保存する前に編集競合を解決してください。",
        ),
      );
      return false;
    }
    const activePath = getActiveGroup().currentFilePath;
    const ordered = dirtyPaths.slice().sort((a, b) => {
      if (a === activePath) {
        return -1;
      }
      if (b === activePath) {
        return 1;
      }
      return a.localeCompare(b, getUiLocale());
    });
    const readBuffer = (path: string): string | null => {
      const entry = monacoModels.get(path);
      if (entry?.model?.getValue) {
        return entry.model.getValue();
      }
      const owner = Object.values(editorGroups).find((group) => group.currentFilePath === path);
      if (!owner?.editor) {
        return null;
      }
      const editor = owner.editor as { getValue?: () => string };
      return editor.getValue?.() ?? null;
    };
    const waitForCompositionIfNeeded = (path: string) =>
      new Promise<void>((resolve) => {
        const owner = Object.values(editorGroups).find((group) => group.currentFilePath === path);
        if (!owner?.isComposing) {
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
        reportSaveError(`Unable to retrieve content to save: ${path}`);
        return false;
      }
      try {
        await savePathContent(path, content);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Saving failed.";
        reportSaveError(message);
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
      saveDirtyFiles().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        reportSaveError(message);
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
    livePreview?: { generation: number; documentEpoch: number };
  }) => {
    // Handle non-file-open message types before consuming pending requests.
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
        console.warn(`Environment install failed for ${target}: ${message}`);
      }
      return;
    }
    const pendingIndex = state.pendingOpenRequests.findIndex(
      (entry) => entry.path === payload.path
    );
    const pendingEntry = pendingIndex >= 0
      ? state.pendingOpenRequests.splice(pendingIndex, 1)[0]
      : null;
    let targetGroupKey: EditorGroupKey = pendingEntry?.group ?? getActiveEditorGroupKey();
    if (!payload.path) {
      return;
    }
    const path = payload.path;
    const kind =
      payload.kind === "text" && !isTextFilePath(path)
        ? "unsupported"
        : payload.kind ??
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
    if (pendingEntry?.background) {
      if (kind !== "text") {
        deps.updateIssues(1, "The live preview source is not editable.", "error", [
          { severity: "error", message: "The live preview source is not editable." },
        ]);
        return;
      }
      const entry = ensureModelEntry(path, payload.content ?? "", payload.content ?? "");
      if (!entry) {
        deps.updateFallback("Editor is not ready.");
        return;
      }
      addOpenTab(targetGroup, path);
      deps.editorTabs.render(targetGroup);
      return;
    }
    if (kind === "image" || kind === "pdf") {
      applyViewerFile(
        targetGroup,
        path,
        kind,
        payload.data,
        payload.mimeType,
      );
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
    busy?: boolean;
    error?: string;
    content?: string;
    formatError?: string;
  }) => {
    let savedContent: string | null = null;
    const saveErrorMessage = payload.error ?? "Saving failed.";
    if (state.pendingSave) {
      if (state.pendingSave.path === payload.path) {
        if (payload.busy) {
          state.pendingSave.resolve(false);
        } else if (payload.ok) {
          if (payload.content) {
            state.pendingSave.content = payload.content;
          }
          savedContent = state.pendingSave.content;
          state.pendingSave.resolve(true);
        } else {
          state.pendingSave.reject(saveErrorMessage);
        }
        state.pendingSave = null;
      } else {
        // Path mismatch: the native side returned a result for a different path.
        // Log and leave pendingSave intact so the correct result can still arrive.
        console.warn(
          `[file-ops] handleSaveResult path mismatch: expected "${state.pendingSave.path}", got "${payload.path}"`
        );
      }
    }
    if (payload.busy) {
      scheduleAutoSave();
      return;
    }
    if (!payload.ok) {
      reportSaveError(saveErrorMessage);
      return;
    }
    if (lastSaveErrorMessage !== null) {
      const snapshot = deps.getRecentIssuesSnapshot?.();
      const stillOurs =
        !snapshot ||
        (snapshot.status === "error" &&
          snapshot.issues.length === 1 &&
          snapshot.issues[0].message === lastSaveErrorMessage);
      if (stillOurs) {
        deps.updateIssues(0, "", "info", []);
      }
      lastSaveErrorMessage = null;
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
    requestOpenFileInBackground,
    saveCurrentFile,
    saveDirtyFiles,
    scheduleAutoSave,
    handleOpenFileResult,
    handleSaveResult,
    clearContentConflicts,
  };
};
