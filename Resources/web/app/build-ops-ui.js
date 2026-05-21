import { uiText } from "./i18n.js";
export const initBuildOpsUi = (context, deps) => {
    const { buildButton, formatButton, synctexButton, issuesLog, issuesLogContent, } = context.dom;
    let formatInFlight = false;
    let formatPending = false;
    let formatWarningShown = false;
    let formatInFlightSnapshot = null;
    let currentBuildLog = null;
    let currentBuildState = "idle";
    let synctexForwardRequestOrder = 0;
    let synctexForwardLastAppliedOrder = 0;
    let synctexManualPriorityUntil = 0;
    let synctexForwardInFlight = null;
    let queuedSynctexForward = null;
    const synctexForwardOrderByRequestId = new Map();
    const synctexForwardInFlightTimeoutMs = 12000;
    const buildSynctexForwardRequestId = (() => {
        let counter = 0;
        return () => `synctex-forward-${Date.now().toString(36)}-${counter++}`;
    })();
    const isEnvMissingMessage = (message) => {
        const lower = message.toLowerCase();
        const hasMissing = message.includes("not found") || lower.includes("not found");
        return hasMissing && lower.includes("synctex");
    };
    const firstBuildCompletedKey = "tex64.onboarding.firstBuildCompleted.v1";
    const resolveRuntimeMissingLabel = (key) => {
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
        synctexButton.textContent = uiText("Jump", "ジャンプ");
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
    const requestSynctexForward = (overridePath, options = {}) => {
        var _a, _b, _c, _d, _e, _f;
        const activeGroup = deps.getActiveGroup();
        const targetPath = overridePath !== null && overridePath !== void 0 ? overridePath : activeGroup.currentFilePath;
        if (!targetPath || !targetPath.endsWith(".tex")) {
            const message = uiText("SyncTeX is only available for .tex files.", "SyncTeX は .tex ファイルでのみ利用できます。");
            deps.updateIssues(1, message, "info", [
                { severity: "warning", message },
            ]);
            return;
        }
        const editor = activeGroup.editor;
        const position = activeGroup.currentFilePath === targetPath ? (_a = editor === null || editor === void 0 ? void 0 : editor.getPosition) === null || _a === void 0 ? void 0 : _a.call(editor) : null;
        const storedPosition = deps.getStoredCursorPosition(targetPath);
        const line = (_c = (_b = position === null || position === void 0 ? void 0 : position.lineNumber) !== null && _b !== void 0 ? _b : storedPosition === null || storedPosition === void 0 ? void 0 : storedPosition.line) !== null && _c !== void 0 ? _c : 1;
        const column = (_e = (_d = position === null || position === void 0 ? void 0 : position.column) !== null && _d !== void 0 ? _d : storedPosition === null || storedPosition === void 0 ? void 0 : storedPosition.column) !== null && _e !== void 0 ? _e : 1;
        const source = (_f = options.source) !== null && _f !== void 0 ? _f : "manual";
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
    const setBuildState = (state, message) => {
        var _a, _b;
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
            }
            catch {
                // ignore storage failures
            }
            if (deps.settings.getAutoSynctexOnBuildEnabled()) {
                // Target the .tex the user is actively editing (incl. an \input-ed
                // sub-file) so SyncTeX jumps to the live cursor; fall back to the built
                // main file when the active tab isn't a .tex (e.g. the PDF or a .bib).
                const activePath = deps.getActiveFilePath();
                const targetPath = activePath && activePath.endsWith(".tex")
                    ? activePath
                    : (_b = (_a = deps.getLastBuildMainFile()) !== null && _a !== void 0 ? _a : deps.getRootFilePath()) !== null && _b !== void 0 ? _b : null;
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
        }
        else if (!runtimeSummary.runtimeReady) {
            const missing = runtimeSummary.missingRequired.map((item) => resolveRuntimeMissingLabel(item));
            const summaryText = missing.length > 0
                ? uiText(`Missing runtime environment: ${missing.join(", ")}`, `Runtime Environmentが不足しています: ${missing.join(", ")}`)
                : uiText("Runtime environment is missing.", "Execution environment is insufficient.");
            const issues = runtimeSummary.missingRequired.length > 0
                ? runtimeSummary.missingRequired.map((item) => ({
                    severity: "error",
                    message: uiText(`${resolveRuntimeMissingLabel(item)} is not detected. Check Settings > Runtime Environment.`, `${resolveRuntimeMissingLabel(item)} is not detected. Please check Settings > Execution environment.`),
                    action: "open-runtime",
                }))
                : [
                    {
                        severity: "error",
                        message: uiText("Runtime environment is missing. Check Settings > Runtime Environment.", "Execution environment is insufficient. Please check Settings > Execution environment."),
                        action: "open-runtime",
                    },
                ];
            deps.updateIssues(issues.length, summaryText, "error", issues);
            deps.setPendingBuildIssuesFocus(true);
            return;
        }
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
            deps.updateIssues(0, uiText("Starting build.", "Start the build."), "info", []);
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
    const handleSaveFormatError = (formatError) => {
        if (formatError && !formatWarningShown) {
            formatWarningShown = true;
            deps.updateIssues(1, formatError, "info", [
                { severity: "warning", message: formatError },
            ]);
        }
    };
    const handleFormatResult = (payload) => {
        var _a, _b, _c, _d;
        const inFlightSnapshot = formatInFlightSnapshot;
        formatInFlight = false;
        formatInFlightSnapshot = null;
        if (!payload.ok) {
            if (!formatWarningShown) {
                formatWarningShown = true;
                const message = (_a = payload.error) !== null && _a !== void 0 ? _a : uiText("Formatting failed.", "整形に失敗しました。");
                deps.updateIssues(1, message, "info", [
                    { severity: "warning", message },
                ]);
            }
        }
        else if (typeof payload.content === "string") {
            const groupsWithFile = deps
                .getEditorGroups()
                .filter((group) => group.currentFilePath === payload.path);
            const currentValue = groupsWithFile.length > 0
                ? (_c = (_b = groupsWithFile[0].editor) === null || _b === void 0 ? void 0 : _b.getValue) === null || _c === void 0 ? void 0 : _c.call(_b)
                : null;
            const isStale = (inFlightSnapshot === null || inFlightSnapshot === void 0 ? void 0 : inFlightSnapshot.path) === payload.path &&
                typeof currentValue === "string" &&
                currentValue !== inFlightSnapshot.content;
            if (!isStale) {
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
        }
        if (formatPending) {
            formatPending = false;
            requestFormatCurrentFile((_d = payload.source) !== null && _d !== void 0 ? _d : "auto");
        }
    };
    const handleSynctexForwardResult = (payload) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        if (!payload) {
            return;
        }
        const payloadRequestId = typeof payload.requestId === "string" && payload.requestId.trim()
            ? payload.requestId
            : null;
        const matchedInFlight = Boolean(payloadRequestId &&
            synctexForwardInFlight &&
            synctexForwardInFlight.requestId === payloadRequestId);
        if (matchedInFlight) {
            synctexForwardInFlight = null;
        }
        const payloadMeta = payloadRequestId
            ? (_a = synctexForwardOrderByRequestId.get(payloadRequestId)) !== null && _a !== void 0 ? _a : null
            : null;
        const payloadOrder = (_b = payloadMeta === null || payloadMeta === void 0 ? void 0 : payloadMeta.order) !== null && _b !== void 0 ? _b : null;
        if (payload.cancelled === true) {
            if (matchedInFlight) {
                flushQueuedSynctexForward();
            }
            return;
        }
        if ((payloadMeta === null || payloadMeta === void 0 ? void 0 : payloadMeta.source) === "auto-build" && Date.now() < synctexManualPriorityUntil) {
            if (matchedInFlight) {
                flushQueuedSynctexForward();
            }
            return;
        }
        if (Number.isFinite(payloadOrder) &&
            payloadOrder !== null &&
            payloadOrder < synctexForwardLastAppliedOrder) {
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
                const pdfPath = (_c = payload.pdfPath) !== null && _c !== void 0 ? _c : null;
                const openedGroup = (_e = (_d = resolvePdfSyncGroup(pdfPath)) !== null && _d !== void 0 ? _d : deps.getEditorGroups().find((group) => group.key === "secondary")) !== null && _e !== void 0 ? _e : deps.getActiveGroup();
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
                const syncPayload = {
                    page: payload.page,
                    x: (_f = payload.x) !== null && _f !== void 0 ? _f : 0,
                    y: (_g = payload.y) !== null && _g !== void 0 ? _g : 0,
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
        if ((payloadMeta === null || payloadMeta === void 0 ? void 0 : payloadMeta.source) === "auto-build") {
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
        const errorMessage = (_h = payload.error) !== null && _h !== void 0 ? _h : uiText("SyncTeX failed.", "SyncTeX に失敗しました。");
        const issue = { severity: "error", message: errorMessage };
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
