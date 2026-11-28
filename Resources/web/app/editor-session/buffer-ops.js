import { LATEX_FILE_EXTENSIONS, getFileExtension, } from "../files.js";
const LANGUAGE_ID_ALIASES = {
    jsonc: "json", json5: "json",
    toml: "ini", conf: "ini", env: "ini", editorconfig: "ini",
    gitignore: "ini", gitattributes: "ini",
    zsh: "shell", fish: "shell",
    sass: "scss",
    vue: "html", svelte: "html", astro: "html", erb: "html",
    mm: "objective-c",
};
export const createEditorSessionBufferOps = (runtime, coreOps, onDirtyChanged) => {
    let languageLookup = null;
    let registeredLanguageIds = null;
    const getLanguageIdForPath = (path) => {
        var _a, _b, _c, _d, _e, _f;
        if ((_a = runtime.monacoModels.get(path)) === null || _a === void 0 ? void 0 : _a.plainText)
            return "plaintext";
        const ext = getFileExtension(path);
        if (ext === "bib") {
            return "bibtex";
        }
        if (LATEX_FILE_EXTENSIONS.has(ext)) {
            return "latex";
        }
        const monacoApi = runtime.deps.getMonacoApi();
        const languages = (_c = (_b = monacoApi === null || monacoApi === void 0 ? void 0 : monacoApi.languages) === null || _b === void 0 ? void 0 : _b.getLanguages) === null || _c === void 0 ? void 0 : _c.call(_b);
        if (!languages) {
            return "plaintext";
        }
        if (!languageLookup) {
            languageLookup = new Map();
            registeredLanguageIds = new Set();
            languages.forEach((language) => {
                var _a, _b;
                registeredLanguageIds === null || registeredLanguageIds === void 0 ? void 0 : registeredLanguageIds.add(language.id);
                (_a = language.extensions) === null || _a === void 0 ? void 0 : _a.forEach((extension) => {
                    languageLookup === null || languageLookup === void 0 ? void 0 : languageLookup.set(`ext:${extension.toLowerCase()}`, language.id);
                });
                (_b = language.filenames) === null || _b === void 0 ? void 0 : _b.forEach((filename) => {
                    languageLookup === null || languageLookup === void 0 ? void 0 : languageLookup.set(`name:${filename}`, language.id);
                });
            });
        }
        const basename = (_d = path.split("/").pop()) !== null && _d !== void 0 ? _d : path;
        const directMatch = (_e = languageLookup.get(`ext:.${ext.toLowerCase()}`)) !== null && _e !== void 0 ? _e : languageLookup.get(`name:${basename}`);
        if (directMatch) {
            return directMatch;
        }
        const alias = (_f = LANGUAGE_ID_ALIASES[ext.toLowerCase()]) !== null && _f !== void 0 ? _f : LANGUAGE_ID_ALIASES[basename.toLowerCase().replace(/^\./, "")];
        return alias && (registeredLanguageIds === null || registeredLanguageIds === void 0 ? void 0 : registeredLanguageIds.has(alias)) ? alias : "plaintext";
    };
    const setEditorLanguage = (group, path) => {
        var _a;
        const monacoApi = runtime.deps.getMonacoApi();
        if (!monacoApi || !group.editor) {
            return;
        }
        if (!runtime.monacoModels.has(path)) {
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
        if (group.editor) {
            // The swap ends a composition on the outgoing model and answers what
            // waited for it (editor-composition.ts), so it runs first.
            const editor = group.editor;
            const emptyModel = getEmptyEditorModel();
            if (emptyModel && editor.setModel) {
                editor.setModel(emptyModel);
            }
        }
        // A workspace change can dispose the composing model before Monaco's
        // compositionend callback. Its candidate and tab action belong to that model.
        group.isComposing = false;
        group.compositionText = "";
        group.composingFilePath = null;
        delete group.compositionBaseline;
        handleCompositionEnd(group, { cancelled: true });
    };
    // Callers waiting on an action queued below, answered instead when the
    // composition is cancelled (its model replaced: editor-composition.ts).
    const compositionCancels = new WeakMap();
    const scheduleAfterComposition = (group, action, cancel) => {
        var _a, _b, _c, _d;
        if (!group.isComposing) {
            action();
            return;
        }
        if (cancel)
            compositionCancels.set(group, [...((_a = compositionCancels.get(group)) !== null && _a !== void 0 ? _a : []), cancel]);
        // Blurring finishes composition. Keep other waiters, for example a save
        // already waiting on the same input when the user clicks another tab.
        const previous = group.pendingCompositionAction;
        group.pendingCompositionAction = previous ? () => {
            try {
                previous();
            }
            finally {
                action();
            }
        } : action;
        // The focused element in the editor is the one composing; otherwise the
        // editor's input (EditContext or textarea).
        const focused = typeof document === "undefined" ? null : document.activeElement;
        const input = focused && ((_c = (_b = group.editorHost) === null || _b === void 0 ? void 0 : _b.contains) === null || _c === void 0 ? void 0 : _c.call(_b, focused))
            ? focused
            : (_d = group.editorHost) === null || _d === void 0 ? void 0 : _d.querySelector(".native-edit-context, textarea.inputarea");
        input === null || input === void 0 ? void 0 : input.blur();
    };
    const handleCompositionEnd = (group, options = {}) => {
        var _a;
        const cancels = (_a = compositionCancels.get(group)) !== null && _a !== void 0 ? _a : [];
        compositionCancels.delete(group);
        const action = group.pendingCompositionAction;
        group.pendingCompositionAction = null;
        if (options.cancelled) {
            // Queued for the model (and folder) that was replaced: nothing of it
            // runs against the new one.
            for (const settle of cancels)
                settle();
            return;
        }
        if (!action) {
            return;
        }
        requestAnimationFrame(() => {
            action();
        });
    };
    const updateDirtyState = (path, content, savedContent) => {
        var _a, _b;
        const wasDirty = runtime.dirtyFiles.has(path);
        const entry = runtime.monacoModels.get(path);
        const groupSavedContent = (_a = Array.from(Object.values(runtime.editorGroups)).find((group) => group.currentFilePath === path && group.currentFileSavedContent)) === null || _a === void 0 ? void 0 : _a.currentFileSavedContent;
        const baseSaved = (_b = savedContent !== null && savedContent !== void 0 ? savedContent : entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _b !== void 0 ? _b : groupSavedContent;
        // Monaco hides the BOM by default. Compare the same complete UTF-8 text
        // that the save path reads, including a BOM when the model carries one.
        if (entry && (entry.plainText || (baseSaved === null || baseSaved === void 0 ? void 0 : baseSaved.charCodeAt(0)) === 0xfeff))
            content = entry.model.getValue(undefined, true);
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
        const dirty = runtime.dirtyFiles.has(path);
        if (wasDirty !== dirty) {
            onDirtyChanged === null || onDirtyChanged === void 0 ? void 0 : onDirtyChanged(path, dirty);
            window.dispatchEvent(new Event("tex64:dirty-state-changed"));
        }
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
        if (!group.currentFilePath ||
            !group.editor ||
            !runtime.monacoModels.has(group.currentFilePath)) {
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
