import { isTexFilePath } from "./files.js";
import { uiText } from "./i18n.js";
import { countMarkedLines, renderBuildLog, segmentBuildLog } from "./build-log-view.js";
import { hideEditorNotice, showEditorNotice } from "./editor-notice.js";
import { collabSession } from "./collab/session.js";
import { explainedHeading } from "./explain.js";
import { autoJumpAfterBuild, jumpButtonEnabled, needsBuildAction, recheckAllowed, recheckText } from "./jump-build-rules.js";
export const resolveBuildProgressPhase = (message, cancelRequested = false) => {
    if (cancelRequested || /cancel/i.test(message !== null && message !== void 0 ? message : ""))
        return "cancelling";
    if (/install/i.test(message !== null && message !== void 0 ? message : ""))
        return "installing";
    return "building";
};
export const resolveSynctexForwardTarget = (overridePath, activePath, lastBuildMainFile, rootPath) => {
    var _a;
    const candidates = [overridePath, activePath, lastBuildMainFile, rootPath];
    return (_a = candidates.find((path) => path === null || path === void 0 ? void 0 : path.toLowerCase().endsWith(".tex"))) !== null && _a !== void 0 ? _a : null;
};
export const resolveSynctexForwardPdfPath = (lastBuildMainFile, rootPath) => {
    const texPath = resolveSynctexForwardTarget(null, null, lastBuildMainFile, rootPath);
    return texPath ? texPath.replace(/\.tex$/i, ".pdf") : null;
};
export const initBuildOpsUi = (context, deps) => {
    const { buildButton, formatButton, synctexButton, issuesLog, issuesLogContent, } = context.dom;
    let formatInFlight = null;
    const formatQueue = new Map();
    let formatWarningShown = false;
    let currentBuildLog = null;
    let currentBuildState = "idle";
    let preparingBuild = false;
    let preparationGeneration = 0;
    // The Build running now: the tab that started it, and the TeX file it was
    // started from (the same file, or the one a non-TeX tab builds).
    let buildSource = null;
    let buildProgressPhase = "building";
    let buildStartedAt = 0;
    let buildCancelRequested = false;
    let buildProgressTimer = null;
    let synctexForwardRequestOrder = 0;
    // A Jump was asked for while the Build running now was running.
    let manualJumpDuringBuild = false;
    // The text that Jump's line was a line of (for its re-check, below).
    let buildJumpText = null;
    // The automatic Jump followed the last Build: a re-check would be a second move.
    let autoJumpedAfterBuild = false;
    // Re-checks waiting for main: request id -> the viewer's reply.
    const recheckReplies = new Map();
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
    // The Jump button turns while its own request resolves, so a click that
    // takes a moment does not read as a dead button.
    let synctexBusyRequestId = null;
    let synctexBusyTimer = null;
    const setSynctexBusy = (requestId) => {
        synctexBusyRequestId = requestId;
        if (synctexBusyTimer !== null)
            window.clearTimeout(synctexBusyTimer);
        synctexBusyTimer = requestId
            ? window.setTimeout(() => setSynctexBusy(null), synctexForwardInFlightTimeoutMs)
            : null;
        if (synctexButton instanceof HTMLElement) {
            synctexButton.classList.toggle("is-busy", Boolean(requestId));
            synctexButton.setAttribute("aria-busy", requestId ? "true" : "false");
        }
    };
    const synctexErrorNotice = (error) => {
        if (/PDF not found|PDF has not been generated/i.test(error)) {
            return {
                message: uiText("No PDF yet. Build first.", "PDFがまだありません。先にビルドしてください。"),
                build: true,
            };
        }
        if (/SyncTeX data was not found/i.test(error)) {
            return {
                message: uiText("This PDF has no position data (SyncTeX). Build it again.", "このPDFには位置情報（SyncTeX）がありません。ビルドし直してください。"),
                build: true,
            };
        }
        if (/not part of this PDF/i.test(error)) {
            return { message: uiText("This file is not part of the PDF.", "このファイルはPDFに含まれていません。") };
        }
        if (/does not appear in the PDF|position was not found/i.test(error)) {
            return { message: uiText("This line does not appear in the PDF.", "この行はPDFに出力されていません。") };
        }
        if (/only (supports|available for) .*TeX files|No TeX file selected/i.test(error)) {
            return { message: uiText("Jump works from a .tex file.", "ジャンプは .texファイルから使えます。") };
        }
        return { message: `${uiText("Could not jump:", "ジャンプできませんでした：")} ${error}` };
    };
    const showSynctexNotice = (message, tone, build = false) => {
        showEditorNotice(synctexButton instanceof HTMLElement ? synctexButton : null, message, {
            tone,
            owner: "jump",
            ...(build ? { action: { label: uiText("Build", "ビルド"), run: () => void startBuild() } } : {}),
        });
    };
    const canBuildFromAnotherTab = () => {
        var _a;
        const activeFile = deps.getActiveFilePath();
        return !preparingBuild && currentBuildState === "building" &&
            buildSource !== null && buildSource.workspace === ((_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps)) &&
            Boolean(activeFile && /\.tex$/i.test(activeFile) && activeFile !== buildSource.path && activeFile !== buildSource.file);
    };
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
    const renderBuildButton = () => {
        if (!(buildButton instanceof HTMLButtonElement))
            return;
        const busy = preparingBuild || (currentBuildState === "building" && !canBuildFromAnotherTab());
        const text = busy ? buildProgressText() : uiText("Build", "ビルド");
        buildButton.disabled = false;
        buildButton.classList.toggle("is-busy", busy);
        buildButton.setAttribute("aria-busy", String(busy));
        buildButton.setAttribute("aria-label", busy ? uiText("Cancel build", "ビルドをキャンセル") : text);
        if (busy)
            buildButton.dataset.progressPhase = buildProgressPhase;
        else
            delete buildButton.dataset.progressPhase;
        const label = buildButton.querySelector(".build-button-label");
        if (label)
            label.textContent = text;
        buildButton.title = text;
    };
    const stopBuildProgressTimer = () => {
        if (buildProgressTimer !== null)
            window.clearInterval(buildProgressTimer);
        buildProgressTimer = null;
    };
    const startBuildProgressTimer = () => {
        if (buildProgressTimer !== null)
            return;
        buildProgressTimer = window.setInterval(renderBuildButton, 250);
    };
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
    const resolvePdfSyncGroup = () => {
        var _a;
        const active = deps.getActiveGroup();
        if (active.viewer.getViewerMode() === "pdf")
            return active;
        return (_a = deps.getEditorGroups().find((group) => group.key !== active.key)) !== null && _a !== void 0 ? _a : active;
    };
    const handleBuildPreviewState = (payload) => {
        if (payload.state === "building")
            buildHasPreviousPdf = payload.previousPdf === true && Boolean(payload.pdfPath);
    };
    // The Live paper is on screen in a viewer (not a static PDF held under it).
    const livePaperShown = () => deps.getEditorGroups().some((group) => { var _a, _b; return group.viewer.getViewerMode() === "pdf" && ((_b = (_a = group.viewer).livePaperShown) === null || _b === void 0 ? void 0 : _b.call(_a)) === true; });
    // The Build running now had a PDF before it (jump-build-rules.ts).
    let buildHasPreviousPdf = false;
    const updateSynctexButtonState = () => {
        renderBuildButton();
        if (!(synctexButton instanceof HTMLButtonElement)) {
            return;
        }
        const targetPath = resolveSynctexForwardTarget(null, deps.getActiveFilePath(), deps.getLastBuildMainFile(), deps.getRootFilePath());
        const enabled = jumpButtonEnabled({
            hasTarget: Boolean(targetPath),
            preparingBuild,
            building: currentBuildState === "building",
            previousPdf: buildHasPreviousPdf,
            livePaper: livePaperShown(),
        });
        synctexButton.disabled = !enabled;
        synctexButton.style.display = "inline-flex";
    };
    // The <details> outlives every build, so the toggle handler is bound once and
    // reads whichever line the latest log marked first. Scroll the transcript box
    // itself rather than scrollIntoView, which would drag the whole panel along.
    let markedTarget = null;
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
        issuesLogContent.scrollTop = Math.max(0, markedTarget.offsetTop - issuesLogContent.clientHeight / 2);
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
    const handleBuildLog = (log) => {
        currentBuildLog = log;
        let firstMarked = null;
        let markedCount = 0;
        if (issuesLogContent instanceof HTMLElement) {
            if (log) {
                firstMarked = renderBuildLog(issuesLogContent, log);
                markedCount = countMarkedLines(segmentBuildLog(log));
            }
            else {
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
                        ? uiText(`Detailed log (${markedCount} marked)`, `詳細ログ（該当${markedCount}件）`)
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
    const requestSynctexForward = (overridePath, options = {}) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
        const activeGroup = deps.getActiveGroup();
        const activePath = deps.getActiveFilePath();
        const lastBuildMainFile = deps.getLastBuildMainFile();
        const rootPath = deps.getRootFilePath();
        const targetPath = resolveSynctexForwardTarget(overridePath, activePath, lastBuildMainFile, rootPath);
        if (!targetPath) {
            if (((_a = options.source) !== null && _a !== void 0 ? _a : "manual") === "manual") {
                showSynctexNotice(uiText("Jump works from a .tex file.", "ジャンプは .texファイルから使えます。"), "info");
            }
            return;
        }
        const sourceGroup = [activeGroup, ...deps.getEditorGroups()].find((group) => group.currentFilePath === targetPath);
        const editor = sourceGroup === null || sourceGroup === void 0 ? void 0 : sourceGroup.editor;
        const position = (_c = (_b = editor === null || editor === void 0 ? void 0 : editor.getPosition) === null || _b === void 0 ? void 0 : _b.call(editor)) !== null && _c !== void 0 ? _c : null;
        // The caret's line is a line of this text; main carries it into the
        // numbering of whatever answers (the last Build read an older text).
        const editorText = position ? (_d = editor === null || editor === void 0 ? void 0 : editor.getValue) === null || _d === void 0 ? void 0 : _d.call(editor) : undefined;
        const storedPosition = deps.getStoredCursorPosition(targetPath);
        const line = (_f = (_e = position === null || position === void 0 ? void 0 : position.lineNumber) !== null && _e !== void 0 ? _e : storedPosition === null || storedPosition === void 0 ? void 0 : storedPosition.line) !== null && _f !== void 0 ? _f : 1;
        const column = (_h = (_g = position === null || position === void 0 ? void 0 : position.column) !== null && _g !== void 0 ? _g : storedPosition === null || storedPosition === void 0 ? void 0 : storedPosition.column) !== null && _h !== void 0 ? _h : 1;
        const source = (_j = options.source) !== null && _j !== void 0 ? _j : "manual";
        if (source === "manual") {
            synctexManualPriorityUntil = Date.now() + 5000;
            // This Build's own Jump will not be followed by another when it ends,
            // and is asked about again on the PDF that Build makes (re-check).
            if (currentBuildState === "building") {
                manualJumpDuringBuild = true;
                buildJumpText = typeof editorText === "string" ? { path: targetPath, line, text: editorText } : null;
            }
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
                if (synctexForwardInFlight.key === requestKey &&
                    !(source === "manual" && synctexForwardInFlight.source !== "manual")) {
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
            afterBuild: options.afterBuild === true,
        });
        synctexForwardInFlight = {
            requestId,
            key: requestKey,
            source,
            startedAt: Date.now(),
        };
        if (source === "manual")
            setSynctexBusy(requestId);
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
            documentMainFile: (_l = (_k = (source === "auto-build" ? lastBuildMainFile : null)) !== null && _k !== void 0 ? _k : chosenTarget(targetPath)) !== null && _l !== void 0 ? _l : undefined,
            line,
            column,
            ...(typeof editorText === "string" ? { text: editorText } : {}),
            // Live's page numbers only for the Live paper (a held static PDF has its own)
            livePaper: livePaperShown(),
            fallbackToTop: options.fallbackToTop === true,
            pdfViewerMode: deps.settings.getPdfViewerMode(),
        });
    };
    const setBuildState = (state, message) => {
        var _a, _b, _c, _d;
        const wasBusy = currentBuildState === "building";
        if (state === "building" && !wasBusy) {
            manualJumpDuringBuild = false;
            autoJumpedAfterBuild = false;
            buildJumpText = null;
        }
        const jumpedDuringBuild = manualJumpDuringBuild;
        if (state !== "building") {
            manualJumpDuringBuild = false;
            buildHasPreviousPdf = false;
        }
        currentBuildState = state;
        // (a Jump that started this Build jumps on its PDF: the automatic one stays out)
        const jumpFollowsBuild = state === "success" && (pendingJumpAfterBuild === null || pendingJumpAfterBuild === void 0 ? void 0 : pendingJumpAfterBuild.started) === true;
        if (state === "building" && pendingJumpAfterBuild)
            pendingJumpAfterBuild.started = true;
        else if (state === "success" || state === "failed" || state === "idle")
            resumeJumpAfterBuild(state);
        if (state === "success" || state === "failed" || state === "idle") {
            const check = pickCheck;
            pickCheck = null;
            const built = deps.getLastBuildMainFile();
            if (check && state === "success" && built && check.workspace === ((_b = (_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps)) !== null && _b !== void 0 ? _b : null)) {
                const key = chosenKey(check.file);
                const pick = chosenTargets.get(key);
                if (pick && pick !== built)
                    chosenTargets.delete(key);
            }
        }
        const isBusy = state === "building";
        if (isBusy) {
            if (!wasBusy) {
                buildStartedAt = Date.now();
                buildCancelRequested = false;
            }
            buildProgressPhase = resolveBuildProgressPhase(message, buildCancelRequested);
            startBuildProgressTimer();
        }
        else {
            stopBuildProgressTimer();
            buildStartedAt = 0;
            buildCancelRequested = false;
            buildProgressPhase = "building";
        }
        updateSynctexButtonState();
        if (state === "success") {
            try {
                localStorage.setItem(firstBuildCompletedKey, "1");
            }
            catch {
                // ignore storage failures
            }
            if (autoJumpAfterBuild({ enabled: deps.settings.getAutoSynctexOnBuildEnabled(), jumpedDuringBuild, jumpFollowsBuild })) {
                // Target the .tex the user is actively editing (incl. an \input-ed
                // sub-file) so SyncTeX jumps to the live cursor; fall back to the built
                // main file when the active tab isn't a .tex (e.g. the PDF or a .bib).
                const activePath = deps.getActiveFilePath();
                const targetPath = isTexFilePath(activePath)
                    ? activePath
                    : (_d = (_c = deps.getLastBuildMainFile()) !== null && _c !== void 0 ? _c : deps.getRootFilePath()) !== null && _d !== void 0 ? _d : null;
                if (isTexFilePath(targetPath)) {
                    autoJumpedAfterBuild = true;
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
                renderBuildButton();
                deps.updateIssues(0, uiText("Canceling build…", "ビルドをキャンセル中…"), "info", []);
            }
        }
    };
    // Fragment → document chosen in the chooser, per workspace, for this session.
    const chosenTargets = new Map();
    const chosenKey = (file) => { var _a, _b; return `${(_b = (_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps)) !== null && _b !== void 0 ? _b : ""}\0${file}`; };
    // A pick stands while its document is in the workspace (a renamed or
    // deleted document drops it, for Build, Jump and the other readers).
    const chosenTarget = (file) => {
        const key = chosenKey(file);
        const target = chosenTargets.get(key);
        if (!target)
            return undefined;
        const files = deps.getWorkspaceFiles();
        if (files.length > 0 && !files.includes(target)) {
            chosenTargets.delete(key);
            return undefined;
        }
        return target;
    };
    // A Build that main resolved from a file with a pick, without asking: when
    // it built another document (a % !TEX root line, Settings › Main TeX, the
    // only owner left), that rule now decides and the pick is dropped.
    let pickCheck = null;
    let chooserDialog = null;
    // A Jump whose document had no PDF yet: the Build it started, and the file
    // to jump from once that Build succeeds.
    let pendingJumpAfterBuild = null;
    const resumeJumpAfterBuild = (state) => {
        var _a;
        const pending = pendingJumpAfterBuild;
        if (!pending)
            return;
        // setBuildState("idle") also runs while startBuild saves files first.
        if (!pending.started) {
            if (state === "failed")
                pendingJumpAfterBuild = null;
            return;
        }
        pendingJumpAfterBuild = null;
        if (state !== "success" || ((_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps)) !== pending.workspaceKey)
            return;
        const built = deps.getLastBuildMainFile();
        // (no target: the Build resolved the document itself)
        if (built && pending.target && built !== pending.target)
            return;
        window.setTimeout(() => requestSynctexForward(pending.path, { fallbackToTop: true, source: "manual", afterBuild: true }), 0);
    };
    // Main could not decide which document to build (a fragment included by two
    // documents, or several documents and no root): one dialog, one answer. The
    // answer is reused for that file while the question stays the same (its
    // document is still one of the candidates); otherwise it is asked again.
    const chooseBuildTarget = (payload) => {
        const requested = typeof (payload === null || payload === void 0 ? void 0 : payload.requested) === "string" ? payload.requested : null;
        const remembered = requested ? chosenTarget(requested) : undefined;
        if (remembered && Array.isArray(payload.candidates) && payload.candidates.includes(remembered)) {
            void startBuild(remembered);
            return;
        }
        if (requested && remembered)
            chosenTargets.delete(chosenKey(requested));
        openTargetChooser({ ...payload, onPick: (path) => void startBuild(path) });
    };
    const openTargetChooser = (payload) => {
        var _a, _b;
        const candidates = Array.isArray(payload === null || payload === void 0 ? void 0 : payload.candidates) ? payload.candidates.filter((c) => typeof c === "string" && c) : [];
        if (candidates.length === 0)
            return;
        const requested = typeof payload.requested === "string" ? payload.requested : null;
        const workspaceKey = (_b = (_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps)) !== null && _b !== void 0 ? _b : null;
        chooserDialog === null || chooserDialog === void 0 ? void 0 : chooserDialog.close();
        const el = (tag, className = "", text = "") => {
            const node = document.createElement(tag);
            node.className = className;
            node.textContent = text;
            return node;
        };
        const dialog = el("dialog", "history-confirm build-target-dialog");
        const title = el("h2", "", uiText("Build target", "ビルド対象"));
        const note = el("p", "build-target-note", requested
            ? uiText(`${requested} belongs to more than one document.`, `${requested}は複数の文書から読み込まれています。`)
            : uiText("No main file is set.", "メインTeXが決まっていません。"));
        const list = el("div", "build-target-list");
        list.setAttribute("role", "listbox");
        const pick = (path) => {
            var _a;
            dialog.close();
            if (((_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps)) !== workspaceKey)
                return;
            if (requested)
                chosenTargets.set(`${workspaceKey !== null && workspaceKey !== void 0 ? workspaceKey : ""}\0${requested}`, path);
            payload.onPick(path);
        };
        candidates.forEach((path, index) => {
            const row = el("button", "history-button build-target-row", path);
            row.type = "button";
            row.setAttribute("role", "option");
            if (index === 0)
                row.autofocus = true;
            row.addEventListener("click", () => pick(path));
            list.append(row);
        });
        const titleRow = explainedHeading(title, requested
            ? uiText("Remembered for this file until the app closes. A % !TEX root line in the file settles it for good.", "この起動中はこのファイルについて記憶します。ファイル先頭の% !TEX root行で固定できます。")
            : uiText("Settings › Main TeX fixes the choice for this folder.", "設定の「メインTeX」でこのフォルダの既定にできます。"));
        const actions = el("div", "history-confirm-actions");
        const cancel = el("button", "history-button", uiText("Cancel", "キャンセル"));
        cancel.type = "button";
        cancel.addEventListener("click", () => dialog.close());
        actions.append(cancel);
        dialog.append(...titleRow, note, list, actions);
        dialog.addEventListener("close", () => {
            dialog.remove();
            if (chooserDialog === dialog)
                chooserDialog = null;
        });
        document.body.append(dialog);
        chooserDialog = dialog;
        dialog.showModal();
    };
    // A guest who just joined may still be receiving the host's figures: the
    // build waits for them and starts when they are in. "Build now" (or Build
    // pressed again) does not wait.
    let awaitingFiles = null;
    let buildWithoutWaiting = false;
    const stopAwaitingFiles = () => {
        awaitingFiles === null || awaitingFiles === void 0 ? void 0 : awaitingFiles();
        awaitingFiles = null;
        hideEditorNotice("build-files");
    };
    const incomingFiles = (state) => (state.active && state.role === "guest" && state.incoming && state.incoming.files > 0 ? state.incoming : null);
    const awaitFiles = (explicitTarget, incoming) => {
        const megabytes = incoming.bytes >= 1048576 ? `${(incoming.bytes / 1048576).toFixed(incoming.bytes >= 10 * 1048576 ? 0 : 1)} MB` : `${Math.max(1, Math.round(incoming.bytes / 1024))} KB`;
        const unsubscribe = collabSession.onChange((state) => {
            if (incomingFiles(state))
                return;
            stopAwaitingFiles();
            if (state.active)
                void startBuild(explicitTarget);
        });
        awaitingFiles = () => unsubscribe();
        showEditorNotice(buildButton instanceof HTMLElement ? buildButton : null, uiText(`Waiting for ${incoming.files} file(s) from the host (${megabytes}); the build starts when they arrive.`, `ホストからのファイルを待っています（残り${incoming.files}件・${megabytes}）。届きしだいビルドします。`), {
            owner: "build-files",
            durationMs: 10000,
            action: { label: uiText("Build now", "今すぐビルド"), run: () => { stopAwaitingFiles(); buildWithoutWaiting = true; void startBuild(explicitTarget); } },
        });
    };
    const startBuild = async (explicitTarget) => {
        var _a, _b, _c, _d, _e, _f, _g;
        if (preparingBuild || (currentBuildState === "building" && !canBuildFromAnotherTab()))
            return;
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
        }
        else if (runtimeSummary.requiredChecksComplete && !runtimeSummary.runtimeReady) {
            const missing = runtimeSummary.missingRequired.map((item) => resolveRuntimeMissingLabel(item));
            const summaryText = missing.length > 0
                ? uiText(`Missing runtime environment: ${missing.join(", ")}`, `Runtime Environmentが不足しています: ${missing.join(", ")}`)
                : uiText("Runtime environment is missing.", "Execution environment is insufficient.");
            const issues = runtimeSummary.missingRequired.length > 0
                ? runtimeSummary.missingRequired.map((item) => ({
                    severity: "error",
                    message: uiText(`${resolveRuntimeMissingLabel(item)} is not detected. Check Settings > Build.`, `${resolveRuntimeMissingLabel(item)} is not detected. Please check Settings > Build.`),
                    action: "open-runtime",
                }))
                : [
                    {
                        severity: "error",
                        message: uiText("Runtime environment is missing. Check Settings > Build.", "Execution environment is insufficient. Please check Settings > Build."),
                        action: "open-runtime",
                    },
                ];
            deps.updateIssues(issues.length, summaryText, "error", issues);
            deps.setPendingBuildIssuesFocus(true);
            return;
        }
        deps.cacheCurrentBuffer(deps.getActiveGroup());
        const buildWorkspace = (_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps);
        // (another source's Build is still running)
        const concurrent = currentBuildState === "building";
        // Both are taken before the saves (the user may switch tabs meanwhile):
        // the initiating tab, for the button's busy state, and the TeX file main
        // resolves the document from (magic root, the including document, the
        // workspace root). A non-TeX tab (.bib, .sty, an image, the PDF) builds,
        // as in v0.1.32, the other pane's TeX file, else the last document built,
        // else the workspace root.
        const initiatingFile = deps.getActiveFilePath();
        const isTex = (file) => Boolean(file && /\.tex$/i.test(file));
        const workspaceFiles = deps.getWorkspaceFiles();
        const present = (file) => isTex(file) && (workspaceFiles.length === 0 || workspaceFiles.includes(file)) ? file : undefined;
        const mainFile = (_f = (_e = (_d = (_b = (isTex(initiatingFile) ? initiatingFile : undefined)) !== null && _b !== void 0 ? _b : (_c = deps.getEditorGroups().find((group) => isTex(group.currentFilePath))) === null || _c === void 0 ? void 0 : _c.currentFilePath) !== null && _d !== void 0 ? _d : present(deps.getLastBuildMainFile())) !== null && _e !== void 0 ? _e : present(deps.getRootFilePath())) !== null && _f !== void 0 ? _f : undefined;
        if (deps.saveDirtyFiles) {
            const generation = ++preparationGeneration;
            preparingBuild = true;
            setBuildState("building");
            let saved = false;
            try {
                saved = await deps.saveDirtyFiles();
            }
            catch { /* save path reports the error */ }
            if (generation !== preparationGeneration)
                return;
            preparingBuild = false;
            if (!saved) {
                setBuildState("failed");
                return;
            }
            if (buildWorkspace !== ((_g = deps.getWorkspaceRootKey) === null || _g === void 0 ? void 0 : _g.call(deps))) {
                setBuildState("idle");
                return;
            }
        }
        const engine = localStorage.getItem("tex64.compileEngine") || "lualatex";
        const payload = { type: "build" };
        if (explicitTarget) {
            payload.targetFile = explicitTarget;
        }
        else if (mainFile) {
            payload.mainFile = mainFile;
        }
        if (engine) {
            payload.engine = engine;
        }
        payload.pdfViewerMode = deps.settings.getPdfViewerMode();
        payload.formatSettings = deps.settings.buildFormatSettingsPayload();
        if (deps.postToNative(payload)) {
            buildSource = { path: initiatingFile, file: explicitTarget ? initiatingFile : mainFile !== null && mainFile !== void 0 ? mainFile : null, workspace: buildWorkspace };
            pickCheck = !explicitTarget && !concurrent && mainFile && chosenTarget(mainFile)
                ? { workspace: buildWorkspace !== null && buildWorkspace !== void 0 ? buildWorkspace : null, file: mainFile }
                : null;
            setBuildState("building");
            handleBuildLog(null);
            deps.updateIssues(0, uiText("Starting build.", "Start the build."), "info", []);
        }
        else {
            const message = uiText("The build request could not be started.", "ビルドを開始できませんでした。");
            setBuildState("failed", message);
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
        }
    };
    const dispatchNextFormat = () => {
        var _a;
        if (formatInFlight)
            return;
        for (const [path, request] of formatQueue) {
            formatQueue.delete(path);
            if (request.root !== ((_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps)) || !request.target.isCurrent())
                continue;
            formatInFlight = request;
            if (deps.postToNative({
                type: "formatFile", path, content: request.target.content, source: request.source,
                formatSettings: request.settings, requestId: request.id, expectedWorkspaceRoot: request.root,
            }))
                return;
            formatInFlight = null;
            handleSaveFormatError(uiText("Failed to request formatting.", "整形を開始できませんでした。"));
        }
    };
    const requestFormatCurrentFile = (source) => {
        var _a;
        const target = deps.captureFormatTarget();
        if (!target)
            return;
        formatQueue.set(target.path, {
            id: crypto.randomUUID(), root: (_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps), target, source,
            settings: deps.settings.buildFormatSettingsPayload(),
        });
        dispatchNextFormat();
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
        var _a, _b;
        const request = formatInFlight;
        if (!request || request.id !== payload.requestId || request.target.path !== payload.path)
            return;
        formatInFlight = null;
        if (!payload.stale && request.root === ((_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps)) && request.target.isCurrent()) {
            if (!payload.ok) {
                handleSaveFormatError((_b = payload.error) !== null && _b !== void 0 ? _b : uiText("Formatting failed.", "整形できませんでした。"));
            }
            else if (typeof payload.content === "string") {
                void request.target.apply(payload.content).catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
                });
            }
        }
        dispatchNextFormat();
    };
    // The viewer's re-check (viewer.ts "jump-recheck"): the PDF a Build made is
    // on screen and a Jump was made while that Build ran. Its line on that PDF,
    // from main (source "recheck": that PDF only, never a Build, never Live),
    // goes back to that viewer, which moves only if the line is out of view.
    // It is not a Jump of the reader's: no notice, no priority over another
    // Jump, and none after the automatic one.
    window.addEventListener("tex64:jump-recheck", (event) => {
        var _a, _b;
        const detail = event.detail;
        if (!detail || typeof detail.reply !== "function")
            return;
        if (!recheckAllowed({ preparingBuild, building: currentBuildState === "building", autoJumped: autoJumpedAfterBuild }))
            return;
        const shown = deps.getEditorGroups().find((group) => group.currentFilePath === detail.file);
        const current = (_b = (_a = shown === null || shown === void 0 ? void 0 : shown.editor) === null || _a === void 0 ? void 0 : _a.getValue) === null || _b === void 0 ? void 0 : _b.call(_a);
        const text = recheckText({ jump: buildJumpText, file: detail.file, line: detail.line, current });
        const requestId = buildSynctexForwardRequestId();
        recheckReplies.set(requestId, detail.reply);
        while (recheckReplies.size > 8)
            recheckReplies.delete(recheckReplies.keys().next().value);
        deps.postToNative({
            type: "synctex:forward",
            requestId,
            source: "recheck",
            path: detail.file,
            line: detail.line,
            column: detail.column,
            pdfPath: detail.pdfPath,
            ...(typeof text === "string" ? { text } : {}),
            fallbackToTop: false,
            livePaper: false,
            pdfViewerMode: "tab",
        }, true);
    });
    const handleSynctexForwardResult = (payload) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
        if (!payload) {
            return;
        }
        const recheckReply = typeof payload.requestId === "string" ? recheckReplies.get(payload.requestId) : undefined;
        if (recheckReply) {
            recheckReplies.delete(payload.requestId);
            if (payload.ok !== true || payload.notTypeset === true || typeof payload.page !== "number")
                return;
            const place = { page: payload.page, x: (_a = payload.x) !== null && _a !== void 0 ? _a : 0, y: (_b = payload.y) !== null && _b !== void 0 ? _b : 0 };
            if (typeof payload.blockX === "number")
                place.blockX = payload.blockX;
            if (typeof payload.blockY === "number")
                place.blockY = payload.blockY;
            if (typeof payload.blockWidth === "number" && payload.blockWidth > 0)
                place.blockWidth = payload.blockWidth;
            if (typeof payload.blockHeight === "number" && payload.blockHeight > 0)
                place.blockHeight = payload.blockHeight;
            if (Array.isArray(payload.blocks) && payload.blocks.length > 1)
                place.blocks = payload.blocks.slice(0, 32);
            if (payload.approximate === true)
                place.approximate = true;
            if (payload.direction === "tate")
                place.direction = "tate";
            recheckReply(place);
            return;
        }
        const payloadRequestId = typeof payload.requestId === "string" && payload.requestId.trim()
            ? payload.requestId
            : null;
        if (payloadRequestId && payloadRequestId === synctexBusyRequestId) {
            setSynctexBusy(null);
        }
        const matchedInFlight = Boolean(payloadRequestId &&
            synctexForwardInFlight &&
            synctexForwardInFlight.requestId === payloadRequestId);
        if (matchedInFlight) {
            synctexForwardInFlight = null;
        }
        const payloadMeta = payloadRequestId
            ? (_c = synctexForwardOrderByRequestId.get(payloadRequestId)) !== null && _c !== void 0 ? _c : null
            : null;
        const payloadOrder = (_d = payloadMeta === null || payloadMeta === void 0 ? void 0 : payloadMeta.order) !== null && _d !== void 0 ? _d : null;
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
                const pdfPath = (_e = payload.pdfPath) !== null && _e !== void 0 ? _e : null;
                const openedGroup = resolvePdfSyncGroup();
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
                if (pdfPath) {
                    syncPayload.pdfPath = pdfPath;
                }
                if (payload.fallback === true)
                    syncPayload.approximate = true;
                if (payload.liveRevision)
                    syncPayload.liveRevision = payload.liveRevision;
                if (payload.direction === "tate")
                    syncPayload.direction = "tate";
                if (payload.notTypeset === true) {
                    // The first page stands in for a line that is not typeset.
                    syncPayload.marker = false;
                }
                else if (payloadMeta) {
                    // a line that only reads a file was answered for the start of that file
                    const redirectedPath = typeof payload.sourcePath === "string" && payload.sourcePath ? payload.sourcePath : null;
                    syncPayload.sourceFile = redirectedPath !== null && redirectedPath !== void 0 ? redirectedPath : payloadMeta.path;
                    syncPayload.sourceLine = redirectedPath && typeof payload.sourceLine === "number" ? payload.sourceLine : payloadMeta.line;
                    syncPayload.sourceColumn = redirectedPath ? 1 : payloadMeta.column;
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
            if (payload.notTypeset === true && (payloadMeta === null || payloadMeta === void 0 ? void 0 : payloadMeta.source) !== "auto-build") {
                showSynctexNotice(uiText("This line does not appear in the PDF, so the first page is shown.", "この行はPDFに出力されないため、先頭ページを表示しました。"), "info");
            }
            if (matchedInFlight) {
                flushQueuedSynctexForward();
            }
            return;
        }
        const code = payload.code;
        if (code === "CHOOSE_TARGET" && (payloadMeta === null || payloadMeta === void 0 ? void 0 : payloadMeta.source) === "manual") {
            const choice = payload;
            openTargetChooser({
                requested: (_h = choice.requested) !== null && _h !== void 0 ? _h : payloadMeta.path,
                candidates: Array.isArray(choice.candidates) ? choice.candidates : [],
                onPick: () => requestSynctexForward(payloadMeta.path, { fallbackToTop: true, source: "manual" }),
            });
            if (matchedInFlight)
                flushQueuedSynctexForward();
            return;
        }
        if (code === "NEEDS_BUILD" && (payloadMeta === null || payloadMeta === void 0 ? void 0 : payloadMeta.source) === "manual") {
            // The document has no PDF yet: build it, then jump from the same file.
            const targetFile = String(payload.targetFile || "");
            const action = needsBuildAction({
                afterBuild: payloadMeta.afterBuild,
                building: currentBuildState === "building",
                targetFile,
            });
            if (action === "notice") {
                // That Build succeeded and still left no PDF with SyncTeX where Jump
                // reads it (SyncTeX turned off in the Build's own options, say):
                // another Build would only end here again, and again.
                showSynctexNotice(synctexErrorNotice("SyncTeX data was not found.").message, "error");
            }
            else if (action === "follow") {
                // A Build is running already (this file's document had no PDF yet):
                // the Jump follows it, from the PDF it makes.
                pendingJumpAfterBuild = {
                    path: payloadMeta.path,
                    target: targetFile || null,
                    workspaceKey: (_k = (_j = deps.getWorkspaceRootKey) === null || _j === void 0 ? void 0 : _j.call(deps)) !== null && _k !== void 0 ? _k : null,
                    started: true,
                };
            }
            else if (action === "build") {
                pendingJumpAfterBuild = {
                    path: payloadMeta.path,
                    target: targetFile || null,
                    workspaceKey: (_m = (_l = deps.getWorkspaceRootKey) === null || _l === void 0 ? void 0 : _l.call(deps)) !== null && _m !== void 0 ? _m : null,
                    started: false,
                };
                void startBuild(targetFile || undefined);
            }
            if (matchedInFlight)
                flushQueuedSynctexForward();
            return;
        }
        if (code === "SYNCTEX_DISABLED" && (payloadMeta === null || payloadMeta === void 0 ? void 0 : payloadMeta.source) === "manual") {
            // The Build profile writes no SyncTeX: a Build cannot help, so the
            // notice comes without its Build action (and no Build starts).
            showSynctexNotice(synctexErrorNotice("SyncTeX data was not found.").message, "error");
            if (matchedInFlight)
                flushQueuedSynctexForward();
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
        const errorMessage = (_o = payload.error) !== null && _o !== void 0 ? _o : uiText("SyncTeX failed.", "SyncTeXで位置を特定できませんでした。");
        if (isEnvMissingMessage(errorMessage)) {
            // Missing TeX tools: the Issues entry carries the fix-it action.
            const issue = { severity: "error", message: errorMessage, action: "open-runtime" };
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
        // Mouse activation of an editor command leaves the text input focused.
        // Keyboard activation keeps the toolbar's normal tab and focus behavior.
        for (const button of [context.dom.saveButton, buildButton, formatButton, synctexButton]) {
            if (!(button instanceof HTMLButtonElement))
                continue;
            button.addEventListener("mousedown", (event) => {
                var _a;
                if (event.button !== 0)
                    return;
                const editor = deps.getActiveGroup().editor;
                if ((_a = editor === null || editor === void 0 ? void 0 : editor.hasTextFocus) === null || _a === void 0 ? void 0 : _a.call(editor))
                    event.preventDefault();
            });
        }
        if (buildButton instanceof HTMLButtonElement) {
            let lastStart = null;
            buildButton.addEventListener("click", (event) => {
                var _a;
                const file = deps.getActiveFilePath();
                const workspace = (_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps);
                if (lastStart && lastStart.file === file && lastStart.workspace === workspace &&
                    event.timeStamp - lastStart.at <= 500)
                    return;
                if (preparingBuild || (currentBuildState === "building" && !canBuildFromAnotherTab())) {
                    cancelBuild();
                    return;
                }
                void startBuild();
                if (preparingBuild || (currentBuildState === "building" && (buildSource === null || buildSource === void 0 ? void 0 : buildSource.path) === file && buildSource.workspace === workspace)) {
                    lastStart = { at: event.timeStamp, file, workspace };
                }
            });
            buildButton.addEventListener("contextmenu", (event) => {
                var _a, _b;
                event.preventDefault();
                if (preparingBuild || currentBuildState === "building")
                    return;
                const workspaceKey = (_b = (_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps)) !== null && _b !== void 0 ? _b : null;
                if (!workspaceKey)
                    return;
                const activePath = deps.getActiveFilePath();
                const texFiles = [...new Set(deps.getWorkspaceFiles().filter((path) => /\.tex$/i.test(path)))].sort((left, right) => {
                    if (left === activePath)
                        return -1;
                    if (right === activePath)
                        return 1;
                    return left.localeCompare(right);
                });
                if (texFiles.length === 0)
                    return;
                const items = texFiles.map((path) => ({
                    type: "action",
                    label: path,
                    action: () => {
                        var _a;
                        if (((_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps)) !== workspaceKey)
                            return;
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
        documentFor: (path) => chosenTarget(path),
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
