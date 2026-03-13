/**
 * Agent Run Loop — OpenPrism architecture (AgentExecutor).
 *
 * Architecture (matching OpenPrism's agentService.js on GitHub):
 *   1. createOpenAIToolsAgent + AgentExecutor (framework-managed loop)
 *   2. No finish_task — agent finishes when LLM returns text without tool calls
 *   3. No tool_choice:"required" — uses LangChain default (auto)
 *   4. 7 tools: read_file, list_files, propose_patch, apply_patch,
 *      get_compile_log, arxiv_search, arxiv_bibtex
 *   5. Simple system prompt (matching OpenPrism)
 *   6. ChatPromptTemplate with chat_history + agent_scratchpad
 *
 * API transport: ChatOpenAI -> tex64.com proxy -> OpenAI-compatible LLM
 * Auth: JWT from platformAccess, with TEX64_LLM_API_KEY env var fallback.
 */

"use strict";

const { loadModules } = require("./esm-bridge.cjs");
const { buildTools } = require("./tools.cjs");
const {
  resolveLLMConfig,
  normalizeChatEndpoint,
  normalizeBaseURL,
} = require("./llm-config.cjs");
const { normalizeUserMessageParts } = require("../agent-message-parts.cjs");
const { extractTextFromParts } = require("../agent-core-utils.cjs");
const { buildSystemPrompt } = require("../agent-prompt-utils.cjs");

const runAgentConversation = async (
  service,
  { message, parts, context, conversationId = "default" },
) => {
  const targetConversationId =
    typeof conversationId === "string" && conversationId.trim()
      ? conversationId.trim()
      : "default";

  // ---- Validate workspace ----
  const rootPath = service.workspace.getRootPath();
  if (!rootPath) {
    service.sendToRenderer("agent:error", {
      message: "ワークスペースが選択されていません。",
      conversationId: targetConversationId,
    });
    service.sendStatus("error", "ワークスペースが未選択です。", targetConversationId);
    return;
  }

  // ---- Resolve settings & policy ----
  service.sendStatus("running", "⏳ 準備中", targetConversationId);
  const settings = await service.ensureUserSettings().getAgentSettings();
  const policy = service.resolveAgentPolicy(settings);
  const options = service.resolveAgentOptions(settings);
  service.contextByConversation.set(targetConversationId, context ?? {});

  // ---- Parse user input ----
  const userParts = normalizeUserMessageParts(message, parts);
  if (!userParts) {
    service.sendToRenderer("agent:error", {
      message: "入力が空です。",
      conversationId: targetConversationId,
    });
    service.sendStatus("error", "入力が空です。", targetConversationId);
    return;
  }
  const userText = extractTextFromParts(userParts);
  const userImages = userParts
    .filter((p) => p?.inlineData?.mimeType?.startsWith("image/") && p?.inlineData?.data)
    .map((p) => ({
      type: "image_url",
      image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` },
    }));

  // ---- Build user input (matching OpenPrism's userInput construction) ----
  const inputParts = [];
  if (context?.activeFilePath) {
    inputParts.push(`Active file: ${context.activeFilePath}`);
  }
  inputParts.push(`User prompt: ${userText}`);
  if (
    context?.activeSelection &&
    typeof context.activeSelection.text === "string" &&
    context.activeSelection.text.trim()
  ) {
    inputParts.push(`Selection:\n${context.activeSelection.text}`);
  }
  const input = inputParts.filter(Boolean).join("\n\n");

  // ---- Build conversation history ----
  const conversation = service.buildConversation(targetConversationId);
  service.workspaceRootByConversation.set(targetConversationId, rootPath);

  // ---- Load ESM modules ----
  const modules = await loadModules();

  // ---- Resolve LLM config ----
  const llmConfig = resolveLLMConfig(settings);

  // ---- Get access token ----
  let accessToken = null;
  if (service.platformAccess) {
    try {
      accessToken = await service.platformAccess.refreshAccessToken(false);
    } catch {
      /* will try env var fallback */
    }
  }
  if (!accessToken) {
    const envKey =
      typeof process.env.TEX64_LLM_API_KEY === "string"
        ? process.env.TEX64_LLM_API_KEY.trim()
        : "";
    if (envKey) accessToken = envKey;
  }
  if (!accessToken) {
    service.sendToRenderer("agent:error", {
      message: "ログインが必要です。サインインしてから再度お試しください。",
      conversationId: targetConversationId,
    });
    service.sendStatus("error", "認証エラー", targetConversationId);
    return;
  }

  // ---- Build ChatOpenAI (matching OpenPrism's llmService.js) ----
  const baseURL = normalizeBaseURL(normalizeChatEndpoint(llmConfig.endpoint));
  const llm = new modules.ChatOpenAI({
    model: llmConfig.model,
    temperature: 0.2,
    apiKey: accessToken,
    openAIApiKey: accessToken,
    configuration: { baseURL },
  });

  // ---- Build tools (matching OpenPrism's 7 tools) ----
  const tools = buildTools(modules, service, targetConversationId, policy);

  // ---- Build system prompt (matching OpenPrism) ----
  const system = buildSystemPrompt(context, rootPath);

  // ---- Build prompt template ----
  // Uses MessagesPlaceholder for user_input to support multimodal (text + image).
  const promptTemplate = modules.ChatPromptTemplate.fromMessages([
    ["system", system],
    new modules.MessagesPlaceholder("chat_history"),
    new modules.MessagesPlaceholder("user_input"),
    new modules.MessagesPlaceholder("agent_scratchpad"),
  ]);

  // ---- Create agent and executor (matching OpenPrism) ----
  const agent = await modules.createOpenAIToolsAgent({
    llm,
    tools,
    prompt: promptTemplate,
    streamRunnable: false, // Required: prevents output parser crash
  });
  const executor = new modules.AgentExecutor({
    agent,
    tools,
    maxIterations: options.maxIterations,
  });

  // ---- Convert conversation history to LangChain messages ----
  const chatHistory = [];
  for (const msg of conversation) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "user") {
      chatHistory.push(
        new modules.HumanMessage(
          typeof msg.content === "string" ? msg.content : "",
        ),
      );
    } else if (msg.role === "assistant") {
      chatHistory.push(
        new modules.AIMessage(
          typeof msg.content === "string" ? msg.content : "",
        ),
      );
    }
  }

  // ---- Store user message in conversation ----
  conversation.push({ role: "user", content: input });
  service.markSessionDirty(targetConversationId);

  // ---- Start run ----
  const run = service.startConversationRun(targetConversationId);
  const isCurrentRun = () =>
    service.isRunCurrent(targetConversationId, run.token);

  service.sendStatus("running", "⏳ 処理中", targetConversationId);

  // ---- Build multimodal user message ----
  const userContent = [{ type: "text", text: input }];
  if (userImages.length > 0) {
    userContent.push(...userImages);
  }
  const userMessage = new modules.HumanMessage({ content: userContent });

  try {
    // ---- Invoke AgentExecutor ----
    const result = await executor.invoke(
      { user_input: [userMessage], chat_history: chatHistory },
      { signal: run.controller.signal },
    );

    if (!isCurrentRun()) return;

    const reply = result.output || "";

    // ---- Store AI response in conversation ----
    conversation.push({ role: "assistant", content: reply });
    service.markSessionDirty(targetConversationId);

    // ---- Send to renderer ----
    service.sendToRenderer("agent:message", {
      text: reply || "完了しました。",
      conversationId: targetConversationId,
    });
    service.sendStatus("idle", "待機中", targetConversationId);
  } catch (error) {
    if (error?.name === "AbortError") {
      if (isCurrentRun()) {
        service.sendStatus("idle", "中断しました。", targetConversationId);
      }
      return;
    }
    const errMsg = error?.message ?? "LLM の呼び出しに失敗しました。";
    service.sendToRenderer("agent:error", {
      message: errMsg,
      conversationId: targetConversationId,
    });
    service.sendStatus("error", "LLM エラー", targetConversationId);
  } finally {
    service.finishConversationRun(targetConversationId, run.token);
    service.markSessionDirty(targetConversationId);
  }
};

module.exports = { runAgentConversation };
