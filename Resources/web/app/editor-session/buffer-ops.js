import { LATEX_FILE_EXTENSIONS, getFileExtension, isTextFilePath } from "../files.js";
export const createEditorSessionBufferOps = (runtime, coreOps) => {
    const getLanguageIdForPath = (path) => {
        const ext = getFileExtension(path);
        if (ext === "bib") {
            return "bibtex";
        }
        if (LATEX_FILE_EXTENSIONS.has(ext)) {
            return "latex";
        }
        return "plaintext";
    };
    const setEditorLanguage = (group, path) => {
        var _a;
        const monacoApi = runtime.deps.getMonacoApi();
        if (!monacoApi || !group.editor) {
            return;
        }
        if (!isTextFilePath(path)) {
            return;
        }
        const editor = group.editor;
        if (!editor.getModel) {
            return;
        }
        const model = editor.getModel();
        const monacoApiAny = monacoApi;
        const languageId = getLanguageIdForPath(path);
        if (model && ((_a = monacoApiAny.editor) === null || _a === void 0 ? void 0 : _a.setModelLanguage)) {
            monacoApiAny.editor.setModelLanguage(model, languageId);
        }
    };
    const getEmptyEditorModel = () => {
        var _a;
        const monacoApi = runtime.deps.getMonacoApi();
        if (!monacoApi) {
            return null;
        }
        if (runtime.emptyEditorModel) {
            return runtime.emptyEditorModel;
        }
        const monacoApiAny = monacoApi;
        if (!((_a = monacoApiAny.editor) === null || _a === void 0 ? void 0 : _a.createModel)) {
            return null;
        }
        runtime.emptyEditorModel = monacoApiAny.editor.createModel("", "plaintext");
        return runtime.emptyEditorModel;
    };
    const clearEditorView = (group) => {
        if (!group.editor) {
            return;
        }
        const editor = group.editor;
        const emptyModel = getEmptyEditorModel();
        if (emptyModel && editor.setModel) {
            editor.setModel(emptyModel);
        }
    };
    const scheduleAfterComposition = (group, action) => {
        var _a;
        if (!group.isComposing) {
            action();
            return;
        }
        // Blur will trigger compositionend which handles recovery
        group.pendingCompositionAction = action;
        const input = (_a = group.editorHost) === null || _a === void 0 ? void 0 : _a.querySelector("textarea.inputarea");
        input === null || input === void 0 ? void 0 : input.blur();
    };
    const handleCompositionEnd = (group) => {
        if (!group.pendingCompositionAction) {
            return;
        }
        const action = group.pendingCompositionAction;
        group.pendingCompositionAction = null;
        requestAnimationFrame(() => {
            action();
        });
    };
    const updateDirtyState = (path, content, savedContent) => {
        var _a, _b;
        const entry = runtime.monacoModels.get(path);
        const groupSavedContent = (_a = Array.from(Object.values(runtime.editorGroups)).find((group) => group.currentFilePath === path && group.currentFileSavedContent)) === null || _a === void 0 ? void 0 : _a.currentFileSavedContent;
        const baseSaved = (_b = savedContent !== null && savedContent !== void 0 ? savedContent : entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _b !== void 0 ? _b : groupSavedContent;
        if (baseSaved === undefined) {
            // No saved reference exists — treat content itself as saved baseline
            // but do NOT overwrite an existing entry.savedContent.
            if (entry && entry.savedContent === undefined) {
                entry.savedContent = content;
            }
            runtime.dirtyFiles.delete(path);
        }
        else {
            if (entry) {
                entry.savedContent = baseSaved;
            }
            if (content !== baseSaved) {
                runtime.dirtyFiles.add(path);
            }
            else {
                runtime.dirtyFiles.delete(path);
            }
        }
        coreOps.forEachEditorGroup((group) => {
            if (group.currentFilePath === path) {
                group.isDirty = runtime.dirtyFiles.has(path);
            }
        });
    };
    const storeViewState = (group, path) => {
        if (!group.editor) {
            return;
        }
        const editor = group.editor;
        if (!editor.saveViewState) {
            return;
        }
        const viewState = editor.saveViewState();
        if (viewState) {
            group.viewStates.set(path, viewState);
        }
    };
    const restoreViewState = (group, path) => {
        var _a;
        if (!group.editor) {
            return;
        }
        const viewState = group.viewStates.get(path);
        if (!viewState) {
            return;
        }
        const editor = group.editor;
        (_a = editor.restoreViewState) === null || _a === void 0 ? void 0 : _a.call(editor, viewState);
    };
    const cacheCurrentBuffer = (group) => {
        if (!group.currentFilePath || !group.editor || !isTextFilePath(group.currentFilePath)) {
            return;
        }
        const editor = group.editor;
        const content = editor.getValue();
        updateDirtyState(group.currentFilePath, content);
        storeViewState(group, group.currentFilePath);
    };
    return {
        getLanguageIdForPath,
        setEditorLanguage,
        clearEditorView,
        scheduleAfterComposition,
        handleCompositionEnd,
        updateDirtyState,
        restoreViewState,
        cacheCurrentBuffer,
    };
};
