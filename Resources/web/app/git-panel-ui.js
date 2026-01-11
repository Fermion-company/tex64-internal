const setText = (element, text) => {
    if (element) {
        element.textContent = text;
    }
};
const setElementHidden = (element, hidden) => {
    if (element) {
        element.hidden = hidden;
    }
};
const createIcon = (name) => {
    const i = document.createElement("i");
    i.className = `icon icon-${name}`; // Assumes icon font or similar class
    // Fallback if no icon font: use text or svg.
    // simpler: use text char for now, will replace with proper icon later if needed.
    // Actually common VSCode icons: + (plus), - (minus), ↩ (undo/discard)
    return i;
};
const renderFileList = (container, entries, title, type) => {
    if (entries.length === 0)
        return;
    const header = document.createElement("div");
    header.className = "git-section-header";
    header.textContent = `${title} (${entries.length})`; // VSCode style: "Staged Changes (N)"
    container.appendChild(header);
    const list = document.createElement("div");
    list.className = "git-file-list";
    entries.forEach(entry => {
        var _a;
        const item = document.createElement("div");
        item.className = "git-file-item";
        // Status letter (M, A, D, U, ?)
        const statusLetter = document.createElement("span");
        statusLetter.className = `git-status-letter status-${entry.status} is-${type}`;
        statusLetter.textContent = entry.status;
        // File path/name
        const nameData = document.createElement("div");
        nameData.className = "git-file-info";
        const nameParams = entry.path.split("/");
        const fileName = (_a = nameParams.pop()) !== null && _a !== void 0 ? _a : entry.path;
        const dirName = nameParams.join("/");
        const nameSpan = document.createElement("span");
        nameSpan.className = "git-file-name";
        nameSpan.textContent = fileName;
        const dirSpan = document.createElement("span");
        dirSpan.className = "git-file-dir";
        dirSpan.textContent = dirName;
        nameData.append(nameSpan, dirSpan);
        // Actions
        const actions = document.createElement("div");
        actions.className = "git-file-actions";
        // Open File (click on item usually opens, but explicit button is good too)
        const openBtn = document.createElement("button");
        openBtn.className = "git-action-btn";
        openBtn.title = "ファイルを開く";
        openBtn.dataset.gitAction = "open";
        openBtn.dataset.path = entry.path;
        openBtn.innerHTML = "<svg width='16' height='16' viewBox='0 0 16 16' fill='currentColor'><path d='M13.71 4.29l-3-3L10 1H4L3 2v12l1 1h9l1-1V5l-.29-.71zM13 14H4V2h5v4h4v8zm-3-9V2l2.29 2.29L10 5z'/></svg>"; // File icon
        actions.appendChild(openBtn);
        if (type === "staged") {
            // Unstage (-)
            const unstageBtn = document.createElement("button");
            unstageBtn.className = "git-action-btn";
            unstageBtn.title = "ステージ解除";
            unstageBtn.dataset.gitAction = "unstage";
            unstageBtn.dataset.path = entry.path;
            unstageBtn.innerHTML = "<svg width='16' height='16' viewBox='0 0 16 16' fill='currentColor'><path d='M14 8H2V7h12v1z'/></svg>"; // Minus
            actions.appendChild(unstageBtn);
        }
        else {
            // Stage (+)
            const stageBtn = document.createElement("button");
            stageBtn.className = "git-action-btn";
            stageBtn.title = "ステージ";
            stageBtn.dataset.gitAction = "stage";
            stageBtn.dataset.path = entry.path;
            stageBtn.innerHTML = "<svg width='16' height='16' viewBox='0 0 16 16' fill='currentColor'><path d='M14 7v1H9v5H8V8H3V7h5V2h1v5h5z'/></svg>"; // Plus
            actions.appendChild(stageBtn);
            // Discard (Undo)
            const discardBtn = document.createElement("button");
            discardBtn.className = "git-action-btn";
            discardBtn.title = "変更を破棄";
            discardBtn.dataset.gitAction = "discard";
            discardBtn.dataset.path = entry.path;
            discardBtn.innerHTML = "<svg width='16' height='16' viewBox='0 0 16 16' fill='currentColor'><path d='M13.5 4l-2.5 2.5-2.5-2.5h2c0-2.21-1.79-4-4-4S2.5 1.79 2.5 4H1c0-3.31 2.69-6 6-6s6 2.69 6 6h.5zm-7 12c3.31 0 6-2.69 6-6h-1.5c0 2.21-1.79 4-4 4s-4-1.79-4-4H.5c0 3.31 2.69 6 6 6z'/></svg>"; // Undo/Refresh like
            // Better discard icon: 
            // <path d="M2.5 4v2h2l-2-2zm12 8v-2h-2l2 2zM6 14.5a6.48 6.48 0 0 0 4.54-1.85l-1.06-1.06A4.98 4.98 0 0 1 6 13a5 5 0 0 1-5-5h-1a6 6 0 0 0 6 6.5zm0-9a4.98 4.98 0 0 1 3.46 1.39l1.06-1.06A6.48 6.48 0 0 0 6 1.5a6 6 0 0 0-6 6.5h1A5 5 0 0 1 6 5.5z"/> (Discard changes)
            // Just use '↶' text for simplicity or custom SVG.
            // Using standard discard arrow.
            discardBtn.innerHTML = "<svg width='16' height='16' viewBox='0 0 16 16' fill='currentColor'><path d='M13.5 2l-1.5 1.5 1.5 1.5v-3zm-6 0v10l-4-4h2.5c0-2.21 1.79-4 4-4h.5V2H7.5z'/></svg>"; // A discard-ish arrow
            actions.appendChild(discardBtn);
        }
        item.append(statusLetter, nameData, actions);
        list.appendChild(item);
    });
    container.appendChild(list);
};
const renderGitChangesSummary = (target, entries, repoState) => {
    if (!(target instanceof HTMLElement)) {
        return;
    }
    target.innerHTML = "";
    if (!repoState.ok) {
        const hint = document.createElement("span");
        hint.className = "git-change-hint";
        hint.textContent = "—";
        target.appendChild(hint);
        return;
    }
    if (entries.length === 0) {
        const hint = document.createElement("span");
        hint.className = "git-change-hint";
        hint.textContent = "変更なし";
        target.appendChild(hint);
        return;
    }
    // Split entries into Staged and Unstaged (Changes)
    // entries have `staged: boolean`
    const staged = entries.filter(e => e.staged);
    const changes = entries.filter(e => !e.staged);
    if (staged.length > 0) {
        renderFileList(target, staged, "ステージされている変更", "staged");
    }
    if (changes.length > 0) {
        renderFileList(target, changes, "変更", "changes");
    }
};
const buildBranchLabel = (state) => {
    var _a;
    if (!state.workspaceRootKey) {
        return "—";
    }
    if (state.repoState.reason === "git-missing") {
        return "利用不可";
    }
    if (!state.repoState.ok) {
        return "未開始";
    }
    if (state.branchState.detached) {
        return "切り離し";
    }
    return (_a = state.branchState.name) !== null && _a !== void 0 ? _a : "不明";
};
const buildRemoteLabel = (state) => {
    var _a, _b;
    if (!state.workspaceRootKey) {
        return "—";
    }
    if (!state.repoState.ok) {
        return "—";
    }
    if (!state.remoteState.exists) {
        return "未設定";
    }
    return (_b = (_a = state.remoteState.name) !== null && _a !== void 0 ? _a : state.remoteState.url) !== null && _b !== void 0 ? _b : "設定済み";
};
const buildBranchSyncLabel = (state) => {
    var _a, _b;
    if (!state.repoState.ok || !state.remoteState.exists) {
        return "—";
    }
    if (state.branchState.detached) {
        return "切り離し";
    }
    const ahead = (_a = state.branchState.ahead) !== null && _a !== void 0 ? _a : 0;
    const behind = (_b = state.branchState.behind) !== null && _b !== void 0 ? _b : 0;
    if (ahead === 0 && behind === 0) {
        return "同期済み";
    }
    const parts = [];
    if (ahead > 0) {
        parts.push(`↑${ahead}`);
    }
    if (behind > 0) {
        parts.push(`↓${behind}`);
    }
    return parts.join(" ");
};
const renderGitHistory = (target, entries, message, state) => {
    if (!(target instanceof HTMLElement)) {
        return;
    }
    target.innerHTML = "";
    if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "panel-placeholder";
        empty.textContent = message;
        target.appendChild(empty);
        return;
    }
    // Simplified validation: allow restore if not busy?
    // Original allowed restore only if clean working tree.
    // We can keep it or relax it (restore might conflict).
    // Let's keep original safe check: canRestoreBase = no local changes.
    const canRestoreBase = state.repoState.ok &&
        !state.busy &&
        state.statusEntries.length === 0 &&
        !state.branchState.detached;
    entries.forEach((entry, index) => {
        const item = document.createElement("div");
        item.className = "git-history-item";
        if (index === 0) {
            item.dataset.current = "true";
        }
        const title = document.createElement("div");
        title.className = "git-history-title";
        title.textContent = entry.message || "履歴";
        const meta = document.createElement("div");
        meta.className = "git-history-meta";
        meta.textContent = `${entry.date} · ${entry.shortHash}${index === 0 ? " · 現在" : ""}`;
        const actions = document.createElement("div");
        actions.className = "git-history-actions";
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "panel-button ghost";
        restore.textContent = "この時点に戻す";
        restore.dataset.gitAction = "restore";
        restore.dataset.hash = entry.hash;
        restore.dataset.shortHash = entry.shortHash;
        restore.dataset.message = entry.message;
        restore.disabled = !canRestoreBase || index === 0;
        actions.appendChild(restore);
        item.append(title, meta, actions);
        target.appendChild(item);
    });
};
const buildGitSummaryMessage = (state) => {
    var _a;
    if (state.busy) {
        return (_a = state.busyMessage) !== null && _a !== void 0 ? _a : "処理中...";
    }
    if (!state.workspaceRootKey) {
        return "ワークスペース未選択";
    }
    if (state.repoState.reason === "git-missing") {
        return "履歴管理は利用不可";
    }
    if (!state.repoState.ok) {
        return "履歴管理が未開始";
    }
    return "";
};
const buildGitSyncMessage = (state) => {
    var _a, _b;
    if (!state.repoState.ok) {
        return "履歴管理が未開始";
    }
    if (!state.remoteState.exists) {
        return "同期先未設定";
    }
    if (state.branchState.detached) {
        return "ブランチ未接続";
    }
    if (state.entries.length > 0) {
        return "未保存の変更あり";
    }
    const ahead = (_a = state.branchState.ahead) !== null && _a !== void 0 ? _a : 0;
    const behind = (_b = state.branchState.behind) !== null && _b !== void 0 ? _b : 0;
    if (ahead > 0 && behind > 0) {
        return "送受信あり";
    }
    if (ahead > 0) {
        return "送信待ち";
    }
    if (behind > 0) {
        return "受信待ち";
    }
    return "同期済み";
};
export const renderGitPanel = (context, state) => {
    var _a, _b;
    const { gitStatus, gitHistory, gitSummaryText, gitBranchName, gitBranchSync, gitRemoteName, gitChangesCount, gitChangesSummary, gitGuide, gitGuideText, gitSyncText, gitInitRow, gitInitButton, gitCommitMessage, gitCommitButton, gitCommitSection, gitHistorySection, gitSyncSection, gitRemoteSection, gitPullButton, gitPushButton, gitRemoteInput, gitRefreshButton, } = context.dom;
    // Status is deprecated in new design? used for file list?
    // renderGitStatus(gitStatus, state.entries, state.message); 
    // We reuse gitChangesSummary for the main list.
    renderGitChangesSummary(gitChangesSummary, state.entries, state.repoState);
    renderGitHistory(gitHistory, state.historyEntries, state.historyMessage, {
        repoState: state.repoState,
        busy: state.busy,
        branchState: state.branchState,
        statusEntries: state.entries,
    });
    if (gitSummaryText instanceof HTMLElement) {
        const summary = buildGitSummaryMessage(state);
        setText(gitSummaryText, summary);
        setElementHidden(gitSummaryText, summary.length === 0);
    }
    if (gitBranchName instanceof HTMLElement) {
        setText(gitBranchName, buildBranchLabel(state));
    }
    if (gitBranchSync instanceof HTMLElement) {
        setText(gitBranchSync, buildBranchSyncLabel(state));
    }
    if (gitRemoteName instanceof HTMLElement) {
        setText(gitRemoteName, buildRemoteLabel(state));
    }
    if (gitChangesCount instanceof HTMLElement) {
        const count = state.repoState.ok ? state.entries.length : null;
        setText(gitChangesCount, count === null ? "—" : `${count}`);
    }
    if (gitGuide instanceof HTMLElement && gitGuideText instanceof HTMLElement) {
        setElementHidden(gitGuide, !state.guideMessage);
        setText(gitGuideText, (_a = state.guideMessage) !== null && _a !== void 0 ? _a : "");
    }
    if (gitSyncText instanceof HTMLElement) {
        setText(gitSyncText, buildGitSyncMessage(state));
    }
    const repoReady = state.repoState.ok;
    const hasWorkspace = Boolean(state.workspaceRootKey);
    const gitUnavailable = state.repoState.reason === "git-missing";
    const hasChanges = state.entries.length > 0;
    const branchDetached = state.branchState.detached === true;
    // Can commit if repo ready and NOT busy.
    // VSCode allows empty commit? Usually no.
    // Check if there are STAGED changes.
    const stagedCount = state.entries.filter(e => e.staged).length;
    const canCommit = repoReady && stagedCount > 0 && !state.busy;
    const canSync = repoReady && state.remoteState.exists && !branchDetached && !hasChanges && !state.busy;
    setElementHidden(gitInitRow, repoReady || gitUnavailable || !hasWorkspace);
    setElementHidden(gitCommitSection, !repoReady);
    setElementHidden(gitHistorySection, !repoReady);
    setElementHidden(gitSyncSection, !repoReady);
    setElementHidden(gitRemoteSection, !repoReady);
    if (gitInitButton instanceof HTMLButtonElement) {
        gitInitButton.disabled = state.busy || !hasWorkspace || repoReady || gitUnavailable;
    }
    if (gitCommitMessage instanceof HTMLInputElement) {
        gitCommitMessage.disabled = !repoReady || state.busy;
    }
    if (gitCommitButton instanceof HTMLButtonElement) {
        gitCommitButton.disabled = !canCommit;
    }
    if (gitPullButton instanceof HTMLButtonElement) {
        gitPullButton.disabled = !canSync;
    }
    if (gitPushButton instanceof HTMLButtonElement) {
        gitPushButton.disabled = !canSync;
    }
    if (gitRemoteInput instanceof HTMLInputElement) {
        gitRemoteInput.disabled = !repoReady || state.busy;
        if (document.activeElement !== gitRemoteInput) {
            gitRemoteInput.value = (_b = state.remoteState.url) !== null && _b !== void 0 ? _b : "";
        }
    }
    if (gitRefreshButton instanceof HTMLButtonElement) {
        gitRefreshButton.disabled = state.busy;
    }
};
