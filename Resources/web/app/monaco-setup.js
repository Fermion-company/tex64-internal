import { dedupeByKey, pickCitationEntries } from "./index-utils.js";
export const initMonacoSetup = (context, deps) => {
    const { editorHost, editorHostSecondary } = context.dom;
    let completionRegistered = false;
    const registerCompletionProvider = (monaco) => {
        var _a, _b, _c, _d, _e;
        if (completionRegistered || !((_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerCompletionItemProvider)) {
            return;
        }
        (_c = (_b = monaco.languages).register) === null || _c === void 0 ? void 0 : _c.call(_b, { id: "latex" });
        (_e = (_d = monaco.languages).register) === null || _e === void 0 ? void 0 : _e.call(_d, { id: "bibtex" });
        const provideItems = (model, position) => {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            const activePath = deps.editorSession.getActiveFilePath();
            if (!activePath || !activePath.endsWith(".tex")) {
                return { suggestions: [] };
            }
            const line = model.getLineContent(position.lineNumber);
            const linePrefix = line.slice(0, Math.max(position.column - 1, 0));
            const refMatch = linePrefix.match(/\\ref\{([^}]*)$/);
            const citeMatch = linePrefix.match(/\\cite\{([^}]*)$/);
            let entries = [];
            let partial = "";
            if (refMatch) {
                entries = dedupeByKey(deps.getIndexLabels());
                partial = (_a = refMatch[1]) !== null && _a !== void 0 ? _a : "";
            }
            else if (citeMatch) {
                entries = pickCitationEntries(deps.getIndexCitations());
                const raw = (_b = citeMatch[1]) !== null && _b !== void 0 ? _b : "";
                const parts = raw.split(",");
                partial = parts.length > 0 ? parts[parts.length - 1].trimStart() : "";
            }
            else {
                return { suggestions: [] };
            }
            const range = monaco.Range
                ? new monaco.Range(position.lineNumber, position.column - partial.length, position.lineNumber, position.column)
                : undefined;
            const kind = (_h = (_e = (_d = (_c = monaco.languages) === null || _c === void 0 ? void 0 : _c.CompletionItemKind) === null || _d === void 0 ? void 0 : _d.Reference) !== null && _e !== void 0 ? _e : (_g = (_f = monaco.languages) === null || _f === void 0 ? void 0 : _f.CompletionItemKind) === null || _g === void 0 ? void 0 : _g.Value) !== null && _h !== void 0 ? _h : 17;
            const suggestions = entries.map((entry) => ({
                label: entry.key,
                kind,
                insertText: entry.key,
                range,
                detail: entry.path,
            }));
            return { suggestions };
        };
        ["latex", "plaintext"].forEach((languageId) => {
            var _a, _b;
            (_b = (_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerCompletionItemProvider) === null || _b === void 0 ? void 0 : _b.call(_a, languageId, {
                triggerCharacters: ["{", ",", "\\"],
                provideCompletionItems: provideItems,
            });
        });
        completionRegistered = true;
    };
    if (!(editorHost instanceof HTMLElement)) {
        deps.updateFallback("エディタ領域が見つかりません。");
        return;
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
        var _a, _b, _c, _d;
        if (!monacoWindow.monaco || !monacoWindow.monaco.editor) {
            deps.updateFallback("Monacoの初期化に失敗しました。");
            return;
        }
        deps.setMonacoApi(monacoWindow.monaco);
        registerCompletionProvider(monacoWindow.monaco);
        const themeName = "tex64-deep-slate";
        const themeColors = {
            "editor.background": "#1A1D23",
            "editor.foreground": "#CDD1D9",
            "editorLineNumber.foreground": "#5C6370",
            "editorLineNumber.activeForeground": "#CDD1D9",
            "editorCursor.foreground": "#5C9CFF",
            "editor.selectionBackground": "#2F3642",
            "editor.inactiveSelectionBackground": "#252B35",
            "editor.selectionHighlightBackground": "rgba(92, 156, 255, 0.15)",
            "editor.lineHighlightBackground": "#1F2329",
            "editor.lineHighlightBorder": "#282C34",
            "editorIndentGuide.background": "#383E49",
            "editorIndentGuide.activeBackground": "#565C68",
            "editorWhitespace.foreground": "#383E49",
            "editorGutter.background": "#1A1D23",
            "editorWidget.background": "#262A32",
            "editorWidget.border": "#454C59",
            "editorHoverWidget.background": "#262A32",
            "editorHoverWidget.border": "#454C59",
            "editorSuggestWidget.background": "#262A32",
            "editorSuggestWidget.border": "#454C59",
            "editorSuggestWidget.foreground": "#CDD1D9",
            "editorSuggestWidget.selectedBackground": "rgba(92, 156, 255, 0.2)",
            "editorSuggestWidget.highlightForeground": "#5C9CFF",
            "editorBracketMatch.background": "rgba(92, 156, 255, 0.15)",
            "editorBracketMatch.border": "#5C9CFF",
            "editor.findMatchBackground": "rgba(92, 156, 255, 0.25)",
            "editor.findMatchHighlightBackground": "rgba(92, 156, 255, 0.15)",
            "editor.findRangeHighlightBackground": "rgba(92, 156, 255, 0.1)",
            "editor.wordHighlightBackground": "rgba(92, 156, 255, 0.1)",
            "editor.wordHighlightStrongBackground": "rgba(92, 156, 255, 0.15)",
            "editorError.foreground": "#D56A6A",
            "editorError.border": "#00000000",
            "editorOverviewRuler.border": "#00000000",
            "editorOverviewRuler.findMatchForeground": "#5C9CFF",
            "editorOverviewRuler.errorForeground": "#D56A6A",
            "editorMarkerNavigationError.background": "rgba(213, 106, 106, 0.1)",
            "editorGutter.errorForeground": "#C55A5A",
            "editorWarning.foreground": "#B89E52",
            "editorOverviewRuler.background": "#1A1D23",
            "scrollbar.shadow": "#000000",
            "scrollbarSlider.background": "rgba(255, 255, 255, 0.12)",
            "scrollbarSlider.hoverBackground": "rgba(255, 255, 255, 0.2)",
            "scrollbarSlider.activeBackground": "rgba(255, 255, 255, 0.28)",
            "editorRuler.foreground": "#383E49",
        };
        (_b = (_a = monacoWindow.monaco.editor).defineTheme) === null || _b === void 0 ? void 0 : _b.call(_a, themeName, {
            base: "vs-dark",
            inherit: true,
            rules: [],
            colors: themeColors,
        });
        (_d = (_c = monacoWindow.monaco.editor).setTheme) === null || _d === void 0 ? void 0 : _d.call(_c, themeName);
        const editorOptions = {
            value: "",
            language: "latex",
            theme: themeName,
            automaticLayout: true,
            glyphMargin: true,
            minimap: { enabled: false },
            scrollbar: { verticalScrollbarSize: 18, horizontalScrollbarSize: 18 },
            fontFamily: '"SF Mono", Menlo, monospace',
            fontSize: 13,
            lineHeight: 20,
            lineNumbersMinChars: 3,
            scrollBeyondLastLine: false,
            wordWrap: "off",
            wordBasedSuggestions: "off",
            quickSuggestions: false,
            suggestOnTriggerCharacters: true,
            occurrencesHighlight: false,
            selectionHighlight: false,
        };
        const createEditorForGroup = (group, host) => {
            var _a, _b, _c, _d, _e;
            const editor = (_b = (_a = monacoWindow.monaco) === null || _a === void 0 ? void 0 : _a.editor) === null || _b === void 0 ? void 0 : _b.create(host, editorOptions);
            group.editor = editor;
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
                        const editorAny = editor;
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
            editor.onDidChangeModelContent(() => {
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
            (_d = editor.onDidChangeCursorPosition) === null || _d === void 0 ? void 0 : _d.call(editor, (e) => {
                if (group.currentFilePath &&
                    group.currentFilePath.endsWith(".tex") &&
                    deps.editorSession.isActiveGroup(group)) {
                    deps.onCursorPositionChange(e.position);
                }
            });
            (_e = editor.onDidChangeCursorSelection) === null || _e === void 0 ? void 0 : _e.call(editor, (e) => {
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
};
