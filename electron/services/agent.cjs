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
    "## 必須ルール",
    "- build 実行はしない（ユーザーがボタンで実行する）",
    "- 書き込みは propose_write で提案のみ。自動適用はしない",
    "- 変更前に read_file を行う",
    "- .tex64 / node_modules / Resources は触らない",
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
      const resolved = this.workspace.resolvePath(proposal.path);
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      await this.workspace.writeFile(proposal.path, proposal.content);
      await this.updateWorkspaceIfNeeded(rootPath, true);
      this.requestIndex(rootPath);
      this.proposals.delete(proposalId);
      this.sendToRenderer("agent:applyResult", { proposalId, ok: true });
    } catch (error) {
      this.sendToRenderer("agent:applyResult", {
        proposalId,
        ok: false,
        error: error?.message ?? "保存に失敗しました。",
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

      if (name === "search_files") {
        const query = typeof args.query === "string" ? args.query : "";
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        const results = await this.searchService.search(rootPath, query);
        return { results };
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
