import type { AppContext } from "./context.js";
import { uiText } from "./i18n.js";
import { countMarkedLines, renderBuildLog, segmentBuildLog } from "./build-log-view.js";
import type {
  BuildState,
  FormatSettingsPayload,
  IssueItem,
  IssuesStatus,
} from "./types.js";
import type { EnvStatusSummary } from "./settings-env.js";
import type { PdfSyncPayload } from "./viewer.js";
import type { ContextMenuApi, ContextMenuItem } from "./context-menu.js";
import { hideEditorNotice, showEditorNotice } from "./editor-notice.js";
import { collabSession, type CollabState } from "./collab/session.js";
import { explainedHeading } from "./explain.js";

type EditorGroupKey = "primary" | "secondary";
type SynctexForwardSource = "manual" | "auto-build" | "other";
export type BuildProgressPhase = "building" | "installing" | "cancelling";

export const resolveBuildProgressPhase = (
  message?: string,
  cancelRequested = false
): BuildProgressPhase => {
  if (cancelRequested || /cancel/i.test(message ?? "")) return "cancelling";
  if (/install/i.test(message ?? "")) return "installing";
  return "building";
};

export const resolveSynctexForwardTarget = (
  overridePath: string | null | undefined,
  activePath: string | null | undefined,
  lastBuildMainFile: string | null | undefined,
  rootPath: string | null | undefined
) => {
  const candidates = [overridePath, activePath, lastBuildMainFile, rootPath];
  return candidates.find((path) => path?.toLowerCase().endsWith(".tex")) ?? null;
};

export const resolveSynctexForwardPdfPath = (
  lastBuildMainFile: string | null | undefined,
  rootPath: string | null | undefined
) => {
  const texPath = resolveSynctexForwardTarget(null, null, lastBuildMainFile, rootPath);
  return texPath ? texPath.replace(/\.tex$/i, ".pdf") : null;
};

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
    syncPdf: (payload: PdfSyncPayload) => void;
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
  getWorkspaceFiles: () => string[];
  getRootFilePath: () => string | null;
  getWorkspaceRootKey?: () => string | null;
  getLastBuildMainFile: () => string | null;
  setLastBuildMainFile: (path: string | null) => void;
  getStoredCursorPosition: (path: string) => { line: number; column: number } | null;
  cacheCurrentBuffer: (group: EditorGroupState) => void;
  saveCurrentFile: () => Promise<boolean>;
  saveDirtyFiles?: () => Promise<boolean>;
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
  contextMenu: ContextMenuApi;
  settings: {
    getPdfViewerMode: () => "window" | "tab";
    getAutoSynctexOnBuildEnabled: () => boolean;
    buildFormatSettingsPayload: () => FormatSettingsPayload;
    getRuntimeStatusSummary: () => EnvStatusSummary | null;
    checkEnvironmentStatus: () => void;
  };
};

export type BuildOpsApi = {
  documentFor: (path: string) => string | undefined;
  updateSynctexButtonState: () => void;
  handleBuildPreviewState: (payload: {
    state: BuildState;
    pdfPath?: string;
    previousPdf?: boolean;
  }) => void;
  setBuildState: (state: BuildState, message?: string) => void;
  startBuild: (explicitTarget?: string) => void;
  chooseBuildTarget: (payload: { requested: string | null; candidates: string[] }) => void;
  requestFormatCurrentFile: (source: string) => void;
  handleFormatResult: (payload: {
    path: string;
    ok: boolean;
    content?: string;
    error?: string;
    source?: string;
    stale?: boolean;
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
    blocks?: Array<{ x: number; y: number; width: number; height: number }>;
    pdfPath?: string | null;
    requestId?: string;
    cancelled?: boolean;
    fallback?: boolean;
    notTypeset?: boolean;
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
  let preparingBuild = false;
  let preparationGeneration = 0;
  let buildProgressPhase: BuildProgressPhase = "building";
  let buildStartedAt = 0;
  let buildCancelRequested = false;
  let buildProgressTimer: ReturnType<typeof window.setInterval> | null = null;
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
    { order: number; source: SynctexForwardSource; createdAt: number; path: string; line: number; column: number }
  >();
  const synctexForwardInFlightTimeoutMs = 12000;
  const buildSynctexForwardRequestId = (() => {
    let counter = 0;
    return () => `synctex-forward-${Date.now().toString(36)}-${counter++}`;
  })();
  // The Jump button turns while its own request resolves, so a click that
  // takes a moment does not read as a dead button.
  let synctexBusyRequestId: string | null = null;
  let synctexBusyTimer: number | null = null;
  const setSynctexBusy = (requestId: string | null) => {
    synctexBusyRequestId = requestId;
    if (synctexBusyTimer !== null) window.clearTimeout(synctexBusyTimer);
    synctexBusyTimer = requestId
      ? window.setTimeout(() => setSynctexBusy(null), synctexForwardInFlightTimeoutMs)
      : null;
    if (synctexButton instanceof HTMLElement) {
      synctexButton.classList.toggle("is-busy", Boolean(requestId));
      synctexButton.setAttribute("aria-busy", requestId ? "true" : "false");
    }
  };
  const synctexErrorNotice = (error: string): { message: string; build?: boolean } => {
    if (/PDF not found|PDF has not been generated/i.test(error)) {
      return {
        message: uiText("No PDF yet. Build first.", "PDF がまだありません。先にビルドしてください。"),
        build: true,
      };
    }
    if (/SyncTeX data was not found/i.test(error)) {
      return {
        message: uiText("This PDF has no position data (SyncTeX). Build it again.", "この PDF には位置情報（SyncTeX）がありません。ビルドし直してください。"),
        build: true,
      };
    }
    if (/not part of this PDF/i.test(error)) {
      return { message: uiText("This file is not part of the PDF.", "このファイルは PDF に含まれていません。") };
    }
    if (/does not appear in the PDF|position was not found/i.test(error)) {
      return { message: uiText("This line does not appear in the PDF.", "この行は PDF に出力されていません。") };
    }
    if (/only (supports|available for) .*TeX files|No TeX file selected/i.test(error)) {
      return { message: uiText("Jump works from a .tex file.", "ジャンプは .tex ファイルから使えます。") };
    }
    return { message: `${uiText("Could not jump:", "ジャンプできませんでした：")} ${error}` };
  };
  const showSynctexNotice = (message: string, tone: "info" | "error", build = false) => {
    showEditorNotice(synctexButton instanceof HTMLElement ? synctexButton : null, message, {
      tone,
      owner: "jump",
      ...(build ? { action: { label: uiText("Build", "ビルド"), run: () => void startBuild() } } : {}),
    });
  };

  const getBuildButtonIdleTitle = () => uiText("Build", "ビルド");

  const buildProgressText = () => {
    if (buildProgressPhase === "cancelling") {
      return uiText("Canceling…", "キャンセル中…");
    }
    const phase = buildProgressPhase === "installing"
      ? uiText("Installing TeX packages…", "TeXパッケージ導入中…")
      : uiText("Building…", "ビルド中…");
    const elapsedSeconds = buildStartedAt > 0
      ? Math.max(0, Math.floor((Date.now() - buildStartedAt) / 1000))
      : 0;
    return elapsedSeconds > 0 ? `${phase} ${elapsedSeconds}s` : phase;
  };

  const renderBuildButtonProgress = () => {
    if (!(buildButton instanceof HTMLButtonElement) || currentBuildState !== "building") return;
    const progress = buildProgressText();
    buildButton.dataset.progressPhase = buildProgressPhase;
    buildButton.title = progress;
    const label = buildButton.querySelector<HTMLElement>(".build-button-label");
    if (label) label.textContent = progress;
  };

  const stopBuildProgressTimer = () => {
    if (buildProgressTimer !== null) window.clearInterval(buildProgressTimer);
    buildProgressTimer = null;
  };

  const startBuildProgressTimer = () => {
    if (buildProgressTimer !== null) return;
    buildProgressTimer = window.setInterval(renderBuildButtonProgress, 250);
  };

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

  const handleBuildPreviewState = (payload: {
    state: BuildState;
    pdfPath?: string;
    previousPdf?: boolean;
  }) => {
    if (payload.state !== "building" || payload.previousPdf !== true || !payload.pdfPath) return;
    if (deps.settings.getPdfViewerMode() !== "tab") return;
    const pdfPath = payload.pdfPath;
    const visible = deps.getEditorGroups().some((group) =>
      group.currentFilePath === pdfPath && group.viewer.getViewerMode() === "pdf"
    );
    if (visible) return;
    const openedGroup = resolvePdfSyncGroup(pdfPath) ??
      deps.getEditorGroups().find((group) => group.key === "secondary") ??
      deps.getActiveGroup();
    if (openedGroup.key === "secondary" && !deps.getSplitViewEnabled()) {
      deps.setSplitViewEnabled(true);
    }
    deps.cacheCurrentBuffer(openedGroup);
    deps.requestOpenFile(pdfPath, openedGroup.key, true);
  };

  const updateSynctexButtonState = () => {
    if (!(synctexButton instanceof HTMLButtonElement)) {
      return;
    }
    const targetPath = resolveSynctexForwardTarget(
      null,
      deps.getActiveFilePath(),
      deps.getLastBuildMainFile(),
      deps.getRootFilePath()
    );
    // A Build rewrites the PDF and its SyncTeX data: no Jump until it is done.
    const enabled = Boolean(targetPath) && !preparingBuild && currentBuildState !== "building";
    synctexButton.disabled = !enabled;
    synctexButton.style.display = "inline-flex";
  };

  // The <details> outlives every build, so the toggle handler is bound once and
  // reads whichever line the latest log marked first. Scroll the transcript box
  // itself rather than scrollIntoView, which would drag the whole panel along.
  let markedTarget: HTMLElement | null = null;
  let revealPending = false;
  const revealMarkedLine = () => {
    if (!markedTarget || !(issuesLogContent instanceof HTMLElement)) {
      return;
    }
    // A build usually finishes while the Issues tab is still hidden, and you
    // cannot scroll a box that has no height yet — the assignment is silently
    // dropped. Stay pending until the box is actually laid out.
    if (issuesLogContent.clientHeight <= 0) {
      return;
    }
    issuesLogContent.scrollTop = Math.max(
      0,
      markedTarget.offsetTop - issuesLogContent.clientHeight / 2
    );
    revealPending = false;
  };
  if (issuesLog instanceof HTMLElement) {
    issuesLog.addEventListener("toggle", () => {
      if (issuesLog.hasAttribute("open")) {
        revealMarkedLine();
      }
    });
  }
  if (issuesLogContent instanceof HTMLElement && typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (revealPending) {
        revealMarkedLine();
      }
    }).observe(issuesLogContent);
  }

  const handleBuildLog = (log: string | null) => {
    currentBuildLog = log;
    let firstMarked: HTMLElement | null = null;
    let markedCount = 0;
    if (issuesLogContent instanceof HTMLElement) {
      if (log) {
        firstMarked = renderBuildLog(issuesLogContent, log);
        markedCount = countMarkedLines(segmentBuildLog(log));
      } else {
        issuesLogContent.replaceChildren();
      }
    }
    if (issuesLog instanceof HTMLElement) {
      issuesLog.classList.toggle("is-hidden", !log);
      if (!log) {
        issuesLog.removeAttribute("open");
      }
      const summary = issuesLog.querySelector(".issues-log-summary");
      if (summary instanceof HTMLElement) {
        summary.dataset.noI18n = "";
        summary.textContent =
          markedCount > 0
            ? uiText(`Detailed log (${markedCount} marked)`, `詳細ログ（該当 ${markedCount} 件）`)
            : uiText("Detailed log", "詳細ログ");
      }
      // Open on arrival: if there is something to say, the transcript is worth
      // seeing without a second click. Thousands of lines of package banners
      // are useless unless you land on the part that matters, so scroll to the
      // first mark — once now, and again if it is closed and reopened.
      if (log) {
        issuesLog.setAttribute("open", "");
      }
      markedTarget = firstMarked;
      revealPending = Boolean(firstMarked);
      if (firstMarked) {
        // Two frames: the first lets the freshly opened <details> lay out, so
        // clientHeight is real when the scroll offset is computed. If the panel
        // is still hidden the ResizeObserver picks it up when it is shown.
        requestAnimationFrame(() => requestAnimationFrame(revealMarkedLine));
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
    const activePath = deps.getActiveFilePath();
    const lastBuildMainFile = deps.getLastBuildMainFile();
    const rootPath = deps.getRootFilePath();
    const targetPath = resolveSynctexForwardTarget(
      overridePath,
      activePath,
      lastBuildMainFile,
      rootPath
    );
    if (!targetPath) {
      if ((options.source ?? "manual") === "manual") {
        showSynctexNotice(uiText("Jump works from a .tex file.", "ジャンプは .tex ファイルから使えます。"), "info");
      }
      return;
    }
    const sourceGroup = [activeGroup, ...deps.getEditorGroups()].find(
      (group) => group.currentFilePath === targetPath
    );
    const editor = sourceGroup?.editor as {
      getPosition?: () => { lineNumber: number; column: number };
    } | null | undefined;
    const position = editor?.getPosition?.() ?? null;
    const storedPosition = deps.getStoredCursorPosition(targetPath);
    const line = position?.lineNumber ?? storedPosition?.line ?? 1;
    const column = position?.column ?? storedPosition?.column ?? 1;
    const source = options.source ?? "manual";
    if (source === "manual") {
      synctexManualPriorityUntil = Date.now() + 5000;
      // The last Jump's note is about another line.
      hideEditorNotice("jump");
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
        // The same line already resolving for a click: nothing to add. For
        // the post-build jump it is the click's turn: a request of its own
        // (the automatic one never falls back to the first page, and its
        // result is dropped once a click has priority).
        if (
          synctexForwardInFlight.key === requestKey &&
          !(source === "manual" && synctexForwardInFlight.source !== "manual")
        ) {
          return;
        }
        // A click from another line replaces the pending one outright (the
        // main process drops the older request); waiting for it made the
        // second click look ignored.
        if (source !== "manual") {
          queuedSynctexForward = {
            overridePath: targetPath,
            options: {
              fallbackToTop: options.fallbackToTop === true,
              source,
            },
          };
          return;
        }
      }
      synctexForwardInFlight = null;
      queuedSynctexForward = null;
    }
    const requestId = buildSynctexForwardRequestId();
    const order = ++synctexForwardRequestOrder;
    synctexForwardOrderByRequestId.set(requestId, {
      order,
      source,
      createdAt: Date.now(),
      path: targetPath,
      line,
      column,
    });
    synctexForwardInFlight = {
      requestId,
      key: requestKey,
      source,
      startedAt: Date.now(),
    };
    if (source === "manual") setSynctexBusy(requestId);
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
      // main resolves the document (and its real PDF) like a Build would. A
      // document chosen for this file, or the one the post-Build jump follows,
      // is named explicitly.
      documentMainFile: (source === "auto-build" ? lastBuildMainFile : null) ??
        chosenTargets.get(`${deps.getWorkspaceRootKey?.() ?? ""}\0${targetPath}`) ?? undefined,
      line,
      column,
      fallbackToTop: options.fallbackToTop === true,
      pdfViewerMode: deps.settings.getPdfViewerMode(),
    });
  };

  const setBuildState = (state: BuildState, message?: string) => {
    const wasBusy = currentBuildState === "building";
    currentBuildState = state;
    updateSynctexButtonState();
    if (state === "building" && pendingJumpAfterBuild) pendingJumpAfterBuild.started = true;
    else if (state === "success" || state === "failed" || state === "idle") resumeJumpAfterBuild(state);
    const isBusy = state === "building";
    if (isBusy) {
      if (!wasBusy) {
        buildStartedAt = Date.now();
        buildCancelRequested = false;
      }
      buildProgressPhase = resolveBuildProgressPhase(message, buildCancelRequested);
      startBuildProgressTimer();
    } else {
      stopBuildProgressTimer();
      buildStartedAt = 0;
      buildCancelRequested = false;
      buildProgressPhase = "building";
    }
    if (buildButton instanceof HTMLButtonElement) {
      buildButton.disabled = false;
      buildButton.classList.toggle("is-busy", isBusy);
      buildButton.setAttribute("aria-busy", isBusy ? "true" : "false");
      buildButton.setAttribute(
        "aria-label",
        isBusy
          ? uiText("Cancel build", "ビルドをキャンセル")
          : uiText("Build", "ビルド")
      );
      const label = buildButton.querySelector<HTMLElement>(".build-button-label");
      if (label && !isBusy) label.textContent = uiText("Build", "ビルド");
      if (isBusy) renderBuildButtonProgress();
      else {
        delete buildButton.dataset.progressPhase;
        buildButton.title = getBuildButtonIdleTitle();
      }
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

  const cancelBuild = () => {
    if (preparingBuild) {
      preparingBuild = false;
      preparationGeneration += 1;
      setBuildState("idle");
      return;
    }
    if (currentBuildState === "building") {
      const ok = deps.postToNative({ type: "build:cancel" });
      if (ok) {
        buildCancelRequested = true;
        buildProgressPhase = "cancelling";
        renderBuildButtonProgress();
        deps.updateIssues(0, uiText("Canceling build…", "ビルドをキャンセル中…"), "info", []);
      }
    }
  };

  // Fragment → document chosen in the chooser, per workspace, for this session.
  const chosenTargets = new Map<string, string>();
  let chooserDialog: HTMLDialogElement | null = null;

  // A Jump whose document had no PDF yet: the Build it started, and the file
  // to jump from once that Build succeeds.
  let pendingJumpAfterBuild: { path: string; target: string; workspaceKey: string | null; started: boolean } | null = null;
  const resumeJumpAfterBuild = (state: BuildState) => {
    const pending = pendingJumpAfterBuild;
    if (!pending) return;
    // setBuildState("idle") also runs while startBuild saves files first.
    if (!pending.started) {
      if (state === "failed") pendingJumpAfterBuild = null;
      return;
    }
    pendingJumpAfterBuild = null;
    if (state !== "success" || deps.getWorkspaceRootKey?.() !== pending.workspaceKey) return;
    const built = deps.getLastBuildMainFile();
    if (built && built !== pending.target) return;
    window.setTimeout(() => requestSynctexForward(pending.path, { fallbackToTop: true, source: "manual" }), 0);
  };

  // Main could not decide which document to build (a fragment included by two
  // documents, or several documents and no root): one dialog, one answer.
  const chooseBuildTarget = (payload: { requested: string | null; candidates: string[] }) =>
    openTargetChooser({ ...payload, onPick: (path) => void startBuild(path) });

  const openTargetChooser = (payload: { requested: string | null; candidates: string[]; onPick: (path: string) => void }) => {
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates.filter((c) => typeof c === "string" && c) : [];
    if (candidates.length === 0) return;
    const requested = typeof payload.requested === "string" ? payload.requested : null;
    const workspaceKey = deps.getWorkspaceRootKey?.() ?? null;
    chooserDialog?.close();
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
      const node = document.createElement(tag);
      node.className = className;
      node.textContent = text;
      return node;
    };
    const dialog = el("dialog", "history-confirm build-target-dialog");
    const title = el("h2", "", uiText("Build target", "ビルド対象"));
    const note = el("p", "build-target-note", requested
      ? uiText(`${requested} belongs to more than one document.`, `${requested} は複数の文書から読み込まれています。`)
      : uiText("No main file is set.", "メイン TeX が決まっていません。"));
    const list = el("div", "build-target-list");
    list.setAttribute("role", "listbox");
    const pick = (path: string) => {
      dialog.close();
      if (deps.getWorkspaceRootKey?.() !== workspaceKey) return;
      if (requested) chosenTargets.set(`${workspaceKey ?? ""}\0${requested}`, path);
      payload.onPick(path);
    };
    candidates.forEach((path, index) => {
      const row = el("button", "history-button build-target-row", path);
      row.type = "button";
      row.setAttribute("role", "option");
      if (index === 0) row.autofocus = true;
      row.addEventListener("click", () => pick(path));
      list.append(row);
    });
    const titleRow = explainedHeading(title, requested
      ? uiText("Remembered for this file until the app closes. A % !TEX root line in the file settles it for good.", "この起動中はこのファイルについて記憶します。ファイル先頭の % !TEX root 行で固定できます。")
      : uiText("Settings › Main TeX fixes the choice for this folder.", "設定の「メイン TeX」でこのフォルダの既定にできます。"));
    const actions = el("div", "history-confirm-actions");
    const cancel = el("button", "history-button", uiText("Cancel", "キャンセル"));
    cancel.type = "button";
    cancel.addEventListener("click", () => dialog.close());
    actions.append(cancel);
    dialog.append(...titleRow, note, list, actions);
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (chooserDialog === dialog) chooserDialog = null;
    });
    document.body.append(dialog);
    chooserDialog = dialog;
    dialog.showModal();
  };

  // A guest who just joined may still be receiving the host's figures: the
  // build waits for them and starts when they are in. "Build now" (or Build
  // pressed again) does not wait.
  let awaitingFiles: (() => void) | null = null;
  let buildWithoutWaiting = false;
  const stopAwaitingFiles = () => {
    awaitingFiles?.();
    awaitingFiles = null;
    hideEditorNotice("build-files");
  };
  const incomingFiles = (state: CollabState) => (state.active && state.role === "guest" && state.incoming && state.incoming.files > 0 ? state.incoming : null);
  const awaitFiles = (explicitTarget: string | undefined, incoming: { files: number; bytes: number }) => {
    const megabytes = incoming.bytes >= 1048576 ? `${(incoming.bytes / 1048576).toFixed(incoming.bytes >= 10 * 1048576 ? 0 : 1)} MB` : `${Math.max(1, Math.round(incoming.bytes / 1024))} KB`;
    const unsubscribe = collabSession.onChange((state) => {
      if (incomingFiles(state)) return;
      stopAwaitingFiles();
      if (state.active) void startBuild(explicitTarget);
    });
    awaitingFiles = () => unsubscribe();
    showEditorNotice(buildButton instanceof HTMLElement ? buildButton : null, uiText(
      `Waiting for ${incoming.files} file(s) from the host (${megabytes}); the build starts when they arrive.`,
      `ホストからのファイルを待っています（残り ${incoming.files} 件・${megabytes}）。届きしだいビルドします。`,
    ), {
      owner: "build-files",
      durationMs: 10000,
      action: { label: uiText("Build now", "今すぐビルド"), run: () => { stopAwaitingFiles(); buildWithoutWaiting = true; void startBuild(explicitTarget); } },
    });
  };

  const startBuild = async (explicitTarget?: string) => {
    // File-selection actions may outlive the idle state in which their context
    // menu opened. Only a normal button click is allowed to cancel a build.
    if (preparingBuild || currentBuildState === "building") return;
    const now = buildWithoutWaiting || awaitingFiles !== null;
    buildWithoutWaiting = false;
    stopAwaitingFiles();
    const incoming = now ? null : incomingFiles(collabSession.getState());
    if (incoming) {
      awaitFiles(explicitTarget, incoming);
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
                `${resolveRuntimeMissingLabel(item)} is not detected. Check Settings > Build.`,
                `${resolveRuntimeMissingLabel(item)} is not detected. Please check Settings > Build.`
              ),
              action: "open-runtime" as const,
            }))
          : [
              {
                severity: "error" as const,
                message: uiText(
                  "Runtime environment is missing. Check Settings > Build.",
                  "Execution environment is insufficient. Please check Settings > Build."
                ),
                action: "open-runtime" as const,
              },
            ];
      deps.updateIssues(issues.length, summaryText, "error", issues);
      deps.setPendingBuildIssuesFocus(true);
      return;
    }

    deps.cacheCurrentBuffer(deps.getActiveGroup());
    const buildWorkspace = deps.getWorkspaceRootKey?.();

    const activePath = deps.getActiveFilePath();
    const activeTex = activePath && /\.tex$/i.test(activePath) ? activePath : undefined;
    // A plain click names the active file and lets main resolve the document
    // it belongs to (magic root, the including document, the workspace root).
    // A chosen file (context menu, or the chooser's answer remembered for this
    // fragment) is built exactly as named.
    const remembered = activeTex ? chosenTargets.get(`${buildWorkspace ?? ""}\0${activeTex}`) : undefined;
    const exactTarget = explicitTarget ?? remembered;
    const mainFile = exactTarget ?? activeTex ??
      deps.getEditorGroups().find((group) => group.currentFilePath && /\.tex$/i.test(group.currentFilePath))?.currentFilePath ??
      deps.getLastBuildMainFile() ?? deps.getRootFilePath() ?? undefined;

    if (deps.saveDirtyFiles) {
      const generation = ++preparationGeneration;
      preparingBuild = true;
      setBuildState("building");
      let saved = false;
      try { saved = await deps.saveDirtyFiles(); } catch { /* save path reports the error */ }
      if (generation !== preparationGeneration) return;
      preparingBuild = false;
      if (!saved) { setBuildState("failed"); return; }
      if (buildWorkspace !== deps.getWorkspaceRootKey?.()) { setBuildState("idle"); return; }
    }

    deps.setLastBuildMainFile(mainFile ?? null);

    const engine = localStorage.getItem("tex64.compileEngine") || "lualatex";

    const payload: {
      type: string;
      mainFile?: string;
      targetFile?: string;
      format?: boolean;
      formatSettings?: FormatSettingsPayload;
      engine?: string;
      pdfViewerMode?: "window" | "tab";
    } = { type: "build" };
    if (exactTarget) {
      payload.targetFile = exactTarget;
    } else if (mainFile) {
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
    } else {
      const message = uiText("The build request could not be started.", "ビルドを開始できませんでした。");
      setBuildState("failed", message);
      deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
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
    stale?: boolean;
  }) => {
    const inFlightSnapshot = formatInFlightSnapshot;
    formatInFlight = false;
    formatInFlightSnapshot = null;
    if (payload.stale === true) {
      formatPending = false;
      return;
    }
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
    blocks?: Array<{ x: number; y: number; width: number; height: number }>;
    pdfPath?: string | null;
    requestId?: string;
    cancelled?: boolean;
    fallback?: boolean;
    notTypeset?: boolean;
  }) => {
    if (!payload) {
      return;
    }
    const payloadRequestId =
      typeof payload.requestId === "string" && payload.requestId.trim()
        ? payload.requestId
        : null;
    if (payloadRequestId && payloadRequestId === synctexBusyRequestId) {
      setSynctexBusy(null);
    }
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
        const syncPayload: PdfSyncPayload = {
          page: payload.page,
          x: payload.x ?? 0,
          y: payload.y ?? 0,
        };
        if (pdfPath) {
          syncPayload.pdfPath = pdfPath;
        }
        if (payload.notTypeset === true) {
          // The first page stands in for a line that is not typeset.
          syncPayload.marker = false;
        } else if (payloadMeta) {
          syncPayload.sourceFile = payloadMeta.path;
          syncPayload.sourceLine = payloadMeta.line;
          syncPayload.sourceColumn = payloadMeta.column;
        }
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
        if (Array.isArray(payload.blocks) && payload.blocks.length > 1) {
          syncPayload.blocks = payload.blocks.slice(0, 32);
        }
        openedGroup.viewer.syncPdf(syncPayload);
      }
      if (payload.notTypeset === true && payloadMeta?.source !== "auto-build") {
        showSynctexNotice(
          uiText("This line does not appear in the PDF, so the first page is shown.", "この行は PDF に出力されないため、先頭ページを表示しました。"),
          "info",
        );
      }
      if (matchedInFlight) {
        flushQueuedSynctexForward();
      }
      return;
    }
    const code = (payload as { code?: string }).code;
    if (code === "CHOOSE_TARGET" && payloadMeta?.source === "manual") {
      const choice = payload as { requested?: string; candidates?: string[] };
      openTargetChooser({
        requested: choice.requested ?? payloadMeta.path,
        candidates: Array.isArray(choice.candidates) ? choice.candidates : [],
        onPick: () => requestSynctexForward(payloadMeta.path, { fallbackToTop: true, source: "manual" }),
      });
      if (matchedInFlight) flushQueuedSynctexForward();
      return;
    }
    if (code === "NEEDS_BUILD" && payloadMeta?.source === "manual") {
      // The document has no PDF yet: build it, then jump from the same file.
      const targetFile = String((payload as { targetFile?: string }).targetFile || "");
      if (targetFile) {
        pendingJumpAfterBuild = {
          path: payloadMeta.path,
          target: targetFile,
          workspaceKey: deps.getWorkspaceRootKey?.() ?? null,
          started: false,
        };
        void startBuild(targetFile);
      }
      if (matchedInFlight) flushQueuedSynctexForward();
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
    if (isEnvMissingMessage(errorMessage)) {
      // Missing TeX tools: the Issues entry carries the fix-it action.
      const issue: IssueItem = { severity: "error", message: errorMessage, action: "open-runtime" };
      deps.updateIssues(1, errorMessage, "error", [issue]);
    }
    // Shown where the click happened: replacing the Issues list would also
    // wipe the last build's warnings, and that panel is usually closed.
    const notice = synctexErrorNotice(errorMessage);
    showSynctexNotice(notice.message, "error", notice.build === true);
    if (matchedInFlight) {
      flushQueuedSynctexForward();
    }
  };

  const setupActionButtons = () => {
    if (buildButton instanceof HTMLButtonElement) {
      buildButton.addEventListener("click", () => {
        if (preparingBuild || currentBuildState === "building") {
          cancelBuild();
          return;
        }
        void startBuild();
      });
      buildButton.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (preparingBuild || currentBuildState === "building") return;
        const workspaceKey = deps.getWorkspaceRootKey?.() ?? null;
        if (!workspaceKey) return;
        const activePath = deps.getActiveFilePath();
        const texFiles = [...new Set(
          deps.getWorkspaceFiles().filter((path) => /\.tex$/i.test(path))
        )].sort((left, right) => {
          if (left === activePath) return -1;
          if (right === activePath) return 1;
          return left.localeCompare(right);
        });
        if (texFiles.length === 0) return;
        const items: ContextMenuItem[] = texFiles.map((path) => ({
          type: "action",
          label: path,
          action: () => {
            if (deps.getWorkspaceRootKey?.() !== workspaceKey) return;
            void startBuild(path);
          },
        }));
        deps.contextMenu.open(event.clientX, event.clientY, items);
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
    // The document a fragment was last built as, when the user chose it.
    documentFor: (path: string) => chosenTargets.get(`${deps.getWorkspaceRootKey?.() ?? ""}\0${path}`),
    updateSynctexButtonState,
    handleBuildPreviewState,
    setBuildState,
    startBuild,
    chooseBuildTarget,
    requestFormatCurrentFile,
    handleFormatResult,
    handleSaveFormatError,
    handleBuildLog,
    requestSynctexForward,
    handleSynctexForwardResult,
    setupActionButtons,
  };
};
