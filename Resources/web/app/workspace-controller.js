export const initWorkspaceController = (context, deps) => {
    const { issuesTab, workspaceLabel, settingsWorkspace, } = context.dom;
    let currentIssues = [];
    let baseIssues = [];
    let duplicateLabelIssues = [];
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
    let buildProfiles = [];
    let buildProfileId = null;
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
    const getIssueLocationRank = (issue) => {
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
    const isDuplicateLabelIssue = (issue) => issue.severity === "warning" && issue.message.startsWith("Duplicate label:");
    const computeDuplicateLabelIssues = (labels) => {
        var _a;
        if (!Array.isArray(labels) || labels.length === 0) {
            return [];
        }
        const byKey = new Map();
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
            }
            else {
                byKey.set(key, [entry]);
            }
        });
        const keys = Array.from(byKey.keys()).sort((a, b) => a.localeCompare(b, "ja"));
        const issues = [];
        const maxLocationsShown = 4;
        for (const key of keys) {
            const entries = (_a = byKey.get(key)) !== null && _a !== void 0 ? _a : [];
            if (entries.length <= 1) {
                continue;
            }
            entries.sort((a, b) => {
                if (a.path !== b.path) {
                    return a.path.localeCompare(b.path, "ja");
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
                message: `Duplicate label: ${key} (${entries.length} 箇所: ${detailText})`,
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
        const merged = [];
        const seen = new Set();
        const hasBaseError = baseIssues.some((issue) => issue.severity === "error");
        const push = (issue) => {
            var _a, _b, _c;
            const token = `${issue.severity}|${(_a = issue.path) !== null && _a !== void 0 ? _a : ""}|${(_b = issue.line) !== null && _b !== void 0 ? _b : ""}|${(_c = issue.column) !== null && _c !== void 0 ? _c : ""}|${issue.message}`;
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
        const status = hasError ? "error" : sorted.length > 0 ? "info" : "success";
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
            deps.setActiveTab("issues");
        }
    };
    const updateIssues = (count, summary, status, issues) => {
        baseIssues = issues;
        mergeIssues();
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
        buildProfiles = Array.isArray(payload.buildProfiles) ? payload.buildProfiles : [];
        buildProfileId =
            typeof payload.buildProfileId === "string" && payload.buildProfileId.trim()
                ? payload.buildProfileId.trim()
                : null;
        deps.buildOps.updateSynctexButtonState();
        const rootChanged = Boolean(previousRoot && previousRoot !== payload.rootPath);
        if (rootChanged) {
            // Fire-and-forget save of dirty files before the workspace is replaced.
            deps.editorSession.saveDirtyFiles().catch(() => { });
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
