import { createActionsMenu } from "./actions-menu.js";
import { getEditorOperationGuard } from "./editor-operation-guard.js";
import { uiText } from "./i18n.js";
const gitErrors = {
    STALE_WORKSPACE: "プロジェクトが変わりました。Gitを開き直してください。",
    GIT_BUSY: "進行中の操作を完了してください。",
    HISTORY_BUSY: "進行中の操作を完了してください。",
    WORKSPACE_BUSY: "Axiomの編集が終わるまでお待ちください。",
    TERMINAL_BUSY: "ターミナルを終了してから操作してください。",
    GIT_DIRTY: "変更をコミットするか、一時退避してください。",
    GIT_AUTHOR_REQUIRED: "コミットに使う名前とメールアドレスを設定してください。",
    GIT_NOTHING_STAGED: "コミットするファイルを選んでください。",
    GIT_UNMERGED: "すべての競合を解決してください。",
    GIT_OPERATION_IN_PROGRESS: "現在の統合を完了するか中止してください。",
    GIT_REF_INVALID: "有効なブランチ名・タグ名を指定してください。",
    GIT_REF_EXISTS: "同じ名前が既にあります。別の名前にしてください。",
    GIT_REF_NOT_FOUND: "選択したブランチがありません。再読み込みしてください。",
    GIT_NO_COMMIT: "先にコミットを作成してください。",
    GIT_PLAN_EXPIRED: "状態が変わりました。操作内容を確認し直してください。",
    STATE_CHANGED: "ファイルが変わりました。操作内容を確認し直してください。",
    GIT_UNRELATED_HISTORIES: "このフォルダと接続先の履歴は別のものです。接続先を別フォルダに取得してください。",
    GIT_SSH_TRUST_REQUIRED: "この接続にはHTTPSのGitHub URLを使ってください。",
    GIT_NETWORK_CONFIG_UNTRUSTED: "Gitの通信設定を確認してください。",
    GIT_CREDENTIAL_HELPER_UNTRUSTED: "この接続で使う認証方法を選んでください。",
    GIT_LAYOUT_UNSUPPORTED: "このリポジトリの構成にはまだ対応していません。",
    GIT_TLS_UNTRUSTED: "GitのTLS検証を有効にしてください。",
    GIT_HOOK_UNTRUSTED: "このリポジトリには追加の実行処理が設定されています。",
    GIT_PUSH_URL_DIFFERENT: "取得先と送信先が異なります。接続設定を確認してください。",
    SYNC_REQUIRED: "ファイルが変わりました。画面の同期を再試行してください。",
};
export function initGitUi(editor, diff) {
    const bridge = window.tex64Git;
    const host = document.getElementById("git-panel");
    if (!bridge || !host)
        return;
    const guard = getEditorOperationGuard(editor);
    const el = (tag, className = "", text = "") => {
        const node = document.createElement(tag);
        node.className = className;
        node.textContent = text;
        return node;
    };
    const button = (label, action) => {
        const node = el("button", "history-button", label);
        node.type = "button";
        node.onclick = action;
        return node;
    };
    let state = null, busy = false, phase = "idle", revision = 0;
    const heading = el("div", "history-heading");
    const branches = button(uiText("Branch", "ブランチ"), () => void branchDialog());
    const list = el("div", "git-files");
    const error = el("p", "history-error");
    error.setAttribute("role", "status");
    const message = el("input", "history-name");
    message.placeholder = uiText("Describe the change", "変更の要点");
    message.setAttribute("aria-label", message.placeholder);
    message.maxLength = 16000;
    const commit = button(uiText("Commit", "コミット"), () => void perform("commit", { message: message.value }, true).then((success) => { if (success)
        message.value = ""; }));
    commit.classList.add("is-primary");
    const network = button(uiText("Check for updates", "更新を確認"), () => void networkDialog());
    const clone = button(uiText("Clone into another folder…", "別フォルダに取得…"), () => void cloneDialog());
    const merge = button(uiText("Merge branch…", "ブランチを取り込む…"), () => void mergeDialog());
    const tag = button(uiText("Add tag…", "タグを付ける…"), () => void tagDialog());
    const pushTag = button(uiText("Push tag…", "タグを送信…"), () => void pushTagDialog());
    const settings = button(uiText("Git settings…", "Git設定…"), () => settingsDialog());
    const refreshButton = button(uiText("Refresh", "再読み込み"), () => void run(refresh));
    const shelve = button(uiText("Set changes aside…", "変更を一時退避…"), () => void shelveDialog());
    const unshelve = button(uiText("Restore saved changes…", "退避した変更を戻す…"), () => void unshelveDialog());
    const recovery = button(uiText("Resume synchronization", "画面の同期を再試行"), () => void run(phase === "recovery-required" ? recoveryDialog : sync));
    recovery.hidden = true;
    heading.append(el("h2", "", "Git"), branches, createActionsMenu([merge, shelve, unshelve, tag, pushTag, clone, settings, refreshButton]));
    host.append(heading, error, recovery, list, message, commit, network);
    async function call(action, payload = {}) {
        const requestedWorkspace = renderedWorkspaceId;
        const value = await bridge.call(action, payload);
        if (requestedWorkspace && renderedWorkspaceId && requestedWorkspace !== renderedWorkspaceId)
            throw new Error(uiText("The project changed. Open this operation again.", "プロジェクトが変わりました。操作を開き直してください。"));
        if (!value.ok)
            throw Object.assign(new Error(uiText(value.error || "The operation failed.", gitErrors[value.code] || value.error) || uiText("The operation failed.", "操作できませんでした。")), { code: value.code });
        return value;
    }
    async function refresh() {
        var _a;
        const current = ++revision;
        const value = await call("status").catch(reason => {
            if (reason.code === "STALE_WORKSPACE")
                staleRefreshError = reason.message;
            throw reason;
        });
        if (current !== revision)
            return;
        if (staleRefreshError && error.textContent === staleRefreshError)
            error.textContent = "";
        staleRefreshError = null;
        acceptWorkspace(value.workspaceId);
        state = value.state;
        phase = value.phase || "idle";
        if (state === null || state === void 0 ? void 0 : state.repository) {
            try {
                const value = await call("shelves");
                unshelve.hidden = !((_a = value.shelves) === null || _a === void 0 ? void 0 : _a.length);
            }
            catch {
                unshelve.hidden = true;
            }
        }
        else
            unshelve.hidden = true;
        render();
    }
    async function run(action) {
        if (busy)
            return false;
        busy = true;
        error.textContent = "";
        render();
        try {
            await action();
            return true;
        }
        catch (reason) {
            error.textContent = reason instanceof Error ? reason.message : String(reason);
            return false;
        }
        finally {
            busy = false;
            render();
        }
    }
    async function sync() {
        const value = await call("sync");
        const buffers = editor.getHistoryBuffers();
        editor.applyHistoryFiles(value.resetModels === false ? value.files.filter((file) => !buffers.some(buffer => buffer.path === file.path && buffer.content === file.content && buffer.savedContent === file.content)) : value.files);
        await call("ack", { buffers: editor.getHistoryBuffers() });
        await refresh();
        guard.setLocked("git-ui", phase !== "idle");
    }
    async function saved(purpose, action) {
        if (editor.isAnyGroupComposing())
            throw new Error(uiText("Finish text conversion first.", "文字の変換を確定してください。"));
        guard.setLocked("git-ui", true);
        let started = false;
        try {
            await call("begin", { purpose, openPaths: editor.getHistoryBuffers().map(item => item.path) });
            started = true;
            if (!await editor.saveDirtyFiles())
                throw new Error(uiText("Resolve the save conflict first.", "保存の競合を解消してください。"));
            await action();
        }
        finally {
            if (started) {
                const status = await call("status");
                phase = status.phase;
                if (phase === "syncing")
                    await sync();
                else if (phase === "saving") {
                    await call("release");
                    phase = "idle";
                }
            }
            guard.setLocked("git-ui", phase !== "idle");
            await refresh();
        }
    }
    function dialog(title, content, label, action) {
        const dialogWorkspace = renderedWorkspaceId;
        const modal = el("dialog", "history-confirm git-dialog");
        const titleNode = el("h2", "", title);
        titleNode.id = `git-dialog-${Date.now()}`;
        modal.setAttribute("aria-labelledby", titleNode.id);
        const status = el("p", "history-error");
        status.setAttribute("role", "status");
        const accept = button(label, () => {
            if (dialogWorkspace !== renderedWorkspaceId) {
                modal.close();
                return;
            }
            accept.disabled = true;
            void action().then((result) => { if (result !== false)
                modal.close();
            else
                status.textContent = error.textContent || uiText("Review the selection before continuing.", "選択内容を確認してください。"); }).catch(reason => { status.textContent = reason.message || String(reason); }).finally(() => { accept.disabled = false; });
        });
        accept.classList.add("is-primary");
        const cancel = button(uiText("Cancel", "キャンセル"), () => modal.close());
        modal.append(titleNode, content, status, el("div", "git-dialog-actions"));
        modal.lastElementChild.append(cancel, accept);
        modal.addEventListener("close", () => modal.remove());
        document.body.append(modal);
        modal.showModal();
        return modal;
    }
    function field(label, placeholder = "") {
        const wrapper = el("label", "git-field", label), input = el("input", "history-name");
        input.placeholder = placeholder;
        wrapper.append(input);
        return { wrapper, input };
    }
    function refSelect(prefix, excludeCurrent = false) {
        const select = el("select", "history-name");
        select.setAttribute("aria-label", uiText("Branch or tag", "ブランチ・タグ"));
        for (const ref of (state === null || state === void 0 ? void 0 : state.refs) || [])
            if (ref.name.startsWith(prefix) && (!excludeCurrent || ref.name !== (state === null || state === void 0 ? void 0 : state.branchRef))) {
                const option = el("option", "", ref.name.replace(/^refs\/(heads|remotes|tags)\//, ""));
                option.value = ref.name;
                select.append(option);
            }
        return select;
    }
    async function perform(action, args, confirm = false) {
        let executed = false;
        const success = await run(async () => {
            await saved(action, async () => {
                const { plan } = await call("plan", { action, args });
                if (confirm) {
                    const accepted = await new Promise(resolve => {
                        const content = el("div");
                        for (const detail of plan.review.details || [])
                            content.append(el("p", "", detail));
                        for (const path of plan.review.changedPaths || [])
                            content.append(el("p", "git-secondary", path));
                        const modal = dialog(plan.review.title, content, plan.review.actionLabel, async () => { resolve(true); });
                        modal.addEventListener("close", () => resolve(false));
                    });
                    if (!accepted)
                        return;
                }
                await call("execute", { planId: plan.planId });
                executed = true;
            });
        });
        return Boolean(success && executed);
    }
    async function branchDialog() {
        const content = el("div"), select = refSelect("refs/heads/", true);
        content.append(select);
        const name = field(uiText("New branch", "新しいブランチ"), "feature-name");
        content.append(name.wrapper);
        dialog(uiText("Switch branch", "ブランチを切り替える"), content, uiText("Continue", "続ける"), async () => {
            if (!name.input.value.trim() && !select.value)
                throw new Error(uiText("Choose a branch.", "ブランチを選んでください。"));
            return perform(name.input.value.trim() ? "branch-create" : "branch-switch", name.input.value.trim() ? { name: name.input.value.trim() } : { ref: select.value }, true);
        });
    }
    async function mergeDialog() {
        const content = el("div"), select = refSelect("refs/", true);
        content.append(el("p", "", `${uiText("Into", "統合先")}：${(state === null || state === void 0 ? void 0 : state.branch) || "—"}`), select);
        dialog(uiText("Merge branch", "ブランチを取り込む"), content, uiText("Review", "内容を確認"), async () => { return perform("merge", { ref: select.value }, true); });
    }
    async function tagDialog() {
        const content = el("div"), name = field(uiText("Tag", "タグ"), "v1.0.0"), note = field(uiText("Description", "説明"));
        content.append(name.wrapper, note.wrapper);
        dialog(uiText("Add tag", "タグを付ける"), content, uiText("Review", "内容を確認"), async () => { return perform("tag-create", { name: name.input.value, ...(note.input.value.trim() ? { message: note.input.value.trim() } : {}) }, true); });
    }
    async function connectDialog() {
        const content = el("div"), url = field(uiText("Repository URL", "リポジトリURL"), "https://github.com/owner/repository");
        content.append(url.wrapper, el("p", "git-secondary", uiText("Connect this folder. Files stay as they are.", "このフォルダに接続します。ファイルは変更しません。")));
        dialog(uiText("Connect GitHub", "GitHubに接続"), content, uiText("Connect", "接続"), async () => {
            return run(() => saved("connect", () => call("connect", { args: { url: url.input.value, initialize: !(state === null || state === void 0 ? void 0 : state.repository) } })));
        });
    }
    async function shelveDialog() {
        var _a;
        const entries = ((_a = state === null || state === void 0 ? void 0 : state.status) === null || _a === void 0 ? void 0 : _a.entries) || [];
        if (!entries.length)
            return;
        await run(() => saved("shelve", async () => {
            const { plan } = await call("shelve-plan", { paths: entries.map(item => item.path) });
            const content = el("div");
            content.append(el("p", "", uiText("Keep these changes privately on this Mac and return the files to the current commit.", "変更をこのMacに退避し、ファイルを現在のコミットに戻します。")));
            for (const item of plan.changes || [])
                content.append(el("p", "", item.path));
            await new Promise(resolve => {
                const modal = dialog(uiText("Set changes aside", "変更を一時退避"), content, uiText("Set aside", "退避"), async () => { await call("shelve", { planId: plan.planId }); });
                modal.addEventListener("close", () => resolve());
            });
        }));
    }
    async function unshelveDialog() {
        await run(async () => {
            const { shelves } = await call("shelves"), content = el("div"), select = el("select", "history-name");
            select.setAttribute("aria-label", uiText("Saved changes", "退避した変更"));
            for (const shelf of shelves) {
                const option = el("option", "", `${shelf.branch || "—"} · ${new Date(shelf.createdAt).toLocaleString()}`);
                option.value = shelf.id;
                select.append(option);
            }
            content.append(select, el("p", "git-secondary", uiText("Return to the original branch and commit before restoring.", "退避したときのブランチとコミットに戻してから復帰できます。")));
            dialog(uiText("Restore saved changes", "退避した変更を戻す"), content, uiText("Restore", "戻す"), async () => {
                if (!select.value)
                    return false;
                return run(() => saved("unshelve", () => call("unshelve", { id: select.value })));
            });
        });
    }
    async function recoveryDialog() {
        var _a;
        const plan = await call("recovery-plan", { openPaths: editor.getHistoryBuffers().map(item => item.path) }), content = el("div");
        for (const item of plan.changes || [])
            content.append(el("p", "", item.path));
        const blocked = plan.canApply === false || plan.blockedGit || ((_a = plan.blockedPaths) === null || _a === void 0 ? void 0 : _a.length) || plan.requiresManualReview;
        if (blocked)
            content.append(el("p", "", uiText("Other changes were detected. Keep the current files and review the recovery data before proceeding.", "操作後の変更があるため、自動で戻せません。現在のファイルを保護したまま確認が必要です。")));
        for (const name of plan.blockedPaths || [])
            content.append(el("p", "", name));
        if (blocked)
            content.append(button(uiText("Export a protected file…", "保護したファイルを書き出す…"), () => void run(async () => {
                const { files } = await call("recovery-files"), picker = el("div"), file = el("select", "history-name"), side = el("select", "history-name");
                file.setAttribute("aria-label", uiText("File", "ファイル"));
                side.setAttribute("aria-label", uiText("Protected version", "保護した状態"));
                for (const item of files)
                    if (["before", "after", "current"].some(key => { var _a; return (_a = item[key]) === null || _a === void 0 ? void 0 : _a.exportable; })) {
                        const option = el("option", "", item.path);
                        option.value = item.path;
                        file.append(option);
                    }
                const updateSides = () => {
                    var _a;
                    side.replaceChildren();
                    const selected = files.find((item) => item.path === file.value);
                    for (const [key, label] of [["before", uiText("Before operation", "操作前")], ["after", uiText("After operation", "操作後")], ["current", uiText("At recovery check", "復旧確認時")]])
                        if ((_a = selected === null || selected === void 0 ? void 0 : selected[key]) === null || _a === void 0 ? void 0 : _a.exportable) {
                            const option = el("option", "", label);
                            option.value = key;
                            side.append(option);
                        }
                };
                file.onchange = updateSides;
                updateSides();
                picker.append(file, side);
                dialog(uiText("Export protected file", "保護したファイルを書き出す"), picker, uiText("Choose location…", "保存先を選ぶ…"), async () => { await call("export-recovery-file", { path: file.value, side: side.value }); });
            })));
        dialog(uiText("Recover interrupted operation", "中断した操作を復旧"), content, blocked ? uiText("Close", "閉じる") : uiText("Restore previous state", "操作前に戻す"), async () => {
            if (blocked)
                return;
            await call("recovery-apply", { planId: plan.planId });
            await sync();
        });
    }
    function settingsDialog() {
        const content = el("div", "git-settings");
        const open = (label, action) => button(label, () => { modal.close(); action(); });
        content.append(el("p", "git-secondary", uiText("Connection", "接続")), open(uiText("Connect GitHub…", "GitHubに接続…"), () => void connectDialog()), el("p", "git-secondary", uiText("Commit", "コミット")), open(uiText("Author name and email…", "作成者名・メール…"), () => void authorDialog()), el("p", "git-secondary", uiText("Authentication", "認証")), open(uiText("Use TeX64 authentication…", "TeX64の認証を使う…"), () => void authenticationDialog()), open(uiText("Sign in to GitHub…", "GitHubにログイン…"), () => void run(async () => { await call("authenticate"); })));
        const modal = dialog(uiText("Git settings", "Git設定"), content, uiText("Close", "閉じる"), async () => { });
    }
    async function authenticationDialog() {
        await run(async () => {
            const plan = await call("plan-authentication");
            const content = el("div");
            for (const detail of plan.review.details || [])
                content.append(el("p", "", detail));
            dialog(plan.review.title, content, plan.review.actionLabel, async () => { await call("approve-authentication", { planId: plan.planId }); });
        });
    }
    async function authorDialog() {
        const content = el("div"), name = field(uiText("Name", "名前")), email = field(uiText("Email", "メールアドレス"));
        email.input.type = "email";
        content.append(name.wrapper, email.wrapper, el("p", "git-secondary", uiText("Used only in this repository.", "このリポジトリだけに設定します。")));
        dialog(uiText("Commit identity", "作成者名・メール"), content, uiText("Save", "保存"), () => run(() => saved("set-author", () => call("set-author", { args: { name: name.input.value, email: email.input.value } }))));
    }
    async function cloneDialog() {
        const content = el("div"), url = field(uiText("Repository URL", "リポジトリURL"), "https://github.com/owner/repository"), name = field(uiText("New folder", "新しいフォルダ名"));
        content.append(url.wrapper, name.wrapper);
        dialog(uiText("Clone into another folder", "別フォルダに取得"), content, uiText("Choose location…", "取得先を選ぶ…"), async () => {
            const selected = await call("choose-clone-destination", { name: name.input.value.trim() });
            if (selected.canceled)
                return false;
            const review = el("div");
            review.append(el("p", "", url.input.value), el("p", "", selected.destination));
            dialog(uiText("Clone repository", "リポジトリを取得"), review, uiText("Clone", "取得"), () => run(() => saved("clone", async () => {
                const result = await call("clone", { args: { url: url.input.value, destinationId: selected.destinationId } });
                error.textContent = uiText(`Saved to ${result.root}`, `取得しました：${result.root}`);
            })));
        });
    }
    async function send(action, args) {
        const result = await call(action, { args });
        if (result.status === "rejected")
            throw new Error(uiText("The destination rejected the push. Check updates before trying again.", "送信が拒否されました。接続先の更新を確認してください。"));
        if (result.status !== "confirmed")
            throw new Error(uiText("Could not confirm the push. Check the destination before retrying.", "送信結果を確認できませんでした。再送信の前に接続先を確認してください。"));
        error.textContent = uiText("Pushed", "送信しました");
    }
    function remoteSelect() {
        const select = el("select", "history-name");
        select.setAttribute("aria-label", uiText("Connection", "接続先"));
        const seen = new Set();
        for (const remote of (state === null || state === void 0 ? void 0 : state.remotes) || [])
            if (!seen.has(remote.name)) {
                seen.add(remote.name);
                const option = el("option", "", remote.name);
                option.value = remote.name;
                select.append(option);
            }
        return select;
    }
    async function networkDialog() {
        var _a;
        if (!((_a = state === null || state === void 0 ? void 0 : state.remotes) === null || _a === void 0 ? void 0 : _a.length))
            return connectDialog();
        const content = el("div"), remote = remoteSelect();
        content.append(remote);
        const modal = dialog(uiText("Check for updates", "更新を確認"), content, uiText("Fetch", "取得"), async () => {
            var _a;
            if (!await run(() => saved("fetch", () => call("fetch", { args: { remote: remote.value } }))))
                return false;
            const choices = el("div"), ref = refSelect(`refs/remotes/${remote.value}/`), counts = el("p", "git-secondary");
            const connected = (_a = state === null || state === void 0 ? void 0 : state.remotes) === null || _a === void 0 ? void 0 : _a.find(item => item.name === remote.value);
            choices.append(el("p", "", (connected === null || connected === void 0 ? void 0 : connected.url) || remote.value), el("p", "", `${uiText("Current branch", "現在のブランチ")}：${(state === null || state === void 0 ? void 0 : state.branch) || "—"}`), ref, counts);
            const cloneHelp = button(uiText("Clone into another folder…", "別フォルダに取得…"), () => { reviewModal.close(); void cloneDialog(); });
            cloneHelp.hidden = true;
            choices.append(cloneHelp);
            let countVersion = 0;
            const updateCounts = async () => {
                const version = ++countVersion;
                if (!(state === null || state === void 0 ? void 0 : state.branchRef) || !ref.value) {
                    counts.textContent = uiText("No matching remote branch", "対応する接続先のブランチはありません");
                    return;
                }
                try {
                    const value = await call("ahead-behind", { args: { localRef: state.branchRef, remoteRef: ref.value } });
                    if (version === countVersion) {
                        counts.textContent = value.related === false ? uiText("These histories are unrelated. Clone into another folder to continue.", "別の履歴です。別フォルダに取得して続けてください。") : `${uiText("Outgoing", "送信")} ${value.ahead} · ${uiText("Incoming", "受信")} ${value.behind}`;
                        choices.querySelectorAll("button").forEach(item => { item.disabled = value.related === false; });
                        reviewModal.querySelector("button.is-primary").disabled = value.related === false;
                        cloneHelp.hidden = value.related !== false;
                        cloneHelp.disabled = false;
                    }
                }
                catch {
                    if (version === countVersion)
                        counts.textContent = uiText("Could not compare these histories", "履歴を比較できませんでした");
                }
            };
            ref.onchange = () => void updateCounts();
            void updateCounts();
            choices.append(button(uiText("Merge into current branch…", "現在のブランチに統合…"), () => void perform("merge", { ref: ref.value }, true)), button(uiText("Use as tracking branch…", "追跡先に設定…"), () => void perform("set-upstream", { localRef: state === null || state === void 0 ? void 0 : state.branchRef, remoteRef: ref.value }, true)));
            const pushTarget = { remote: remote.value, ref: state === null || state === void 0 ? void 0 : state.branchRef, oid: state === null || state === void 0 ? void 0 : state.head };
            const reviewModal = dialog(uiText("Remote changes", "接続先の変更"), choices, uiText("Push current branch", "現在のブランチを送信"), async () => {
                if (!pushTarget.oid || !pushTarget.ref)
                    throw new Error(uiText("Create a commit first.", "先にコミットしてください。"));
                return run(() => saved("push", () => send("push", pushTarget)));
            });
        });
        return modal;
    }
    async function pushTagDialog() {
        const tagRefs = [...((state === null || state === void 0 ? void 0 : state.refs) || [])];
        const content = el("div"), remote = remoteSelect(), tag = refSelect("refs/tags/");
        content.append(remote, tag);
        dialog(uiText("Push tag", "タグを送信"), content, uiText("Push", "送信"), async () => {
            const selected = tagRefs.find(ref => ref.name === tag.value);
            if (!selected)
                throw new Error(uiText("Choose a tag.", "タグを選んでください。"));
            return run(() => saved("push-tag", () => send("push-tag", { remote: remote.value, ref: selected.name, oid: selected.oid })));
        });
    }
    function render() {
        var _a, _b, _c, _d;
        branches.textContent = ((state === null || state === void 0 ? void 0 : state.branch) || ((state === null || state === void 0 ? void 0 : state.detached) ? uiText("Detached HEAD", "ブランチ未選択") : uiText("Branch", "ブランチ"))) + " ▾";
        branches.disabled = busy || !(state === null || state === void 0 ? void 0 : state.repository) || phase !== "idle";
        merge.disabled = tag.disabled = pushTag.disabled = clone.disabled = settings.disabled = busy || phase !== "idle";
        message.hidden = !(state === null || state === void 0 ? void 0 : state.repository);
        commit.hidden = !(state === null || state === void 0 ? void 0 : state.repository) || phase === "conflict" || (state === null || state === void 0 ? void 0 : state.operation) === "merge";
        commit.disabled = busy || !((_a = state === null || state === void 0 ? void 0 : state.status) === null || _a === void 0 ? void 0 : _a.hasStaged) || !message.value.trim();
        network.disabled = busy;
        recovery.hidden = !["syncing", "recovery-required"].includes(phase);
        recovery.textContent = phase === "recovery-required" ? uiText("Review interrupted operation…", "中断した操作を確認…") : uiText("Resume synchronization", "画面の同期を再試行");
        list.replaceChildren();
        if (!(state === null || state === void 0 ? void 0 : state.repository)) {
            list.append(button(uiText("Connect GitHub…", "GitHubに接続…"), () => void connectDialog()));
            network.hidden = true;
            return;
        }
        network.hidden = phase === "conflict" || state.operation === "merge";
        network.textContent = ((_b = state.remotes) === null || _b === void 0 ? void 0 : _b.length) ? uiText("Check for updates", "更新を確認") : uiText("Connect GitHub…", "GitHubに接続…");
        if (!state.supported) {
            list.append(el("p", "git-secondary", state.unsupportedReason || uiText("This repository needs attention.", "このリポジトリの設定を確認してください。")));
            return;
        }
        const entries = ((_c = state.status) === null || _c === void 0 ? void 0 : _c.entries) || [];
        shelve.hidden = entries.length === 0;
        shelve.disabled = busy || phase !== "idle";
        unshelve.disabled = busy || phase !== "idle";
        if (phase === "conflict" || state.operation === "merge") {
            const actions = el("div", "git-conflict-actions");
            const finish = button(uiText("Finish merge", "統合を完了"), () => void perform("merge-finish", { message: message.value || uiText("Merge changes", "変更を統合") }, true));
            finish.disabled = busy || Boolean((_d = state.status) === null || _d === void 0 ? void 0 : _d.hasUnmerged);
            actions.append(finish, button(uiText("Abort merge…", "統合を中止…"), () => void perform("merge-abort", {}, true)));
            list.append(actions);
        }
        if (!entries.length)
            list.append(el("p", "git-secondary git-empty", uiText("No changes", "変更なし")));
        for (const entry of entries) {
            const row = el("div", "git-file"), check = el("input");
            check.type = "checkbox";
            check.checked = entry.staged;
            check.indeterminate = entry.partiallyStaged;
            check.disabled = busy || entry.unmerged;
            check.setAttribute("aria-label", `${uiText("Commit target", "コミット対象")}：${entry.path}`);
            check.onchange = () => void perform(check.checked ? "stage" : "unstage", { paths: [entry.path] });
            const name = button(entry.path, () => void run(async () => {
                const show = async (side) => {
                    var _a, _b;
                    const value = await call("diff", { path: entry.path, side });
                    if (value.text)
                        diff.showDiffModal(value.original, value.modified, 0, { title: side === "staged" ? uiText("Selected changes", "コミット対象の変更") : uiText("Remaining changes", "未選択の変更"), fileName: entry.path, viewOnly: true, closeLabel: uiText("Close", "閉じる") });
                    else {
                        const content = el("div");
                        content.append(el("p", "", entry.path), el("p", "", `${(_a = value.originalInfo.size) !== null && _a !== void 0 ? _a : 0} → ${(_b = value.modifiedInfo.size) !== null && _b !== void 0 ? _b : 0} bytes`), el("p", "git-secondary", uiText("This file cannot be shown as text.", "このファイルはテキストで比較できません。")));
                        dialog(uiText("File changes", "ファイルの変更"), content, uiText("Close", "閉じる"), async () => { });
                    }
                };
                if (entry.staged && entry.unstaged) {
                    const content = el("div");
                    const picker = dialog(entry.path, content, uiText("Close", "閉じる"), async () => { });
                    content.append(button(uiText("Selected changes", "コミット対象の変更"), () => { picker.close(); void run(() => show("staged")); }), button(uiText("Remaining changes", "未選択の変更"), () => { picker.close(); void run(() => show("unstaged")); }));
                }
                else
                    await show(entry.staged ? "staged" : "unstaged");
            }));
            name.className = "git-file-name git-file-open";
            name.title = entry.path;
            name.disabled = busy || entry.unmerged;
            const status = el("span", "git-secondary", entry.unmerged ? uiText("Conflict", "競合") : entry.partiallyStaged ? uiText("Partial", "一部選択") : entry.index === "A" || entry.index === "?" ? uiText("New", "追加") : entry.index === "D" || entry.worktree === "D" ? uiText("Deleted", "削除") : "");
            row.append(check, name, status);
            list.append(row);
            if (entry.unmerged) {
                const actions = el("div", "git-conflict-actions");
                actions.append(button(uiText("Resolve…", "競合を編集…"), () => void run(async () => {
                    const conflict = await call("read-conflict", { path: entry.path });
                    if (conflict.binary || !conflict.hasOurs || !conflict.hasTheirs) {
                        const content = el("div"), side = el("select", "history-name");
                        side.setAttribute("aria-label", uiText("Version to keep", "採用する内容"));
                        for (const [value, label, exists] of [["ours", uiText("Current branch", "現在のブランチ"), conflict.hasOurs], ["theirs", uiText("Incoming changes", "取り込む側"), conflict.hasTheirs]]) {
                            const option = el("option", "", `${label}${exists ? "" : uiText(" (delete)", "（削除）")}`);
                            option.value = value;
                            side.append(option);
                        }
                        content.append(el("p", "", entry.path), side);
                        dialog(uiText("Choose the file to keep", "ファイルの内容を選ぶ"), content, uiText("Use this version", "この内容を採用"), () => run(() => saved("resolution", () => call("write-resolution", { conflictId: conflict.conflictId, source: side.value }))));
                        return;
                    }
                    diff.showDiffModal(conflict.original || "", conflict.modified || "", 0, {
                        title: uiText("Resolve conflict", "競合を編集"), fileName: entry.path,
                        submitLabel: uiText("Save", "保存"), onApply: async (content) => {
                            await saved("resolution", () => call("write-resolution", { conflictId: conflict.conflictId, content }));
                        },
                    });
                })), button(uiText("Mark resolved", "解決済みにする"), () => void perform("resolve-stage", { paths: [entry.path] }, true)));
                list.append(actions);
            }
        }
    }
    message.oninput = () => { var _a; commit.disabled = busy || !((_a = state === null || state === void 0 ? void 0 : state.status) === null || _a === void 0 ? void 0 : _a.hasStaged) || !message.value.trim(); };
    let renderedWorkspaceId = null;
    let staleRefreshError = null;
    let refreshTimer = null;
    const acceptWorkspace = (workspaceId) => {
        var _a;
        if (typeof workspaceId !== "string")
            return;
        if (renderedWorkspaceId !== null && renderedWorkspaceId !== workspaceId) {
            revision += 1;
            document.querySelectorAll("dialog.git-dialog").forEach(modal => modal.close());
            if (((_a = diff.getDiffContext()) === null || _a === void 0 ? void 0 : _a.type) === "customApply")
                diff.closeDiffModal();
            state = null;
            message.value = "";
            error.textContent = "";
        }
        renderedWorkspaceId = workspaceId;
    };
    const scheduleRefresh = () => {
        if (refreshTimer !== null)
            return;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            if (busy) {
                scheduleRefresh();
                return;
            }
            // Background status must not erase the result of the operation that
            // triggered this save notification.
            busy = true;
            render();
            void refresh().catch(reason => {
                error.textContent = reason instanceof Error ? reason.message : String(reason);
            }).finally(() => { busy = false; render(); });
        }, 150);
    };
    // A status read spawns about eleven git processes, and autosave lands here
    // after every pause in typing. Read only while the Git panel is shown;
    // a change behind a hidden panel marks it stale and the panel catches up
    // when it opens.
    const panel = host.closest(".panel");
    const panelShown = () => !panel || panel.classList.contains("is-active");
    let staleWhileHidden = false;
    const requestRefresh = () => {
        if (panelShown())
            scheduleRefresh();
        else
            staleWhileHidden = true;
    };
    if (panel) {
        new MutationObserver(() => {
            if (!staleWhileHidden || !panelShown())
                return;
            staleWhileHidden = false;
            scheduleRefresh();
        }).observe(panel, { attributes: true, attributeFilter: ["class"] });
    }
    bridge.onChange(value => {
        const payload = value.payload || {};
        const hadIdentity = renderedWorkspaceId !== null;
        if (["updateWorkspace", "git:state", "workspace:operation"].includes(value.type))
            acceptWorkspace(payload.workspaceId);
        if (!hadIdentity && renderedWorkspaceId !== null)
            requestRefresh();
        const operation = value.type === "workspace:operation" ? payload : value.type === "updateWorkspace" ? payload.workspaceOperation : null;
        if (operation) {
            guard.setLocked("workspace-main", operation.phase !== "idle");
            guard.refresh();
        }
        if (value.type === "git:state") {
            phase = payload.phase || "idle";
            render();
        }
        if (value.type === "updateWorkspace" || value.type === "file:externalChange" || value.type === "saveResult" && payload.ok)
            requestRefresh();
    });
    const initialIdentity = bridge.getIdentity();
    if (initialIdentity.workspaceId && Number.isSafeInteger(initialIdentity.workspaceGeneration)) {
        acceptWorkspace(initialIdentity.workspaceId);
        if (panelShown())
            void run(refresh);
        else
            staleWhileHidden = true;
    }
}
