import { attachSnippetEditor } from "./snippets-ui.js";
import { uiText } from "./i18n.js";
import { aiText } from "./ai-i18n.js";
import { registerHoverProvider, } from "./monaco-hover.js";
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
        var _a, _b, _c, _d;
        if (!monacoWindow.monaco || !monacoWindow.monaco.editor) {
            deps.updateFallback(uiText("Monaco initialization failed.", "Monacoの初期化に失敗しました。"));
            return;
        }
        deps.setMonacoApi(monacoWindow.monaco);
        registerTexLanguages(monacoWindow.monaco);
        // Completion is provided by texlab (see setupLsp below). The previous
        // hand-rolled \ref/\cite/path/\begin completion was removed to avoid
        // duplicate suggestions.
        registerHoverProvider(monacoWindow.monaco, {
            getActiveFilePath: deps.editorSession.getActiveFilePath,
            getWorkspaceFiles: deps.getWorkspaceFiles,
            getIndexLabels: deps.getIndexLabels,
            getIndexCitations: deps.getIndexCitations,
            requestFilePreview: deps.requestFilePreview,
            requestFileExcerpt: deps.requestFileExcerpt,
        }, hoverState);
        void setupLsp(monacoWindow.monaco, {
            getWorkspaceRoot: deps.getWorkspaceRoot,
        });
        const spellBridge = window.tex64Spell;
        const spellChecker = spellBridge ? new SpellChecker(monacoWindow.monaco, spellBridge) : null;
        spellChecker === null || spellChecker === void 0 ? void 0 : spellChecker.start();
        const codeCommentManager = createCodeCommentManager(monacoWindow.monaco, {
            getWorkspaceRoot: deps.getWorkspaceRoot,
        });
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
        (_b = (_a = document.fonts) === null || _a === void 0 ? void 0 : _a.ready) === null || _b === void 0 ? void 0 : _b.then(() => remeasureFonts()).catch(() => { });
        (_d = (_c = document.fonts) === null || _c === void 0 ? void 0 : _c.addEventListener) === null || _d === void 0 ? void 0 : _d.call(_c, "loadingdone", () => remeasureFonts());
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
            acceptSuggestionOnEnter: "on",
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
            occurrencesHighlight: false,
            selectionHighlight: false,
        };
        const createEditorForGroup = (group, host) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x;
            const editor = (_b = (_a = monacoWindow.monaco) === null || _a === void 0 ? void 0 : _a.editor) === null || _b === void 0 ? void 0 : _b.create(host, editorOptions);
            const editorAny = editor;
            group.editor = editor;
            attachEditorErgonomics(monacoWindow.monaco, editor, group);
            attachSelectionDragAutoScroll(monacoWindow.monaco, editor, host);
            codeCommentManager.attachToEditor(group);
            host.addEventListener("keydown", (event) => {
                var _a;
                if (event.key !== "Tab") {
                    return;
                }
                if (!document.querySelector(".suggest-widget.visible")) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                const command = event.shiftKey ? "selectPrevSuggestion" : "selectNextSuggestion";
                (_a = editorAny.trigger) === null || _a === void 0 ? void 0 : _a.call(editorAny, "tex64", command, {});
            }, true);
            let hoverAnchorRafId = null;
            const updateHoverFixedAnchor = () => {
                var _a;
                const editorForHover = editor;
                const editorDomNode = (_a = editorForHover.getDomNode) === null || _a === void 0 ? void 0 : _a.call(editorForHover);
                if (!editorDomNode) {
                    return;
                }
                const hostRect = editorDomNode.getBoundingClientRect();
                const top = Math.max(8, Math.round(hostRect.top + 10));
                const right = Math.max(8, Math.round(window.innerWidth - hostRect.right + 14));
                document.documentElement.style.setProperty("--tex64-hover-fixed-top", `${top}px`);
                document.documentElement.style.setProperty("--tex64-hover-fixed-right", `${right}px`);
            };
            const scheduleHoverFixedAnchor = () => {
                if (hoverAnchorRafId !== null) {
                    window.cancelAnimationFrame(hoverAnchorRafId);
                }
                hoverAnchorRafId = window.requestAnimationFrame(() => {
                    hoverAnchorRafId = null;
                    updateHoverFixedAnchor();
                });
            };
            window.addEventListener("resize", scheduleHoverFixedAnchor);
            updateHoverFixedAnchor();
            host.addEventListener("compositionstart", () => {
                group.isComposing = true;
                group.compositionText = "";
                group.composingFilePath = group.currentFilePath;
            });
            host.addEventListener("compositionupdate", (e) => {
                group.compositionText = e.data || "";
            });
            host.addEventListener("compositionend", (e) => {
                const data = e.data;
                if (!data && group.compositionText) {
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
                group.compositionText = "";
                group.isComposing = false;
                group.composingFilePath = null;
                deps.editorSession.handleCompositionEnd(group);
            });
            (_c = editor.onDidFocusEditorWidget) === null || _c === void 0 ? void 0 : _c.call(editor, () => {
                deps.editorSession.setActiveGroup(group.key, { focusEditor: false });
                deps.fileTree.setTreeFocus(false);
            });
            (_d = editorAny.onDidBlurEditorWidget) === null || _d === void 0 ? void 0 : _d.call(editorAny, () => {
                if (hoverAnchorRafId !== null) {
                    window.cancelAnimationFrame(hoverAnchorRafId);
                    hoverAnchorRafId = null;
                }
            });
            (_e = editor.onDidFocusEditorWidget) === null || _e === void 0 ? void 0 : _e.call(editor, () => {
                scheduleHoverFixedAnchor();
            });
            (_f = editorAny.onDidScrollChange) === null || _f === void 0 ? void 0 : _f.call(editorAny, () => {
                scheduleHoverFixedAnchor();
            });
            editor.onDidChangeModelContent((e) => {
                if (group.isApplyingFile)
                    return;
                if (e.isFlush)
                    return;
                if (!group.currentFilePath)
                    return;
                const currentValue = editor.getValue();
                deps.editorSession.updateDirtyState(group.currentFilePath, currentValue);
                deps.editorTabs.render(group);
                if (deps.editorSession.isActiveGroup(group)) {
                    deps.editorSession.clearJumpHighlight(group);
                    deps.editorSession.updateBreadcrumbs();
                    deps.fileTree.render();
                    if (!e.isUndoing && !e.isRedoing) {
                        deps.editorSession.scheduleAutoSave();
                    }
                }
            });
            (_g = editor.onDidChangeCursorPosition) === null || _g === void 0 ? void 0 : _g.call(editor, (e) => {
                if (group.currentFilePath &&
                    group.currentFilePath.endsWith(".tex") &&
                    deps.editorSession.isActiveGroup(group)) {
                    deps.onCursorPositionChange(e.position);
                }
            });
            (_h = editor.onDidChangeCursorSelection) === null || _h === void 0 ? void 0 : _h.call(editor, (e) => {
                var _a;
                if (group.currentFilePath &&
                    group.currentFilePath.endsWith(".tex") &&
                    deps.editorSession.isActiveGroup(group)) {
                    (_a = deps.onCursorSelectionChange) === null || _a === void 0 ? void 0 : _a.call(deps, {
                        lineNumber: e.selection.positionLineNumber,
                        column: e.selection.positionColumn,
                    });
                }
            });
            attachSnippetEditor(editor, monacoWindow.monaco);
            // Selection → Axiom: the context-menu entry (⌘K) and a small button
            // that floats at the end of a selection in a .tex file. Both open the
            // chat with the selection as its context.
            if (deps.openAiWithSelection) {
                const KeyMod = (_j = monacoWindow.monaco) === null || _j === void 0 ? void 0 : _j.KeyMod;
                const KeyCode = (_k = monacoWindow.monaco) === null || _k === void 0 ? void 0 : _k.KeyCode;
                const openAi = deps.openAiWithSelection;
                if (KeyMod && KeyCode) {
                    (_m = (_l = editor).addAction) === null || _m === void 0 ? void 0 : _m.call(_l, {
                        id: "tex64.ai-edit-selection",
                        label: aiText("ask_axiom"),
                        keybindings: [KeyMod.CtrlCmd | KeyCode.KeyK],
                        contextMenuGroupId: "9_ai",
                        contextMenuOrder: 1,
                        precondition: "editorHasSelection",
                        run: () => { openAi(); },
                    });
                }
                const preference = (_p = (_o = monacoWindow.monaco) === null || _o === void 0 ? void 0 : _o.editor) === null || _p === void 0 ? void 0 : _p.ContentWidgetPositionPreference;
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
                    const isTex = Boolean(group.currentFilePath && group.currentFilePath.endsWith(".tex"));
                    const empty = !selection || (typeof selection.isEmpty === "function" ? selection.isEmpty() : true);
                    const snippetActive = (_f = (_e = (_d = (_c = editor).getContribution) === null || _d === void 0 ? void 0 : _d.call(_c, "snippetController2")) === null || _e === void 0 ? void 0 : _e.isInSnippet) === null || _f === void 0 ? void 0 : _f.call(_e);
                    if (!isTex || empty || snippetActive) {
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
                (_q = editor.onDidChangeCursorSelection) === null || _q === void 0 ? void 0 : _q.call(editor, () => queueMicrotask(syncAsk));
                (_r = editor.onDidChangeModelContent) === null || _r === void 0 ? void 0 : _r.call(editor, () => hideAsk());
                (_t = (_s = editor).onDidChangeModel) === null || _t === void 0 ? void 0 : _t.call(_s, () => hideAsk());
            }
            (_v = (_u = editor).addAction) === null || _v === void 0 ? void 0 : _v.call(_u, {
                id: "tex64.pro-canvas-edit",
                label: uiText("Edit figure in canvas", "図をキャンバスで編集"),
                contextMenuGroupId: "9_ai",
                contextMenuOrder: 2,
                run: () => {
                    var _a, _b, _c, _d;
                    const model = (_b = (_a = editor).getModel) === null || _b === void 0 ? void 0 : _b.call(_a);
                    const position = (_c = editor.getPosition) === null || _c === void 0 ? void 0 : _c.call(editor);
                    const lines = (_d = model === null || model === void 0 ? void 0 : model.getValue) === null || _d === void 0 ? void 0 : _d.call(model).split(/\r?\n/);
                    const decoded = lines && position ? decodeFigureBlockAt(lines, position.lineNumber - 1) : null;
                    if ((decoded === null || decoded === void 0 ? void 0 : decoded.detached) && !window.confirm(uiText("This figure's code has been edited by hand. Updating it from the canvas will discard those edits. Continue?", "この図のコードは手編集されています。キャンバスで更新すると手編集分は失われます。続けますか？")))
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
            // Spell: "Add to dictionary" for the word under the cursor (context menu
            // / command palette). Done as an editor action because this Monaco build
            // has no editor.registerCommand for code-action commands.
            if (spellChecker) {
                (_x = (_w = editor).addAction) === null || _x === void 0 ? void 0 : _x.call(_w, {
                    id: "tex64.spell.addWordToDictionary",
                    label: uiText("Add word to dictionary", "単語を辞書に追加"),
                    contextMenuGroupId: "9_spell",
                    contextMenuOrder: 1,
                    run: () => {
                        void spellChecker.addWordAtCursor(editor);
                    },
                });
            }
        };
        if (editorHost instanceof HTMLElement) {
            createEditorForGroup(deps.editorSession.getEditorGroup("primary"), editorHost);
            deps.editorSession.openPendingFileIfReady();
        }
        if (editorHostSecondary instanceof HTMLElement) {
            createEditorForGroup(deps.editorSession.getEditorGroup("secondary"), editorHostSecondary);
        }
        // Apply font-family/size changes live across all editor groups.
        editorSettings.subscribe((change) => {
            if (change.kind !== "font") {
                return;
            }
            const fontFamily = editorSettings.getFontFamily();
            const fontSize = editorSettings.getFontSize();
            const lineHeight = editorSettings.getLineHeight();
            deps.editorSession.forEachEditorGroup((group) => {
                var _a;
                const editorAny = group.editor;
                (_a = editorAny === null || editorAny === void 0 ? void 0 : editorAny.updateOptions) === null || _a === void 0 ? void 0 : _a.call(editorAny, { fontFamily, fontSize, lineHeight });
            });
        });
        document.body.classList.add("has-editor");
    }, () => {
        deps.updateFallback(uiText("Failed to load Monaco.", "Monacoの読み込みに失敗しました。"));
    });
    return api;
};
