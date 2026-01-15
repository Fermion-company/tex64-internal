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
import { initUiEvents } from "./app/ui-events.js";
import { initSearchUi } from "./app/search-ui.js";
import { initSidebarVisibility } from "./app/sidebar-ui.js";
import { initSettingsUi } from "./app/settings-ui.js";
import { initWorkspaceController } from "./app/workspace-controller.js";
window.addEventListener("DOMContentLoaded", () => {
    var _a;
    requestAnimationFrame(() => {
        document.body.classList.add("is-ready");
    });
    const dom = getDomRefs();
    const { tabs, editorHost, editorViewer, editorViewerImage, editorViewerPdf, editorHostSecondary, editorViewerSecondary, editorViewerImageSecondary, editorViewerPdfSecondary, editorFallbackSecondary, } = dom;
    let blockAutoDetect = null;
    let blockEditSession = null;
    let blockInsertApi = null;
    let triggerBlockInsert = () => { };
    let resetBlockSession = (_options) => { };
    let editorSession;
    let editorTabsUi;
    let buildOps;
    let outlineUi;
    let issuesUi;
    let rootSelectorUi;
    let resizerUi;
    let aiChatUi = null;
    let alchemyConvert = null;
    let magicCapture = null;
    let mathCapture = null;
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
    const bridgeWindow = window;
    const appState = createAppState();
    const appActions = createAppActions(appState);
    const appContext = createAppContext({
        dom,
        bridgeWindow,
        isE2E,
        viewers: { primary: primaryViewer, secondary: secondaryViewer },
    });
    let updateIssues = (_count, _summary, _status, _issues) => { };
    let lastIssueSnapshot = null;
    const recordIssuesSnapshot = (count, summary, status, issues) => {
        lastIssueSnapshot = {
            count,
            summary,
            status,
            issues,
            updatedAt: Date.now(),
        };
    };
    const updateIssuesProxy = (count, summary, status, issues) => {
        const normalizedIssues = issues.length > 0
            ? issues
            : count > 0
                ? [
                    {
                        severity: status === "error" ? "error" : "warning",
                        message: (summary === null || summary === void 0 ? void 0 : summary.trim()) || "エラーが発生しました。",
                    },
                ]
                : [];
        const normalizedCount = count > 0 ? Math.max(count, normalizedIssues.length) : normalizedIssues.length;
        recordIssuesSnapshot(normalizedCount, summary, status, normalizedIssues);
        updateIssues(normalizedCount, summary, status, normalizedIssues);
    };
    const postToNative = initBridgeSender({
        bridgeWindow,
        isE2E,
        updateIssues: updateIssuesProxy,
    });
    let workspaceController = null;
    const getWorkspaceRootKey = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getWorkspaceRootKey()) !== null && _a !== void 0 ? _a : null; };
    const getWorkspaceFiles = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getWorkspaceFiles()) !== null && _a !== void 0 ? _a : []; };
    const getWorkspaceFolders = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getWorkspaceFolders()) !== null && _a !== void 0 ? _a : []; };
    const getWorkspaceName = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getWorkspaceName()) !== null && _a !== void 0 ? _a : "ワークスペース未選択"; };
    const getRootFilePath = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getRootFilePath()) !== null && _a !== void 0 ? _a : null; };
    const getRootSource = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getRootSource()) !== null && _a !== void 0 ? _a : "auto"; };
    const getIndexLabels = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getIndexLabels()) !== null && _a !== void 0 ? _a : []; };
    const getIndexCitations = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getIndexCitations()) !== null && _a !== void 0 ? _a : []; };
    const getIndexSections = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getIndexSections()) !== null && _a !== void 0 ? _a : []; };
    const getIndexTodos = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getIndexTodos()) !== null && _a !== void 0 ? _a : []; };
    const getCurrentIssues = () => { var _a; return (_a = workspaceController === null || workspaceController === void 0 ? void 0 : workspaceController.getCurrentIssues()) !== null && _a !== void 0 ? _a : []; };
    let setPendingBuildIssuesFocus = (_value) => { };
    let onFilesTabActive = () => { };
    let onSettingsTabActive = () => { };
    let updateMathKeyboardVisibility = () => { };
    const tabController = initTabController(appContext, {
        onFilesTabActive: () => onFilesTabActive(),
        onGitTabActive: () => { },
        onSettingsTabActive: () => onSettingsTabActive(),
        updateMathKeyboardVisibility: () => updateMathKeyboardVisibility(),
    });
    let lastNonAlchemyTab = "files";
    const setActiveTab = (tabKey) => {
        if (tabKey !== "alchemy") {
            lastNonAlchemyTab = tabKey;
        }
        tabController.setActiveTab(tabKey);
    };
    const envRegistry = initEnvRegistry(appContext, {
        getWorkspaceRootKey: appActions.getWorkspaceRootKey,
        onRefreshDetectedBlock: (allowTabSwitch = false) => {
            blockEditSession === null || blockEditSession === void 0 ? void 0 : blockEditSession.refreshDetectedBlock(allowTabSwitch);
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
    };
    let lastBuildMainFile = null;
    if (isE2E) {
        window
            .__tex64SetLastBuildMainFile = (path) => {
            lastBuildMainFile = typeof path === "string" ? path : null;
        };
    }
    const ENABLE_TABLE_BLOCKS = true;
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
    const openInSecondaryEditor = (path, line) => {
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
    const stripMathCaptureWrapper = (value) => {
        const trimmed = value.trim();
        const wrappers = [
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
    const stripLatexCommandBlocks = (value, commands) => {
        let result = "";
        for (let i = 0; i < value.length; i += 1) {
            if (value[i] !== "\\") {
                result += value[i];
                continue;
            }
            let name = "";
            let cursor = i + 1;
            while (cursor < value.length && /[A-Za-z]/.test(value[cursor])) {
                name += value[cursor];
                cursor += 1;
            }
            if (!name || !commands.has(name)) {
                result += value[i];
                continue;
            }
            while (cursor < value.length && /\s/.test(value[cursor])) {
                cursor += 1;
            }
            if (value[cursor] !== "{") {
                result += value[i];
                continue;
            }
            let depth = 0;
            let end = cursor;
            for (; end < value.length; end += 1) {
                if (value[end] === "{") {
                    depth += 1;
                }
                else if (value[end] === "}") {
                    depth -= 1;
                    if (depth === 0) {
                        break;
                    }
                }
            }
            if (depth === 0) {
                i = end;
                continue;
            }
            result += value[i];
        }
        return result;
    };
    const normalizeMathCaptureText = (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
            return "";
        }
        const unwrapped = stripMathCaptureWrapper(trimmed);
        const noWhitespace = unwrapped.replace(/\s+/g, "");
        const textCommands = new Set([
            "text",
            "mbox",
            "textnormal",
            "textrm",
            "textsf",
            "texttt",
            "textbf",
            "textit",
        ]);
        let cleaned = stripLatexCommandBlocks(noWhitespace, textCommands);
        cleaned = cleaned.replace(/\\newline/g, "").replace(/\\\\/g, "");
        cleaned = cleaned.replace(/[^A-Za-z0-9\\{}_^=+\-*/().,\[\]|<>!:]/g, "");
        return cleaned;
    };
    const handleMathCaptureImage = (imageDataUrl) => {
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
            blockEditSession === null || blockEditSession === void 0 ? void 0 : blockEditSession.setMode("insert");
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
    const setPendingBlockApply = (payload) => {
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
            magicCapture === null || magicCapture === void 0 ? void 0 : magicCapture.openCapture();
        },
        setPendingBlockApply,
        showDiffModal: diffModalApi.showDiffModal,
    });
    const captureUi = initCaptureUi(appContext);
    magicCapture = initMagicCapture(appContext, {
        captureUi,
        onCaptureImage: (imageDataUrl) => {
            alchemyConvert === null || alchemyConvert === void 0 ? void 0 : alchemyConvert.handleCaptureImage(imageDataUrl);
        },
        updateIssues: updateIssuesProxy,
        getCurrentIssues,
        setStatus: (message) => {
            alchemyConvert === null || alchemyConvert === void 0 ? void 0 : alchemyConvert.setStatus(message);
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
        getActiveFileSnapshot: () => editorSession.getActiveFileSnapshot(),
        getOpenFileSnapshots: (options) => editorSession.getOpenFileSnapshots(options),
        getRecentIssuesSnapshot: () => lastIssueSnapshot,
    });
    const blockInputApi = initBlockInputUi(appContext, {
        enableTableBlocks: ENABLE_TABLE_BLOCKS,
        getActiveBlockContext: () => activeBlockContext,
        getActiveBlockEditMode: () => activeBlockEditMode,
        onMathFieldSubmit: () => {
            triggerBlockInsert();
        },
        onMathCaptureRequest: () => {
            mathCapture === null || mathCapture === void 0 ? void 0 : mathCapture.openCapture();
        },
    });
    if (isE2E) {
        window.__tex64SetMathInputFallback = (value) => {
            blockInputApi.setMathInputFallback(value);
        };
        window.__tex64GetMathInputFallback = () => blockInputApi.getMathInputFallback();
        window.__tex64GetMathInputValue =
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
        requestFormatPreview: (payload) => buildOps.requestFormatPreview(payload),
        postToNative: (payload, silent) => postToNative(payload, silent),
        getIsE2E: () => isE2E,
        getMathInputValue: blockInputApi.getMathInputValue,
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
            openInSecondaryEditor(result.path, result.line);
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
                var _a;
                const editor = group.editor;
                (_a = editor === null || editor === void 0 ? void 0 : editor.layout) === null || _a === void 0 ? void 0 : _a.call(editor);
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
    const initialTab = tabController.normalizeTabKey((_a = tabs.find((tab) => tab.classList.contains("is-active"))) === null || _a === void 0 ? void 0 : _a.dataset.tab);
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
    try {
        mathLiveApi.setupMathField();
    }
    catch (e) {
        console.error("setupMathField error:", e);
        updateIssues(1, "数式エディタの初期化に失敗しました: " + e.message, "error", []);
    }
    try {
        resizerUi.setup();
    }
    catch (e) {
        console.error("setupResizer error:", e);
        // リサイズ機能のエラーは致命的ではないので通知しないか、infoレベルで
    }
    try {
        blockInputApi.attachMathInputListener();
    }
    catch (e) {
        console.error("attachMathInputListener error:", e);
        // updateIssues(1, "数式入力リスナーのエラー: " + e.message, "error", []);
    }
    try {
        blockInputApi.updateMathPreview();
    }
    catch (e) {
        console.error("updateMathPreview error:", e);
    }
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
            requestCommit: () => { },
            requestRestore: (_hash) => { },
            setupActions: () => { },
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
        search: {
            handleSearchUpdate: (payload) => searchUi.handleSearchUpdate(payload),
        },
        git: {
            handleUpdate: (_payload) => { },
            handleDiff: (_payload) => { },
            handleActionResult: (_payload) => { },
        },
        build: {
            setBuildState: (state, message) => buildOps.setBuildState(state, message),
            handleFormatResult: (payload) => buildOps.handleFormatResult(payload),
            handleBuildLog: (log) => buildOps.handleBuildLog(log),
            handleSynctexForwardResult: (payload) => buildOps.handleSynctexForwardResult(payload),
        },
        alchemy: {
            handleSettings: ({ settings }) => {
                alchemyConvert === null || alchemyConvert === void 0 ? void 0 : alchemyConvert.setSettings(settings);
            },
        },
        settings: {
            updateEnvStatus: (command, available) => settingsUi.updateEnvStatus(command, available),
            getSettingsSnapshot: () => settingsUi.getSettingsSnapshot(),
            applySettingsPatch: (patch) => settingsUi.applySettingsPatch(patch),
        },
        agent: {
            handleSettings: (settings) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleSettings(settings),
            handleStatus: (state, message, conversationId) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleStatus(state, message, conversationId),
            handleMessage: (text, conversationId) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleMessage(text, conversationId),
            handleMessageDelta: (text, conversationId) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleMessageDelta(text, conversationId),
            handleTool: (payload) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleTool(payload),
            handleProposal: (proposal) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleProposal(proposal),
            handleApplyResult: (payload) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleApplyResult(payload),
            handleError: (message, conversationId) => aiChatUi === null || aiChatUi === void 0 ? void 0 : aiChatUi.handleError(message, conversationId),
        },
        editorSession: {
            handleOpenFileResult: (payload) => editorSession.handleOpenFileResult(payload),
            handleSaveResult: (payload) => editorSession.handleSaveResult(payload),
            handleRenameResult: (payload) => editorSession.handleRenameResult(payload),
            applyContentToOpenFile: (path, content, options) => editorSession.applyContentToOpenFile(path, content, options),
        },
    });
    postToNative({ type: "alchemy:settings:get" }, true);
    postToNative({ type: "agent:settings:get" }, true);
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
