import { registerCompletionProvider } from "./monaco-completion.js";
import { registerHoverProvider } from "./monaco-hover.js";
import { createInlineCompletionController } from "./monaco-inline.js";
import { applyMonacoTheme } from "./monaco-theme.js";
export const initMonacoSetup = (context, deps) => {
    const { editorHost, editorHostSecondary } = context.dom;
    const completionState = { registered: false };
    const hoverState = { registered: false };
    const inlineController = createInlineCompletionController({
        editorSession: deps.editorSession,
        getGhostCompletionEnabled: deps.getGhostCompletionEnabled,
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
        deps.editorSession.forEachEditorGroup((group) => {
            var _a;
            const editorAny = group.editor;
            (_a = editorAny === null || editorAny === void 0 ? void 0 : editorAny.updateOptions) === null || _a === void 0 ? void 0 : _a.call(editorAny, { inlineSuggest: { enabled } });
        });
    };
    const setGhostCompletionConfig = (config) => {
        inlineController.applyGhostCompletionConfig(config);
    };
    const api = { setInlineSuggestEnabled, setGhostCompletionConfig };
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
        inlineController.registerInlineCompletionProvider(monacoWindow.monaco);
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
            wordWrap: "off",
            wordBasedSuggestions: "off",
            quickSuggestions: false,
            suggestOnTriggerCharacters: true,
            occurrencesHighlight: false,
            selectionHighlight: false,
            inlineSuggest: { enabled: deps.getGhostCompletionEnabled() },
        };
        const createEditorForGroup = (group, host) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
            const editor = (_b = (_a = monacoWindow.monaco) === null || _a === void 0 ? void 0 : _a.editor) === null || _b === void 0 ? void 0 : _b.create(host, editorOptions);
            const editorAny = editor;
            group.editor = editor;
            const ghostCaretNode = document.createElement("div");
            ghostCaretNode.className = "monaco-ghost-caret";
            ghostCaretNode.style.height = `${editorOptions.lineHeight}px`;
            ghostCaretNode.setAttribute("aria-hidden", "true");
            let ghostCaretPosition = null;
            let ghostCaretVisible = false;
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
            if (context.isE2E) {
                if (group.key === "primary") {
                    window.__tex64Editor = editor;
                }
                else {
                    window.__tex64SecondaryEditor = editor;
                }
            }
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
                updateGhostCaretPosition((_b = (_a = editorAny.getPosition) === null || _a === void 0 ? void 0 : _a.call(editorAny)) !== null && _b !== void 0 ? _b : null);
                showGhostCaret();
            });
            (_k = editorAny.onDidScrollChange) === null || _k === void 0 ? void 0 : _k.call(editorAny, () => {
                var _a;
                if (ghostCaretVisible) {
                    (_a = editorAny.layoutContentWidget) === null || _a === void 0 ? void 0 : _a.call(editorAny, ghostCaretWidget);
                }
            });
            editor.onDidChangeModelContent(() => {
                inlineController.recordInlineEdit();
                if (group.isApplyingFile) {
                    return;
                }
                if (!group.currentFilePath) {
                    return;
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
            (_l = editor.onDidChangeCursorPosition) === null || _l === void 0 ? void 0 : _l.call(editor, (e) => {
                updateGhostCaretPosition(e.position);
                if (group.currentFilePath &&
                    group.currentFilePath.endsWith(".tex") &&
                    deps.editorSession.isActiveGroup(group)) {
                    deps.onCursorPositionChange(e.position);
                }
            });
            (_m = editor.onDidChangeCursorSelection) === null || _m === void 0 ? void 0 : _m.call(editor, (e) => {
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
