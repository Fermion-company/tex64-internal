import { getDomRefs } from "./app/dom.js";
import { createAppActions } from "./app/actions.js";
import { createAppContext } from "./app/context.js";
import { initBridgeHandlers } from "./app/bridge-handlers.js";
import { initBridgeSender } from "./app/bridge-sender.js";
import { initDiffModal } from "./app/diff-modal.js";
import { initContextMenu } from "./app/context-menu.js";
import { initEditorSession } from "./app/editor-session.js";
import { initEditorTabsUi } from "./app/editor-tabs-ui.js";
import { initEnvRegistry } from "./app/env-registry-ui.js";
import { initFileTreeUi } from "./app/file-tree-ui.js";
import { initAlchemyConvert } from "./app/alchemy-convert.js";
import { initCaptureUi } from "./app/capture-ui.js";
import { initMagicCapture } from "./app/magic-capture.js";
import { initMathCaptureUi } from "./app/math-capture-ui.js";
import { initMathCapture } from "./app/math-capture.js";
import { initLauncherUi } from "./app/launcher-ui.js";
import { initMathKeyboard } from "./app/math-keyboard-ui.js";
import { initMonacoSetup } from "./app/monaco-setup.js";
import { recognizeMath } from "./app/math-ocr.js";
import { initAiChatUi } from "./app/ai-chat-ui.js";
import { createAppState } from "./app/state.js";
import { createViewer } from "./app/viewer.js";
import { initBlockAutoDetection } from "./app/blocks/auto-detect.js";
import { initBlockEditSession } from "./app/blocks/edit-session.js";
import { initDetectedBlockUi } from "./app/blocks/detected-ui.js";
import { initBlockInputUi } from "./app/blocks/input-ui.js";
import { initMathLive } from "./app/blocks/mathlive.js";
import { initBlockInsertFlow } from "./app/blocks/insert-flow.js";
import { initBuildOpsUi } from "./app/build-ops-ui.js";

import { initIssuesUi } from "./app/issues-ui.js";
import { initOutlineUi } from "./app/outline-ui.js";
import { initRootSelectorUi } from "./app/root-selector-ui.js";
import { initSidebarResizer } from "./app/sidebar-resizer-ui.js";
import { initTabController } from "./app/tab-controller.js";
import type { TabKey } from "./app/config.js";
import { initUiEvents } from "./app/ui-events.js";
import { initSearchUi } from "./app/search-ui.js";
import { initSidebarVisibility } from "./app/sidebar-ui.js";
import { initSettingsUi } from "./app/settings-ui.js";
import { initWorkspaceController } from "./app/workspace-controller.js";
import type {
  BlockContext,
  DetectedBlockSnapshot,
  PendingBlockApply,
} from "./app/blocks/types.js";
import type {
  BlockEditMode,
  BridgeWindow,
  IssuesStatus,
  IssueItem,
} from "./app/types.js";

window.addEventListener("DOMContentLoaded", () => {
  requestAnimationFrame(() => {
    document.body.classList.add("is-ready");
  });

  const dom = getDomRefs();
  const {
    tabs,
    editorHost,
    editorViewer,
    editorViewerImage,
    editorViewerPdf,
    editorHostSecondary,
    editorViewerSecondary,
    editorViewerImageSecondary,
    editorViewerPdfSecondary,
    editorFallbackSecondary,
  } = dom;

  let blockAutoDetect: ReturnType<typeof initBlockAutoDetection> | null = null;
  let blockEditSession: ReturnType<typeof initBlockEditSession> | null = null;
  let blockInsertApi: ReturnType<typeof initBlockInsertFlow> | null = null;
  let triggerBlockInsert = () => {};
  let resetBlockSession = (_options?: { applyMode?: "detected" | "new" }) => {};
  let editorSession: ReturnType<typeof initEditorSession>;
  let editorTabsUi: ReturnType<typeof initEditorTabsUi>;
  let buildOps: ReturnType<typeof initBuildOpsUi>;

  let outlineUi: ReturnType<typeof initOutlineUi>;
  let issuesUi: ReturnType<typeof initIssuesUi>;
  let rootSelectorUi: ReturnType<typeof initRootSelectorUi>;
  let resizerUi: ReturnType<typeof initSidebarResizer>;
  let aiChatUi: ReturnType<typeof initAiChatUi> | null = null;
  let alchemyConvert: ReturnType<typeof initAlchemyConvert> | null = null;
  let magicCapture: ReturnType<typeof initMagicCapture> | null = null;
  let mathCapture: ReturnType<typeof initMathCapture> | null = null;
  const primaryViewer = createViewer({
    editorViewer,
    editorViewerImage,
    editorViewerPdf,
    editorHost,
  });
  const secondaryViewer = createViewer({
    editorViewer: editorViewerSecondary,
    editorViewerImage: editorViewerImageSecondary,
    editorViewerPdf: editorViewerPdfSecondary,
    editorHost: editorHostSecondary,
  });
  const isE2E = new URLSearchParams(window.location.search).get("e2e") === "1";

  const bridgeWindow = window as BridgeWindow;
  const appState = createAppState();
  const appActions = createAppActions(appState);
  const appContext = createAppContext({
    dom,
    bridgeWindow,
    isE2E,
    viewers: { primary: primaryViewer, secondary: secondaryViewer },
  });
  let updateIssues = (
    _count: number,
    _summary: string,
    _status: IssuesStatus,
    _issues: IssueItem[]
  ) => {};
  const updateIssuesProxy = (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => {
    updateIssues(count, summary, status, issues);
  };
  const postToNative = initBridgeSender({
    bridgeWindow,
    isE2E,
    updateIssues: updateIssuesProxy,
  });
  let workspaceController: ReturnType<typeof initWorkspaceController> | null = null;
  const getWorkspaceRootKey = () => workspaceController?.getWorkspaceRootKey() ?? null;
  const getWorkspaceFiles = () => workspaceController?.getWorkspaceFiles() ?? [];
  const getWorkspaceFolders = () => workspaceController?.getWorkspaceFolders() ?? [];
  const getWorkspaceName = () =>
    workspaceController?.getWorkspaceName() ?? "ワークスペース未選択";
  const getRootFilePath = () => workspaceController?.getRootFilePath() ?? null;
  const getRootSource = () => workspaceController?.getRootSource() ?? "auto";
  const getIndexLabels = () => workspaceController?.getIndexLabels() ?? [];
  const getIndexCitations = () => workspaceController?.getIndexCitations() ?? [];
  const getIndexSections = () => workspaceController?.getIndexSections() ?? [];
  const getIndexTodos = () => workspaceController?.getIndexTodos() ?? [];
  const getCurrentIssues = () => workspaceController?.getCurrentIssues() ?? [];
  let setPendingBuildIssuesFocus = (_value: boolean) => {};
  let onFilesTabActive = () => {};

  let onSettingsTabActive = () => {};
  let updateMathKeyboardVisibility = () => {};
  const tabController = initTabController(appContext, {
    onFilesTabActive: () => onFilesTabActive(),
    onGitTabActive: () => {},
    onSettingsTabActive: () => onSettingsTabActive(),
    updateMathKeyboardVisibility: () => updateMathKeyboardVisibility(),
  });
  let lastNonAlchemyTab: TabKey = "files";
  const setActiveTab = (tabKey: TabKey) => {
    if (tabKey !== "alchemy") {
      lastNonAlchemyTab = tabKey;
    }
    tabController.setActiveTab(tabKey);
  };
  const envRegistry = initEnvRegistry(appContext, {
    getWorkspaceRootKey: appActions.getWorkspaceRootKey,
    onRefreshDetectedBlock: (allowTabSwitch = false) => {
      blockEditSession?.refreshDetectedBlock(allowTabSwitch);
    },
  });
  const settingsUi = initSettingsUi(appContext, {
    envRegistry,
    getWorkspaceRootKey: appActions.getWorkspaceRootKey,
    postToNative: (payload, silent) => postToNative(payload, silent),
  });
  onSettingsTabActive = () => settingsUi.checkEnvironmentStatus();
  const contextMenu = initContextMenu(appContext);
  const launcherUi = initLauncherUi(appContext, {
    onCreate: (template) => {
      postToNative({ type: "createProject", template });
    },
    onOpen: () => {
      postToNative({ type: "openWorkspace" });
    },
  });
  const fileTreeUi = initFileTreeUi(appContext, {
    contextMenu,
    getWorkspaceRootKey,
    getWorkspaceName,
    getWorkspaceFiles,
    getWorkspaceFolders,
    getActiveFilePath: () => editorSession.getActiveFilePath(),
    getActiveEditorGroupKey: () => editorSession.getActiveEditorGroupKey(),
    requestOpenFile: (path, groupKey, force) =>
      editorSession.requestOpenFile(path, groupKey, force),
    updateIssues: updateIssuesProxy,
    isAnyGroupComposing: () => editorSession.isAnyGroupComposing(),
    postToNative: (payload) => postToNative(payload),
    getDirtyPaths: () => editorSession.getDirtyPaths(),
  });

  const detectedBlockUi = initDetectedBlockUi(dom);

  let activeBlockContext: BlockContext | null = null;
  let currentBlockDraft: { snippet: string; content: any } | null = null;
  /* const settingsAutoBuildButton = document.getElementById("settings-auto-build"); */ // Removed

  const { setAutoDetectedUi } = detectedBlockUi;

  const handleCursorPositionChange = (position: { lineNumber: number; column: number }) => {
    const activeGroup = editorSession.getActiveGroup();
    if (!activeGroup.editor) return;
    if (activeGroup.currentFilePath) {
      editorSession.recordCursorPosition(activeGroup.currentFilePath, position);
    }
    blockEditSession?.handleCursorPositionChange(position);
  };

  let lastBuildMainFile: string | null = null;

  if (isE2E) {
    (window as { __tex64SetLastBuildMainFile?: (path: string | null) => void })
      .__tex64SetLastBuildMainFile = (path) => {
        lastBuildMainFile = typeof path === "string" ? path : null;
      };
  }
  const ENABLE_TABLE_BLOCKS = true;
  let blockPreviewActive = false;
  let activeBlockOriginalSnippet: string | null = null;
  let activeBlockEditMode: BlockEditMode = "none";
  let detectedBlockSnapshot: DetectedBlockSnapshot | null = null;
  let pendingBlockApply: PendingBlockApply | null = null;
  let updateFallback = (message: string) => {};

  editorSession = initEditorSession(appContext, {
    getWorkspaceFiles,
    getRootFilePath,
    postToNative: (payload, silent) => postToNative(payload, silent),
    updateIssues: updateIssuesProxy,
    setAutoDetectedUi,
    setBlockPreviewActive: (active) => {
      blockPreviewActive = active;
    },
    updateFallback: (message) => updateFallback(message),
    fileTree: {
      setSelection: (path, kind) => fileTreeUi.setSelection(path, kind),
      clearSelection: () => fileTreeUi.clearSelection(),
      render: () => fileTreeUi.render(),
      loadOpenState: () => fileTreeUi.loadOpenState(),
      setTreeFocus: (value) => fileTreeUi.setTreeFocus(value),
      handleRenameResult: (payload) => fileTreeUi.handleRenameResult(payload),
    },
    outline: {
      render: () => outlineUi.render(),
    },
    editorTabs: {
      render: (group) => editorTabsUi.render(group),
    },
    buildOps: {
      updateSynctexButtonState: () => buildOps.updateSynctexButtonState(),
      handleSaveFormatError: (error) => buildOps.handleSaveFormatError(error),
    },
    settings: {
      buildFormatSettingsPayload: settingsUi.buildFormatSettingsPayload,
      updateEnvStatus: (command, available) => settingsUi.updateEnvStatus(command, available),
    },
    search: {
      handleSearchUpdate: (payload) => searchUi.handleSearchUpdate(payload),
    },
    getMonacoApi: appActions.getMonacoApi,
  });
  onFilesTabActive = () => editorSession.updateMiniOutline();

  const openInSecondaryEditor = (path: string, line?: number) => {
    if (!editorSession.getSplitViewEnabled()) {
      editorSession.setSplitViewEnabled(true);
    }
    if (typeof line === "number") {
      editorSession.jumpToFileLine(path, line, "secondary", {
        force: true,
        focus: false,
      });
      return;
    }
    editorSession.requestOpenFile(path, "secondary", true);
  };

  let mathCaptureBusy = false;

  const stripMathCaptureWrapper = (value: string) => {
    const trimmed = value.trim();
    const wrappers: Array<[string, string]> = [
      ["$$", "$$"],
      ["$", "$"],
      ["\\(", "\\)"],
      ["\\[", "\\]"],
    ];
    for (const [start, end] of wrappers) {
      if (trimmed.startsWith(start) && trimmed.endsWith(end)) {
        const inner = trimmed.slice(start.length, -end.length).trim();
        if (inner) {
          return inner;
        }
      }
    }
    return trimmed;
  };

  const normalizeMathCaptureText = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    const collapsed = trimmed.replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
    return stripMathCaptureWrapper(collapsed);
  };

  const handleMathCaptureImage = (imageDataUrl: string) => {
    if (mathCaptureBusy) {
      return;
    }
    if (!imageDataUrl) {
      const message = "キャプチャ画像がありません。";
      updateIssuesProxy(1, message, "error", [{ severity: "error", message }]);
      return;
    }
    mathCaptureBusy = true;
    recognizeMath(imageDataUrl)
      .then((latex) => {
        const normalized = normalizeMathCaptureText(latex);
        if (!normalized) {
          const message = "OCR結果が空でした。";
          updateIssuesProxy(1, message, "error", [{ severity: "error", message }]);
          return;
        }
        blockEditSession?.setMode("insert");
        blockInputApi.setActiveBlockType("math");
        blockInputApi.setMathInputValue(normalized);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "OCRに失敗しました。";
        updateIssuesProxy(1, message, "error", [{ severity: "error", message }]);
      })
      .finally(() => {
        mathCaptureBusy = false;
      });
  };

  const diffModalApi = initDiffModal(appContext, {
    getMonacoApi: appActions.getMonacoApi,
    getActiveFilePath: () => editorSession.getActiveFilePath(),
  });

  const setPendingBlockApply = (payload: PendingBlockApply | null) => {
    pendingBlockApply = payload;
  };

  alchemyConvert = initAlchemyConvert(appContext, {
    editorSession,
    updateIssues: updateIssuesProxy,
    getMonacoApi: appActions.getMonacoApi,
    onSettingsChange: (settings) => {
      postToNative({ type: "alchemy:settings:set", settings }, true);
    },
    onCaptureRequest: () => {
      magicCapture?.openCapture();
    },
    setPendingBlockApply,
    showDiffModal: diffModalApi.showDiffModal,
  });

  const captureUi = initCaptureUi(appContext);
  magicCapture = initMagicCapture(appContext, {
    captureUi,
    onCaptureImage: (imageDataUrl) => {
      alchemyConvert?.handleCaptureImage(imageDataUrl);
    },
    updateIssues: updateIssuesProxy,
    getCurrentIssues,
    setStatus: (message) => {
      alchemyConvert?.setStatus(message);
    },
  });
  const mathCaptureUi = initMathCaptureUi(appContext);
  mathCapture = initMathCapture(appContext, {
    captureUi: mathCaptureUi,
    onCaptureImage: (imageDataUrl) => {
      handleMathCaptureImage(imageDataUrl);
    },
    updateIssues: updateIssuesProxy,
    getCurrentIssues,
    setStatus: (message) => {
      updateIssuesProxy(1, message, "error", [{ severity: "error", message }]);
    },
  });

  aiChatUi = initAiChatUi(appContext, {
    postToNative: (payload, silent) => postToNative(payload, silent),
    getActiveFilePath: () => editorSession.getActiveFilePath(),
    diffModal: {
      showDiffModal: diffModalApi.showDiffModal,
      setDiffContext: diffModalApi.setDiffContext,
    },
  });

  const blockInputApi = initBlockInputUi(appContext, {
    enableTableBlocks: ENABLE_TABLE_BLOCKS,
    getActiveBlockContext: () => activeBlockContext,
    getActiveBlockEditMode: () => activeBlockEditMode,
    onMathFieldSubmit: () => {
      triggerBlockInsert();
    },
    onMathCaptureRequest: () => {
      mathCapture?.openCapture();
    },
  });

  if (isE2E) {
    (
      window as {
        __tex64SetMathInputFallback?: (value: string | null) => void;
        __tex64GetMathInputFallback?: () => string | null;
      }
    ).__tex64SetMathInputFallback = (value) => {
      blockInputApi.setMathInputFallback(value);
    };
    (
      window as { __tex64GetMathInputFallback?: () => string | null }
    ).__tex64GetMathInputFallback = () => blockInputApi.getMathInputFallback();
    (window as { __tex64GetMathInputValue?: () => string }).__tex64GetMathInputValue =
      () => blockInputApi.getMathInputValue();
  }

  const mathKeyboardApi = initMathKeyboard(appContext, {
    getActiveTab: tabController.getActiveTab,
    getActiveBlockType: () => blockInputApi.getActiveBlockType(),
    onInsertKey: blockInputApi.insertMathKey,
  });
  blockInputApi.setMathKeyboardVisibilityHandler(mathKeyboardApi.updateVisibility);
  updateMathKeyboardVisibility = () => mathKeyboardApi.updateVisibility();

  const mathLiveApi = initMathLive(appContext, {
    onMathFieldCreated: blockInputApi.setMathInputElement,
    onAttachMathFieldEvents: blockInputApi.attachMathFieldEvents,
    onMathLiveReady: mathKeyboardApi.markMathLiveReady,
    onEnsureMathLiveReady: mathKeyboardApi.ensureMathLiveReady,
  });

  blockAutoDetect = initBlockAutoDetection({
    envRegistry,
    getActiveGroup: () => editorSession.getActiveGroup(),
    getActiveBlockContext: () => activeBlockContext,
    setActiveBlockContext: (context) => {
      activeBlockContext = context;
    },
    getActiveBlockEditMode: () => activeBlockEditMode,
    setActiveBlockEditMode: (mode) => {
      activeBlockEditMode = mode;
    },
    setActiveBlockType: blockInputApi.setActiveBlockType,
    setActiveBlockOriginalSnippet: (snippet) => {
      activeBlockOriginalSnippet = snippet;
    },
    setDetectedBlockSnapshot: (snapshot) => {
      detectedBlockSnapshot = snapshot;
    },
    setCurrentBlockDraft: (draft) => {
      currentBlockDraft = draft;
    },
    setAutoDetectedUi,
    setMathInputValue: blockInputApi.setMathInputValue,
  });
  blockEditSession = initBlockEditSession({
    getActiveGroup: () => editorSession.getActiveGroup(),
    autoDetect: blockAutoDetect,
    clearMathInput: () => blockInputApi.setMathInputValue(""),
    setBlockModeUi: detectedBlockUi.setBlockMode,
  });
  detectedBlockUi.onBlockModeToggle((mode) => {
    blockEditSession?.setMode(mode);
  });
  blockInsertApi = initBlockInsertFlow(appContext, {
    getBlockDraft: blockInputApi.getBlockDraft,
    getDetectedBlockSnapshot: () => detectedBlockSnapshot,
    getActiveGroup: () => editorSession.getActiveGroup(),
    getMonacoApi: appActions.getMonacoApi,
    updateIssues: updateIssuesProxy,
    updateFallback: (message) => {
      updateFallback(message);
    },
    getEditorAlignEnvEnabled: settingsUi.getEditorAlignEnvEnabled,
    requestFormatCurrentFile: (source) => {
      buildOps.requestFormatCurrentFile(source);
    },
    requestFormatPreview: (payload) => buildOps.requestFormatPreview(payload),
    postToNative: (payload, silent) => postToNative(payload, silent),
    getIsE2E: () => isE2E,
    getMathInputValue: blockInputApi.getMathInputValue,
    getBlockMode: () => blockEditSession?.getMode() ?? "insert",
    resetBlockSession: (options) => resetBlockSession(options),
    getPendingBlockApply: () => pendingBlockApply,
    setPendingBlockApply: (payload) => {
      pendingBlockApply = payload;
    },
    setCurrentBlockDraft: (draft) => {
      currentBlockDraft = draft;
    },
    getBlockPreviewActive: () => blockPreviewActive,
    setBlockPreviewActive: (active) => {
      blockPreviewActive = active;
    },
    showDiffModal: diffModalApi.showDiffModal,
    refreshDetectedBlock: (position, options) => {
      blockAutoDetect?.syncDetectedBlockAtPosition(position, options);
    },
  });
  triggerBlockInsert = blockInsertApi.triggerInsert;

  const searchUi = initSearchUi(appContext, {
    getWorkspaceRootKey: appActions.getWorkspaceRootKey,
    postToNative: (message) => {
      postToNative(message);
    },
    openSearchResult: (result) => {
      openInSecondaryEditor(result.path, result.line);
    },
  });

  resetBlockSession = (options) => {
    blockPreviewActive = false;
    activeBlockOriginalSnippet = null;
    activeBlockContext = null;
    activeBlockEditMode = "none";
    detectedBlockSnapshot = null;
    pendingBlockApply = null;
    currentBlockDraft = null;
    const applyMode = options?.applyMode ?? "new";
    if (applyMode === "new") {
      blockInputApi.setMathInputValue("");
    }
    if (applyMode === "detected") {
      blockEditSession?.refreshDetectedBlock();
    } else {
      blockEditSession?.exitEditMode();
    }
  };

  const handleLauncherStatus = (payload: { isBusy?: boolean; message?: string }) => {
    launcherUi.setStatus({
      isBusy: typeof payload.isBusy === "boolean" ? payload.isBusy : undefined,
      message: payload.message ?? null,
    });
  };
  const sidebarUi = initSidebarVisibility(appContext, {
    contextMenu,
    getActiveTab: tabController.getActiveTab,
    setActiveTab,
    normalizeTabKey: tabController.normalizeTabKey,
  });
  editorTabsUi = initEditorTabsUi(appContext, {
    getGroups: () => editorSession.getEditorGroups(),
    getGroup: editorSession.getEditorGroup,
    getActiveGroupKey: () => editorSession.getActiveEditorGroupKey(),
    isActiveGroup: editorSession.isActiveGroup,
    setActiveGroup: editorSession.setActiveGroup,
    requestOpenFile: editorSession.requestOpenFile,
    closeTab: editorSession.closeTab,
    addOpenTab: editorSession.addOpenTab,
    scheduleAfterComposition: editorSession.scheduleAfterComposition,
    getDirtyPaths: () => editorSession.getDirtyPaths(),
    setEditorEmptyState: editorSession.setEditorGroupEmptyState,
    updateSynctexButtonState: () => buildOps.updateSynctexButtonState(),
    getSplitViewEnabled: () => editorSession.getSplitViewEnabled(),
    setSplitViewEnabled: editorSession.setSplitViewEnabled,
  });
  buildOps = initBuildOpsUi(appContext, {
    getActiveGroup: editorSession.getActiveGroup,
    getActiveEditorGroupKey: () => editorSession.getActiveEditorGroupKey(),
    getActiveFilePath: () => editorSession.getActiveFilePath(),
    getRootFilePath,
    getLastBuildMainFile: () => lastBuildMainFile,
    setLastBuildMainFile: (path) => {
      lastBuildMainFile = path;
    },
    getStoredCursorPosition: (path) => editorSession.getStoredCursorPosition(path),
    cacheCurrentBuffer: editorSession.cacheCurrentBuffer,
    saveCurrentFile: () => editorSession.saveCurrentFile(),
    postToNative: (payload, silent) => postToNative(payload, silent),
    updateIssues: updateIssuesProxy,
    setPendingBuildIssuesFocus: (value) => setPendingBuildIssuesFocus(value),
    applyFormattedContent: editorSession.applyFormattedContent,
    getEditorGroups: () => editorSession.getEditorGroups(),
    renderEditorTabs: (group) => editorTabsUi.render(group),
    requestOpenFile: editorSession.requestOpenFile,
    getSplitViewEnabled: () => editorSession.getSplitViewEnabled(),
    setSplitViewEnabled: (enabled) => editorSession.setSplitViewEnabled(enabled),
    settings: {
      getPdfViewerMode: settingsUi.getPdfViewerMode,
      getAutoSynctexOnBuildEnabled: settingsUi.getAutoSynctexOnBuildEnabled,
      buildFormatSettingsPayload: settingsUi.buildFormatSettingsPayload,
    },
  });

  rootSelectorUi = initRootSelectorUi(appContext, {
    getWorkspaceRootKey,
    getWorkspaceFiles,
    getRootFilePath,
    getRootSource,
    postToNative: (payload, silent) => postToNative(payload, silent),
    updateIssues: updateIssuesProxy,
  });
  resizerUi = initSidebarResizer(appContext, {
    layoutEditors: () => {
      editorSession.forEachEditorGroup((group) => {
        const editor = group.editor as { layout?: () => void };
        editor?.layout?.();
      });
    },
  });
  outlineUi = initOutlineUi(appContext, {
    getActiveFilePath: () => editorSession.getActiveFilePath(),
    getWorkspaceRootKey,
    getIndexLabels,
    getIndexCitations,
    getIndexSections,
    getIndexTodos,
    onJumpToLocation: (entry) => {
      if (!entry.path || !entry.line) {
        return;
      }
      openInSecondaryEditor(entry.path, entry.line);
    },
    onJumpToSection: (entry) => {
      openInSecondaryEditor(entry.path, entry.line);
    },
  });
  issuesUi = initIssuesUi(appContext, {
    parseIssueDetail: editorSession.parseIssueDetail,
    onFocusIssue: (issue) => {
      editorSession.focusIssue(issue);
    },
    onOpenRuntimeSettings: () => {
      setActiveTab("settings");
      settingsUi.openSettingsPage("runtime");
    },
  });
  workspaceController = initWorkspaceController(appContext, {
    setWorkspaceRootKey: appActions.setWorkspaceRootKey,
    setActiveTab,
    issuesUi,
    editorSession: {
      clearIssueHighlight: editorSession.clearIssueHighlight,
      syncWorkspaceFiles: editorSession.syncWorkspaceFiles,
      requestInitialOpen: editorSession.requestInitialOpen,
    },
    outlineUi,
    buildOps,
    settingsUi,
    launcherUi,
    searchUi,

    diffModal: {
      setDiffContext: diffModalApi.setDiffContext,
    },
    envRegistry,
    rootSelectorUi,
    setLastBuildMainFile: (path) => {
      lastBuildMainFile = path;
    },
  });
  updateIssues = workspaceController.updateIssues;
  setPendingBuildIssuesFocus = workspaceController.setPendingBuildIssuesFocus;

  const initialTab = tabController.normalizeTabKey(
    tabs.find((tab) => tab.classList.contains("is-active"))?.dataset.tab
  );
  setActiveTab(initialTab);
  sidebarUi.loadVisibility();
  sidebarUi.applyVisibility();
  workspaceController.syncWorkspaceLabel();
  editorSession.updateBreadcrumbs();
  fileTreeUi.render();
  outlineUi.render();
  blockInputApi.setActiveBlockType(blockInputApi.getActiveBlockType());
  mathKeyboardApi.setTab("analysis");
  editorTabsUi.setupInteractions();
  try { mathLiveApi.setupMathField(); } catch (e: any) { 
    console.error("setupMathField error:", e);
    updateIssues(1, "数式エディタの初期化に失敗しました: " + e.message, "error", []);
  }
  try { resizerUi.setup(); } catch (e: any) { 
    console.error("setupResizer error:", e); 
    // リサイズ機能のエラーは致命的ではないので通知しないか、infoレベルで
  }
  try { blockInputApi.attachMathInputListener(); } catch (e: any) { 
    console.error("attachMathInputListener error:", e);
    // updateIssues(1, "数式入力リスナーのエラー: " + e.message, "error", []);
  }
  try { blockInputApi.updateMathPreview(); } catch (e: any) { console.error("updateMathPreview error:", e); }
  searchUi.render();

  rootSelectorUi.render();
  buildOps.updateSynctexButtonState();
  settingsUi.loadStartupSettings();
  updateIssues(0, "ビルド結果はここに要約します。", "info", []);
  if (!workspaceController.getWorkspaceRootKey()) {
    launcherUi.setVisible(true);
    launcherUi.setStatus({ isBusy: false, message: null });
  }
  postToNative({ type: "ready" }, true);
  const uiEvents = initUiEvents(appContext, {
    setActiveTab,
    normalizeTabKey: tabController.normalizeTabKey,
    getCurrentIssues,
    saveCurrentFile: () => editorSession.saveCurrentFile(),
    updateIssues,
    fileTree: {
      setTreeFocus: (value) => fileTreeUi.setTreeFocus(value),
    },
    diffModal: {
      getDiffContext: diffModalApi.getDiffContext,
      closeDiffModal: diffModalApi.closeDiffModal,
    },
    gitOps: {
      requestCommit: () => {},
      requestRestore: (_hash: string) => {},
      setupActions: () => {},
    },
    aiOps: aiChatUi,
    blockInsert: blockInsertApi,
    buildOps: {
      setupActionButtons: () => buildOps.setupActionButtons(),
    },
    rootSelectorUi: {
      setupActions: () => rootSelectorUi.setupActions(),
    },
  });
  uiEvents.setup();

  const fallbackPrimary = document.getElementById("editor-fallback");
  const fallbackSecondary = editorFallbackSecondary;

  updateFallback = (message: string) => {
    [fallbackPrimary, fallbackSecondary].forEach((fallback) => {
      if (!fallback) {
        return;
      }
      const body = fallback.querySelector("p");
      if (body) {
        body.textContent = message;
      }
    });
  };

  initBridgeHandlers({
    bridgeWindow,
    updateIssues: workspaceController.updateIssues,
    handleWorkspaceUpdate: workspaceController.handleWorkspaceUpdate,
    handleIndexUpdate: workspaceController.handleIndexUpdate,
    handleLauncherStatus,
    search: {
      handleSearchUpdate: (payload) => searchUi.handleSearchUpdate(payload),
    },
    git: {
      handleUpdate: (_payload: any) => {},
      handleDiff: (_payload: any) => {},
      handleActionResult: (_payload: any) => {},
    },
    build: {
      setBuildState: (state, message) => buildOps.setBuildState(state, message),
      handleFormatResult: (payload) => buildOps.handleFormatResult(payload),
      handleBuildLog: (log) => buildOps.handleBuildLog(log),
      handleSynctexForwardResult: (payload) => buildOps.handleSynctexForwardResult(payload),
    },
    alchemy: {
      handleSettings: ({ settings }) => {
        alchemyConvert?.setSettings(settings);
      },
    },
    settings: {
      updateEnvStatus: (command, available) => settingsUi.updateEnvStatus(command, available),
    },
    agent: {
      handleSettings: (settings) => aiChatUi?.handleSettings(settings),
      handleStatus: (state, message, conversationId) =>
        aiChatUi?.handleStatus(state, message, conversationId),
      handleMessage: (text, conversationId) => aiChatUi?.handleMessage(text, conversationId),
      handleTool: (payload) => aiChatUi?.handleTool(payload),
      handleProposal: (proposal) => aiChatUi?.handleProposal(proposal),
      handleApplyResult: (payload) => aiChatUi?.handleApplyResult(payload),
      handleError: (message, conversationId) =>
        aiChatUi?.handleError(message, conversationId),
    },
    editorSession: {
      handleOpenFileResult: (payload) => editorSession.handleOpenFileResult(payload),
      handleSaveResult: (payload) => editorSession.handleSaveResult(payload),
      handleRenameResult: (payload) => editorSession.handleRenameResult(payload),
    },
  });

  postToNative({ type: "alchemy:settings:get" }, true);

  initMonacoSetup(appContext, {
    editorSession,
    editorTabs: {
      render: (group) => editorTabsUi.render(group),
    },
    fileTree: {
      render: () => fileTreeUi.render(),
      setTreeFocus: (focus) => fileTreeUi.setTreeFocus(focus),
    },
    updateFallback,
    setMonacoApi: (api) => appActions.setMonacoApi(api),
    getIndexLabels,
    getIndexCitations,
    onCursorPositionChange: handleCursorPositionChange,
    onCursorSelectionChange: handleCursorPositionChange,
  });
});
