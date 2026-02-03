export const initBuildOpsUi = (context, deps) => {
    const { buildButton, formatButton, synctexButton, lintButton, issuesLog, issuesLogContent, } = context.dom;
    let formatInFlight = false;
    let formatPending = false;
    let formatWarningShown = false;
    let currentBuildLog = null;
    const formatPreviewRequests = new Map();
    const formatPreviewIgnore = new Set();
    const isEnvMissingMessage = (message) => {
        const lower = message.toLowerCase();
        const hasMissing = message.includes("見つかりません") || lower.includes("not found");
        return hasMissing && lower.includes("synctex");
    };
    const resolvePdfSyncGroup = (pdfPath) => {
        var _a;
        if (!pdfPath) {
            return null;
        }
        return ((_a = deps.getEditorGroups().find((group) => group.openTabs.includes(pdfPath))) !== null && _a !== void 0 ? _a : null);
    };
    const updateSynctexButtonState = () => {
        if (!(synctexButton instanceof HTMLButtonElement)) {
            return;
        }
        const activePath = deps.getActiveFilePath();
        const rootPath = deps.getRootFilePath();
        const targetPath = activePath && activePath.endsWith(".tex") ? activePath : rootPath;
        const enabled = Boolean(targetPath && targetPath.endsWith(".tex"));
        synctexButton.disabled = !enabled;
        synctexButton.style.display = "inline-flex";
        synctexButton.textContent = "SyncTeX";
    };
    const handleBuildLog = (log) => {
        currentBuildLog = log;
        if (issuesLogContent instanceof HTMLElement) {
            issuesLogContent.textContent = log !== null && log !== void 0 ? log : "";
        }
        if (issuesLog instanceof HTMLElement) {
            issuesLog.classList.toggle("is-hidden", !log);
            if (!log) {
                issuesLog.removeAttribute("open");
            }
        }
    };
    const requestSynctexForward = (overridePath, options = {}) => {
        var _a, _b, _c, _d, _e;
        const activeGroup = deps.getActiveGroup();
        const targetPath = overridePath !== null && overridePath !== void 0 ? overridePath : activeGroup.currentFilePath;
        if (!targetPath || !targetPath.endsWith(".tex")) {
            deps.updateIssues(1, "SyncTeX は .tex ファイルでのみ利用できます。", "info", [
                { severity: "warning", message: "SyncTeX は .tex ファイルでのみ利用できます。" },
            ]);
            return;
        }
        const editor = activeGroup.editor;
        const position = activeGroup.currentFilePath === targetPath ? (_a = editor === null || editor === void 0 ? void 0 : editor.getPosition) === null || _a === void 0 ? void 0 : _a.call(editor) : null;
        const storedPosition = deps.getStoredCursorPosition(targetPath);
        const line = (_c = (_b = position === null || position === void 0 ? void 0 : position.lineNumber) !== null && _b !== void 0 ? _b : storedPosition === null || storedPosition === void 0 ? void 0 : storedPosition.line) !== null && _c !== void 0 ? _c : 1;
        const column = (_e = (_d = position === null || position === void 0 ? void 0 : position.column) !== null && _d !== void 0 ? _d : storedPosition === null || storedPosition === void 0 ? void 0 : storedPosition.column) !== null && _e !== void 0 ? _e : 1;
        deps.postToNative({
            type: "synctex:forward",
            path: targetPath,
            line,
            column,
            fallbackToTop: options.fallbackToTop === true,
            pdfViewerMode: deps.settings.getPdfViewerMode(),
        });
    };
    const setBuildState = (state, message) => {
        var _a, _b;
        const isBusy = state === "building";
        if (buildButton instanceof HTMLButtonElement) {
            buildButton.disabled = isBusy;
            buildButton.classList.toggle("is-busy", isBusy);
            buildButton.setAttribute("aria-busy", isBusy ? "true" : "false");
            buildButton.setAttribute("aria-label", isBusy ? "ビルド中" : "ビルド");
        }
        if (state === "success") {
            const targetPath = (_b = (_a = deps.getLastBuildMainFile()) !== null && _a !== void 0 ? _a : deps.getRootFilePath()) !== null && _b !== void 0 ? _b : deps.getActiveFilePath();
            if (deps.settings.getAutoSynctexOnBuildEnabled() &&
                targetPath &&
                targetPath.endsWith(".tex")) {
                requestSynctexForward(targetPath, { fallbackToTop: true });
            }
        }
        if (state === "failed") {
            deps.setPendingBuildIssuesFocus(true);
        }
        else if (state !== "building") {
            deps.setPendingBuildIssuesFocus(false);
        }
        if (message && state === "building") {
            deps.updateIssues(0, message, "info", []);
        }
    };
    const startBuild = () => {
        var _a, _b;
        deps.cacheCurrentBuffer(deps.getActiveGroup());
        const mainFile = (_a = deps.getRootFilePath()) !== null && _a !== void 0 ? _a : (deps.getActiveFilePath() && ((_b = deps.getActiveFilePath()) === null || _b === void 0 ? void 0 : _b.endsWith(".tex"))
            ? deps.getActiveFilePath()
            : undefined);
        deps.setLastBuildMainFile(mainFile !== null && mainFile !== void 0 ? mainFile : null);
        const engine = localStorage.getItem("tex64.compileEngine") || "lualatex";
        const payload = { type: "build" };
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
    const requestFormatCurrentFile = (source) => {
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
        const editor = activeGroup.editor;
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
    const requestFormatPreview = (payload) => new Promise((resolve) => {
        var _a;
        const source = (_a = payload.source) !== null && _a !== void 0 ? _a : `blockInsertPreview:${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const ok = deps.postToNative({
            type: "formatFile",
            path: payload.path,
            content: payload.content,
            source,
            formatSettings: deps.settings.buildFormatSettingsPayload(),
        }, true);
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
    const handleSaveFormatError = (formatError) => {
        if (formatError && !formatWarningShown) {
            formatWarningShown = true;
            deps.updateIssues(1, formatError, "info", [
                { severity: "warning", message: formatError },
            ]);
        }
    };
    const handleFormatResult = (payload) => {
        var _a, _b, _c;
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
                deps.updateIssues(1, (_a = payload.error) !== null && _a !== void 0 ? _a : "整形に失敗しました。", "info", [
                    { severity: "warning", message: (_b = payload.error) !== null && _b !== void 0 ? _b : "整形に失敗しました。" },
                ]);
            }
        }
        else if (typeof payload.content === "string") {
            const groupsWithFile = deps
                .getEditorGroups()
                .filter((group) => group.currentFilePath === payload.path);
            if (groupsWithFile.length > 0) {
                groupsWithFile.forEach((group) => {
                    deps.applyFormattedContent(group, payload.path, payload.content, {
                        updateSaved: false,
                    });
                    deps.renderEditorTabs(group);
                });
            }
            const activeGroup = deps.getActiveGroup();
            if (activeGroup.currentFilePath === payload.path && activeGroup.isDirty) {
                deps.saveCurrentFile().catch((message) => {
                    deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
                });
            }
        }
        if (formatPending) {
            formatPending = false;
            requestFormatCurrentFile((_c = payload.source) !== null && _c !== void 0 ? _c : "auto");
        }
    };
    const handleSynctexForwardResult = (payload) => {
        var _a, _b, _c, _d, _e, _f;
        if (!payload) {
            return;
        }
        if (payload.ok) {
            if (deps.settings.getPdfViewerMode() === "tab" && typeof payload.page === "number") {
                const pdfPath = (_a = payload.pdfPath) !== null && _a !== void 0 ? _a : null;
                const openedGroup = (_c = (_b = resolvePdfSyncGroup(pdfPath)) !== null && _b !== void 0 ? _b : deps.getEditorGroups().find((group) => group.key === "secondary")) !== null && _c !== void 0 ? _c : deps.getActiveGroup();
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
                openedGroup.viewer.syncPdf({
                    page: payload.page,
                    x: (_d = payload.x) !== null && _d !== void 0 ? _d : 0,
                    y: (_e = payload.y) !== null && _e !== void 0 ? _e : 0,
                });
            }
            return;
        }
        const errorMessage = (_f = payload.error) !== null && _f !== void 0 ? _f : "SyncTeX に失敗しました。";
        const issue = { severity: "error", message: errorMessage };
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
                        .catch((message) => {
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
        if (synctexButton instanceof HTMLButtonElement) {
            synctexButton.addEventListener("click", () => {
                if (synctexButton.disabled) {
                    return;
                }
                const activeGroup = deps.getActiveGroup();
                if (activeGroup.isDirty && activeGroup.currentFilePath) {
                    deps
                        .saveCurrentFile()
                        .then((ok) => {
                        if (ok) {
                            requestSynctexForward(null, { fallbackToTop: true });
                        }
                    })
                        .catch((message) => {
                        deps.updateIssues(1, message, "error", [
                            { severity: "error", message },
                        ]);
                    });
                    return;
                }
                requestSynctexForward(null, { fallbackToTop: true });
            });
        }
        if (lintButton instanceof HTMLButtonElement) {
            const runLint = () => {
                var _a;
                const mainFile = (_a = deps.getRootFilePath()) !== null && _a !== void 0 ? _a : deps.getActiveFilePath();
                deps.postToNative({
                    type: "lint:run",
                    mainFile,
                }, false);
            };
            lintButton.addEventListener("click", () => {
                if (lintButton.disabled) {
                    return;
                }
                const activeGroup = deps.getActiveGroup();
                if (activeGroup.isDirty && activeGroup.currentFilePath) {
                    deps
                        .saveCurrentFile()
                        .then((ok) => {
                        if (ok) {
                            runLint();
                        }
                    })
                        .catch((message) => {
                        deps.updateIssues(1, message, "error", [
                            { severity: "error", message },
                        ]);
                    });
                    return;
                }
                runLint();
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
