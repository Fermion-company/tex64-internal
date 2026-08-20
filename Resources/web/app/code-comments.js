import { uiText } from "./i18n.js";
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
const sanitizeComment = (value) => {
    const entry = value;
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
const createHoverMessage = (comment) => ({
    value: `${uiText("**Comment**", "**コメント**")}\n\n${escapeMarkdownText(comment.text)}`,
});
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
    let loadedStorageKey = null;
    let cachedComments = [];
    const groupStates = new Map();
    const getStorageKey = () => { var _a; return `${STORAGE_PREFIX}${(_a = deps.getWorkspaceRoot()) !== null && _a !== void 0 ? _a : "global"}`; };
    const loadComments = () => {
        var _a;
        const storageKey = getStorageKey();
        if (storageKey === loadedStorageKey) {
            return cachedComments;
        }
        loadedStorageKey = storageKey;
        try {
            const parsed = JSON.parse((_a = localStorage.getItem(storageKey)) !== null && _a !== void 0 ? _a : "[]");
            cachedComments = Array.isArray(parsed)
                ? parsed.map(sanitizeComment).filter((comment) => Boolean(comment))
                : [];
        }
        catch {
            cachedComments = [];
        }
        return cachedComments;
    };
    const saveComments = (comments) => {
        cachedComments = comments;
        loadedStorageKey = getStorageKey();
        try {
            if (comments.length === 0) {
                localStorage.removeItem(loadedStorageKey);
            }
            else {
                localStorage.setItem(loadedStorageKey, JSON.stringify(comments));
            }
        }
        catch {
            // Storage failures should not break editing.
        }
    };
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
        var _a, _b;
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
        saveComments(loadComments().filter((entry) => entry.id !== comment.id));
        refreshGroupsForPath(comment.filePath);
        (_b = (_a = group.editor) === null || _a === void 0 ? void 0 : _a.focus) === null || _b === void 0 ? void 0 : _b.call(_a);
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
        var _a, _b, _c, _d, _e, _f, _g;
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
