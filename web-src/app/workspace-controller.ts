import type { TabKey } from "./config.js";
import type { AppContext } from "./context.js";
import type { DiffContext } from "./diff-modal.js";
import { getUiLocale } from "./i18n.js";
import type {
  IndexEntry,
  IssueItem,
  IssuesStatus,
  RootSource,
  SectionEntry,
  BuildProfile,
} from "./types.js";

type WorkspaceUpdatePayload = {
  rootName: string;
  rootPath: string;
  files: string[];
  folders?: string[];
  rootFile?: string;
  rootSource?: RootSource;
  buildProfiles?: BuildProfile[];
  buildProfileId?: string;
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
  getActiveTab: () => TabKey;
  setActiveTab: (tabKey: TabKey) => void;
  issuesUi: {
    render: (issues: IssueItem[]) => void;
  };
  editorSession: {
    clearIssueHighlight: () => void;
    syncIssueMarkers: (issues: IssueItem[]) => void;
    syncWorkspaceFiles: (payload: { workspaceFiles: string[]; rootChanged: boolean }) => void;
    requestInitialOpen: () => void;
    saveDirtyFiles: () => Promise<boolean>;
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
  getBuildProfiles: () => BuildProfile[];
  getBuildProfileId: () => string | null;
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
  let baseIssues: IssueItem[] = [];
  let duplicateLabelIssues: IssueItem[] = [];
  let pendingBuildIssuesFocus = false;
  let indexLabels: IndexEntry[] = [];
  let indexCitations: IndexEntry[] = [];
  let indexSections: SectionEntry[] = [];
  let indexTodos: IndexEntry[] = [];
  let workspaceFiles: string[] = [];
  let workspaceFolders: string[] = [];
  let workspaceName = "No workspace selected";
  let workspaceRootKey: string | null = null;
  let rootFilePath: string | null = null;
  let rootSource: RootSource = "auto";
  let buildProfiles: BuildProfile[] = [];
  let buildProfileId: string | null = null;

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

  const getIssueLocationRank = (issue: IssueItem) => {
    const hasPath = typeof issue.path === "string" && issue.path.trim().length > 0;
    const lineValue = typeof issue.line === "number" ? issue.line : Number.NaN;
    const hasLine = Number.isFinite(lineValue) && lineValue > 0;
    if (hasPath && hasLine) {
      return 0;
    }
    if (hasPath) {
      return 1;
    }
    if (hasLine) {
      return 2;
    }
    return 3;
  };

  const isDuplicateLabelIssue = (issue: IssueItem) =>
    issue.severity === "warning" && issue.message.startsWith("Duplicate label:");

  const computeDuplicateLabelIssues = (labels: IndexEntry[]) => {
    if (!Array.isArray(labels) || labels.length === 0) {
      return [];
    }
    const byKey = new Map<string, IndexEntry[]>();
    labels.forEach((entry) => {
      if (!entry || typeof entry.key !== "string" || typeof entry.path !== "string") {
        return;
      }
      const key = entry.key.trim();
      if (!key) {
        return;
      }
      const list = byKey.get(key);
      if (list) {
        list.push(entry);
      } else {
        byKey.set(key, [entry]);
      }
    });
    const keys = Array.from(byKey.keys()).sort((a, b) => a.localeCompare(b, getUiLocale()));
    const issues: IssueItem[] = [];
    const maxLocationsShown = 4;
    for (const key of keys) {
      const entries = byKey.get(key) ?? [];
      if (entries.length <= 1) {
        continue;
      }
      entries.sort((a, b) => {
        if (a.path !== b.path) {
          return a.path.localeCompare(b.path, getUiLocale());
        }
        return a.line - b.line;
      });
      const locations = entries.map((entry) => `${entry.path}:${entry.line}`);
      const shown = locations.slice(0, maxLocationsShown).join(", ");
      const rest = locations.length > maxLocationsShown ? ` +${locations.length - maxLocationsShown}` : "";
      const detailText = shown ? `${shown}${rest}` : "(location unavailable)";
      if (issues.length >= 80) {
        break;
      }
      const primary = entries[0];
      issues.push({
        severity: "warning",
        message: `Duplicate label: ${key} (${entries.length} location: ${detailText})`,
        path: primary.path,
        line: primary.line,
      });
      if (issues.length >= 80) {
        break;
      }
    }
    return issues;
  };

  const mergeIssues = () => {
    const merged: IssueItem[] = [];
    const seen = new Set<string>();
    const hasBaseError = baseIssues.some((issue) => issue.severity === "error");
    const push = (issue: IssueItem) => {
      const token = `${issue.severity}|${issue.path ?? ""}|${issue.line ?? ""}|${issue.column ?? ""}|${issue.message}`;
      if (seen.has(token)) {
        return;
      }
      seen.add(token);
      merged.push(issue);
    };
    baseIssues.forEach(push);
    if (hasBaseError) {
      duplicateLabelIssues.forEach(push);
    }

    const sorted = merged
      .map((issue, index) => ({ issue, index }))
      .sort((a, b) => {
        const severityRankA = a.issue.severity === "error" ? 0 : 1;
        const severityRankB = b.issue.severity === "error" ? 0 : 1;
        if (severityRankA !== severityRankB) {
          return severityRankA - severityRankB;
        }
        const duplicateRankA = isDuplicateLabelIssue(a.issue) ? 1 : 0;
        const duplicateRankB = isDuplicateLabelIssue(b.issue) ? 1 : 0;
        if (duplicateRankA !== duplicateRankB) {
          return duplicateRankA - duplicateRankB;
        }
        const locationRankA = getIssueLocationRank(a.issue);
        const locationRankB = getIssueLocationRank(b.issue);
        if (locationRankA !== locationRankB) {
          return locationRankA - locationRankB;
        }
        const runtimeRankA = a.issue.action === "open-runtime" ? 0 : 1;
        const runtimeRankB = b.issue.action === "open-runtime" ? 0 : 1;
        if (runtimeRankA !== runtimeRankB) {
          return runtimeRankA - runtimeRankB;
        }
        return a.index - b.index;
      })
      .map((entry) => entry.issue);

    const hasError = sorted.some((issue) => issue.severity === "error");
    const status: IssuesStatus = hasError ? "error" : sorted.length > 0 ? "info" : "success";

    currentIssues = sorted;
    setIssuesStatus(status);
    deps.issuesUi.render(sorted);
    deps.editorSession.syncIssueMarkers(sorted);

    if (issuesTab instanceof HTMLElement) {
      const hasAlert = sorted.length > 0 && status === "error";
      issuesTab.classList.toggle("is-alert", hasAlert);
    }
    if (sorted.length === 0) {
      deps.editorSession.clearIssueHighlight();
    }
    if (pendingBuildIssuesFocus && sorted.length > 0 && status === "error") {
      pendingBuildIssuesFocus = false;
    }
  };

  const updateIssues = (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => {
    baseIssues = issues;
    mergeIssues();
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
    buildProfiles = Array.isArray(payload.buildProfiles) ? payload.buildProfiles : [];
    buildProfileId =
      typeof payload.buildProfileId === "string" && payload.buildProfileId.trim()
        ? payload.buildProfileId.trim()
        : null;
    deps.buildOps.updateSynctexButtonState();
    const rootChanged = Boolean(previousRoot && previousRoot !== payload.rootPath);
    if (rootChanged) {
      // Fire-and-forget save of dirty files before the workspace is replaced.
      deps.editorSession.saveDirtyFiles().catch(() => {});
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
    duplicateLabelIssues = computeDuplicateLabelIssues(indexLabels);
    mergeIssues();
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
    getBuildProfiles: () => buildProfiles,
    getBuildProfileId: () => buildProfileId,
    getIndexLabels: () => indexLabels,
    getIndexCitations: () => indexCitations,
    getIndexSections: () => indexSections,
    getIndexTodos: () => indexTodos,
    syncWorkspaceLabel,
  };
};
