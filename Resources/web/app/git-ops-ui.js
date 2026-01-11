import { renderGitPanel as renderGitPanelUi } from "./git-panel-ui.js";
export const initGitOpsUi = (context, deps) => {
    const { gitRefreshButton, gitInitButton, gitCommitMessage, gitCommitButton, gitHistory, gitPullButton, gitPushButton, gitRemoteInput, } = context.dom;
    let gitEntries = [];
    let gitMessage = "履歴の状態はここに表示します。";
    let gitRepoState = { ok: false };
    let gitRemoteState = { exists: false };
    let gitBranchState = {};
    let gitHistoryEntries = [];
    let gitHistoryMessage = "履歴はここに表示します。";
    let gitGuideMessage = null;
    let gitPreviewContext = null;
    let gitBusy = false;
    let gitBusyMessage = null;
    let gitLastAction = null;
    const render = () => {
        renderGitPanelUi(context, {
            entries: gitEntries,
            message: gitMessage,
            historyEntries: gitHistoryEntries,
            historyMessage: gitHistoryMessage,
            repoState: gitRepoState,
            remoteState: gitRemoteState,
            branchState: gitBranchState,
            busy: gitBusy,
            busyMessage: gitBusyMessage,
            guideMessage: gitGuideMessage,
            workspaceRootKey: deps.getWorkspaceRootKey(),
        });
    };
    const reset = () => {
        gitEntries = [];
        gitMessage = "履歴の状態はここに表示します。";
        gitRepoState = { ok: false };
        gitRemoteState = { exists: false };
        gitBranchState = {};
        gitHistoryEntries = [];
        gitHistoryMessage = "履歴はここに表示します。";
        gitGuideMessage = null;
        gitPreviewContext = null;
        gitBusy = false;
        gitBusyMessage = null;
        gitLastAction = null;
        if (gitCommitMessage instanceof HTMLInputElement) {
            gitCommitMessage.value = "";
        }
        if (gitRemoteInput instanceof HTMLInputElement) {
            gitRemoteInput.value = "";
        }
        render();
    };
    const handleUpdate = (payload) => {
        var _a, _b, _c;
        gitEntries = Array.isArray(payload.entries) ? payload.entries : [];
        gitRepoState = (_a = payload.repo) !== null && _a !== void 0 ? _a : gitRepoState;
        gitRemoteState = (_b = payload.remote) !== null && _b !== void 0 ? _b : gitRemoteState;
        gitBranchState = (_c = payload.branch) !== null && _c !== void 0 ? _c : gitBranchState;
        gitHistoryEntries = Array.isArray(payload.history) ? payload.history : [];
        if (!gitRepoState.ok) {
            gitGuideMessage = null;
        }
        if (payload.message) {
            gitMessage = payload.message;
        }
        else if (!deps.getWorkspaceRootKey()) {
            gitMessage = "ワークスペースが未選択です。";
        }
        else if (gitRepoState.reason === "git-missing") {
            gitMessage = "履歴管理を利用できません。";
        }
        else if (!gitRepoState.ok) {
            gitMessage = "履歴管理がまだ有効ではありません。";
        }
        else if (gitEntries.length === 0) {
            gitMessage = "変更はありません。";
        }
        if (payload.historyMessage) {
            gitHistoryMessage = payload.historyMessage;
        }
        else if (!deps.getWorkspaceRootKey()) {
            gitHistoryMessage = "ワークスペースが未選択です。";
        }
        else if (gitRepoState.reason === "git-missing") {
            gitHistoryMessage = "履歴を取得できません。";
        }
        else if (!gitRepoState.ok) {
            gitHistoryMessage = "履歴管理がまだ有効ではありません。";
        }
        else if (gitHistoryEntries.length === 0) {
            gitHistoryMessage = "履歴はまだありません。";
        }
        const shouldClearCommitMessage = gitLastAction === "commit" && gitEntries.length === 0;
        gitBusy = false;
        gitBusyMessage = null;
        gitLastAction = null;
        if (shouldClearCommitMessage && gitCommitMessage instanceof HTMLInputElement) {
            gitCommitMessage.value = "";
        }
        render();
    };
    const handleDiff = (payload) => {
        var _a, _b, _c, _d, _e, _f, _g;
        gitBusy = false;
        gitBusyMessage = null;
        gitLastAction = null;
        render();
        if (!payload.ok) {
            const message = (_a = payload.message) !== null && _a !== void 0 ? _a : "差分を取得できませんでした。";
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
            gitPreviewContext = null;
            return;
        }
        const patch = (_b = payload.patch) !== null && _b !== void 0 ? _b : "";
        if (!patch.trim()) {
            const message = (_c = payload.message) !== null && _c !== void 0 ? _c : "変更はありません。";
            deps.updateIssues(0, message, "info", []);
            gitPreviewContext = null;
            return;
        }
        if (payload.mode === "commit") {
            gitPreviewContext = null;
            deps.diffModal.showPatchModal(patch, {
                title: "履歴に保存の確認",
                fileName: "保存予定の変更",
                submitLabel: "保存",
                context: { type: "gitCommit" },
            });
            return;
        }
        const context = (gitPreviewContext === null || gitPreviewContext === void 0 ? void 0 : gitPreviewContext.type) === "restore" ? gitPreviewContext : null;
        const shortHash = (_d = context === null || context === void 0 ? void 0 : context.shortHash) !== null && _d !== void 0 ? _d : ((_e = payload.hash) !== null && _e !== void 0 ? _e : "").slice(0, 7);
        const labelMessage = (context === null || context === void 0 ? void 0 : context.message) ? ` ${context.message}` : "";
        const fileName = shortHash ? `履歴: ${shortHash}${labelMessage}` : "履歴の変更";
        gitPreviewContext = null;
        deps.diffModal.showPatchModal(patch, {
            title: "履歴を戻す確認",
            fileName,
            submitLabel: "戻す",
            context: { type: "gitRestore", hash: (_g = (_f = payload.hash) !== null && _f !== void 0 ? _f : context === null || context === void 0 ? void 0 : context.hash) !== null && _g !== void 0 ? _g : "" },
        });
    };
    const handleActionResult = (payload) => {
        if (payload.action !== "pull" && payload.action !== "push") {
            if (payload.ok) {
                gitGuideMessage = null;
                render();
            }
            return;
        }
        if (payload.hint) {
            gitGuideMessage = payload.hint;
        }
        else if (payload.ok) {
            gitGuideMessage = null;
        }
        render();
    };
    const requestStatus = () => {
        if (!deps.getWorkspaceRootKey()) {
            gitEntries = [];
            gitMessage = "ワークスペースが未選択です。";
            gitHistoryEntries = [];
            gitHistoryMessage = "ワークスペースが未選択です。";
            gitGuideMessage = null;
            render();
            return;
        }
        if (gitBusy) {
            return;
        }
        gitMessage = "取得中...";
        gitHistoryMessage = "取得中...";
        gitBusy = true;
        gitBusyMessage = "状態を確認しています...";
        gitLastAction = "refresh";
        render();
        deps.postToNative({ type: "gitStatus" }, true);
    };
    const requestInit = () => {
        if (!deps.getWorkspaceRootKey() || gitBusy || gitRepoState.ok) {
            return;
        }
        gitBusy = true;
        gitBusyMessage = "履歴管理を開始しています...";
        gitLastAction = "init";
        render();
        deps.postToNative({ type: "gitInit" });
    };
    const requestCommit = () => {
        if (!deps.getWorkspaceRootKey() || gitBusy || !gitRepoState.ok || gitEntries.length === 0) {
            return;
        }
        const message = gitCommitMessage instanceof HTMLInputElement ? gitCommitMessage.value : "";
        gitBusy = true;
        gitBusyMessage = "履歴を保存しています...";
        gitLastAction = "commit";
        render();
        deps.postToNative({ type: "gitCommit", message });
    };
    const requestCommitPreview = () => {
        if (!deps.getWorkspaceRootKey() || gitBusy || !gitRepoState.ok || gitEntries.length === 0) {
            return;
        }
        gitBusy = true;
        gitBusyMessage = "保存前の差分を確認しています...";
        gitLastAction = "commit-preview";
        gitPreviewContext = { type: "commit" };
        render();
        deps.postToNative({ type: "gitDiff", mode: "commit" });
    };
    const requestPull = () => {
        if (!deps.getWorkspaceRootKey() ||
            gitBusy ||
            !gitRepoState.ok ||
            !gitRemoteState.exists ||
            gitBranchState.detached ||
            gitEntries.length > 0) {
            return;
        }
        gitBusy = true;
        gitBusyMessage = "受け取り中...";
        gitLastAction = "pull";
        render();
        deps.postToNative({ type: "gitPull" });
    };
    const requestPush = () => {
        if (!deps.getWorkspaceRootKey() ||
            gitBusy ||
            !gitRepoState.ok ||
            !gitRemoteState.exists ||
            gitBranchState.detached ||
            gitEntries.length > 0) {
            return;
        }
        gitBusy = true;
        gitBusyMessage = "送信中...";
        gitLastAction = "push";
        render();
        deps.postToNative({ type: "gitPush" });
    };
    const requestSetRemote = () => {
        if (!deps.getWorkspaceRootKey() || gitBusy || !gitRepoState.ok) {
            return;
        }
        const url = gitRemoteInput instanceof HTMLInputElement ? gitRemoteInput.value : "";
        gitBusy = true;
        gitBusyMessage = "同期先を保存しています...";
        gitLastAction = "remote";
        render();
        deps.postToNative({ type: "gitSetRemote", url });
    };
    const requestRestore = (hash) => {
        if (!deps.getWorkspaceRootKey() ||
            gitBusy ||
            !gitRepoState.ok ||
            gitEntries.length > 0 ||
            gitBranchState.detached) {
            return;
        }
        const trimmed = (hash !== null && hash !== void 0 ? hash : "").trim();
        if (!trimmed) {
            return;
        }
        gitBusy = true;
        gitBusyMessage = "履歴を戻しています...";
        gitLastAction = "restore";
        render();
        deps.postToNative({ type: "gitRestore", hash: trimmed });
    };
    const requestRestorePreview = (entry) => {
        if (!deps.getWorkspaceRootKey() ||
            gitBusy ||
            !gitRepoState.ok ||
            gitEntries.length > 0 ||
            gitBranchState.detached) {
            return;
        }
        const hash = entry.hash.trim();
        if (!hash) {
            return;
        }
        gitBusy = true;
        gitBusyMessage = "復元内容を確認しています...";
        gitLastAction = "restore";
        gitPreviewContext = {
            type: "restore",
            hash,
            shortHash: entry.shortHash,
            message: entry.message,
        };
        render();
        deps.postToNative({ type: "gitDiff", mode: "restore", hash });
    };
    const requestStage = (path) => {
        if (!deps.getWorkspaceRootKey() || gitBusy || !gitRepoState.ok)
            return;
        gitBusy = true;
        gitBusyMessage = "ステージしています...";
        render();
        deps.postToNative({ type: "gitStage", files: [path] });
    };
    const requestUnstage = (path) => {
        if (!deps.getWorkspaceRootKey() || gitBusy || !gitRepoState.ok)
            return;
        gitBusy = true;
        gitBusyMessage = "ステージを解除しています...";
        render();
        deps.postToNative({ type: "gitUnstage", files: [path] });
    };
    const requestDiscard = (path) => {
        if (!deps.getWorkspaceRootKey() || gitBusy || !gitRepoState.ok)
            return;
        // Confirm? VSCode shows modal. We can show a simple confirm or custom modal.
        // simpler confirm for now, or just do it (VSCode warns).
        // Let's rely on native dialog or just do it for this iteration.
        // Better to use electron dialog but we don't have direct access here easily without IPC.
        // For now, assume user knows (or add confirm later).
        gitBusy = true;
        gitBusyMessage = "変更を破棄しています...";
        render();
        deps.postToNative({ type: "gitDiscard", files: [path] });
    };
    const setupActions = () => {
        if (gitRefreshButton instanceof HTMLButtonElement) {
            gitRefreshButton.addEventListener("click", (e) => {
                e.stopPropagation();
                requestStatus();
            });
        }
        if (gitInitButton instanceof HTMLButtonElement) {
            gitInitButton.addEventListener("click", () => {
                requestInit();
            });
        }
        if (gitCommitButton instanceof HTMLButtonElement) {
            gitCommitButton.addEventListener("click", () => {
                requestCommit();
            });
        }
        if (gitCommitMessage instanceof HTMLInputElement) {
            gitCommitMessage.addEventListener("keydown", (event) => {
                if (event.key !== "Enter" || event.isComposing) {
                    return;
                }
                event.preventDefault();
                requestCommit();
            });
        }
        if (gitPullButton instanceof HTMLButtonElement) {
            gitPullButton.addEventListener("click", (e) => {
                e.stopPropagation();
                requestPull();
            });
        }
        if (gitPushButton instanceof HTMLButtonElement) {
            gitPushButton.addEventListener("click", (e) => {
                e.stopPropagation();
                requestPush();
            });
        }
        if (gitRemoteInput instanceof HTMLInputElement) {
            gitRemoteInput.addEventListener("keydown", (event) => {
                if (event.key !== "Enter" || event.isComposing) {
                    return;
                }
                event.preventDefault();
                requestSetRemote();
            });
        }
        if (gitHistory instanceof HTMLElement) {
            gitHistory.addEventListener("click", (event) => {
                var _a, _b, _c;
                const target = event.target;
                const button = target === null || target === void 0 ? void 0 : target.closest("button[data-git-action=\"restore\"]");
                if (!button || button.disabled) {
                    return;
                }
                const hash = (_a = button.dataset.hash) !== null && _a !== void 0 ? _a : "";
                const shortHash = (_b = button.dataset.shortHash) !== null && _b !== void 0 ? _b : hash.slice(0, 7);
                const message = (_c = button.dataset.message) !== null && _c !== void 0 ? _c : "";
                if (!hash) {
                    return;
                }
                requestRestorePreview({ hash, shortHash, message });
            });
        }
        // New event delegation for file actions (stage/unstage/discard)
        // We assume these are inside gitChangesSummary container or similar.
        // Update: git-panel-ui.ts renders into gitChangesSummary.
        const { gitChangesSummary } = context.dom;
        if (gitChangesSummary instanceof HTMLElement) {
            gitChangesSummary.addEventListener("click", (event) => {
                const target = event.target;
                const button = target === null || target === void 0 ? void 0 : target.closest("button[data-git-action]");
                if (!button || button.disabled)
                    return;
                const action = button.dataset.gitAction;
                const path = button.dataset.path;
                if (!path)
                    return;
                if (action === "stage") {
                    requestStage(path);
                }
                else if (action === "unstage") {
                    requestUnstage(path);
                }
                else if (action === "discard") {
                    requestDiscard(path);
                }
                else if (action === "open") {
                    // Open diff or file
                    deps.postToNative({ type: "openFile", path });
                }
            });
        }
    };
    return {
        render,
        reset,
        handleUpdate,
        handleDiff,
        handleActionResult,
        requestStatus,
        requestInit,
        requestCommit,
        requestCommitPreview,
        requestPull,
        requestPush,
        requestSetRemote,
        requestRestore,
        requestRestorePreview,
        requestStage,
        requestUnstage,
        requestDiscard,
        setupActions,
    };
};
