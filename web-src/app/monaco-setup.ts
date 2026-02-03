import type { AppContext } from "./context.js";
import type { IndexEntry } from "./types.js";
import type { EditorGroupKey, EditorSessionApi, EditorGroupState } from "./editor-session.js";
import { registerCompletionProvider } from "./monaco-completion.js";
import { registerHoverProvider, type HoverState } from "./monaco-hover.js";
import { createInlineCompletionController } from "./monaco-inline.js";
import { applyMonacoTheme } from "./monaco-theme.js";

type FileExcerptResult =
  | { ok: true; path: string; startLine: number; lines: string[]; truncated?: boolean }
  | { ok: false; error?: string };

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
  getWorkspaceFiles: () => string[];
  requestFilePreview?: (
    path: string
  ) => Promise<{ ok: boolean; dataUrl?: string | null; error?: string }>;
  requestFileExcerpt?: (
    path: string,
    line: number,
    options?: { radius?: number; maxLines?: number }
  ) => Promise<FileExcerptResult>;
  onCursorPositionChange: (position: { lineNumber: number; column: number }) => void;
  onCursorSelectionChange?: (position: { lineNumber: number; column: number }) => void;
  getGhostCompletionEnabled: () => boolean;
  getGhostCompletionConfig: () => { debounceMs: number; maxChars: number };
  requestApiCompletion?: (payload: {
    prompt: string;
    prefix: string;
    maxOutputTokens: number;
    temperature: number;
    topP: number;
    topK: number;
    timeoutMs: number;
  }) => Promise<{ text: string | null }>;
};

export type MonacoSetupApi = {
  setInlineSuggestEnabled: (enabled: boolean) => void;
  setGhostCompletionConfig: (config: { debounceMs: number; maxChars: number }) => void;
};

export const initMonacoSetup = (
  context: AppContext,
  deps: MonacoSetupDeps
): MonacoSetupApi => {
  const { editorHost, editorHostSecondary } = context.dom;

  const completionState = { registered: false };
  const hoverState: HoverState = { registered: false };
  const inlineController = createInlineCompletionController({
    editorSession: deps.editorSession,
    getGhostCompletionEnabled: deps.getGhostCompletionEnabled,
    getGhostCompletionConfig: deps.getGhostCompletionConfig,
    requestApiCompletion: deps.requestApiCompletion,
  });
  const ghostCaretControllers: Array<{ key: EditorGroupKey; hide: () => void }> = [];

  const hideGhostCarets = (activeKey?: EditorGroupKey) => {
    ghostCaretControllers.forEach((controller) => {
      if (!activeKey || controller.key !== activeKey) {
        controller.hide();
      }
    });
  };

  const setInlineSuggestEnabled = (enabled: boolean) => {
    deps.editorSession.forEachEditorGroup((group) => {
      const editorAny = group.editor as { updateOptions?: (options: unknown) => void } | null;
      editorAny?.updateOptions?.({ inlineSuggest: { enabled } });
    });
  };

  const setGhostCompletionConfig = (config: { debounceMs: number; maxChars: number }) => {
    inlineController.applyGhostCompletionConfig(config);
  };

  const api: MonacoSetupApi = { setInlineSuggestEnabled, setGhostCompletionConfig };

  if (!(editorHost instanceof HTMLElement)) {
    deps.updateFallback("エディタ領域が見つかりません。");
    return api;
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
          registerInlineCompletionsProvider?: (
            languageId: string,
            provider: {
              provideInlineCompletions: (
                model: { getLineContent: (lineNumber: number) => string },
                position: { lineNumber: number; column: number },
                context?: { triggerKind?: number },
                token?: unknown
              ) =>
                | { items: Array<{ insertText: string; range?: unknown }> }
                | Promise<{ items: Array<{ insertText: string; range?: unknown }> }>;
              freeInlineCompletions?: (completions: unknown) => void;
            }
          ) => void;
          CompletionItemKind?: { Reference?: number; Value?: number };
          InlineCompletionTriggerKind?: { Automatic?: number };
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
      registerCompletionProvider(
        monacoWindow.monaco,
        {
          getActiveFilePath: deps.editorSession.getActiveFilePath,
          getIndexLabels: deps.getIndexLabels,
          getIndexCitations: deps.getIndexCitations,
          getWorkspaceFiles: deps.getWorkspaceFiles,
        },
        completionState
      );
      registerHoverProvider(
        monacoWindow.monaco,
        {
          getActiveFilePath: deps.editorSession.getActiveFilePath,
          getWorkspaceFiles: deps.getWorkspaceFiles,
          getIndexLabels: deps.getIndexLabels,
          getIndexCitations: deps.getIndexCitations,
          requestFilePreview: deps.requestFilePreview,
          requestFileExcerpt: deps.requestFileExcerpt,
        },
        hoverState
      );
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

  return api;
};
