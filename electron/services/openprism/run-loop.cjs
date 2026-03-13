/**
 * Agent Run Loop — Direct OpenAI-compatible API (no LangChain).
 *
 * Architecture:
 *   1. Direct fetch to OpenAI-compatible /chat/completions endpoint
 *   2. tool_choice defaults to "auto" — LLM freely decides text vs tools
 *   3. Simple loop: call API → if tool_calls, execute → loop; if text → done
 *   4. 7 tools: read_file, list_files, propose_patch, apply_patch,
 *      get_compile_log, arxiv_search, arxiv_bibtex
 *   5. Simple system prompt (matching OpenPrism)
 *
 * API transport: fetch → tex64.com proxy → OpenAI-compatible LLM
 * Auth: JWT from platformAccess, with TEX64_LLM_API_KEY env var fallback.
 */

"use strict";

const { buildTools } = require("./tools.cjs");
const { resolveLLMConfig, normalizeChatEndpoint } = require("./llm-config.cjs");
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

  // ---- Build LLM input with context (sent to model, NOT stored in history) ----
  const llmInputParts = [];
  if (context?.activeFilePath) {
    llmInputParts.push(`Active file: ${context.activeFilePath}`);
  }
  llmInputParts.push(`User prompt: ${userText}`);
  if (
    context?.activeSelection &&
    typeof context.activeSelection.text === "string" &&
    context.activeSelection.text.trim()
  ) {
    llmInputParts.push(`Selection:\n${context.activeSelection.text}`);
  }
  const llmInput = llmInputParts.filter(Boolean).join("\n\n");

  // ---- Build conversation history ----
  const conversation = service.buildConversation(targetConversationId);
  service.workspaceRootByConversation.set(targetConversationId, rootPath);

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

  // ---- Build tools ----
  const tools = buildTools(service, targetConversationId, policy);

  // ---- Prepare tool definitions for API (without execute) ----
  const toolDefinitions = tools.map((t) => ({
    type: t.type,
    function: t.function,
  }));

  // ---- Build tool executor map ----
  const toolExecutors = new Map();
  for (const tool of tools) {
    toolExecutors.set(tool.function.name, tool.execute);
  }

  // ---- Build system prompt ----
  const system = buildSystemPrompt(context, rootPath);

  // ---- Convert conversation history to OpenAI messages ----
  const chatHistory = [];
  for (const msg of conversation) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "user" && typeof msg.content === "string") {
      chatHistory.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant" && typeof msg.content === "string") {
      chatHistory.push({ role: "assistant", content: msg.content });
    }
  }

  // ---- Store user message in conversation (clean text only) ----
  conversation.push({ role: "user", content: userText });
  service.markSessionDirty(targetConversationId);

  // ---- Start run ----
  const run = service.startConversationRun(targetConversationId);
  const isCurrentRun = () =>
    service.isRunCurrent(targetConversationId, run.token);

  service.sendStatus("running", "⏳ 処理中", targetConversationId);

  // ---- Build the user message for LLM (with context metadata) ----
  const userContent = userImages.length > 0
    ? [{ type: "text", text: llmInput }, ...userImages]
    : llmInput;

  // ---- Assemble messages for API ----
  const messages = [
    { role: "system", content: system },
    ...chatHistory,
    { role: "user", content: userContent },
  ];

  // ---- API endpoint ----
  const apiUrl = normalizeChatEndpoint(llmConfig.endpoint);

  try {
    // ---- Agent loop ----
    const maxIterations = options.maxIterations || 15;
    let iterations = 0;
    const toolErrorHistory = []; // Track consecutive identical errors for loop detection

    while (iterations < maxIterations) {
      if (!isCurrentRun()) return;
      iterations += 1;

      // ---- Call OpenAI-compatible API (streaming, with retry for transient errors) ----
      let response;
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (!isCurrentRun()) return;
        response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: llmConfig.model,
            messages,
            tools: toolDefinitions,
            stream: true,
          }),
          signal: run.controller.signal,
        });

        if (response.ok) break;

        const errorText = await response.text().catch(() => "");
        const status = response.status;
        console.error(`[run-loop] API error ${status} (attempt ${attempt}/${maxRetries}): ${errorText.slice(0, 500)}`);

        // Retry on 429 (rate limit) or 5xx (server error), but not on 4xx client errors
        if ((status === 429 || status >= 500) && attempt < maxRetries) {
          const backoffMs = status === 429 ? 5000 * attempt : 2000 * attempt;
          console.log(`[run-loop] Retrying in ${backoffMs}ms...`);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        throw new Error(`API error ${status}: ${errorText.slice(0, 500)}`);
      }

      // ---- Parse response (SSE stream or JSON fallback) ----
      let assistantContent = "";
      const toolCallAccumulators = new Map();

      const contentType = response.headers.get("content-type") || "";
      const isSSE = contentType.includes("text/event-stream");

      if (isSSE) {
        // ---- SSE streaming path ----
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = "";

        while (true) {
          if (!isCurrentRun()) return;
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue;
            if (trimmed === "data: [DONE]") continue;
            if (!trimmed.startsWith("data: ")) continue;

            let chunk;
            try {
              chunk = JSON.parse(trimmed.slice(6));
            } catch {
              continue;
            }

            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // Text content delta
            if (delta.content) {
              assistantContent += delta.content;
              service.sendToRenderer("agent:messageDelta", {
                text: delta.content,
                conversationId: targetConversationId,
              });
            }

            // Tool call deltas
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolCallAccumulators.has(idx)) {
                  toolCallAccumulators.set(idx, {
                    id: tc.id || "",
                    name: tc.function?.name || "",
                    arguments: tc.function?.arguments || "",
                  });
                } else {
                  const acc = toolCallAccumulators.get(idx);
                  if (tc.id) acc.id = tc.id;
                  if (tc.function?.name) acc.name += tc.function.name;
                  if (tc.function?.arguments) acc.arguments += tc.function.arguments;
                }
              }
            }
          }
        }
      } else {
        // ---- JSON fallback (non-streaming response) ----
        const data = await response.json();
        const choice = data.choices?.[0];
        if (choice?.message) {
          assistantContent = choice.message.content || "";
          if (assistantContent) {
            service.sendToRenderer("agent:messageDelta", {
              text: assistantContent,
              conversationId: targetConversationId,
            });
          }
          if (choice.message.tool_calls) {
            for (let i = 0; i < choice.message.tool_calls.length; i++) {
              const tc = choice.message.tool_calls[i];
              toolCallAccumulators.set(i, {
                id: tc.id || "",
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "",
              });
            }
          }
        }
      }

      // ---- Assemble complete assistant message ----
      const toolCalls = [];
      for (const [, acc] of [...toolCallAccumulators.entries()].sort((a, b) => a[0] - b[0])) {
        toolCalls.push({
          id: acc.id,
          type: "function",
          function: { name: acc.name, arguments: acc.arguments },
        });
      }
      console.log(`[run-loop] iteration=${iterations} text=${assistantContent.length}chars toolCalls=${toolCalls.length}${toolCalls.length > 0 ? ` tools=[${toolCalls.map(t => t.function.name).join(",")}]` : ""}`);

      const assistantMessage = { role: "assistant", content: assistantContent || null };
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }
      messages.push(assistantMessage);

      // ---- If no tool calls, we're done ----
      if (toolCalls.length === 0) {
        const reply = assistantContent || "";

        // Store AI response in conversation
        conversation.push({ role: "assistant", content: reply });
        service.markSessionDirty(targetConversationId);

        // Send final message (finalizes streaming element on frontend)
        service.sendToRenderer("agent:message", {
          text: reply || "完了しました。",
          conversationId: targetConversationId,
        });
        service.sendStatus("idle", "待機中", targetConversationId);
        return;
      }

      // ---- Execute tool calls ----
      for (const toolCall of toolCalls) {
        if (!isCurrentRun()) return;

        const fnName = toolCall.function?.name;
        const executor = toolExecutors.get(fnName);
        let toolResult;

        if (!executor) {
          toolResult = JSON.stringify({ error: `Unknown tool: ${fnName}` });
        } else {
          let args = {};
          try {
            args = JSON.parse(toolCall.function.arguments || "{}");
          } catch {
            args = {};
          }
          toolResult = await executor(args);
        }

        // Add tool result to messages
        const toolResultStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResultStr,
        });

        // Track errors for repeated-failure detection
        const isError = toolResultStr.includes('"error"');
        if (isError) {
          const errorKey = `${fnName}:${toolResultStr}`;
          toolErrorHistory.push(errorKey);
        } else {
          toolErrorHistory.length = 0; // Reset on success
        }
      }

      // Detect repeated identical tool failures (same tool, same error 3+ times)
      if (toolErrorHistory.length >= 3) {
        const last3 = toolErrorHistory.slice(-3);
        if (last3[0] === last3[1] && last3[1] === last3[2]) {
          console.warn(`[run-loop] Detected repeated tool failure (3x identical). Injecting recovery hint.`);
          messages.push({
            role: "user",
            content: "SYSTEM: The same tool call has failed 3 times with the same error. " +
              "You MUST try a different approach. If apply_patch keeps failing, use propose_patch instead " +
              "with the full desired file content. Do NOT retry the same failing tool call.",
          });
          toolErrorHistory.length = 0; // Reset to avoid re-triggering
        }
      }

      // Loop continues — next iteration will call API again with tool results
    }

    // ---- Max iterations reached ----
    const reply = "最大イテレーション数に達しました。";
    conversation.push({ role: "assistant", content: reply });
    service.markSessionDirty(targetConversationId);
    service.sendToRenderer("agent:message", {
      text: reply,
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
