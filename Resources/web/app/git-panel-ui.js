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
const getGitStatusKind = (status) => {
    const normalized = status.replace(/\s+/g, "");
    if (normalized === "??") {
        return "new";
    }
    if (normalized.includes("U")) {
        return "conflict";
    }
    if (normalized.includes("R")) {
        return "renamed";
    }
    if (normalized.includes("D")) {
        return "deleted";
    }
    if (normalized.includes("A")) {
        return "added";
    }
    if (normalized.includes("M")) {
        return "modified";
    }
    return "modified";
};
const formatGitStatusLabel = (status) => {
    var _a;
    const kind = getGitStatusKind(status);
    const labels = {
        new: "新規",
        conflict: "競合",
        renamed: "名前変更",
        deleted: "削除",
        added: "追加",
        modified: "変更",
    };
    return (_a = labels[kind]) !== null && _a !== void 0 ? _a : "変更";
};
const formatGitStatusShort = (status) => {
    const normalized = status.replace(/\s+/g, "");
    if (normalized === "??") {
        return "?";
    }
    if (normalized.includes("U")) {
        return "C";
    }
    if (normalized.includes("R")) {
        return "R";
    }
    if (normalized.includes("D")) {
        return "D";
    }
    if (normalized.includes("A")) {
        return "A";
    }
    if (normalized.includes("M")) {
        return "M";
    }
    return normalized.slice(0, 1) || "M";
};
const countGitStatusKinds = (entries) => {
    const counts = {
        new: 0,
        conflict: 0,
        renamed: 0,
        deleted: 0,
        added: 0,
        modified: 0,
    };
    entries.forEach((entry) => {
        const kind = getGitStatusKind(entry.status);
        counts[kind] += 1;
    });
    return counts;
};
const renderGitStatus = (target, entries, message) => {
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
    entries.forEach((entry) => {
        var _a;
        const item = document.createElement("div");
        item.className = "git-item";
        const main = document.createElement("div");
        main.className = "git-item-main";
        const normalizedPath = entry.path.replace(/\\/g, "/");
        const parts = normalizedPath.split("/").filter(Boolean);
        const nameText = (_a = parts.pop()) !== null && _a !== void 0 ? _a : entry.path;
        const dirText = parts.join("/");
        const name = document.createElement("div");
        name.className = "git-item-name";
        name.textContent = nameText;
        name.title = entry.path;
        main.appendChild(name);
        if (dirText) {
            const meta = document.createElement("div");
            meta.className = "git-item-meta";
            meta.textContent = dirText;
            main.appendChild(meta);
        }
        const status = document.createElement("span");
        const kind = getGitStatusKind(entry.status);
        status.className = `git-item-status is-${kind}`;
        status.textContent = formatGitStatusShort(entry.status);
        status.title = formatGitStatusLabel(entry.status);
        item.append(main, status);
        target.appendChild(item);
    });
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
    const counts = countGitStatusKinds(entries);
    const order = [
        { kind: "modified", label: "M", title: "変更" },
        { kind: "added", label: "A", title: "追加" },
        { kind: "new", label: "?", title: "新規" },
        { kind: "deleted", label: "D", title: "削除" },
        { kind: "renamed", label: "R", title: "名前変更" },
        { kind: "conflict", label: "C", title: "競合" },
    ];
    order.forEach(({ kind, label, title }) => {
        const count = counts[kind];
        if (!count) {
            return;
        }
        const pill = document.createElement("span");
        pill.className = `git-change-pill is-${kind}`;
        pill.textContent = `${label} ${count}`;
        pill.title = title;
        target.appendChild(pill);
    });
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
    const { gitStatus, gitHistory, gitSummaryText, gitBranchName, gitBranchSync, gitRemoteName, gitChangesCount, gitChangesSummary, gitGuide, gitGuideText, gitSyncText, gitInitRow, gitInitButton, gitCommitMessage, gitCommitButton, gitCommitSection, gitHistorySection, gitSyncSection, gitRemoteSection, gitPullButton, gitPushButton, gitRemoteInput, gitRemoteSaveButton, gitRefreshButton, } = context.dom;
    renderGitStatus(gitStatus, state.entries, state.message);
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
    const canCommit = repoReady && hasChanges && !state.busy;
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
    if (gitRemoteSaveButton instanceof HTMLButtonElement) {
        gitRemoteSaveButton.disabled = !repoReady || state.busy;
    }
    if (gitRefreshButton instanceof HTMLButtonElement) {
        gitRefreshButton.disabled = state.busy;
    }
};
