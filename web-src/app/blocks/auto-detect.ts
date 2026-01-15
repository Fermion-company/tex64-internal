import { createLatexBlockDetector } from "./detect.js";
import { getInnerContent, parseBlockContext } from "./context.js";
import type {
  BlockContext,
  DetectedBlockSnapshot,
  DetectedLatexBlock,
} from "./types.js";
import type { BlockEditMode, BlockType } from "../types.js";

type EditorModel = {
  getValue: () => string;
  getOffsetAt: (pos: { lineNumber: number; column: number }) => number;
  getPositionAt: (offset: number) => { lineNumber: number; column: number };
  getVersionId?: () => number;
};

type EditorLike = {
  getModel?: () => EditorModel;
  getSelection?: () => {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null;
  deltaDecorations?: (oldDecorations: string[], newDecorations: unknown[]) => string[];
};

type EditorGroup = { editor?: EditorLike | null };

type BlockDraft = { snippet: string; content: unknown };

type EditorSelection = NonNullable<ReturnType<EditorLike["getSelection"]>>;

type SelectionOffsets = {
  start: number;
  end: number;
  selection: EditorSelection;
};

type HighlightRange = { start: number; end: number } | null;

type DetectedCandidate = {
  detected: DetectedLatexBlock;
  snapshot: DetectedBlockSnapshot;
  context: BlockContext | null;
  mathInputValue: string;
  highlightRange: HighlightRange;
  cursorLineNumber?: number;
};

type BlockAutoDetectDeps = {
  envRegistry: {
    isEnvDisabled: (name: string) => boolean;
    isMathEnvName: (name: string) => boolean;
  };
  getActiveGroup: () => EditorGroup;
  getActiveBlockContext: () => BlockContext | null;
  setActiveBlockContext: (context: BlockContext | null) => void;
  getActiveBlockEditMode: () => BlockEditMode;
  setActiveBlockEditMode: (mode: BlockEditMode) => void;
  setActiveBlockType: (type: BlockType) => void;
  setActiveBlockOriginalSnippet: (snippet: string | null) => void;
  setDetectedBlockSnapshot: (snapshot: DetectedBlockSnapshot | null) => void;
  setCurrentBlockDraft: (draft: BlockDraft | null) => void;
  setAutoDetectedUi: (enabled: boolean, lineNumber?: number) => void;
  setMathInputValue: (value: string) => void;
};

export type BlockAutoDetectApi = {
  syncDetectedBlockAtPosition: (
    position: { lineNumber: number; column: number } | null | undefined,
    options?: { force?: boolean; allowTabSwitch?: boolean; ignoreSelection?: boolean }
  ) => DetectedLatexBlock | null;
  handleCursorPositionChange: (position: { lineNumber: number; column: number }) => void;
  activateDetectedBlock: () => void;
  clearDetectedBlockState: (options?: { force?: boolean; clearActive?: boolean }) => void;
};

export const initBlockAutoDetection = (
  deps: BlockAutoDetectDeps
): BlockAutoDetectApi => {
  let currentDetectedBlock: DetectedLatexBlock | null = null;
  let currentSelectionRange: { start: number; end: number } | null = null;
  let currentCandidate: DetectedCandidate | null = null;
  let blockDetectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let blockHighlightDecorations: string[] = [];

  const blockDetector = createLatexBlockDetector({
    isEnvDisabled: deps.envRegistry.isEnvDisabled,
    isMathEnvName: deps.envRegistry.isMathEnvName,
  });

  const shouldUpdateDetectedBlock = (
    detected: DetectedLatexBlock,
    selectionRange: { start: number; end: number } | null
  ) => {
    if (
      !currentDetectedBlock ||
      currentDetectedBlock.start !== detected.start ||
      currentDetectedBlock.end !== detected.end ||
      currentDetectedBlock.fullMatch !== detected.fullMatch
    ) {
      return true;
    }
    if (!currentSelectionRange && !selectionRange) {
      return false;
    }
    if (!currentSelectionRange || !selectionRange) {
      return true;
    }
    return (
      currentSelectionRange.start !== selectionRange.start ||
      currentSelectionRange.end !== selectionRange.end
    );
  };

  const highlightDetectedBlock = (
    start: number,
    end: number,
    context: BlockContext | null,
    cursorLineNumber?: number,
    highlightRange?: HighlightRange
  ) => {
    const activeGroup = deps.getActiveGroup();
    if (!activeGroup.editor || !activeGroup.editor.deltaDecorations) return;
    const model = activeGroup.editor.getModel?.();
    if (!model) return;
    let highlightStart = start;
    let highlightEnd = start;
    let showInline = false;
    if (context) {
      const innerStart = start + context.prefix.length;
      const innerEnd = end - context.suffix.length;
      if (innerEnd > innerStart) {
        const hasHighlightStart = typeof highlightRange?.start === "number";
        const hasHighlightEnd = typeof highlightRange?.end === "number";
        highlightStart =
          hasHighlightStart && highlightRange.start >= innerStart
            ? highlightRange.start
            : innerStart;
        highlightEnd =
          hasHighlightEnd && highlightRange.end <= innerEnd ? highlightRange.end : innerEnd;
        showInline = true;
      }
    }
    const startPos = model.getPositionAt(highlightStart);
    const endPos = model.getPositionAt(highlightEnd);
    const glyphLine = cursorLineNumber ?? startPos.lineNumber;
    const decorations: Array<{ range: unknown; options: Record<string, unknown> }> = [];
    if (showInline) {
      decorations.push({
        range: {
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
        },
        options: {
          inlineClassName: "detected-block-highlight",
        },
      });
    }
    decorations.push({
      range: {
        startLineNumber: glyphLine,
        startColumn: 1,
        endLineNumber: glyphLine,
        endColumn: 1,
      },
      options: {
        glyphMarginClassName: "detected-block-glyph",
      },
    });
    blockHighlightDecorations = activeGroup.editor.deltaDecorations(
      blockHighlightDecorations,
      decorations
    );
  };

  const clearBlockHighlight = () => {
    const activeGroup = deps.getActiveGroup();
    if (!activeGroup.editor || !activeGroup.editor.deltaDecorations) return;
    blockHighlightDecorations = activeGroup.editor.deltaDecorations(
      blockHighlightDecorations,
      []
    );
  };

  const normalizeSelection = (selection: EditorSelection) => {
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

  const resolveSelectionOffsets = (
    model: EditorModel,
    selection: EditorSelection | null | undefined
  ): SelectionOffsets | null => {
    if (!selection) {
      return null;
    }
    const normalized = normalizeSelection(selection);
    const start = model.getOffsetAt({
      lineNumber: normalized.startLineNumber,
      column: normalized.startColumn,
    });
    const end = model.getOffsetAt({
      lineNumber: normalized.endLineNumber,
      column: normalized.endColumn,
    });
    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
      selection: normalized,
    };
  };

  const applyDetectedBlock = (
    detected: DetectedLatexBlock,
    text: string,
    model: EditorModel,
    selectionOffsets: SelectionOffsets | null,
    force = false,
    allowTabSwitch = true,
    cursorLineNumber?: number,
    cursorOffset?: number
  ) => {
    const selectionRange = selectionOffsets
      ? { start: selectionOffsets.start, end: selectionOffsets.end }
      : null;
    if (!force && !shouldUpdateDetectedBlock(detected, selectionRange)) {
      return;
    }
    currentDetectedBlock = detected;
    currentSelectionRange = selectionRange;
    if (
      allowTabSwitch &&
      !document.querySelector('.panel[data-panel="blocks"].is-active')
    ) {
      const blocksTab = document.querySelector<HTMLButtonElement>('.tab[data-tab="blocks"]');
      blocksTab?.click();
    }
    const snippet = detected.fullMatch ?? text.slice(detected.start, detected.end);
    const context = snippet ? parseBlockContext(snippet) : null;
    const detectedInner = context
      ? getInnerContent(context, { trim: false })
      : detected.content;
    currentCandidate = {
      detected,
      snapshot: {
        type: detected.type,
        start: detected.start,
        end: detected.end,
        snippet,
        context,
        modelVersion: typeof model.getVersionId === "function" ? model.getVersionId() : 0,
      },
      context,
      mathInputValue: detectedInner,
      highlightRange: null,
      cursorLineNumber,
    };
    deps.setAutoDetectedUi(true, cursorLineNumber ?? model.getPositionAt(detected.start).lineNumber);
    if (deps.getActiveBlockEditMode() !== "detected") {
      highlightDetectedBlock(
        detected.start,
        detected.end,
        context,
        cursorLineNumber,
        currentCandidate.highlightRange
      );
    }
  };

  const activateDetectedBlock = () => {
    if (!currentCandidate) {
      return;
    }
    const activeGroup = deps.getActiveGroup();
    const model = activeGroup.editor?.getModel?.();
    if (!model) {
      return;
    }
    const { detected, snapshot, context, mathInputValue } = currentCandidate;
    const updatedSnapshot = {
      ...snapshot,
      modelVersion: typeof model.getVersionId === "function" ? model.getVersionId() : 0,
    };
    currentCandidate = { ...currentCandidate, snapshot: updatedSnapshot };
    deps.setActiveBlockType(detected.type);
    deps.setActiveBlockEditMode("detected");
    deps.setCurrentBlockDraft(null);
    deps.setActiveBlockOriginalSnippet(updatedSnapshot.snippet);
    deps.setActiveBlockContext(context);
    deps.setDetectedBlockSnapshot(updatedSnapshot);
    const startPos = model.getPositionAt(detected.start);
    deps.setAutoDetectedUi(true, startPos.lineNumber);
    deps.setMathInputValue(mathInputValue);
    highlightDetectedBlock(
      detected.start,
      detected.end,
      context,
      currentCandidate.cursorLineNumber ?? startPos.lineNumber,
      currentCandidate.highlightRange
    );
  };

  const clearDetectedBlockState = (options?: { force?: boolean; clearActive?: boolean }) => {
    if (!currentDetectedBlock && !options?.force) {
      return;
    }
    currentDetectedBlock = null;
    currentSelectionRange = null;
    currentCandidate = null;
    if (options?.clearActive) {
      deps.setDetectedBlockSnapshot(null);
      if (deps.getActiveBlockEditMode() === "detected") {
        deps.setActiveBlockEditMode("none");
        deps.setActiveBlockContext(null);
        deps.setActiveBlockOriginalSnippet(null);
      }
    }
    if (options?.clearActive || deps.getActiveBlockEditMode() !== "detected") {
      clearBlockHighlight();
    }
    deps.setAutoDetectedUi(false);
  };

  const syncDetectedBlockAtPosition: BlockAutoDetectApi["syncDetectedBlockAtPosition"] = (
    position,
    options
  ) => {
    const activeGroup = deps.getActiveGroup();
    if (!activeGroup.editor || !position) {
      return null;
    }
    const model = activeGroup.editor.getModel?.();
    if (!model) {
      return null;
    }
    const text = model.getValue();
    const selectionOffsets = options?.ignoreSelection
      ? null
      : resolveSelectionOffsets(model, activeGroup.editor.getSelection?.() ?? null);
    const offset = model.getOffsetAt(position);
    const detected = selectionOffsets
      ? blockDetector.detectLatexBlockInRange(text, selectionOffsets.start, selectionOffsets.end)
      : blockDetector.detectLatexBlockAtOffset(text, offset);
    const force = options?.force ?? false;
    const allowTabSwitch = options?.allowTabSwitch ?? false;
    if (detected) {
      applyDetectedBlock(
        detected,
        text,
        model,
        selectionOffsets,
        force,
        allowTabSwitch,
        selectionOffsets?.selection.startLineNumber ?? position?.lineNumber,
        offset
      );
      return detected;
    }
    clearDetectedBlockState();
    return null;
  };

  const handleCursorPositionChange: BlockAutoDetectApi["handleCursorPositionChange"] = (
    position
  ) => {
    const activeGroup = deps.getActiveGroup();
    if (!activeGroup.editor) return;
    if (blockDetectionDebounceTimer) {
      clearTimeout(blockDetectionDebounceTimer);
    }
    blockDetectionDebounceTimer = setTimeout(() => {
      syncDetectedBlockAtPosition(position, { allowTabSwitch: false });
    }, 150);
  };

  return {
    syncDetectedBlockAtPosition,
    handleCursorPositionChange,
    activateDetectedBlock,
    clearDetectedBlockState,
  };
};
