import { getDomRefs } from "./app/dom.js";
import { createAppActions } from "./app/actions.js";
import { initEditorSettingsControls } from "./app/editor-settings/editor-settings-controls.js";
import { createAppContext } from "./app/context.js";
import { initBridgeHandlers } from "./app/bridge-handlers.js";
import { initBridgeSender, type PostToNative } from "./app/bridge-sender.js";
import { initDiffModal } from "./app/diff-modal.js";
import { initContextMenu } from "./app/context-menu.js";
import { initEditorSession } from "./app/editor-session.js";
import { initEditorTabsUi } from "./app/editor-tabs-ui.js";
import { initEnvRegistry } from "./app/env-registry-ui.js";
import { initFileTreeUi } from "./app/file-tree-ui.js";
import { initMathCaptureUi } from "./app/math-capture-ui.js";
import { initMathCapture } from "./app/math-capture.js";
import { initLauncherUi } from "./app/launcher-ui.js";
import { initMonacoSetup } from "./app/monaco-setup.js";

import { createFilePreviewBroker } from "./app/file-preview.js";
import { createFileExcerptBroker } from "./app/file-excerpt.js";
import { recognizeMath } from "./app/math-ocr.js";
import { createMathCaptureHandler } from "./main-math-capture.js";
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
import { initBottomPanelUi } from "./app/bottom-panel-ui.js";
import { initSettingsUi } from "./app/settings-ui.js";
import { initAnnouncementsUi } from "./app/announcements-ui.js";
import { initWorkspaceController } from "./app/workspace-controller.js";
import { getUiLocale, initI18n, uiText } from "./app/i18n.js";
import { createIssuesProxy } from "./app/issues-proxy.js";
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

export const initMain = () => {
  window.addEventListener("DOMContentLoaded", () => {
    initI18n();
    requestAnimationFrame(() => {
      document.body.classList.add("is-ready");
    });

    const dom = getDomRefs();
    const {
    tabs,
    settingsTab,
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

  let postToNative: PostToNative = () => false;
  let isReverseSynctexEnabled = () => true;
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
  let mathCapture: ReturnType<typeof initMathCapture> | null = null;
  const primaryViewer = createViewer({
    editorViewer,
    editorViewerImage,
    editorViewerPdf,
    editorHost,
    onPdfReverseRequest: (payload) => {
      if (!isReverseSynctexEnabled()) {
        return;
      }
      postToNative(
        {
          type: "synctex:reverse",
          page: payload.page,
          x: payload.x,
          y: payload.y,
          pdfPath: payload.pdfPath,
        },
        true
      );
    },
  });
  const secondaryViewer = createViewer({
    editorViewer: editorViewerSecondary,
    editorViewerImage: editorViewerImageSecondary,
    editorViewerPdf: editorViewerPdfSecondary,
    editorHost: editorHostSecondary,
    onPdfReverseRequest: (payload) => {
      if (!isReverseSynctexEnabled()) {
        return;
      }
      postToNative(
        {
          type: "synctex:reverse",
          page: payload.page,
          x: payload.x,
          y: payload.y,
          pdfPath: payload.pdfPath,
        },
        true
      );
    },
  });
  const bridgeWindow = window as BridgeWindow;
  bridgeWindow.__tex64TestRecognizeMath = (imageDataUrl: string) => recognizeMath(imageDataUrl);
  const appState = createAppState();
  const appActions = createAppActions(appState);
  const appContext = createAppContext({
    dom,
    bridgeWindow,
    viewers: { primary: primaryViewer, secondary: secondaryViewer },
  });
  let updateIssues = (
    _count: number,
    _summary: string,
    _status: IssuesStatus,
    _issues: IssueItem[]
  ) => {};
  const issuesProxy = createIssuesProxy((count, summary, status, issues) => {
    updateIssues(count, summary, status, issues);
  });
  const updateIssuesProxy = issuesProxy.updateIssuesProxy;
  postToNative = initBridgeSender({
    bridgeWindow,
    updateIssues: updateIssuesProxy,
  });
  const filePreviewBroker = createFilePreviewBroker((payload, silent) =>
    postToNative(payload, silent)
  );
  const fileExcerptBroker = createFileExcerptBroker((payload, silent) =>
    postToNative(payload, silent)
  );
  let workspaceController: ReturnType<typeof initWorkspaceController> | null = null;
  const getWorkspaceRootKey = () => workspaceController?.getWorkspaceRootKey() ?? null;
  const getWorkspaceFiles = () => workspaceController?.getWorkspaceFiles() ?? [];
  const getWorkspaceFolders = () => workspaceController?.getWorkspaceFolders() ?? [];
  const getWorkspaceName = () =>
    workspaceController?.getWorkspaceName() ?? uiText("No workspace selected", "ワークスペース未選択");
  const getRootFilePath = () => workspaceController?.getRootFilePath() ?? null;
  const getRootSource = () => workspaceController?.getRootSource() ?? "auto";
  const getBuildProfiles = () => workspaceController?.getBuildProfiles() ?? [];
  const getBuildProfileId = () => workspaceController?.getBuildProfileId() ?? null;
  const getIndexLabels = () => workspaceController?.getIndexLabels() ?? [];
  const getIndexCitations = () => workspaceController?.getIndexCitations() ?? [];
  const getIndexSections = () => workspaceController?.getIndexSections() ?? [];
  const getIndexTodos = () => workspaceController?.getIndexTodos() ?? [];
  const getCurrentIssues = () => workspaceController?.getCurrentIssues() ?? [];
  let setPendingBuildIssuesFocus = (_value: boolean) => {};
  let onFilesTabActive = () => {};

  let onSettingsTabActive = () => {};
  let setSettingsTabAlert = (_hasAlert: boolean) => {};
  let updateEditorWordWrap = (_enabled: boolean) => {};
  let pendingEditorWordWrapEnabled: boolean | null = null;
  const tabController = initTabController(appContext, {
    onFilesTabActive: () => onFilesTabActive(),
    onSettingsTabActive: () => onSettingsTabActive(),
  });
  const setActiveTab = (tabKey: TabKey) => {
    tabController.setActiveTab(tabKey);
  };
  setSettingsTabAlert = (hasAlert) => {
    if (!(settingsTab instanceof HTMLElement)) {
      return;
    }
    settingsTab.classList.toggle("is-alert", hasAlert);
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
    getBuildProfiles,
    getBuildProfileId,
    postToNative: (payload, silent) => postToNative(payload, silent),
    onEditorWordWrapChange: (enabled) => {
      pendingEditorWordWrapEnabled = enabled;
      updateEditorWordWrap(enabled);
    },
    onUpdateAttentionChange: (hasAttention) => {
      setSettingsTabAlert(hasAttention);
    },
    onRuntimeSetupNeeded: () => {
      setActiveTab("settings");
      settingsUi.openSettingsPage("env");
    },
    onRequestFirstBuild: () => {
      setActiveTab("files");
      if (buildOps && typeof buildOps.startBuild === "function") {
        buildOps.startBuild();
      }
    },
  });
  isReverseSynctexEnabled = () => settingsUi.getReverseSynctexEnabled();
  onSettingsTabActive = () => settingsUi.checkEnvironmentStatus();
  initEditorSettingsControls();
  const announcementsUi = initAnnouncementsUi({
    postToNative: (payload, silent) => postToNative(payload, silent),
  });
  const contextMenu = initContextMenu(appContext);
  const launcherUi = initLauncherUi(appContext, {
    onCreate: () => {
      postToNative({ type: "createProject", locale: getUiLocale() });
    },
    onOpen: () => {
      postToNative({ type: "openWorkspace", locale: getUiLocale() });
    },
    onOpenRecent: (path) => {
      postToNative({ type: "openRecentProject", path });
    },
    onRemoveRecent: (path) => {
      postToNative({ type: "removeRecentProject", path });
    },
  });
  
  // Request recent projects on startup
  postToNative({ type: "getRecentProjects" });
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
    aiChatUi?.refreshContextBar();
  };

  let lastBuildMainFile: string | null = null;
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
      handleRenameResult: (payload) => searchUi.handleRenameResult(payload),
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

  const mathCaptureHandler = createMathCaptureHandler({
    recognizeMath,
    onInsertMath: (normalized) => {
      blockEditSession?.setMode("insert");
      blockInputApi.setActiveBlockType("math");
      blockInputApi.setMathInputValue(normalized);
    },
  });

  const diffModalApi = initDiffModal(appContext, {
    getMonacoApi: appActions.getMonacoApi,
    getActiveFilePath: () => editorSession.getActiveFilePath(),
  });

  const setPendingBlockApply = (payload: PendingBlockApply | null) => {
    pendingBlockApply = payload;
  };
  const mathCaptureUi = initMathCaptureUi(appContext);
  mathCapture = initMathCapture(appContext, {
    captureUi: mathCaptureUi,
    onCaptureImage: mathCaptureHandler.handleMathCaptureImage,
    updateIssues: updateIssuesProxy,
    getCurrentIssues,
    setStatus: (message) => {
      updateIssuesProxy(1, message, "info", [{ severity: "warning", message }]);
    },
  });

  aiChatUi = initAiChatUi(appContext, {
    postToNative: (payload, silent) => postToNative(payload, silent),
    getActiveFilePath: () => editorSession.getActiveFilePath(),
    getActiveFileSnapshot: () => editorSession.getActiveFileSnapshot(),
    getActiveCursorPosition: () => {
      const path = editorSession.getActiveFilePath();
      if (!path) return null;
      const stored = editorSession.getStoredCursorPosition(path);
      if (!stored) return null;
      return { lineNumber: stored.line, column: stored.column };
    },
    getActiveSelectionSnapshot: () => editorSession.getActiveSelectionSnapshot(),
    getOpenFileSnapshots: (options) => editorSession.getOpenFileSnapshots(options),
    getRecentIssuesSnapshot: () => issuesProxy.getLastIssueSnapshot(),
    getWorkspaceFiles,
    showDiffModal: diffModalApi.showDiffModal,
    showMultiFileDiff: diffModalApi.showMultiFileDiff,
    setDiffContext: diffModalApi.setDiffContext,
  });

  const blockInputApi = initBlockInputUi(appContext, {
    getActiveBlockContext: () => activeBlockContext,
    getWorkspaceRootKey: appActions.getWorkspaceRootKey,
    onMathFieldSubmit: () => {
      triggerBlockInsert();
    },
    onMathCaptureRequest: () => {
      mathCapture?.openCapture();
    },
  });

  const mathLiveApi = initMathLive(appContext, {
    onMathFieldCreated: blockInputApi.setMathInputElement,
    onAttachMathFieldEvents: blockInputApi.attachMathFieldEvents,
    onMathLiveReady: () => {},
    onEnsureMathLiveReady: () => {},
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
    postToNative: (payload, silent) => postToNative(payload, silent),
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
    openAiPanel: () => {
      setActiveTab("ai");
    },
    buildRenameContext: () => {
      const context: {
        activeFilePath?: string;
        activeFileContent?: string;
        activeFileIsDirty?: boolean;
        activeFileContentTruncated?: boolean;
        activeFileContentLength?: number;
        openFiles?: Array<{ path: string; isDirty: boolean; isActive: boolean }>;
        openFileSnapshots?: Array<{
          path: string;
          content: string;
          isDirty: boolean;
          truncated: boolean;
          contentLength: number;
        }>;
      } = {};
      const activeSnapshot = editorSession.getActiveFileSnapshot();
      if (activeSnapshot) {
        context.activeFilePath = activeSnapshot.path;
        context.activeFileContent = activeSnapshot.content;
        context.activeFileIsDirty = activeSnapshot.isDirty;
        context.activeFileContentTruncated = false;
        context.activeFileContentLength = activeSnapshot.content.length;
      }
      const openSnapshots = editorSession.getOpenFileSnapshots({
        maxFiles: 0,
        maxChars: 0,
      });
      if (openSnapshots) {
        const dirtySnapshots = openSnapshots.snapshots.filter((snapshot) => snapshot.isDirty);
        if (dirtySnapshots.length > 0) {
          context.openFiles = openSnapshots.files;
          context.openFileSnapshots = dirtySnapshots;
        }
      }
      return context;
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
  const bottomPanelUi = initBottomPanelUi(appContext);
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
      getRuntimeStatusSummary: settingsUi.getRuntimeStatusSummary,
      checkEnvironmentStatus: settingsUi.checkEnvironmentStatus,
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
      settingsUi.openSettingsPage("env");
    },
  });
  workspaceController = initWorkspaceController(appContext, {
    setWorkspaceRootKey: appActions.setWorkspaceRootKey,
    getActiveTab: tabController.getActiveTab,
    setActiveTab,
    issuesUi,
    editorSession: {
      clearIssueHighlight: editorSession.clearIssueHighlight,
      syncIssueMarkers: editorSession.syncIssueMarkers,
      syncWorkspaceFiles: editorSession.syncWorkspaceFiles,
      requestInitialOpen: editorSession.requestInitialOpen,
      saveDirtyFiles: editorSession.saveDirtyFiles,
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

  const storedActiveTab = (() => {
    try {
      return localStorage.getItem("tex64.activeTab") ?? undefined;
    } catch {
      return undefined;
    }
  })();
  const initialTab = tabController.normalizeTabKey(
    storedActiveTab ?? tabs.find((tab) => tab.classList.contains("is-active"))?.dataset.tab
  );
  setActiveTab(initialTab);
  sidebarUi.loadVisibility();
  sidebarUi.applyVisibility();
  workspaceController.syncWorkspaceLabel();
  editorSession.updateBreadcrumbs();
  fileTreeUi.render();
  outlineUi.render();
  blockInputApi.setActiveBlockType(blockInputApi.getActiveBlockType());
  editorTabsUi.setupInteractions();
  try { mathLiveApi.setupMathField(); } catch (e: any) { 
    console.error("setupMathField error:", e);
    updateIssues(
      1,
      uiText(`Failed to initialize formula editor: ${e.message}`, "Failed to initialize formula editor: " + e.message),
      "error",
      []
    );
  }
  try { resizerUi.setup(); } catch (e: any) { 
    console.error("setupResizer error:", e); 
    // リサイズ機能のIssuesは致命的ではないので通知しないか、infoレベルで
  }
  try { blockInputApi.attachMathInputListener(); } catch (e: any) { 
    console.error("attachMathInputListener error:", e);
    // updateIssues(1, "Formula input listener error: " + e.message, "error", []);
  }
  searchUi.render();

  rootSelectorUi.render();
  buildOps.updateSynctexButtonState();
  settingsUi.loadStartupSettings();
  updateIssues(0, uiText("Build results are summarized here.", "The build results are summarized here."), "info", []);
  if (!workspaceController.getWorkspaceRootKey()) {
    launcherUi.setVisible(true);
    launcherUi.setStatus({ isBusy: false, message: null });
  }
  postToNative({ type: "ready" }, true);
  const uiEvents = initUiEvents(appContext, {
    setActiveTab,
    normalizeTabKey: tabController.normalizeTabKey,
    getCurrentIssues,
    fileTree: {
      setTreeFocus: (value) => fileTreeUi.setTreeFocus(value),
    },
    diffModal: {
      getDiffContext: diffModalApi.getDiffContext,
      closeDiffModal: diffModalApi.closeDiffModal,
    },
    aiOps: aiChatUi,
    blockInsert: blockInsertApi,
    buildOps: {
      setupActionButtons: () => buildOps.setupActionButtons(),
      startBuild: () => buildOps.startBuild(),
    },
    rootSelectorUi: {
      setupActions: () => rootSelectorUi.setupActions(),
    },
    saveCurrentFile: () => editorSession.saveCurrentFile(),
  });
  uiEvents.setup();

  window.addEventListener("beforeunload", () => {
    // For an auto-save editor, flush any pending saves immediately rather
    // than blocking the close with a confusing "Leave site?" dialog.
    // The IPC messages are enqueued synchronously and will be processed by
    // the main process even after the renderer is torn down.
    if (editorSession.getDirtyPaths().size > 0) {
      editorSession.saveDirtyFiles().catch(() => {});
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const actionable = target.closest<HTMLElement>("[data-tex64-href], a[href]");
    const href =
      actionable?.getAttribute("data-tex64-href") ??
      actionable?.getAttribute("href") ??
      "";
    if (!href.startsWith("tex64://")) {
      return;
    }
    let url: URL | null = null;
    try {
      url = new URL(href);
    } catch {
      url = null;
    }
    if (!url) {
      return;
    }
    const action = url.hostname || url.pathname.replace(/^\/+/, "");
    if (action !== "view-on-pdf" && action !== "open-source") {
      return;
    }
    const path = url.searchParams.get("path") ?? "";
    const line = Number.parseInt(url.searchParams.get("line") ?? "", 10);
    const column = Number.parseInt(url.searchParams.get("column") ?? "1", 10);
    if (!path || !Number.isFinite(line) || line < 1) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (action === "open-source") {
      const groupKey = editorSession.getActiveEditorGroupKey();
      editorSession.jumpToFileLine(path, line, groupKey, {
        force: true,
        focus: true,
        column: Number.isFinite(column) && column > 0 ? column : 1,
      });
      return;
    }
    postToNative(
      {
        type: "synctex:forward",
        path,
        line,
        column: Number.isFinite(column) && column > 0 ? column : 1,
        fallbackToTop: true,
        pdfViewerMode: settingsUi.getPdfViewerMode(),
      },
      false
    );
  });

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
    postToNative: (payload, silent) => postToNative(payload, silent),
    updateIssues: updateIssuesProxy,
    handleWorkspaceUpdate: workspaceController.handleWorkspaceUpdate,
    handleIndexUpdate: workspaceController.handleIndexUpdate,
    handleLauncherStatus,
    handleRecentProjects: (projects) => launcherUi.updateRecentProjects(projects),
    search: {
      handleSearchUpdate: (payload) => searchUi.handleSearchUpdate(payload),
      handleRenameResult: (payload) => searchUi.handleRenameResult(payload),
    },
    build: {
      setBuildState: (state, message) => buildOps.setBuildState(state, message),
      handleFormatResult: (payload) => buildOps.handleFormatResult(payload),
      handleBuildLog: (log) => buildOps.handleBuildLog(log),
      handleSynctexForwardResult: (payload) => buildOps.handleSynctexForwardResult(payload),
      handleSynctexReverseResult: (payload) => {
        if (payload?.ok && payload.path && typeof payload.line === "number") {
          editorSession.jumpToFileLine(payload.path, payload.line, "primary", {
            focus: true,
            className: "synctex-reverse-highlight",
          });
          return;
        }
        const errorMessage = payload?.error ?? uiText("SyncTeX failed.", "SyncTeX に失敗しました。");
        const lower = errorMessage.toLowerCase();
        const hasMissing =
          errorMessage.includes("not found") || lower.includes("not found");
        const issue: IssueItem = { severity: "error", message: errorMessage };
        if (hasMissing && lower.includes("synctex")) {
          issue.action = "open-runtime";
        }
        updateIssuesProxy(1, errorMessage, "error", [issue]);
      },
    },
    settings: {
      updateEnvStatus: (command, available) => settingsUi.updateEnvStatus(command, available),
      handleEnvInstallStart: (payload) => settingsUi.handleEnvInstallStart(payload),
      handleEnvInstallResult: (payload) => settingsUi.handleEnvInstallResult(payload),
      getSettingsSnapshot: () => settingsUi.getSettingsSnapshot(),
      applySettingsPatch: (patch) => settingsUi.applySettingsPatch(patch),
    },
    agent: {
      handleSettings: (settings) => aiChatUi?.handleSettings(settings),
      handleState: (state) => aiChatUi?.handleState(state),
      handleStatus: (state, message, conversationId) =>
        aiChatUi?.handleStatus(state, message, conversationId),
      handleMessage: (text, conversationId) => aiChatUi?.handleMessage(text, conversationId),
      handleMessageDelta: (text, conversationId) =>
        aiChatUi?.handleMessageDelta(text, conversationId),
      handleTool: (payload) => aiChatUi?.handleTool(payload),
      handleProposal: (proposal) => aiChatUi?.handleProposal(proposal),
      handleApplyResult: (payload) => aiChatUi?.handleApplyResult(payload),
      handleUndoResult: (payload) => aiChatUi?.handleUndoResult(payload),
      handleScratchpad: (payload) => aiChatUi?.handleScratchpad(payload),
      handleThought: (payload) => aiChatUi?.handleThought(payload),
      handleError: (message, conversationId) =>
        aiChatUi?.handleError(message, conversationId),
    },
    api: {
      handleUsage: () => {},
    },
    platform: {
      handleAuth: (payload) => {
        aiChatUi?.handlePlatformAuth(payload);
        settingsUi.handlePlatformAuth(payload);
      },
      handleAiAccess: (payload) => aiChatUi?.handlePlatformAiAccess(payload),
      handleUsage: (payload) => aiChatUi?.handlePlatformUsage(payload),
      handleUpdate: (payload) => {
        settingsUi.handlePlatformUpdate(payload);
      },
      handleUpdateStatus: (payload) => settingsUi.handlePlatformUpdateStatus(payload),
      handleFeedback: (payload) => settingsUi.handlePlatformFeedback(payload),
      handleAnnouncements: (payload) => announcementsUi.handleAnnouncements(payload),
    },
    filePreview: {
      handlePreviewResult: (payload) => filePreviewBroker.handlePreviewResult(payload),
    },
    fileExcerpt: {
      handleExcerptResult: (payload) => fileExcerptBroker.handleExcerptResult(payload),
    },
    editorSession: {
      handleOpenFileResult: (payload) => editorSession.handleOpenFileResult(payload),
      handleSaveResult: (payload) => {
        editorSession.handleSaveResult(payload);
      },
      handleRenameResult: (payload) => editorSession.handleRenameResult(payload),
      applyContentToOpenFile: (path, content, options) =>
        editorSession.applyContentToOpenFile(path, content, options),
    },
  });

  postToNative({ type: "agent:settings:get" }, true);
  postToNative({ type: "agent:state:get" }, true);
  postToNative({ type: "announcements:check" }, true);

  const monacoSetup = initMonacoSetup(appContext, {
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
    getWorkspaceFiles,
    getWorkspaceRoot: getWorkspaceRootKey,
    onCursorPositionChange: handleCursorPositionChange,
    onCursorSelectionChange: handleCursorPositionChange,
    openAiWithSelection: () => {
      setActiveTab("ai");
      const input = document.getElementById("ai-input");
      if (input instanceof HTMLTextAreaElement) {
        input.focus();
      }
    },
    getEditorWordWrapEnabled: () => settingsUi.getEditorWordWrapEnabled(),
    requestFilePreview: (path) => filePreviewBroker.requestPreview(path),
    requestFileExcerpt: (path, line, options) =>
      fileExcerptBroker.requestExcerpt(path, line, options),
  });
  updateEditorWordWrap = monacoSetup.setWordWrapEnabled;
  updateEditorWordWrap(settingsUi.getEditorWordWrapEnabled());
  if (pendingEditorWordWrapEnabled !== null) {
    updateEditorWordWrap(pendingEditorWordWrapEnabled);
  }
  });
};
