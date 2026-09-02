import { uiText } from "./i18n.js";
const getBridge = () => {
    const bridge = window.tex64Git;
    return bridge && typeof bridge.invoke === "function" ? bridge : null;
};
const STATUS_LABELS = {
    modified: { en: "Modified", ja: "変更", badge: "M" },
    added: { en: "Added", ja: "追加", badge: "A" },
    deleted: { en: "Deleted", ja: "削除", badge: "D" },
    renamed: { en: "Renamed", ja: "名前変更", badge: "R" },
    copied: { en: "Copied", ja: "コピー", badge: "C" },
    typechange: { en: "Type changed", ja: "種別変更", badge: "T" },
    untracked: { en: "Untracked", ja: "未追跡", badge: "U" },
    conflicted: { en: "Conflicted", ja: "競合", badge: "!" },
};
export const initGitUi = (context, deps) => {
    const { gitStatusLine, gitEmpty, gitMain, gitBranch, gitBranchName, gitTracking, gitFetch, gitPull, gitPush, gitCommitMessage, gitCommit, gitStageAll, gitSections, gitInit, gitInitText, gitInitButton, } = context.dom;
    let status = null;
    let busy = false;
    let visible = false;
    const setMessage = (text, isError = false) => {
        if (!(gitStatusLine instanceof HTMLElement)) {
            return;
        }
        gitStatusLine.textContent = text;
        gitStatusLine.classList.toggle("is-error", isError);
        gitStatusLine.classList.toggle("is-hidden", !text);
    };
    const setBusy = (value) => {
        busy = value;
        [gitFetch, gitPull, gitPush, gitCommit, gitStageAll, gitInitButton].forEach((element) => {
            if (element instanceof HTMLButtonElement) {
                element.disabled = value;
            }
        });
    };
    const call = async (op, payload) => {
        const bridge = getBridge();
        if (!bridge) {
            return { ok: false, error: "Source control is unavailable." };
        }
        return bridge.invoke(op, payload);
    };
    // Every mutating action goes through here: run it, say what happened, then
    // re-read the status so the panel can never drift from the repository.
    const runAction = async (op, payload, successMessage) => {
        var _a;
        if (busy) {
            return;
        }
        setBusy(true);
        setMessage(uiText("Working...", "実行中..."));
        const result = await call(op, payload);
        setBusy(false);
        if ((result === null || result === void 0 ? void 0 : result.ok) === false) {
            setMessage(String((_a = result.error) !== null && _a !== void 0 ? _a : "git failed"), true);
        }
        else {
            setMessage(successMessage);
        }
        await refresh();
    };
    const renderEntry = (entry, section) => {
        var _a, _b, _c, _d, _e, _f, _g;
        const row = document.createElement("div");
        row.className = "git-row";
        row.dataset.path = entry.path;
        const badge = document.createElement("span");
        badge.className = `git-badge is-${entry.status}`;
        badge.textContent = (_b = (_a = STATUS_LABELS[entry.status]) === null || _a === void 0 ? void 0 : _a.badge) !== null && _b !== void 0 ? _b : "?";
        badge.title = uiText((_d = (_c = STATUS_LABELS[entry.status]) === null || _c === void 0 ? void 0 : _c.en) !== null && _d !== void 0 ? _d : entry.status, (_f = (_e = STATUS_LABELS[entry.status]) === null || _e === void 0 ? void 0 : _e.ja) !== null && _f !== void 0 ? _f : entry.status);
        const name = document.createElement("button");
        name.type = "button";
        name.className = "git-row-name";
        const segments = entry.path.split("/");
        const base = (_g = segments.pop()) !== null && _g !== void 0 ? _g : entry.path;
        name.textContent = base;
        const dir = segments.join("/");
        if (dir) {
            const dirLabel = document.createElement("span");
            dirLabel.className = "git-row-dir";
            dirLabel.textContent = dir;
            name.appendChild(dirLabel);
        }
        name.title = entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path;
        name.addEventListener("click", () => {
            void openDiff(entry, section === "staged");
        });
        const actions = document.createElement("div");
        actions.className = "git-row-actions";
        const addAction = (label, title, handler, danger = false) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = danger ? "git-row-action is-danger" : "git-row-action";
            button.textContent = label;
            button.title = title;
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                handler();
            });
            actions.appendChild(button);
        };
        addAction("↗", uiText("Open file", "ファイルを開く"), () => deps.requestOpenFile(entry.path));
        if (section === "unstaged") {
            addAction("↶", uiText("Discard changes", "変更を破棄"), () => {
                // Discarding is the one destructive action in this panel, so it always
                // asks first — there is no undo once git has thrown the edits away.
                const confirmed = window.confirm(uiText(`Discard all changes to ${entry.path}? This cannot be undone.`, `${entry.path} の変更をすべて破棄しますか？元に戻せません。`));
                if (confirmed) {
                    void runAction("discard", { paths: [entry.path] }, uiText("Changes discarded.", "変更を破棄しました。"));
                }
            }, true);
            addAction("+", uiText("Stage changes", "ステージする"), () => void runAction("stage", { paths: [entry.path] }, uiText("Staged.", "ステージしました。")));
        }
        else {
            addAction("−", uiText("Unstage changes", "ステージを解除"), () => void runAction("unstage", { paths: [entry.path] }, uiText("Unstaged.", "ステージを解除しました。")));
        }
        row.append(badge, name, actions);
        return row;
    };
    const openDiff = async (entry, staged) => {
        var _a, _b, _c;
        if (entry.status === "untracked") {
            deps.requestOpenFile(entry.path);
            return;
        }
        const result = await call("diff", { path: entry.path, staged });
        if ((result === null || result === void 0 ? void 0 : result.ok) === false) {
            setMessage(String((_a = result.error) !== null && _a !== void 0 ? _a : "diff failed"), true);
            return;
        }
        deps.showDiff(String((_b = result.original) !== null && _b !== void 0 ? _b : ""), String((_c = result.modified) !== null && _c !== void 0 ? _c : ""), {
            title: staged
                ? uiText(`Staged changes — ${entry.path}`, `ステージ済みの変更 — ${entry.path}`)
                : uiText(`Working tree changes — ${entry.path}`, `作業ツリーの変更 — ${entry.path}`),
            fileName: entry.path,
        });
    };
    const renderSection = (title, entries, section) => {
        if (entries.length === 0) {
            return null;
        }
        const wrapper = document.createElement("div");
        wrapper.className = "git-section";
        const header = document.createElement("div");
        header.className = "git-section-header";
        const label = document.createElement("span");
        label.textContent = title;
        const count = document.createElement("span");
        count.className = "git-section-count";
        count.textContent = String(entries.length);
        header.append(label, count);
        wrapper.appendChild(header);
        entries.forEach((entry) => wrapper.appendChild(renderEntry(entry, section)));
        return wrapper;
    };
    const render = () => {
        var _a, _b, _c, _d, _e;
        if (!(gitSections instanceof HTMLElement)) {
            return;
        }
        const hasWorkspace = Boolean(deps.getWorkspaceRootKey());
        const isRepo = Boolean(status === null || status === void 0 ? void 0 : status.isRepo);
        gitEmpty === null || gitEmpty === void 0 ? void 0 : gitEmpty.classList.toggle("is-hidden", hasWorkspace);
        gitMain === null || gitMain === void 0 ? void 0 : gitMain.classList.toggle("is-hidden", !hasWorkspace || !isRepo);
        gitInit === null || gitInit === void 0 ? void 0 : gitInit.classList.toggle("is-hidden", !hasWorkspace || isRepo);
        if (gitInitText instanceof HTMLElement) {
            gitInitText.textContent =
                (status === null || status === void 0 ? void 0 : status.gitAvailable) === false
                    ? uiText("Git was not found on this machine.", "この環境で git が見つかりませんでした。")
                    : uiText("This folder is not a Git repository.", "このフォルダは Git リポジトリではありません。");
        }
        if (gitInitButton instanceof HTMLButtonElement) {
            gitInitButton.classList.toggle("is-hidden", (status === null || status === void 0 ? void 0 : status.gitAvailable) === false);
        }
        if (!hasWorkspace || !isRepo) {
            gitSections.innerHTML = "";
            return;
        }
        if (gitBranchName instanceof HTMLElement) {
            gitBranchName.textContent = (status === null || status === void 0 ? void 0 : status.branch) || "—";
        }
        if (gitTracking instanceof HTMLElement) {
            const parts = [];
            if (status === null || status === void 0 ? void 0 : status.ahead) {
                parts.push(`↑${status.ahead}`);
            }
            if (status === null || status === void 0 ? void 0 : status.behind) {
                parts.push(`↓${status.behind}`);
            }
            if (!(status === null || status === void 0 ? void 0 : status.upstream)) {
                parts.push(uiText("no upstream", "上流なし"));
            }
            gitTracking.textContent = parts.join(" ");
            gitTracking.title = (_a = status === null || status === void 0 ? void 0 : status.remoteUrl) !== null && _a !== void 0 ? _a : "";
        }
        gitSections.innerHTML = "";
        const staged = (_b = status === null || status === void 0 ? void 0 : status.staged) !== null && _b !== void 0 ? _b : [];
        const conflicted = (_c = status === null || status === void 0 ? void 0 : status.conflicted) !== null && _c !== void 0 ? _c : [];
        const changed = [...((_d = status === null || status === void 0 ? void 0 : status.unstaged) !== null && _d !== void 0 ? _d : []), ...((_e = status === null || status === void 0 ? void 0 : status.untracked) !== null && _e !== void 0 ? _e : [])];
        const sections = [
            renderSection(uiText("Conflicts", "競合"), conflicted, "unstaged"),
            renderSection(uiText("Staged changes", "ステージ済みの変更"), staged, "staged"),
            renderSection(uiText("Changes", "変更"), changed, "unstaged"),
        ].filter((element) => element !== null);
        if (sections.length === 0) {
            const clean = document.createElement("div");
            clean.className = "panel-placeholder";
            clean.textContent = (status === null || status === void 0 ? void 0 : status.lastCommit)
                ? uiText(`No changes. Last commit: ${status.lastCommit}`, `変更はありません。最新のコミット: ${status.lastCommit}`)
                : uiText("No changes.", "変更はありません。");
            gitSections.appendChild(clean);
            return;
        }
        sections.forEach((element) => gitSections.appendChild(element));
    };
    const refresh = async () => {
        if (!getBridge()) {
            return;
        }
        const result = (await call("status"));
        status = result;
        if ((result === null || result === void 0 ? void 0 : result.ok) === false && result.error) {
            setMessage(result.error, true);
        }
        render();
    };
    const openBranchMenu = async () => {
        const result = await call("branches");
        const branches = Array.isArray(result === null || result === void 0 ? void 0 : result.branches) ? result.branches : [];
        const rect = gitBranch instanceof HTMLElement ? gitBranch.getBoundingClientRect() : null;
        const items = branches.map((branch) => ({
            type: "action",
            label: branch === (status === null || status === void 0 ? void 0 : status.branch) ? `● ${branch}` : branch,
            action: () => {
                void runAction("checkout", { branch }, uiText(`Switched to ${branch}.`, `${branch} に切り替えました。`));
            },
        }));
        items.push({ type: "separator" });
        items.push({
            type: "action",
            label: uiText("New branch...", "新しいブランチ..."),
            action: () => {
                const name = window.prompt(uiText("New branch name", "新しいブランチ名"));
                if (name && name.trim()) {
                    void runAction("checkout", { branch: name.trim(), create: true }, uiText(`Created ${name.trim()}.`, `${name.trim()} を作成しました。`));
                }
            },
        });
        deps.contextMenu.open(rect ? rect.left : 40, rect ? rect.bottom + 4 : 80, items);
    };
    const commit = () => {
        if (!(gitCommitMessage instanceof HTMLTextAreaElement)) {
            return;
        }
        const message = gitCommitMessage.value.trim();
        if (!message) {
            setMessage(uiText("Enter a commit message.", "コミットメッセージを入力してください。"), true);
            gitCommitMessage.focus();
            return;
        }
        void (async () => {
            await runAction("commit", { message }, uiText("Committed.", "コミットしました。"));
            // Only clear the box when the commit actually landed, so a rejected
            // message is not lost.
            if (!(gitStatusLine === null || gitStatusLine === void 0 ? void 0 : gitStatusLine.classList.contains("is-error"))) {
                gitCommitMessage.value = "";
            }
        })();
    };
    const push = () => {
        var _a;
        const branch = (_a = status === null || status === void 0 ? void 0 : status.branch) !== null && _a !== void 0 ? _a : "";
        const setUpstream = !(status === null || status === void 0 ? void 0 : status.upstream) && Boolean(branch);
        void runAction("push", { setUpstream, branch }, uiText("Pushed.", "push しました。"));
    };
    gitBranch === null || gitBranch === void 0 ? void 0 : gitBranch.addEventListener("click", () => void openBranchMenu());
    gitFetch === null || gitFetch === void 0 ? void 0 : gitFetch.addEventListener("click", () => void runAction("fetch", undefined, uiText("Fetched.", "fetch しました。")));
    gitPull === null || gitPull === void 0 ? void 0 : gitPull.addEventListener("click", () => void runAction("pull", undefined, uiText("Pulled.", "pull しました。")));
    gitPush === null || gitPush === void 0 ? void 0 : gitPush.addEventListener("click", push);
    gitCommit === null || gitCommit === void 0 ? void 0 : gitCommit.addEventListener("click", commit);
    gitStageAll === null || gitStageAll === void 0 ? void 0 : gitStageAll.addEventListener("click", () => void runAction("stageAll", undefined, uiText("Staged everything.", "すべてステージしました。")));
    gitInitButton === null || gitInitButton === void 0 ? void 0 : gitInitButton.addEventListener("click", () => void runAction("init", undefined, uiText("Repository created.", "リポジトリを作成しました。")));
    if (gitCommitMessage instanceof HTMLTextAreaElement) {
        gitCommitMessage.addEventListener("keydown", (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                commit();
            }
        });
    }
    const activate = () => {
        visible = true;
        void refresh();
    };
    return {
        // Only refreshes while the panel is on screen: running `git status` for
        // every file the watcher reports would be pure waste otherwise.
        refresh: () => {
            if (visible) {
                void refresh();
            }
        },
        activate,
        deactivate: () => {
            visible = false;
        },
    };
};
