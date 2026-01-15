import type { AppContext } from "./context.js";
import type {
  BuildState,
  FormatSettingsPayload,
  IssueItem,
  IssuesStatus,
} from "./types.js";

type EditorGroupKey = "primary" | "secondary";

type EditorGroupState = {
  key: EditorGroupKey;
  root: HTMLElement | null;
  tabs: HTMLElement | null;
  tabsList: HTMLElement | null;
  editorHost: HTMLElement | null;
  currentFilePath: string | null;
  currentFileSavedContent: string | null;
  editor: unknown | null;
  openTabs: string[];
  viewer: {
    getViewerMode: () => string;
    syncPdf: (payload: { page: number; x: number; y: number }) => void;
  };
  isDirty: boolean;
  viewStates: Map<string, unknown>;
  isApplyingFile: boolean;
  isComposing: boolean;
  compositionText: string;
  composingFilePath: string | null;
  pendingCompositionAction: (() => void) | null;
};

type BuildOpsDeps = {
  getActiveGroup: () => EditorGroupState;
  getActiveEditorGroupKey: () => EditorGroupKey;
  getActiveFilePath: () => string | null;
  getRootFilePath: () => string | null;
  getLastBuildMainFile: () => string | null;
  setLastBuildMainFile: (path: string | null) => void;
  getStoredCursorPosition: (path: string) => { line: number; column: number } | null;
  cacheCurrentBuffer: (group: EditorGroupState) => void;
  saveCurrentFile: () => Promise<boolean>;
  postToNative: (
    payload: { type: string; [key: string]: unknown },
    silent?: boolean
  ) => boolean;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
  setPendingBuildIssuesFocus: (value: boolean) => void;
  applyFormattedContent: (
    group: EditorGroupState,
    path: string,
    content: string,
    options?: { updateSaved?: boolean }
  ) => void;
  getEditorGroups: () => EditorGroupState[];
  renderEditorTabs: (group: EditorGroupState) => void;
  requestOpenFile: (
    path: string,
    groupKey: EditorGroupKey,
    force?: boolean
  ) => boolean;
  getSplitViewEnabled: () => boolean;
  setSplitViewEnabled: (enabled: boolean) => void;
  settings: {
    getPdfViewerMode: () => "window" | "tab";
    getAutoSynctexOnBuildEnabled: () => boolean;
    buildFormatSettingsPayload: () => FormatSettingsPayload;
  };
};

export type BuildOpsApi = {
  updateSynctexButtonState: () => void;
  setBuildState: (state: BuildState, message?: string) => void;
  startBuild: () => void;
  requestFormatCurrentFile: (source: string) => void;
  requestFormatPreview: (payload: {
    path: string;
    content: string;
    source?: string;
  }) => Promise<{
    path: string;
    ok: boolean;
    content?: string;
    error?: string;
    source?: string;
  }>;
  handleFormatResult: (payload: {
    path: string;
    ok: boolean;
    content?: string;
    error?: string;
    source?: string;
  }) => void;
  handleSaveFormatError: (formatError?: string) => void;
  handleBuildLog: (log: string | null) => void;
  requestSynctexForward: (
    overridePath?: string | null,
    options?: { fallbackToTop?: boolean }
  ) => void;
  handleSynctexForwardResult: (payload: {
    ok?: boolean;
    error?: string;
    page?: number;
    x?: number;
    y?: number;
    pdfPath?: string | null;
  }) => void;
  setupActionButtons: () => void;
};

export const initBuildOpsUi = (
  context: AppContext,
  deps: BuildOpsDeps
): BuildOpsApi => {
  const { buildButton, formatButton, synctexButton, issuesLog, issuesLogContent } = context.dom;

  let formatInFlight = false;
  let formatPending = false;
  let formatWarningShown = false;
  let currentBuildLog: string | null = null;
  const formatPreviewRequests = new Map<
    string,
    { resolve: (payload: { path: string; ok: boolean; content?: string; error?: string; source?: string }) => void; timeoutId: number }
  >();
  const formatPreviewIgnore = new Set<string>();

  const isEnvMissingMessage = (message: string) => {
    const lower = message.toLowerCase();
    const hasMissing = message.includes("見つかりません") || lower.includes("not found");
    return hasMissing && lower.includes("synctex");
  };

  const resolvePdfSyncGroup = (pdfPath?: string | null) => {
    if (!pdfPath) {
      return null;
    }
    return (
      deps.getEditorGroups().find((group) => group.openTabs.includes(pdfPath)) ?? null
    );
  };

  const updateSynctexButtonState = () => {
    if (!(synctexButton instanceof HTMLButtonElement)) {
      return;
    }
    synctexButton.disabled = true;
    synctexButton.style.display = "none";
  };

  const handleBuildLog = (log: string | null) => {
    currentBuildLog = log;
    if (issuesLogContent instanceof HTMLElement) {
      issuesLogContent.textContent = log ?? "";
    }
    if (issuesLog instanceof HTMLElement) {
      issuesLog.classList.toggle("is-hidden", !log);
      if (!log) {
        issuesLog.removeAttribute("open");
      }
    }
  };

  const requestSynctexForward = (
    overridePath?: string | null,
    options: { fallbackToTop?: boolean } = {}
  ) => {
    const activeGroup = deps.getActiveGroup();
    const targetPath = overridePath ?? activeGroup.currentFilePath;
    if (!targetPath || !targetPath.endsWith(".tex")) {
      deps.updateIssues(1, "SyncTeX は .tex ファイルでのみ利用できます。", "info", [
        { severity: "warning", message: "SyncTeX は .tex ファイルでのみ利用できます。" },
      ]);
      return;
    }
    const editor = activeGroup.editor as {
      getPosition?: () => { lineNumber: number; column: number };
    };
    const position =
      activeGroup.currentFilePath === targetPath ? editor?.getPosition?.() : null;
    const storedPosition = deps.getStoredCursorPosition(targetPath);
    const line = position?.lineNumber ?? storedPosition?.line ?? 1;
    const column = position?.column ?? storedPosition?.column ?? 1;
    deps.postToNative({
      type: "synctex:forward",
      path: targetPath,
      line,
      column,
      fallbackToTop: options.fallbackToTop === true,
      pdfViewerMode: deps.settings.getPdfViewerMode(),
    });
  };

  const setBuildState = (state: BuildState, message?: string) => {
    if (buildButton instanceof HTMLButtonElement) {
      const isBusy = state === "building";
      buildButton.disabled = isBusy;
      buildButton.classList.toggle("is-busy", isBusy);
      buildButton.setAttribute("aria-busy", isBusy ? "true" : "false");
      buildButton.setAttribute("aria-label", isBusy ? "ビルド中" : "ビルド");
    }
    if (state === "success") {
      const targetPath =
        deps.getLastBuildMainFile() ?? deps.getRootFilePath() ?? deps.getActiveFilePath();
      if (
        deps.settings.getAutoSynctexOnBuildEnabled() &&
        targetPath &&
        targetPath.endsWith(".tex")
      ) {
        requestSynctexForward(targetPath, { fallbackToTop: true });
      }
    }
    if (state === "failed") {
      deps.setPendingBuildIssuesFocus(true);
    } else if (state !== "building") {
      deps.setPendingBuildIssuesFocus(false);
    }
    if (message && state === "building") {
      deps.updateIssues(0, message, "info", []);
    }
  };

  const startBuild = () => {
    deps.cacheCurrentBuffer(deps.getActiveGroup());

    const mainFile =
      deps.getRootFilePath() ??
      (deps.getActiveFilePath() && deps.getActiveFilePath()?.endsWith(".tex")
        ? deps.getActiveFilePath()
        : undefined);

    deps.setLastBuildMainFile(mainFile ?? null);

    const engine = localStorage.getItem("tex64.compileEngine") || "lualatex";

    const payload: {
      type: string;
      mainFile?: string;
      format?: boolean;
      formatSettings?: FormatSettingsPayload;
      engine?: string;
      pdfViewerMode?: "window" | "tab";
    } = { type: "build" };
    if (mainFile) {
      payload.mainFile = mainFile;
    }
    if (engine) {
      payload.engine = engine;
    }
    payload.pdfViewerMode = deps.settings.getPdfViewerMode();
    payload.formatSettings = deps.settings.buildFormatSettingsPayload();

    if (deps.postToNative(payload)) {
      setBuildState("building");
      handleBuildLog(null);
      deps.updateIssues(0, "ビルドを開始します。", "info", []);
    }
  };

  const requestFormatCurrentFile = (source: string) => {
    const activeGroup = deps.getActiveGroup();
    const activePath = activeGroup.currentFilePath;
    if (!activePath || !activePath.toLowerCase().endsWith(".tex")) {
      return;
    }
    if (!activeGroup.editor) {
      return;
    }
    if (formatInFlight) {
      formatPending = true;
      return;
    }
    const editor = activeGroup.editor as { getValue: () => string };
    const content = editor.getValue();
    formatInFlight = true;
    const ok = deps.postToNative({
      type: "formatFile",
      path: activePath,
      content,
      source,
      formatSettings: deps.settings.buildFormatSettingsPayload(),
    });
    if (!ok) {
      formatInFlight = false;
      formatPending = false;
      if (!formatWarningShown) {
        formatWarningShown = true;
        deps.updateIssues(1, "整形のリクエストに失敗しました。", "info", [
          { severity: "warning", message: "整形のリクエストに失敗しました。" },
        ]);
      }
    }
  };

  const requestFormatPreview = (payload: {
    path: string;
    content: string;
    source?: string;
  }) =>
    new Promise<{
      path: string;
      ok: boolean;
      content?: string;
      error?: string;
      source?: string;
    }>((resolve) => {
      const source =
        payload.source ??
        `blockInsertPreview:${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const ok = deps.postToNative(
        {
          type: "formatFile",
          path: payload.path,
          content: payload.content,
          source,
          formatSettings: deps.settings.buildFormatSettingsPayload(),
        },
        true
      );
      if (!ok) {
        resolve({
          path: payload.path,
          ok: false,
          error: "整形のリクエストに失敗しました。",
          source,
        });
        return;
      }
      const timeoutId = window.setTimeout(() => {
        formatPreviewRequests.delete(source);
        formatPreviewIgnore.add(source);
        window.setTimeout(() => formatPreviewIgnore.delete(source), 30000);
        resolve({
          path: payload.path,
          ok: false,
          error: "整形がタイムアウトしました。",
          source,
        });
      }, 15000);
      formatPreviewRequests.set(source, { resolve, timeoutId });
    });

  const handleSaveFormatError = (formatError?: string) => {
    if (formatError && !formatWarningShown) {
      formatWarningShown = true;
      deps.updateIssues(1, formatError, "info", [
        { severity: "warning", message: formatError },
      ]);
    }
  };

  const handleFormatResult = (payload: {
    path: string;
    ok: boolean;
    content?: string;
    error?: string;
    source?: string;
  }) => {
    if (payload.source && formatPreviewRequests.has(payload.source)) {
      const pending = formatPreviewRequests.get(payload.source);
      if (pending) {
        window.clearTimeout(pending.timeoutId);
        formatPreviewRequests.delete(payload.source);
        pending.resolve(payload);
      }
      return;
    }
    if (payload.source && formatPreviewIgnore.has(payload.source)) {
      formatPreviewIgnore.delete(payload.source);
      return;
    }
    formatInFlight = false;
    if (!payload.ok) {
      if (!formatWarningShown) {
        formatWarningShown = true;
        deps.updateIssues(1, payload.error ?? "整形に失敗しました。", "info", [
          { severity: "warning", message: payload.error ?? "整形に失敗しました。" },
        ]);
      }
    } else if (typeof payload.content === "string") {
      const groupsWithFile = deps
        .getEditorGroups()
        .filter((group) => group.currentFilePath === payload.path);
      if (groupsWithFile.length > 0) {
        groupsWithFile.forEach((group) => {
          deps.applyFormattedContent(group, payload.path, payload.content as string, {
            updateSaved: false,
          });
          deps.renderEditorTabs(group);
        });
      }
      const activeGroup = deps.getActiveGroup();
      if (activeGroup.currentFilePath === payload.path && activeGroup.isDirty) {
        deps.saveCurrentFile().catch((message: string) => {
          deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
        });
      }
    }
    if (formatPending) {
      formatPending = false;
      requestFormatCurrentFile(payload.source ?? "auto");
    }
  };

  const handleSynctexForwardResult = (payload: {
    ok?: boolean;
    error?: string;
    page?: number;
    x?: number;
    y?: number;
    pdfPath?: string | null;
  }) => {
    if (!payload) {
      return;
    }
    if (payload.ok) {
      if (deps.settings.getPdfViewerMode() === "tab" && typeof payload.page === "number") {
        const pdfPath = payload.pdfPath ?? null;
        const openedGroup =
          resolvePdfSyncGroup(pdfPath) ??
          deps.getEditorGroups().find((group) => group.key === "secondary") ??
          deps.getActiveGroup();
        const hasPdfTab = pdfPath ? openedGroup.openTabs.includes(pdfPath) : false;
        if (openedGroup.key === "secondary" && hasPdfTab && !deps.getSplitViewEnabled()) {
          deps.setSplitViewEnabled(true);
        }
        if (pdfPath && hasPdfTab) {
          if (openedGroup.currentFilePath !== pdfPath) {
            deps.requestOpenFile(pdfPath, openedGroup.key, true);
          }
        }
        openedGroup.viewer.syncPdf({
          page: payload.page,
          x: payload.x ?? 0,
          y: payload.y ?? 0,
        });
      }
      return;
    }
    const errorMessage = payload.error ?? "SyncTeX に失敗しました。";
    const issue: IssueItem = { severity: "error", message: errorMessage };
    if (isEnvMissingMessage(errorMessage)) {
      issue.action = "open-runtime";
    }
    deps.updateIssues(1, errorMessage, "error", [issue]);
  };

  const setupActionButtons = () => {
    if (buildButton instanceof HTMLButtonElement) {
      buildButton.addEventListener("click", () => {
        if (buildButton.disabled) {
          return;
        }
        const activeGroup = deps.getActiveGroup();
        if (activeGroup.isDirty && activeGroup.currentFilePath) {
          deps
            .saveCurrentFile()
            .then((ok) => {
              if (ok) {
                startBuild();
              }
            })
            .catch((message: string) => {
              deps.updateIssues(1, message, "error", [
                { severity: "error", message },
              ]);
            });
          return;
        }
        startBuild();
      });
    }

    if (formatButton instanceof HTMLButtonElement) {
      formatButton.addEventListener("click", () => {
        requestFormatCurrentFile("manual");
      });
    }
  };

  return {
    updateSynctexButtonState,
    setBuildState,
    startBuild,
    requestFormatCurrentFile,
    requestFormatPreview,
    handleFormatResult,
    handleSaveFormatError,
    handleBuildLog,
    requestSynctexForward,
    handleSynctexForwardResult,
    setupActionButtons,
  };
};
