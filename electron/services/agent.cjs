const path = require("path");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { normalizeRelativePath } = require("./workspace.cjs");
const { AGENT_TOOL_DECLARATIONS } = require("./agent-tools.cjs");
const { requestGemini } = require("./agent-llm.cjs");

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ITERATIONS = 6;
const TEXT_EXTENSIONS = new Set([
  "tex",
  "bib",
  "sty",
  "cls",
  "md",
  "txt",
  "json",
  "yaml",
  "yml",
  "csv",
  "ts",
  "js",
  "cjs",
  "mjs",
  "html",
  "css",
]);
const BLOCKED_TOP_LEVEL = new Set([".tex64", "node_modules", "Resources"]);

const normalizePath = (value) => normalizeRelativePath((value ?? "").trim());

const isBlockedPath = (relativePath) => {
  const normalized = normalizePath(relativePath);
  if (!normalized) return true;
  const top = normalized.split("/")[0];
  return BLOCKED_TOP_LEVEL.has(top);
};

const isTextExtension = (relativePath) => {
  const ext = path.extname(relativePath).toLowerCase();
  if (!ext) {
    return true;
  }
  return TEXT_EXTENSIONS.has(ext.slice(1));
};

const buildSystemPrompt = (context, rootPath) => {
  const activeFilePath = context?.activeFilePath ?? "";
  return [
    "あなたは tex64 に統合されたAIアシスタントです。",
    "LaTeXプロジェクトの編集を支援します。",
    "",
    "## 利用可能なツール",
    "- list_files: ファイル一覧を取得",
    "- read_file: ファイルを読み取り",
    "- read_files: 複数ファイルを一括読み取り（効率的）",
    "- search_files: テキスト検索",
    "- get_project_structure: プロジェクト構造をツリー形式で取得",
    "- propose_write: ファイル作成/上書きを提案",
    "- propose_patch: 部分編集を提案（search & replace）",
    "- propose_delete: ファイル削除を提案",
    "- propose_rename: ファイルのリネーム/移動を提案",
    "- propose_create_directory: ディレクトリ作成を提案",
    "",
    "## 必須ルール",
    "- build 実行はしない（ユーザーがボタンで実行する）",
    "- 変更は全て propose_* で提案のみ。自動適用はしない",
    "- 変更前に必ず read_file / read_files で現状を確認する",
    "- .tex64 / node_modules / Resources は触らない",
    "- 大きな変更は propose_patch で部分編集を優先する",
    "",
    "## ワークスペース",
    `- Root: ${rootPath}`,
    `- Active file: ${activeFilePath || "(none)"}`,
    "",
    "必要に応じてファイルを読み、変更は提案してください。",
  ].join("\n");
};

class AgentService {
  constructor({
    workspace,
    searchService,
    ensureUserSettings,
    sendToRenderer,
    updateWorkspaceIfNeeded,
    requestIndex,
  }) {
    this.workspace = workspace;
    this.searchService = searchService;
    this.ensureUserSettings = ensureUserSettings;
    this.sendToRenderer = sendToRenderer;
    this.updateWorkspaceIfNeeded = updateWorkspaceIfNeeded;
    this.requestIndex = requestIndex;
    this.conversations = new Map();
    this.proposals = new Map();
    this.abortController = null;
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
  }

  abort() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
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
      } else if (type === "mkdir") {
        const resolved = this.workspace.resolvePath(proposal.path);
        await fsp.mkdir(resolved, { recursive: true });
      } else {
        // write or patch
        const resolved = this.workspace.resolvePath(proposal.path);
        await fsp.mkdir(path.dirname(resolved), { recursive: true });
        await this.workspace.writeFile(proposal.path, proposal.content);
      }
      
      await this.updateWorkspaceIfNeeded(rootPath, true);
      this.requestIndex(rootPath);
      this.proposals.delete(proposalId);
      this.sendToRenderer("agent:applyResult", { proposalId, ok: true });
    } catch (error) {
      this.sendToRenderer("agent:applyResult", {
        proposalId,
        ok: false,
        error: error?.message ?? "操作に失敗しました。",
      });
    }
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

      if (name === "list_files") {
        const directory = normalizePath(args.directory);
        const files = await this.workspace.listFiles();
        const filtered = directory
          ? files.filter((file) => normalizePath(file).startsWith(directory))
          : files;
        return { files: filtered };
      }

      if (name === "read_file") {
        const targetPath = normalizePath(args.path);
        if (!targetPath) {
          return { error: "path が空です。" };
        }
        if (isBlockedPath(targetPath)) {
          return { error: "対象パスは読み取り禁止です。" };
        }
        if (!isTextExtension(targetPath)) {
          return { error: "テキストファイルのみ読み取れます。" };
        }
        const resolved = this.workspace.resolvePath(targetPath);
        const stat = await fsp.stat(resolved).catch(() => null);
        if (!stat || !stat.isFile()) {
          return { error: "ファイルが見つかりません。" };
        }
        if (stat.size > MAX_FILE_BYTES) {
          return { error: "ファイルが大きすぎます。" };
        }
        const content = await this.workspace.readFile(targetPath);
        return { content };
      }

      if (name === "read_files") {
        const paths = Array.isArray(args.paths) ? args.paths : [];
        if (paths.length === 0) {
          return { error: "paths が空です。" };
        }
        if (paths.length > 10) {
          return { error: "一度に読み取れるファイルは10個までです。" };
        }
        const results = {};
        for (const p of paths) {
          const targetPath = normalizePath(p);
          if (!targetPath || isBlockedPath(targetPath) || !isTextExtension(targetPath)) {
            results[p] = { error: "読み取り不可" };
            continue;
          }
          try {
            const resolved = this.workspace.resolvePath(targetPath);
            const stat = await fsp.stat(resolved).catch(() => null);
            if (!stat || !stat.isFile() || stat.size > MAX_FILE_BYTES) {
              results[p] = { error: "ファイルが見つからないか大きすぎます" };
              continue;
            }
            const content = await this.workspace.readFile(targetPath);
            results[p] = { content };
          } catch {
            results[p] = { error: "読み取りエラー" };
          }
        }
        return { files: results };
      }

      if (name === "search_files") {
        const query = typeof args.query === "string" ? args.query : "";
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        const results = await this.searchService.search(rootPath, query);
        return { results };
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
          const result = [];
          for (const entry of entries) {
            if (BLOCKED_TOP_LEVEL.has(entry.name) || entry.name.startsWith(".")) continue;
            if (entry.isDirectory()) {
              const children = await buildTree(path.join(dir, entry.name), depth + 1);
              result.push({ name: entry.name, type: "dir", children: children || [] });
            } else {
              result.push({ name: entry.name, type: "file" });
            }
          }
          return result;
        };
        const tree = await buildTree(rootPath, 1);
        return { structure: tree };
      }

      if (name === "propose_write") {
        const targetPath = normalizePath(args.path);
        const content = typeof args.content === "string" ? args.content : "";
        const summary = typeof args.summary === "string" ? args.summary : "";
        if (!targetPath) {
          return { error: "path が空です。" };
        }
        if (isBlockedPath(targetPath)) {
          return { error: "対象パスは書き込み禁止です。" };
        }
        if (!isTextExtension(targetPath)) {
          return { error: "テキストファイルのみ書き込み可能です。" };
        }
        if (content.length > MAX_FILE_BYTES) {
          return { error: "内容が大きすぎます。" };
        }
        let originalContent = "";
        let isNewFile = true;
        try {
          originalContent = await this.workspace.readFile(targetPath);
          isNewFile = false;
        } catch {
          originalContent = "";
          isNewFile = true;
        }
        const id =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const proposal = {
          id,
          type: "write",
          path: targetPath,
          content,
          originalContent,
          summary,
          isNewFile,
          conversationId,
        };
        this.proposals.set(id, proposal);
        this.sendToRenderer("agent:proposal", { proposal });
        return { status: "proposed", proposalId: id };
      }

      if (name === "propose_patch") {
        const targetPath = normalizePath(args.path);
        const search = typeof args.search === "string" ? args.search : "";
        const replace = typeof args.replace === "string" ? args.replace : "";
        const summary = typeof args.summary === "string" ? args.summary : "";
        if (!targetPath || !search) {
          return { error: "path と search は必須です。" };
        }
        if (isBlockedPath(targetPath)) {
          return { error: "対象パスは編集禁止です。" };
        }
        let originalContent = "";
        try {
          originalContent = await this.workspace.readFile(targetPath);
        } catch {
          return { error: "ファイルが見つかりません。" };
        }
        if (!originalContent.includes(search)) {
          return { error: "検索文字列がファイル内に見つかりません。" };
        }
        const newContent = originalContent.replace(search, replace);
        const id =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const proposal = {
          id,
          type: "patch",
          path: targetPath,
          content: newContent,
          originalContent,
          summary: summary || `"${search.slice(0, 20)}..." → "${replace.slice(0, 20)}..."`,
          isNewFile: false,
          conversationId,
        };
        this.proposals.set(id, proposal);
        this.sendToRenderer("agent:proposal", { proposal });
        return { status: "proposed", proposalId: id };
      }

      if (name === "propose_delete") {
        const targetPath = normalizePath(args.path);
        const summary = typeof args.summary === "string" ? args.summary : "ファイル削除";
        if (!targetPath) {
          return { error: "path が空です。" };
        }
        if (isBlockedPath(targetPath)) {
          return { error: "対象パスは削除禁止です。" };
        }
        const resolved = this.workspace.resolvePath(targetPath);
        const stat = await fsp.stat(resolved).catch(() => null);
        if (!stat || !stat.isFile()) {
          return { error: "ファイルが見つかりません。" };
        }
        const originalContent = await this.workspace.readFile(targetPath).catch(() => "");
        const id =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const proposal = {
          id,
          type: "delete",
          path: targetPath,
          content: "",
          originalContent,
          summary,
          isNewFile: false,
          conversationId,
        };
        this.proposals.set(id, proposal);
        this.sendToRenderer("agent:proposal", { proposal });
        return { status: "proposed", proposalId: id };
      }

      if (name === "propose_rename") {
        const oldPath = normalizePath(args.oldPath);
        const newPath = normalizePath(args.newPath);
        const summary = typeof args.summary === "string" ? args.summary : `${oldPath} → ${newPath}`;
        if (!oldPath || !newPath) {
          return { error: "oldPath と newPath は必須です。" };
        }
        if (isBlockedPath(oldPath) || isBlockedPath(newPath)) {
          return { error: "対象パスは操作禁止です。" };
        }
        const resolved = this.workspace.resolvePath(oldPath);
        const stat = await fsp.stat(resolved).catch(() => null);
        if (!stat || !stat.isFile()) {
          return { error: "ファイルが見つかりません。" };
        }
        const originalContent = await this.workspace.readFile(oldPath).catch(() => "");
        const id =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const proposal = {
          id,
          type: "rename",
          path: newPath,
          oldPath,
          content: originalContent,
          originalContent,
          summary,
          isNewFile: false,
          conversationId,
        };
        this.proposals.set(id, proposal);
        this.sendToRenderer("agent:proposal", { proposal });
        return { status: "proposed", proposalId: id };
      }

      if (name === "propose_create_directory") {
        const targetPath = normalizePath(args.path);
        const summary = typeof args.summary === "string" ? args.summary : "ディレクトリ作成";
        if (!targetPath) {
          return { error: "path が空です。" };
        }
        if (isBlockedPath(targetPath)) {
          return { error: "対象パスは作成禁止です。" };
        }
        const id =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const proposal = {
          id,
          type: "mkdir",
          path: targetPath,
          content: "",
          originalContent: "",
          summary,
          isNewFile: true,
          conversationId,
        };
        this.proposals.set(id, proposal);
        this.sendToRenderer("agent:proposal", { proposal });
        return { status: "proposed", proposalId: id };
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

    const settings = await this.ensureUserSettings().getAgentSettings();
    const proxyUrl = (
      typeof process.env.TEX64_AI_PROXY_URL === "string"
        ? process.env.TEX64_AI_PROXY_URL.trim()
        : ""
    ).trim();
    const resolvedProxyUrl = proxyUrl || "https://tex64.vercel.app/api/ai-chat";

    const conversation = this.buildConversation(conversationId);
    conversation.push({ role: "user", parts: [{ text: message }] });

    const systemPrompt = buildSystemPrompt(context, rootPath);
    const tools = [{ functionDeclarations: AGENT_TOOL_DECLARATIONS }];
    const generationConfig = {
      temperature: settings.temperature ?? 0.2,
      maxOutputTokens: settings.maxOutputTokens ?? 2048,
    };

    this.sendStatus("running", "AIが応答中です...", conversationId);
    this.abort();
    this.abortController = new AbortController();

    for (let i = 0; i < MAX_ITERATIONS; i += 1) {
      try {
        const response = await requestGemini({
          proxyUrl: resolvedProxyUrl,
          contents: conversation,
          systemInstruction: { parts: [{ text: systemPrompt }] },
          tools,
          toolConfig: { functionCallingConfig: { mode: "AUTO" } },
          generationConfig,
          signal: this.abortController.signal,
        });

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
            const result = await this.executeToolCall(call, conversationId);
            this.sendToRenderer("agent:tool", {
              name: call.name,
              summary: result?.error ?? "ok",
              conversationId,
            });
            conversation.push({
              role: "tool",
              parts: [
                {
                  functionResponse: {
                    name: call.name,
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
