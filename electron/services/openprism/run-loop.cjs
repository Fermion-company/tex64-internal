/**
 * Agent Run Loop — Direct OpenAI-compatible API (no LangChain).
 *
 * Architecture:
 *   1. Direct fetch to OpenAI-compatible /chat/completions endpoint
 *   2. tool_choice defaults to "auto" — LLM freely decides text vs tools
 *   3. Simple loop: call API → if tool_calls, execute → loop; if text → done
 *   4. 10 tools: read_file, list_files, write_file, apply_patch, run_command,
 *      get_compile_log, arxiv_search, arxiv_bibtex, check_environment, install_environment
 *   5. Simple system prompt (matching OpenPrism)
 *
 * API transport: fetch → tex64.com proxy → OpenAI-compatible LLM
 * Auth: JWT from platformAccess when signed in, otherwise a stable device ID
 * for the anonymous one-time allowance. TEX64_LLM_API_KEY remains an env var
 * fallback for local/private endpoints.
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
      message: "No workspace is selected.",
      conversationId: targetConversationId,
    });
    service.sendStatus("error", "No workspace is selected.", targetConversationId);
    return;
  }

  // ---- Resolve settings & policy ----
  service.sendStatus("running", "Preparing...", targetConversationId);
  const settings = await service.ensureUserSettings().getAgentSettings();
  const policy = service.resolveAgentPolicy(settings);
  const options = service.resolveAgentOptions(settings);
  service.contextByConversation.set(targetConversationId, context ?? {});

  // ---- Parse user input ----
  const userParts = normalizeUserMessageParts(message, parts);
  if (!userParts) {
    service.sendToRenderer("agent:error", {
      message: "Input is empty.",
      conversationId: targetConversationId,
    });
    service.sendStatus("error", "Input is empty.", targetConversationId);
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
  const apiUrl = normalizeChatEndpoint(llmConfig.endpoint);

  // ---- Resolve platform identity ----
  let accessToken = null;
  let deviceId = null;
  if (service.platformAccess) {
    try {
      accessToken = await service.platformAccess.refreshAccessToken(false);
    } catch {
      /* will try env var fallback */
    }
    try {
      deviceId = await service.platformAccess.ensureDeviceId();
    } catch {
      /* anonymous fallback will be unavailable */
    }
  }
  const usesPlatformProxy = /\/api\/v2\/ai\/openai\/chat\/completions$/i.test(apiUrl);
  if (!accessToken && (!deviceId || !usesPlatformProxy)) {
    const envKey =
      typeof process.env.TEX64_LLM_API_KEY === "string"
        ? process.env.TEX64_LLM_API_KEY.trim()
        : "";
    if (envKey) accessToken = envKey;
  }
  if (!accessToken && !deviceId) {
    service.sendToRenderer("agent:error", {
      message: "Axiom requires either login or a local app identity. Please restart TeX64 and try again.",
      conversationId: targetConversationId,
    });
    service.sendStatus("error", "Axiom identity unavailable", targetConversationId);
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

  service.sendStatus("running", "Thinking...", targetConversationId);

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

  try {
    // ---- Agent loop ----
    const maxIterations = options.maxIterations || 15;
    let iterations = 0;
    const toolErrorHistory = []; // Track consecutive identical errors for loop detection
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // Track write tool usage across the entire run so we can verify that
    // the final assistant message matches what actually happened. The E2E
    // test showed the LLM would report "I added the Preliminaries content"
    // after making zero tool calls. We refuse to let such hallucinated
    // success reach the user.
    const WRITE_TOOL_NAMES = new Set([
      "write_file",
      "create_file",
      "apply_patch",
      "replace_lines",
      "insert_lines",
      "delete_lines",
      "replace_section",
      "append_to_section",
      "run_command",
    ]);
    const writeToolInvocations = [];
    // Regexes matching "modification claim" phrasing in the final assistant
    // message. If we see one of these but the run made ZERO write tool
    // calls, we treat the turn as a hallucination and loop the agent back
    // with a corrective system message.
    const MODIFICATION_CLAIM_PATTERNS = [
      // English
      /\b(?:I(?:'ve| have)?|I'll|let me|i just)\s+(?:added|inserted|updated|modified|changed|created|wrote|filled(?:\s+in)?|replaced|removed|deleted|fixed|refactored|renamed|rewrote|expanded|appended)\b/i,
      /\b(?:added|inserted|updated|modified|changed|created|wrote|filled(?:\s+in)?|replaced|removed|deleted|fixed|rewrote|expanded|appended)\s+(?:the|a|an)\b/i,
      /\b(?:has been|have been)\s+(?:added|inserted|updated|modified|changed|created|written|filled(?:\s+in)?|replaced|removed|deleted|fixed|rewrote|expanded|appended)\b/i,
      // Japanese
      /(?:追加|挿入|更新|変更|作成|書[きい]|記述|修正|置換|削除|リファクタ|名称?変更|書き換え|書き加え|埋め)(?:しました|されました|ました|した)/,
      /(?:しました|されました|ました|した)\b/,
      // Chinese (Simplified) — past-tense action confirmations: 已 + verb, 完成
      /已(?:添加|新增|插入|更新|修改|更改|创建|写入|编写|替换|移除|删除|修复|重构|重命名|改名|重写|扩展|追加|应用|完成)/,
      /(?:添加|新增|插入|更新|修改|更改|创建|写入|编写|替换|移除|删除|修复|重构|重命名|改名|重写|扩展|追加|应用)了/,
      // Korean — completed-action endings on common edit verbs
      /(?:추가|삽입|갱신|업데이트|수정|변경|생성|작성|기록|교체|치환|제거|삭제|수정|리팩터링|이름\s?변경|개명|재작성|확장|추가\s?작성|적용|완료)(?:했(?:습니다|어요|다)|됐(?:습니다|어요|다)|되었(?:습니다|어요|다)|했음|함)/,
      // German — Ich habe ... ge<verb>; X wurde/wurden ge<verb>
      /\bIch\s+(?:habe|hab)\b[\s\S]{0,80}?\b(?:hinzugefügt|eingefügt|aktualisiert|geändert|modifiziert|erstellt|geschrieben|ersetzt|entfernt|gelöscht|behoben|umbenannt|umgeschrieben|erweitert|angehängt|angewendet)\b/i,
      /\b(?:wurde|wurden|ist|sind)\s+(?:hinzugefügt|eingefügt|aktualisiert|geändert|modifiziert|erstellt|geschrieben|ersetzt|entfernt|gelöscht|behoben|umbenannt|umgeschrieben|erweitert|angehängt|angewendet)\b/i,
      // French — J'ai ... <verbe>; X a été <verbe>
      // (Trailing \b dropped: most past participles end in `é` which is not in
      // ASCII \w, so \b fails. Using \p{L} lookahead with the `u` flag instead.)
      /\bJ['’]ai\b[\s\S]{0,80}?(?:ajouté|inséré|mis\s+à\s+jour|modifié|changé|créé|écrit|rempli|remplacé|retiré|supprimé|corrigé|refactorisé|renommé|réécrit|étendu|appliqué)(?!\p{L})/iu,
      /\b(?:a|ont)\s+été\s+(?:ajouté|inséré|mis\s+à\s+jour|modifié|changé|créé|écrit|rempli|remplacé|retiré|supprimé|corrigé|refactorisé|renommé|réécrit|étendu|appliqué)e?s?(?!\p{L})/iu,
      // Spanish — He ... <verbo>; X ha sido / se ha <verbo>
      /\bHe\b[\s\S]{0,80}?\b(?:añadido|agregado|insertado|actualizado|modificado|cambiado|creado|escrito|rellenado|reemplazado|eliminado|borrado|corregido|refactorizado|renombrado|reescrito|ampliado|aplicado)\b/i,
      /\b(?:ha\s+sido|han\s+sido|se\s+ha|se\s+han)\s+(?:añadido|agregado|insertado|actualizado|modificado|cambiado|creado|escrito|rellenado|reemplazado|eliminado|borrado|corregido|refactorizado|renombrado|reescrito|ampliado|aplicado)s?\b/i,
    ];
    let halluciationRetryCount = 0;
    const MAX_HALLUCINATION_RETRIES = 2;

    while (iterations < maxIterations) {
      if (!isCurrentRun()) return;
      iterations += 1;

      // ---- Call OpenAI-compatible API (streaming, with retry for transient errors) ----
      let response;
      const maxRetries = 3;
      const MAX_RETRY_AFTER_SEC = 60; // Give up if server asks to wait longer than this
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (!isCurrentRun()) return;
        response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken ? { "Authorization": `Bearer ${accessToken}` } : {}),
            ...(deviceId ? { "X-Tex64-Device-Id": deviceId } : {}),
          },
          body: JSON.stringify({
            model: llmConfig.model,
            messages,
            tools: toolDefinitions,
            stream: true,
            stream_options: { include_usage: true },
            ...(typeof llmConfig.temperature === "number" ? { temperature: llmConfig.temperature } : {}),
          }),
          signal: run.controller.signal,
        });

        if (response.ok) break;

        const errorText = await response.text().catch(() => "");
        const status = response.status;
        console.error(`[run-loop] API error ${status} (attempt ${attempt}/${maxRetries}): ${errorText.slice(0, 500)}`);

        // Parse server-provided Retry-After (header or JSON body's retryAfterSec)
        let retryAfterSec = null;
        const retryAfterHeader = response.headers.get("retry-after");
        if (retryAfterHeader) {
          const parsed = Number(retryAfterHeader);
          if (Number.isFinite(parsed) && parsed >= 0) {
            retryAfterSec = parsed;
          }
        }
        if (retryAfterSec === null && errorText) {
          try {
            const body = JSON.parse(errorText);
            const bodyRetry = body?.error?.retryAfterSec ?? body?.retryAfterSec;
            if (Number.isFinite(bodyRetry) && bodyRetry >= 0) {
              retryAfterSec = bodyRetry;
            }
          } catch { /* not JSON, ignore */ }
        }

        // If server asks to wait too long (e.g. monthly quota reset), don't retry — surface clearly
        if (status === 429 && retryAfterSec !== null && retryAfterSec > MAX_RETRY_AFTER_SEC) {
          const hours = Math.ceil(retryAfterSec / 3600);
          throw new Error(
            `Rate limit / quota exhausted. Retry after ~${hours}h. ` +
            `Server response: ${errorText.slice(0, 300)}`
          );
        }

        // Retry on 429 (rate limit) or 5xx (server error), but not on 4xx client errors
        if ((status === 429 || status >= 500) && attempt < maxRetries) {
          // Prefer server-provided Retry-After, else fall back to linear backoff
          const fallbackMs = status === 429 ? 5000 * attempt : 2000 * attempt;
          const backoffMs =
            retryAfterSec !== null ? Math.max(1000, retryAfterSec * 1000) : fallbackMs;
          console.log(`[run-loop] Retrying in ${backoffMs}ms (Retry-After=${retryAfterSec ?? "none"})...`);
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

            // Capture usage from final SSE chunk (stream_options: include_usage)
            if (chunk.usage) {
              totalPromptTokens += chunk.usage.prompt_tokens || 0;
              totalCompletionTokens += chunk.usage.completion_tokens || 0;
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
        if (data.usage) {
          totalPromptTokens += data.usage.prompt_tokens || 0;
          totalCompletionTokens += data.usage.completion_tokens || 0;
        }
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

        // ---- Claim verification ----
        // If the assistant's final message claims a modification but the
        // agent made zero write tool calls during the ENTIRE run, this is
        // a hallucinated success. Reject it and loop back with a corrective
        // system reminder (up to MAX_HALLUCINATION_RETRIES times).
        const claimsModification = MODIFICATION_CLAIM_PATTERNS.some((re) => re.test(reply));
        const madeAnyWrite = writeToolInvocations.length > 0;
        if (
          claimsModification &&
          !madeAnyWrite &&
          halluciationRetryCount < MAX_HALLUCINATION_RETRIES
        ) {
          halluciationRetryCount += 1;
          console.warn(
            `[run-loop] Hallucination detected — message claims a modification but zero write tools were called. ` +
              `Injecting corrective reminder (retry ${halluciationRetryCount}/${MAX_HALLUCINATION_RETRIES}).`
          );
          messages.push({
            role: "user",
            content:
              "SYSTEM: Your last response claims you made a change, but you did not " +
              "actually call any file-editing tool (write_file, replace_lines, " +
              "insert_lines, delete_lines, replace_section, append_to_section, " +
              "apply_patch, or create_file). You MUST call the appropriate tool to " +
              "make the change, then verify by re-reading the file. Do not claim " +
              "success without a real tool call. Retry the user's request now.",
          });
          // Reset streaming buffers and fall through to next iteration
          continue;
        }

        // Store AI response in conversation
        conversation.push({ role: "assistant", content: reply });
        service.markSessionDirty(targetConversationId);

        // Send final message (finalizes streaming element on frontend)
        service.sendToRenderer("agent:message", {
          text: reply || "Done.",
          conversationId: targetConversationId,
        });
        service.sendStatus("idle", "Waiting", targetConversationId);
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

        // Track successful write-tool invocations for claim verification
        if (!isError && WRITE_TOOL_NAMES.has(fnName)) {
          writeToolInvocations.push({ name: fnName });
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
              "You MUST try a different approach. If apply_patch keeps failing, use write_file instead " +
              "with the full desired file content. Do NOT retry the same failing tool call.",
          });
          toolErrorHistory.length = 0; // Reset to avoid re-triggering
        }
      }

      // Loop continues — next iteration will call API again with tool results
    }

    // ---- Max iterations reached ----
    const reply = `Reached the processing limit (${iterations} iterations). You can send another message to continue.`;
    conversation.push({ role: "assistant", content: reply });
    service.markSessionDirty(targetConversationId);
    service.sendToRenderer("agent:message", {
      text: reply,
      conversationId: targetConversationId,
    });
    service.sendStatus("resumable", "Paused", targetConversationId);
  } catch (error) {
    if (error?.name === "AbortError" || run.controller.signal.aborted) {
      if (isCurrentRun()) {
        service.sendStatus("idle", "Aborted.", targetConversationId);
      }
      return;
    }
    const errMsg = error?.message ?? "Failed to get response.";
    service.sendToRenderer("agent:error", {
      message: errMsg,
      conversationId: targetConversationId,
    });
    service.sendStatus("error", "An error has occurred", targetConversationId);
  } finally {
    service.finishConversationRun(targetConversationId, run.token);
    service.markSessionDirty(targetConversationId);

    // Record local usage tracking
    if (totalPromptTokens > 0 || totalCompletionTokens > 0) {
      try {
        if (service.apiUsageService && typeof service.apiUsageService.recordUsage === "function") {
          await service.apiUsageService.recordUsage({
            model: llmConfig.model,
            promptTokens: totalPromptTokens,
            outputTokens: totalCompletionTokens,
            totalTokens: totalPromptTokens + totalCompletionTokens,
            source: "agent",
          });
        }
      } catch { /* usage tracking is best-effort */ }
    }
  }
};

module.exports = { runAgentConversation };
