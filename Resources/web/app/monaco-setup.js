import { registerCompletionProvider } from "./monaco-completion.js";
import { registerHoverProvider, } from "./monaco-hover.js";
import { createInlineCompletionController } from "./monaco-inline.js";
import { registerTexLanguages } from "./monaco-language.js";
import { applyMonacoTheme } from "./monaco-theme.js";
const GHOST_COMPLETION_TEMP_DISABLED = true;
export const initMonacoSetup = (context, deps) => {
    const { editorHost, editorHostSecondary } = context.dom;
    const completionState = { registered: false };
    const hoverState = { registered: false };
    const isGhostCompletionEnabled = () => !GHOST_COMPLETION_TEMP_DISABLED && deps.getGhostCompletionEnabled();
    const inlineController = createInlineCompletionController({
        editorSession: deps.editorSession,
        getGhostCompletionEnabled: isGhostCompletionEnabled,
        getGhostCompletionConfig: deps.getGhostCompletionConfig,
        requestApiCompletion: deps.requestApiCompletion,
    });
    const ghostCaretControllers = [];
    const hideGhostCarets = (activeKey) => {
        ghostCaretControllers.forEach((controller) => {
            if (!activeKey || controller.key !== activeKey) {
                controller.hide();
            }
        });
    };
    const setInlineSuggestEnabled = (enabled) => {
        const resolvedEnabled = !GHOST_COMPLETION_TEMP_DISABLED && enabled;
        deps.editorSession.forEachEditorGroup((group) => {
            var _a;
            const editorAny = group.editor;
            (_a = editorAny === null || editorAny === void 0 ? void 0 : editorAny.updateOptions) === null || _a === void 0 ? void 0 : _a.call(editorAny, { inlineSuggest: { enabled: resolvedEnabled } });
        });
    };
    const setWordWrapEnabled = (enabled) => {
        const wordWrap = enabled ? "on" : "off";
        deps.editorSession.forEachEditorGroup((group) => {
            var _a;
            const editorAny = group.editor;
            (_a = editorAny === null || editorAny === void 0 ? void 0 : editorAny.updateOptions) === null || _a === void 0 ? void 0 : _a.call(editorAny, { wordWrap });
        });
    };
    const setGhostCompletionConfig = (config) => {
        inlineController.applyGhostCompletionConfig(config);
    };
    const api = {
        setInlineSuggestEnabled,
        setWordWrapEnabled,
        setGhostCompletionConfig,
    };
    if (!(editorHost instanceof HTMLElement)) {
        deps.updateFallback("エディタ領域が見つかりません。");
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
        deps.updateFallback("Monacoのローダーが見つかりません。");
        return;
    }
    monacoWindow.require.config({ paths: { vs: requireBase } });
    monacoWindow.require(["vs/editor/editor.main"], () => {
        if (!monacoWindow.monaco || !monacoWindow.monaco.editor) {
            deps.updateFallback("Monacoの初期化に失敗しました。");
            return;
        }
        deps.setMonacoApi(monacoWindow.monaco);
        registerTexLanguages(monacoWindow.monaco);
        registerCompletionProvider(monacoWindow.monaco, {
            getActiveFilePath: deps.editorSession.getActiveFilePath,
            getIndexLabels: deps.getIndexLabels,
            getIndexCitations: deps.getIndexCitations,
            getWorkspaceFiles: deps.getWorkspaceFiles,
        }, completionState);
        registerHoverProvider(monacoWindow.monaco, {
            getActiveFilePath: deps.editorSession.getActiveFilePath,
            getWorkspaceFiles: deps.getWorkspaceFiles,
            getIndexLabels: deps.getIndexLabels,
            getIndexCitations: deps.getIndexCitations,
            requestFilePreview: deps.requestFilePreview,
            requestFileExcerpt: deps.requestFileExcerpt,
        }, hoverState);
        if (!GHOST_COMPLETION_TEMP_DISABLED) {
            inlineController.registerInlineCompletionProvider(monacoWindow.monaco);
        }
        const themeName = applyMonacoTheme(monacoWindow.monaco);
        const editorOptions = {
            value: "",
            language: "latex",
            theme: themeName,
            automaticLayout: true,
            glyphMargin: true,
            minimap: { enabled: false },
            scrollbar: { verticalScrollbarSize: 18, horizontalScrollbarSize: 18 },
            fontFamily: '"SF Mono", "Hiragino Kaku Gothic ProN", "Hiragino Sans", Menlo, Monaco, "Courier New", monospace',
            fontSize: 12,
            lineHeight: 20,
            lineNumbersMinChars: 3,
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
            inlineSuggest: { enabled: isGhostCompletionEnabled() },
        };
        const createEditorForGroup = (group, host) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
            const editor = (_b = (_a = monacoWindow.monaco) === null || _a === void 0 ? void 0 : _a.editor) === null || _b === void 0 ? void 0 : _b.create(host, editorOptions);
            const editorAny = editor;
            group.editor = editor;
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
            const ghostCaretNode = document.createElement("div");
            ghostCaretNode.className = "monaco-ghost-caret";
            ghostCaretNode.style.height = `${editorOptions.lineHeight}px`;
            ghostCaretNode.setAttribute("aria-hidden", "true");
            let ghostCaretPosition = null;
            let ghostCaretVisible = false;
            let inlineAutoTriggerTimers = [];
            let hoverAnchorRafId = null;
            const ghostCaretPreference = (_f = (_e = (_d = (_c = monacoWindow.monaco) === null || _c === void 0 ? void 0 : _c.editor) === null || _d === void 0 ? void 0 : _d.ContentWidgetPositionPreference) === null || _e === void 0 ? void 0 : _e.EXACT) !== null && _f !== void 0 ? _f : 0;
            const ghostCaretWidget = {
                getId: () => `tex64-ghost-caret-${group.key}`,
                getDomNode: () => ghostCaretNode,
                getPosition: () => {
                    if (!ghostCaretVisible || !ghostCaretPosition) {
                        return null;
                    }
                    return {
                        position: ghostCaretPosition,
                        preference: [ghostCaretPreference],
                    };
                },
            };
            (_g = editorAny.addContentWidget) === null || _g === void 0 ? void 0 : _g.call(editorAny, ghostCaretWidget);
            const updateGhostCaretPosition = (position) => {
                var _a;
                if (!position) {
                    return;
                }
                ghostCaretPosition = {
                    lineNumber: position.lineNumber,
                    column: position.column,
                };
                if (ghostCaretVisible) {
                    (_a = editorAny.layoutContentWidget) === null || _a === void 0 ? void 0 : _a.call(editorAny, ghostCaretWidget);
                }
            };
            const hideGhostCaret = () => {
                var _a;
                if (!ghostCaretVisible) {
                    return;
                }
                ghostCaretVisible = false;
                (_a = editorAny.layoutContentWidget) === null || _a === void 0 ? void 0 : _a.call(editorAny, ghostCaretWidget);
            };
            const clearInlineAutoTrigger = () => {
                inlineAutoTriggerTimers.forEach((timerId) => {
                    window.clearTimeout(timerId);
                });
                inlineAutoTriggerTimers = [];
            };
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
            const scheduleInlineAutoTrigger = () => {
                clearInlineAutoTrigger();
                const config = deps.getGhostCompletionConfig();
                const baseDelay = Number.isFinite(config.debounceMs) && config.debounceMs >= 0
                    ? Math.round(config.debounceMs)
                    : 120;
                const delays = [baseDelay, Math.max(baseDelay + 120, 620)];
                delays.forEach((delay) => {
                    const timerId = window.setTimeout(() => {
                        var _a, _b, _c;
                        inlineAutoTriggerTimers = inlineAutoTriggerTimers.filter((id) => id !== timerId);
                        if (!isGhostCompletionEnabled()) {
                            return;
                        }
                        if (!deps.editorSession.isActiveGroup(group)) {
                            return;
                        }
                        if (!group.currentFilePath || !group.currentFilePath.endsWith(".tex")) {
                            return;
                        }
                        if (group.isComposing || deps.editorSession.isAnyGroupComposing()) {
                            return;
                        }
                        if (document.querySelector(".suggest-widget.visible")) {
                            return;
                        }
                        const hasTextFocus = (_b = (_a = editorAny).hasTextFocus) === null || _b === void 0 ? void 0 : _b.call(_a);
                        if (!hasTextFocus) {
                            return;
                        }
                        (_c = editorAny.trigger) === null || _c === void 0 ? void 0 : _c.call(editorAny, "tex64", "editor.action.inlineSuggest.trigger", {});
                    }, delay);
                    inlineAutoTriggerTimers.push(timerId);
                });
            };
            const showGhostCaret = () => {
                var _a, _b, _c;
                if (!deps.editorSession.isActiveGroup(group)) {
                    hideGhostCaret();
                    return;
                }
                if (!ghostCaretPosition) {
                    updateGhostCaretPosition((_b = (_a = editorAny.getPosition) === null || _a === void 0 ? void 0 : _a.call(editorAny)) !== null && _b !== void 0 ? _b : null);
                }
                if (!ghostCaretPosition) {
                    return;
                }
                if (ghostCaretVisible) {
                    return;
                }
                ghostCaretVisible = true;
                (_c = editorAny.layoutContentWidget) === null || _c === void 0 ? void 0 : _c.call(editorAny, ghostCaretWidget);
            };
            ghostCaretControllers.push({ key: group.key, hide: hideGhostCaret });
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
            (_h = editor.onDidFocusEditorWidget) === null || _h === void 0 ? void 0 : _h.call(editor, () => {
                hideGhostCarets(group.key);
                hideGhostCaret();
                deps.editorSession.setActiveGroup(group.key, { focusEditor: false });
                deps.fileTree.setTreeFocus(false);
            });
            (_j = editorAny.onDidBlurEditorWidget) === null || _j === void 0 ? void 0 : _j.call(editorAny, () => {
                var _a, _b;
                clearInlineAutoTrigger();
                if (hoverAnchorRafId !== null) {
                    window.cancelAnimationFrame(hoverAnchorRafId);
                    hoverAnchorRafId = null;
                }
                updateGhostCaretPosition((_b = (_a = editorAny.getPosition) === null || _a === void 0 ? void 0 : _a.call(editorAny)) !== null && _b !== void 0 ? _b : null);
                showGhostCaret();
            });
            (_k = editor.onDidFocusEditorWidget) === null || _k === void 0 ? void 0 : _k.call(editor, () => {
                scheduleHoverFixedAnchor();
            });
            (_l = editorAny.onDidScrollChange) === null || _l === void 0 ? void 0 : _l.call(editorAny, () => {
                var _a;
                if (ghostCaretVisible) {
                    (_a = editorAny.layoutContentWidget) === null || _a === void 0 ? void 0 : _a.call(editorAny, ghostCaretWidget);
                }
                scheduleHoverFixedAnchor();
            });
            editor.onDidChangeModelContent(() => {
                inlineController.recordInlineEdit();
                if (group.isApplyingFile) {
                    clearInlineAutoTrigger();
                    return;
                }
                if (!group.currentFilePath) {
                    clearInlineAutoTrigger();
                    return;
                }
                if (deps.editorSession.isActiveGroup(group) && group.currentFilePath.endsWith(".tex")) {
                    scheduleInlineAutoTrigger();
                }
                else {
                    clearInlineAutoTrigger();
                }
                const currentValue = editor.getValue();
                deps.editorSession.updateDirtyState(group.currentFilePath, currentValue);
                deps.editorTabs.render(group);
                if (deps.editorSession.isActiveGroup(group)) {
                    deps.editorSession.clearJumpHighlight(group);
                    deps.editorSession.updateBreadcrumbs();
                    deps.fileTree.render();
                    deps.editorSession.scheduleAutoSave();
                }
            });
            (_m = editor.onDidChangeCursorPosition) === null || _m === void 0 ? void 0 : _m.call(editor, (e) => {
                updateGhostCaretPosition(e.position);
                if (group.currentFilePath &&
                    group.currentFilePath.endsWith(".tex") &&
                    deps.editorSession.isActiveGroup(group)) {
                    deps.onCursorPositionChange(e.position);
                }
            });
            (_o = editor.onDidChangeCursorSelection) === null || _o === void 0 ? void 0 : _o.call(editor, (e) => {
                var _a;
                updateGhostCaretPosition({
                    lineNumber: e.selection.positionLineNumber,
                    column: e.selection.positionColumn,
                });
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
                const KeyMod = (_p = monacoWindow.monaco) === null || _p === void 0 ? void 0 : _p.KeyMod;
                const KeyCode = (_q = monacoWindow.monaco) === null || _q === void 0 ? void 0 : _q.KeyCode;
                const openAi = deps.openAiWithSelection;
                if (KeyMod && KeyCode) {
                    (_s = (_r = editor).addAction) === null || _s === void 0 ? void 0 : _s.call(_r, {
                        id: "tex64.ai-edit-selection",
                        label: "Axiomで編集",
                        keybindings: [KeyMod.CtrlCmd | KeyCode.KeyK],
                        contextMenuGroupId: "9_ai",
                        contextMenuOrder: 1,
                        precondition: "editorHasSelection",
                        run: () => { openAi(); },
                    });
                }
            }
        };
        if (editorHost instanceof HTMLElement) {
            createEditorForGroup(deps.editorSession.getEditorGroup("primary"), editorHost);
            deps.editorSession.openPendingFileIfReady();
        }
        if (editorHostSecondary instanceof HTMLElement) {
            createEditorForGroup(deps.editorSession.getEditorGroup("secondary"), editorHostSecondary);
        }
        document.body.classList.add("has-editor");
    }, () => {
        deps.updateFallback("Monacoの読み込みに失敗しました。");
    });
    return api;
};
