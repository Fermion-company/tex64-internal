import type { TabKey } from "./config.js";
import type { AppContext } from "./context.js";
import type { DiffContext } from "./diff-modal.js";
import type {
  IndexEntry,
  IssueItem,
  IssuesStatus,
  RootSource,
  SectionEntry,
} from "./types.js";

type WorkspaceUpdatePayload = {
  rootName: string;
  rootPath: string;
  files: string[];
  folders?: string[];
  rootFile?: string;
  rootSource?: RootSource;
};

type IndexUpdatePayload = {
  labels?: IndexEntry[];
  references?: IndexEntry[];
  citations?: IndexEntry[];
  sections?: SectionEntry[];
  figures?: IndexEntry[];
  tables?: IndexEntry[];
  todos?: IndexEntry[];
};

type WorkspaceControllerDeps = {
  setWorkspaceRootKey: (value: string | null) => void;
  setActiveTab: (tabKey: TabKey) => void;
  issuesUi: {
    render: (issues: IssueItem[]) => void;
  };
  editorSession: {
    clearIssueHighlight: () => void;
    syncWorkspaceFiles: (payload: { workspaceFiles: string[]; rootChanged: boolean }) => void;
    requestInitialOpen: () => void;
  };
  outlineUi: {
    render: () => void;
  };
  buildOps: {
    updateSynctexButtonState: () => void;
  };
  settingsUi: {
    refreshCompileEngine: () => void;
    loadWorkspaceSettings: () => void;
  };
  launcherUi: {
    setVisible: (value: boolean) => void;
    setStatus: (payload: { isBusy?: boolean; message?: string | null }) => void;
  };
  searchUi: {
    reset: (message?: string) => void;
  };

  diffModal: {
    setDiffContext: (context: DiffContext) => void;
  };
  envRegistry: {
    reload: (allowTabSwitch?: boolean) => void;
  };
  rootSelectorUi: {
    render: () => void;
  };
  setLastBuildMainFile: (path: string | null) => void;
};

export type WorkspaceControllerApi = {
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
  handleWorkspaceUpdate: (payload: WorkspaceUpdatePayload) => void;
  handleIndexUpdate: (payload: IndexUpdatePayload) => void;
  setPendingBuildIssuesFocus: (value: boolean) => void;
  getCurrentIssues: () => IssueItem[];
  getWorkspaceRootKey: () => string | null;
  getWorkspaceFiles: () => string[];
  getWorkspaceFolders: () => string[];
  getWorkspaceName: () => string;
  getRootFilePath: () => string | null;
  getRootSource: () => RootSource;
  getIndexLabels: () => IndexEntry[];
  getIndexCitations: () => IndexEntry[];
  getIndexSections: () => SectionEntry[];
  getIndexTodos: () => IndexEntry[];
  syncWorkspaceLabel: () => void;
};

export const initWorkspaceController = (
  context: AppContext,
  deps: WorkspaceControllerDeps
): WorkspaceControllerApi => {
  const {
    issuesTab,
    workspaceLabel,
    settingsWorkspace,
  } = context.dom;

  let currentIssues: IssueItem[] = [];
  let pendingBuildIssuesFocus = false;
  let indexLabels: IndexEntry[] = [];
  let indexCitations: IndexEntry[] = [];
  let indexSections: SectionEntry[] = [];
  let indexTodos: IndexEntry[] = [];
  let workspaceFiles: string[] = [];
  let workspaceFolders: string[] = [];
  let workspaceName = "ワークスペース未選択";
  let workspaceRootKey: string | null = null;
  let rootFilePath: string | null = null;
  let rootSource: RootSource = "auto";

  const setText = (element: HTMLElement | null, text: string) => {
    if (element) {
      element.textContent = text;
    }
  };

  const syncWorkspaceLabel = () => {
    setText(workspaceLabel, workspaceName);
  };

  const setWorkspaceLabel = (label: string) => {
    workspaceName = label;
    syncWorkspaceLabel();
  };

  const setIssuesStatus = (status: IssuesStatus) => {
    if (issuesTab instanceof HTMLElement) {
      issuesTab.dataset.status = status;
    }
  };

  const updateIssues = (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => {
    currentIssues = issues;
    setIssuesStatus(status);
    deps.issuesUi.render(issues);
    if (issuesTab instanceof HTMLElement) {
      const hasAlert = count > 0 && status === "error";
      issuesTab.classList.toggle("is-alert", hasAlert);
    }
    if (count === 0) {
      deps.editorSession.clearIssueHighlight();
    }
    if (pendingBuildIssuesFocus && count > 0 && status === "error") {
      pendingBuildIssuesFocus = false;
      deps.setActiveTab("issues");
    }
  };

  const handleWorkspaceUpdate = (payload: WorkspaceUpdatePayload) => {
    const previousRoot = workspaceRootKey;
    workspaceFiles = payload.files;
    workspaceFolders = Array.isArray(payload.folders) ? payload.folders : [];
    workspaceRootKey = payload.rootPath;
    deps.setWorkspaceRootKey(workspaceRootKey);
    setWorkspaceLabel(payload.rootName);
    setText(settingsWorkspace, payload.rootPath);

    deps.settingsUi.refreshCompileEngine();

    if (payload.rootPath) {
      deps.launcherUi.setVisible(false);
      deps.launcherUi.setStatus({ isBusy: false, message: null });
    }
    rootFilePath = payload.rootFile?.trim() ? payload.rootFile : null;
    rootSource =
      payload.rootSource === "manual" || payload.rootSource === "auto"
        ? payload.rootSource
        : "auto";
    deps.buildOps.updateSynctexButtonState();
    const rootChanged = Boolean(previousRoot && previousRoot !== payload.rootPath);
    if (rootChanged) {
      deps.setLastBuildMainFile(null);
    }
    deps.editorSession.syncWorkspaceFiles({ workspaceFiles, rootChanged });
    deps.searchUi.reset();

    deps.diffModal.setDiffContext(null);
    deps.settingsUi.loadWorkspaceSettings();
    deps.envRegistry.reload(false);
    deps.rootSelectorUi.render();
    deps.buildOps.updateSynctexButtonState();
    deps.editorSession.requestInitialOpen();
  };

  const handleIndexUpdate = (payload: IndexUpdatePayload) => {
    indexLabels = Array.isArray(payload.labels) ? payload.labels : [];
    indexCitations = Array.isArray(payload.citations) ? payload.citations : [];
    indexSections = Array.isArray(payload.sections) ? payload.sections : [];
    indexTodos = Array.isArray(payload.todos) ? payload.todos : [];
    deps.outlineUi.render();
  };

  return {
    updateIssues,
    handleWorkspaceUpdate,
    handleIndexUpdate,
    setPendingBuildIssuesFocus: (value) => {
      pendingBuildIssuesFocus = value;
    },
    getCurrentIssues: () => currentIssues,
    getWorkspaceRootKey: () => workspaceRootKey,
    getWorkspaceFiles: () => workspaceFiles,
    getWorkspaceFolders: () => workspaceFolders,
    getWorkspaceName: () => workspaceName,
    getRootFilePath: () => rootFilePath,
    getRootSource: () => rootSource,
    getIndexLabels: () => indexLabels,
    getIndexCitations: () => indexCitations,
    getIndexSections: () => indexSections,
    getIndexTodos: () => indexTodos,
    syncWorkspaceLabel,
  };
};
