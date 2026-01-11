import type { AppContext } from "./context.js";
import type { IndexEntry } from "./types.js";
import type { EditorGroupKey, EditorSessionApi, EditorGroupState } from "./editor-session.js";
import { dedupeByKey, pickCitationEntries } from "./index-utils.js";

type MonacoSetupDeps = {
  editorSession: EditorSessionApi;
  editorTabs: {
    render: (group: EditorGroupState) => void;
  };
  fileTree: {
    render: () => void;
    setTreeFocus: (focus: boolean) => void;
  };
  updateFallback: (message: string) => void;
  setMonacoApi: (api: Record<string, unknown>) => void;
  getIndexLabels: () => IndexEntry[];
  getIndexCitations: () => IndexEntry[];
  onCursorPositionChange: (position: { lineNumber: number; column: number }) => void;
  onCursorSelectionChange?: (position: { lineNumber: number; column: number }) => void;
};

export const initMonacoSetup = (context: AppContext, deps: MonacoSetupDeps) => {
  const { editorHost, editorHostSecondary } = context.dom;

  let completionRegistered = false;
  const ghostCaretControllers: Array<{ key: EditorGroupKey; hide: () => void }> = [];

  const hideGhostCarets = (activeKey?: EditorGroupKey) => {
    ghostCaretControllers.forEach((controller) => {
      if (!activeKey || controller.key !== activeKey) {
        controller.hide();
      }
    });
  };

  const registerCompletionProvider = (monaco: {
    languages?: {
      register?: (config: { id: string }) => void;
      registerCompletionItemProvider?: (
        languageId: string,
        provider: {
          triggerCharacters?: string[];
          provideCompletionItems: (
            model: { getLineContent: (lineNumber: number) => string },
            position: { lineNumber: number; column: number }
          ) => { suggestions: unknown[] };
        }
      ) => void;
      CompletionItemKind?: { Reference?: number; Value?: number };
    };
    Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
  }) => {
    if (completionRegistered || !monaco.languages?.registerCompletionItemProvider) {
      return;
    }
    monaco.languages.register?.({ id: "latex" });
    monaco.languages.register?.({ id: "bibtex" });

    const provideItems = (
      model: { getLineContent: (lineNumber: number) => string },
      position: { lineNumber: number; column: number }
    ) => {
      const activePath = deps.editorSession.getActiveFilePath();
      if (!activePath || !activePath.endsWith(".tex")) {
        return { suggestions: [] };
      }
      const line = model.getLineContent(position.lineNumber);
      const linePrefix = line.slice(0, Math.max(position.column - 1, 0));
      const refMatch = linePrefix.match(/\\ref\{([^}]*)$/);
      const citeMatch = linePrefix.match(/\\cite\{([^}]*)$/);

      let entries: IndexEntry[] = [];
      let partial = "";

      if (refMatch) {
        entries = dedupeByKey(deps.getIndexLabels());
        partial = refMatch[1] ?? "";
      } else if (citeMatch) {
        entries = pickCitationEntries(deps.getIndexCitations());
        const raw = citeMatch[1] ?? "";
        const parts = raw.split(",");
        partial = parts.length > 0 ? parts[parts.length - 1].trimStart() : "";
      } else {
        return { suggestions: [] };
      }

      const range = monaco.Range
        ? new monaco.Range(
            position.lineNumber,
            position.column - partial.length,
            position.lineNumber,
            position.column
          )
        : undefined;

      const kind =
        monaco.languages?.CompletionItemKind?.Reference ??
        monaco.languages?.CompletionItemKind?.Value ??
        17;

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
      monaco.languages?.registerCompletionItemProvider?.(languageId, {
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

  type RequireConfig = { paths: { vs: string } };
  type RequireFunction = ((
    deps: string[],
    onLoad: () => void,
    onError: () => void
  ) => void) & { config: (options: RequireConfig) => void };

  type MonacoTheme = {
    base: string;
    inherit: boolean;
    rules: unknown[];
    colors: Record<string, string>;
  };

  type MonacoWindow = Window &
    typeof globalThis & {
      MonacoEnvironment?: { getWorkerUrl: () => string };
      require?: RequireFunction;
      monaco?: {
        editor?: {
          create: (el: HTMLElement, options: Record<string, unknown>) => unknown;
          defineTheme?: (name: string, theme: MonacoTheme) => void;
          setTheme?: (name: string) => void;
        };
        languages?: {
          register?: (config: { id: string }) => void;
          registerCompletionItemProvider?: (
            languageId: string,
            provider: {
              triggerCharacters?: string[];
              provideCompletionItems: (
                model: { getLineContent: (lineNumber: number) => string },
                position: { lineNumber: number; column: number }
              ) => { suggestions: unknown[] };
            }
          ) => void;
          CompletionItemKind?: { Reference?: number; Value?: number };
        };
        Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
      };
    };

  const monacoWindow = window as MonacoWindow;

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
  monacoWindow.require(
    ["vs/editor/editor.main"],
    () => {
      if (!monacoWindow.monaco || !monacoWindow.monaco.editor) {
        deps.updateFallback("Monacoの初期化に失敗しました。");
        return;
      }

      deps.setMonacoApi(monacoWindow.monaco as Record<string, unknown>);
      registerCompletionProvider(monacoWindow.monaco);
      const themeName = "tex64-deep-slate";
      const themeColors: Record<string, string> = {
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
      monacoWindow.monaco.editor.defineTheme?.(themeName, {
        base: "vs-dark",
        inherit: true,
        rules: [],
        colors: themeColors,
      });
      monacoWindow.monaco.editor.setTheme?.(themeName);
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
      };

      const createEditorForGroup = (group: EditorGroupState, host: HTMLElement) => {
        const editor = monacoWindow.monaco?.editor?.create(host, editorOptions) as {
          addContentWidget?: (widget: {
            getId: () => string;
            getDomNode: () => HTMLElement;
            getPosition: () =>
              | { position: { lineNumber: number; column: number }; preference: number[] }
              | null;
          }) => void;
          layoutContentWidget?: (widget: {
            getId: () => string;
            getDomNode: () => HTMLElement;
            getPosition: () =>
              | { position: { lineNumber: number; column: number }; preference: number[] }
              | null;
          }) => void;
          onDidChangeModelContent: (listener: () => void) => void;
          onDidChangeCursorPosition?: (
            listener: (event: { position: { lineNumber: number; column: number } }) => void
          ) => void;
          onDidChangeCursorSelection?: (
            listener: (event: {
              selection: { positionLineNumber: number; positionColumn: number };
            }) => void
          ) => void;
          onDidBlurEditorWidget?: (listener: () => void) => void;
          onDidFocusEditorWidget?: (listener: () => void) => void;
          onDidScrollChange?: (listener: () => void) => void;
          executeEdits?: (
            source: string,
            edits: Array<{ range: unknown; text: string; forceMoveMarkers?: boolean }>
          ) => void;
          getPosition?: () => { lineNumber: number; column: number } | null;
          getSelection?: () => unknown | null;
          getValue: () => string;
          focus?: () => void;
        } & any;
        const editorAny = editor as {
          addContentWidget?: (widget: {
            getId: () => string;
            getDomNode: () => HTMLElement;
            getPosition: () =>
              | { position: { lineNumber: number; column: number }; preference: number[] }
              | null;
          }) => void;
          layoutContentWidget?: (widget: {
            getId: () => string;
            getDomNode: () => HTMLElement;
            getPosition: () =>
              | { position: { lineNumber: number; column: number }; preference: number[] }
              | null;
          }) => void;
          onDidBlurEditorWidget?: (listener: () => void) => void;
          onDidScrollChange?: (listener: () => void) => void;
          getPosition?: () => { lineNumber: number; column: number } | null;
          getSelection?: () => unknown | null;
          executeEdits?: (
            source: string,
            edits: Array<{ range: unknown; text: string; forceMoveMarkers?: boolean }>
          ) => void;
        };
        group.editor = editor;

        const ghostCaretNode = document.createElement("div");
        ghostCaretNode.className = "monaco-ghost-caret";
        ghostCaretNode.style.height = `${editorOptions.lineHeight}px`;
        ghostCaretNode.setAttribute("aria-hidden", "true");

        let ghostCaretPosition: { lineNumber: number; column: number } | null = null;
        let ghostCaretVisible = false;
        const ghostCaretPreference =
          (monacoWindow.monaco as any)?.editor?.ContentWidgetPositionPreference?.EXACT ?? 0;
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
        editorAny.addContentWidget?.(ghostCaretWidget);

        const updateGhostCaretPosition = (
          position?: { lineNumber: number; column: number } | null
        ) => {
          if (!position) {
            return;
          }
          ghostCaretPosition = {
            lineNumber: position.lineNumber,
            column: position.column,
          };
          if (ghostCaretVisible) {
            editorAny.layoutContentWidget?.(ghostCaretWidget);
          }
        };

        const hideGhostCaret = () => {
          if (!ghostCaretVisible) {
            return;
          }
          ghostCaretVisible = false;
          editorAny.layoutContentWidget?.(ghostCaretWidget);
        };

        const showGhostCaret = () => {
          if (!deps.editorSession.isActiveGroup(group)) {
            hideGhostCaret();
            return;
          }
          if (!ghostCaretPosition) {
            updateGhostCaretPosition(editorAny.getPosition?.() ?? null);
          }
          if (!ghostCaretPosition) {
            return;
          }
          if (ghostCaretVisible) {
            return;
          }
          ghostCaretVisible = true;
          editorAny.layoutContentWidget?.(ghostCaretWidget);
        };

        ghostCaretControllers.push({ key: group.key, hide: hideGhostCaret });
        if (context.isE2E) {
          if (group.key === "primary") {
            (window as { __tex64Editor?: unknown }).__tex64Editor = editor;
          } else {
            (window as { __tex64SecondaryEditor?: unknown }).__tex64SecondaryEditor = editor;
          }
        }
        host.addEventListener("compositionstart", () => {
          group.isComposing = true;
          group.compositionText = "";
          group.composingFilePath = group.currentFilePath;
        });
        host.addEventListener("compositionupdate", (e) => {
          group.compositionText = (e as CompositionEvent).data || "";
        });
        host.addEventListener("compositionend", (e) => {
          const data = (e as CompositionEvent).data;
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
        editor.onDidFocusEditorWidget?.(() => {
          hideGhostCarets(group.key);
          hideGhostCaret();
          deps.editorSession.setActiveGroup(group.key, { focusEditor: false });
          deps.fileTree.setTreeFocus(false);
        });
        editorAny.onDidBlurEditorWidget?.(() => {
          updateGhostCaretPosition(editorAny.getPosition?.() ?? null);
          showGhostCaret();
        });
        editorAny.onDidScrollChange?.(() => {
          if (ghostCaretVisible) {
            editorAny.layoutContentWidget?.(ghostCaretWidget);
          }
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
        editor.onDidChangeCursorPosition?.(
          (e: { position: { lineNumber: number; column: number } }) => {
            updateGhostCaretPosition(e.position);
            if (
              group.currentFilePath &&
              group.currentFilePath.endsWith(".tex") &&
              deps.editorSession.isActiveGroup(group)
            ) {
              deps.onCursorPositionChange(e.position);
            }
          }
        );
        editor.onDidChangeCursorSelection?.(
          (e: { selection: { positionLineNumber: number; positionColumn: number } }) => {
            updateGhostCaretPosition({
              lineNumber: e.selection.positionLineNumber,
              column: e.selection.positionColumn,
            });
            if (
              group.currentFilePath &&
              group.currentFilePath.endsWith(".tex") &&
              deps.editorSession.isActiveGroup(group)
            ) {
              deps.onCursorSelectionChange?.({
                lineNumber: e.selection.positionLineNumber,
                column: e.selection.positionColumn,
              });
            }
          }
        );
      };

      if (editorHost instanceof HTMLElement) {
        createEditorForGroup(deps.editorSession.getEditorGroup("primary"), editorHost);
        deps.editorSession.openPendingFileIfReady();
      }
      if (editorHostSecondary instanceof HTMLElement) {
        createEditorForGroup(deps.editorSession.getEditorGroup("secondary"), editorHostSecondary);
      }

      document.body.classList.add("has-editor");
    },
    () => {
      deps.updateFallback("Monacoの読み込みに失敗しました。");
    }
  );
};
