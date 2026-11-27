import { isTexFilePath } from "./files.js";
import { resolveLivePreviewWorkspacePath } from "./live-preview-path.js";
import { attachSnippetEditor } from "./snippets-ui.js";
import { attachCitationEditor } from "./zotero-ui.js";
import { installEditorContextMenu } from "./editor-context-menu.js";
import { uiText } from "./i18n.js";
import { aiText } from "./ai-i18n.js";
import { registerHoverProvider, } from "./monaco-hover.js";
import { scrollFormulaHover } from "./monaco-hover/math-preview.js";
import { registerTexLanguages } from "./monaco-language.js";
import { applyMonacoTheme } from "./monaco-theme.js";
import { getCurrentAppearanceTheme, onAppearanceThemeChange } from "./appearance.js";
import { setupLsp } from "./lsp/setup-lsp.js";
import { editorSettings } from "./editor-settings/editor-settings-store.js";
import { attachEditorErgonomics } from "./editor-ergonomics.js";
import { createCodeCommentManager } from "./code-comments.js";
import { SpellChecker } from "./spell/spell-check.js";
import { decodeFigureBlockAt } from "./pro-canvas/figure-codec.js";
import { installFigureMetaChips } from "./pro-canvas/figure-meta-chip.js";
import { attachSelectionDragAutoScroll } from "./editor-selection-autoscroll.js";
// texlab is a resident process (~40 MB) that serves nothing until a TeX
// document is open, and its initialize handshake fixes the workspace root.
// Start it with the first latex/bibtex file model instead of with the window:
// by then a project is open, so the root is known too.
const startLspOnFirstTexModel = (monaco, start) => {
    var _a, _b, _c;
    const isTexFile = (model) => { var _a, _b; return ((_a = model === null || model === void 0 ? void 0 : model.uri) === null || _a === void 0 ? void 0 : _a.scheme) === "file" && ["latex", "bibtex"].includes((_b = model.getLanguageId) === null || _b === void 0 ? void 0 : _b.call(model)); };
    if (((_c = (_b = (_a = monaco.editor).getModels) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : []).some(isTexFile)) {
        start();
        return;
    }
    const subscriptions = [];
    const maybeStart = (model) => {
        if (!isTexFile(model) || !subscriptions.length)
            return;
        subscriptions.splice(0).forEach((subscription) => subscription.dispose());
        start();
    };
    subscriptions.push(monaco.editor.onDidCreateModel(maybeStart));
    if (monaco.editor.onDidChangeModelLanguage) {
        subscriptions.push(monaco.editor.onDidChangeModelLanguage((event) => maybeStart(event.model)));
    }
};
export const initMonacoSetup = (context, deps) => {
    const { editorHost, editorHostSecondary } = context.dom;
    const hoverState = { registered: false };
    const setWordWrapEnabled = (enabled) => {
        const wordWrap = enabled ? "on" : "off";
        deps.editorSession.forEachEditorGroup((group) => {
            var _a;
            const editorAny = group.editor;
            (_a = editorAny === null || editorAny === void 0 ? void 0 : editorAny.updateOptions) === null || _a === void 0 ? void 0 : _a.call(editorAny, { wordWrap });
        });
    };
    const api = {
        setWordWrapEnabled,
        flushComments: async () => { },
        hasPendingComments: () => false,
    };
    if (!(editorHost instanceof HTMLElement)) {
        deps.updateFallback(uiText("Editor area not found.", "エディタ領域が見つかりません。"));
        return api;
    }
    const baseUrl = new URL("monaco/vs/", window.location.href).toString();
    const requireBase = baseUrl.replace(/\/$/, "");
    const monacoWindow = window;
    monacoWindow.MonacoEnvironment = {
        getWorkerUrl: () => {
            const workerMain = `${baseUrl}base/worker/workerMain.js`;
            const workerBootstrap = [
                `self.MonacoEnvironment = { baseUrl: '${baseUrl}' };`,
                `importScripts('${workerMain}');`,
            ].join("\n");
            return URL.createObjectURL(new Blob([workerBootstrap], { type: "text/javascript" }));
        },
    };
    if (!monacoWindow.require || !monacoWindow.require.config) {
        deps.updateFallback(uiText("Monaco loader not found.", "Monacoのローダーが見つかりません。"));
        return;
    }
    monacoWindow.require.config({ paths: { vs: requireBase } });
    monacoWindow.require(["vs/editor/editor.main"], () => {
        var _a, _b, _c, _d, _e, _f, _g;
        if (!monacoWindow.monaco || !monacoWindow.monaco.editor) {
            deps.updateFallback(uiText("Monaco initialization failed.", "Monacoを初期化できませんでした。"));
            return;
        }
        deps.setMonacoApi(monacoWindow.monaco);
        registerTexLanguages(monacoWindow.monaco);
        (_b = (_a = monacoWindow.monaco.editor).registerEditorOpener) === null || _b === void 0 ? void 0 : _b.call(_a, {
            openCodeEditor: (editor, resource, target) => {
                var _a, _b, _c, _d, _e, _f, _g, _h;
                if (resource.scheme !== "file" || ((_c = (_b = (_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) === null || _b === void 0 ? void 0 : _b.uri) === null || _c === void 0 ? void 0 : _c.toString()) === resource.toString())
                    return false;
                const path = resolveLivePreviewWorkspacePath(resource.fsPath, deps.getWorkspaceRoot());
                if (!path || !deps.getWorkspaceFiles().includes(path))
                    return false;
                const group = deps.editorSession.getEditorGroups().find((group) => group.editor === editor);
                deps.editorSession.jumpToFileLine(path, (_e = (_d = target === null || target === void 0 ? void 0 : target.startLineNumber) !== null && _d !== void 0 ? _d : target === null || target === void 0 ? void 0 : target.lineNumber) !== null && _e !== void 0 ? _e : 1, (_f = group === null || group === void 0 ? void 0 : group.key) !== null && _f !== void 0 ? _f : deps.editorSession.getActiveEditorGroupKey(), { column: (_h = (_g = target === null || target === void 0 ? void 0 : target.startColumn) !== null && _g !== void 0 ? _g : target === null || target === void 0 ? void 0 : target.column) !== null && _h !== void 0 ? _h : 1, focus: true });
                return true;
            },
        });
        // Completion is provided by texlab (see setupLsp below). The previous
        // hand-rolled \ref/\cite/path/\begin completion was removed to avoid
        // duplicate suggestions.
        registerHoverProvider(monacoWindow.monaco, {
            getActiveFilePath: deps.editorSession.getActiveFilePath,
            getWorkspaceFiles: deps.getWorkspaceFiles,
            getRootFilePath: deps.getRootFilePath,
            getWorkspaceRoot: deps.getWorkspaceRoot,
            getIndexLabels: deps.getIndexLabels,
            getIndexCitations: deps.getIndexCitations,
            requestFilePreview: deps.requestFilePreview,
            requestFileExcerpt: deps.requestFileExcerpt,
        }, hoverState);
        startLspOnFirstTexModel(monacoWindow.monaco, () => void setupLsp(monacoWindow.monaco, {
            getWorkspaceRoot: deps.getWorkspaceRoot,
            loadResource: (resource) => {
                const path = resolveLivePreviewWorkspacePath(resource.fsPath, deps.getWorkspaceRoot());
                return resource.scheme === "file" && path
                    ? deps.editorSession.loadWorkspaceTextModel(path)
                    : Promise.resolve(false);
            },
        }));
        const spellBridge = window.tex64Spell;
        const spellChecker = spellBridge ? new SpellChecker(monacoWindow.monaco, spellBridge) : null;
        spellChecker === null || spellChecker === void 0 ? void 0 : spellChecker.start();
        const codeCommentManager = createCodeCommentManager(monacoWindow.monaco, {
            getWorkspaceRoot: deps.getWorkspaceRoot,
            collab: (_c = deps.collab) === null || _c === void 0 ? void 0 : _c.comments,
        });
        window.__tex64CodeComments = codeCommentManager;
        api.flushComments = codeCommentManager.flushPendingSave;
        api.hasPendingComments = codeCommentManager.hasPendingSave;
        const themeName = applyMonacoTheme(monacoWindow.monaco, getCurrentAppearanceTheme());
        onAppearanceThemeChange((theme) => {
            if (monacoWindow.monaco) {
                applyMonacoTheme(monacoWindow.monaco, theme);
            }
        });
        // Click-to-column accuracy: Monaco measures glyph advance widths when
        // an editor is created, but the default editor face (Latin Modern
        // Mono, 0.525em advance) is a webfont — if it lands after that
        // measurement, mouse positions map through the FALLBACK font's widths
        // (Menlo/SF Mono, ~0.60em) and a click at column 60 places the cursor
        // ~8 columns off. Remeasure once the document's fonts settle, and
        // again whenever any later font load finishes (a font-family change
        // in settings, a lazily-loaded face).
        const remeasureFonts = () => { var _a, _b, _c; return (_c = (_b = (_a = monacoWindow.monaco) === null || _a === void 0 ? void 0 : _a.editor) === null || _b === void 0 ? void 0 : _b.remeasureFonts) === null || _c === void 0 ? void 0 : _c.call(_b); };
        (_e = (_d = document.fonts) === null || _d === void 0 ? void 0 : _d.ready) === null || _e === void 0 ? void 0 : _e.then(() => remeasureFonts()).catch(() => { });
        (_g = (_f = document.fonts) === null || _f === void 0 ? void 0 : _f.addEventListener) === null || _g === void 0 ? void 0 : _g.call(_f, "loadingdone", () => remeasureFonts());
        const editorOptions = {
            value: "",
            language: "latex",
            theme: themeName,
            automaticLayout: true,
            glyphMargin: true,
            minimap: { enabled: false },
            scrollbar: { vertical: "visible", horizontal: "auto", verticalScrollbarSize: 14, horizontalScrollbarSize: 14 },
            fontFamily: editorSettings.getFontFamily(),
            fontSize: editorSettings.getFontSize(),
            lineHeight: editorSettings.getLineHeight(),
            lineNumbersMinChars: 2,
            scrollBeyondLastLine: false,
            wordWrap: deps.getEditorWordWrapEnabled() ? "on" : "off",
            wordBasedSuggestions: "off",
            quickSuggestions: { other: true, comments: false, strings: true },
            quickSuggestionsDelay: 25,
            suggestOnTriggerCharacters: true,
            tabCompletion: "off",
            // Enter is a line break in TeX source; Tab accepts a suggestion.
            acceptSuggestionOnEnter: "off",
            // Render hover/suggest widgets in a fixed layer to avoid clipping
            // at the Monaco viewport edge (especially near the first lines).
            fixedOverflowWidgets: true,
            hover: {
                enabled: true,
                delay: 180,
                sticky: true,
                // Prefer above by default (Monaco may fallback below if space is insufficient).
                above: true,
            },
            occurrencesHighlight: editorSettings.isEnabled("lsp.documentHighlight") ? "singleFile" : "off",
            selectionHighlight: false,
        };
        const createEditorForGroup = (group, host) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1;
            const editor = (_b = (_a = monacoWindow.monaco) === null || _a === void 0 ? void 0 : _a.editor) === null || _b === void 0 ? void 0 : _b.create(host, editorOptions);
            const editorAny = editor;
            group.editor = editor;
            const sizeFormulaPreview = ({ width }) => {
                host.style.setProperty("--tex64-editor-width", width + "px");
            };
            host.addEventListener("wheel", scrollFormulaHover, { capture: true, passive: false });
            sizeFormulaPreview(editor.getLayoutInfo());
            editor.onDidLayoutChange(sizeFormulaPreview);
            attachEditorErgonomics(monacoWindow.monaco, editor, group);
            attachSelectionDragAutoScroll(monacoWindow.monaco, editor, host);
            codeCommentManager.attachToEditor(group);
            // Chromium EditContext delivers IME events directly to Monaco.
            editor.onDidCompositionStart(() => {
                var _a;
                group.isComposing = true;
                group.compositionText = "";
                group.composingFilePath = group.currentFilePath;
                const model = editor.getModel();
                if (model && group.currentFilePath) {
                    group.compositionBaseline = {
                        model,
                        text: group.isDirty ? model.getValue() : (_a = group.currentFileSavedContent) !== null && _a !== void 0 ? _a : model.getValue(),
                        dirty: group.isDirty,
                    };
                }
            });
            host.addEventListener("compositionupdate", (e) => {
                group.compositionText = e.data || "";
            });
            host.addEventListener("compositionend", (e) => {
                const data = e.data;
                if (!data && group.pendingCompositionAction && group.compositionText) {
                    if (group.composingFilePath === group.currentFilePath) {
                        const selection = editorAny.getSelection();
                        if (selection) {
                            editorAny.executeEdits("ime-recover", [
                                {
                                    range: selection,
                                    text: group.compositionText,
                                    forceMoveMarkers: true,
                                },
                            ]);
                        }
                    }
                }
            });
            editor.onDidCompositionEnd(() => {
                // Let textarea compositionend finish any pending file-switch recovery.
                queueMicrotask(() => {
                    if (editor.inComposition)
                        return;
                    group.compositionText = "";
                    group.isComposing = false;
                    group.composingFilePath = null;
                    delete group.compositionBaseline;
                    deps.editorSession.handleCompositionEnd(group);
                    if (group.isDirty)
                        deps.editorSession.scheduleAutoSave();
                });
            });
            (_c = editor.onDidFocusEditorWidget) === null || _c === void 0 ? void 0 : _c.call(editor, () => {
                deps.editorSession.setActiveGroup(group.key, { focusEditor: false });
                deps.fileTree.setTreeFocus(false);
            });
            editor.onDidChangeModelContent((e) => {
                var _a;
                if (group.isApplyingFile)
                    return;
                if (e.isFlush)
                    return;
                if (!group.currentFilePath)
                    return;
                const currentValue = editor.getValue();
                deps.editorSession.updateDirtyState(group.currentFilePath, currentValue);
                if (deps.editorSession.isActiveGroup(group)) {
                    deps.editorSession.clearJumpHighlight(group);
                    // Undo and redo change the file too. Autosave never reformats,
                    // so saving them leaves the undo stack alone. A file shared in a
                    // collaboration session is written by the session layer instead.
                    if (!((_a = deps.collab) === null || _a === void 0 ? void 0 : _a.isBound(group.currentFilePath)))
                        deps.editorSession.scheduleAutoSave();
                }
            });
            (_d = editor.onDidChangeCursorPosition) === null || _d === void 0 ? void 0 : _d.call(editor, (e) => {
                if (isTexFilePath(group.currentFilePath) &&
                    deps.editorSession.isActiveGroup(group)) {
                    deps.onCursorPositionChange(e.position);
                }
            });
            (_e = editor.onDidChangeCursorSelection) === null || _e === void 0 ? void 0 : _e.call(editor, (e) => {
                var _a;
                if (isTexFilePath(group.currentFilePath) &&
                    deps.editorSession.isActiveGroup(group)) {
                    (_a = deps.onCursorSelectionChange) === null || _a === void 0 ? void 0 : _a.call(deps, {
                        lineNumber: e.selection.positionLineNumber,
                        column: e.selection.positionColumn,
                    });
                }
            });
            attachSnippetEditor(editor, monacoWindow.monaco);
            attachCitationEditor(editor, () => group.currentFilePath);
            // Selection → Axiom: the context-menu entry (⌘K) and a small button
            // that floats at the end of a selection in a .tex file. Both open the
            // chat with the selection as its context.
            let askButton = null;
            let voicePillShown = false;
            if (deps.openAiWithSelection) {
                const KeyMod = (_f = monacoWindow.monaco) === null || _f === void 0 ? void 0 : _f.KeyMod;
                const KeyCode = (_g = monacoWindow.monaco) === null || _g === void 0 ? void 0 : _g.KeyCode;
                const openAi = deps.openAiWithSelection;
                if (KeyMod && KeyCode) {
                    (_j = (_h = editor).addAction) === null || _j === void 0 ? void 0 : _j.call(_h, {
                        id: "tex64.ai-edit-selection",
                        label: aiText("ask_axiom"),
                        keybindings: [KeyMod.CtrlCmd | KeyCode.KeyK],
                        contextMenuGroupId: "9_ai",
                        contextMenuOrder: 1,
                        precondition: "editorHasSelection",
                        run: () => { openAi(); },
                    });
                }
                const preference = (_l = (_k = monacoWindow.monaco) === null || _k === void 0 ? void 0 : _k.editor) === null || _l === void 0 ? void 0 : _l.ContentWidgetPositionPreference;
                const askNode = document.createElement("button");
                askNode.type = "button";
                askNode.className = "ai-selection-ask";
                askNode.textContent = aiText("ask_axiom");
                askNode.addEventListener("mousedown", (event) => {
                    // Keep the editor selection: it is what the chat receives.
                    event.preventDefault();
                    event.stopPropagation();
                });
                askNode.addEventListener("click", (event) => {
                    event.preventDefault();
                    openAi();
                });
                let askPosition = null;
                const askWidget = {
                    getId: () => "tex64.ai-selection-ask",
                    getDomNode: () => askNode,
                    getPosition: () => askPosition
                        ? {
                            position: askPosition,
                            preference: preference ? [preference.BELOW, preference.ABOVE] : [2, 1],
                        }
                        : null,
                };
                let askShown = false;
                const hideAsk = () => {
                    var _a, _b;
                    askPosition = null;
                    if (askShown) {
                        (_b = (_a = editor).removeContentWidget) === null || _b === void 0 ? void 0 : _b.call(_a, askWidget);
                        askShown = false;
                    }
                };
                const syncAsk = () => {
                    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
                    const selection = (_b = (_a = editor).getSelection) === null || _b === void 0 ? void 0 : _b.call(_a);
                    const isTex = isTexFilePath(group.currentFilePath);
                    const empty = !selection || (typeof selection.isEmpty === "function" ? selection.isEmpty() : true);
                    const snippetActive = (_f = (_e = (_d = (_c = editor).getContribution) === null || _d === void 0 ? void 0 : _d.call(_c, "snippetController2")) === null || _e === void 0 ? void 0 : _e.isInSnippet) === null || _f === void 0 ? void 0 : _f.call(_e);
                    if (!isTex || empty || snippetActive || voicePillShown) {
                        hideAsk();
                        return;
                    }
                    askNode.textContent = aiText("ask_axiom");
                    askPosition = { lineNumber: selection.endLineNumber, column: selection.endColumn };
                    if (!askShown) {
                        (_h = (_g = editor).addContentWidget) === null || _h === void 0 ? void 0 : _h.call(_g, askWidget);
                        askShown = true;
                    }
                    else {
                        (_k = (_j = editor).layoutContentWidget) === null || _k === void 0 ? void 0 : _k.call(_j, askWidget);
                    }
                };
                (_m = editor.onDidChangeCursorSelection) === null || _m === void 0 ? void 0 : _m.call(editor, () => queueMicrotask(syncAsk));
                (_o = editor.onDidChangeModelContent) === null || _o === void 0 ? void 0 : _o.call(editor, () => hideAsk());
                (_q = (_p = editor).onDidChangeModel) === null || _q === void 0 ? void 0 : _q.call(_p, () => hideAsk());
                askButton = { hide: hideAsk, sync: syncAsk };
            }
            // Voice edit (⌥⌘V): speak the instruction; it goes to Axiom with the
            // selection as context. Its pill stands where the Ask button was.
            (_r = deps.voiceEdit) === null || _r === void 0 ? void 0 : _r.attachEditor(monacoWindow.monaco, editor, {
                getFilePath: () => group.currentFilePath,
                isDirty: () => Boolean(group.isDirty),
                onPillChange: (state) => {
                    voicePillShown = state === "shown";
                    // After a send the button stays away until the selection changes:
                    // the request is already out, and Axiom may be moving these lines.
                    if (state === "shown")
                        askButton === null || askButton === void 0 ? void 0 : askButton.hide();
                    else if (state === "hidden")
                        askButton === null || askButton === void 0 ? void 0 : askButton.sync();
                },
            });
            (_t = (_s = editor).addAction) === null || _t === void 0 ? void 0 : _t.call(_s, {
                id: "tex64.pro-canvas-edit",
                label: uiText("Edit in canvas", "キャンバスで編集"),
                contextMenuGroupId: "9_ai",
                contextMenuOrder: 2,
                run: () => {
                    var _a, _b, _c, _d;
                    const model = (_b = (_a = editor).getModel) === null || _b === void 0 ? void 0 : _b.call(_a);
                    const position = (_c = editor.getPosition) === null || _c === void 0 ? void 0 : _c.call(editor);
                    const lines = (_d = model === null || model === void 0 ? void 0 : model.getValue) === null || _d === void 0 ? void 0 : _d.call(model).split(/\r?\n/);
                    const decoded = lines && position ? decodeFigureBlockAt(lines, position.lineNumber - 1) : null;
                    if ((decoded === null || decoded === void 0 ? void 0 : decoded.detached) && !window.confirm(uiText("Discard manual edits and update from the canvas?", "手編集を破棄してキャンバスで更新しますか？")))
                        return;
                    window.dispatchEvent(new CustomEvent("tex64:pro-canvas-open", {
                        detail: decoded ? {
                            scene: decoded.scene,
                            replaceRange: { startLine: decoded.startLine + 1, endLine: decoded.endLine + 1 },
                        } : {},
                    }));
                },
            });
            // 図ブロックのメタデータ行は長いので、エディタ上では短いチップに畳む。
            installFigureMetaChips(editor);
            // Shared documents undo only this user's edits (Y.UndoManager); the
            // precondition keeps Monaco's own undo for everything else.
            if (deps.collab) {
                const KeyMod = (_u = monacoWindow.monaco) === null || _u === void 0 ? void 0 : _u.KeyMod;
                const KeyCode = (_v = monacoWindow.monaco) === null || _v === void 0 ? void 0 : _v.KeyCode;
                const collab = deps.collab;
                (_x = (_w = editor).addAction) === null || _x === void 0 ? void 0 : _x.call(_w, {
                    id: "tex64.collab.undo",
                    label: uiText("Undo", "取り消す"),
                    keybindings: KeyMod && KeyCode ? [KeyMod.CtrlCmd | KeyCode.KeyZ] : undefined,
                    precondition: "tex64CollabBound && !editorReadonly",
                    run: () => { collab.undo(editor); },
                });
                (_z = (_y = editor).addAction) === null || _z === void 0 ? void 0 : _z.call(_y, {
                    id: "tex64.collab.redo",
                    label: uiText("Redo", "やり直す"),
                    keybindings: KeyMod && KeyCode ? [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, KeyMod.CtrlCmd | KeyCode.KeyY] : undefined,
                    precondition: "tex64CollabBound && !editorReadonly",
                    run: () => { collab.redo(editor); },
                });
            }
            window.dispatchEvent(new CustomEvent("tex64:editor-created", { detail: { group: group.key } }));
            // Spell: "Add to dictionary" for the word under the cursor (context menu
            // / command palette). Done as an editor action because this Monaco build
            // has no editor.registerCommand for code-action commands.
            if (spellChecker) {
                (_1 = (_0 = editor).addAction) === null || _1 === void 0 ? void 0 : _1.call(_0, {
                    id: "tex64.spell.addWordToDictionary",
                    label: uiText("Add to dictionary", "辞書に追加"),
                    contextMenuGroupId: "9_spell",
                    contextMenuOrder: 1,
                    run: () => {
                        void spellChecker.addWordAtCursor(editor);
                    },
                });
            }
            // The right-click menu: grouped, translated, and with the items that
            // apply only somewhere shown only there. Draw (toolbar) still opens a
            // new canvas anywhere; the command palette still adds any word.
            installEditorContextMenu(editor, {
                applies: {
                    "tex64.spell.addWordToDictionary": () => {
                        var _a, _b, _c, _d, _e, _f, _g;
                        const model = (_b = (_a = editor).getModel) === null || _b === void 0 ? void 0 : _b.call(_a);
                        const position = (_c = editor.getPosition) === null || _c === void 0 ? void 0 : _c.call(editor);
                        if (!model || !position)
                            return false;
                        const markers = (_g = (_f = (_e = (_d = monacoWindow.monaco) === null || _d === void 0 ? void 0 : _d.editor) === null || _e === void 0 ? void 0 : _e.getModelMarkers) === null || _f === void 0 ? void 0 : _f.call(_e, { owner: "spell", resource: model.uri })) !== null && _g !== void 0 ? _g : [];
                        return markers.some((marker) => marker.startLineNumber === position.lineNumber &&
                            marker.startColumn <= position.column &&
                            position.column <= marker.endColumn);
                    },
                    "tex64.pro-canvas-edit": () => {
                        var _a, _b, _c, _d, _e;
                        const position = (_a = editor.getPosition) === null || _a === void 0 ? void 0 : _a.call(editor);
                        const lines = (_e = (_d = (_c = (_b = editor).getModel) === null || _c === void 0 ? void 0 : _c.call(_b)) === null || _d === void 0 ? void 0 : _d.getValue) === null || _e === void 0 ? void 0 : _e.call(_d).split(/\r?\n/);
                        return Boolean(lines && position && decodeFigureBlockAt(lines, position.lineNumber - 1));
                    },
                },
            });
        };
        if (editorHost instanceof HTMLElement) {
            createEditorForGroup(deps.editorSession.getEditorGroup("primary"), editorHost);
            deps.editorSession.openPendingFileIfReady();
        }
        if (editorHostSecondary instanceof HTMLElement) {
            createEditorForGroup(deps.editorSession.getEditorGroup("secondary"), editorHostSecondary);
        }
        editorSettings.subscribe((change) => {
            let options;
            if (change.kind === "font") {
                options = {
                    fontFamily: editorSettings.getFontFamily(),
                    fontSize: editorSettings.getFontSize(),
                    lineHeight: editorSettings.getLineHeight(),
                };
            }
            else if (change.kind === "flag" && change.id === "lsp.documentHighlight") {
                options = { occurrencesHighlight: change.value ? "singleFile" : "off" };
            }
            else {
                return;
            }
            deps.editorSession.forEachEditorGroup((group) => {
                var _a;
                const editor = group.editor;
                (_a = editor === null || editor === void 0 ? void 0 : editor.updateOptions) === null || _a === void 0 ? void 0 : _a.call(editor, options);
            });
        });
        document.body.classList.add("has-editor");
    }, () => {
        deps.updateFallback(uiText("Failed to load Monaco.", "Monacoを読み込めませんでした。"));
    });
    return api;
};
