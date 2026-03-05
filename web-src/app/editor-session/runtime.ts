import type { AppContext } from "../context.js";
import type { FileOpsState } from "../editor-session-file-ops.js";
import type {
  EditorGroupKey,
  EditorGroupState,
  EditorSessionDeps,
  MonacoModel,
  MonacoModelEntry,
} from "./types.js";

export type EditorSessionRuntime = {
  context: AppContext;
  deps: EditorSessionDeps;
  dom: {
    editorGroupsRootEl: HTMLElement | null;
    editorSplitButton: HTMLElement | null;
    editorSplitter: HTMLElement | null;
  };
  editorGroups: Record<EditorGroupKey, EditorGroupState>;
  state: {
    activeEditorGroup: EditorGroupKey;
    splitViewEnabled: boolean;
    splitRatioKey: string;
    splitRatio: number;
    layoutFrame: number | null;
    pendingAutoOpenPath: string | null;
    issueDecorations: string[];
    issueDecorationGroup: EditorGroupKey | null;
  };
  fileOpsState: FileOpsState;
  jumpDecorations: Record<EditorGroupKey, string[]>;
  jumpDecorationClassNames: Record<EditorGroupKey, string | null>;
  issueHighlightClassNames: Set<string>;
  lastCursorPositions: Map<string, { line: number; column: number }>;
  monacoModels: Map<string, MonacoModelEntry>;
  dirtyFiles: Set<string>;
  emptyEditorModel: MonacoModel | null;
};

export const createEditorSessionRuntime = (context: AppContext, deps: EditorSessionDeps): EditorSessionRuntime => {
  const {
    editorGroups: editorGroupsRoot,
    editorTabs,
    editorTabsList,
    editorTabsSecondary,
    editorTabsListSecondary,
    editorHost,
    editorHostSecondary,
    editorSplitButton,
    editorSplitter,
  } = context.dom;

  const editorGroupsRootEl = editorGroupsRoot instanceof HTMLElement ? editorGroupsRoot : null;
  const editorGroupPrimary =
    editorGroupsRootEl?.querySelector<HTMLElement>('[data-editor-group="primary"]') ?? null;
  const editorGroupSecondary =
    editorGroupsRootEl?.querySelector<HTMLElement>('[data-editor-group="secondary"]') ?? null;

  const editorGroups: Record<EditorGroupKey, EditorGroupState> = {
    primary: {
      key: "primary",
      root: editorGroupPrimary,
      tabs: editorTabs,
      tabsList: editorTabsList,
      editorHost,
      viewer: context.viewers.primary,
      editor: null,
      openTabs: [],
      currentFilePath: null,
      currentFileSavedContent: null,
      isDirty: false,
      viewStates: new Map(),
      isApplyingFile: false,
      isComposing: false,
      compositionText: "",
      composingFilePath: null,
      pendingCompositionAction: null,
    },
    secondary: {
      key: "secondary",
      root: editorGroupSecondary,
      tabs: editorTabsSecondary,
      tabsList: editorTabsListSecondary,
      editorHost: editorHostSecondary,
      viewer: context.viewers.secondary,
      editor: null,
      openTabs: [],
      currentFilePath: null,
      currentFileSavedContent: null,
      isDirty: false,
      viewStates: new Map(),
      isApplyingFile: false,
      isComposing: false,
      compositionText: "",
      composingFilePath: null,
      pendingCompositionAction: null,
    },
  };

  const fileOpsState: FileOpsState = {
    pendingOpenRequests: [],
    pendingReveal: null,
    pendingSave: null,
    autoSaveTimer: null,
    autoSavePending: false,
  };

  return {
    context,
    deps,
    dom: {
      editorGroupsRootEl,
      editorSplitButton: editorSplitButton instanceof HTMLElement ? editorSplitButton : null,
      editorSplitter: editorSplitter instanceof HTMLElement ? editorSplitter : null,
    },
    editorGroups,
    state: {
      activeEditorGroup: "primary",
      splitViewEnabled: false,
      splitRatioKey: "tex64.editorSplitRatio",
      splitRatio: 0.5,
      layoutFrame: null,
      pendingAutoOpenPath: null,
      issueDecorations: [],
      issueDecorationGroup: null,
    },
    fileOpsState,
    jumpDecorations: {
      primary: [],
      secondary: [],
    },
    jumpDecorationClassNames: {
      primary: null,
      secondary: null,
    },
    issueHighlightClassNames: new Set(["issue-line-warning", "issue-line-highlight"]),
    lastCursorPositions: new Map(),
    monacoModels: new Map(),
    dirtyFiles: new Set(),
    emptyEditorModel: null,
  };
};

