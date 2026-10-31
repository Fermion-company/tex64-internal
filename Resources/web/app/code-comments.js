import { uiText } from "./i18n.js";
import { collabSession } from "./collab/session.js";
const STORAGE_PREFIX = "tex64.codeComments.v1:";
const MAX_COMMENT_CHARS = 4000;
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const createCommentId = () => `comment_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const normalizeCommentText = (text) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
const sanitizeStoredRange = (value) => {
    const entry = value;
    if (!entry) {
        return null;
    }
    const { startLineNumber, startColumn, endLineNumber, endColumn } = entry;
    if (!isFiniteNumber(startLineNumber) ||
        !isFiniteNumber(startColumn) ||
        !isFiniteNumber(endLineNumber) ||
        !isFiniteNumber(endColumn)) {
        return null;
    }
    return {
        startLineNumber: Math.max(1, Math.floor(startLineNumber)),
        startColumn: Math.max(1, Math.floor(startColumn)),
        endLineNumber: Math.max(1, Math.floor(endLineNumber)),
        endColumn: Math.max(1, Math.floor(endColumn)),
    };
};
const sanitizeReply = (value) => {
    const entry = value;
    const text = entry && typeof entry.text === "string" ? normalizeCommentText(entry.text) : "";
    if (!text)
        return null;
    return {
        author: typeof (entry === null || entry === void 0 ? void 0 : entry.author) === "string" ? entry.author.slice(0, 80) : "",
        text: text.slice(0, MAX_COMMENT_CHARS),
        createdAt: isFiniteNumber(entry === null || entry === void 0 ? void 0 : entry.createdAt) ? entry.createdAt : Date.now(),
    };
};
const sanitizeComment = (value) => {
    var _a;
    const entry = value;
    const range = sanitizeStoredRange((_a = entry === null || entry === void 0 ? void 0 : entry.range) !== null && _a !== void 0 ? _a : entry);
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
        replies: Array.isArray(entry.replies) ? entry.replies.map(sanitizeReply).filter((reply) => Boolean(reply)) : [],
    };
};
// The JSON file keeps the range as one object.
const toStoredComment = (comment) => ({
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
const escapeMarkdownText = (text) => text
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#+\-.!|>])/g, "\\$1")
    .replace(/\n/g, "  \n");
const comparePosition = (a, b) => {
    if (a.lineNumber !== b.lineNumber) {
        return a.lineNumber - b.lineNumber;
    }
    return a.column - b.column;
};
const rangeStart = (range) => ({
    lineNumber: range.startLineNumber,
    column: range.startColumn,
});
const rangeEnd = (range) => ({
    lineNumber: range.endLineNumber,
    column: range.endColumn,
});
const rangeContainsPosition = (range, position) => comparePosition(position, rangeStart(range)) >= 0 && comparePosition(position, rangeEnd(range)) <= 0;
const rangesIntersect = (a, b) => comparePosition(rangeStart(a), rangeEnd(b)) <= 0 && comparePosition(rangeStart(b), rangeEnd(a)) <= 0;
const lineIntersectsRange = (range, lineNumber) => lineNumber >= range.startLineNumber && lineNumber <= range.endLineNumber;
const clampRangeToModel = (range, model) => {
    var _a, _b, _c, _d, _e, _f;
    const lineCount = Math.max(1, (_b = (_a = model === null || model === void 0 ? void 0 : model.getLineCount) === null || _a === void 0 ? void 0 : _a.call(model)) !== null && _b !== void 0 ? _b : range.endLineNumber);
    const startLineNumber = clamp(Math.floor(range.startLineNumber), 1, lineCount);
    const endLineNumber = clamp(Math.floor(range.endLineNumber), startLineNumber, lineCount);
    const startMaxColumn = Math.max(1, (_d = (_c = model === null || model === void 0 ? void 0 : model.getLineMaxColumn) === null || _c === void 0 ? void 0 : _c.call(model, startLineNumber)) !== null && _d !== void 0 ? _d : range.startColumn);
    const endMaxColumn = Math.max(1, (_f = (_e = model === null || model === void 0 ? void 0 : model.getLineMaxColumn) === null || _e === void 0 ? void 0 : _e.call(model, endLineNumber)) !== null && _f !== void 0 ? _f : range.endColumn);
    const startColumn = clamp(Math.floor(range.startColumn), 1, startMaxColumn);
    const endColumn = clamp(Math.floor(range.endColumn), 1, endMaxColumn);
    return {
        startLineNumber,
        startColumn,
        endLineNumber,
        endColumn: endLineNumber === startLineNumber ? Math.max(startColumn, endColumn) : endColumn,
    };
};
const getSelectionRange = (editor, model) => {
    var _a, _b, _c, _d, _e, _f;
    const selection = (_a = editor.getSelection) === null || _a === void 0 ? void 0 : _a.call(editor);
    if (selection &&
        isFiniteNumber(selection.startLineNumber) &&
        isFiniteNumber(selection.startColumn) &&
        isFiniteNumber(selection.endLineNumber) &&
        isFiniteNumber(selection.endColumn)) {
        const isEmpty = typeof selection.isEmpty === "function"
            ? selection.isEmpty()
            : selection.startLineNumber === selection.endLineNumber &&
                selection.startColumn === selection.endColumn;
        if (!isEmpty) {
            return clampRangeToModel(selection, model);
        }
    }
    const position = (_b = editor.getPosition) === null || _b === void 0 ? void 0 : _b.call(editor);
    if (!position) {
        return null;
    }
    const lineNumber = clamp(position.lineNumber, 1, Math.max(1, (_d = (_c = model === null || model === void 0 ? void 0 : model.getLineCount) === null || _c === void 0 ? void 0 : _c.call(model)) !== null && _d !== void 0 ? _d : position.lineNumber));
    const endColumn = Math.max(1, (_f = (_e = model === null || model === void 0 ? void 0 : model.getLineMaxColumn) === null || _e === void 0 ? void 0 : _e.call(model, lineNumber)) !== null && _f !== void 0 ? _f : position.column);
    return {
        startLineNumber: lineNumber,
        startColumn: 1,
        endLineNumber: lineNumber,
        endColumn,
    };
};
const createHoverMessage = (comment) => {
    const heading = comment.resolved ? uiText("**Comment** · resolved", "**コメント** · 解決済み") : uiText("**Comment**", "**コメント**");
    const author = comment.author ? ` — ${escapeMarkdownText(comment.author)}` : "";
    const lines = [`${heading}${author}`, "", escapeMarkdownText(comment.text)];
    for (const reply of comment.replies) {
        lines.push("", `↳ ${reply.author ? `**${escapeMarkdownText(reply.author)}** ` : ""}${escapeMarkdownText(reply.text)}`);
    }
    return { value: lines.join("\n") };
};
const createCodeCommentDialog = (options) => new Promise((resolve) => {
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
    const close = (value) => {
        var _a;
        if (settled) {
            return;
        }
        settled = true;
        window.removeEventListener("keydown", onKeyDown, true);
        modal.remove();
        (_a = previousFocus === null || previousFocus === void 0 ? void 0 : previousFocus.focus) === null || _a === void 0 ? void 0 : _a.call(previousFocus);
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
    function onKeyDown(event) {
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
export const createCodeCommentManager = (monaco, deps) => {
    var _a;
    let loadedRoot = null;
    let cachedComments = [];
    let loadGeneration = 0;
    let saveTimer = null;
    const groupStates = new Map();
    const legacyStorageKey = () => { var _a; return `${STORAGE_PREFIX}${(_a = deps.getWorkspaceRoot()) !== null && _a !== void 0 ? _a : "global"}`; };
    const sessionMap = () => { var _a, _b, _c; return (_c = (_b = (_a = deps.collab) === null || _a === void 0 ? void 0 : _a.sessionDoc()) === null || _b === void 0 ? void 0 : _b.getMap("comments")) !== null && _c !== void 0 ? _c : null; };
    const inSession = () => Boolean(sessionMap());
    const authorName = () => { var _a, _b; return ((_a = collabSession.selfParticipant()) === null || _a === void 0 ? void 0 : _a.name) || ((_b = deps.getAuthorName) === null || _b === void 0 ? void 0 : _b.call(deps)) || ""; };
    const refreshAllGroups = () => {
        groupStates.forEach((state) => scheduleRefreshGroup(state.group));
    };
    // Workspace file (outside a session). Loads once per root; the in-memory
    // list is what the editor reads synchronously.
    const loadFromWorkspace = async () => {
        var _a;
        const root = deps.getWorkspaceRoot();
        const generation = ++loadGeneration;
        let comments = [];
        let missing = false;
        if (root && collabSession.available) {
            try {
                const result = await collabSession.call("comments:load");
                comments = result.comments.map(sanitizeComment).filter((comment) => Boolean(comment));
                missing = result.missing === true;
            }
            catch {
                comments = [];
            }
        }
        if (generation !== loadGeneration || deps.getWorkspaceRoot() !== root)
            return;
        let migrated = [];
        try {
            const legacy = JSON.parse((_a = localStorage.getItem(legacyStorageKey())) !== null && _a !== void 0 ? _a : "[]");
            if (Array.isArray(legacy))
                migrated = legacy.map(sanitizeComment).filter((comment) => Boolean(comment));
        }
        catch { }
        cachedComments = comments;
        loadedRoot = root;
        if (migrated.length && (missing || comments.length === 0) && root) {
            cachedComments = migrated;
            void persistWorkspace(cachedComments).then((ok) => {
                if (ok) {
                    try {
                        localStorage.removeItem(legacyStorageKey());
                    }
                    catch { }
                }
            });
        }
        refreshAllGroups();
    };
    const persistWorkspace = async (comments) => {
        if (!collabSession.available || !deps.getWorkspaceRoot())
            return false;
        try {
            await collabSession.call("comments:save", { comments: comments.map(toStoredComment) });
            return true;
        }
        catch {
            return false;
        }
    };
    const loadComments = () => {
        const map = sessionMap();
        if (map)
            return readSessionComments(map);
        const root = deps.getWorkspaceRoot();
        if (root !== loadedRoot) {
            loadedRoot = root;
            cachedComments = [];
            void loadFromWorkspace();
        }
        return cachedComments;
    };
    const saveComments = (comments) => {
        if (inSession())
            return;
        cachedComments = comments;
        loadedRoot = deps.getWorkspaceRoot();
        if (saveTimer !== null)
            window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
            saveTimer = null;
            void persistWorkspace(cachedComments);
        }, 250);
    };
    // ---- session store (Y.Map id → Y.Map comment, replies: Y.Array)
    const Y = () => { var _a, _b, _c; return (_c = (_b = (_a = deps.collab) === null || _a === void 0 ? void 0 : _a.getVendor()) === null || _b === void 0 ? void 0 : _b.Y) !== null && _c !== void 0 ? _c : null; };
    const resolveSessionRange = (entry) => {
        var _a;
        const YLib = Y();
        const filePath = entry.get("filePath");
        const ytext = (_a = deps.collab) === null || _a === void 0 ? void 0 : _a.sessionText(filePath);
        const anchor = entry.get("anchor");
        const head = entry.get("head");
        if (YLib && ytext && anchor instanceof Uint8Array && head instanceof Uint8Array) {
            try {
                const start = YLib.createAbsolutePositionFromRelativePosition(YLib.decodeRelativePosition(anchor), ytext.doc);
                const end = YLib.createAbsolutePositionFromRelativePosition(YLib.decodeRelativePosition(head), ytext.doc);
                if (start && end) {
                    const content = ytext.toString();
                    const position = (offset) => {
                        const clamped = Math.max(0, Math.min(content.length, offset));
                        const before = content.slice(0, clamped);
                        const lastBreak = before.lastIndexOf("\n");
                        return { lineNumber: before.split("\n").length, column: clamped - lastBreak };
                    };
                    const a = position(Math.min(start.index, end.index));
                    const b = position(Math.max(start.index, end.index));
                    return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
                }
            }
            catch { }
        }
        return sanitizeStoredRange(entry.get("range"));
    };
    const readSessionComments = (map) => {
        const comments = [];
        map.forEach((entry, id) => {
            if (!entry || typeof entry.get !== "function")
                return;
            const range = resolveSessionRange(entry);
            if (!range)
                return;
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
            if (comment)
                comments.push(comment);
        });
        return comments;
    };
    const sessionRelativePositions = (filePath, range, model) => {
        var _a;
        const YLib = Y();
        const ytext = (_a = deps.collab) === null || _a === void 0 ? void 0 : _a.sessionText(filePath);
        if (!YLib || !ytext || !(model === null || model === void 0 ? void 0 : model.getOffsetAt))
            return null;
        const start = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
        const end = model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
        return {
            anchor: YLib.encodeRelativePosition(YLib.createRelativePositionFromTypeIndex(ytext, start)),
            head: YLib.encodeRelativePosition(YLib.createRelativePositionFromTypeIndex(ytext, end, -1)),
        };
    };
    const sessionAdd = (comment, model) => {
        const map = sessionMap();
        const YLib = Y();
        if (!map || !YLib)
            return false;
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
    const sessionUpdate = (id, patch) => {
        const map = sessionMap();
        const entry = map === null || map === void 0 ? void 0 : map.get(id);
        if (!map || !entry)
            return false;
        map.doc.transact(() => {
            if (typeof patch.text === "string")
                entry.set("text", patch.text);
            if (typeof patch.resolved === "boolean")
                entry.set("resolved", patch.resolved);
            if (patch.reply) {
                let replies = entry.get("replies");
                if (!replies || typeof replies.push !== "function") {
                    replies = new (Y().Array)();
                    entry.set("replies", replies);
                }
                replies.push([patch.reply]);
            }
            entry.set("updatedAt", Date.now());
        }, "comments");
        return true;
    };
    const sessionRemove = (id) => {
        const map = sessionMap();
        if (!map)
            return false;
        map.doc.transact(() => map.delete(id), "comments");
        return true;
    };
    // Session comments change under us (another participant, or our own write
    // echoed): redraw. The file store reloads when the session ends.
    let observedDoc = null;
    const observeSession = (doc) => {
        if (observedDoc === doc)
            return;
        if (observedDoc) {
            try {
                observedDoc.getMap("comments").unobserveDeep(onSessionCommentsChanged);
            }
            catch { }
        }
        observedDoc = doc;
        if (doc)
            doc.getMap("comments").observeDeep(onSessionCommentsChanged);
        else {
            loadedRoot = null;
            cachedComments = [];
        }
        refreshAllGroups();
    };
    const onSessionCommentsChanged = () => refreshAllGroups();
    (_a = deps.collab) === null || _a === void 0 ? void 0 : _a.onSessionDoc(observeSession);
    collabSession.onMessage("collab:comments", () => { if (!inSession()) {
        loadedRoot = null;
        refreshAllGroups();
    } });
    const getState = (group) => {
        const existing = groupStates.get(group.key);
        if (existing) {
            return existing;
        }
        const state = {
            group,
            path: null,
            model: null,
            records: [],
            refreshRafId: null,
        };
        groupStates.set(group.key, state);
        return state;
    };
    const syncRangesFromDecorations = (state) => {
        var _a, _b;
        // In a session the relative positions in the shared text move by
        // themselves; writing absolute ranges back from every participant would
        // make them fight.
        if (inSession())
            return;
        if (!state.path || !state.model || state.records.length === 0) {
            return;
        }
        const comments = loadComments();
        let changed = false;
        for (const record of state.records) {
            const range = (_b = (_a = state.model).getDecorationRange) === null || _b === void 0 ? void 0 : _b.call(_a, record.decorationId);
            const comment = comments.find((entry) => entry.id === record.commentId && entry.filePath === state.path);
            if (!range || !comment) {
                continue;
            }
            const nextRange = clampRangeToModel(range, state.model);
            if (comment.startLineNumber !== nextRange.startLineNumber ||
                comment.startColumn !== nextRange.startColumn ||
                comment.endLineNumber !== nextRange.endLineNumber ||
                comment.endColumn !== nextRange.endColumn) {
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
    const clearDecorations = (group, state) => {
        var _a, _b;
        const ids = state.records.map((record) => record.decorationId);
        if (ids.length === 0) {
            return;
        }
        const editor = group.editor;
        if ((_a = state.model) === null || _a === void 0 ? void 0 : _a.deltaDecorations) {
            state.model.deltaDecorations(ids, []);
        }
        else {
            (_b = editor === null || editor === void 0 ? void 0 : editor.deltaDecorations) === null || _b === void 0 ? void 0 : _b.call(editor, ids, []);
        }
        state.records = [];
    };
    const refreshGroup = (group) => {
        var _a, _b, _c, _d;
        const state = getState(group);
        state.refreshRafId = null;
        syncRangesFromDecorations(state);
        clearDecorations(group, state);
        const editor = group.editor;
        const model = (_b = (_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) !== null && _b !== void 0 ? _b : null;
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
        const stickiness = (_d = (_c = monaco.editor) === null || _c === void 0 ? void 0 : _c.TrackedRangeStickiness) === null || _d === void 0 ? void 0 : _d.NeverGrowsWhenTypingAtEdges;
        const decorations = comments.map((comment) => {
            const range = clampRangeToModel(comment, model);
            const hoverMessage = createHoverMessage(comment);
            return {
                range: new monaco.Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn),
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
    };
    const scheduleRefreshGroup = (group) => {
        const state = getState(group);
        if (state.refreshRafId !== null) {
            window.cancelAnimationFrame(state.refreshRafId);
        }
        state.refreshRafId = window.requestAnimationFrame(() => refreshGroup(group));
    };
    const refreshGroupsForPath = (filePath) => {
        groupStates.forEach((state) => {
            if (state.group.currentFilePath === filePath || state.path === filePath) {
                scheduleRefreshGroup(state.group);
            }
        });
    };
    const findCommentAtCurrentContext = (group) => {
        var _a, _b, _c, _d;
        const editor = group.editor;
        const model = (_b = (_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) !== null && _b !== void 0 ? _b : null;
        const path = group.currentFilePath;
        if (!editor || !path) {
            return null;
        }
        const selectionRange = getSelectionRange(editor, model);
        const position = (_c = editor.getPosition) === null || _c === void 0 ? void 0 : _c.call(editor);
        return ((_d = loadComments().find((comment) => {
            if (comment.filePath !== path) {
                return false;
            }
            if (selectionRange && rangesIntersect(comment, selectionRange)) {
                return true;
            }
            return Boolean(position && rangeContainsPosition(comment, position));
        })) !== null && _d !== void 0 ? _d : null);
    };
    const editComment = async (group, comment) => {
        var _a, _b, _c, _d;
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
            (_b = (_a = group.editor) === null || _a === void 0 ? void 0 : _a.focus) === null || _b === void 0 ? void 0 : _b.call(_a);
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
        (_d = (_c = group.editor) === null || _c === void 0 ? void 0 : _c.focus) === null || _d === void 0 ? void 0 : _d.call(_c);
    };
    const replyToComment = async (group, comment) => {
        var _a, _b;
        const text = await createCodeCommentDialog({
            title: uiText("Reply to comment", "コメントに返信"),
            initialText: "",
            submitLabel: uiText("Reply", "返信"),
        });
        if (text === null)
            return;
        const reply = { author: authorName(), text, createdAt: Date.now() };
        if (inSession()) {
            sessionUpdate(comment.id, { reply });
        }
        else {
            const comments = loadComments();
            const target = comments.find((entry) => entry.id === comment.id);
            if (!target)
                return;
            target.replies = [...target.replies, reply];
            target.updatedAt = Date.now();
            saveComments(comments);
        }
        refreshGroupsForPath(comment.filePath);
        (_b = (_a = group.editor) === null || _a === void 0 ? void 0 : _a.focus) === null || _b === void 0 ? void 0 : _b.call(_a);
    };
    const toggleResolved = (group, comment) => {
        var _a, _b;
        const resolved = !comment.resolved;
        if (inSession()) {
            sessionUpdate(comment.id, { resolved });
        }
        else {
            const comments = loadComments();
            const target = comments.find((entry) => entry.id === comment.id);
            if (!target)
                return;
            target.resolved = resolved;
            target.updatedAt = Date.now();
            saveComments(comments);
        }
        refreshGroupsForPath(comment.filePath);
        (_b = (_a = group.editor) === null || _a === void 0 ? void 0 : _a.focus) === null || _b === void 0 ? void 0 : _b.call(_a);
    };
    const addOrEditComment = async (group) => {
        var _a, _b, _c;
        const editor = group.editor;
        const model = (_b = (_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) !== null && _b !== void 0 ? _b : null;
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
        const comment = {
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
        }
        else {
            const comments = loadComments();
            comments.push(comment);
            saveComments(comments);
        }
        refreshGroupsForPath(filePath);
        (_c = editor.focus) === null || _c === void 0 ? void 0 : _c.call(editor);
    };
    const deleteCommentAtCursor = (group) => {
        var _a, _b;
        const comment = findCommentAtCurrentContext(group);
        if (!comment) {
            return;
        }
        const confirmed = window.confirm(uiText("Delete this comment?", "このコメントを削除しますか？"));
        if (!confirmed) {
            return;
        }
        if (inSession())
            sessionRemove(comment.id);
        else
            saveComments(loadComments().filter((entry) => entry.id !== comment.id));
        refreshGroupsForPath(comment.filePath);
        (_b = (_a = group.editor) === null || _a === void 0 ? void 0 : _a.focus) === null || _b === void 0 ? void 0 : _b.call(_a);
    };
    const replyAtCursor = async (group) => {
        const comment = findCommentAtCurrentContext(group);
        if (comment)
            await replyToComment(group, comment);
    };
    const resolveAtCursor = (group) => {
        const comment = findCommentAtCurrentContext(group);
        if (comment)
            toggleResolved(group, comment);
    };
    const editCommentAtCursor = async (group) => {
        const comment = findCommentAtCurrentContext(group);
        if (comment) {
            await editComment(group, comment);
        }
    };
    const editCommentAtLine = async (group, lineNumber) => {
        const path = group.currentFilePath;
        if (!path) {
            return;
        }
        const comment = loadComments().find((entry) => entry.filePath === path && lineIntersectsRange(entry, lineNumber));
        if (comment) {
            await editComment(group, comment);
        }
    };
    const attachToEditor = (group) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const editor = group.editor;
        if (!editor) {
            return;
        }
        getState(group);
        (_a = editor.onDidChangeModelContent) === null || _a === void 0 ? void 0 : _a.call(editor, () => {
            const state = getState(group);
            syncRangesFromDecorations(state);
        });
        (_b = editor.onDidChangeModel) === null || _b === void 0 ? void 0 : _b.call(editor, () => {
            scheduleRefreshGroup(group);
        });
        (_c = editor.onDidFocusEditorWidget) === null || _c === void 0 ? void 0 : _c.call(editor, () => {
            scheduleRefreshGroup(group);
        });
        (_d = editor.onMouseDown) === null || _d === void 0 ? void 0 : _d.call(editor, (event) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
            const target = event === null || event === void 0 ? void 0 : event.target;
            const glyphTargetType = (_b = (_a = monaco.editor) === null || _a === void 0 ? void 0 : _a.MouseTargetType) === null || _b === void 0 ? void 0 : _b.GUTTER_GLYPH_MARGIN;
            const isGlyphTarget = (target === null || target === void 0 ? void 0 : target.type) === glyphTargetType ||
                Boolean((_d = (_c = target === null || target === void 0 ? void 0 : target.element) === null || _c === void 0 ? void 0 : _c.classList) === null || _d === void 0 ? void 0 : _d.contains("code-comment-glyph"));
            if (!isGlyphTarget) {
                return;
            }
            const lineNumber = (_f = (_e = target === null || target === void 0 ? void 0 : target.position) === null || _e === void 0 ? void 0 : _e.lineNumber) !== null && _f !== void 0 ? _f : (_g = target === null || target === void 0 ? void 0 : target.range) === null || _g === void 0 ? void 0 : _g.startLineNumber;
            if (!isFiniteNumber(lineNumber)) {
                return;
            }
            event && ((_j = (_h = event.event) === null || _h === void 0 ? void 0 : _h.preventDefault) === null || _j === void 0 ? void 0 : _j.call(_h));
            event && ((_l = (_k = event.event) === null || _k === void 0 ? void 0 : _k.stopPropagation) === null || _l === void 0 ? void 0 : _l.call(_k));
            void editCommentAtLine(group, lineNumber);
        });
        (_e = editor.addAction) === null || _e === void 0 ? void 0 : _e.call(editor, {
            id: `tex64.comments.add.${group.key}`,
            label: uiText("Add comment", "コメントを追加"),
            contextMenuGroupId: "9_comments",
            contextMenuOrder: 1,
            run: () => addOrEditComment(group),
        });
        (_f = editor.addAction) === null || _f === void 0 ? void 0 : _f.call(editor, {
            id: `tex64.comments.edit.${group.key}`,
            label: uiText("Edit comment", "コメントを編集"),
            contextMenuGroupId: "9_comments",
            contextMenuOrder: 2,
            run: () => editCommentAtCursor(group),
        });
        (_g = editor.addAction) === null || _g === void 0 ? void 0 : _g.call(editor, {
            id: `tex64.comments.reply.${group.key}`,
            label: uiText("Reply to comment", "コメントに返信"),
            contextMenuGroupId: "9_comments",
            contextMenuOrder: 3,
            run: () => replyAtCursor(group),
        });
        (_h = editor.addAction) === null || _h === void 0 ? void 0 : _h.call(editor, {
            id: `tex64.comments.resolve.${group.key}`,
            label: uiText("Resolve / reopen comment", "コメントを解決・再開"),
            contextMenuGroupId: "9_comments",
            contextMenuOrder: 4,
            run: () => resolveAtCursor(group),
        });
        (_j = editor.addAction) === null || _j === void 0 ? void 0 : _j.call(editor, {
            id: `tex64.comments.delete.${group.key}`,
            label: uiText("Delete comment", "コメントを削除"),
            contextMenuGroupId: "9_comments",
            contextMenuOrder: 5,
            run: () => deleteCommentAtCursor(group),
        });
        scheduleRefreshGroup(group);
    };
    return { attachToEditor, refreshGroup, listComments: () => loadComments().map(toStoredComment) };
};
