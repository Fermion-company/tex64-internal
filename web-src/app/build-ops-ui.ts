import type { AppContext } from "./context.js";
import { uiText } from "./i18n.js";
import type {
  BuildState,
  FormatSettingsPayload,
  IssueItem,
  IssuesStatus,
} from "./types.js";
import type { EnvStatusSummary } from "./settings-env.js";

type EditorGroupKey = "primary" | "secondary";
type SynctexForwardSource = "manual" | "auto-build" | "other";

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
    syncPdf: (payload: { page: number; x: number; y: number; blockX?: number; blockY?: number; blockWidth?: number; blockHeight?: number }) => void;
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
    getRuntimeStatusSummary: () => EnvStatusSummary | null;
    checkEnvironmentStatus: () => void;
  };
};

export type BuildOpsApi = {
  updateSynctexButtonState: () => void;
  setBuildState: (state: BuildState, message?: string) => void;
  startBuild: () => void;
  requestFormatCurrentFile: (source: string) => void;
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
    options?: { fallbackToTop?: boolean; source?: SynctexForwardSource }
  ) => void;
  handleSynctexForwardResult: (payload: {
    ok?: boolean;
    error?: string;
    page?: number;
    x?: number;
    y?: number;
    blockX?: number;
    blockY?: number;
    blockWidth?: number;
    blockHeight?: number;
    pdfPath?: string | null;
    requestId?: string;
    cancelled?: boolean;
  }) => void;
  setupActionButtons: () => void;
};

export const initBuildOpsUi = (
  context: AppContext,
  deps: BuildOpsDeps
): BuildOpsApi => {
  const {
    buildButton,
    formatButton,
    synctexButton,
    issuesLog,
    issuesLogContent,
  } = context.dom;

  let formatInFlight = false;
  let formatPending = false;
  let formatWarningShown = false;
  let formatInFlightSnapshot: { path: string; content: string } | null = null;
  let currentBuildLog: string | null = null;
  let currentBuildState: BuildState = "idle";
  let synctexForwardRequestOrder = 0;
  let synctexForwardLastAppliedOrder = 0;
  let synctexManualPriorityUntil = 0;
  let synctexForwardInFlight: {
    requestId: string;
    key: string;
    source: SynctexForwardSource;
    startedAt: number;
  } | null = null;
  let queuedSynctexForward: {
    overridePath: string | null;
    options: { fallbackToTop?: boolean; source?: SynctexForwardSource };
  } | null = null;
  const synctexForwardOrderByRequestId = new Map<
    string,
    { order: number; source: SynctexForwardSource; createdAt: number }
  >();
  const synctexForwardInFlightTimeoutMs = 12000;
  const buildSynctexForwardRequestId = (() => {
    let counter = 0;
    return () => `synctex-forward-${Date.now().toString(36)}-${counter++}`;
  })();

  const isEnvMissingMessage = (message: string) => {
    const lower = message.toLowerCase();
    const hasMissing = message.includes("not found") || lower.includes("not found");
    return hasMissing && lower.includes("synctex");
  };

  const firstBuildCompletedKey = "tex64.onboarding.firstBuildCompleted.v1";

  const resolveRuntimeMissingLabel = (key: string) => {
    if (key === "engine") {
      return "TeX Engine";
    }
    if (key === "latexmk") {
      return "latexmk";
    }
    if (key === "synctex") {
      return "synctex";
    }
    if (key === "latexindent") {
      return "latexindent";
    }
    return key;
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
    const activePath = deps.getActiveFilePath();
    const rootPath = deps.getRootFilePath();
    const targetPath =
      activePath && activePath.endsWith(".tex") ? activePath : rootPath;
    const enabled = Boolean(targetPath && targetPath.endsWith(".tex"));
    synctexButton.disabled = !enabled;
    synctexButton.style.display = "inline-flex";
    synctexButton.textContent = uiText("Jump", "ジャンプ");
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

  const flushQueuedSynctexForward = () => {
    if (!queuedSynctexForward) {
      return;
    }
    const queued = queuedSynctexForward;
    queuedSynctexForward = null;
    window.setTimeout(() => {
      requestSynctexForward(queued.overridePath, queued.options);
    }, 0);
  };

  const requestSynctexForward = (
    overridePath?: string | null,
    options: { fallbackToTop?: boolean; source?: SynctexForwardSource } = {}
  ) => {
    const activeGroup = deps.getActiveGroup();
    const targetPath = overridePath ?? activeGroup.currentFilePath;
    if (!targetPath || !targetPath.endsWith(".tex")) {
      const message = uiText("SyncTeX is only available for .tex files.", "SyncTeX は .tex ファイルでのみ利用できます。");
      deps.updateIssues(1, message, "info", [
        { severity: "warning", message },
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
    const source = options.source ?? "manual";
    if (source === "manual") {
      synctexManualPriorityUntil = Date.now() + 5000;
    }
    const requestKey = [
      targetPath,
      String(line),
      String(column),
      deps.settings.getPdfViewerMode(),
    ].join("|");
    if (synctexForwardInFlight) {
      const inFlightAgeMs = Date.now() - synctexForwardInFlight.startedAt;
      if (inFlightAgeMs <= synctexForwardInFlightTimeoutMs) {
        if (synctexForwardInFlight.key === requestKey) {
          return;
        }
        queuedSynctexForward = {
          overridePath: targetPath,
          options: {
            fallbackToTop: options.fallbackToTop === true,
            source,
          },
        };
        return;
      }
      synctexForwardInFlight = null;
    }
    const requestId = buildSynctexForwardRequestId();
    const order = ++synctexForwardRequestOrder;
    synctexForwardOrderByRequestId.set(requestId, {
      order,
      source,
      createdAt: Date.now(),
    });
    synctexForwardInFlight = {
      requestId,
      key: requestKey,
      source,
      startedAt: Date.now(),
    };
    while (synctexForwardOrderByRequestId.size > 256) {
      const oldestRequestId = synctexForwardOrderByRequestId.keys().next().value;
      if (!oldestRequestId) {
        break;
      }
      synctexForwardOrderByRequestId.delete(oldestRequestId);
    }
    deps.postToNative({
      type: "synctex:forward",
      requestId,
      source,
      path: targetPath,
      line,
      column,
      fallbackToTop: options.fallbackToTop === true,
      pdfViewerMode: deps.settings.getPdfViewerMode(),
    });
  };

  const setBuildState = (state: BuildState, message?: string) => {
    currentBuildState = state;
    const isBusy = state === "building";
    if (buildButton instanceof HTMLButtonElement) {
      buildButton.disabled = false;
      buildButton.classList.toggle("is-busy", isBusy);
      buildButton.setAttribute("aria-busy", isBusy ? "true" : "false");
      buildButton.setAttribute("aria-label", isBusy ? uiText("Cancel", "cancel") : uiText("Build", "build"));
      buildButton.title = isBusy ? uiText("Cancel build", "ビルドをキャンセル") : uiText("Build", "ビルド");
    }
    if (state === "success") {
      try {
        localStorage.setItem(firstBuildCompletedKey, "1");
      } catch {
        // ignore storage failures
      }
      if (deps.settings.getAutoSynctexOnBuildEnabled()) {
        // Target the .tex the user is actively editing (incl. an \input-ed
        // sub-file) so SyncTeX jumps to the live cursor; fall back to the built
        // main file when the active tab isn't a .tex (e.g. the PDF or a .bib).
        const activePath = deps.getActiveFilePath();
        const targetPath =
          activePath && activePath.endsWith(".tex")
            ? activePath
            : deps.getLastBuildMainFile() ?? deps.getRootFilePath() ?? null;
        if (targetPath && targetPath.endsWith(".tex")) {
          requestSynctexForward(targetPath, {
            fallbackToTop: false,
            source: "auto-build",
          });
        }
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
    if (currentBuildState === "building") {
      const ok = deps.postToNative({ type: "build:cancel" });
      if (ok) {
        deps.updateIssues(0, uiText("Canceling build...", "ビルドをキャンセルしています..."), "info", []);
      }
      return;
    }

    const runtimeSummary = deps.settings.getRuntimeStatusSummary();
    if (!runtimeSummary || !runtimeSummary.hasAnyResult) {
      // Environment hasn't been checked yet — trigger an async check but
      // proceed to build anyway. The main process has its own
      // ensureRuntimeReadyForBuild() that will block and report errors if
      // required tools are missing. Previously this path returned early,
      // which prevented the spinner from ever appearing ("stops midway").
      deps.settings.checkEnvironmentStatus();
    } else if (!runtimeSummary.runtimeReady) {
      const missing = runtimeSummary.missingRequired.map((item) =>
        resolveRuntimeMissingLabel(item)
      );
      const summaryText =
        missing.length > 0
          ? uiText(`Missing runtime environment: ${missing.join(", ")}`, `Runtime Environmentが不足しています: ${missing.join(", ")}`)
          : uiText("Runtime environment is missing.", "Execution environment is insufficient.");
      const issues =
        runtimeSummary.missingRequired.length > 0
          ? runtimeSummary.missingRequired.map((item) => ({
              severity: "error" as const,
              message: uiText(
                `${resolveRuntimeMissingLabel(item)} is not detected. Check Settings > Runtime Environment.`,
                `${resolveRuntimeMissingLabel(item)} is not detected. Please check Settings > Execution environment.`
              ),
              action: "open-runtime" as const,
            }))
          : [
              {
                severity: "error" as const,
                message: uiText(
                  "Runtime environment is missing. Check Settings > Runtime Environment.",
                  "Execution environment is insufficient. Please check Settings > Execution environment."
                ),
                action: "open-runtime" as const,
              },
            ];
      deps.updateIssues(issues.length, summaryText, "error", issues);
      deps.setPendingBuildIssuesFocus(true);
      return;
    }

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
      deps.updateIssues(0, uiText("Starting build.", "Start the build."), "info", []);
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
    formatInFlightSnapshot = { path: activePath, content };
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
      formatInFlightSnapshot = null;
      if (!formatWarningShown) {
        formatWarningShown = true;
        const message = uiText("Failed to request formatting.", "The formatting request failed.");
        deps.updateIssues(1, message, "info", [
          { severity: "warning", message },
        ]);
      }
    }
  };

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
    const inFlightSnapshot = formatInFlightSnapshot;
    formatInFlight = false;
    formatInFlightSnapshot = null;
    if (!payload.ok) {
      if (!formatWarningShown) {
        formatWarningShown = true;
        const message = payload.error ?? uiText("Formatting failed.", "整形に失敗しました。");
        deps.updateIssues(1, message, "info", [
          { severity: "warning", message },
        ]);
      }
    } else if (typeof payload.content === "string") {
      const groupsWithFile = deps
        .getEditorGroups()
        .filter((group) => group.currentFilePath === payload.path);
      const currentValue =
        groupsWithFile.length > 0
          ? (groupsWithFile[0].editor as { getValue?: () => string })?.getValue?.()
          : null;
      const isStale =
        inFlightSnapshot?.path === payload.path &&
        typeof currentValue === "string" &&
        currentValue !== inFlightSnapshot.content;
      if (!isStale) {
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
    blockX?: number;
    blockY?: number;
    blockWidth?: number;
    blockHeight?: number;
    pdfPath?: string | null;
    requestId?: string;
    cancelled?: boolean;
  }) => {
    if (!payload) {
      return;
    }
    const payloadRequestId =
      typeof payload.requestId === "string" && payload.requestId.trim()
        ? payload.requestId
        : null;
    const matchedInFlight = Boolean(
      payloadRequestId &&
        synctexForwardInFlight &&
        synctexForwardInFlight.requestId === payloadRequestId
    );
    if (matchedInFlight) {
      synctexForwardInFlight = null;
    }
    const payloadMeta = payloadRequestId
      ? synctexForwardOrderByRequestId.get(payloadRequestId) ?? null
      : null;
    const payloadOrder = payloadMeta?.order ?? null;
    if (payload.cancelled === true) {
      if (matchedInFlight) {
        flushQueuedSynctexForward();
      }
      return;
    }
    if (payloadMeta?.source === "auto-build" && Date.now() < synctexManualPriorityUntil) {
      if (matchedInFlight) {
        flushQueuedSynctexForward();
      }
      return;
    }
    if (
      Number.isFinite(payloadOrder) &&
      payloadOrder !== null &&
      payloadOrder < synctexForwardLastAppliedOrder
    ) {
      if (matchedInFlight) {
        flushQueuedSynctexForward();
      }
      return;
    }
    if (Number.isFinite(payloadOrder) && payloadOrder !== null) {
      synctexForwardLastAppliedOrder = Math.max(synctexForwardLastAppliedOrder, payloadOrder);
    }
    if (payload.ok) {
      if (deps.settings.getPdfViewerMode() === "tab" && typeof payload.page === "number") {
        const pdfPath = payload.pdfPath ?? null;
        const openedGroup =
          resolvePdfSyncGroup(pdfPath) ??
          deps.getEditorGroups().find((group) => group.key === "secondary") ??
          deps.getActiveGroup();
        const shouldSplit = openedGroup.key === "secondary";
        if (shouldSplit && !deps.getSplitViewEnabled()) {
          deps.setSplitViewEnabled(true);
        }
        if (pdfPath) {
          const hasPdfTab = openedGroup.openTabs.includes(pdfPath);
          if (!hasPdfTab || openedGroup.currentFilePath !== pdfPath) {
            deps.requestOpenFile(pdfPath, openedGroup.key, true);
          }
        }
        const syncPayload: { page: number; x: number; y: number; blockX?: number; blockY?: number; blockWidth?: number; blockHeight?: number } = {
          page: payload.page,
          x: payload.x ?? 0,
          y: payload.y ?? 0,
        };
        if (typeof payload.blockWidth === "number" && payload.blockWidth > 0) {
          syncPayload.blockWidth = payload.blockWidth;
        }
        if (typeof payload.blockHeight === "number" && payload.blockHeight > 0) {
          syncPayload.blockHeight = payload.blockHeight;
        }
        if (typeof payload.blockX === "number") {
          syncPayload.blockX = payload.blockX;
        }
        if (typeof payload.blockY === "number") {
          syncPayload.blockY = payload.blockY;
        }
        openedGroup.viewer.syncPdf(syncPayload);
      }
      if (matchedInFlight) {
        flushQueuedSynctexForward();
      }
      return;
    }
    if (payloadMeta?.source === "auto-build") {
      // Auto-build SyncTeX is best-effort: when the cursor line can't be
      // resolved (preamble, comment, blank line), don't surface an error and
      // don't jump anywhere — the PDF keeps its current scroll/zoom via the
      // viewer's reload restore. Only the explicit Jump button (source
      // "manual") reports failures / falls back to the top.
      if (matchedInFlight) {
        flushQueuedSynctexForward();
      }
      return;
    }
    const errorMessage = payload.error ?? uiText("SyncTeX failed.", "SyncTeX に失敗しました。");
    const issue: IssueItem = { severity: "error", message: errorMessage };
    if (isEnvMissingMessage(errorMessage)) {
      issue.action = "open-runtime";
    }
    deps.updateIssues(1, errorMessage, "error", [issue]);
    if (matchedInFlight) {
      flushQueuedSynctexForward();
    }
  };

  const setupActionButtons = () => {
    if (buildButton instanceof HTMLButtonElement) {
      buildButton.addEventListener("click", () => {
        startBuild();
      });
    }

    if (formatButton instanceof HTMLButtonElement) {
      formatButton.addEventListener("click", () => {
        requestFormatCurrentFile("manual");
      });
    }

    if (synctexButton instanceof HTMLButtonElement) {
      synctexButton.addEventListener("click", () => {
        if (synctexButton.disabled) {
          return;
        }
        requestSynctexForward(null, { fallbackToTop: true, source: "manual" });
      });
    }

  };

  return {
    updateSynctexButtonState,
    setBuildState,
    startBuild,
    requestFormatCurrentFile,
    handleFormatResult,
    handleSaveFormatError,
    handleBuildLog,
    requestSynctexForward,
    handleSynctexForwardResult,
    setupActionButtons,
  };
};
