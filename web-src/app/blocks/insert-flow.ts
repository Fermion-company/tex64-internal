import { formatSnippetForInsert } from "./format.js";
import type { BlockApplyMode, BlockMode } from "../types.js";
import type { DetectedBlockSnapshot, PendingBlockApply } from "./types.js";
import type { AppContext } from "../context.js";

type BlockDraft = { snippet: string; content: unknown };

type BlockInsertDeps = {
  getBlockDraft: () => BlockDraft | null;
  getDetectedBlockSnapshot: () => DetectedBlockSnapshot | null;
  getActiveGroup: () => {
    editor?: {
      executeEdits?: (
        source: string,
        edits: { range: unknown; text: string; forceMoveMarkers: boolean }[]
      ) => void;
      focus?: () => void;
      getPosition?: () => { lineNumber: number; column: number } | null;
      getSelection?: () => {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      } | null;
      getModel?: () => {
        getValue: () => string;
        getPositionAt?: (offset: number) => { lineNumber: number; column: number };
        getOffsetAt?: (pos: { lineNumber: number; column: number }) => number;
        getLineContent?: (lineNumber: number) => string;
        getVersionId?: () => number;
      };
    } | null;
    currentFilePath?: string | null;
  };
  getMonacoApi: () => Record<string, unknown> | null;
  updateIssues: (
    count: number,
    summary: string,
    status: "success" | "error" | "info",
    issues: { severity: "error" | "warning"; message: string }[]
  ) => void;
  updateFallback: (message: string) => void;
  getEditorAlignEnvEnabled: () => boolean;
  requestFormatCurrentFile: (source: string) => void;
  postToNative?: (
    payload: { type: string; [key: string]: unknown },
    silent?: boolean
  ) => boolean;
  getIsE2E: () => boolean;
  getMathInputValue: () => string;
  getBlockMode?: () => BlockMode;
  resetBlockSession: (options?: { applyMode?: BlockApplyMode }) => void;
  getPendingBlockApply: () => PendingBlockApply | null;
  setPendingBlockApply: (payload: PendingBlockApply | null) => void;
  setCurrentBlockDraft: (draft: BlockDraft | null) => void;
  getBlockPreviewActive: () => boolean;
  setBlockPreviewActive: (active: boolean) => void;
  showDiffModal: (original: string, modified: string, lineOffset?: number) => void;
  refreshDetectedBlock: (
    position: { lineNumber: number; column: number } | null,
    options?: { force?: boolean }
  ) => void;
};

type BlockEditor = NonNullable<ReturnType<BlockInsertDeps["getActiveGroup"]>["editor"]>;
type EditorModelWithPosition = {
  getValue: () => string;
  getPositionAt: (offset: number) => { lineNumber: number; column: number };
  getLineCount?: () => number;
  getOffsetAt?: (pos: { lineNumber: number; column: number }) => number;
};

export type BlockInsertApi = {
  triggerInsert: () => void;
  applyBlockInsert: (payload?: PendingBlockApply) => void;
  applyPendingFromDiffModal: () => void;
  clearPending: () => void;
  resetPreviewActive: () => void;
};

export const initBlockInsertFlow = (
  context: AppContext,
  deps: BlockInsertDeps
): BlockInsertApi => {
  const { blockInsertButton } = context.dom;
  const countLines = (text: string) => {
    if (!text) return 1;
    return text.split(/\r?\n/).length;
  };
  const countLineBreaks = (text: string) => text.match(/\r?\n/g)?.length ?? 0;
  const buildDiffPreviewContext = (
    model: {
      getValue: () => string;
      getPositionAt: (offset: number) => { lineNumber: number; column: number };
      getLineCount?: () => number;
    },
    startOffset: number,
    endOffset: number,
    replacement: string,
    contextLineCount = 3
  ) => {
    const originalText = model.getValue();
    const totalLines =
      typeof model.getLineCount === "function" ? model.getLineCount() : countLines(originalText);
    const startPos = model.getPositionAt(startOffset);
    const endPos = model.getPositionAt(endOffset);
    let startLine = startPos.lineNumber;
    let endLine = endPos.lineNumber;
    if (endOffset > startOffset && endPos.column === 1) {
      endLine = Math.max(startLine, endLine - 1);
    }
    const contextStartLine = Math.max(1, startLine - contextLineCount);
    const contextEndLine = Math.min(totalLines, endLine + contextLineCount);
    const originalLines = originalText.split(/\r?\n/);
    const originalSlice = originalLines.slice(contextStartLine - 1, contextEndLine).join("\n");
    const originalSegment = originalText.slice(startOffset, endOffset);
    const lineDelta = countLineBreaks(replacement) - countLineBreaks(originalSegment);
    const modifiedText =
      originalText.slice(0, startOffset) + replacement + originalText.slice(endOffset);
    const modifiedTotalLines = totalLines + lineDelta;
    const modifiedEndLine = Math.min(modifiedTotalLines, contextEndLine + lineDelta);
    const modifiedLines = modifiedText.split(/\r?\n/);
    const modifiedSlice = modifiedLines
      .slice(contextStartLine - 1, Math.max(contextStartLine, modifiedEndLine))
      .join("\n");
    return {
      original: originalSlice,
      modified: modifiedSlice,
      lineOffset: contextStartLine - 1,
    };
  };

  const normalizeSelection = (selection: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  }) => {
    const startsAfter =
      selection.startLineNumber > selection.endLineNumber ||
      (selection.startLineNumber === selection.endLineNumber &&
        selection.startColumn > selection.endColumn);
    if (!startsAfter) {
      return selection;
    }
    return {
      startLineNumber: selection.endLineNumber,
      startColumn: selection.endColumn,
      endLineNumber: selection.startLineNumber,
      endColumn: selection.startColumn,
    };
  };

  const resolveEmptyLineInsertRange = (editor: BlockEditor | null | undefined) => {
    if (!editor?.getSelection || !editor.getModel) {
      return null;
    }
    const selection = editor.getSelection();
    const model = editor.getModel();
    if (!selection || !model?.getLineContent) {
      return null;
    }
    const normalized = normalizeSelection(selection);
    const hasSelection =
      normalized.startLineNumber !== normalized.endLineNumber ||
      normalized.startColumn !== normalized.endColumn;
    if (!hasSelection) {
      return null;
    }
    const lineContent = model.getLineContent(normalized.startLineNumber);
    if (lineContent.trim().length > 0) {
      return null;
    }
    const isLineSelection =
      normalized.startColumn === 1 &&
      normalized.endColumn === 1 &&
      normalized.endLineNumber === normalized.startLineNumber + 1;
    if (!isLineSelection) {
      return null;
    }
    return normalized;
  };

  const applyBlockInsert = (payload?: PendingBlockApply) => {
    const applyPayload = payload ?? deps.getPendingBlockApply();
    if (!applyPayload && !deps.getBlockPreviewActive()) {
      return;
    }
    const draft = applyPayload?.draft ?? deps.getBlockDraft();
    if (!draft) {
      return;
    }
    const activeGroup = deps.getActiveGroup();
    if (!activeGroup.editor || !deps.getMonacoApi()) {
      deps.updateFallback("エディタの準備が完了していません。");
      return;
    }
    if (!activeGroup.currentFilePath || !activeGroup.currentFilePath.endsWith(".tex")) {
      deps.updateIssues(1, "ブロックは .tex ファイルでのみ挿入できます。", "error", [
        { severity: "error", message: "ブロックは .tex ファイルでのみ挿入できます。" },
      ]);
      return;
    }

    const editor = activeGroup.editor;
    const monacoApiAny = deps.getMonacoApi() as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };

    let range: unknown;
    const model = editor.getModel?.();
    const blockMode = deps.getBlockMode?.() ?? "insert";
    const mode: BlockApplyMode =
      applyPayload?.mode ?? (blockMode === "edit" ? "detected" : "new");

    let snippet = draft.snippet;
    let insertPosition: { lineNumber: number; column: number } | null = null;
    let insertRange = applyPayload
      ? applyPayload.insertRange ?? null
      : mode === "new"
        ? resolveEmptyLineInsertRange(editor)
        : null;
    if (mode === "detected") {
      const snapshot = applyPayload?.detectedSnapshot ?? deps.getDetectedBlockSnapshot();
      if (!snapshot || !model?.getPositionAt) {
        return;
      }
      const content = model.getValue();
      const slice = content.slice(snapshot.start, snapshot.end);
      if (slice !== snapshot.snippet) {
        return;
      }
      const startPos = model.getPositionAt(snapshot.start);
      const endPos = model.getPositionAt(snapshot.end);
      range = new monacoApiAny.Range(
        startPos.lineNumber,
        startPos.column,
        endPos.lineNumber,
        endPos.column
      );
    } else {
      if (insertRange) {
        insertPosition = {
          lineNumber: insertRange.startLineNumber,
          column: insertRange.startColumn,
        };
        range = new monacoApiAny.Range(
          insertRange.startLineNumber,
          insertRange.startColumn,
          insertRange.endLineNumber,
          insertRange.endColumn
        );
      } else {
        insertPosition = applyPayload?.insertPosition ?? editor.getPosition?.() ?? null;
        const insertAt = insertPosition ?? { lineNumber: 1, column: 1 };
        range = new monacoApiAny.Range(
          insertAt.lineNumber,
          insertAt.column,
          insertAt.lineNumber,
          insertAt.column
        );
      }
      if (!applyPayload) {
        snippet = formatSnippetForInsert(snippet, model, insertPosition, {
          alignEnv: deps.getEditorAlignEnvEnabled(),
        });
      }
    }

    editor.executeEdits?.("block-insert", [
      {
        range,
        text: snippet,
        forceMoveMarkers: true,
      },
    ]);
    editor.focus?.();
    if (typeof deps.postToNative === "function") {
      deps.postToNative(
        {
          type: "blocks:save",
          entry: {
            file: activeGroup.currentFilePath ?? null,
            snippet,
            content: draft.content ?? null,
            mode,
            createdAt: new Date().toISOString(),
          },
        },
        true
      );
    }
    deps.setPendingBlockApply(null);
    deps.setCurrentBlockDraft(null);
    deps.resetBlockSession({ applyMode: mode });
  };

  const triggerInsert = () => {
    const activeGroup = deps.getActiveGroup();
    if (!activeGroup.editor) {
      return;
    }
    const editorForDetect = activeGroup.editor;
    const blockMode = deps.getBlockMode?.() ?? "insert";
    const detectPosition = editorForDetect.getPosition?.() ?? null;
    const model = editorForDetect.getModel?.();
    let detectedSnapshot =
      blockMode === "edit" ? deps.getDetectedBlockSnapshot() : null;
    if (blockMode === "edit") {
      const shouldResync =
        !!detectedSnapshot &&
        !!detectPosition &&
        !!model?.getOffsetAt &&
        (() => {
          const offset = model.getOffsetAt(detectPosition);
          if (offset < detectedSnapshot.start || offset >= detectedSnapshot.end) {
            return true;
          }
          if (
            typeof model.getVersionId === "function" &&
            detectedSnapshot.modelVersion !== model.getVersionId()
          ) {
            return true;
          }
          return false;
        })();
      if (detectPosition && shouldResync) {
        deps.refreshDetectedBlock(detectPosition, { force: true });
        detectedSnapshot = deps.getDetectedBlockSnapshot();
      }
    }
    const draft = deps.getBlockDraft();
    if (!draft) return;

    let mode: BlockApplyMode = "new";
    if (blockMode === "edit") {
      if (!detectedSnapshot) {
        return;
      }
      mode = "detected";
    }
    let insertPosition = mode === "new" ? editorForDetect.getPosition?.() ?? null : null;
    const insertRange =
      mode === "new" ? resolveEmptyLineInsertRange(editorForDetect) : null;
    if (insertRange) {
      insertPosition = {
        lineNumber: insertRange.startLineNumber,
        column: insertRange.startColumn,
      };
    }
    const formattedSnippet =
      mode === "new"
        ? formatSnippetForInsert(draft.snippet, editorForDetect.getModel?.(), insertPosition, {
            alignEnv: deps.getEditorAlignEnvEnabled(),
          })
        : draft.snippet;
    const resolvedDraft = { ...draft, snippet: formattedSnippet };

    if (deps.getIsE2E()) {
      (window as {
        __tex64LastDraft?: {
          formula: string;
          snippet: string | null;
          detectedSnippet: string | null;
        };
      }).__tex64LastDraft = {
        formula: deps.getMathInputValue(),
        snippet: resolvedDraft.snippet,
        detectedSnippet: detectedSnapshot?.snippet ?? null,
      };
    }

    const applyPayload: PendingBlockApply = {
      mode,
      draft: resolvedDraft,
      detectedSnapshot: mode === "detected" ? detectedSnapshot : null,
      insertPosition,
      insertRange,
    };
    deps.setPendingBlockApply(applyPayload);
    deps.setCurrentBlockDraft(resolvedDraft);

    const editorModel = editorForDetect.getModel?.();
    const hasPositionAt = (model: {
      getValue?: () => string;
      getPositionAt?: (offset: number) => { lineNumber: number; column: number };
    }): model is EditorModelWithPosition =>
      typeof model.getValue === "function" && typeof model.getPositionAt === "function";
    if (editorModel && hasPositionAt(editorModel)) {
      const model = editorModel as EditorModelWithPosition;
      let startOffset = 0;
      let endOffset = 0;
      if (mode === "detected" && detectedSnapshot) {
        startOffset = detectedSnapshot.start;
        endOffset = detectedSnapshot.end;
      } else if (insertRange && model.getOffsetAt) {
        startOffset = model.getOffsetAt({
          lineNumber: insertRange.startLineNumber,
          column: insertRange.startColumn,
        });
        endOffset = model.getOffsetAt({
          lineNumber: insertRange.endLineNumber,
          column: insertRange.endColumn,
        });
      } else if (insertPosition && model.getOffsetAt) {
        const offset = model.getOffsetAt(insertPosition);
        startOffset = offset;
        endOffset = offset;
      }
      const diffContext = buildDiffPreviewContext(
        model,
        startOffset,
        endOffset,
        resolvedDraft.snippet
      );
      deps.showDiffModal(diffContext.original, diffContext.modified, diffContext.lineOffset);
      return;
    }

    const originalSnippet =
      mode === "detected" ? detectedSnapshot?.snippet ?? "" : "";
    const fallbackOffset = insertRange
      ? Math.max(0, insertRange.startLineNumber - 1)
      : insertPosition
        ? Math.max(0, insertPosition.lineNumber - 1)
        : 0;
    deps.showDiffModal(originalSnippet, resolvedDraft.snippet, fallbackOffset);
  };

  const applyPendingFromDiffModal = () => {
    deps.setBlockPreviewActive(true);
    applyBlockInsert(deps.getPendingBlockApply() ?? undefined);
    deps.setBlockPreviewActive(false);
    deps.setPendingBlockApply(null);
    deps.setCurrentBlockDraft(null);
    deps.requestFormatCurrentFile("blockInsert");
  };

  const clearPending = () => {
    deps.setPendingBlockApply(null);
    deps.setCurrentBlockDraft(null);
  };

  const resetPreviewActive = () => {
    deps.setBlockPreviewActive(false);
  };

  if (blockInsertButton instanceof HTMLElement) {
    blockInsertButton.addEventListener("click", () => {
      triggerInsert();
    });
  }

  return {
    triggerInsert,
    applyBlockInsert,
    applyPendingFromDiffModal,
    clearPending,
    resetPreviewActive,
  };
};
