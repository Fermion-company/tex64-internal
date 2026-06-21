import { uiText } from "./i18n.js";
import type { EditorGroupState, EditorGroupKey } from "./editor-session.js";

type MonacoLike = {
  Range?: new (
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number
  ) => unknown;
  editor?: {
    [key: string]: unknown;
    MouseTargetType?: { GUTTER_GLYPH_MARGIN?: number };
    TrackedRangeStickiness?: { NeverGrowsWhenTypingAtEdges?: number };
  };
};

type PositionLike = { lineNumber: number; column: number };
type StoredRange = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

type CodeComment = StoredRange & {
  id: string;
  filePath: string;
  text: string;
  createdAt: number;
  updatedAt: number;
};

type ModelLike = {
  getLineCount?: () => number;
  getLineMaxColumn?: (lineNumber: number) => number;
  getDecorationRange?: (decorationId: string) => StoredRange | null;
  deltaDecorations?: (oldDecorations: string[], newDecorations: unknown[]) => string[];
};

type EditorLike = {
  addAction?: (action: {
    id: string;
    label: string;
    keybindings?: number[];
    contextMenuGroupId?: string;
    contextMenuOrder?: number;
    run: () => unknown;
  }) => void;
  deltaDecorations?: (oldDecorations: string[], newDecorations: unknown[]) => string[];
  getModel?: () => ModelLike | null;
  getPosition?: () => PositionLike | null;
  getSelection?: () => (StoredRange & { isEmpty?: () => boolean }) | null;
  onDidChangeModel?: (listener: () => void) => { dispose?: () => void } | void;
  onDidChangeModelContent?: (listener: () => void) => { dispose?: () => void } | void;
  onDidFocusEditorWidget?: (listener: () => void) => { dispose?: () => void } | void;
  onMouseDown?: (listener: (event: unknown) => void) => { dispose?: () => void } | void;
  focus?: () => void;
};

type GroupCommentState = {
  group: EditorGroupState;
  path: string | null;
  model: ModelLike | null;
  records: Array<{ commentId: string; decorationId: string }>;
  refreshRafId: number | null;
};

const STORAGE_PREFIX = "tex64.codeComments.v1:";
const MAX_COMMENT_CHARS = 4000;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const createCommentId = () =>
  `comment_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

const normalizeCommentText = (text: string) =>
  text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

const sanitizeStoredRange = (value: unknown): StoredRange | null => {
  const entry = value as Partial<StoredRange> | null;
  if (!entry) {
    return null;
  }
  const { startLineNumber, startColumn, endLineNumber, endColumn } = entry;
  if (
    !isFiniteNumber(startLineNumber) ||
    !isFiniteNumber(startColumn) ||
    !isFiniteNumber(endLineNumber) ||
    !isFiniteNumber(endColumn)
  ) {
    return null;
  }
  return {
    startLineNumber: Math.max(1, Math.floor(startLineNumber)),
    startColumn: Math.max(1, Math.floor(startColumn)),
    endLineNumber: Math.max(1, Math.floor(endLineNumber)),
    endColumn: Math.max(1, Math.floor(endColumn)),
  };
};

const sanitizeComment = (value: unknown): CodeComment | null => {
  const entry = value as Partial<CodeComment> | null;
  const range = sanitizeStoredRange(entry);
  if (!entry || !range || typeof entry.id !== "string" || typeof entry.filePath !== "string") {
    return null;
  }
  const text = typeof entry.text === "string" ? normalizeCommentText(entry.text) : "";
  if (!text) {
    return null;
  }
  return {
    ...range,
    id: entry.id,
    filePath: entry.filePath,
    text: text.slice(0, MAX_COMMENT_CHARS),
    createdAt: isFiniteNumber(entry.createdAt) ? entry.createdAt : Date.now(),
    updatedAt: isFiniteNumber(entry.updatedAt) ? entry.updatedAt : Date.now(),
  };
};

const escapeMarkdownText = (text: string) =>
  text
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#+\-.!|>])/g, "\\$1")
    .replace(/\n/g, "  \n");

const comparePosition = (a: PositionLike, b: PositionLike) => {
  if (a.lineNumber !== b.lineNumber) {
    return a.lineNumber - b.lineNumber;
  }
  return a.column - b.column;
};

const rangeStart = (range: StoredRange): PositionLike => ({
  lineNumber: range.startLineNumber,
  column: range.startColumn,
});

const rangeEnd = (range: StoredRange): PositionLike => ({
  lineNumber: range.endLineNumber,
  column: range.endColumn,
});

const rangeContainsPosition = (range: StoredRange, position: PositionLike) =>
  comparePosition(position, rangeStart(range)) >= 0 && comparePosition(position, rangeEnd(range)) <= 0;

const rangesIntersect = (a: StoredRange, b: StoredRange) =>
  comparePosition(rangeStart(a), rangeEnd(b)) <= 0 && comparePosition(rangeStart(b), rangeEnd(a)) <= 0;

const lineIntersectsRange = (range: StoredRange, lineNumber: number) =>
  lineNumber >= range.startLineNumber && lineNumber <= range.endLineNumber;

const clampRangeToModel = (range: StoredRange, model: ModelLike | null): StoredRange => {
  const lineCount = Math.max(1, model?.getLineCount?.() ?? range.endLineNumber);
  const startLineNumber = clamp(Math.floor(range.startLineNumber), 1, lineCount);
  const endLineNumber = clamp(Math.floor(range.endLineNumber), startLineNumber, lineCount);
  const startMaxColumn = Math.max(1, model?.getLineMaxColumn?.(startLineNumber) ?? range.startColumn);
  const endMaxColumn = Math.max(1, model?.getLineMaxColumn?.(endLineNumber) ?? range.endColumn);
  const startColumn = clamp(Math.floor(range.startColumn), 1, startMaxColumn);
  const endColumn = clamp(Math.floor(range.endColumn), 1, endMaxColumn);
  return {
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn: endLineNumber === startLineNumber ? Math.max(startColumn, endColumn) : endColumn,
  };
};

const getSelectionRange = (editor: EditorLike, model: ModelLike | null): StoredRange | null => {
  const selection = editor.getSelection?.();
  if (
    selection &&
    isFiniteNumber(selection.startLineNumber) &&
    isFiniteNumber(selection.startColumn) &&
    isFiniteNumber(selection.endLineNumber) &&
    isFiniteNumber(selection.endColumn)
  ) {
    const isEmpty =
      typeof selection.isEmpty === "function"
        ? selection.isEmpty()
        : selection.startLineNumber === selection.endLineNumber &&
          selection.startColumn === selection.endColumn;
    if (!isEmpty) {
      return clampRangeToModel(selection, model);
    }
  }

  const position = editor.getPosition?.();
  if (!position) {
    return null;
  }
  const lineNumber = clamp(position.lineNumber, 1, Math.max(1, model?.getLineCount?.() ?? position.lineNumber));
  const endColumn = Math.max(1, model?.getLineMaxColumn?.(lineNumber) ?? position.column);
  return {
    startLineNumber: lineNumber,
    startColumn: 1,
    endLineNumber: lineNumber,
    endColumn,
  };
};

const createHoverMessage = (comment: CodeComment) => ({
  value: `${uiText("**Comment**", "**コメント**")}\n\n${escapeMarkdownText(comment.text)}`,
});

const createCodeCommentDialog = (options: {
  title: string;
  initialText: string;
  submitLabel: string;
}): Promise<string | null> =>
  new Promise((resolve) => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modal = document.createElement("div");
    modal.className = "modal code-comment-modal is-open";
    modal.setAttribute("aria-hidden", "false");

    const card = document.createElement("section");
    card.className = "modal-card code-comment-modal-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");

    const title = document.createElement("h2");
    title.className = "modal-title code-comment-modal-title";
    title.textContent = options.title;

    const textarea = document.createElement("textarea");
    textarea.className = "modal-input code-comment-modal-input";
    textarea.value = options.initialText;
    textarea.maxLength = MAX_COMMENT_CHARS;
    textarea.placeholder = uiText("Write a comment", "コメントを入力");
    textarea.setAttribute("aria-label", uiText("Comment", "コメント"));

    const help = document.createElement("div");
    help.className = "modal-help code-comment-modal-help";

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "panel-button code-comment-modal-cancel";
    cancelButton.textContent = uiText("Cancel", "キャンセル");

    const submitButton = document.createElement("button");
    submitButton.type = "button";
    submitButton.className = "panel-button code-comment-modal-submit";
    submitButton.textContent = options.submitLabel;

    actions.append(cancelButton, submitButton);
    card.append(title, textarea, help, actions);
    modal.append(card);
    document.body.append(modal);

    let settled = false;

    const close = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener("keydown", onKeyDown, true);
      modal.remove();
      previousFocus?.focus?.();
      resolve(value);
    };

    const submit = () => {
      const text = normalizeCommentText(textarea.value);
      if (!text) {
        help.textContent = uiText("Comment cannot be empty.", "コメントは空にできません。");
        help.classList.add("is-error");
        textarea.focus();
        return;
      }
      close(text.slice(0, MAX_COMMENT_CHARS));
    };

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(null);
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        submit();
      }
    }

    modal.addEventListener("mousedown", (event) => {
      if (event.target === modal) {
        close(null);
      }
    });
    cancelButton.addEventListener("click", () => close(null));
    submitButton.addEventListener("click", submit);
    textarea.addEventListener("input", () => {
      help.textContent = "";
      help.classList.remove("is-error");
    });
    window.addEventListener("keydown", onKeyDown, true);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.select();
    });
  });

export const createCodeCommentManager = (
  monaco: MonacoLike,
  deps: { getWorkspaceRoot: () => string | null }
) => {
  let loadedStorageKey: string | null = null;
  let cachedComments: CodeComment[] = [];
  const groupStates = new Map<EditorGroupKey, GroupCommentState>();

  const getStorageKey = () => `${STORAGE_PREFIX}${deps.getWorkspaceRoot() ?? "global"}`;

  const loadComments = () => {
    const storageKey = getStorageKey();
    if (storageKey === loadedStorageKey) {
      return cachedComments;
    }
    loadedStorageKey = storageKey;
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      cachedComments = Array.isArray(parsed)
        ? parsed.map(sanitizeComment).filter((comment): comment is CodeComment => Boolean(comment))
        : [];
    } catch {
      cachedComments = [];
    }
    return cachedComments;
  };

  const saveComments = (comments: CodeComment[]) => {
    cachedComments = comments;
    loadedStorageKey = getStorageKey();
    try {
      if (comments.length === 0) {
        localStorage.removeItem(loadedStorageKey);
      } else {
        localStorage.setItem(loadedStorageKey, JSON.stringify(comments));
      }
    } catch {
      // Storage failures should not break editing.
    }
  };

  const getState = (group: EditorGroupState) => {
    const existing = groupStates.get(group.key);
    if (existing) {
      return existing;
    }
    const state: GroupCommentState = {
      group,
      path: null,
      model: null,
      records: [],
      refreshRafId: null,
    };
    groupStates.set(group.key, state);
    return state;
  };

  const syncRangesFromDecorations = (state: GroupCommentState) => {
    if (!state.path || !state.model || state.records.length === 0) {
      return;
    }
    const comments = loadComments();
    let changed = false;
    for (const record of state.records) {
      const range = state.model.getDecorationRange?.(record.decorationId);
      const comment = comments.find(
        (entry) => entry.id === record.commentId && entry.filePath === state.path
      );
      if (!range || !comment) {
        continue;
      }
      const nextRange = clampRangeToModel(range, state.model);
      if (
        comment.startLineNumber !== nextRange.startLineNumber ||
        comment.startColumn !== nextRange.startColumn ||
        comment.endLineNumber !== nextRange.endLineNumber ||
        comment.endColumn !== nextRange.endColumn
      ) {
        comment.startLineNumber = nextRange.startLineNumber;
        comment.startColumn = nextRange.startColumn;
        comment.endLineNumber = nextRange.endLineNumber;
        comment.endColumn = nextRange.endColumn;
        comment.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) {
      saveComments(comments);
    }
  };

  const clearDecorations = (group: EditorGroupState, state: GroupCommentState) => {
    const ids = state.records.map((record) => record.decorationId);
    if (ids.length === 0) {
      return;
    }
    const editor = group.editor as EditorLike | null;
    if (state.model?.deltaDecorations) {
      state.model.deltaDecorations(ids, []);
    } else {
      editor?.deltaDecorations?.(ids, []);
    }
    state.records = [];
  };

  const refreshGroup = (group: EditorGroupState) => {
    const state = getState(group);
    state.refreshRafId = null;
    syncRangesFromDecorations(state);
    clearDecorations(group, state);

    const editor = group.editor as EditorLike | null;
    const model = editor?.getModel?.() ?? null;
    const path = group.currentFilePath;
    state.path = path;
    state.model = model;
    if (!editor || !model || !path) {
      return;
    }

    const comments = loadComments().filter((comment) => comment.filePath === path);
    if (comments.length === 0 || !monaco.Range || !editor.deltaDecorations) {
      return;
    }

    const stickiness = monaco.editor?.TrackedRangeStickiness?.NeverGrowsWhenTypingAtEdges;
    const decorations = comments.map((comment) => {
      const range = clampRangeToModel(comment, model);
      const hoverMessage = createHoverMessage(comment);
      return {
        range: new monaco.Range(
          range.startLineNumber,
          range.startColumn,
          range.endLineNumber,
          range.endColumn
        ),
        options: {
          className: "code-comment-range",
          glyphMarginClassName: "code-comment-glyph",
          glyphMarginHoverMessage: hoverMessage,
          hoverMessage,
          linesDecorationsClassName: "code-comment-line",
          stickiness,
        },
      };
    });
    const ids = editor.deltaDecorations([], decorations);
    state.records = ids.map((decorationId, index) => ({
      decorationId,
      commentId: comments[index].id,
    }));
  };

  const scheduleRefreshGroup = (group: EditorGroupState) => {
    const state = getState(group);
    if (state.refreshRafId !== null) {
      window.cancelAnimationFrame(state.refreshRafId);
    }
    state.refreshRafId = window.requestAnimationFrame(() => refreshGroup(group));
  };

  const refreshGroupsForPath = (filePath: string) => {
    groupStates.forEach((state) => {
      if (state.group.currentFilePath === filePath || state.path === filePath) {
        scheduleRefreshGroup(state.group);
      }
    });
  };

  const findCommentAtCurrentContext = (group: EditorGroupState) => {
    const editor = group.editor as EditorLike | null;
    const model = editor?.getModel?.() ?? null;
    const path = group.currentFilePath;
    if (!editor || !path) {
      return null;
    }
    const selectionRange = getSelectionRange(editor, model);
    const position = editor.getPosition?.();
    return (
      loadComments().find((comment) => {
        if (comment.filePath !== path) {
          return false;
        }
        if (selectionRange && rangesIntersect(comment, selectionRange)) {
          return true;
        }
        return Boolean(position && rangeContainsPosition(comment, position));
      }) ?? null
    );
  };

  const editComment = async (group: EditorGroupState, comment: CodeComment) => {
    const nextText = await createCodeCommentDialog({
      title: uiText("Edit comment", "コメントを編集"),
      initialText: comment.text,
      submitLabel: uiText("Save", "保存"),
    });
    if (nextText === null) {
      return;
    }
    const comments = loadComments();
    const target = comments.find((entry) => entry.id === comment.id);
    if (!target) {
      return;
    }
    target.text = nextText;
    target.updatedAt = Date.now();
    saveComments(comments);
    refreshGroupsForPath(target.filePath);
    (group.editor as EditorLike | null)?.focus?.();
  };

  const addOrEditComment = async (group: EditorGroupState) => {
    const editor = group.editor as EditorLike | null;
    const model = editor?.getModel?.() ?? null;
    const filePath = group.currentFilePath;
    if (!editor || !model || !filePath) {
      return;
    }

    const existing = findCommentAtCurrentContext(group);
    if (existing) {
      await editComment(group, existing);
      return;
    }

    const range = getSelectionRange(editor, model);
    if (!range) {
      return;
    }
    const text = await createCodeCommentDialog({
      title: uiText("Add comment", "コメントを追加"),
      initialText: "",
      submitLabel: uiText("Add", "追加"),
    });
    if (text === null) {
      return;
    }
    const now = Date.now();
    const comments = loadComments();
    comments.push({
      ...range,
      id: createCommentId(),
      filePath,
      text,
      createdAt: now,
      updatedAt: now,
    });
    saveComments(comments);
    refreshGroupsForPath(filePath);
    editor.focus?.();
  };

  const deleteCommentAtCursor = (group: EditorGroupState) => {
    const comment = findCommentAtCurrentContext(group);
    if (!comment) {
      return;
    }
    const confirmed = window.confirm(uiText("Delete this comment?", "このコメントを削除しますか？"));
    if (!confirmed) {
      return;
    }
    saveComments(loadComments().filter((entry) => entry.id !== comment.id));
    refreshGroupsForPath(comment.filePath);
    (group.editor as EditorLike | null)?.focus?.();
  };

  const editCommentAtCursor = async (group: EditorGroupState) => {
    const comment = findCommentAtCurrentContext(group);
    if (comment) {
      await editComment(group, comment);
    }
  };

  const editCommentAtLine = async (group: EditorGroupState, lineNumber: number) => {
    const path = group.currentFilePath;
    if (!path) {
      return;
    }
    const comment = loadComments().find(
      (entry) => entry.filePath === path && lineIntersectsRange(entry, lineNumber)
    );
    if (comment) {
      await editComment(group, comment);
    }
  };

  const attachToEditor = (group: EditorGroupState) => {
    const editor = group.editor as EditorLike | null;
    if (!editor) {
      return;
    }
    getState(group);
    editor.onDidChangeModelContent?.(() => {
      const state = getState(group);
      syncRangesFromDecorations(state);
    });
    editor.onDidChangeModel?.(() => {
      scheduleRefreshGroup(group);
    });
    editor.onDidFocusEditorWidget?.(() => {
      scheduleRefreshGroup(group);
    });
    editor.onMouseDown?.((event: unknown) => {
      const target = (event as {
        target?: {
          type?: number;
          position?: PositionLike | null;
          range?: { startLineNumber?: number } | null;
          element?: Element | null;
        };
        event?: { preventDefault?: () => void; stopPropagation?: () => void };
      })?.target;
      const glyphTargetType = monaco.editor?.MouseTargetType?.GUTTER_GLYPH_MARGIN;
      const isGlyphTarget =
        target?.type === glyphTargetType ||
        Boolean(target?.element?.classList?.contains("code-comment-glyph"));
      if (!isGlyphTarget) {
        return;
      }
      const lineNumber = target?.position?.lineNumber ?? target?.range?.startLineNumber;
      if (!isFiniteNumber(lineNumber)) {
        return;
      }
      event && (event as { event?: { preventDefault?: () => void; stopPropagation?: () => void } }).event?.preventDefault?.();
      event && (event as { event?: { preventDefault?: () => void; stopPropagation?: () => void } }).event?.stopPropagation?.();
      void editCommentAtLine(group, lineNumber);
    });

    editor.addAction?.({
      id: `tex64.comments.add.${group.key}`,
      label: uiText("Add comment", "コメントを追加"),
      contextMenuGroupId: "9_comments",
      contextMenuOrder: 1,
      run: () => addOrEditComment(group),
    });
    editor.addAction?.({
      id: `tex64.comments.edit.${group.key}`,
      label: uiText("Edit comment", "コメントを編集"),
      contextMenuGroupId: "9_comments",
      contextMenuOrder: 2,
      run: () => editCommentAtCursor(group),
    });
    editor.addAction?.({
      id: `tex64.comments.delete.${group.key}`,
      label: uiText("Delete comment", "コメントを削除"),
      contextMenuGroupId: "9_comments",
      contextMenuOrder: 3,
      run: () => deleteCommentAtCursor(group),
    });
    scheduleRefreshGroup(group);
  };

  return { attachToEditor, refreshGroup };
};
