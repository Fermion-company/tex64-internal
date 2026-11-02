import { uiText } from "./i18n.js";
import type { EditorGroupState, EditorGroupKey } from "./editor-session.js";
import { collabSession } from "./collab/session.js";

// Comments live in <workspace>/.tex64/comments.json (shared with whoever gets
// the folder). During a collaboration session the session Y.Map `comments`
// is the record instead: positions are relative positions in the shared text
// (they follow edits on every side), replies are a Y.Array, and the main
// process writes the JSON file from it. Older localStorage comments migrate
// into the file once, after the first successful write.

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

type CommentReply = { author: string; text: string; createdAt: number };

type CodeComment = StoredRange & {
  id: string;
  filePath: string;
  text: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  resolved: boolean;
  replies: CommentReply[];
};

type CollabCommentDeps = {
  sessionDoc: () => any | null;
  sessionText: (path: string) => any | null;
  getVendor: () => { Y: any } | null;
  onSessionDoc: (listener: (doc: any | null) => void) => () => void;
};

type ModelLike = {
  getLineCount?: () => number;
  getLineMaxColumn?: (lineNumber: number) => number;
  getOffsetAt?: (position: PositionLike) => number;
  getPositionAt?: (offset: number) => PositionLike;
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
    precondition?: string;
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

const sanitizeReply = (value: unknown): CommentReply | null => {
  const entry = value as Partial<CommentReply> | null;
  const text = entry && typeof entry.text === "string" ? normalizeCommentText(entry.text) : "";
  if (!text) return null;
  return {
    author: typeof entry?.author === "string" ? entry.author.slice(0, 80) : "",
    text: text.slice(0, MAX_COMMENT_CHARS),
    createdAt: isFiniteNumber(entry?.createdAt) ? entry!.createdAt! : Date.now(),
  };
};

const sanitizeComment = (value: unknown): CodeComment | null => {
  const entry = value as (Partial<CodeComment> & { range?: StoredRange }) | null;
  const range = sanitizeStoredRange(entry?.range ?? entry);
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
    author: typeof entry.author === "string" ? entry.author.slice(0, 80) : "",
    createdAt: isFiniteNumber(entry.createdAt) ? entry.createdAt : Date.now(),
    updatedAt: isFiniteNumber(entry.updatedAt) ? entry.updatedAt : Date.now(),
    resolved: entry.resolved === true,
    replies: Array.isArray(entry.replies) ? entry.replies.map(sanitizeReply).filter((reply): reply is CommentReply => Boolean(reply)) : [],
  };
};

// The JSON file keeps the range as one object.
const toStoredComment = (comment: CodeComment) => ({
  id: comment.id,
  filePath: comment.filePath,
  range: {
    startLineNumber: comment.startLineNumber,
    startColumn: comment.startColumn,
    endLineNumber: comment.endLineNumber,
    endColumn: comment.endColumn,
  },
  text: comment.text,
  author: comment.author,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  resolved: comment.resolved,
  replies: comment.replies,
});

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

const createHoverMessage = (comment: CodeComment) => {
  const heading = comment.resolved ? uiText("**Comment** · resolved", "**コメント** · 解決済み") : uiText("**Comment**", "**コメント**");
  const author = comment.author ? ` — ${escapeMarkdownText(comment.author)}` : "";
  const lines = [`${heading}${author}`, "", escapeMarkdownText(comment.text)];
  for (const reply of comment.replies) {
    lines.push("", `↳ ${reply.author ? `**${escapeMarkdownText(reply.author)}** ` : ""}${escapeMarkdownText(reply.text)}`);
  }
  return { value: lines.join("\n") };
};

const createCodeCommentDialog = (options: {
  title: string;
  initialText: string;
  submitLabel: string;
  quote?: string;
  placeholder?: string;
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

    const quote = document.createElement("blockquote");
    quote.className = "code-comment-modal-quote";
    quote.textContent = options.quote ?? "";
    quote.hidden = !options.quote;
    quote.dataset.noI18n = "true";

    const textarea = document.createElement("textarea");
    textarea.className = "modal-input code-comment-modal-input";
    textarea.value = options.initialText;
    textarea.maxLength = MAX_COMMENT_CHARS;
    textarea.placeholder = options.placeholder ?? uiText("Write a comment", "コメントを入力");
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
    card.append(title, quote, textarea, help, actions);
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
  deps: {
    getWorkspaceRoot: () => string | null;
    collab?: CollabCommentDeps;
    getAuthorName?: () => string;
  }
) => {
  let loadedRoot: string | null = null;
  let cachedComments: CodeComment[] = [];
  let loadGeneration = 0;
  let saveTimer: number | null = null;
  const groupStates = new Map<EditorGroupKey, GroupCommentState>();
  const contextSyncers = new Map<EditorGroupKey, () => void>();

  const legacyStorageKey = () => `${STORAGE_PREFIX}${deps.getWorkspaceRoot() ?? "global"}`;
  const sessionMap = () => deps.collab?.sessionDoc()?.getMap("comments") ?? null;
  const inSession = () => Boolean(sessionMap());
  const authorName = () => collabSession.selfParticipant()?.name || deps.getAuthorName?.() || "";

  const refreshAllGroups = () => {
    groupStates.forEach((state) => scheduleRefreshGroup(state.group));
  };

  // Workspace file (outside a session). Loads once per root; the in-memory
  // list is what the editor reads synchronously.
  const loadFromWorkspace = async () => {
    const root = deps.getWorkspaceRoot();
    const generation = ++loadGeneration;
    let comments: CodeComment[] = [];
    let missing = false;
    if (root && collabSession.available) {
      try {
        const result = await collabSession.call("comments:load");
        comments = (result.comments as unknown[]).map(sanitizeComment).filter((comment): comment is CodeComment => Boolean(comment));
        missing = result.missing === true;
      } catch {
        comments = [];
      }
    }
    if (generation !== loadGeneration || deps.getWorkspaceRoot() !== root) return;
    let migrated: CodeComment[] = [];
    try {
      const legacy = JSON.parse(localStorage.getItem(legacyStorageKey()) ?? "[]");
      if (Array.isArray(legacy)) migrated = legacy.map(sanitizeComment).filter((comment): comment is CodeComment => Boolean(comment));
    } catch {}
    cachedComments = comments;
    loadedRoot = root;
    if (migrated.length && (missing || comments.length === 0) && root) {
      cachedComments = migrated;
      void persistWorkspace(cachedComments).then((ok) => {
        if (ok) {
          try { localStorage.removeItem(legacyStorageKey()); } catch {}
        }
      });
    }
    refreshAllGroups();
  };

  const persistWorkspace = async (comments: CodeComment[]) => {
    if (!collabSession.available || !deps.getWorkspaceRoot()) return false;
    try {
      await collabSession.call("comments:save", { comments: comments.map(toStoredComment) });
      return true;
    } catch {
      return false;
    }
  };

  const loadComments = () => {
    const map = sessionMap();
    if (map) return readSessionComments(map);
    const root = deps.getWorkspaceRoot();
    if (root !== loadedRoot) {
      loadedRoot = root;
      cachedComments = [];
      void loadFromWorkspace();
    }
    return cachedComments;
  };

  const saveComments = (comments: CodeComment[]) => {
    if (inSession()) return;
    cachedComments = comments;
    loadedRoot = deps.getWorkspaceRoot();
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void persistWorkspace(cachedComments);
    }, 250);
  };

  // ---- session store (Y.Map id → Y.Map comment, replies: Y.Array)
  const Y = () => deps.collab?.getVendor()?.Y ?? null;

  const resolveSessionRange = (entry: any): StoredRange | null => {
    const YLib = Y();
    const filePath = entry.get("filePath");
    const ytext = deps.collab?.sessionText(filePath);
    const anchor = entry.get("anchor");
    const head = entry.get("head");
    if (YLib && ytext && anchor instanceof Uint8Array && head instanceof Uint8Array) {
      try {
        const start = YLib.createAbsolutePositionFromRelativePosition(YLib.decodeRelativePosition(anchor), ytext.doc);
        const end = YLib.createAbsolutePositionFromRelativePosition(YLib.decodeRelativePosition(head), ytext.doc);
        if (start && end) {
          const content: string = ytext.toString();
          const position = (offset: number) => {
            const clamped = Math.max(0, Math.min(content.length, offset));
            const before = content.slice(0, clamped);
            const lastBreak = before.lastIndexOf("\n");
            return { lineNumber: before.split("\n").length, column: clamped - lastBreak };
          };
          const a = position(Math.min(start.index, end.index));
          const b = position(Math.max(start.index, end.index));
          return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
        }
      } catch {}
    }
    return sanitizeStoredRange(entry.get("range"));
  };

  const readSessionComments = (map: any): CodeComment[] => {
    const comments: CodeComment[] = [];
    map.forEach((entry: any, id: string) => {
      if (!entry || typeof entry.get !== "function") return;
      const range = resolveSessionRange(entry);
      if (!range) return;
      const replies = entry.get("replies");
      const comment = sanitizeComment({
        ...range,
        id,
        filePath: entry.get("filePath"),
        text: entry.get("text"),
        author: entry.get("author"),
        createdAt: entry.get("createdAt"),
        updatedAt: entry.get("updatedAt"),
        resolved: entry.get("resolved"),
        replies: replies && typeof replies.toArray === "function" ? replies.toArray() : [],
      });
      if (comment) comments.push(comment);
    });
    return comments;
  };

  const sessionRelativePositions = (filePath: string, range: StoredRange, model: ModelLike | null) => {
    const YLib = Y();
    const ytext = deps.collab?.sessionText(filePath);
    if (!YLib || !ytext || !model?.getOffsetAt) return null;
    const start = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
    const end = model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
    return {
      anchor: YLib.encodeRelativePosition(YLib.createRelativePositionFromTypeIndex(ytext, start)),
      head: YLib.encodeRelativePosition(YLib.createRelativePositionFromTypeIndex(ytext, end, -1)),
    };
  };

  const sessionAdd = (comment: CodeComment, model: ModelLike | null) => {
    const map = sessionMap();
    const YLib = Y();
    if (!map || !YLib) return false;
    const entry = new YLib.Map();
    const replies = new YLib.Array();
    map.doc.transact(() => {
      entry.set("filePath", comment.filePath);
      entry.set("text", comment.text);
      entry.set("author", comment.author);
      entry.set("createdAt", comment.createdAt);
      entry.set("updatedAt", comment.updatedAt);
      entry.set("resolved", comment.resolved);
      entry.set("range", { startLineNumber: comment.startLineNumber, startColumn: comment.startColumn, endLineNumber: comment.endLineNumber, endColumn: comment.endColumn });
      entry.set("replies", replies);
      const positions = sessionRelativePositions(comment.filePath, comment, model);
      if (positions) {
        entry.set("anchor", positions.anchor);
        entry.set("head", positions.head);
      }
      map.set(comment.id, entry);
    }, "comments");
    return true;
  };

  const sessionUpdate = (id: string, patch: { text?: string; resolved?: boolean; reply?: CommentReply }) => {
    const map = sessionMap();
    const entry = map?.get(id);
    if (!map || !entry) return false;
    map.doc.transact(() => {
      if (typeof patch.text === "string") entry.set("text", patch.text);
      if (typeof patch.resolved === "boolean") entry.set("resolved", patch.resolved);
      if (patch.reply) {
        let replies = entry.get("replies");
        if (!replies || typeof replies.push !== "function") {
          replies = new (Y()!.Array)();
          entry.set("replies", replies);
        }
        replies.push([patch.reply]);
      }
      entry.set("updatedAt", Date.now());
    }, "comments");
    return true;
  };

  const sessionRemove = (id: string) => {
    const map = sessionMap();
    if (!map) return false;
    map.doc.transact(() => map.delete(id), "comments");
    return true;
  };

  // Session comments change under us (another participant, or our own write
  // echoed): redraw. The file store reloads when the session ends.
  let observedDoc: any = null;
  const observeSession = (doc: any | null) => {
    if (observedDoc === doc) return;
    if (observedDoc) {
      try { observedDoc.getMap("comments").unobserveDeep(onSessionCommentsChanged); } catch {}
    }
    observedDoc = doc;
    if (doc) doc.getMap("comments").observeDeep(onSessionCommentsChanged);
    else {
      loadedRoot = null;
      cachedComments = [];
    }
    refreshAllGroups();
  };
  const onSessionCommentsChanged = () => refreshAllGroups();
  deps.collab?.onSessionDoc(observeSession);
  collabSession.onMessage("collab:comments", () => { if (!inSession()) { loadedRoot = null; refreshAllGroups(); } });

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
    // In a session the relative positions in the shared text move by
    // themselves; writing absolute ranges back from every participant would
    // make them fight.
    if (inSession()) return;
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
          className: comment.resolved ? "code-comment-range is-resolved" : "code-comment-range",
          glyphMarginClassName: comment.resolved ? "code-comment-glyph is-resolved" : "code-comment-glyph",
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
    contextSyncers.get(group.key)?.();
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
    if (inSession()) {
      sessionUpdate(comment.id, { text: nextText });
      refreshGroupsForPath(comment.filePath);
      (group.editor as EditorLike | null)?.focus?.();
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

  const replyToComment = async (group: EditorGroupState, comment: CodeComment) => {
    const text = await createCodeCommentDialog({
      title: uiText("Reply to comment", "コメントに返信"),
      initialText: "",
      submitLabel: uiText("Reply", "返信"),
      quote: `${comment.author ? `${comment.author}: ` : ""}${comment.text}`,
      placeholder: uiText("Write a reply", "返信を入力"),
    });
    if (text === null) return;
    const reply: CommentReply = { author: authorName(), text, createdAt: Date.now() };
    if (inSession()) {
      sessionUpdate(comment.id, { reply });
    } else {
      const comments = loadComments();
      const target = comments.find((entry) => entry.id === comment.id);
      if (!target) return;
      target.replies = [...target.replies, reply];
      target.updatedAt = Date.now();
      saveComments(comments);
    }
    refreshGroupsForPath(comment.filePath);
    (group.editor as EditorLike | null)?.focus?.();
  };

  const toggleResolved = (group: EditorGroupState, comment: CodeComment) => {
    const resolved = !comment.resolved;
    if (inSession()) {
      sessionUpdate(comment.id, { resolved });
    } else {
      const comments = loadComments();
      const target = comments.find((entry) => entry.id === comment.id);
      if (!target) return;
      target.resolved = resolved;
      target.updatedAt = Date.now();
      saveComments(comments);
    }
    refreshGroupsForPath(comment.filePath);
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
    const comment: CodeComment = {
      ...range,
      id: createCommentId(),
      filePath,
      text,
      author: authorName(),
      createdAt: now,
      updatedAt: now,
      resolved: false,
      replies: [],
    };
    if (inSession()) {
      sessionAdd(comment, model);
    } else {
      const comments = loadComments();
      comments.push(comment);
      saveComments(comments);
    }
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
    if (inSession()) sessionRemove(comment.id);
    else saveComments(loadComments().filter((entry) => entry.id !== comment.id));
    refreshGroupsForPath(comment.filePath);
    (group.editor as EditorLike | null)?.focus?.();
  };

  const replyAtCursor = async (group: EditorGroupState) => {
    const comment = findCommentAtCurrentContext(group);
    if (comment) await replyToComment(group, comment);
  };

  const resolveAtCursor = (group: EditorGroupState) => {
    const comment = findCommentAtCurrentContext(group);
    if (comment) toggleResolved(group, comment);
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
    // Edit / reply / resolve / delete only make sense on a comment: the
    // context menu shows them when the cursor or selection touches one.
    const editorAny = editor as EditorLike & {
      createContextKey?: (key: string, value: boolean) => { set: (value: boolean) => void };
      onDidChangeCursorSelection?: (listener: () => void) => void;
    };
    const atComment = editorAny.createContextKey?.("tex64CommentAtCursor", false);
    const atResolved = editorAny.createContextKey?.("tex64CommentResolved", false);
    const syncAtComment = () => {
      const comment = findCommentAtCurrentContext(group);
      atComment?.set(Boolean(comment));
      atResolved?.set(Boolean(comment?.resolved));
    };
    editorAny.onDidChangeCursorSelection?.(() => queueMicrotask(syncAtComment));
    contextSyncers.set(group.key, syncAtComment);
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
      precondition: "tex64CommentAtCursor",
      run: () => editCommentAtCursor(group),
    });
    editor.addAction?.({
      id: `tex64.comments.reply.${group.key}`,
      label: uiText("Reply to comment", "コメントに返信"),
      contextMenuGroupId: "9_comments",
      contextMenuOrder: 3,
      precondition: "tex64CommentAtCursor",
      run: () => replyAtCursor(group),
    });
    editor.addAction?.({
      id: `tex64.comments.resolve.${group.key}`,
      label: uiText("Resolve comment", "コメントを解決"),
      contextMenuGroupId: "9_comments",
      contextMenuOrder: 4,
      precondition: "tex64CommentAtCursor && !tex64CommentResolved",
      run: () => resolveAtCursor(group),
    });
    editor.addAction?.({
      id: `tex64.comments.reopen.${group.key}`,
      label: uiText("Reopen comment", "コメントを再開"),
      contextMenuGroupId: "9_comments",
      contextMenuOrder: 4,
      precondition: "tex64CommentAtCursor && tex64CommentResolved",
      run: () => resolveAtCursor(group),
    });
    editor.addAction?.({
      id: `tex64.comments.delete.${group.key}`,
      label: uiText("Delete comment", "コメントを削除"),
      contextMenuGroupId: "9_comments",
      contextMenuOrder: 5,
      precondition: "tex64CommentAtCursor",
      run: () => deleteCommentAtCursor(group),
    });
    scheduleRefreshGroup(group);
  };

  return { attachToEditor, refreshGroup, listComments: () => loadComments().map(toStoredComment) };
};
