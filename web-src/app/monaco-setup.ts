import type { AppContext } from "./context.js";
import { uiText } from "./i18n.js";
import type { IndexEntry } from "./types.js";
import type { EditorGroupKey, EditorSessionApi, EditorGroupState } from "./editor-session.js";
import { registerCompletionProvider } from "./monaco-completion.js";
import {
  registerHoverProvider,
  type HoverState,
} from "./monaco-hover.js";
import { registerTexLanguages } from "./monaco-language.js";
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
  openAiWithSelection?: () => void;
  getEditorWordWrapEnabled: () => boolean;
};

export type MonacoSetupApi = {
  setWordWrapEnabled: (enabled: boolean) => void;
};

export const initMonacoSetup = (
  context: AppContext,
  deps: MonacoSetupDeps
): MonacoSetupApi => {
  const { editorHost, editorHostSecondary } = context.dom;

  const completionState = { registered: false };
  const hoverState: HoverState = { registered: false };

  const setWordWrapEnabled = (enabled: boolean) => {
    const wordWrap = enabled ? "on" : "off";
    deps.editorSession.forEachEditorGroup((group) => {
      const editorAny = group.editor as { updateOptions?: (options: unknown) => void } | null;
      editorAny?.updateOptions?.({ wordWrap });
    });
  };

  const api: MonacoSetupApi = {
    setWordWrapEnabled,
  };

  if (!(editorHost instanceof HTMLElement)) {
    deps.updateFallback(uiText("Editor area not found.", "エディタ領域が見つかりません。"));
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
    deps.updateFallback(uiText("Monaco loader not found.", "Monacoのローダーが見つかりません。"));
    return;
  }

  monacoWindow.require.config({ paths: { vs: requireBase } });
  monacoWindow.require(
    ["vs/editor/editor.main"],
    () => {
      if (!monacoWindow.monaco || !monacoWindow.monaco.editor) {
        deps.updateFallback(uiText("Monaco initialization failed.", "Monacoの初期化に失敗しました。"));
        return;
      }

      deps.setMonacoApi(monacoWindow.monaco as Record<string, unknown>);
      registerTexLanguages(monacoWindow.monaco);
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
          trigger?: (source: string, handlerId: string, payload?: unknown) => void;
        };
        group.editor = editor;

        host.addEventListener(
          "keydown",
          (event) => {
            if (event.key !== "Tab") {
              return;
            }
            if (!document.querySelector(".suggest-widget.visible")) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            const command = event.shiftKey ? "selectPrevSuggestion" : "selectNextSuggestion";
            editorAny.trigger?.("tex64", command, {});
          },
          true
        );

        let hoverAnchorRafId: number | null = null;

        const updateHoverFixedAnchor = () => {
          const editorForHover = editor as any;
          const editorDomNode = editorForHover.getDomNode?.() as HTMLElement | null;
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
          deps.editorSession.setActiveGroup(group.key, { focusEditor: false });
          deps.fileTree.setTreeFocus(false);
        });
        editorAny.onDidBlurEditorWidget?.(() => {
          if (hoverAnchorRafId !== null) {
            window.cancelAnimationFrame(hoverAnchorRafId);
            hoverAnchorRafId = null;
          }
        });
        editor.onDidFocusEditorWidget?.(() => {
          scheduleHoverFixedAnchor();
        });
        editorAny.onDidScrollChange?.(() => {
          scheduleHoverFixedAnchor();
        });
        editor.onDidChangeModelContent((e: { isFlush?: boolean; isUndoing?: boolean; isRedoing?: boolean }) => {
          if (group.isApplyingFile) return;
          if (e.isFlush) return;
          if (!group.currentFilePath) return;
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
        editor.onDidChangeCursorPosition?.(
          (e: { position: { lineNumber: number; column: number } }) => {
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

        // C-1: Inline AI editing — Cmd+K to open AI panel with selection context
        if (deps.openAiWithSelection) {
          const KeyMod = (monacoWindow.monaco as any)?.KeyMod;
          const KeyCode = (monacoWindow.monaco as any)?.KeyCode;
          const openAi = deps.openAiWithSelection;
          if (KeyMod && KeyCode) {
            (editor as any).addAction?.({
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
      deps.updateFallback(uiText("Failed to load Monaco.", "Monacoの読み込みに失敗しました。"));
    }
  );

  return api;
};
