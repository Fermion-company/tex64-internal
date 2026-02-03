const path = require("path");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { normalizeRelativePath } = require("./workspace.cjs");
const { AGENT_TOOL_DECLARATIONS } = require("./agent-tools.cjs");
const { requestGemini } = require("./agent-llm.cjs");
const {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_READ_FILES,
  buildAgentPolicy,
  clampNumber,
  formatByteLimit,
  isBlockedPath,
  isTextExtension,
  normalizeExtensionList,
  normalizePath,
  normalizeStringList,
} = require("./agent-policy.cjs");
const {
  DEFAULT_LATEX_SYMBOL_EXTENSIONS,
  renameBibEntryKey,
  renameLatexInText,
} = require("./agent-latex.cjs");
const {
  handleListFiles,
  handleProposeCreateDirectory,
  handleProposeDelete,
  handleProposePatch,
  handleProposeRename,
  handleProposeWrite,
  handleReadFile,
  handleReadFiles,
  handleRunCommand,
  readFileFromDisk,
} = require("./agent-tools-file.cjs");
const { handleSearchFiles } = require("./agent-tools-search.cjs");
const TOOL_STATUS_LABELS = {
  list_files: "構成把握中",
  get_project_structure: "構成把握中",
  get_index: "構造解析中",
  read_file: "ファイル確認中",
  read_files: "ファイル確認中",
  search_files: "検索中",
  run_build: "ビルド検証中",
  run_command: "コマンド実行中",
  rename_latex_symbol: "シンボルリネーム中",
  get_app_settings: "設定取得中",
  set_app_settings: "設定更新中",
  propose_write: "変更案作成中",
  propose_patch: "変更案作成中",
  propose_delete: "変更案作成中",
  propose_rename: "変更案作成中",
  propose_create_directory: "変更案作成中",
};

const buildSystemPrompt = (context, rootPath, policy) => {
  const activeFilePath = context?.activeFilePath ?? "";
  const activeFileContent =
    typeof context?.activeFileContent === "string" ? context.activeFileContent : "";
  const activeFileIsDirty = Boolean(context?.activeFileIsDirty);
  const activeFileContentTruncated = Boolean(context?.activeFileContentTruncated);
  const activeFileContentLength =
    typeof context?.activeFileContentLength === "number" ? context.activeFileContentLength : null;
  const openFiles = Array.isArray(context?.openFiles) ? context.openFiles : [];
  const openFileLabel = openFiles.length
    ? openFiles
        .map((entry) => {
          const dirty = entry.isDirty ? " *" : "";
          const active = entry.isActive ? " (active)" : "";
          return `${entry.path}${dirty}${active}`;
        })
        .join(", ")
    : "";
  const dirtyOpenCount = openFiles.filter((entry) => entry.isDirty).length;
  const blockedList = policy?.blockedTopLevel ? Array.from(policy.blockedTopLevel) : [];
  const allowedList = policy?.allowedTopLevel ? Array.from(policy.allowedTopLevel) : [];
  const blockedLabel = blockedList.length > 0 ? blockedList.join(" / ") : "(なし)";
  const allowedLabel = allowedList.length > 0 ? allowedList.join(" / ") : "";
  const fileSizeLabel = formatByteLimit(policy?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const readFilesLimit = policy?.maxReadFiles ?? DEFAULT_MAX_READ_FILES;
  const agentMode = context?.agentMode === "paper" ? "paper" : "general";

  const lines = [
    "あなたは tex64 に統合されたAIアシスタントです。",
    "LaTeXプロジェクトの編集を支援します。",
    "",
    "## 利用可能なツール",
    "- list_files: ファイル一覧を取得",
    "- read_file: ファイルを読み取り",
    "- read_files: 複数ファイルを一括読み取り（効率的）",
    "- search_files: テキスト検索",
    "- get_project_structure: プロジェクト構造をツリー形式で取得",
    "- get_index: ラベル/参照/引用/セクションのインデックス取得",
    "- rename_latex_symbol: LaTeXのラベル/参照/引用キーを一括リネーム",
    "- run_build: ビルド検証を実行",
    "- run_command: ターミナルコマンドを実行",
    "- get_app_settings: アプリ設定を取得",
    "- set_app_settings: アプリ設定を更新",
    "- propose_write: ファイル作成/上書きを提案",
    "- propose_patch: 部分編集を提案（複数ファイル/複数箇所対応）",
    "- propose_delete: ファイル削除を提案",
    "- propose_rename: ファイルのリネーム/移動を提案",
    "- propose_create_directory: ディレクトリ作成を提案",
    "",
    "## 必須ルール",
    "- 検証が必要なタスクでは run_build を使って確認する（ユーザー依頼がある場合は必ず実行）",
    "- 変更は全て propose_* で提案する（適用はユーザー承認、または autoApply 有効時に自動）",
    "- 1回の応答で提案する変更（propose_*）は原則1つだけ（小さく刻んで進める）",
    "- 変更前に必ず read_file / read_files で現状を確認する（アクティブファイルのスナップショットが提供されている場合はそれを利用してよい）",
    `- ブロック対象: ${blockedLabel}${allowedLabel ? `（許可: ${allowedLabel}）` : ""}`,
    Number.isFinite(readFilesLimit)
      ? `- read_files は最大${readFilesLimit}件まで`
      : "- read_files は無制限",
    fileSizeLabel === "無制限"
      ? "- ファイルサイズ制限なし"
      : `- 1ファイル最大${fileSizeLabel}まで読み書き可能`,
    "- バイナリファイルは read_file/read_files の encoding: base64 で取得できる",
    "- 大きな変更は propose_patch で部分編集を優先する",
    "",
    "## 出力ルール",
    "- ユーザー向けの最終応答の冒頭に、短い要約を必ず付ける",
    "- 形式: 「方針: ...」「理由: ...」の2行（各1文程度）",
    "- 最後に「次の提案: ...」を1行で必ず書く（次に何をすべきかを明確にする）",
    "- 内部の推論や思考過程は書かない",
    "",
    ...(agentMode === "paper"
      ? [
          "## 論文モード",
          "- ユーザーが考えなくても論文が進むように、常に次の一手を提案する",
          "- 迷ったら仮の文章を入れて前に進め、TODOで穴埋め箇所を残す",
          "- 章立て/導入/関連/手法/実験/結果/考察/結論/参考文献の整合を優先する",
          "",
        ]
      : []),
    "## ワークスペース",
    `- Root: ${rootPath}`,
    `- Agent mode: ${agentMode}`,
    `- Active file: ${activeFilePath || "(none)"}`,
  ];

  if (openFileLabel) {
    lines.push(`- Open files: ${openFileLabel}`);
    if (dirtyOpenCount > 0) {
      lines.push(`- Unsaved buffers: ${dirtyOpenCount}件（read_file は開いている未保存内容を優先）`);
    }
  }

  if (activeFileContent) {
    lines.push(`- Active file status: ${activeFileIsDirty ? "未保存の変更あり" : "保存済み"}`);
    if (activeFileContentTruncated) {
      const fullLength = activeFileContentLength ?? activeFileContent.length;
      lines.push(`- Active file note: 先頭${activeFileContent.length}文字のみ（全${fullLength}文字）`);
    }
    lines.push("", "## Active file snapshot", "```", activeFileContent, "```");
  }

  const openSnapshots = Array.isArray(context?.openFileSnapshots)
    ? context.openFileSnapshots
    : [];
  if (openSnapshots.length > 0) {
    const seenPaths = new Set();
    const usableSnapshots = openSnapshots.filter((snapshot) => {
      if (!snapshot || typeof snapshot.path !== "string" || typeof snapshot.content !== "string") {
        return false;
      }
      if (snapshot.path === activeFilePath) {
        return false;
      }
      if (seenPaths.has(snapshot.path)) {
        return false;
      }
      seenPaths.add(snapshot.path);
      return true;
    });
    if (usableSnapshots.length > 0) {
      lines.push("", "## Open file snapshots");
      usableSnapshots.forEach((snapshot) => {
        const dirtyLabel = snapshot.isDirty ? " (未保存)" : "";
        lines.push(`### ${snapshot.path}${dirtyLabel}`);
        if (snapshot.truncated) {
          const fullLength =
            typeof snapshot.contentLength === "number"
              ? snapshot.contentLength
              : snapshot.content.length;
          lines.push(`- Snapshot note: 先頭${snapshot.content.length}文字のみ（全${fullLength}文字）`);
        }
        lines.push("```", snapshot.content, "```");
      });
    }
  }

  const recentIssues = Array.isArray(context?.recentIssues) ? context.recentIssues : [];
  const recentIssueSummary =
    typeof context?.recentIssueSummary === "string" ? context.recentIssueSummary : "";
  const recentIssueStatus =
    typeof context?.recentIssueStatus === "string" ? context.recentIssueStatus : "";
  const recentIssuesUpdatedAt =
    typeof context?.recentIssuesUpdatedAt === "string" ? context.recentIssuesUpdatedAt : "";
  if (recentIssues.length > 0) {
    lines.push("", "## Recent issues");
    if (recentIssueSummary) {
      lines.push(`- Summary: ${recentIssueSummary}${recentIssueStatus ? ` (${recentIssueStatus})` : ""}`);
    }
    if (recentIssuesUpdatedAt) {
      lines.push(`- Updated: ${recentIssuesUpdatedAt}`);
    }
    recentIssues.forEach((issue) => {
      if (!issue || typeof issue.message !== "string") {
        return;
      }
      const location = issue.path
        ? `${issue.path}${issue.line ? `:${issue.line}` : ""}`
        : issue.line
        ? `line ${issue.line}`
        : "location unknown";
      const severity = issue.severity || "error";
      const resolution =
        typeof issue.resolution === "string" && issue.resolution.trim()
          ? ` / fix: ${issue.resolution.trim()}`
          : "";
      lines.push(`- [${severity}] ${issue.message} (${location})${resolution}`);
    });
  }

  lines.push("", "必要に応じてファイルを読み、変更は提案してください。");
  return lines.join("\n");
};

class AgentService {
  constructor({
    workspace,
    searchService,
    ensureUserSettings,
    sendToRenderer,
    updateWorkspaceIfNeeded,
    requestIndex,
    buildService,
    sendBuildState,
    sendBuildLog,
    sendIssues,
    indexerService,
    apiUsageService,
  }) {
    this.workspace = workspace;
    this.searchService = searchService;
    this.ensureUserSettings = ensureUserSettings;
    this.sendToRenderer = sendToRenderer;
    this.updateWorkspaceIfNeeded = updateWorkspaceIfNeeded;
    this.requestIndex = requestIndex;
    this.buildService = buildService;
    this.sendBuildState = sendBuildState;
    this.sendBuildLog = sendBuildLog;
    this.sendIssues = sendIssues;
    this.indexerService = indexerService;
    this.apiUsageService = apiUsageService;
    this.conversations = new Map();
    this.proposals = new Map();
    this.contextByConversation = new Map();
    this.abortController = null;
    this.agentPolicy = buildAgentPolicy();
    this.agentOptions = {
      maxIterations: DEFAULT_MAX_ITERATIONS,
      stream: true,
      autoApply: false,
      autoBuild: false,
    };
    this.autoBuildInProgress = false;
    this.pendingSettingsRequests = new Map();
  }

  sendStatus(state, message, conversationId) {
    this.sendToRenderer("agent:status", { state, message, conversationId });
  }

  buildConversation(conversationId) {
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, []);
    }
    return this.conversations.get(conversationId);
  }

  clearConversation(conversationId) {
    this.conversations.set(conversationId, []);
    this.contextByConversation.delete(conversationId);
  }

  abort() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  resolveAgentPolicy(settings) {
    const policy = buildAgentPolicy(settings);
    this.agentPolicy = policy;
    return policy;
  }

  resolveAgentOptions(settings) {
    const options = {
      maxIterations: clampNumber(
        settings?.maxIterations,
        DEFAULT_MAX_ITERATIONS,
        { min: 1, max: 30 }
      ),
      stream: settings?.stream !== false,
      autoApply: settings?.autoApply === true,
      autoBuild: settings?.autoBuild === true,
    };
    this.agentOptions = options;
    return options;
  }

  setContext(conversationId, context) {
    if (!conversationId) {
      return;
    }
    this.contextByConversation.set(conversationId, context ?? {});
  }

  requestAppSettings(action, payload) {
    const requestId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSettingsRequests.delete(requestId);
        resolve({ error: "設定の取得に失敗しました。" });
      }, 3000);
      this.pendingSettingsRequests.set(requestId, { resolve, timer });
      this.sendToRenderer("settings:request", {
        requestId,
        action,
        ...payload,
      });
    });
  }

  handleSettingsResponse(payload) {
    const requestId = payload?.requestId;
    if (!requestId || !this.pendingSettingsRequests.has(requestId)) {
      return;
    }
    const entry = this.pendingSettingsRequests.get(requestId);
    this.pendingSettingsRequests.delete(requestId);
    if (entry?.timer) {
      clearTimeout(entry.timer);
    }
    entry?.resolve?.(payload);
  }

  async maybeAutoBuild(proposal) {
    if (!this.agentOptions.autoBuild || this.autoBuildInProgress) {
      return;
    }
    const pathValue = proposal?.path ?? "";
    if (!/\.(tex|bib|sty|cls|ltx|dtx)$/i.test(pathValue)) {
      return;
    }
    this.autoBuildInProgress = true;
    try {
      await this.executeToolCall(
        { name: "run_build", args: {} },
        proposal?.conversationId ?? "default"
      );
    } finally {
      this.autoBuildInProgress = false;
    }
  }

  getContextSnapshot(conversationId, targetPath) {
    if (!targetPath) {
      return null;
    }
    const context = this.contextByConversation.get(conversationId);
    if (!context || !targetPath) {
      return null;
    }
    if (context.activeFilePath === targetPath && typeof context.activeFileContent === "string") {
      return {
        path: targetPath,
        content: context.activeFileContent,
        isDirty: Boolean(context.activeFileIsDirty),
        truncated: Boolean(context.activeFileContentTruncated),
        contentLength:
          typeof context.activeFileContentLength === "number"
            ? context.activeFileContentLength
            : context.activeFileContent.length,
      };
    }
    const snapshots = Array.isArray(context.openFileSnapshots)
      ? context.openFileSnapshots
      : [];
    const match = snapshots.find((entry) => entry.path === targetPath);
    if (!match || typeof match.content !== "string") {
      return null;
    }
    return {
      path: match.path,
      content: match.content,
      isDirty: Boolean(match.isDirty),
      truncated: Boolean(match.truncated),
      contentLength:
        typeof match.contentLength === "number" ? match.contentLength : match.content.length,
    };
  }

  async applyProposal(proposalId) {
    const proposal = this.proposals.get(proposalId);
    const rootPath = this.workspace.getRootPath();
    if (!proposal) {
      this.sendToRenderer("agent:applyResult", {
        proposalId,
        ok: false,
        error: "提案が見つかりません。",
      });
      return;
    }
    if (!rootPath) {
      this.sendToRenderer("agent:applyResult", {
        proposalId,
        ok: false,
        error: "ワークスペースが選択されていません。",
      });
      return;
    }
    try {
      const type = proposal.type || "write";
      
      if (type === "delete") {
        const resolved = this.workspace.resolvePath(proposal.path);
        await fsp.unlink(resolved);
      } else if (type === "rename") {
        const oldResolved = this.workspace.resolvePath(proposal.oldPath);
        const newResolved = this.workspace.resolvePath(proposal.path);
        await fsp.mkdir(path.dirname(newResolved), { recursive: true });
        await fsp.rename(oldResolved, newResolved);
        this.sendToRenderer("renameResult", {
          oldPath: proposal.oldPath,
          newPath: proposal.path,
          isDirectory: false,
        });
      } else if (type === "mkdir") {
        const resolved = this.workspace.resolvePath(proposal.path);
        await fsp.mkdir(resolved, { recursive: true });
      } else {
        // write or patch
        const resolved = this.workspace.resolvePath(proposal.path);
        await fsp.mkdir(path.dirname(resolved), { recursive: true });
        if (proposal.encoding === "base64") {
          const buffer = Buffer.from(proposal.content, "base64");
          await fsp.writeFile(resolved, buffer);
        } else {
          await this.workspace.writeFile(proposal.path, proposal.content);
          this.sendToRenderer("agent:applyContent", {
            path: proposal.path,
            content: proposal.content,
            updateSaved: true,
          });
        }
      }
      
      await this.updateWorkspaceIfNeeded(rootPath, true);
      this.requestIndex(rootPath);
      this.proposals.delete(proposalId);
      this.sendToRenderer("agent:applyResult", { proposalId, ok: true });
      await this.maybeAutoBuild(proposal);
    } catch (error) {
      this.sendToRenderer("agent:applyResult", {
        proposalId,
        ok: false,
        error: error?.message ?? "操作に失敗しました。",
      });
    }
  }

  buildProgressMessage(label) {
    if (!label) {
      return "思考中...";
    }
    return `思考中: ${label}`;
  }

  async executeToolCall(toolCall, conversationId) {
    try {
      const name = toolCall?.name ?? "";
      let args = toolCall?.args ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      if (!args || typeof args !== "object") {
        args = {};
      }
      const policy = this.agentPolicy ?? buildAgentPolicy();
      const clip = (value, max = 60) => {
        const text = typeof value === "string" ? value.trim() : "";
        if (!text) return "";
        return text.length > max ? `${text.slice(0, max)}…` : text;
      };
      const statusLabel = TOOL_STATUS_LABELS[name];
      if (statusLabel) {
        let detail = statusLabel;
        if (name === "read_file") {
          const targetPath = normalizePath(args.path);
          if (targetPath) detail = `${statusLabel}: ${targetPath}`;
        } else if (name === "read_files") {
          const paths = normalizeStringList(args.paths).slice(0, 3);
          if (paths.length > 0) {
            const suffix = normalizeStringList(args.paths).length > 3 ? "…" : "";
            detail = `${statusLabel}: ${paths.join(", ")}${suffix}`;
          }
        } else if (name === "search_files") {
          const query = clip(args.query, 48);
          if (query) detail = `${statusLabel}: ${query}`;
        } else if (name === "list_files") {
          const directory = normalizePath(args.directory);
          if (directory) detail = `${statusLabel}: ${directory}`;
        } else if (name === "get_index") {
          const kinds = normalizeStringList(args.kinds).slice(0, 4);
          const query = clip(args.query, 32);
          if (kinds.length > 0 || query) {
            const parts = [];
            if (kinds.length > 0) parts.push(kinds.join(", "));
            if (query) parts.push(`q=${query}`);
            detail = `${statusLabel}: ${parts.join(" ")}`;
          }
        } else if (name === "rename_latex_symbol") {
          const from = clip(args.from, 24);
          const to = clip(args.to, 24);
          if (from && to) detail = `${statusLabel}: ${from} → ${to}`;
        } else if (name === "run_build") {
          const mainFile = clip(args.mainFile, 64);
          const engine = clip(args.engine, 16);
          if (mainFile || engine) {
            detail = `${statusLabel}: ${[mainFile, engine].filter(Boolean).join(" ")}`;
          }
        } else if (name === "run_command") {
          const command = clip(args.command, 64);
          if (command) detail = `${statusLabel}: ${command}`;
        } else if (
          name === "propose_write" ||
          name === "propose_patch" ||
          name === "propose_delete" ||
          name === "propose_rename" ||
          name === "propose_create_directory"
        ) {
          const targetPath = clip(args.path, 80);
          if (targetPath) detail = `${statusLabel}: ${targetPath}`;
        }
        this.sendStatus("running", this.buildProgressMessage(detail), conversationId);
      }

      if (name === "list_files") {
        return handleListFiles(this, args, policy);
      }

      if (name === "read_file") {
        return handleReadFile(this, args, policy, conversationId);
      }

      if (name === "read_files") {
        return handleReadFiles(this, args, policy, conversationId);
      }

      if (name === "search_files") {
        return handleSearchFiles(this, args, policy, conversationId);
      }

      if (name === "get_project_structure") {
        const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 3;
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        const buildTree = async (dir, depth) => {
          if (depth > maxDepth) return null;
          const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
          entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name, "ja");
          });
          const result = [];
          for (const entry of entries) {
            const absPath = path.join(dir, entry.name);
            const relPath = normalizeRelativePath(path.relative(rootPath, absPath));
            const top = relPath.split("/")[0];
            if (policy.blockedTopLevel.has(top) && !policy.allowedTopLevel.has(top)) {
              continue;
            }
            if (entry.isDirectory()) {
              const children = await buildTree(absPath, depth + 1);
              result.push({
                name: entry.name,
                path: relPath,
                type: "dir",
                children: children || [],
              });
            } else {
              result.push({ name: entry.name, path: relPath, type: "file" });
            }
          }
          return result;
        };
        const tree = await buildTree(rootPath, 1);
        return { structure: tree };
      }

      if (name === "get_index") {
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        if (!this.indexerService) {
          return { error: "インデクサが利用できません。" };
        }
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 200;
        const query =
          typeof args.query === "string" && args.query.trim() ? args.query.trim().toLowerCase() : "";
        const kinds = Array.isArray(args.kinds)
          ? args.kinds.filter((kind) => typeof kind === "string")
          : [];
        const snapshot = await this.indexerService.buildIndex(rootPath);
        const filterSymbols = (items, keyField) => {
          let result = items;
          if (query) {
            result = result.filter((entry) =>
              String(entry[keyField] ?? "").toLowerCase().includes(query)
            );
          }
          if (Number.isFinite(limit)) {
            result = result.slice(0, Math.max(0, limit));
          }
          return result;
        };
        const includeAll = kinds.length === 0;
        const data = {};
        if (includeAll || kinds.includes("labels")) {
          data.labels = filterSymbols(snapshot.labels, "key");
        }
        if (includeAll || kinds.includes("references")) {
          data.references = filterSymbols(snapshot.references, "key");
        }
        if (includeAll || kinds.includes("citations")) {
          data.citations = filterSymbols(snapshot.citations, "key");
        }
        if (includeAll || kinds.includes("sections")) {
          data.sections = filterSymbols(snapshot.sections, "title");
        }
        if (includeAll || kinds.includes("figures")) {
          data.figures = filterSymbols(snapshot.figures, "key");
        }
        if (includeAll || kinds.includes("tables")) {
          data.tables = filterSymbols(snapshot.tables, "key");
        }
        if (includeAll || kinds.includes("todos")) {
          data.todos = filterSymbols(snapshot.todos, "key");
        }
        return { index: data };
      }

      if (name === "get_app_settings") {
        const keys = Array.isArray(args.keys)
          ? args.keys.filter((entry) => typeof entry === "string")
          : [];
        const response = await this.requestAppSettings("get", { keys });
        if (response?.error) {
          return { error: response.error };
        }
        const settings = response?.settings ?? response?.payload?.settings ?? null;
        if (!settings) {
          return { error: "設定が取得できませんでした。" };
        }
        if (keys.length === 0) {
          return { settings };
        }
        const filtered = {};
        keys.forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(settings, key)) {
            filtered[key] = settings[key];
          }
        });
        return { settings: filtered };
      }

      if (name === "set_app_settings") {
        const patch =
          args?.settings && typeof args.settings === "object" ? args.settings : null;
        if (!patch) {
          return { error: "settings が空です。" };
        }
        const response = await this.requestAppSettings("set", { settings: patch });
        if (response?.error) {
          return { error: response.error };
        }
        const settings = response?.settings ?? response?.payload?.settings ?? null;
        if (!settings) {
          return { error: "設定が更新できませんでした。" };
        }
        return { settings };
      }

      if (name === "run_build") {
        if (!this.buildService) {
          return { error: "ビルド機能が利用できません。" };
        }
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        const requestedMain = typeof args.mainFile === "string" ? args.mainFile.trim() : "";
        const requestedEngine = typeof args.engine === "string" ? args.engine.trim() : "";
        const rootInfo = await this.workspace.rootInfo().catch(() => null);
        const requestedFile = requestedMain && requestedMain.trim() ? requestedMain.trim() : null;
        let targetFile = rootInfo?.path || "main.tex";
        if (requestedFile && requestedFile.endsWith(".tex")) {
          const magicRoot = await this.workspace
            .resolveTexRootFromMagic(requestedFile)
            .catch(() => null);
          if (magicRoot) {
            targetFile = magicRoot;
          } else if (!rootInfo?.path) {
            targetFile = requestedFile;
          }
        } else if (requestedFile && !rootInfo?.path) {
          targetFile = requestedFile;
        }
        this.sendBuildState?.("building", "AIがビルド中...");
        this.sendIssues?.(0, "AIがビルド中...", "info", []);
        const settings = await this.workspace.loadSettings().catch(() => null);
        const activeId =
          typeof settings?.buildProfileId === "string" ? settings.buildProfileId.trim() : "";
        const profiles = Array.isArray(settings?.buildProfiles) ? settings.buildProfiles : [];
        const selected = activeId
          ? profiles.find(
              (profile) => profile && typeof profile === "object" && profile.id === activeId
            )
          : null;
        const buildProfile = selected
          ? {
              outDir:
                typeof selected.outDir === "string" && selected.outDir.trim()
                  ? selected.outDir.trim()
                  : null,
              extraArgs:
                typeof selected.extraArgs === "string" && selected.extraArgs.trim()
                  ? selected.extraArgs.trim()
                  : null,
            }
          : null;
        const result = await this.buildService.build(
          rootPath,
          targetFile,
          requestedEngine || "lualatex",
          buildProfile
        );
        if (result.kind === "busy") {
          this.sendBuildState?.("building", "すでにビルド中です。");
          this.sendIssues?.(0, "すでにビルド中です。", "info", []);
          return { status: "busy", summary: "すでにビルド中です。" };
        }
        if (result.log) {
          this.sendBuildLog?.(result.log);
        }
        if (result.kind === "success") {
          const warningIssues = result.issues.filter(
            (issue) => issue.severity === "warning"
          );
          if (warningIssues.length > 0) {
            const summaryText = warningIssues[0]?.message ?? result.summary;
            this.sendIssues?.(warningIssues.length, summaryText, "info", warningIssues);
          } else {
            this.sendIssues?.(0, result.summary, "success", []);
          }
          this.sendBuildState?.("success", result.summary);
          return {
            status: "success",
            summary: result.summary,
            issues: result.issues,
            pdfPath: result.pdfPath ?? null,
          };
        }
        if (result.kind === "failure") {
          const count = Math.max(result.issues.length, 1);
          const summaryText = result.issues[0]?.message ?? result.summary;
          this.sendBuildState?.("failed", result.summary);
          this.sendIssues?.(count, summaryText, "error", result.issues);
          return { status: "failure", summary: result.summary, issues: result.issues };
        }
        return { status: "unknown", summary: "ビルド結果が不明です。" };
      }

      if (name === "run_command") {
        return handleRunCommand(this, args);
      }

      if (name === "rename_latex_symbol") {
        const from = typeof args.from === "string" ? args.from.trim() : "";
        const to = typeof args.to === "string" ? args.to.trim() : "";
        if (!from || !to) {
          return { error: "from と to は必須です。" };
        }
        if (from === to) {
          return { error: "from と to が同じです。" };
        }
        const invalidPattern = /[\s,{}]/;
        if (invalidPattern.test(from) || invalidPattern.test(to)) {
          return { error: "from/to に空白や区切り文字は使えません。" };
        }
        const kinds = normalizeStringList(args.kinds).map((entry) => entry.toLowerCase());
        const renameLabels =
          kinds.length === 0 || kinds.includes("label") || kinds.includes("ref");
        const renameCites =
          kinds.length === 0 || kinds.includes("cite") || kinds.includes("citation");
        if (!renameLabels && !renameCites) {
          return { error: "kinds が不正です。" };
        }
        const extOverride = normalizeExtensionList(args.extensions);
        const targetExtensions =
          extOverride.size > 0
            ? extOverride
            : new Set(DEFAULT_LATEX_SYMBOL_EXTENSIONS);
        if (!renameCites && extOverride.size === 0) {
          targetExtensions.delete("bib");
        }
        let fileList = [];
        try {
          fileList = await this.workspace.listFiles();
        } catch {
          return { error: "ファイル一覧の取得に失敗しました。" };
        }

        const preparedProposals = [];
        const skipped = [];

        for (const targetPath of fileList) {
          if (!targetPath) {
            continue;
          }
          if (isBlockedPath(targetPath, policy)) {
            skipped.push({ path: targetPath, reason: "blocked" });
            continue;
          }
          const ext = path.extname(targetPath).toLowerCase().replace(/^\./, "");
          if (!targetExtensions.has(ext)) {
            continue;
          }
          if (!isTextExtension(targetPath, policy)) {
            skipped.push({ path: targetPath, reason: "non_text" });
            continue;
          }

          let originalContent = "";
          const snapshot = this.getContextSnapshot(conversationId, targetPath);
          if (snapshot && typeof snapshot.content === "string") {
            if (snapshot.truncated && snapshot.isDirty) {
              return {
                error:
                  `${targetPath} は未保存の変更があり、スナップショットが省略されています。` +
                  "保存してから再実行してください。",
              };
            }
            if (!snapshot.truncated) {
              originalContent = snapshot.content;
            }
          }

          if (!originalContent) {
            let resolved = "";
            try {
              resolved = this.workspace.resolvePath(targetPath);
            } catch {
              continue;
            }
            const stat = await fsp.stat(resolved).catch(() => null);
            if (!stat || !stat.isFile()) {
              continue;
            }
            if (stat.size > policy.maxFileBytes) {
              skipped.push({ path: targetPath, reason: "too_large" });
              continue;
            }
            const result = await readFileFromDisk(resolved);
            if (result.binary) {
              skipped.push({ path: targetPath, reason: "binary" });
              continue;
            }
            originalContent = result.content;
          }

          let updatedContent = originalContent;
          let appliedCount = 0;

          if (ext === "bib") {
            if (renameCites) {
              const result = renameBibEntryKey(updatedContent, from, to);
              updatedContent = result.text;
              appliedCount += result.count;
            }
          } else {
            const result = renameLatexInText(updatedContent, {
              from,
              to,
              renameLabels,
              renameCites,
            });
            updatedContent = result.text;
            appliedCount += result.count;
          }

          if (appliedCount === 0 || updatedContent === originalContent) {
            continue;
          }
          if (updatedContent.length > policy.maxFileBytes) {
            skipped.push({ path: targetPath, reason: "too_large" });
            continue;
          }
          preparedProposals.push({
            path: targetPath,
            originalContent,
            updatedContent,
            appliedCount,
          });
        }

        if (preparedProposals.length === 0) {
          return { error: "一致するシンボルが見つかりません。" };
        }

        const proposals = [];
        const summaryBase =
          renameLabels && renameCites
            ? "シンボルリネーム"
            : renameLabels
            ? "ラベルリネーム"
            : "引用キーリネーム";

        for (const prepared of preparedProposals) {
          const id =
            typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
          const proposal = {
            id,
            type: "patch",
            path: prepared.path,
            content: prepared.updatedContent,
            originalContent: prepared.originalContent,
            summary: `${summaryBase}: ${from} → ${to} (${prepared.appliedCount}箇所)`,
            isNewFile: false,
            conversationId,
          };
          this.proposals.set(id, proposal);
          this.sendToRenderer("agent:proposal", { proposal });
          proposals.push({
            proposalId: id,
            path: prepared.path,
            appliedCount: prepared.appliedCount,
          });
        }

        if (this.agentOptions.autoApply) {
          for (const entry of proposals) {
            await this.applyProposal(entry.proposalId);
          }
        }

        return {
          status: "proposed",
          proposalIds: proposals.map((proposal) => proposal.proposalId),
          files: proposals,
          skipped,
        };
      }

      if (name === "propose_write") {
        return handleProposeWrite(this, args, policy, conversationId);
      }

      if (name === "propose_patch") {
        return handleProposePatch(this, args, policy, conversationId);
      }

      if (name === "propose_delete") {
        return handleProposeDelete(this, args, policy, conversationId);
      }

      if (name === "propose_rename") {
        return handleProposeRename(this, args, policy, conversationId);
      }

      if (name === "propose_create_directory") {
        return handleProposeCreateDirectory(this, args, policy, conversationId);
      }

      return { error: `unknown tool: ${name}` };
    } catch (error) {
      return { error: error?.message ?? "tool error" };
    }
  }

  async run({ message, context, conversationId = "default" }) {
    const rootPath = this.workspace.getRootPath();
    if (!rootPath) {
      this.sendToRenderer("agent:error", {
        message: "ワークスペースが選択されていません。",
        conversationId,
      });
      this.sendStatus("error", "ワークスペースが未選択です。", conversationId);
      return;
    }

    this.sendStatus("running", this.buildProgressMessage("準備中"), conversationId);
    const settings = await this.ensureUserSettings().getAgentSettings();
    const policy = this.resolveAgentPolicy(settings);
    const options = this.resolveAgentOptions(settings);
    this.contextByConversation.set(conversationId, context ?? {});
    const proxyUrl = (
      typeof process.env.TEX64_AI_PROXY_URL === "string"
        ? process.env.TEX64_AI_PROXY_URL.trim()
        : ""
    ).trim();
    const resolvedProxyUrl = proxyUrl || "https://tex64.vercel.app/api/ai-chat";

    const conversation = this.buildConversation(conversationId);
    conversation.push({ role: "user", parts: [{ text: message }] });

    const systemPrompt = buildSystemPrompt(context, rootPath, policy);
    const tools = [{ functionDeclarations: AGENT_TOOL_DECLARATIONS }];
    const generationConfig = {
      temperature: settings.temperature ?? 0.2,
      maxOutputTokens: settings.maxOutputTokens ?? 2048,
    };

    this.sendStatus("running", this.buildProgressMessage("文脈整理中"), conversationId);
    this.abort();
    this.abortController = new AbortController();

    let proposedInThisRun = false;

    for (let i = 0; i < options.maxIterations; i += 1) {
      try {
        const thinkingLabel = i === 0 ? "方針検討中" : "追加検討中";
        this.sendStatus("running", this.buildProgressMessage(thinkingLabel), conversationId);
        const handleDelta =
          options.stream === true
            ? (text) => {
                if (text) {
                  this.sendToRenderer("agent:messageDelta", { text, conversationId });
                }
              }
            : null;
        const response = await requestGemini({
          proxyUrl: resolvedProxyUrl,
          contents: conversation,
          systemInstruction: { parts: [{ text: systemPrompt }] },
          tools,
          toolConfig: { functionCallingConfig: { mode: "AUTO" } },
          generationConfig,
          signal: this.abortController.signal,
          onDelta: handleDelta,
        });

        try {
          const usage = response?.usageMetadata ?? response?.usage ?? null;
          if (usage && this.apiUsageService) {
            const promptTokens =
              usage.promptTokenCount ??
              usage.promptTokens ??
              usage.inputTokenCount ??
              usage.input_tokens;
            const outputTokens =
              usage.candidatesTokenCount ??
              usage.outputTokenCount ??
              usage.outputTokens ??
              usage.output_tokens;
            const totalTokens =
              usage.totalTokenCount ??
              usage.totalTokens ??
              (Number.isFinite(promptTokens) && Number.isFinite(outputTokens)
                ? promptTokens + outputTokens
                : undefined);
            const snapshot = await this.apiUsageService.recordUsage({
              model: response?.model,
              promptTokens,
              outputTokens,
              totalTokens,
              source: "agent",
            });
            if (snapshot) {
              this.sendToRenderer("api:usage", { snapshot });
            }
          }
        } catch {
          // ignore usage recording failures
        }

        const candidate = response?.candidates?.[0]?.content ?? null;
        const parts = candidate?.parts ?? [];
        const functionCalls = parts.filter((part) => part.functionCall);
        const textParts = parts
          .map((part) => part.text)
          .filter((text) => typeof text === "string" && text.trim().length > 0);

        if (candidate) {
          conversation.push(candidate);
        }

        if (functionCalls.length > 0) {
          for (const part of functionCalls) {
            const call = part.functionCall;
            const toolName = call?.name ?? "";
            const isProposalTool =
              typeof toolName === "string" && toolName.startsWith("propose_");
            let result = null;
            if (isProposalTool && proposedInThisRun) {
              result = {
                error:
                  "このターンでは変更提案（propose_*）は1つだけです。既に提案を作成しました。次はユーザーの適用を待ってください。",
              };
            } else {
              result = await this.executeToolCall(call, conversationId);
              if (isProposalTool && result?.status === "proposed") {
                proposedInThisRun = true;
              }
            }
            this.sendToRenderer("agent:tool", {
              name: toolName,
              summary: result?.error ?? "ok",
              conversationId,
            });
            conversation.push({
              role: "tool",
              parts: [
                {
                  functionResponse: {
                    name: toolName,
                    response: result,
                  },
                },
              ],
            });
          }
          continue;
        }

        if (textParts.length > 0) {
          const text = textParts.join("\n");
          this.sendStatus("running", this.buildProgressMessage("回答整形中"), conversationId);
          this.sendToRenderer("agent:message", { text, conversationId });
          this.sendStatus("idle", "待機中", conversationId);
          return;
        }

        this.sendToRenderer("agent:message", {
          text: "応答が空でした。",
          conversationId,
        });
        this.sendStatus("idle", "待機中", conversationId);
        return;
      } catch (error) {
        if (error?.name === "AbortError") {
          this.sendStatus("idle", "中断しました。", conversationId);
          return;
        }
        this.sendToRenderer("agent:error", {
          message: error?.message ?? "AIの呼び出しに失敗しました。",
          conversationId,
        });
        this.sendStatus("error", "AIエラー", conversationId);
        return;
      }
    }

    this.sendToRenderer("agent:message", {
      text: "上限回数に達したため停止しました。",
      conversationId,
    });
    this.sendStatus("idle", "待機中", conversationId);
  }
}

module.exports = {
  AgentService,
};
