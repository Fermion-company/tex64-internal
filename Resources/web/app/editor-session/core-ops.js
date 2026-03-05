import { isTextFilePath } from "../files.js";
export const createEditorSessionCoreOps = (runtime) => {
    const getEditorGroup = (key) => runtime.editorGroups[key];
    const getActiveGroup = () => runtime.editorGroups[runtime.state.activeEditorGroup];
    const getActiveEditorGroupKey = () => runtime.state.activeEditorGroup;
    const getActiveFilePath = () => getActiveGroup().currentFilePath;
    const getActiveFileSnapshot = () => {
        var _a, _b, _c, _d, _e;
        const group = getActiveGroup();
        if (!group.currentFilePath || !isTextFilePath(group.currentFilePath)) {
            return null;
        }
        const entry = runtime.monacoModels.get(group.currentFilePath);
        const editor = group.editor;
        const content = (_e = (_c = (_b = (_a = entry === null || entry === void 0 ? void 0 : entry.model) === null || _a === void 0 ? void 0 : _a.getValue) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : (_d = editor === null || editor === void 0 ? void 0 : editor.getValue) === null || _d === void 0 ? void 0 : _d.call(editor)) !== null && _e !== void 0 ? _e : null;
        if (content === null) {
            return null;
        }
        return { path: group.currentFilePath, content, isDirty: group.isDirty };
    };
    const getActiveSelectionSnapshot = () => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const group = getActiveGroup();
        if (!group.currentFilePath || !isTextFilePath(group.currentFilePath) || !group.editor) {
            return null;
        }
        const editorAny = group.editor;
        const selection = (typeof editorAny.getSelection === "function" ? editorAny.getSelection() : null);
        if (!selection || typeof selection !== "object") {
            return null;
        }
        const startLine = (_b = (_a = selection.startLineNumber) !== null && _a !== void 0 ? _a : selection.selectionStartLineNumber) !== null && _b !== void 0 ? _b : selection.positionLineNumber;
        const startColumn = (_d = (_c = selection.startColumn) !== null && _c !== void 0 ? _c : selection.selectionStartColumn) !== null && _d !== void 0 ? _d : selection.positionColumn;
        const endLine = (_f = (_e = selection.endLineNumber) !== null && _e !== void 0 ? _e : selection.selectionEndLineNumber) !== null && _f !== void 0 ? _f : selection.positionLineNumber;
        const endColumn = (_h = (_g = selection.endColumn) !== null && _g !== void 0 ? _g : selection.selectionEndColumn) !== null && _h !== void 0 ? _h : selection.positionColumn;
        if (typeof startLine !== "number" ||
            typeof startColumn !== "number" ||
            typeof endLine !== "number" ||
            typeof endColumn !== "number") {
            return null;
        }
        if (startLine === endLine && startColumn === endColumn) {
            return null;
        }
        const model = typeof editorAny.getModel === "function" ? editorAny.getModel() : null;
        const getValueInRange = model && typeof model.getValueInRange === "function" ? model.getValueInRange.bind(model) : null;
        if (!getValueInRange) {
            return null;
        }
        const text = getValueInRange(selection).replace(/\r\n/g, "\n");
        return {
            path: group.currentFilePath,
            text,
            isDirty: group.isDirty,
            startLine,
            startColumn,
            endLine,
            endColumn,
        };
    };
    const isActiveGroup = (group) => group.key === runtime.state.activeEditorGroup;
    const getOtherGroupKey = (key) => (key === "primary" ? "secondary" : "primary");
    const resolveAutoOpenGroupKey = (preferredKey) => {
        if (!runtime.state.splitViewEnabled) {
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
    const findGroupKeyByPath = (path) => {
        const groups = Object.keys(runtime.editorGroups);
        for (const key of groups) {
            if (runtime.editorGroups[key].openTabs.includes(path)) {
                return key;
            }
        }
        return null;
    };
    const findGroupKeyByCurrentPath = (path) => {
        const groups = Object.keys(runtime.editorGroups);
        for (const key of groups) {
            if (runtime.editorGroups[key].currentFilePath === path) {
                return key;
            }
        }
        return null;
    };
    const resolveOpenTargetGroupKey = (path, preferredKey) => {
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
    const forEachEditorGroup = (handler) => {
        Object.keys(runtime.editorGroups).forEach((key) => {
            handler(runtime.editorGroups[key]);
        });
    };
    const scheduleEditorLayout = () => {
        if (runtime.state.layoutFrame !== null) {
            return;
        }
        runtime.state.layoutFrame = requestAnimationFrame(() => {
            runtime.state.layoutFrame = null;
            forEachEditorGroup((group) => {
                var _a;
                const editor = group.editor;
                (_a = editor === null || editor === void 0 ? void 0 : editor.layout) === null || _a === void 0 ? void 0 : _a.call(editor);
            });
        });
    };
    const getOpenFileSnapshots = (options) => {
        var _a, _b;
        const rawMaxFiles = (_a = options === null || options === void 0 ? void 0 : options.maxFiles) !== null && _a !== void 0 ? _a : 8;
        const maxFiles = rawMaxFiles > 0 ? rawMaxFiles : Number.POSITIVE_INFINITY;
        const rawMaxChars = (_b = options === null || options === void 0 ? void 0 : options.maxChars) !== null && _b !== void 0 ? _b : 20000;
        const maxChars = rawMaxChars > 0 ? rawMaxChars : Number.POSITIVE_INFINITY;
        const files = new Map();
        const snapshots = [];
        const pushSnapshot = (path, isDirty) => {
            var _a, _b, _c, _d, _e;
            if (snapshots.length >= maxFiles || !isTextFilePath(path)) {
                return;
            }
            const entry = runtime.monacoModels.get(path);
            const editorGroupKey = findGroupKeyByPath(path);
            const group = editorGroupKey ? getEditorGroup(editorGroupKey) : null;
            const editor = group === null || group === void 0 ? void 0 : group.editor;
            const rawContent = (_e = (_c = (_b = (_a = entry === null || entry === void 0 ? void 0 : entry.model) === null || _a === void 0 ? void 0 : _a.getValue) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : (_d = editor === null || editor === void 0 ? void 0 : editor.getValue) === null || _d === void 0 ? void 0 : _d.call(editor)) !== null && _e !== void 0 ? _e : null;
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
                        isDirty: runtime.dirtyFiles.has(path),
                        isActive: group.currentFilePath === path,
                    });
                }
                else {
                    const entry = files.get(path);
                    if (entry) {
                        entry.isDirty = entry.isDirty || runtime.dirtyFiles.has(path);
                        entry.isActive = entry.isActive || group.currentFilePath === path;
                    }
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
    return {
        getEditorGroup,
        getActiveGroup,
        getActiveEditorGroupKey,
        getActiveFilePath,
        getActiveFileSnapshot,
        getActiveSelectionSnapshot,
        getOpenFileSnapshots,
        isActiveGroup,
        getOtherGroupKey,
        resolveAutoOpenGroupKey,
        findGroupKeyByPath,
        findGroupKeyByCurrentPath,
        resolveOpenTargetGroupKey,
        forEachEditorGroup,
        scheduleEditorLayout,
    };
};
