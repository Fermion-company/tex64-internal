export const initWorkspaceController = (context, deps) => {
    const { issuesTab, workspaceLabel, settingsWorkspace, } = context.dom;
    let currentIssues = [];
    let pendingBuildIssuesFocus = false;
    let indexLabels = [];
    let indexCitations = [];
    let indexSections = [];
    let indexTodos = [];
    let workspaceFiles = [];
    let workspaceFolders = [];
    let workspaceName = "ワークスペース未選択";
    let workspaceRootKey = null;
    let rootFilePath = null;
    let rootSource = "auto";
    const setText = (element, text) => {
        if (element) {
            element.textContent = text;
        }
    };
    const syncWorkspaceLabel = () => {
        setText(workspaceLabel, workspaceName);
    };
    const setWorkspaceLabel = (label) => {
        workspaceName = label;
        syncWorkspaceLabel();
    };
    const setIssuesStatus = (status) => {
        if (issuesTab instanceof HTMLElement) {
            issuesTab.dataset.status = status;
        }
    };
    const updateIssues = (count, summary, status, issues) => {
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
    const handleWorkspaceUpdate = (payload) => {
        var _a;
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
        rootFilePath = ((_a = payload.rootFile) === null || _a === void 0 ? void 0 : _a.trim()) ? payload.rootFile : null;
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
    const handleIndexUpdate = (payload) => {
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
