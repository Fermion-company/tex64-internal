const fsp = require("fs/promises");
const path = require("path");
const { AGENT_TOOL_DECLARATIONS } = require("./agent-tools.cjs");
const { requestGemini } = require("./agent-llm.cjs");
const { normalizeUserMessageParts } = require("./agent-message-parts.cjs");
const {
  clipText, digestJson,
  extractTextFromParts, findLastTopicResetIndex,
  summarizeToolArgs, summarizeToolResult, TOOL_STATUS_LABELS,
} = require("./agent-core-utils.cjs");
const {
  buildSystemPrompt,
  resolveResponseModel,
} = require("./agent-prompt-utils.cjs");

const runAgentConversation = async (service, { message, parts, context, conversationId = "default" }) => {
  await service.ensureSessionsRestored();
  const targetConversationId =
    typeof conversationId === "string" && conversationId.trim()
      ? conversationId.trim()
      : "default";
  const rootPath = service.workspace.getRootPath();
  if (!rootPath) {
    service.sendToRenderer("agent:error", {
      message: "ワークスペースが選択されていません。",
      conversationId: targetConversationId,
    });
    service.sendStatus("error", "ワークスペースが未選択です。", targetConversationId);
    return;
  }

  service.sendStatus("running", service.buildProgressMessage("準備中"), targetConversationId);
  const settings = await service.ensureUserSettings().getAgentSettings();
  const chatModel = service.resolveChatModel(settings);
  const maxOutputTokens = service.resolveMaxOutputTokens(settings);
  const policy = service.resolveAgentPolicy(settings);
  const options = service.resolveAgentOptions(settings);
  service.contextByConversation.set(targetConversationId, context ?? {});
  const proxyUrl = (
    typeof process.env.TEX64_AI_PROXY_URL === "string"
      ? process.env.TEX64_AI_PROXY_URL.trim()
      : ""
  ).trim();
  const resolvedProxyUrl = proxyUrl || "https://tex64.vercel.app/api/ai-chat";

  const userParts = normalizeUserMessageParts(message, parts);
  if (!userParts) {
    service.sendToRenderer("agent:error", {
      message: "入力が空です。",
      conversationId: targetConversationId,
    });
    service.sendStatus("error", "入力が空です。", targetConversationId);
    return;
  }

  const conversation = service.buildConversation(targetConversationId);
  // Inject active file content into the first user message so Gemini sees it
  // in the conversation (not just system prompt). Gemini weights user-turn
  // content more heavily than system instructions, so this prevents the model
  // from ignoring the open document and asking clarifying questions instead.
  let enrichedUserParts = userParts;
  if (
    conversation.length === 0 &&
    typeof context?.activeFileContent === "string" &&
    context.activeFileContent.trim()
  ) {
    const pathLabel =
      typeof context?.activeFilePath === "string" && context.activeFilePath
        ? context.activeFilePath
        : "unknown";
    const truncNote =
      context?.activeFileContentTruncated && typeof context?.activeFileContentLength === "number"
        ? `（先頭${context.activeFileContent.length}文字/全${context.activeFileContentLength}文字）`
        : "";
    const fileCtxText = `[エディタで開いているファイル: ${pathLabel}${truncNote}]\n\`\`\`\n${context.activeFileContent}\n\`\`\`\n`;
    enrichedUserParts = [{ text: fileCtxText }, ...(Array.isArray(userParts) ? userParts : [userParts])];
  }
  conversation.push({ role: "user", parts: enrichedUserParts });
  service.workspaceRootByConversation.set(targetConversationId, rootPath);
  service.markSessionDirty(targetConversationId);

  const userText = extractTextFromParts(userParts);
  const rootFileInfo = await service.workspace.rootInfo().catch(() => null);

  const projectInstructions = await fsp
    .readFile(path.join(rootPath, ".tex64", "agent-instructions.md"), "utf8")
    .catch(() => null);

  const agentMemory = await fsp
    .readFile(path.join(rootPath, ".tex64", "agent-memory.md"), "utf8")
    .catch(() => null);

  const systemPrompt = buildSystemPrompt(context, rootPath, policy, options, {
    rootFileInfo,
    scratchpad: service.scratchpadByConversation.get(targetConversationId) ?? "",
    projectInstructions,
    agentMemory,
  });
  const functionDeclarations =
    options.allowRunCommand === true
      ? AGENT_TOOL_DECLARATIONS
      : AGENT_TOOL_DECLARATIONS.filter((entry) => entry?.name !== "run_command");
  const tools = [{ functionDeclarations }];
  const baseTemperature = typeof settings?.temperature === "number" && Number.isFinite(settings.temperature)
    ? Math.min(2, Math.max(0, settings.temperature))
    : 1.0;
  const generationConfig = {
    temperature: baseTemperature,
    maxOutputTokens,
  };

  service.sendStatus("running", service.buildProgressMessage("文脈整理中"), targetConversationId);
  const run = service.startConversationRun(targetConversationId);
  let exitReason = "unknown";
  let exitError = null;

  const userInlineParts = Array.isArray(userParts)
    ? userParts.filter((part) => part && typeof part === "object" && part.inlineData)
    : [];
  const inlineBytesApprox = userInlineParts.reduce((sum, part) => {
    const data = typeof part?.inlineData?.data === "string" ? part.inlineData.data : "";
    return sum + Math.round(data.length * 0.75);
  }, 0);
  service.emitAuditEvent(
    "run_start",
    {
      workspaceRoot: rootPath,
      model: chatModel,
      resolvedProxyUrl,
      toolCount: functionDeclarations.length,
      systemPromptChars: systemPrompt.length,
      options,
      temperature: baseTemperature,
      policy: {
        maxFileBytes: policy?.maxFileBytes ?? null,
        maxReadFiles: policy?.maxReadFiles ?? null,
        blockedTopLevelCount: policy?.blockedTopLevel?.size ?? null,
        allowedTopLevelCount: policy?.allowedTopLevel?.size ?? null,
      },
      user: {
        textPreview: clipText(userText, 400),
        inlineDataCount: userInlineParts.length,
        inlineBytesApprox,
      },
    },
    targetConversationId,
    run.token
  );

  const isCurrentRun = () => service.isRunCurrent(targetConversationId, run.token);
  const callAiChat = async (payload, signal, onDelta) => {
    if (service.requestAiChat) {
      return service.requestAiChat(
        {
          ...payload,
          stream: Boolean(onDelta),
        },
        { signal, onDelta }
      );
    }
    return requestGemini({
      proxyUrl: resolvedProxyUrl,
      model: payload.model,
      contents: payload.contents,
      systemInstruction: payload.systemInstruction,
      tools: payload.tools,
      toolConfig: payload.toolConfig,
      generationConfig: payload.generationConfig,
      signal,
      onDelta,
    });
  };

  const maxIterations = options.maxIterations;
  const declaredToolNames = new Set(
    Array.isArray(functionDeclarations)
      ? functionDeclarations
          .map((entry) => (typeof entry?.name === "string" ? entry.name.trim() : ""))
          .filter(Boolean)
      : []
  );
  // mode:"ANY" forces Gemini to always call a tool — never output plain text.
  // The agent communicates with the user exclusively via finish_task().
  const FINISH_TASK_TOOL = "finish_task";
  const toolConfigAny = { functionCallingConfig: { mode: "ANY" } };
  const appliedEditToolNames = new Set([
    "rename_latex_symbol",
    "write_file",
    "patch_file",
    "replace_lines",
    "delete_file",
    "rename_file",
    "create_directory",
    "propose_write",
    "propose_patch",
    "propose_delete",
    "propose_rename",
    "propose_create_directory",
  ]);
  let editedSinceLastBuild = false;
  let lastBuildStatus = null;
  let lastBuildFailureSummary = null;
  let lastBuildFailureIssues = null;
  let recoveryPromptCount = 0;
  let forceBuildCount = 0;
  const canRunBuild = declaredToolNames.has("run_build");
  const maxRecoveryPromptCount = Math.min(3, Math.max(1, Math.round(maxIterations / 50)));
  const wasAppliedEdit = (toolName, result) => {
    if (!appliedEditToolNames.has(toolName)) {
      return false;
    }
    if (!result || typeof result !== "object") {
      return false;
    }
    if (result.error) {
      return false;
    }
    if (result.apply && typeof result.apply === "object") {
      return result.apply.ok === true;
    }
    const status = typeof result.status === "string" ? result.status : "";
    if (status === "applied" || status === "partially_applied" || status === "success") {
      return true;
    }
    const files = Array.isArray(result.files) ? result.files : [];
    return files.some((entry) => entry && entry.ok === true);
  };
  const updateLoopStateFromToolResult = (toolName, result) => {
    const applyBuildResult = (buildResult) => {
      const status = typeof buildResult?.status === "string" ? buildResult.status : null;
      if (!status) {
        return;
      }
      lastBuildStatus = status;
      forceBuildCount += 1;
      // A build has been attempted for the current working tree.
      editedSinceLastBuild = false;
      if (status === "failure") {
        lastBuildFailureSummary =
          typeof buildResult?.summary === "string" && buildResult.summary.trim()
            ? clipText(buildResult.summary, 600)
            : null;
        lastBuildFailureIssues = Array.isArray(buildResult?.issues) ? buildResult.issues : [];
        return;
      }
      lastBuildFailureSummary = null;
      lastBuildFailureIssues = null;
    };

    if (wasAppliedEdit(toolName, result)) {
      editedSinceLastBuild = true;
      forceBuildCount = 0;
    }
    const autoBuildStatus =
      typeof result?.autoBuild?.status === "string" ? result.autoBuild.status : null;
    if (autoBuildStatus) {
      applyBuildResult(result.autoBuild);
    }
    if (toolName === "run_build") {
      applyBuildResult(result);
    }
  };

  const buildRequestConversationForTurn = () => {
    const source = Array.isArray(conversation) ? conversation : [];
    if (source.length === 0) return [];
    const resetIndex = findLastTopicResetIndex(source);
    const afterReset = resetIndex >= 0 ? source.slice(resetIndex + 1) : source;
    return afterReset.filter((entry) => entry && typeof entry === "object");
  };
  const READ_ONLY_TOOL_NAMES = new Set([
    "list_files",
    "read_file",
    "read_files",
    "search_files",
    "search_web",
    "read_url",
    "get_project_structure",
    "get_index",
    "read_scratchpad",
    "get_app_settings",
    "read_terminal_output",
  ]);
  const MAX_PARALLEL_READONLY_TOOL_CALLS = 6;

  const executeToolCallWithAuditRaw = async (iteration, toolName, callArgs) => {
    const argsSummary = summarizeToolArgs(toolName, callArgs);
    const argsDigest = digestJson(argsSummary);
    service.emitAuditEvent(
      "tool_call",
      { iteration, toolName, argsDigest, args: argsSummary },
      targetConversationId,
      run.token
    );
    const result = await service.executeToolCall(
      { name: toolName, args: callArgs },
      targetConversationId
    );
    service.emitAuditEvent(
      "tool_result",
      { iteration, toolName, argsDigest, ...summarizeToolResult(toolName, result) },
      targetConversationId,
      run.token
    );
    return { result, argsDigest };
  };

  const recordToolResult = (toolName, result) => {
    if (!isCurrentRun()) {
      exitReason = "superseded";
      return { superseded: true };
    }
    service.sendToRenderer("agent:tool", {
      name: toolName,
      label: TOOL_STATUS_LABELS[toolName] ?? toolName,
      summary: result?.error ?? "ok",
      conversationId: targetConversationId,
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
    updateLoopStateFromToolResult(toolName, result);
    service.markSessionDirty(targetConversationId);
    return { superseded: false };
  };

  const executeToolWithAudit = async (iteration, toolName, callArgs) => {
    const raw = await executeToolCallWithAuditRaw(iteration, toolName, callArgs);
    return recordToolResult(toolName, raw.result);
  };

  const executeToolCallsFromParts = async (iteration, functionCallParts) => {
    const pendingReadOnly = [];
    const flushReadOnly = async () => {
      if (pendingReadOnly.length === 0) {
        return { superseded: false };
      }
      const batch = pendingReadOnly.splice(0, pendingReadOnly.length);
      const batchResults = await Promise.all(
        batch.map((entry) => executeToolCallWithAuditRaw(iteration, entry.toolName, entry.callArgs))
      );
      for (let index = 0; index < batch.length; index += 1) {
        const { toolName } = batch[index];
        const { result } = batchResults[index] ?? {};
        const recorded = recordToolResult(toolName, result);
        if (recorded.superseded) {
          return recorded;
        }
      }
      return { superseded: false };
    };

    for (const part of functionCallParts) {
      const call = part?.functionCall;
      const toolName = call?.name ?? "";
      let callArgs = call?.args ?? {};
      if (typeof callArgs === "string") {
        try {
          callArgs = JSON.parse(callArgs);
        } catch {
          callArgs = {};
        }
      }
      if (!callArgs || typeof callArgs !== "object") {
        callArgs = {};
      }

      const isReadOnly = READ_ONLY_TOOL_NAMES.has(toolName);
      if (isReadOnly) {
        pendingReadOnly.push({ toolName, callArgs });
        if (pendingReadOnly.length >= MAX_PARALLEL_READONLY_TOOL_CALLS) {
          const flushed = await flushReadOnly();
          if (flushed.superseded) {
            return flushed;
          }
        }
        continue;
      }

      const flushed = await flushReadOnly();
      if (flushed.superseded) {
        return flushed;
      }
      const raw = await executeToolCallWithAuditRaw(iteration, toolName, callArgs);
      const recorded = recordToolResult(toolName, raw.result);
      if (recorded.superseded) {
        return recorded;
      }
    }

    return flushReadOnly();
  };

  try {
    for (let i = 0; i < maxIterations; i += 1) {
      if (!isCurrentRun()) {
        exitReason = "superseded";
        return;
      }
      try {
        const stepLabel = `${i + 1}/${maxIterations}`;
        const thinkingLabel = i === 0 ? `方針検討中 (${stepLabel})` : `追加検討中 (${stepLabel})`;
        service.sendStatus("running", service.buildProgressMessage(thinkingLabel), targetConversationId);
        const handleDelta =
          options.stream === true
            ? (text) => {
                if (text) {
                  service.sendToRenderer("agent:messageDelta", {
                    text,
                    conversationId: targetConversationId,
                  });
                }
              }
            : null;
        const requestConversation = buildRequestConversationForTurn();
        const requestContents = service.buildRequestContents(requestConversation, i, settings);
        if (!Array.isArray(requestContents) || requestContents.length === 0) {
          throw new Error("送信可能な会話コンテキストがありません。");
        }
        const requestBytes = requestContents.reduce(
          (sum, entry) => sum + service.estimateRequestMessageSize(entry),
          0
        );
        service.emitAuditEvent(
          "model_call",
          {
            iteration: i,
            model: chatModel,
            requestMessages: requestContents.length,
            requestBytes,
          },
          targetConversationId,
          run.token
        );
        const response = await callAiChat(
          {
            model: chatModel,
            contents: requestContents,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            tools,
            toolConfig: toolConfigAny,
            generationConfig,
          },
          run.controller.signal,
          handleDelta
        );

        try {
          const usage = service.extractUsageMetadata(response);
          if (usage && service.apiUsageService) {
            const snapshot = await service.apiUsageService.recordUsage({
              model: resolveResponseModel(response) || "unknown",
              promptTokens: usage.promptTokenCount,
              outputTokens: usage.candidatesTokenCount,
              totalTokens: usage.totalTokenCount,
              source: "agent",
            });
            if (snapshot) {
              service.sendToRenderer("api:usage", { snapshot });
            }
          }
          const platformUsage = service.buildPlatformUsageFromQuota(
            response?.quota ?? response?.output?.quota ?? null,
            response?.plan ?? null,
            "chat"
          );
          if (platformUsage) {
            service.sendToRenderer("platform:usage", platformUsage);
          }
        } catch {
          // ignore usage recording failures
        }

        const candidate = service.normalizeModelCandidate(response);
        const parts = candidate?.parts ?? [];
        const functionCalls = parts.filter((part) => part.functionCall);
        const textParts = parts
          .filter((part) => !part.thought)
          .map((part) => part.text)
          .filter((text) => typeof text === "string" && text.trim().length > 0);

        // Extract and forward thought parts for visualization
        const thoughtParts = parts
          .filter((part) => part.thought === true && typeof part.text === "string" && part.text.trim())
          .map((part) => part.text.trim());
        if (thoughtParts.length > 0) {
          service.sendToRenderer("agent:thought", {
            text: thoughtParts.join("\n"),
            conversationId: targetConversationId,
          });
        }

        const usage = service.extractUsageMetadata(response);
        service.emitAuditEvent(
          "model_response",
          {
            iteration: i,
            resolvedModel: resolveResponseModel(response) || null,
            usage,
            textChars: textParts.join("\n").length,
            toolCalls: functionCalls
              .map((part) => String(part?.functionCall?.name || "").trim())
              .filter(Boolean)
              .slice(0, 10),
          },
          targetConversationId,
          run.token
        );

        if (candidate) {
          conversation.push(candidate);
          service.markSessionDirty(targetConversationId);
        }

        if (functionCalls.length > 0) {
          // finish_task is the sentinel tool the model calls to deliver its final response.
          const finishPart = functionCalls.find(
            (p) => p?.functionCall?.name === FINISH_TASK_TOOL
          );

          if (finishPart) {
            if (!isCurrentRun()) {
              exitReason = "superseded";
              return;
            }
            // Auto-build before finishing if there are unsaved edits.
            if (
              options.autoBuild === true &&
              canRunBuild &&
              editedSinceLastBuild &&
              forceBuildCount < 3
            ) {
              const execution = await executeToolWithAudit(i, "run_build", {});
              if (execution.superseded) {
                return;
              }
              // Let model respond again after seeing build result.
              continue;
            }
            // Build-failure recovery before finishing.
            if (
              canRunBuild &&
              lastBuildStatus === "failure" &&
              recoveryPromptCount < maxRecoveryPromptCount
            ) {
              recoveryPromptCount += 1;
              const issues = Array.isArray(lastBuildFailureIssues) ? lastBuildFailureIssues : [];
              const topIssues = issues
                .filter((issue) => issue && typeof issue === "object" && issue.severity === "error")
                .slice(0, 6);
              const fallbackIssues = topIssues.length > 0 ? [] : issues.slice(0, 6);
              const toLine = (issue) => {
                const p = typeof issue?.path === "string" ? issue.path : "";
                const line = typeof issue?.line === "number" ? issue.line : null;
                const column = typeof issue?.column === "number" ? issue.column : null;
                const msg = typeof issue?.message === "string" ? issue.message : "";
                const loc = p ? `${p}${line ? `:${line}${column ? `:${column}` : ""}` : ""}` : "";
                return `- ${loc ? `${loc}: ` : ""}${clipText(msg, 240)}`;
              };
              const issueLines = [...topIssues, ...fallbackIssues]
                .map(toLine)
                .filter((line) => line && line !== "- ")
                .slice(0, 6);
              const details = [];
              if (lastBuildFailureSummary) details.push(`ビルド概要: ${lastBuildFailureSummary}`);
              if (issueLines.length > 0) details.push("主なエラー:", ...issueLines);
              const detailText = details.length > 0 ? `\n\n${details.join("\n")}` : "";
              conversation.push({
                role: "user",
                parts: [{
                  text:
                    "最新ビルドが失敗しています。エラー箇所を解析して修正し、ビルドが成功するまで継続してください。" +
                    detailText,
                }],
              });
              service.markSessionDirty(targetConversationId);
              continue;
            }

            const finishArgs = finishPart.functionCall?.args ?? {};
            const finishText =
              typeof finishArgs?.message === "string" && finishArgs.message.trim()
                ? finishArgs.message.trim()
                : "完了しました。";

            exitReason = "assistant_message";
            service.emitAuditEvent(
              "assistant_message",
              { iteration: i, textChars: finishText.length, preview: clipText(finishText, 400) },
              targetConversationId,
              run.token
            );
            service.sendStatus("running", service.buildProgressMessage("回答整形中"), targetConversationId);
            service.sendToRenderer("agent:message", { text: finishText, conversationId: targetConversationId });
            service.sendStatus("idle", "待機中", targetConversationId);
            service.markSessionDirty(targetConversationId);
            return;
          }

          // All other tool calls — execute normally.
          const otherCalls = functionCalls.filter(
            (p) => p?.functionCall?.name !== FINISH_TASK_TOOL
          );
          const execution = await executeToolCallsFromParts(i, otherCalls);
          if (execution.superseded) {
            return;
          }
          continue;
        }

        // Fallback: model returned plain text (shouldn't happen with mode:ANY, but handle gracefully).
        if (textParts.length > 0) {
          const text = textParts.join("\n");
          if (!isCurrentRun()) {
            exitReason = "superseded";
            return;
          }
          exitReason = "assistant_message";
          service.emitAuditEvent(
            "assistant_message",
            { iteration: i, textChars: text.length, preview: clipText(text, 400) },
            targetConversationId,
            run.token
          );
          service.sendStatus("running", service.buildProgressMessage("回答整形中"), targetConversationId);
          service.sendToRenderer("agent:message", { text, conversationId: targetConversationId });
          service.sendStatus("idle", "待機中", targetConversationId);
          service.markSessionDirty(targetConversationId);
          return;
        }

        if (!isCurrentRun()) {
          exitReason = "superseded";
          return;
        }
        exitReason = "empty_response";
        service.emitAuditEvent(
          "assistant_message",
          { iteration: i, text: "empty" },
          targetConversationId,
          run.token
        );
        service.sendToRenderer("agent:message", {
          text: "応答が空でした。",
          conversationId: targetConversationId,
        });
        service.sendStatus("idle", "待機中", targetConversationId);
        service.markSessionDirty(targetConversationId);
        return;
      } catch (error) {
        if (error?.name === "AbortError") {
          exitReason = "aborted";
          if (service.isRunCurrent(targetConversationId, run.token)) {
            service.sendStatus("idle", "中断しました。", targetConversationId);
          }
          service.emitAuditEvent(
            "run_end",
            { reason: exitReason },
            targetConversationId,
            run.token
          );
          service.markSessionDirty(targetConversationId);
          return;
        }
        exitReason = "error";
        exitError = error?.message ?? "Axiom の呼び出しに失敗しました。";
        service.emitAuditEvent(
          "run_error",
          { iteration: i, message: clipText(exitError, 400) },
          targetConversationId,
          run.token
        );
        service.sendToRenderer("agent:error", {
          message: error?.message ?? "Axiom の呼び出しに失敗しました。",
          conversationId: targetConversationId,
        });
        service.sendStatus("error", "Axiom エラー", targetConversationId);
        service.markSessionDirty(targetConversationId);
        return;
      }
    }

    if (isCurrentRun()) {
      exitReason = "max_iterations";
      service.sendToRenderer("agent:message", {
        text: `上限回数 (${maxIterations}) に達したため一時停止しました。自動的に続行します。`,
        conversationId: targetConversationId,
      });
      service.sendStatus("resumable", "継続可能", targetConversationId);
      service.markSessionDirty(targetConversationId);
    }
  } finally {
    if (!run.controller.signal.aborted) {
      service.emitAuditEvent(
        "run_end",
        { reason: exitReason, ...(exitError ? { error: clipText(exitError, 400) } : {}) },
        targetConversationId,
        run.token
      );
    }
    service.finishConversationRun(targetConversationId, run.token);
    if (exitReason && exitReason !== "superseded") {
      service.markSessionDirty(targetConversationId);
    }
  }
};

module.exports = {
  runAgentConversation,
};
