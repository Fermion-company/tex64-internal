import { getDomRefs } from "./app/dom.js";
import { createAppActions } from "./app/actions.js";
import { initEditorSettingsControls } from "./app/editor-settings/editor-settings-controls.js";
import { initFeedbackModal } from "./app/feedback-modal.js";
import { createAppContext } from "./app/context.js";
import { initBridgeHandlers } from "./app/bridge-handlers.js";
import { initBridgeSender } from "./app/bridge-sender.js";
import { initDiffModal } from "./app/diff-modal.js";
import { initContextMenu } from "./app/context-menu.js";
import { initEditorSession } from "./app/editor-session.js";
import { initEditorTabsUi } from "./app/editor-tabs-ui.js";
import { initEnvRegistry } from "./app/env-registry-ui.js";
import { initFileTreeUi } from "./app/file-tree-ui.js";
import { initMathCaptureUi } from "./app/math-capture-ui.js";
import { initMathCapture } from "./app/math-capture.js";
import { initLauncherUi } from "./app/launcher-ui.js";
import { initOnboardingUi } from "./app/onboarding-ui.js";
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
import { initUiEvents } from "./app/ui-events.js";
import { initSearchUi } from "./app/search-ui.js";
import { initSidebarVisibility } from "./app/sidebar-ui.js";
import { initBottomPanelUi } from "./app/bottom-panel-ui.js";
import { initTerminalUi } from "./app/terminal-ui.js";
import { initBillingUi } from "./app/billing-ui.js";
import { initSettingsUi } from "./app/settings-ui.js";
import { initAnnouncementsUi } from "./app/announcements-ui.js";
import { initWorkspaceController } from "./app/workspace-controller.js";
import { getUiLocale, initI18n, onUiLocaleChange, uiText } from "./app/i18n.js";
import { initAppearanceTheme } from "./app/appearance.js";
import { createIssuesProxy } from "./app/issues-proxy.js";
import { initProModeUi } from "./app/pro-mode-ui.js";
import { APP_MODE_STORAGE_KEY, initAppModeUi, resolveInitialAppMode } from "./app/app-mode.js";
import { initAiModeUi } from "./app/ai-mode-ui.js";
import { initProCanvasUi } from "./app/pro-canvas/canvas-ui.js";
import { initCodeLivePreview } from "./app/code-live-preview.js";
export const initMain = () => {
    window.addEventListener("DOMContentLoaded", () => {
        var _a, _b, _c, _d;
        initAppearanceTheme();
        initI18n();
        requestAnimationFrame(() => {
            document.body.classList.add("is-ready");
        });
        const dom = getDomRefs();
        const { tabs, settingsTab, editorHost, editorViewer, editorViewerImage, editorViewerPdf, editorHostSecondary, editorViewerSecondary, editorViewerImageSecondary, editorViewerPdfSecondary, editorFallbackSecondary, } = dom;
        let postToNative = () => false;
        let requestLiveSource = (_payload) => { };
        let requestLiveEdit = (_payload) => { };
        let isReverseSynctexEnabled = () => true;
        let blockAutoDetect = null;
        let blockEditSession = null;
        let blockInsertApi = null;
        let triggerBlockInsert = () => { };
        let resetBlockSession = (_options) => { };
        let editorSession;
        let editorTabsUi;
        let buildOps;
        let codeWorkspaceApi = null;
        let outlineUi;
        let issuesUi;
        let rootSelectorUi;
        let resizerUi;
        let aiChatUi = null;
        let billingUi = null;
        let mathCapture = null;
        const primaryViewer = createViewer({
            editorViewer,
            editorViewerImage,
            editorViewerPdf,
            editorHost,
            onPdfReverseRequest: (payload) => {
                if (!isReverseSynctexEnabled()) {
                    return;
                }
                postToNative({
                    type: "synctex:reverse",
                    page: payload.page,
                    x: payload.x,
                    y: payload.y,
                    pdfPath: payload.pdfPath,
                }, true);
            },
            onLiveSourceRequest: (payload) => requestLiveSource(payload),
            onLiveEditRequest: (payload) => requestLiveEdit(payload),
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
                postToNative({
                    type: "synctex:reverse",
                    page: payload.page,
                    x: payload.x,
                    y: payload.y,
                    pdfPath: payload.pdfPath,
                }, true);
            },
            onLiveSourceRequest: (payload) => requestLiveSource(payload),
            onLiveEditRequest: (payload) => requestLiveEdit(payload),
        });
        const bridgeWindow = window;
        bridgeWindow.__tex64TestRecognizeMath = (imageDataUrl) => recognizeMath(imageDataUrl);
        const appState = createAppState();
        const appActions = createAppActions(appState);
        const appContext = createAppContext({
            dom,
            bridgeWindow,
            viewers: { primary: primaryViewer, secondary: secondaryViewer },
        });
        let updateIssues = (_count, _summary, _status, _issues) => { };
        const issuesProxy = createIssuesProxy((count, summary, status, issues) => {
            updateIssues(count, summary, status, issues);
        });
        const updateIssuesProxy = issuesProxy.updateIssuesProxy;
        postToNative = initBridgeSender({
            bridgeWindow,
            updateIssues: updateIssuesProxy,
        });
        requestLiveSource = (payload) => {
            postToNative({ type: "live-preview:source", ...payload }, true);
        };
        const filePreviewBroker = createFilePreviewBroker((payload, silent) => postToNative(payload, silent));
        const fileExcerptBroker = createFileExcerptBroker((payload, silent) => postToNative(payload, silent));
        let workspaceController = null;
        const getWorkspaceRootKey = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getWorkspaceRootKey()) !== null && _a !== void 0 ? _a : null; };
        const getWorkspaceFiles = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getWorkspaceFiles()) !== null && _a !== void 0 ? _a : []; };
        const getWorkspaceFolders = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getWorkspaceFolders()) !== null && _a !== void 0 ? _a : []; };
        const getWorkspaceName = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getWorkspaceName()) !== null && _a !== void 0 ? _a : uiText("No workspace selected", "ワークスペース未選択"); };
        const getRootFilePath = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getRootFilePath()) !== null && _a !== void 0 ? _a : null; };
        const getRootSource = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getRootSource()) !== null && _a !== void 0 ? _a : "auto"; };
        const getBuildProfiles = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getBuildProfiles()) !== null && _a !== void 0 ? _a : []; };
        const getBuildProfileId = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getBuildProfileId()) !== null && _a !== void 0 ? _a : null; };
        const getIndexLabels = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getIndexLabels()) !== null && _a !== void 0 ? _a : []; };
        const getIndexCitations = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getIndexCitations()) !== null && _a !== void 0 ? _a : []; };
        const getIndexSections = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getIndexSections()) !== null && _a !== void 0 ? _a : []; };
        const getIndexTodos = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getIndexTodos()) !== null && _a !== void 0 ? _a : []; };
        const getCurrentIssues = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getCurrentIssues()) !== null && _a !== void 0 ? _a : []; };
        let setPendingBuildIssuesFocus = (_value) => { };
        let onFilesTabActive = () => { };
        let onSettingsTabActive = () => { };
        let setSettingsTabAlert = (_hasAlert) => { };
        let updateEditorWordWrap = (_enabled) => { };
        let pendingEditorWordWrapEnabled = null;
        const tabController = initTabController(appContext, {
            onFilesTabActive: () => onFilesTabActive(),
            onSettingsTabActive: () => onSettingsTabActive(),
        });
        const setActiveTab = (tabKey) => {
            tabController.setActiveTab(tabKey);
        };
        setSettingsTabAlert = (hasAlert) => {
            if (!(settingsTab instanceof HTMLElement)) {
                return;
            }
            settingsTab.classList.toggle("is-alert", hasAlert);
        };
        // The full-screen settings overlay covers the sidebar rail, so closing it
        // needs its own affordances: the top-right close button and Escape.
        const settingsCloseButton = document.getElementById("settings-close");
        if (settingsCloseButton instanceof HTMLElement) {
            settingsCloseButton.addEventListener("click", () => {
                setActiveTab("files");
            });
        }
        window.addEventListener("keydown", (event) => {
            if (event.key === "Escape" &&
                !event.defaultPrevented &&
                tabController.getActiveTab() === "settings") {
                event.preventDefault();
                setActiveTab("files");
            }
        });
        const envRegistry = initEnvRegistry(appContext, {
            getWorkspaceRootKey: appActions.getWorkspaceRootKey,
            onRefreshDetectedBlock: (allowTabSwitch = false) => {
                blockEditSession === null || blockEditSession === void 0 ? void 0 : blockEditSession.refreshDetectedBlock(allowTabSwitch);
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
            onPdfViewerModeChange: (mode) => {
                // A detached PDF already owns the preview surface. Give the editor the
                // full width instead of keeping a redundant integrated preview column.
                codeWorkspaceApi === null || codeWorkspaceApi === void 0 ? void 0 : codeWorkspaceApi.setPreviewEnabled(mode === "tab");
            },
            onUpdateAttentionChange: (hasAttention) => {
                setSettingsTabAlert(hasAttention);
            },
            onRuntimeSetupNeeded: () => {
                if (onboardingUi.isVisible()) {
                    return;
                }
                setActiveTab("settings");
                settingsUi.openSettingsPage("env");
            },
            onRuntimeDetection: (report, summary) => {
                // Trust the per-command sweep when it has finished, and the detection
                // report on its own before that — right after an install the sweep is
                // momentarily empty, and the gate must not flash back to the choice.
                const ready = (summary === null || summary === void 0 ? void 0 : summary.hasAnyResult) ? summary.runtimeReady : Boolean(report === null || report === void 0 ? void 0 : report.ready);
                if (ready) {
                    if (onboardingUi.isVisible()) {
                        onboardingUi.finish();
                    }
                    return;
                }
                if (onboardingUi.isVisible()) {
                    return;
                }
                onboardingUi.showChoice();
            },
            onRuntimeInstallEvent: (event) => {
                var _a, _b, _c, _d, _e;
                const variant = "full";
                if (!onboardingUi.isVisible()) {
                    return;
                }
                if (event.kind === "result") {
                    if (event.success) {
                        // The whole point of the gate: the editor appears the moment TeX works.
                        onboardingUi.finish();
                    }
                    else {
                        onboardingUi.showFailure((_a = event.message) !== null && _a !== void 0 ? _a : "");
                    }
                    return;
                }
                onboardingUi.showProgress({
                    variant,
                    percent: event.kind === "start" ? 0 : (_b = event.percent) !== null && _b !== void 0 ? _b : null,
                    phase: (_c = event.phase) !== null && _c !== void 0 ? _c : "",
                    current: (_d = event.current) !== null && _d !== void 0 ? _d : null,
                    total: (_e = event.total) !== null && _e !== void 0 ? _e : null,
                });
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
        initFeedbackModal(appContext, {
            submitFeedback: settingsUi.submitFeedback,
            onFeedbackStatus: settingsUi.onFeedbackStatus,
        });
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
        // First-run gate for TeX. It is created before anything asks about the
        // environment so the very first detection result can raise it, and it sits
        // above the launcher: a machine without TeX answers this before picking a
        // project.
        const revealAppBehindOnboarding = () => {
            if (!getWorkspaceRootKey()) {
                launcherUi.setVisible(true);
                launcherUi.setStatus({ isBusy: false, message: null });
            }
        };
        const onboardingUi = initOnboardingUi({
            startInstall: (variant) => {
                postToNative({ type: "env:install", target: "basictex", variant });
            },
            onFinished: revealAppBehindOnboarding,
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
            requestOpenFile: (path, groupKey, force) => editorSession.requestOpenFile(path, groupKey, force),
            updateIssues: updateIssuesProxy,
            isAnyGroupComposing: () => editorSession.isAnyGroupComposing(),
            postToNative: (payload) => postToNative(payload),
            getDirtyPaths: () => editorSession.getDirtyPaths(),
        });
        const detectedBlockUi = initDetectedBlockUi(dom);
        let activeBlockContext = null;
        let currentBlockDraft = null;
        /* const settingsAutoBuildButton = document.getElementById("settings-auto-build"); */ // Removed
        const { setAutoDetectedUi } = detectedBlockUi;
        const handleCursorPositionChange = (position) => {
            const activeGroup = editorSession.getActiveGroup();
            if (!activeGroup.editor)
                return;
            if (activeGroup.currentFilePath) {
                editorSession.recordCursorPosition(activeGroup.currentFilePath, position);
            }
            blockEditSession === null || blockEditSession === void 0 ? void 0 : blockEditSession.handleCursorPositionChange(position);
            aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.refreshContextBar();
        };
        let lastBuildMainFile = null;
        let blockPreviewActive = false;
        let activeBlockOriginalSnippet = null;
        let activeBlockEditMode = "none";
        let detectedBlockSnapshot = null;
        let pendingBlockApply = null;
        let updateFallback = (message) => { };
        editorSession = initEditorSession(appContext, {
            getWorkspaceFiles,
            getRootFilePath,
            postToNative: (payload, silent) => postToNative(payload, silent),
            updateIssues: updateIssuesProxy,
            getRecentIssuesSnapshot: () => issuesProxy.getLastIssueSnapshot(),
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
            workspaceViewer: {
                tryShowViewerFile: (path, kind, data, mimeType) => { var _a; return (_a = codeWorkspaceApi === null || codeWorkspaceApi === void 0 ? void 0 : codeWorkspaceApi.tryShowViewerFile(path, kind, data, mimeType)) !== null && _a !== void 0 ? _a : false; },
            },
        });
        requestLiveEdit = (payload) => {
            var _a, _b;
            const workspaceRoot = (_b = (_a = getWorkspaceRootKey()) === null || _a === void 0 ? void 0 : _a.replace(/\\/g, "/").replace(/\/$/, "")) !== null && _b !== void 0 ? _b : "";
            const sourcePath = payload.file.replace(/\\/g, "/").replace(/^\.\//, "");
            const absolute = sourcePath.startsWith("/") || /^[A-Za-z]:\//.test(sourcePath);
            const candidate = absolute && workspaceRoot && sourcePath.startsWith(`${workspaceRoot}/`)
                ? sourcePath.slice(workspaceRoot.length + 1)
                : absolute
                    ? ""
                    : sourcePath;
            const parts = candidate.split("/").filter((part) => part && part !== ".");
            const path = parts.includes("..") || parts.some((part) => part.includes("\0"))
                ? ""
                : parts.join("/");
            if (!path) {
                const message = uiText("The PDF edit is outside this workspace.", "PDF編集対象がワークスペース外です。");
                updateIssuesProxy(1, message, "error", [{ severity: "error", message }]);
                return;
            }
            const ok = editorSession.applyLivePreviewEdit({ ...payload, path });
            if (!ok) {
                const message = uiText("The source changed. Click the text again to edit it.", "ソースが更新されています。文字をもう一度クリックしてください。");
                updateIssuesProxy(1, message, "error", [{ severity: "error", message }]);
            }
        };
        codeWorkspaceApi = initProModeUi({
            setSplitViewEnabled: editorSession.setSplitViewEnabled,
        });
        codeWorkspaceApi === null || codeWorkspaceApi === void 0 ? void 0 : codeWorkspaceApi.setPreviewEnabled(settingsUi.getPdfViewerMode() === "tab");
        initProCanvasUi({
            getActiveGroup: editorSession.getActiveGroup,
            getWorkspaceFiles,
        });
        const aiModeApi = initAiModeUi({
            postToNative: (payload, silent) => postToNative(payload, silent),
        });
        // The AI mode webview sees the same host messages Code mode does, filtered
        // by its own allowlist. Registering a second listener keeps the existing
        // dispatcher untouched.
        (_b = (_a = bridgeWindow.tex64Bridge) === null || _a === void 0 ? void 0 : _a.onMessage) === null || _b === void 0 ? void 0 : _b.call(_a, (message) => aiModeApi.deliver(message));
        const appModeApi = initAppModeUi({
            initialMode: resolveInitialAppMode(localStorage.getItem(APP_MODE_STORAGE_KEY)),
            onModeChange: (mode) => {
                codeWorkspaceApi === null || codeWorkspaceApi === void 0 ? void 0 : codeWorkspaceApi.setEnabled(mode === "code");
                if (mode === "ai")
                    aiModeApi.activate();
            },
        });
        initCodeLivePreview({
            getActiveGroup: editorSession.getActiveGroup,
            getEditorGroups: editorSession.getEditorGroups,
            getAppMode: () => appModeApi.getMode(),
            getPdfViewerMode: settingsUi.getPdfViewerMode,
            getWorkspaceRoot: getWorkspaceRootKey,
            getRootFile: getRootFilePath,
            getDirtyFileSnapshots: () => editorSession.getOpenFileSnapshots({
                maxFiles: Number.POSITIVE_INFINITY,
                maxChars: Number.POSITIVE_INFINITY,
                onlyDirty: true,
            }).snapshots,
            setWorkspaceLivePreview: (url, generation) => codeWorkspaceApi === null || codeWorkspaceApi === void 0 ? void 0 : codeWorkspaceApi.setLivePreview(url, generation),
        });
        onFilesTabActive = () => editorSession.updateMiniOutline();
        const openInCodeEditor = (path, line) => {
            if (typeof line === "number") {
                editorSession.jumpToFileLine(path, line, "primary", {
                    force: true,
                    focus: false,
                });
                return;
            }
            editorSession.requestOpenFile(path, "primary", true);
        };
        const mathCaptureHandler = createMathCaptureHandler({
            recognizeMath,
            onInsertMath: (normalized) => {
                blockEditSession === null || blockEditSession === void 0 ? void 0 : blockEditSession.setMode("insert");
                blockInputApi.setActiveBlockType("math");
                blockInputApi.setMathInputValue(normalized);
            },
        });
        const diffModalApi = initDiffModal(appContext, {
            getMonacoApi: appActions.getMonacoApi,
            getActiveFilePath: () => editorSession.getActiveFilePath(),
        });
        const setPendingBlockApply = (payload) => {
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
                if (!path)
                    return null;
                const stored = editorSession.getStoredCursorPosition(path);
                if (!stored)
                    return null;
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
                mathCapture === null || mathCapture === void 0 ? void 0 : mathCapture.openCapture();
            },
        });
        const mathLiveApi = initMathLive(appContext, {
            onMathFieldCreated: blockInputApi.setMathInputElement,
            onAttachMathFieldEvents: blockInputApi.attachMathFieldEvents,
            onMathLiveReady: () => { },
            onEnsureMathLiveReady: () => { },
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
            blockEditSession === null || blockEditSession === void 0 ? void 0 : blockEditSession.setMode(mode);
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
            getBlockMode: () => { var _a; return (_a = blockEditSession === null || blockEditSession === void 0 ? void 0 : blockEditSession.getMode()) !== null && _a !== void 0 ? _a : "insert"; },
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
                blockAutoDetect === null || blockAutoDetect === void 0 ? void 0 : blockAutoDetect.syncDetectedBlockAtPosition(position, options);
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
                const context = {};
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
                openInCodeEditor(result.path, result.line);
            },
        });
        resetBlockSession = (options) => {
            var _a;
            blockPreviewActive = false;
            activeBlockOriginalSnippet = null;
            activeBlockContext = null;
            activeBlockEditMode = "none";
            detectedBlockSnapshot = null;
            pendingBlockApply = null;
            currentBlockDraft = null;
            const applyMode = (_a = options === null || options === void 0 ? void 0 : options.applyMode) !== null && _a !== void 0 ? _a : "new";
            if (applyMode === "new") {
                blockInputApi.setMathInputValue("");
            }
            if (applyMode === "detected") {
                blockEditSession === null || blockEditSession === void 0 ? void 0 : blockEditSession.refreshDetectedBlock();
            }
            else {
                blockEditSession === null || blockEditSession === void 0 ? void 0 : blockEditSession.exitEditMode();
            }
        };
        const handleLauncherStatus = (payload) => {
            var _a;
            launcherUi.setStatus({
                isBusy: typeof payload.isBusy === "boolean" ? payload.isBusy : undefined,
                message: (_a = payload.message) !== null && _a !== void 0 ? _a : null,
            });
        };
        const sidebarUi = initSidebarVisibility(appContext, {
            contextMenu,
            getActiveTab: tabController.getActiveTab,
            setActiveTab,
            normalizeTabKey: tabController.normalizeTabKey,
        });
        const terminalUi = initTerminalUi(appContext);
        const bottomPanelUi = initBottomPanelUi(appContext, {
            onTerminalShow: () => terminalUi.show(),
            onTerminalHide: () => terminalUi.hide(),
            onTerminalRestart: () => terminalUi.restart(),
        });
        // In-app billing: the Plans modal opens on the "tex64:open-plans" event fired
        // by the AI upsell CTAs and the Settings > Account entry; it reads/refreshes
        // plan + usage state through the AI chat UI.
        billingUi = initBillingUi(appContext, {
            getCurrentPlan: () => { var _a; return (_a = aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.getCurrentPlan()) !== null && _a !== void 0 ? _a : "free"; },
            onPlanRefresh: () => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.refreshPlan(),
            getUsageSnapshot: () => { var _a; return (_a = aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.getUsageSnapshot()) !== null && _a !== void 0 ? _a : null; },
            refreshUsage: () => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.refreshUsage(),
            startSignIn: () => {
                postToNative({ type: "auth:google:start" });
            },
        });
        // Settings > Account > Plans & Usage: close the full-screen settings first,
        // then open the same in-app Plans modal used everywhere else.
        (_c = document.getElementById("settings-plan-open")) === null || _c === void 0 ? void 0 : _c.addEventListener("click", () => {
            var _a;
            (_a = document.getElementById("settings-close")) === null || _a === void 0 ? void 0 : _a.click();
            window.dispatchEvent(new CustomEvent("tex64:open-plans"));
        });
        window.addEventListener("focus", () => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.refreshPlan(false));
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
            workspaceViewer: {
                getPdfPath: () => { var _a; return (_a = codeWorkspaceApi === null || codeWorkspaceApi === void 0 ? void 0 : codeWorkspaceApi.getPdfPath()) !== null && _a !== void 0 ? _a : null; },
                syncPdf: (payload) => codeWorkspaceApi === null || codeWorkspaceApi === void 0 ? void 0 : codeWorkspaceApi.syncPdf(payload),
            },
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
                    var _a;
                    const editor = group.editor;
                    (_a = editor === null || editor === void 0 ? void 0 : editor.layout) === null || _a === void 0 ? void 0 : _a.call(editor);
                });
            },
            setEditorsAutomaticLayout: (enabled) => {
                editorSession.forEachEditorGroup((group) => {
                    var _a;
                    const editor = group.editor;
                    (_a = editor === null || editor === void 0 ? void 0 : editor.updateOptions) === null || _a === void 0 ? void 0 : _a.call(editor, { automaticLayout: enabled });
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
                openInCodeEditor(entry.path, entry.line);
            },
            onJumpToSection: (entry) => {
                openInCodeEditor(entry.path, entry.line);
            },
        });
        issuesUi = initIssuesUi(appContext, {
            parseIssueDetail: editorSession.parseIssueDetail,
            onFocusIssue: (issue) => {
                editorSession.focusIssue(issue, { groupKey: "primary" });
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
            var _a;
            try {
                return (_a = localStorage.getItem("tex64.activeTab")) !== null && _a !== void 0 ? _a : undefined;
            }
            catch {
                return undefined;
            }
        })();
        const initialTab = tabController.normalizeTabKey(storedActiveTab !== null && storedActiveTab !== void 0 ? storedActiveTab : (_d = tabs.find((tab) => tab.classList.contains("is-active"))) === null || _d === void 0 ? void 0 : _d.dataset.tab);
        setActiveTab(initialTab);
        sidebarUi.loadVisibility();
        sidebarUi.applyVisibility();
        workspaceController.syncWorkspaceLabel();
        editorSession.updateBreadcrumbs();
        fileTreeUi.render();
        outlineUi.render();
        blockInputApi.setActiveBlockType(blockInputApi.getActiveBlockType());
        editorTabsUi.setupInteractions();
        try {
            mathLiveApi.setupMathField();
        }
        catch (e) {
            console.error("setupMathField error:", e);
            updateIssues(1, uiText(`Failed to initialize formula editor: ${e.message}`, "Failed to initialize formula editor: " + e.message), "error", []);
        }
        try {
            resizerUi.setup();
        }
        catch (e) {
            console.error("setupResizer error:", e);
            // リサイズ機能のIssuesは致命的ではないので通知しないか、infoレベルで
        }
        try {
            blockInputApi.attachMathInputListener();
        }
        catch (e) {
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
        // Keep the main process in sync with the in-app language so native surfaces
        // (permission dialogs, menu, notifications) match the UI, not the OS locale.
        postToNative({ type: "uiLocale", locale: getUiLocale() });
        onUiLocaleChange((locale) => postToNative({ type: "uiLocale", locale }));
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
                editorSession.saveDirtyFiles().catch(() => { });
            }
        });
        document.addEventListener("click", (event) => {
            var _a, _b, _c, _d, _e;
            const target = event.target;
            if (!(target instanceof HTMLElement)) {
                return;
            }
            const actionable = target.closest("[data-tex64-href], a[href]");
            const href = (_b = (_a = actionable === null || actionable === void 0 ? void 0 : actionable.getAttribute("data-tex64-href")) !== null && _a !== void 0 ? _a : actionable === null || actionable === void 0 ? void 0 : actionable.getAttribute("href")) !== null && _b !== void 0 ? _b : "";
            if (!href.startsWith("tex64://")) {
                return;
            }
            let url = null;
            try {
                url = new URL(href);
            }
            catch {
                url = null;
            }
            if (!url) {
                return;
            }
            const action = url.hostname || url.pathname.replace(/^\/+/, "");
            if (action !== "view-on-pdf" && action !== "open-source") {
                return;
            }
            const path = (_c = url.searchParams.get("path")) !== null && _c !== void 0 ? _c : "";
            const line = Number.parseInt((_d = url.searchParams.get("line")) !== null && _d !== void 0 ? _d : "", 10);
            const column = Number.parseInt((_e = url.searchParams.get("column")) !== null && _e !== void 0 ? _e : "1", 10);
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
            postToNative({
                type: "synctex:forward",
                path,
                line,
                column: Number.isFinite(column) && column > 0 ? column : 1,
                fallbackToTop: true,
                pdfViewerMode: settingsUi.getPdfViewerMode(),
            }, false);
        });
        const fallbackPrimary = document.getElementById("editor-fallback");
        const fallbackSecondary = editorFallbackSecondary;
        updateFallback = (message) => {
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
            app: {
                handleCommand: (command) => {
                    if (command === "file:new") {
                        setActiveTab("files");
                        fileTreeUi.requestCreate("file");
                        return;
                    }
                    if (command === "project:new") {
                        postToNative({ type: "createProject", locale: getUiLocale() });
                        return;
                    }
                    if (command === "project:open") {
                        postToNative({ type: "openWorkspace", locale: getUiLocale() });
                        return;
                    }
                    if (command === "file:save") {
                        editorSession.saveCurrentFile();
                        return;
                    }
                    if (command === "document:build") {
                        buildOps.startBuild();
                        return;
                    }
                    if (command === "settings:open") {
                        setActiveTab("settings");
                    }
                },
            },
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
                    var _a;
                    if ((payload === null || payload === void 0 ? void 0 : payload.ok) && payload.path && typeof payload.line === "number") {
                        editorSession.jumpToFileLine(payload.path, payload.line, "primary", {
                            focus: true,
                            className: "synctex-reverse-highlight",
                        });
                        return;
                    }
                    const errorMessage = (_a = payload === null || payload === void 0 ? void 0 : payload.error) !== null && _a !== void 0 ? _a : uiText("SyncTeX failed.", "SyncTeX に失敗しました。");
                    const lower = errorMessage.toLowerCase();
                    const hasMissing = errorMessage.includes("not found") || lower.includes("not found");
                    const issue = { severity: "error", message: errorMessage };
                    if (hasMissing && lower.includes("synctex")) {
                        issue.action = "open-runtime";
                    }
                    updateIssuesProxy(1, errorMessage, "error", [issue]);
                },
            },
            settings: {
                updateEnvStatus: (command, available) => settingsUi.updateEnvStatus(command, available),
                handleEnvDetectResult: (payload) => settingsUi.handleEnvDetectResult(payload),
                handleEnvInstallStart: (payload) => settingsUi.handleEnvInstallStart(payload),
                // Without this the install progress bar never moves: the events arrive on
                // the bridge and land on an undefined handler.
                handleEnvInstallProgress: (payload) => settingsUi.handleEnvInstallProgress(payload),
                handleEnvInstallResult: (payload) => settingsUi.handleEnvInstallResult(payload),
                getSettingsSnapshot: () => settingsUi.getSettingsSnapshot(),
                applySettingsPatch: (patch) => settingsUi.applySettingsPatch(patch),
            },
            agent: {
                handleSettings: (settings) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleSettings(settings),
                handleState: (state) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleState(state),
                handleStatus: (state, message, conversationId) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleStatus(state, message, conversationId),
                handleMessage: (text, conversationId) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleMessage(text, conversationId),
                handleMessageDelta: (text, conversationId) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleMessageDelta(text, conversationId),
                handleTool: (payload) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleTool(payload),
                handleProposal: (proposal) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleProposal(proposal),
                handleApplyResult: (payload) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleApplyResult(payload),
                handleUndoResult: (payload) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleUndoResult(payload),
                handleScratchpad: (payload) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleScratchpad(payload),
                handleThought: (payload) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleThought(payload),
                handleError: (message, conversationId) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleError(message, conversationId),
            },
            api: {
                handleUsage: () => { },
            },
            platform: {
                handleAuth: (payload) => {
                    aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handlePlatformAuth(payload);
                    settingsUi.handlePlatformAuth(payload);
                },
                handleAiAccess: (payload) => {
                    aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handlePlatformAiAccess(payload);
                    billingUi === null || billingUi === void 0 ? void 0 : billingUi.handlePlanUpdated();
                },
                handleUsage: (payload) => {
                    aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handlePlatformUsage(payload);
                    billingUi === null || billingUi === void 0 ? void 0 : billingUi.handleUsageUpdated();
                },
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
                applyContentToOpenFile: (path, content, options) => editorSession.applyContentToOpenFile(path, content, options),
                applyLivePreviewEdit: (payload) => editorSession.applyLivePreviewEdit(payload),
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
            requestFileExcerpt: (path, line, options) => fileExcerptBroker.requestExcerpt(path, line, options),
        });
        updateEditorWordWrap = monacoSetup.setWordWrapEnabled;
        updateEditorWordWrap(settingsUi.getEditorWordWrapEnabled());
        if (pendingEditorWordWrapEnabled !== null) {
            updateEditorWordWrap(pendingEditorWordWrapEnabled);
        }
    });
};
