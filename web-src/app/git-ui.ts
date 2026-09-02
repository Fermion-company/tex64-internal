import type { AppContext } from "./context.js";
import type { ContextMenuApi, ContextMenuItem } from "./context-menu.js";
import { uiText } from "./i18n.js";

// The Source Control panel. Everything here is a thin shell over the machine's
// own git (electron/services/git.cjs): stage, commit, sync, switch branch, and
// look at a diff. Authentication is whatever the user's git already uses, so a
// push to GitHub behaves exactly as it does in their terminal.

type GitEntry = {
  path: string;
  status: string;
  originalPath?: string;
};

type GitStatus = {
  ok?: boolean;
  isRepo?: boolean;
  gitAvailable?: boolean;
  error?: string;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  detached?: boolean;
  staged?: GitEntry[];
  unstaged?: GitEntry[];
  untracked?: GitEntry[];
  conflicted?: GitEntry[];
  remoteUrl?: string;
  lastCommit?: string;
};

type GitBridge = {
  invoke: (
    op: string,
    payload?: Record<string, unknown>
  ) => Promise<Record<string, unknown> & { ok?: boolean; error?: string }>;
};

const getBridge = (): GitBridge | null => {
  const bridge = (window as unknown as { tex64Git?: GitBridge }).tex64Git;
  return bridge && typeof bridge.invoke === "function" ? bridge : null;
};

type GitUiDeps = {
  contextMenu: ContextMenuApi;
  getWorkspaceRootKey: () => string | null;
  requestOpenFile: (path: string) => void;
  showDiff: (
    original: string,
    modified: string,
    options: { title: string; fileName: string }
  ) => void;
};

export type GitUiApi = {
  refresh: () => void;
  /** Called when the Source Control tab becomes visible. */
  activate: () => void;
  /** Called when another sidebar tab takes over; stops background refreshes. */
  deactivate: () => void;
};

const STATUS_LABELS: Record<string, { en: string; ja: string; badge: string }> = {
  modified: { en: "Modified", ja: "変更", badge: "M" },
  added: { en: "Added", ja: "追加", badge: "A" },
  deleted: { en: "Deleted", ja: "削除", badge: "D" },
  renamed: { en: "Renamed", ja: "名前変更", badge: "R" },
  copied: { en: "Copied", ja: "コピー", badge: "C" },
  typechange: { en: "Type changed", ja: "種別変更", badge: "T" },
  untracked: { en: "Untracked", ja: "未追跡", badge: "U" },
  conflicted: { en: "Conflicted", ja: "競合", badge: "!" },
};

export const initGitUi = (context: AppContext, deps: GitUiDeps): GitUiApi => {
  const {
    gitStatusLine,
    gitEmpty,
    gitMain,
    gitBranch,
    gitBranchName,
    gitTracking,
    gitFetch,
    gitPull,
    gitPush,
    gitCommitMessage,
    gitCommit,
    gitStageAll,
    gitSections,
    gitInit,
    gitInitText,
    gitInitButton,
  } = context.dom;

  let status: GitStatus | null = null;
  let busy = false;
  let visible = false;

  const setMessage = (text: string, isError = false) => {
    if (!(gitStatusLine instanceof HTMLElement)) {
      return;
    }
    gitStatusLine.textContent = text;
    gitStatusLine.classList.toggle("is-error", isError);
    gitStatusLine.classList.toggle("is-hidden", !text);
  };

  const setBusy = (value: boolean) => {
    busy = value;
    [gitFetch, gitPull, gitPush, gitCommit, gitStageAll, gitInitButton].forEach((element) => {
      if (element instanceof HTMLButtonElement) {
        element.disabled = value;
      }
    });
  };

  const call = async (op: string, payload?: Record<string, unknown>) => {
    const bridge = getBridge();
    if (!bridge) {
      return { ok: false, error: "Source control is unavailable." };
    }
    return bridge.invoke(op, payload);
  };

  // Every mutating action goes through here: run it, say what happened, then
  // re-read the status so the panel can never drift from the repository.
  const runAction = async (
    op: string,
    payload: Record<string, unknown> | undefined,
    successMessage: string
  ) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setMessage(uiText("Working...", "実行中..."));
    const result = await call(op, payload);
    setBusy(false);
    if (result?.ok === false) {
      setMessage(String(result.error ?? "git failed"), true);
    } else {
      setMessage(successMessage);
    }
    await refresh();
  };

  const renderEntry = (
    entry: GitEntry,
    section: "staged" | "unstaged"
  ): HTMLElement => {
    const row = document.createElement("div");
    row.className = "git-row";
    row.dataset.path = entry.path;

    const badge = document.createElement("span");
    badge.className = `git-badge is-${entry.status}`;
    badge.textContent = STATUS_LABELS[entry.status]?.badge ?? "?";
    badge.title = uiText(
      STATUS_LABELS[entry.status]?.en ?? entry.status,
      STATUS_LABELS[entry.status]?.ja ?? entry.status
    );

    const name = document.createElement("button");
    name.type = "button";
    name.className = "git-row-name";
    const segments = entry.path.split("/");
    const base = segments.pop() ?? entry.path;
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
    const addAction = (label: string, title: string, handler: () => void, danger = false) => {
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
        const confirmed = window.confirm(
          uiText(
            `Discard all changes to ${entry.path}? This cannot be undone.`,
            `${entry.path} の変更をすべて破棄しますか？元に戻せません。`
          )
        );
        if (confirmed) {
          void runAction("discard", { paths: [entry.path] }, uiText("Changes discarded.", "変更を破棄しました。"));
        }
      }, true);
      addAction("+", uiText("Stage changes", "ステージする"), () =>
        void runAction("stage", { paths: [entry.path] }, uiText("Staged.", "ステージしました。"))
      );
    } else {
      addAction("−", uiText("Unstage changes", "ステージを解除"), () =>
        void runAction("unstage", { paths: [entry.path] }, uiText("Unstaged.", "ステージを解除しました。"))
      );
    }

    row.append(badge, name, actions);
    return row;
  };

  const openDiff = async (entry: GitEntry, staged: boolean) => {
    if (entry.status === "untracked") {
      deps.requestOpenFile(entry.path);
      return;
    }
    const result = await call("diff", { path: entry.path, staged });
    if (result?.ok === false) {
      setMessage(String(result.error ?? "diff failed"), true);
      return;
    }
    deps.showDiff(String(result.original ?? ""), String(result.modified ?? ""), {
      title: staged
        ? uiText(`Staged changes — ${entry.path}`, `ステージ済みの変更 — ${entry.path}`)
        : uiText(`Working tree changes — ${entry.path}`, `作業ツリーの変更 — ${entry.path}`),
      fileName: entry.path,
    });
  };

  const renderSection = (
    title: string,
    entries: GitEntry[],
    section: "staged" | "unstaged"
  ): HTMLElement | null => {
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
    if (!(gitSections instanceof HTMLElement)) {
      return;
    }
    const hasWorkspace = Boolean(deps.getWorkspaceRootKey());
    const isRepo = Boolean(status?.isRepo);
    gitEmpty?.classList.toggle("is-hidden", hasWorkspace);
    gitMain?.classList.toggle("is-hidden", !hasWorkspace || !isRepo);
    gitInit?.classList.toggle("is-hidden", !hasWorkspace || isRepo);
    if (gitInitText instanceof HTMLElement) {
      gitInitText.textContent =
        status?.gitAvailable === false
          ? uiText(
              "Git was not found on this machine.",
              "この環境で git が見つかりませんでした。"
            )
          : uiText(
              "This folder is not a Git repository.",
              "このフォルダは Git リポジトリではありません。"
            );
    }
    if (gitInitButton instanceof HTMLButtonElement) {
      gitInitButton.classList.toggle("is-hidden", status?.gitAvailable === false);
    }
    if (!hasWorkspace || !isRepo) {
      gitSections.innerHTML = "";
      return;
    }

    if (gitBranchName instanceof HTMLElement) {
      gitBranchName.textContent = status?.branch || "—";
    }
    if (gitTracking instanceof HTMLElement) {
      const parts: string[] = [];
      if (status?.ahead) {
        parts.push(`↑${status.ahead}`);
      }
      if (status?.behind) {
        parts.push(`↓${status.behind}`);
      }
      if (!status?.upstream) {
        parts.push(uiText("no upstream", "上流なし"));
      }
      gitTracking.textContent = parts.join(" ");
      gitTracking.title = status?.remoteUrl ?? "";
    }

    gitSections.innerHTML = "";
    const staged = status?.staged ?? [];
    const conflicted = status?.conflicted ?? [];
    const changed = [...(status?.unstaged ?? []), ...(status?.untracked ?? [])];
    const sections = [
      renderSection(uiText("Conflicts", "競合"), conflicted, "unstaged"),
      renderSection(uiText("Staged changes", "ステージ済みの変更"), staged, "staged"),
      renderSection(uiText("Changes", "変更"), changed, "unstaged"),
    ].filter((element): element is HTMLElement => element !== null);
    if (sections.length === 0) {
      const clean = document.createElement("div");
      clean.className = "panel-placeholder";
      clean.textContent = status?.lastCommit
        ? uiText(
            `No changes. Last commit: ${status.lastCommit}`,
            `変更はありません。最新のコミット: ${status.lastCommit}`
          )
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
    const result = (await call("status")) as GitStatus;
    status = result;
    if (result?.ok === false && result.error) {
      setMessage(result.error, true);
    }
    render();
  };

  const openBranchMenu = async () => {
    const result = await call("branches");
    const branches = Array.isArray(result?.branches) ? (result.branches as string[]) : [];
    const rect = gitBranch instanceof HTMLElement ? gitBranch.getBoundingClientRect() : null;
    const items: ContextMenuItem[] = branches.map((branch) => ({
      type: "action",
      label: branch === status?.branch ? `● ${branch}` : branch,
      action: () => {
        void runAction(
          "checkout",
          { branch },
          uiText(`Switched to ${branch}.`, `${branch} に切り替えました。`)
        );
      },
    }));
    items.push({ type: "separator" });
    items.push({
      type: "action",
      label: uiText("New branch...", "新しいブランチ..."),
      action: () => {
        const name = window.prompt(uiText("New branch name", "新しいブランチ名"));
        if (name && name.trim()) {
          void runAction(
            "checkout",
            { branch: name.trim(), create: true },
            uiText(`Created ${name.trim()}.`, `${name.trim()} を作成しました。`)
          );
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
      if (!gitStatusLine?.classList.contains("is-error")) {
        gitCommitMessage.value = "";
      }
    })();
  };

  const push = () => {
    const branch = status?.branch ?? "";
    const setUpstream = !status?.upstream && Boolean(branch);
    void runAction("push", { setUpstream, branch }, uiText("Pushed.", "push しました。"));
  };

  gitBranch?.addEventListener("click", () => void openBranchMenu());
  gitFetch?.addEventListener("click", () =>
    void runAction("fetch", undefined, uiText("Fetched.", "fetch しました。"))
  );
  gitPull?.addEventListener("click", () =>
    void runAction("pull", undefined, uiText("Pulled.", "pull しました。"))
  );
  gitPush?.addEventListener("click", push);
  gitCommit?.addEventListener("click", commit);
  gitStageAll?.addEventListener("click", () =>
    void runAction("stageAll", undefined, uiText("Staged everything.", "すべてステージしました。"))
  );
  gitInitButton?.addEventListener("click", () =>
    void runAction("init", undefined, uiText("Repository created.", "リポジトリを作成しました。"))
  );
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
