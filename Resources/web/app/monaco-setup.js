import { uiText } from "./i18n.js";
import { registerHoverProvider, } from "./monaco-hover.js";
import { registerTexLanguages } from "./monaco-language.js";
import { applyMonacoTheme } from "./monaco-theme.js";
import { getCurrentAppearanceTheme, onAppearanceThemeChange } from "./appearance.js";
import { setupLsp } from "./lsp/setup-lsp.js";
import { editorSettings } from "./editor-settings/editor-settings-store.js";
import { attachEditorErgonomics } from "./editor-ergonomics.js";
import { createCodeCommentManager } from "./code-comments.js";
import { SpellChecker } from "./spell/spell-check.js";
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
        const editorOptions = {
            value: "",
            language: "latex",
            theme: themeName,
            automaticLayout: true,
            glyphMargin: true,
            minimap: { enabled: false },
            scrollbar: { verticalScrollbarSize: 18, horizontalScrollbarSize: 18 },
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
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
            const editor = (_b = (_a = monacoWindow.monaco) === null || _a === void 0 ? void 0 : _a.editor) === null || _b === void 0 ? void 0 : _b.create(host, editorOptions);
            const editorAny = editor;
            group.editor = editor;
            attachEditorErgonomics(monacoWindow.monaco, editor, group);
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
            // C-1: Inline AI editing — Cmd+K to open AI panel with selection context
            if (deps.openAiWithSelection) {
                const KeyMod = (_j = monacoWindow.monaco) === null || _j === void 0 ? void 0 : _j.KeyMod;
                const KeyCode = (_k = monacoWindow.monaco) === null || _k === void 0 ? void 0 : _k.KeyCode;
                const openAi = deps.openAiWithSelection;
                if (KeyMod && KeyCode) {
                    (_m = (_l = editor).addAction) === null || _m === void 0 ? void 0 : _m.call(_l, {
                        id: "tex64.ai-edit-selection",
                        label: uiText("Edit with Axiom", "Axiomで編集"),
                        keybindings: [KeyMod.CtrlCmd | KeyCode.KeyK],
                        contextMenuGroupId: "9_ai",
                        contextMenuOrder: 1,
                        precondition: "editorHasSelection",
                        run: () => { openAi(); },
                    });
                }
            }
            // Spell: "Add to dictionary" for the word under the cursor (context menu
            // / command palette). Done as an editor action because this Monaco build
            // has no editor.registerCommand for code-action commands.
            if (spellChecker) {
                (_p = (_o = editor).addAction) === null || _p === void 0 ? void 0 : _p.call(_o, {
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
