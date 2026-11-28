import type {
  EditorGroupKey,
  EditorGroupState,
  EditorSessionDeps,
  MonacoModel,
  MonacoModelEntry,
} from "./editor-session.js";
import {
  isTexFilePath,
  isImageFilePath,
  isPdfFilePath,
} from "./files.js";
import type { FormatTarget } from "./editor-session/types.js";
import { buildLineDiff } from "./diff.js";
import { getUiLocale, uiText } from "./i18n.js";
import { trackLiveEditModel } from "./editor-session/live-edit-history.js";
import type { TabPosition } from "./editor-session/tab-state-ops.js";
import { getEditorModelPath, rememberEditorModelPath } from "./editor-session/model-path.js";
import { applyHunks, rebaseHunks, type TextHunk } from "./editor-session/text-merge.js";
import { notifySaveStatusChange, type SaveStatus } from "./save-status.js";

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
  issueMessage?: string;
  group: EditorGroupKey;
  focus?: boolean;
  className?: string;
};

type OpenRequest = {
  id: number;
  path: string;
  group: EditorGroupKey;
  background?: boolean;
  position?: TabPosition;
  wasOpen?: boolean;
  // The automatic PDF shown beside a manuscript (openFirstPreview).
  firstPreview?: boolean;
  // A background read shared with a foreground one: whether its tab appears
  // when the foreground selection moves on (false: a model only, for a paper edit).
  showTab?: boolean;
};

export type FileOpsState = {
  pendingOpenRequests: OpenRequest[];
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
  addOpenTab: (group: EditorGroupState, path: string, position?: TabPosition) => void;
  updateDirtyState: (path: string, content: string, savedContent?: string) => void;
  restoreViewState: (group: EditorGroupState, path: string) => void;
  setEditorLanguage: (group: EditorGroupState, path: string) => void;
  updateBreadcrumbs: () => void;
  updateMiniOutline: () => void;
  revealLine: (
    group: EditorGroupState,
    line: number,
    options?: { focus?: boolean; className?: string; column?: number; issueMessage?: string }
  ) => void;
  scheduleAfterComposition: (group: EditorGroupState, action: () => void, cancel?: () => void) => void;
  getLanguageIdForPath: (path: string) => string;
  /** Clock for the typing-pause rules (tests replace it). */
  now?: () => number;
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
    scheduleAfterComposition,
    getLanguageIdForPath,
  } = ctx;
  const now = ctx.now ?? (() => Date.now());
  let nextOpenRequestId = 0;
  let openScope = 0;
  const latestOpen = new Map<EditorGroupKey, OpenRequest>();

  const clearOpenRequests = () => {
    state.pendingOpenRequests.length = 0;
    latestOpen.clear();
    openScope += 1;
  };

  // When each model was last edited from the keyboard (or IME, or the live
  // preview), and where. Edits applied from outside the keyboard run with
  // isApplyingFile set on every group and are not typing.
  const typing = new WeakMap<object, { at: number; offset: number | null }>();
  const watchedForTyping = new WeakSet<object>();
  const watchTyping = (model: MonacoModel) => {
    if (watchedForTyping.has(model) || !model.onDidChangeContent) return;
    watchedForTyping.add(model);
    model.onDidChangeContent((event) => {
      if (event.isFlush) return;
      if (Object.values(editorGroups).some((group) => group.isApplyingFile)) return;
      const change = event.changes?.[0];
      typing.set(model, { at: now(), offset: change ? change.rangeOffset + change.text.length : null });
    });
  };

  // Files whose autosave waits: an Axiom edit to the paragraph being typed is
  // held until a pause (outside-edits.ts), and until it is applied the editor
  // text is not based on the disk any more. `release` applies it (or shows the
  // conflict choices) at once; an explicit save or a Build calls it.
  const heldSaves = new Map<string, () => void>();
  // Files whose save was refused because the disk changed: until when that
  // stays quiet (reportSaveError).
  const diskChangeQuietUntil = new Map<string, number>();
  const DISK_CHANGE_QUIET_MS = 3000;

  // Why each file's last save failed. An entry lasts until that file saves
  // or stops being dirty: another file saving says nothing about it.
  const saveErrors = new Map<string, string>();
  let lastSavedAt: number | null = null;
  // A failed file keeps trying on its own (2 s, 4 s, ... up to 30 s): the
  // cause is often passing (a sync client or a project operation holding it).
  let saveRetryTimer: number | null = null;
  let saveRetryDelayMs = 0;
  const hasFailedDirtyFile = () => Array.from(saveErrors.keys()).some((path) => dirtyFiles.has(path));
  const scheduleSaveRetry = () => {
    if (saveRetryTimer !== null) return;
    saveRetryDelayMs = Math.min(30_000, saveRetryDelayMs > 0 ? saveRetryDelayMs * 2 : 2000);
    saveRetryTimer = window.setTimeout(() => {
      saveRetryTimer = null;
      if (hasFailedDirtyFile()) void saveDirtyFiles({ auto: true }).catch(() => {});
    }, saveRetryDelayMs);
  };
  const reportSaveError = (message: string, path: string | null = null) => {
    // A file waiting for the person's choice (its conflict bar) or for a
    // typing pause (held Axiom edit) is a state, not a save failure: its
    // autosave being refused against the newer disk text says nothing new.
    if (path && (heldSaves.has(path) || contentConflicts.has(path))) return;
    // The disk changed under this save: the watcher's notice of that change
    // follows within a moment and either merges it into the buffer or opens
    // the conflict choices. Give it that moment before calling it a failure.
    if (path && /changed on disk/i.test(message)) {
      const quietUntil = diskChangeQuietUntil.get(path);
      if (quietUntil === undefined || now() < quietUntil) {
        if (quietUntil === undefined) diskChangeQuietUntil.set(path, now() + DISK_CHANGE_QUIET_MS);
        window.setTimeout(() => {
          if (dirtyFiles.has(path)) void saveDirtyFiles({ auto: true }).catch(() => {});
        }, DISK_CHANGE_QUIET_MS + 100);
        return;
      }
    }
    // A retry failing the same way leaves Issues alone: it would replace the
    // build's warnings every few seconds. (Retries differ only in the
    // temporary file name.) `lastSaveErrorMessage` is what Issues shows, so
    // a later success can take exactly that down.
    const kind = (text: string) => text.replace(/\.[^\s'"/\\]+\.tmp-[\w.-]+/g, "");
    const previous = path ? saveErrors.get(path) : lastSaveErrorMessage;
    if (typeof previous !== "string" || kind(previous) !== kind(message)) {
      deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
      lastSaveErrorMessage = message;
    }
    if (path) {
      saveErrors.set(path, message);
      scheduleSaveRetry();
    }
    notifySaveStatusChange();
  };
  // A save rejects with the host's message as a string.
  const saveFailureMessage = (error: unknown) =>
    typeof error === "string" && error
      ? error
      : error instanceof Error && error.message
        ? error.message
        : "Saving failed.";

  // Save by hand (Cmd+S, Retry, Build/History/Git) on a file whose conflict
  // choices are open: say why, through the save status (its notice names the
  // file), not as an issue.
  const CONFLICT_SAVE_MESSAGE = uiText("Resolve the edit conflict before saving.", "保存する前に編集競合を解決してください。");
  const refuseConflictedSave = (path: string) => {
    saveErrors.set(path, CONFLICT_SAVE_MESSAGE);
    notifySaveStatusChange();
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
    notifySaveStatusChange();
  };

  const clearContentConflicts = () => {
    contentConflicts.clear();
    notifySaveStatusChange();
    document.getElementById("ai-content-conflict-bar")?.remove();
    clearOwnSaveError();
  };

  // `expectedContent` left out: what is on disk is whatever this editor last
  // saved, read when the save leaves the queue. Reading it when the save was
  // queued went stale once an earlier save of the same file landed, and the
  // host then reported a change "by another app" that was only our own save.
  const savePathContent = (
    path: string,
    value: string,
    timeoutMs = 8000,
    expectedContent?: string | null,
    stillCurrent?: () => boolean,
  ): Promise<boolean> =>
    new Promise<boolean>((resolve, reject) => {
      const identity = (window as any).tex64History?.getIdentity?.() || {};
      const startedAt = Date.now();
      const enqueue = () => {
        if (stillCurrent && !stillCurrent()) {
          resolve(false);
          return;
        }
        if (state.pendingSave) {
          if (Date.now() - startedAt >= timeoutMs) {
            reject("Waiting for save timed out.");
            return;
          }
          window.setTimeout(enqueue, 25);
          return;
        }
        const lastSaved = monacoModels.get(path)?.savedContent;
        if (expectedContent === undefined && typeof lastSaved === "string" && lastSaved === value) {
          // An earlier queued save already wrote exactly this.
          resolve(true);
          return;
        }
        const expected = expectedContent === undefined ? lastSaved : expectedContent;
        state.pendingSave = { path, content: value, resolve, reject };
        notifySaveStatusChange();
        const safetyTimer = window.setTimeout(() => {
          if (state.pendingSave && state.pendingSave.path === path) {
            console.warn(`[file-ops] pendingSave safety timeout for "${path}"`);
            state.pendingSave.reject("Timed out waiting for a save response.");
            state.pendingSave = null;
            notifySaveStatusChange();
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
          ...(typeof expected === "string" ? { expectedContent: expected } : {}),
          format: false,
        });
        if (!ok) {
          clearTimeout(safetyTimer);
          state.pendingSave = null;
          notifySaveStatusChange();
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

  type PositionModel = MonacoModel & {
    getPositionAt?: (offset: number) => { lineNumber: number; column: number };
    deltaDecorations?: (old: string[], next: unknown[]) => string[];
    getDecorationRange?: (id: string) => { startLineNumber: number } | null;
  };
  type ScrollEditor = {
    getVisibleRanges?: () => Array<{ startLineNumber: number }>;
    getScrollTop?: () => number;
    setScrollTop?: (top: number) => void;
    getTopForLineNumber?: (line: number) => number;
  };

  // Keeps the first visible line's text where it is on screen when lines are
  // added or removed above it (a decoration follows that text through the
  // edit). Monaco itself keeps the pixel offset, which slides the page.
  const anchorViewport = (editor: ScrollEditor | null, model: PositionModel) => {
    const top = editor?.getVisibleRanges?.()?.[0]?.startLineNumber;
    if (!top || !editor?.getScrollTop || !editor.setScrollTop || !editor.getTopForLineNumber ||
      !model.deltaDecorations || !model.getDecorationRange) return () => {};
    const offset = editor.getScrollTop() - editor.getTopForLineNumber(top);
    const [id] = model.deltaDecorations([], [{
      range: { startLineNumber: top, startColumn: 1, endLineNumber: top, endColumn: 1 },
      options: { stickiness: 1 }, // NeverGrowsWhenTypingAtEdges: stays with the text
    }]);
    return () => {
      const moved = id ? model.getDecorationRange!(id) : null;
      if (id) model.deltaDecorations!([id], []);
      if (moved && moved.startLineNumber !== top) {
        editor.setScrollTop!(editor.getTopForLineNumber!(moved.startLineNumber) + offset);
      }
    };
  };

  // Applies only the changed ranges, as one undo step. Monaco moves the caret,
  // selections, markers and decorations with the text they belong to, so a
  // writer outside the keyboard does not relocate the person typing. Returns
  // false when the model cannot take ranged edits.
  const applyRangedEdits = (
    editor: {
      executeEdits?: (
        source: string,
        edits: Array<{ range: unknown; text: string; forceMoveMarkers?: boolean }>,
      ) => boolean | void;
    } & ScrollEditor | null,
    model: PositionModel,
    hunks: TextHunk[],
    source: string,
  ) => {
    if (!model.getPositionAt || (!editor?.executeEdits && !model.pushEditOperations)) return false;
    if (hunks.length === 0) return true;
    const edits = hunks.map((hunk) => {
      const start = model.getPositionAt!(hunk.start);
      const end = model.getPositionAt!(hunk.end);
      return {
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        },
        text: hunk.text,
        forceMoveMarkers: false,
      };
    });
    const restoreViewport = anchorViewport(editor, model);
    model.pushStackElement?.();
    // A read-only editor (a project operation in progress) refuses
    // executeEdits; the disk changed regardless, so edit the model.
    const viaEditor = editor?.executeEdits ? editor.executeEdits(source, edits) !== false : false;
    if (!viaEditor) {
      if (!model.pushEditOperations) {
        restoreViewport();
        return false;
      }
      model.pushEditOperations([], edits, () => null);
    }
    model.pushStackElement?.();
    restoreViewport();
    return true;
  };

  // [start, end) of the blank-line delimited paragraph around `offset`.
  const paragraphAround = (text: string, offset: number): [number, number] => {
    const lineIsBlank = (from: number, to: number) => text.slice(from, to).trim() === "";
    let start = text.lastIndexOf("\n", offset - 1) + 1;
    while (start > 0) {
      const previousStart = text.lastIndexOf("\n", start - 2) + 1;
      if (lineIsBlank(previousStart, start - 1)) break;
      start = previousStart;
    }
    let end = text.indexOf("\n", offset);
    if (end < 0) end = text.length;
    while (end < text.length) {
      let nextEnd = text.indexOf("\n", end + 1);
      if (nextEnd < 0) nextEnd = text.length;
      if (lineIsBlank(end + 1, nextEnd)) break;
      end = nextEnd;
    }
    return [start, end];
  };

  // Monaco hides an encoding BOM and keeps one line-break style; compare and
  // diff disk text in the model's form.
  const inModelForm = (model: MonacoModel, bufferValue: string, text: string) => {
    const eol = model.getEOL?.() === "\r\n" ? "\r\n" : "\n";
    const unified = text.replace(/\r\n|\r|\n/g, eol);
    return unified.charCodeAt(0) === 0xfeff && bufferValue.charCodeAt(0) !== 0xfeff ? unified.slice(1) : unified;
  };

  const applyViewerFile = (
    group: EditorGroupState,
    path: string,
    kind: "image" | "pdf" | "unbuilt-pdf",
    data?: string,
    mimeType?: string,
    position?: TabPosition,
    preserveFocus = false,
  ) => {
    group.currentFilePath = path;
    group.currentFileSavedContent = null;
    group.isDirty = false;
    dirtyFiles.delete(path);
    addOpenTab(group, path, position);
    clearTemporaryTabs(group, path);
    deps.editorTabs.render(group);
    if (isActiveGroup(group)) {
      deps.fileTree.setSelection(path, "file");
      updateBreadcrumbs();
      updateMiniOutline();
      deps.outline.render();
      deps.fileTree.render();
    }
    if (kind !== "unbuilt-pdf") {
      deps.setBlockPreviewActive(false);
      deps.setAutoDetectedUi(false);
    }
    if (
      state.pendingReveal &&
      state.pendingReveal.path === path &&
      state.pendingReveal.group === group.key
    ) {
      state.pendingReveal = null;
    }
    if (kind === "image") {
      group.viewer.showImageViewer(path, data, mimeType);
    } else if (kind === "unbuilt-pdf") {
      group.viewer.showUnbuiltPdf(path);
    } else {
      group.viewer.showPdfViewer(path, data, mimeType, preserveFocus || !isActiveGroup(group));
    }
    if (isActiveGroup(group)) {
      deps.buildOps.updateSynctexButtonState();
      deps.fileTree.setTreeFocus(false);
    }
  };

  const applyUnsupportedFile = (group: EditorGroupState, path: string, position?: TabPosition) => {
    group.currentFilePath = path;
    group.currentFileSavedContent = null;
    const keepDirty = monacoModels.has(path) && dirtyFiles.has(path);
    group.isDirty = keepDirty;
    if (!keepDirty) {
      dirtyFiles.delete(path);
    }
    addOpenTab(group, path, position);
    clearTemporaryTabs(group, path);
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

  const ensureModelEntry = (path: string, content: string, savedContent?: string, plainText?: boolean) => {
    const monacoApi = deps.getMonacoApi();
    if (!monacoApi) {
      return null;
    }
    const entry = monacoModels.get(path);
    if (entry) {
      if (plainText !== undefined) entry.plainText = plainText;
      rememberEditorModelPath(entry.model, path);
      trackLiveEditModel(entry.model);
      watchTyping(entry.model);
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
    const root = deps.getWorkspaceRoot?.();
    const fullPath = root && !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
      ? `${root.replace(/[\\/]+$/, "")}/${path}`
      : path;
    const uri = monacoApiAny.Uri?.file?.(fullPath);
    const existing = uri && monacoApiAny.editor.getModel ? monacoApiAny.editor.getModel(uri) : null;
    const model = (existing ??
      monacoApiAny.editor.createModel(content, plainText ? "plaintext" : getLanguageIdForPath(path), uri)) as MonacoModel;
    rememberEditorModelPath(model, path);
    trackLiveEditModel(model);
    watchTyping(model);
    const nextEntry = { model, savedContent: savedContent ?? content, plainText };
    monacoModels.set(path, nextEntry);
    // Workspace edits can change a model with no visible editor (e.g. F2).
    // Writers outside the keyboard (outside-edits.ts) set isApplyingFile and
    // settle the dirty state themselves.
    model.onDidChangeContent?.((event) => {
      if (event.isFlush) return;
      if (Object.values(editorGroups).some((group) => group.isApplyingFile)) return;
      const file = getEditorModelPath(model);
      if (!file || monacoModels.get(file)?.model !== model) return;
      if (Object.values(editorGroups).some((group) => group.currentFilePath === file)) return;
      updateDirtyState(file, model.getValue());
      scheduleAutoSave();
    });
    updateDirtyState(path, content, nextEntry.savedContent);
    return nextEntry;
  };

  const applyFileContent = (
    group: EditorGroupState,
    path: string,
    entry: MonacoModelEntry | null,
    position?: TabPosition,
  ) => {
    if (!group.editor || !entry) {
      deps.updateFallback("Editor is not ready.");
      return;
    }
    const editor = group.editor as {
      setModel: (model: unknown) => void;
      focus?: () => void;
    };
    group.viewer.hideViewer();
    if (isActiveGroup(group)) {
      clearJumpHighlight(group);
    }
    group.currentFilePath = path;
    group.currentFileSavedContent = entry.savedContent;
    group.isApplyingFile = true;
    try {
      editor.setModel(entry.model);
    } finally {
      group.isApplyingFile = false;
    }
    updateDirtyState(path, entry.model.getValue(), entry.savedContent);
    restoreViewState(group, path);
    addOpenTab(group, path, position);
    clearTemporaryTabs(group, path);
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
        issueMessage: state.pendingReveal.issueMessage,
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
    if (contentConflicts.has(path)) showPendingConflict(group, path);
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
    const currentValue = entry?.model.getValue(undefined, true) ?? editor.getValue?.() ?? "";
    const targetIsVisible = group.currentFilePath === path;
    const viewState = targetIsVisible ? editor.saveViewState?.() : undefined;
    const fileDeleted = options?.fileDeleted === true;
    // A new disk version from outside the keyboard (another program, Axiom).
    // `entry.savedContent` is the disk text this buffer was last in step
    // with, so savedContent → buffer is exactly the unsaved typing and
    // savedContent → content is everything that happened on disk. Carry the
    // latter over as ranged edits when it does not touch the former. A file
    // already in conflict stays in conflict: its buffer is not based on
    // savedContent any more.
    let rebased: { hunks: TextHunk[]; from: string; value: string; matchesDisk: boolean } | null = null;
    if (
      entry &&
      !fileDeleted &&
      options?.updateSaved === true &&
      options.forceConflict !== true &&
      options.expectedFileMissing !== true &&
      (typeof options.expectedContent === "string" || options.externalChange === true) &&
      !contentConflicts.has(path)
    ) {
      // The hunks are applied at model offsets, which never count an encoding
      // BOM (currentValue keeps it for the comparisons with the disk below).
      const buffer = entry.model.getValue();
      const base = inModelForm(entry.model, buffer, entry.savedContent ?? options.expectedContent ?? "");
      const theirs = inModelForm(entry.model, buffer, content);
      const hunks = rebaseHunks(base, buffer, theirs);
      if (hunks) {
        const value = applyHunks(buffer, hunks);
        rebased = { hunks, from: buffer, value, matchesDisk: value === theirs };
      }
    }
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
        : rebased === null &&
          currentValue !== content &&
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
        `${path}が外部で変更されました。未保存の編集は保持しています。`,
      ) : uiText(
        fileDeleted
          ? `Axiom deleted ${path} while it had unsaved edits. Choose which version to keep.`
          : `Axiom changed ${path} on disk while it had unsaved edits. Choose which version to keep.`,
        fileDeleted
          ? `未保存の編集中にAxiomが ${path} を削除しました。残す内容を選んでください。`
          : `未保存の編集中にAxiomが ${path} を変更しました。残す内容を選んでください。`,
      );
      // The conflict bar is the notice. A failure already recorded for this
      // file (an autosave refused against the new disk text) is superseded.
      diskChangeQuietUntil.delete(path);
      if (saveErrors.delete(path) && !hasFailedDirtyFile()) clearOwnSaveError();
      notifySaveStatusChange();

      // A conflict that arrives on its own (another program, Axiom) never
      // switches tabs: the person may be typing in another file. Its buttons
      // appear when that file is shown (applyFileContent). Moving on to the
      // next conflict after resolving one is the person's own action.
      const showsElsewhere = !targetIsVisible && !fileDeleted;
      if (showsElsewhere && options?.forceConflict === true) {
        requestOpenFile(path, group.key, true);
      }

      const editorDom = editor.getDomNode?.();
      const editorContainer = showsElsewhere && options?.forceConflict !== true ? null : editorDom?.parentElement;
      if (editorContainer) {
        document.getElementById("ai-content-conflict-bar")?.remove();
        const bar = document.createElement("div");
        bar.id = "ai-content-conflict-bar";
        bar.className = "ai-undo-keep-bar";
        // What happened, for hover and assistive technology.
        bar.title = message;
        bar.setAttribute?.("role", "group");
        bar.setAttribute?.("aria-label", message);

        const keepMine = document.createElement("button");
        keepMine.className = "ai-undo-keep-btn is-undo";
        keepMine.textContent = uiText("Keep mine", "自分の編集を残す");
        keepMine.addEventListener("click", () => {
          const conflict = contentConflicts.get(path);
          if (!conflict) return;
          const mine = entry?.model.getValue(undefined, true) ?? editor.getValue?.() ?? currentValue;
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
              notifySaveStatusChange();
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
            notifySaveStatusChange();
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
              notifySaveStatusChange();
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

    const nextValue = rebased ? rebased.value : content;
    if (!hasConcurrentEdit && (rebased ? rebased.hunks.length > 0 : currentValue !== content)) {
      // Compute changed line numbers BEFORE replacing (for diff decorations).
      // Use LCS-based diff so that only truly added/modified lines are marked,
      // not lines that merely shifted position due to an insertion above.
      let changedLineNumbers: number[] = [];
      if (options?.showAiDiff) {
        const oldLines = (rebased ? rebased.from : currentValue).split("\n");
        const newLines = nextValue.split("\n");
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

      const source = options?.showAiDiff ? "ai-apply" : "format-on-save";
      // Every editor showing this model ignores the edit as typing; the dirty
      // state is set below.
      const groups = Object.values(editorGroups);
      const wasApplying = groups.map((each) => each.isApplyingFile);
      groups.forEach((each) => { each.isApplyingFile = true; });
      try {
        const ranged = rebased && entry &&
          applyRangedEdits(targetIsVisible ? editor : null, entry.model as PositionModel, rebased.hunks, source);
        if (ranged && entry.model.getValue() !== nextValue) {
          // Never expected; still never leave the buffer different from what
          // was computed (the person's typing plus the disk change).
          console.warn(`[file-ops] ranged apply diverged for "${path}"; replacing the buffer`);
          replaceContentViaEdits(targetIsVisible ? editor : null, entry.model, nextValue, source);
          if (targetIsVisible && viewState && editor.restoreViewState) editor.restoreViewState(viewState);
        } else if (!ranged) {
          replaceContentViaEdits(
            targetIsVisible ? editor : null,
            entry?.model ?? null,
            nextValue,
            source,
          );
          if (targetIsVisible && viewState && editor.restoreViewState) {
            editor.restoreViewState(viewState);
          }
        }
      } finally {
        groups.forEach((each, index) => { each.isApplyingFile = wasApplying[index]; });
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
    // A rebase that kept unsaved typing leaves the buffer dirty against the
    // new disk text; autosave then writes both, guarded by that text.
    const keptTyping = !hasConcurrentEdit && rebased !== null && !rebased.matchesDisk;
    updateDirtyState(path, hasConcurrentEdit ? currentValue : keptTyping ? nextValue : content, savedContent);
    if (keptTyping) scheduleAutoSave();
    return hasConcurrentEdit;
  };

  // Shows the resolution buttons of a conflict whose file has just come into
  // view (a conflict never switches tabs by itself).
  const showPendingConflict = (group: EditorGroupState, path: string) => {
    const conflict = contentConflicts.get(path);
    if (!conflict || group.currentFilePath !== path) return;
    applyFormattedContent(group, path, conflict.diskContent ?? "", {
      updateSaved: conflict.diskContent !== null,
      fileDeleted: conflict.diskContent === null,
      conversationId: conflict.conversationId ?? undefined,
      forceConflict: true,
      externalChange: conflict.externalChange,
    });
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

  // Install a model only for the latest selection of this pane. Cache the
  // outgoing buffer at the swap, since it may have changed during a read or IME.
  const isCurrentOpen = (request: OpenRequest) =>
    latestOpen.get(request.group) === request &&
    (!request.wasOpen || getEditorGroup(request.group).openTabs.includes(request.path));

  const activateOpen = (group: EditorGroupState, request: OpenRequest | null, apply: () => void, scope = openScope) => {
    if (scope !== openScope || (request && !isCurrentOpen(request))) return;
    if (group.isComposing) {
      scheduleAfterComposition(group, () => activateOpen(group, request, apply, scope));
      return;
    }
    cacheCurrentBuffer(group);
    apply();
  };

  const sendOpenRequest = (request: OpenRequest) => {
    state.pendingOpenRequests.push(request);
    const ok = deps.postToNative({
      type: "openFile", path: request.path, openRequestId: request.id,
      expectedWorkspaceRoot: deps.getWorkspaceRoot?.(),
    });
    if (!ok) {
      const index = state.pendingOpenRequests.indexOf(request);
      if (index >= 0) state.pendingOpenRequests.splice(index, 1);
      deps.updateIssues(1, "Unable to open file.", "error", [
        { severity: "error", message: "Unable to open file." },
      ]);
    }
    return ok;
  };

  // The PDF shown automatically beside a manuscript (openFirstPreview). It
  // takes an empty secondary pane, or replaces the previous automatic one;
  // a file the person opens there ends it.
  const cancelPendingFirstPreview = () => {
    state.pendingOpenRequests = state.pendingOpenRequests.filter(request => !request.firstPreview);
  };
  const canShowFirstPreview = (group: EditorGroupState, path: string) => {
    if (state.pendingOpenRequests.some(request => request.group === group.key)) return false;
    if (group.currentFilePath === group.automaticPreviewPath && group.currentFilePath) return true;
    if (group.currentFilePath === path && group.viewer.getViewerMode() === "unsupported") return true;
    return !group.currentFilePath && !group.openTabs.length && !isActiveGroup(group);
  };
  const replaceFirstPreview = (group: EditorGroupState, path: string) => {
    const previous = group.automaticPreviewPath;
    if (previous && previous !== path) group.openTabs = group.openTabs.filter(tab => tab !== previous);
    group.automaticPreviewPath = path;
  };

  const openInPane = (
    path: string,
    groupKey: EditorGroupKey,
    force: boolean,
    position: TabPosition | undefined,
    firstPreview: boolean,
  ) => {
    const preferredGroup = getEditorGroup(groupKey);
    const preferredGroupHasPath =
      preferredGroup.currentFilePath === path || preferredGroup.openTabs.includes(path);
    const existingGroupKey = preferredGroupHasPath ? groupKey : findGroupKeyByPath(path);
    const resolvedGroupKey = force || preferredGroupHasPath
      ? groupKey
      : existingGroupKey ?? (isPdfFilePath(path) ? "secondary" : resolveAutoOpenGroupKey(groupKey));
    if (resolvedGroupKey === "secondary" && !firstPreview) {
      setSplitViewEnabled(true);
    }
    const group = getEditorGroup(resolvedGroupKey);
    if (firstPreview) {
      // Not a selection: it never makes the pane's latest selection stale.
      return sendOpenRequest({ id: ++nextOpenRequestId, path, group: resolvedGroupKey, firstPreview: true });
    }
    if (group.key === "secondary") {
      cancelPendingFirstPreview();
      delete group.automaticPreviewPath;
    }
    // The same selection still being read: that read answers this one too.
    const latest = latestOpen.get(resolvedGroupKey);
    if (latest && latest.path === path && !latest.background && state.pendingOpenRequests.includes(latest)) {
      if (position) latest.position = position;
      return true;
    }
    // Only the most recent foreground selection may put a file into this
    // pane. A slower read a paper edit shares (showTab set) carries on in the
    // background for its model.
    state.pendingOpenRequests = state.pendingOpenRequests.filter(request => {
      if (request.group !== resolvedGroupKey || request.background || request.firstPreview) return true;
      if (request.showTab === undefined) return false;
      request.background = true;
      return true;
    });
    const request: OpenRequest = {
      id: ++nextOpenRequestId, path, group: resolvedGroupKey, position,
      wasOpen: group.openTabs.includes(path),
    };
    latestOpen.set(resolvedGroupKey, request);
    if (state.pendingReveal?.group === resolvedGroupKey && state.pendingReveal.path !== path) {
      state.pendingReveal = null;
    }
    // Turning Live off reads the saved PDF of the paper it showed again.
    const restoreSavedPdf = force && group.viewer.getUnbuiltPdfPath() === path;
    if (group.currentFilePath === path && group.viewer.getViewerMode() !== "unsupported" && !restoreSavedPdf) {
      if (!position) return false;
      addOpenTab(group, path, position);
      deps.editorTabs.render(group);
      return true;
    }
    // Closed buffers can miss watcher updates. Open tabs already have the
    // current model, including any edits that have yet to reach the disk.
    if (existingGroupKey && monacoModels.has(path) && group.editor) {
      activateOpen(group, request, () => {
        const entry = monacoModels.get(path);
        if (entry) applyFileContent(group, path, entry, position);
      });
      return true;
    }
    return sendOpenRequest(request);
  };

  const requestOpenFile = (path: string, groupKey: EditorGroupKey, force = false, position?: TabPosition) =>
    openInPane(path, groupKey, force, position, false);

  // `showTab` false: only the model is wanted (a paper edit in an unopened
  // file); a tab appears only if a selection of that file shares the read.
  const requestOpenFileInBackground = (path: string, group: EditorGroupKey, showTab = true) => {
    if (monacoModels.has(path)) return false;
    const pending = state.pendingOpenRequests.find((entry) => entry.path === path && !entry.firstPreview);
    if (pending) {
      pending.showTab = pending.showTab || showTab;
      return true;
    }
    return sendOpenRequest({ id: ++nextOpenRequestId, path, group, background: true, showTab });
  };

  const captureFormatTarget = (): FormatTarget | null => {
    const group = getActiveGroup();
    const path = group.currentFilePath;
    const entry = path ? monacoModels.get(path) : null;
    if (!path || !entry || !isTexFilePath(path)) return null;
    const content = entry.model.getValue();
    const version = entry.model.getVersionId?.();
    const owner = () => Object.values(editorGroups).find((g) => g.currentFilePath === path)
      ?? Object.values(editorGroups).find((g) => g.openTabs.includes(path));
    const canEdit = () => monacoModels.get(path) === entry && Boolean(owner())
      && !contentConflicts.has(path)
      && !Object.values(editorGroups).some((g) => g.isComposing && g.currentFilePath === path);
    const matchesSnapshot = (revision: number | undefined, text: string) =>
      canEdit() && (revision === undefined ? entry.model.getValue() === text : entry.model.getVersionId?.() === revision);
    const isCurrent = () => matchesSnapshot(version, content);
    return {
      path, content, isCurrent,
      apply: async (formatted) => {
        const target = owner();
        if (!target || !isCurrent()) return false;
        applyFormattedContent(target, path, formatted, { updateSaved: false });
        if (!dirtyFiles.has(path)) return true;
        if (deps.collab?.isBound(path)) return deps.collab.flush();
        const formattedVersion = entry.model.getVersionId?.();
        return savePathContent(
          path, entry.model.getValue(undefined, true), 8000, undefined,
          () => matchesSnapshot(formattedVersion, formatted),
        );
      },
    };
  };

  const saveCurrentFileInternal = () => {
    const activeGroup = getActiveGroup();
    const activePath = activeGroup.currentFilePath;
    // Saving by hand brings in an Axiom edit that waits for a typing pause.
    if (activePath) heldSaves.get(activePath)?.();
    if (!activePath || !activeGroup.editor || !monacoModels.has(activePath)) {
      const message = activePath
        ? "This file format cannot be edited."
        : "No files have been selected to save.";
      deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
      return Promise.resolve(false);
    }
    if (deps.collab?.isBound(activePath)) {
      return deps.collab.flush();
    }
    const editor = activeGroup.editor as { getValue: () => string };
    const entry = monacoModels.get(activePath);
    const content = entry && (entry.plainText || entry.savedContent.charCodeAt(0) === 0xfeff)
      ? entry.model.getValue(undefined, true) : editor.getValue();
    if (contentConflicts.has(activePath)) {
      refuseConflictedSave(activePath);
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
      }, () => resolve(false));
    });
  };

  // One pass at a time: autosave, the retry timer and Retry can all ask at
  // once. A request during a pass gets one more pass after it, which sees
  // what changed meanwhile.
  // `auto`: autosave and its retries. They never end an IME composition and
  // leave a held file waiting; Save, Build, History and Git do neither.
  let saveDirtyRun: Promise<boolean> | null = null;
  let saveDirtyAgain: Promise<boolean> | null = null;
  let saveDirtyAgainAuto = true;
  const saveDirtyFiles = (options: { auto?: boolean } = {}): Promise<boolean> => {
    const auto = options.auto === true;
    if (!saveDirtyRun) {
      saveDirtyRun = saveDirtyFilesOnce(auto).finally(() => {
        saveDirtyRun = null;
      });
      return saveDirtyRun;
    }
    if (!auto) saveDirtyAgainAuto = false;
    saveDirtyAgain ??= saveDirtyRun
      .catch(() => false)
      .then(() => {
        saveDirtyAgain = null;
        const again = saveDirtyAgainAuto;
        saveDirtyAgainAuto = true;
        return saveDirtyFiles({ auto: again });
      });
    return saveDirtyAgain;
  };

  const saveDirtyFilesOnce = async (auto = false) => {
    if (!auto) {
      for (const release of Array.from(heldSaves.values())) release();
    }
    const allDirty = Array.from(dirtyFiles).filter((path) => monacoModels.has(path));
    const boundDirty = allDirty.filter((path) => deps.collab?.isBound(path));
    const dirtyPaths = allDirty.filter((path) => !deps.collab?.isBound(path));
    if (dirtyPaths.length === 0) {
      return boundDirty.length ? deps.collab!.flush() : true;
    }
    // A file in an edit conflict waits for the user; the others still save.
    const conflicted = dirtyPaths.filter((path) => contentConflicts.has(path));
    const activePath = getActiveGroup().currentFilePath;
    const ordered = dirtyPaths.filter((path) => !contentConflicts.has(path) && !heldSaves.has(path)).sort((a, b) => {
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
        return entry.model.getValue(undefined, true);
      }
      const owner = Object.values(editorGroups).find((group) => group.currentFilePath === path);
      if (!owner?.editor) {
        return null;
      }
      const editor = owner.editor as { getValue?: () => string };
      return editor.getValue?.() ?? null;
    };
    const composingOwner = (path: string) =>
      Object.values(editorGroups).find((group) => group.currentFilePath === path && group.isComposing);
    // False: the composition's model was replaced (a folder change), and
    // this buffer is no longer one to save.
    const waitForCompositionIfNeeded = (path: string) =>
      new Promise<boolean>((resolve) => {
        const owner = composingOwner(path);
        if (!owner) {
          resolve(true);
          return;
        }
        if (!auto) {
          scheduleAfterComposition(owner, () => resolve(true), () => resolve(false));
          return;
        }
        // Autosave waits for the composition to end by itself: ending it
        // (scheduleAfterComposition blurs the input) would commit a
        // half-converted word and take the caret away mid-sentence.
        const check = () => {
          if (composingOwner(path)) window.setTimeout(check, 100);
          else resolve(true);
        };
        window.setTimeout(check, 100);
      });
    for (const path of ordered) {
      if (!dirtyFiles.has(path)) {
        continue;
      }
      if (!(await waitForCompositionIfNeeded(path))) {
        continue;
      }
      // An Axiom edit may have started waiting on this file meanwhile.
      if (heldSaves.has(path) || contentConflicts.has(path)) {
        continue;
      }
      const content = readBuffer(path);
      if (content === null) {
        reportSaveError(`Unable to retrieve content to save: ${path}`, path);
        return false;
      }
      try {
        await savePathContent(path, content);
      } catch (error) {
        reportSaveError(saveFailureMessage(error), path);
        return false;
      }
    }
    if (conflicted.length > 0) {
      // Autosave leaves a file with open conflict choices alone, silently.
      if (!auto) conflicted.forEach(refuseConflictedSave);
      return false;
    }
    if (boundDirty.length) return deps.collab!.flush();
    return true;
  };

  const getSaveStatus = (): SaveStatus => {
    // A file that is clean again (undone, reverted) has nothing left to save.
    for (const path of Array.from(saveErrors.keys())) {
      if (!dirtyFiles.has(path)) saveErrors.delete(path);
    }
    if (saveErrors.size === 0 && saveRetryTimer !== null) {
      window.clearTimeout(saveRetryTimer);
      saveRetryTimer = null;
      saveRetryDelayMs = 0;
    }
    const dirtyPaths = Array.from(dirtyFiles).filter((path) => monacoModels.has(path));
    const failed = Array.from(saveErrors.entries());
    // A file with open conflict choices counts as unsaved, not as failed: the
    // bar is its notice (a save by hand records why it cannot, above).
    if (failed.length > 0) {
      const [path, message] = failed[0];
      return { kind: "error", message, path, count: failed.length };
    }
    if (state.pendingSave) {
      return { kind: "saving", path: state.pendingSave.path };
    }
    if (dirtyPaths.length > 0) {
      return { kind: "dirty", count: dirtyPaths.length };
    }
    return { kind: "saved", savedAt: lastSavedAt };
  };

  // ---- Axiom edits that wait for a typing pause (outside-edits.ts) ----
  const holdSaves = (path: string, release: () => void) => {
    heldSaves.set(path, release);
    // A save already sent may come back refused against Axiom's text; that
    // is expected while the edit waits, not something to report.
    saveErrors.delete(path);
    notifySaveStatusChange();
  };
  const unholdSaves = (path: string) => {
    if (heldSaves.delete(path)) notifySaveStatusChange();
  };
  const lastTypedAt = (path: string) => {
    const entry = monacoModels.get(path);
    return entry ? typing.get(entry.model)?.at ?? null : null;
  };
  // The new disk text of `path` as ranged edits onto the buffer: null when it
  // touches the unsaved typing (the conflict choices would be needed).
  const rebaseOntoBuffer = (path: string, content: string) => {
    const entry = monacoModels.get(path);
    if (!entry) return null;
    const mine = entry.model.getValue();
    return rebaseHunks(
      inModelForm(entry.model, mine, entry.savedContent ?? ""),
      mine,
      inModelForm(entry.model, mine, content),
    );
  };
  const mergesCleanly = (path: string, content: string) =>
    !contentConflicts.has(path) && rebaseOntoBuffer(path, content) !== null;
  // Whether applying `content` now would change the text under the person's
  // fingers: they typed in this file within `withinMs`, and the change either
  // overlaps their unsaved typing or lands in the paragraph they are typing
  // in (blank-line delimited, around the last keystroke).
  const disturbsTyping = (path: string, content: string, withinMs: number) => {
    const entry = monacoModels.get(path);
    if (!entry || contentConflicts.has(path)) return false;
    const typed = typing.get(entry.model);
    if (!typed || now() - typed.at >= withinMs) return false;
    const hunks = rebaseOntoBuffer(path, content);
    if (!hunks) return true;
    if (typed.offset === null) return false;
    const text = entry.model.getValue();
    const [start, end] = paragraphAround(text, Math.min(typed.offset, text.length));
    return hunks.some((hunk) => hunk.start <= end && hunk.end >= start);
  };

  const clearAutoSaveTimer = () => {
    if (state.autoSaveTimer) {
      window.clearTimeout(state.autoSaveTimer);
      state.autoSaveTimer = null;
    }
    state.autoSavePending = false;
  };

  const scheduleAutoSave = () => {
    // Check if any group (not just the active one) has dirty files. Files
    // bound to a collaboration session are written by that session.
    const hasDirty = Array.from(dirtyFiles).some((path) => !deps.collab?.isBound(path));
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
      saveDirtyFiles({ auto: true }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        reportSaveError(message);
      });
    }, 400);
  };

  const handleOpenFileResult = (payload: {
    path: string;
    openRequestId?: number;
    fileIdentity?: string;
    content?: string;
    error?: string;
    kind?: "text" | "image" | "pdf" | "unsupported";
    buildPreview?: "previous" | "built";
    languageId?: "plaintext";
    data?: string;
    mimeType?: string;
    livePreview?: { generation: number; documentEpoch: number };
  }): boolean => {
    // Handle non-file-open message types before consuming pending requests.
    const type = (payload as any).type;
    if (type === "searchResult") {
      deps.search.handleSearchUpdate(payload as any);
      return false;
    }
    if (type === "env:checkResult") {
      deps.settings.updateEnvStatus((payload as any).command, (payload as any).available);
      return false;
    }
    if (type === "env:installResult") {
      const { target, success, message } = payload as any;
      console.log(`Install result for ${target}: ${success} - ${message}`);
      if (!success) {
        console.warn(`Environment install failed for ${target}: ${message}`);
      }
      return false;
    }
    if (!payload.path) return false;
    let pendingEntry: OpenRequest | null = null;
    if (payload.openRequestId !== undefined) {
      const index = state.pendingOpenRequests.findIndex(
        (entry) => entry.id === payload.openRequestId && entry.path === payload.path
      );
      if (index < 0) return false;
      [pendingEntry] = state.pendingOpenRequests.splice(index, 1);
      if (!pendingEntry.background && !pendingEntry.firstPreview && !isCurrentOpen(pendingEntry)) {
        // Superseded. A read a paper edit shares (showTab set) still makes
        // its model, as a background read.
        if (pendingEntry.showTab === undefined) return false;
        pendingEntry.background = true;
      }
    } else {
      // An older internal sender (no request ID) answers a selection of the
      // same file still waiting, as before request IDs: nothing is left
      // pending for it (requestInitialOpen waits on pending selections).
      state.pendingOpenRequests = state.pendingOpenRequests.filter((entry) =>
        entry.path !== payload.path || entry.background || entry.firstPreview);
    }
    let targetGroupKey: EditorGroupKey = pendingEntry?.group ?? getActiveEditorGroupKey();
    // Main owns text classification. Older internal senders provide content
    // without a kind (new files, settings, imported documents).
    const kind = payload.kind ??
      (isPdfFilePath(payload.path)
        ? "pdf"
        : isImageFilePath(payload.path)
        ? "image"
        : typeof payload.content === "string"
        ? "text"
        : "unsupported");
    const path = kind === "text" ? payload.fileIdentity || payload.path : payload.path;
    if (!pendingEntry) {
      if (kind === "pdf") {
        if (payload.buildPreview) {
          // A build can finish while either editor pane is active.
          const active = getActiveGroup();
          targetGroupKey = active.viewer.getViewerMode() === "pdf"
            ? active.key
            : active.key === "primary" ? "secondary" : "primary";
        } else {
          targetGroupKey = "secondary";
        }
        if (targetGroupKey === "secondary") setSplitViewEnabled(true);
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
    if (pendingEntry?.firstPreview) {
      if (!canShowFirstPreview(targetGroup, path)) return false;
      replaceFirstPreview(targetGroup, path);
      setSplitViewEnabled(true);
      // A Build can truncate or remove the disk file between listing the
      // workspace and reading it. Live needs only the document's PDF path.
      if (payload.error || !payload.data) {
        applyViewerFile(targetGroup, path, "unbuilt-pdf");
        return true;
      }
      applyViewerFile(targetGroup, path, "pdf", payload.data, payload.mimeType, undefined, true);
      return true;
    }
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
      return true;
    }
    if (pendingEntry?.background) {
      if (kind !== "text") {
        deps.updateIssues(1, "The live preview source is not editable.", "error", [
          { severity: "error", message: "The live preview source is not editable." },
        ]);
        return true;
      }
      const entry = monacoModels.get(path) ??
        ensureModelEntry(path, payload.content ?? "", payload.content ?? "", payload.languageId === "plaintext");
      if (!entry) {
        deps.updateFallback("Editor is not ready.");
        return true;
      }
      if (pendingEntry.showTab !== false) {
        addOpenTab(targetGroup, path);
        deps.editorTabs.render(targetGroup);
      }
      return true;
    }
    if (pendingEntry?.showTab !== undefined && kind === "text" && !monacoModels.has(path)) {
      // A paper edit waits on this read for the model (loadWorkspaceTextModel):
      // a composition deferring the swap below does not hold the model back.
      ensureModelEntry(path, payload.content ?? "", payload.content ?? "", payload.languageId === "plaintext");
    }
    if (payload.buildPreview === "previous" && targetGroup.currentFilePath === path &&
        targetGroup.viewer.getViewerMode() === "pdf") return true;
    const position = pendingEntry?.position;
    activateOpen(targetGroup, pendingEntry, () => {
      if (state.pendingReveal?.path === payload.path && state.pendingReveal.group === targetGroupKey) {
        state.pendingReveal.path = path;
      }
      if (kind === "image" || kind === "pdf") {
        // A file opened by hand is no longer the automatic preview.
        delete targetGroup.automaticPreviewPath;
        const liveOnly = kind === "pdf" && !payload.data && deps.isLivePaper(path);
        applyViewerFile(targetGroup, path, liveOnly ? "unbuilt-pdf" : kind, payload.data, payload.mimeType, position);
      } else if (kind === "unsupported") {
        applyUnsupportedFile(targetGroup, path, position);
      } else {
        const cached = pendingEntry && findGroupKeyByPath(path) ? monacoModels.get(path) : null;
        const content = payload.content ?? "";
        const entry = cached ?? ensureModelEntry(path, content, content, payload.languageId === "plaintext");
        applyFileContent(targetGroup, path, entry, position);
        if (entry && !cached) setEditorLanguage(targetGroup, path);
      }
    });
    return true;
  };

  const handleSaveResult = (payload: {
    path: string;
    ok: boolean;
    busy?: boolean;
    error?: string;
    content?: string;
    savedContent?: string;
    formatError?: string;
  }) => {
    let submittedContent: string | null = null;
    const saveErrorMessage = payload.error ?? "Saving failed.";
    if (state.pendingSave) {
      if (state.pendingSave.path === payload.path) {
        if (payload.busy) {
          state.pendingSave.resolve(false);
        } else if (payload.ok) {
          submittedContent = state.pendingSave.content;
          state.pendingSave.resolve(true);
        } else {
          state.pendingSave.reject(saveErrorMessage);
        }
        state.pendingSave = null;
        notifySaveStatusChange();
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
      reportSaveError(saveErrorMessage, payload.path);
      return;
    }
    lastSavedAt = Date.now();
    saveErrors.delete(payload.path);
    diskChangeQuietUntil.delete(payload.path);
    if (!hasFailedDirtyFile()) {
      saveRetryDelayMs = 0;
      if (saveRetryTimer !== null) {
        window.clearTimeout(saveRetryTimer);
        saveRetryTimer = null;
      }
    }
    notifySaveStatusChange();
    if (lastSaveErrorMessage !== null && !hasFailedDirtyFile()) {
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
    const resolvedSavedContent = payload.savedContent ?? payload.content ?? submittedContent;
    const modelContent = entry?.model.getValue(undefined, true);
    const applyReturnedFormat = typeof payload.content === "string" &&
      (modelContent === undefined || modelContent === submittedContent || modelContent === payload.content);
    if (resolvedSavedContent !== null && entry) {
      updateDirtyState(payload.path, modelContent, resolvedSavedContent);
    }
    const groupsWithFile = Object.values(editorGroups).filter(
      (group) => group.currentFilePath === payload.path
    );
    if (groupsWithFile.length > 0) {
      groupsWithFile.forEach((group) => {
        if (resolvedSavedContent !== null) {
          group.currentFileSavedContent = resolvedSavedContent;
        }
        if (applyReturnedFormat) {
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
      scheduleAutoSave();
    }
    if (payload.formatError) {
      deps.buildOps.handleSaveFormatError(payload.formatError);
    }
  };

  return {
    applyFormattedContent,
    cancelPendingFirstPreview,
    openFirstPreview: (path: string, saved: boolean) => {
      const group = editorGroups.secondary;
      if (!canShowFirstPreview(group, path)) return;
      if (saved) openInPane(path, group.key, true, undefined, true);
      else {
        replaceFirstPreview(group, path);
        setSplitViewEnabled(true);
        applyViewerFile(group, path, "unbuilt-pdf");
      }
    },
    requestOpenFile,
    requestOpenFileInBackground,
    captureFormatTarget,
    saveCurrentFile,
    saveDirtyFiles,
    scheduleAutoSave,
    getSaveStatus,
    handleOpenFileResult,
    clearOpenRequests,
    handleSaveResult,
    clearContentConflicts,
    holdSaves,
    unholdSaves,
    lastTypedAt,
    mergesCleanly,
    disturbsTyping,
  };
};
