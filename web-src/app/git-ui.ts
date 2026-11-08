import { createActionsMenu } from "./actions-menu.js";
import { getEditorOperationGuard } from "./editor-operation-guard.js";
import { uiText } from "./i18n.js";
import { createExplain, explainedHeading } from "./explain.js";
import type { EditorSessionApi } from "./editor-session.js";
import type { DiffModalApi } from "./diff-modal.js";
import { collabSession } from "./collab/session.js";
import { applyCollabGuestLock } from "./collab/guest-lock.js";

type Bridge = { getIdentity(): {workspaceId?: string; workspaceGeneration?: number}; call(action: string, payload?: Record<string, unknown>): Promise<any>; onChange(handler: (message: any) => void): () => void };
type Entry = { path: string; staged: boolean; unstaged: boolean; partiallyStaged: boolean; unmerged: boolean; index: string; worktree: string };
type State = { repository: boolean; supported: boolean; unsupportedReason?: string; branch?: string; branchRef?: string; head?: string; detached?: boolean; refs?: {name: string; oid: string}[]; remotes?: {name: string; url: string; kind: string}[]; status?: {entries: Entry[]; hasStaged: boolean; hasUnmerged: boolean}; operation?: string };

const gitErrors: Record<string, string> = {
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

export function initGitUi(editor: EditorSessionApi, diff: DiffModalApi) {
  const bridge = (window as unknown as {tex64Git?: Bridge}).tex64Git;
  const host = document.getElementById("git-panel");
  if (!bridge || !host) return;
  const guard = getEditorOperationGuard(editor);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const button = (label: string, action: () => void) => {
    const node = el("button", "history-button", label); node.type = "button"; node.onclick = action; return node;
  };
  let state: State | null = null, busy = false, phase = "idle", revision = 0;
  const heading = el("div", "history-heading");
  const branches = button(uiText("Branch", "ブランチ"), () => void branchDialog());
  const list = el("div", "git-files");
  const error = el("p", "history-error"); error.setAttribute("role", "status");
  const message = el("input", "history-name"); message.placeholder = uiText("Describe the change", "変更の要点"); message.setAttribute("aria-label", message.placeholder); message.maxLength = 16000;
  const commit = button(uiText("Commit", "コミット"), () => void perform("commit", {message: message.value}, true).then((success) => { if (success) message.value = ""; }));
  commit.classList.add("is-primary");
  const network = button(uiText("Push & pull…", "送受信…"), () => void networkDialog());
  const clone = button(uiText("Clone into another folder…", "別フォルダに取得…"), () => void cloneDialog());
  const merge = button(uiText("Merge branch…", "ブランチを取り込む…"), () => void mergeDialog());
  const tag = button(uiText("Add tag…", "タグを付ける…"), () => void tagDialog());
  const pushTag = button(uiText("Push tag…", "タグを送信…"), () => void pushTagDialog());
  const settings = button(uiText("Git settings…", "Git設定…"), () => settingsDialog());
  const refreshButton = button(uiText("Refresh", "再読み込み"), () => void run(refresh));
  const shelve = button(uiText("Set changes aside…", "変更を一時退避…"), () => void shelveDialog());
  const unshelve = button(uiText("Restore saved changes…", "退避した変更を戻す…"), () => void unshelveDialog());
  const recovery = button(uiText("Resume synchronization", "画面の同期を再試行"), () => void run(phase === "recovery-required" ? recoveryDialog : sync)); recovery.hidden = true;
  heading.append(el("h2", "", "Git"), branches, createActionsMenu([merge, shelve, unshelve, tag, pushTag, clone, settings, refreshButton]));
  host.append(heading, error, recovery, list, message, commit, network);
  collabSession.onChange((state) => applyCollabGuestLock(host, state.active && state.role === "guest"));
  async function call(action: string, payload: Record<string, unknown> = {}) {
    const requestedWorkspace = renderedWorkspaceId;
    const value = await bridge!.call(action, payload);
    if (requestedWorkspace && renderedWorkspaceId && requestedWorkspace !== renderedWorkspaceId) throw new Error(uiText("The project changed. Open this operation again.", "プロジェクトが変わりました。操作を開き直してください。"));
    if (!value.ok) throw Object.assign(new Error(uiText(value.error || "The operation failed.", gitErrors[value.code] || value.error) || uiText("The operation failed.", "操作できませんでした。")), {code: value.code});
    return value;
  }
  async function refresh() {
    const current = ++revision;
    const value = await call("status").catch(reason => {
      if (reason.code === "STALE_WORKSPACE") staleRefreshError = reason.message;
      throw reason;
    });
    if (current !== revision) return;
    if (staleRefreshError && error.textContent === staleRefreshError) error.textContent = "";
    staleRefreshError = null;
    acceptWorkspace(value.workspaceId);
    state = value.state; phase = value.phase || "idle";
    if (state?.repository) { try { const value = await call("shelves"); unshelve.hidden = !value.shelves?.length; } catch { unshelve.hidden = true; } } else unshelve.hidden = true;
    render();
  }
  async function run(action: () => Promise<unknown>) {
    if (busy) return false;
    busy = true; error.textContent = ""; render();
    try { await action(); return true; }
    catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); return false; }
    finally { busy = false; render(); }
  }
  async function sync() {
    const value = await call("sync");
    const buffers = editor.getHistoryBuffers();
    editor.applyHistoryFiles(value.resetModels === false ? value.files.filter((file: {path: string; content: string | null}) => !buffers.some(buffer => buffer.path === file.path && buffer.content === file.content && buffer.savedContent === file.content)) : value.files);
    await call("ack", {buffers: editor.getHistoryBuffers()});
    await refresh(); guard.setLocked("git-ui", phase !== "idle");
  }
  async function saved(purpose: string, action: () => Promise<unknown>) {
    if (editor.isAnyGroupComposing()) throw new Error(uiText("Finish text conversion first.", "文字の変換を確定してください。"));
    guard.setLocked("git-ui", true);
    let started = false;
    try {
      await call("begin", {purpose, openPaths: editor.getHistoryBuffers().map(item => item.path)}); started = true;
      if (!await editor.saveDirtyFiles()) throw new Error(uiText("Resolve the save conflict first.", "保存の競合を解消してください。"));
      await action();
    } finally {
      if (started) {
        const status = await call("status"); phase = status.phase;
        if (phase === "syncing") await sync();
        else if (phase === "saving") { await call("release"); phase = "idle"; }
      }
      guard.setLocked("git-ui", phase !== "idle");
      await refresh();
    }
  }
  // Without an action the dialog only shows something, and its one button is Close.
  function dialog(title: string, content: HTMLElement, label?: string, action?: () => Promise<unknown>, explain?: string) {
    const dialogWorkspace = renderedWorkspaceId;
    const modal = el("dialog", "history-confirm git-dialog");
    const titleNode = el("h2", "", title); titleNode.id = `git-dialog-${Date.now()}`; modal.setAttribute("aria-labelledby", titleNode.id);
    const status = el("p", "history-error"); status.setAttribute("role", "status");
    const actions = el("div", "git-dialog-actions");
    const cancel = button(action ? uiText("Cancel", "キャンセル") : uiText("Close", "閉じる"), () => modal.close());
    actions.append(cancel);
    if (label && action) {
      const accept = button(label, () => {
        if (dialogWorkspace !== renderedWorkspaceId) { modal.close(); return; }
        accept.disabled = true;
        void action().then((result) => { if (result !== false) modal.close(); else status.textContent = error.textContent || uiText("Review the selection.", "選択を確認してください。"); }).catch(reason => { status.textContent = reason.message || String(reason); }).finally(() => { accept.disabled = false; });
      }); accept.classList.add("is-primary");
      actions.append(accept);
    }
    // A ▾ in the title does not take the initial focus.
    if (explain) (content.querySelector<HTMLElement>("input, select, button") || cancel).autofocus = true;
    modal.append(...(explain ? explainedHeading(titleNode, explain) : [titleNode]), content, status, actions);
    modal.addEventListener("close", () => modal.remove()); document.body.append(modal); modal.showModal(); return modal;
  }
  function field(label: string) {
    const wrapper = el("label", "git-field", label), input = el("input", "history-name"); wrapper.append(input); return {wrapper, input};
  }
  // A ▾ after a field's label whose text opens between the label and the
  // field. The label stays a sibling that names the field by id, and a
  // dialog's first field keeps the initial focus it had before the ▾.
  function explainField(target: {wrapper: HTMLElement; input: HTMLElement}, text: string) {
    const label = target.wrapper as HTMLLabelElement;
    const explain = createExplain(text, {topic: label.textContent?.trim() || undefined});
    const field = el("div", "git-field"), head = el("div", "has-explain");
    target.input.id = `${explain.panel.id}-field`;
    label.replaceWith(field);
    label.className = ""; label.htmlFor = target.input.id;
    head.append(label, explain.button);
    field.append(head, explain.panel, target.input);
    if (!field.previousElementSibling) target.input.autofocus = true;
  }
  function refSelect(prefix: string, excludeCurrent = false) {
    const select = el("select", "history-name"); select.setAttribute("aria-label", uiText("Branch or tag", "ブランチ・タグ"));
    for (const ref of state?.refs || []) if (ref.name.startsWith(prefix) && (!excludeCurrent || ref.name !== state?.branchRef)) {
      const option = el("option", "", ref.name.replace(/^refs\/(heads|remotes|tags)\//, "")); option.value = ref.name; select.append(option);
    }
    return select;
  }
  async function perform(action: string, args: Record<string, unknown>, confirm = false) {
    let executed = false;
    const success = await run(async () => {
      await saved(action, async () => {
        const {plan} = await call("plan", {action, args});
        if (confirm) {
          const accepted = await new Promise<boolean>(resolve => {
            const content = el("div"); for (const detail of plan.review.details || []) content.append(el("p", "", detail));
            for (const path of plan.review.changedPaths || []) content.append(el("p", "git-secondary", path));
            const modal = dialog(plan.review.title, content, plan.review.actionLabel, async () => { resolve(true); });
            modal.addEventListener("close", () => resolve(false));
          });
          if (!accepted) return;
        }
        await call("execute", {planId: plan.planId}); executed = true;
      });
    });
    return Boolean(success && executed);
  }
  async function branchDialog() {
    const content = el("div"), select = refSelect("refs/heads/", true);
    content.append(select);
    const name = field(uiText("New branch", "新しいブランチ")); content.append(name.wrapper);
    const modal = dialog(uiText("Branch", "ブランチ"), content, uiText("Switch", "切り替える"), async () => {
      if (!name.input.value.trim() && !select.value) throw new Error(uiText("Choose a branch.", "ブランチを選んでください。"));
      return perform(name.input.value.trim() ? "branch-create" : "branch-switch", name.input.value.trim() ? {name: name.input.value.trim()} : {ref: select.value}, true);
    });
    // A new name wins over the chosen branch, so the button and the list say so.
    const accept = modal.querySelector<HTMLButtonElement>("button.is-primary");
    name.input.addEventListener("input", () => {
      const creating = Boolean(name.input.value.trim());
      select.disabled = creating;
      if (accept) accept.textContent = creating ? uiText("Create and switch", "作成して切り替える") : uiText("Switch", "切り替える");
    });
  }
  async function mergeDialog() {
    const content = el("div"), select = refSelect("refs/", true); content.append(el("p", "", `${uiText("Into", "統合先")}：${state?.branch || "—"}`), select);
    dialog(uiText("Merge", "統合"), content, uiText("Review", "確認"), async () => { return perform("merge", {ref: select.value}, true); });
  }
  async function tagDialog() {
    const content = el("div"), name = field(uiText("Name", "名前")), note = field(uiText("Description", "説明")); content.append(name.wrapper, note.wrapper);
    dialog(uiText("Tag", "タグ"), content, uiText("Review", "確認"), async () => { return perform("tag-create", {name: name.input.value, ...(note.input.value.trim() ? {message: note.input.value.trim()} : {})}, true); });
  }
  async function connectDialog() {
    const content = el("div"), url = field("URL");
    content.append(url.wrapper);
    dialog(uiText("Connect GitHub", "GitHubに接続"), content, uiText("Connect", "接続"), async () => {
      return run(() => saved("connect", () => call("connect", {args: {url: url.input.value, initialize: !state?.repository}})));
    });
  }
  async function shelveDialog() {
    const entries = state?.status?.entries || [];
    if (!entries.length) return;
    await run(() => saved("shelve", async () => {
      const {plan} = await call("shelve-plan", {paths: entries.map(item => item.path)});
      const content = el("div");
      for (const item of plan.changes || []) content.append(el("p", "", item.path));
      await new Promise<void>(resolve => {
        const modal = dialog(uiText("Set changes aside", "変更を退避"), content, uiText("Set aside", "退避"), async () => { await call("shelve", {planId: plan.planId}); },
          uiText("Keeps these changes on this Mac and returns the files to the current commit.", "変更をこのMacに退避し、ファイルを現在のコミットに戻します。"));
        modal.addEventListener("close", () => resolve());
      });
    }));
  }
  async function unshelveDialog() {
    await run(async () => {
      const {shelves} = await call("shelves"), content = el("div"), select = el("select", "history-name");
      select.setAttribute("aria-label", uiText("Saved changes", "退避した変更"));
      for (const shelf of shelves) { const option = el("option", "", `${shelf.branch || "—"} · ${new Date(shelf.createdAt).toLocaleString()}`); option.value = shelf.id; select.append(option); }
      const explain = createExplain(uiText("Return to the original branch and commit before restoring.", "退避時と同じブランチ・コミットでのみ戻せます。"), {topic: uiText("saved changes", "退避した変更")});
      const row = el("div", "has-explain"); row.append(select, explain.button);
      content.append(row, explain.panel);
      dialog(uiText("Saved changes", "退避した変更"), content, uiText("Restore", "戻す"), async () => {
        if (!select.value) return false;
        return run(() => saved("unshelve", () => call("unshelve", {id: select.value})));
      });
    });
  }
  async function recoveryDialog() {
    const plan = await call("recovery-plan", {openPaths: editor.getHistoryBuffers().map(item => item.path)}), content = el("div");
    for (const item of plan.changes || []) content.append(el("p", "", item.path));
    const blocked = plan.canApply === false || plan.blockedGit || plan.blockedPaths?.length || plan.requiresManualReview;
    if (blocked) content.append(el("p", "", uiText("Later changes were found, so this cannot be undone automatically.", "操作後に変更があるため、自動では戻せません。")));
    for (const name of plan.blockedPaths || []) content.append(el("p", "", name));
    if (blocked) content.append(button(uiText("Export…", "書き出す…"), () => void run(async () => {
      const {files} = await call("recovery-files"), picker = el("div"), file = el("select", "history-name"), side = el("select", "history-name");
      file.setAttribute("aria-label", uiText("File", "ファイル")); side.setAttribute("aria-label", uiText("Protected version", "保護した状態"));
      for (const item of files) if (["before", "after", "current"].some(key => item[key]?.exportable)) { const option = el("option", "", item.path); option.value = item.path; file.append(option); }
      const updateSides = () => {
        side.replaceChildren(); const selected = files.find((item: any) => item.path === file.value);
        for (const [key, label] of [["before", uiText("Before operation", "操作前")], ["after", uiText("After operation", "操作後")], ["current", uiText("At recovery check", "復旧確認時")]]) if (selected?.[key]?.exportable) { const option = el("option", "", label); option.value = key; side.append(option); }
      };
      file.onchange = updateSides; updateSides(); picker.append(file, side);
      dialog(uiText("Export", "書き出し"), picker, uiText("Save to…", "保存先…"), async () => { await call("export-recovery-file", {path: file.value, side: side.value}); });
    })));

    if (blocked) dialog(uiText("Recovery", "復旧"), content);
    else dialog(uiText("Recovery", "復旧"), content, uiText("Restore previous state", "操作前に戻す"), async () => {
      await call("recovery-apply", {planId: plan.planId}); await sync();
    });
  }
  function settingsDialog() {
    const content = el("div", "git-settings");
    const open = (label: string, action: () => void) => button(label, () => { modal.close(); action(); });
    content.append(open(uiText("Connect GitHub…", "GitHubに接続…"), () => void connectDialog()),
      open(uiText("Commit identity…", "作成者…"), () => void authorDialog()),
      open(uiText("Git authentication…", "Gitの認証…"), () => void authenticationDialog()),
      open(uiText("Sign in to GitHub…", "GitHubにログイン…"), () => void run(async () => { await call("authenticate"); })));
    const modal = dialog(uiText("Git settings", "Git設定"), content);
  }
  async function authenticationDialog() {
    await run(async () => {
      const plan = await call("plan-authentication");
      const content = el("div");
      for (const detail of plan.review.details || []) content.append(el("p", "", detail));
      dialog(plan.review.title, content, plan.review.actionLabel, async () => { await call("approve-authentication", {planId: plan.planId}); });
    });
  }
  async function authorDialog() {
    const content = el("div"), name = field(uiText("Name", "名前")), email = field(uiText("Email", "メール"));
    email.input.type = "email"; content.append(name.wrapper, email.wrapper);
    explainField(name, uiText("Used only in this repository.", "このリポジトリだけに設定します。"));
    dialog(uiText("Commit identity", "作成者"), content, uiText("Save", "保存"), () => run(() => saved("set-author", () => call("set-author", {args: {name: name.input.value, email: email.input.value}}))));
  }
  async function cloneDialog() {
    const content = el("div"), url = field("URL"), name = field(uiText("Folder name", "フォルダ名"));
    content.append(url.wrapper, name.wrapper);
    dialog(uiText("Clone into another folder", "別フォルダに取得"), content, uiText("Clone to…", "取得先…"), async () => {
      const selected = await call("choose-clone-destination", {name: name.input.value.trim()});
      if (selected.canceled) return false;
      const review = el("div"), source = el("p", "", url.input.value); source.title = selected.destination; review.append(source);
      dialog(uiText("Clone", "取得"), review, uiText("Clone", "取得"), () => run(() => saved("clone", async () => {
        const result = await call("clone", {args: {url: url.input.value, destinationId: selected.destinationId}});
        error.textContent = uiText(`Saved to ${result.root}`, `取得しました：${result.root}`);
      })));
    });
  }
  async function send(action: string, args: Record<string, unknown>) {
    const result = await call(action, {args});
    if (result.status === "rejected") throw new Error(uiText("The destination rejected the push. Check updates before trying again.", "送信が拒否されました。接続先の更新を確認してください。"));
    if (result.status !== "confirmed") throw new Error(uiText("Could not confirm the push. Check the destination before retrying.", "送信結果を確認できませんでした。再送信の前に接続先を確認してください。"));
    error.textContent = uiText("Pushed", "送信しました");
  }
  function remoteSelect() {
    const select = el("select", "history-name"); select.setAttribute("aria-label", uiText("Connection", "接続先"));
    const seen = new Set<string>();
    for (const remote of state?.remotes || []) if (!seen.has(remote.name)) { seen.add(remote.name); const option = el("option", "", remote.name); option.value = remote.name; select.append(option); }
    return select;
  }
  async function networkDialog() {
    if (!state?.remotes?.length) return connectDialog();
    const content = el("div"), remote = remoteSelect(); content.append(remote);
    const modal = dialog(uiText("Push & pull", "送受信"), content, uiText("Fetch", "取得"), async () => {
      if (!await run(() => saved("fetch", () => call("fetch", {args: {remote: remote.value}})))) return false;
      const choices = el("div"), ref = refSelect(`refs/remotes/${remote.value}/`), counts = el("p", "git-secondary");
      const connected = el("p", "", remote.value); connected.title = state?.remotes?.find(item => item.name === remote.value)?.url || "";
      choices.append(connected, el("p", "", `${uiText("Branch", "ブランチ")}：${state?.branch || "—"}`), ref, counts);
      const cloneHelp = button(uiText("Clone into another folder…", "別フォルダに取得…"), () => { reviewModal.close(); void cloneDialog(); }); cloneHelp.hidden = true; choices.append(cloneHelp);
      let countVersion = 0;
      const updateCounts = async () => {
        const version = ++countVersion;
        if (!state?.branchRef || !ref.value) { counts.textContent = uiText("No matching remote branch", "対応するブランチがありません"); return; }
        try { const value = await call("ahead-behind", {args: {localRef: state.branchRef, remoteRef: ref.value}}); if (version === countVersion) {
          counts.textContent = value.related === false ? uiText("The histories are unrelated.", "履歴が異なります。") : `${uiText("Outgoing", "送信")} ${value.ahead} · ${uiText("Incoming", "受信")} ${value.behind}`;
          choices.querySelectorAll<HTMLButtonElement>("button").forEach(item => { item.disabled = value.related === false; }); (reviewModal.querySelector("button.is-primary") as HTMLButtonElement).disabled = value.related === false; cloneHelp.hidden = value.related !== false; cloneHelp.disabled = false;
        } }
        catch { if (version === countVersion) counts.textContent = uiText("Could not compare these histories", "履歴を比較できませんでした"); }
      };
      ref.onchange = () => void updateCounts(); void updateCounts();
      choices.append(button(uiText("Merge incoming…", "受信を取り込む…"), () => void perform("merge", {ref: ref.value}, true)),
        button(uiText("Track…", "追跡先…"), () => void perform("set-upstream", {localRef: state?.branchRef, remoteRef: ref.value}, true)));
      const pushTarget = {remote: remote.value, ref: state?.branchRef, oid: state?.head};
      const reviewModal = dialog(uiText("Remote changes", "接続先の変更"), choices, uiText("Push changes", "変更を送信"), async () => {
        if (!pushTarget.oid || !pushTarget.ref) throw new Error(uiText("Create a commit first.", "先にコミットしてください。"));
        return run(() => saved("push", () => send("push", pushTarget)));
      });
    });
    return modal;
  }
  async function pushTagDialog() {
    const tagRefs = [...(state?.refs || [])];
    const content = el("div"), remote = remoteSelect(), tag = refSelect("refs/tags/"); content.append(remote, tag);
    dialog(uiText("Push tag", "タグを送信"), content, uiText("Push", "送信"), async () => {
      const selected = tagRefs.find(ref => ref.name === tag.value); if (!selected) throw new Error(uiText("Choose a tag.", "タグを選んでください。"));
      return run(() => saved("push-tag", () => send("push-tag", {remote: remote.value, ref: selected.name, oid: selected.oid})));
    });
  }
  function render() {
    branches.textContent = (state?.branch || (state?.detached ? uiText("Detached HEAD", "ブランチ未選択") : uiText("Branch", "ブランチ"))) + " ▾";
    branches.disabled = busy || !state?.repository || phase !== "idle";
    merge.disabled = tag.disabled = pushTag.disabled = clone.disabled = settings.disabled = busy || phase !== "idle";
    message.hidden = !state?.repository; commit.hidden = !state?.repository || phase === "conflict" || state?.operation === "merge";
    commit.disabled = busy || !state?.status?.hasStaged || !message.value.trim();
    network.disabled = busy;
    recovery.hidden = !["syncing", "recovery-required"].includes(phase);
    recovery.textContent = phase === "recovery-required" ? uiText("Review interrupted operation…", "中断した操作を確認…") : uiText("Resume synchronization", "画面の同期を再試行");
    list.replaceChildren();
    if (!state?.repository) { list.append(button(uiText("Connect GitHub…", "GitHubに接続…"), () => void connectDialog())); network.hidden = true; return; }
    network.hidden = phase === "conflict" || state.operation === "merge";
    network.textContent = state.remotes?.length ? uiText("Push & pull…", "送受信…") : uiText("Connect GitHub…", "GitHubに接続…");
    if (!state.supported) { list.append(el("p", "git-secondary", state.unsupportedReason || uiText("This repository needs attention.", "このリポジトリの設定を確認してください。"))); return; }
    const entries = state.status?.entries || [];
    shelve.hidden = entries.length === 0; shelve.disabled = busy || phase !== "idle"; unshelve.disabled = busy || phase !== "idle";
    if (phase === "conflict" || state.operation === "merge") {
      const actions = el("div", "git-conflict-actions");
      const finish = button(uiText("Finish merge", "統合を完了"), () => void perform("merge-finish", {message: message.value || uiText("Merge changes", "変更を統合")}, true));
      finish.disabled = busy || Boolean(state.status?.hasUnmerged);
      actions.append(finish, button(uiText("Abort merge…", "統合を中止…"), () => void perform("merge-abort", {}, true))); list.append(actions);
    }
    if (!entries.length) list.append(el("p", "git-secondary git-empty", uiText("No changes", "変更なし")));
    for (const entry of entries) {
      const row = el("div", "git-file"), check = el("input"); check.type = "checkbox"; check.checked = entry.staged; check.indeterminate = entry.partiallyStaged; check.disabled = busy || entry.unmerged;
      check.setAttribute("aria-label", `${uiText("Commit target", "コミット対象")}：${entry.path}`);
      check.onchange = () => void perform(check.checked ? "stage" : "unstage", {paths: [entry.path]});
      const name = button(entry.path, () => void run(async () => {
        const show = async (side: "staged" | "unstaged") => {
          const value = await call("diff", {path: entry.path, side});
          if (value.text) diff.showDiffModal(value.original, value.modified, 0, {title: side === "staged" ? uiText("Commit target", "コミット対象") : uiText("Not selected", "未選択"), fileName: entry.path, viewOnly: true, closeLabel: uiText("Close", "閉じる")});
          else { const content = el("div"); content.append(el("p", "", entry.path), el("p", "", `${value.originalInfo.size ?? 0} → ${value.modifiedInfo.size ?? 0} bytes`), el("p", "git-secondary", uiText("Cannot be compared as text.", "テキストでは比較できません。"))); dialog(uiText("Changes", "変更"), content); }
        };
        if (entry.staged && entry.unstaged) { const content = el("div"); const picker = dialog(entry.path, content); content.append(button(uiText("Commit target", "コミット対象"), () => { picker.close(); void run(() => show("staged")); }), button(uiText("Not selected", "未選択"), () => { picker.close(); void run(() => show("unstaged")); })); }
        else await show(entry.staged ? "staged" : "unstaged");
      })); name.className = "git-file-name git-file-open"; name.title = entry.path; name.disabled = busy || entry.unmerged;
      const status = el("span", "git-secondary", entry.unmerged ? uiText("Conflict", "競合") : entry.partiallyStaged ? uiText("Partial", "一部選択") : entry.index === "A" || entry.index === "?" ? uiText("New", "追加") : entry.index === "D" || entry.worktree === "D" ? uiText("Deleted", "削除") : "");
      row.append(check, name, status); list.append(row);
      if (entry.unmerged) {
        const actions = el("div", "git-conflict-actions");
        actions.append(button(uiText("Resolve…", "競合を編集…"), () => void run(async () => {
          const conflict = await call("read-conflict", {path: entry.path});
          if (conflict.binary || !conflict.hasOurs || !conflict.hasTheirs) {
            const content = el("div"), side = el("select", "history-name"); side.setAttribute("aria-label", uiText("Version to keep", "採用する内容"));
            for (const [value, label, exists] of [["ours", uiText("Current branch", "現在のブランチ"), conflict.hasOurs], ["theirs", uiText("Incoming changes", "取り込む側"), conflict.hasTheirs]] as const) {
              const option = el("option", "", `${label}${exists ? "" : uiText(" (delete)", "（削除）")}`); option.value = value; side.append(option);
            }
            content.append(el("p", "", entry.path), side);
            dialog(uiText("Resolve conflict", "競合の解決"), content, uiText("Keep", "採用"), () => run(() => saved("resolution", () => call("write-resolution", {conflictId: conflict.conflictId, source: side.value}))));
            return;
          }
          diff.showDiffModal(conflict.original || "", conflict.modified || "", 0, {
            title: uiText("Resolve conflict", "競合を編集"), fileName: entry.path,
            submitLabel: uiText("Save", "保存"), onApply: async (content: string) => {
              await saved("resolution", () => call("write-resolution", {conflictId: conflict.conflictId, content}));
            },
          });
        })), button(uiText("Mark resolved", "解決済みにする"), () => void perform("resolve-stage", {paths: [entry.path]}, true)));
        list.append(actions);
      }
    }
  }
  message.oninput = () => { commit.disabled = busy || !state?.status?.hasStaged || !message.value.trim(); };
  let renderedWorkspaceId: string | null = null;
  let staleRefreshError: string | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const acceptWorkspace = (workspaceId: unknown) => {
    if (typeof workspaceId !== "string") return;
    if (renderedWorkspaceId !== null && renderedWorkspaceId !== workspaceId) {
      revision += 1;
      document.querySelectorAll<HTMLDialogElement>("dialog.git-dialog").forEach(modal => modal.close());
      if (diff.getDiffContext()?.type === "customApply") diff.closeDiffModal();
      state = null; message.value = ""; error.textContent = "";
    }
    renderedWorkspaceId = workspaceId;
  };
  const scheduleRefresh = () => {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (busy) { scheduleRefresh(); return; }
      // Background status must not erase the result of the operation that
      // triggered this save notification.
      busy = true; render();
      void refresh().catch(reason => {
        error.textContent = reason instanceof Error ? reason.message : String(reason);
      }).finally(() => { busy = false; render(); });
    }, 150);
  };
  // A status read spawns about eleven git processes, and autosave lands here
  // after every pause in typing. Read only while the Git panel is shown;
  // a change behind a hidden panel marks it stale and the panel catches up
  // when it opens.
  const panel = host.closest<HTMLElement>(".panel");
  const panelShown = () => !panel || panel.classList.contains("is-active");
  let staleWhileHidden = false;
  const requestRefresh = () => {
    if (panelShown()) scheduleRefresh();
    else staleWhileHidden = true;
  };
  if (panel) {
    new MutationObserver(() => {
      if (!staleWhileHidden || !panelShown()) return;
      staleWhileHidden = false;
      scheduleRefresh();
    }).observe(panel, { attributes: true, attributeFilter: ["class"] });
  }
  bridge.onChange(value => {
    const payload = value.payload || {};
    const hadIdentity = renderedWorkspaceId !== null;
    if (["updateWorkspace", "git:state", "workspace:operation"].includes(value.type)) acceptWorkspace(payload.workspaceId);
    if (!hadIdentity && renderedWorkspaceId !== null) requestRefresh();
    const operation = value.type === "workspace:operation" ? payload : value.type === "updateWorkspace" ? payload.workspaceOperation : null;
    if (operation) { guard.setLocked("workspace-main", operation.phase !== "idle"); guard.refresh(); }
    if (value.type === "git:state") { phase = payload.phase || "idle"; render(); }
    if (value.type === "updateWorkspace" || value.type === "file:externalChange" || value.type === "saveResult" && payload.ok) requestRefresh();
  });
  const initialIdentity = bridge.getIdentity();
  if (initialIdentity.workspaceId && Number.isSafeInteger(initialIdentity.workspaceGeneration)) {
    acceptWorkspace(initialIdentity.workspaceId);
    if (panelShown()) void run(refresh);
    else staleWhileHidden = true;
  }
}
