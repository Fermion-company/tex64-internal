const { AGENT_TOOL_DECLARATIONS } = require("./agent-tools.cjs");
const { requestGemini } = require("./agent-llm.cjs");
const { handleReadFiles } = require("./agent-tools-file.cjs");
const { normalizePath } = require("./agent-policy.cjs");
const { normalizeUserMessageParts } = require("./agent-message-parts.cjs");
const {
  CAPABILITY_QUESTION_PATTERN, DEFAULT_PREFETCH_FILES_LIMIT, GREETING_ONLY_PATTERN,
  clipText, digestJson, deriveTurnRouting, deriveTurnTemperature, extractMentionedPaths,
  extractTextFromParts, findLastTopicResetIndex, normalizeWorkspaceRelativePath,
  resolvePrefetchMaxChars, summarizeToolArgs, summarizeToolResult, TOOL_STATUS_LABELS,
} = require("./agent-core-utils.cjs");
const {
  buildSmalltalkSystemPrompt, buildStandaloneQuestionSystemPrompt, buildSystemPrompt, resolveResponseModel,
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
  conversation.push({ role: "user", parts: userParts });
  service.workspaceRootByConversation.set(targetConversationId, rootPath);
  service.markSessionDirty(targetConversationId);

  const userText = extractTextFromParts(userParts);
  const referencedFileSnapshots = [];
  const referencedFileErrors = [];
  const routing = deriveTurnRouting(userText, conversation);
  const rootFileInfo = routing.useWorkspaceContext
    ? await service.workspace.rootInfo().catch(() => null)
    : null;

  let prefetchPaths = [];
  if (routing.useWorkspaceContext) {
    const explicitPaths = Array.isArray(context?.explicitContextPaths)
      ? context.explicitContextPaths.map((entry) => normalizePath(entry)).filter(Boolean)
      : [];
    const mentionedPaths = extractMentionedPaths(userText);
    const existingSnapshots = new Set();
    const hasActiveSnapshot =
      typeof context?.activeFilePath === "string" &&
      typeof context?.activeFileContent === "string" &&
      context.activeFilePath.trim().length > 0;
    if (hasActiveSnapshot) {
      const normalized = normalizeWorkspaceRelativePath(rootPath, context.activeFilePath);
      if (normalized) {
        existingSnapshots.add(normalized);
      }
    }
    const openSnapshots = Array.isArray(context?.openFileSnapshots)
      ? context.openFileSnapshots
      : [];
    openSnapshots.forEach((snapshot) => {
      if (snapshot && typeof snapshot.path === "string" && typeof snapshot.content === "string") {
        const normalized = normalizeWorkspaceRelativePath(rootPath, snapshot.path);
        if (normalized) {
          existingSnapshots.add(normalized);
        }
      }
    });
    const prefetchCandidates = [];
    const pushPrefetchPath = (value) => {
      const normalized = normalizeWorkspaceRelativePath(rootPath, value);
      if (!normalized) {
        return;
      }
      if (existingSnapshots.has(normalized)) {
        return;
      }
      if (prefetchCandidates.includes(normalized)) {
        return;
      }
      prefetchCandidates.push(normalized);
    };
    explicitPaths.forEach(pushPrefetchPath);
    mentionedPaths.forEach(pushPrefetchPath);

    // If the UI already provided an active-file snapshot and the user didn't reference
    // other files, avoid prefetching extra files to keep context small and reduce bias.
    if (!hasActiveSnapshot && prefetchCandidates.length === 0) {
      if (typeof context?.activeFilePath === "string" && context.activeFilePath.trim()) {
        pushPrefetchPath(context.activeFilePath);
      }
      if (prefetchCandidates.length === 0 && rootFileInfo?.path) {
        pushPrefetchPath(rootFileInfo.path);
      }
      if (prefetchCandidates.length === 0) {
        pushPrefetchPath("main.tex");
      }
    }

    const maxPrefetchFiles = Number.isFinite(policy?.maxReadFiles)
      ? Math.max(0, Math.min(DEFAULT_PREFETCH_FILES_LIMIT, policy.maxReadFiles))
      : DEFAULT_PREFETCH_FILES_LIMIT;
    prefetchPaths =
      maxPrefetchFiles > 0 ? prefetchCandidates.slice(0, maxPrefetchFiles) : [];
    if (prefetchPaths.length > 0) {
      const maxChars = resolvePrefetchMaxChars(settings);
      const prefetchResult = await handleReadFiles(
        service,
        { paths: prefetchPaths },
        policy,
        targetConversationId
      );
      const files =
        prefetchResult?.files && typeof prefetchResult.files === "object"
          ? prefetchResult.files
          : {};
      prefetchPaths.forEach((targetPath) => {
        const entry = files[targetPath] ?? files[targetPath.replace(/^\.\//, "")] ?? null;
        if (!entry || typeof entry !== "object") {
          referencedFileErrors.push({ path: targetPath, error: "読み取り失敗" });
          return;
        }
        if (typeof entry.error === "string" && entry.error) {
          referencedFileErrors.push({ path: targetPath, error: entry.error });
          return;
        }
        const rawContent = typeof entry.content === "string" ? entry.content : "";
        const fullLength = rawContent.length;
        let content = rawContent;
        let partial = Boolean(entry.partial);
        if (Number.isFinite(maxChars) && fullLength > maxChars) {
          content = rawContent.slice(0, maxChars);
          partial = true;
        }
        referencedFileSnapshots.push({
          path: targetPath,
          content,
          partial,
          contentLength: fullLength,
          source: typeof entry.source === "string" ? entry.source : "disk",
        });
      });
    }
  }

  const systemPrompt = routing.useWorkspaceContext
    ? buildSystemPrompt(context, rootPath, policy, options, {
        rootFileInfo,
        referencedFileSnapshots,
        referencedFileErrors,
      })
    : routing.mode === "smalltalk"
    ? buildSmalltalkSystemPrompt()
    : buildStandaloneQuestionSystemPrompt();
  const functionDeclarations =
    options.allowRunCommand === true
      ? AGENT_TOOL_DECLARATIONS
      : AGENT_TOOL_DECLARATIONS.filter((entry) => entry?.name !== "run_command");
  const tools = routing.disableTools ? [] : [{ functionDeclarations }];
  const temperatureInfo = deriveTurnTemperature(userText, routing, settings);
  const generationConfig = {
    temperature: temperatureInfo.temperature,
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
      toolCount: routing.disableTools ? 0 : functionDeclarations.length,
      systemPromptChars: systemPrompt.length,
      options,
      temperature: {
        value: temperatureInfo.temperature,
        profile: temperatureInfo.profile,
      },
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
      prefetchPaths,
      referencedFileSnapshots: referencedFileSnapshots.length,
      referencedFileErrors: referencedFileErrors.length,
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

  const maxIterations = routing.disableTools ? 1 : options.maxIterations;
  const declaredToolNames = new Set(
    Array.isArray(functionDeclarations)
      ? functionDeclarations
          .map((entry) => (typeof entry?.name === "string" ? entry.name.trim() : ""))
          .filter(Boolean)
      : []
  );
  const allowedEditFunctionNames = [
    "list_files",
    "read_file",
    "read_files",
    "search_files",
    "search_web",
    "open_terminal_session",
    "execute_bash_command",
    "send_terminal_input",
    "read_terminal_output",
    "kill_terminal",
    "get_project_structure",
    "get_index",
    "read_scratchpad",
    "write_scratchpad",
    "rename_latex_symbol",
    "get_app_settings",
    "set_app_settings",
    "write_file",
    "patch_file",
    "delete_file",
    "rename_file",
    "create_directory",
    "propose_write",
    "propose_patch",
    "propose_delete",
    "propose_rename",
    "propose_create_directory",
  ].filter((name) => declaredToolNames.has(name));
  const toolConfigNone = { functionCallingConfig: { mode: "NONE" } };
  const toolConfigAuto = { functionCallingConfig: { mode: "AUTO" } };
  const toolConfigAnyEdit = {
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: allowedEditFunctionNames },
  };
  const toolConfigAnyBuild = {
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["run_build"] },
  };
  const appliedEditToolNames = new Set([
    "rename_latex_symbol",
    "write_file",
    "patch_file",
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
  let recoveryPromptCount = 0;
  let forceBuildCount = 0;
  const canRunBuild = declaredToolNames.has("run_build");
  const maxRecoveryPromptCount = Math.max(2, Math.min(10, Math.round(maxIterations / 2)));
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
    if (wasAppliedEdit(toolName, result)) {
      editedSinceLastBuild = true;
      forceBuildCount = 0;
    }
    const autoBuildStatus =
      typeof result?.autoBuild?.status === "string" ? result.autoBuild.status : null;
    if (autoBuildStatus) {
      lastBuildStatus = autoBuildStatus;
      forceBuildCount += 1;
      if (autoBuildStatus === "success") {
        editedSinceLastBuild = false;
      }
    }
    if (toolName === "run_build") {
      const status = typeof result?.status === "string" ? result.status : null;
      lastBuildStatus = status;
      forceBuildCount += 1;
      if (status === "success") {
        editedSinceLastBuild = false;
      }
    }
  };

  const buildRequestConversationForTurn = () => {
    const source = Array.isArray(conversation) ? conversation : [];
    if (source.length === 0) return [];
    if (routing.mode === "smalltalk") {
      return [source[source.length - 1]];
    }
    const resetIndex = findLastTopicResetIndex(source);
    const afterReset = resetIndex >= 0 ? source.slice(resetIndex + 1) : source;
    if (routing.mode === "standalone") {
      const filtered = afterReset.filter((entry) => entry && entry.role !== "tool");
      return filtered.length > 8 ? filtered.slice(filtered.length - 8) : filtered;
    }
    // workspace: drop user-only greetings/capability checks to reduce accidental carryover.
    return afterReset.filter((entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (entry.role !== "user") return true;
      const text = extractTextFromParts(entry.parts).trim();
      if (!text) return true;
      if (GREETING_ONLY_PATTERN.test(text)) return false;
      if (CAPABILITY_QUESTION_PATTERN.test(text)) return false;
      return true;
    });
  };
  const executeToolWithAudit = async (iteration, toolName, callArgs) => {
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
    if (!isCurrentRun()) {
      exitReason = "superseded";
      return { result, superseded: true };
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
    return { result, superseded: false };
  };

  try {
    for (let i = 0; i < maxIterations; i += 1) {
      if (!isCurrentRun()) {
        exitReason = "superseded";
        return;
      }
      try {
        const thinkingLabel = i === 0 ? "方針検討中" : "追加検討中";
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
            toolConfig: routing.disableTools
              ? toolConfigNone
              : i === 0 && routing.forceToolCall === "build"
              ? toolConfigAnyBuild
              : i === 0 && routing.forceToolCall === "edit"
              ? toolConfigAnyEdit
              : toolConfigAuto,
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
          .map((part) => part.text)
          .filter((text) => typeof text === "string" && text.trim().length > 0);

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
          for (const part of functionCalls) {
            const call = part.functionCall;
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
            const execution = await executeToolWithAudit(i, toolName, callArgs);
            if (execution.superseded) {
              return;
            }
          }
          continue;
        }

        if (textParts.length > 0) {
          const text = textParts.join("\n");
          if (!isCurrentRun()) {
            exitReason = "superseded";
            return;
          }
          if (
            routing.mode === "workspace" &&
            options.autoBuild === true &&
            canRunBuild &&
            editedSinceLastBuild &&
            forceBuildCount < 3
          ) {
            const execution = await executeToolWithAudit(i, "run_build", {});
            if (execution.superseded) {
              return;
            }
            continue;
          }
          if (
            routing.mode === "workspace" &&
            canRunBuild &&
            lastBuildStatus === "failure" &&
            recoveryPromptCount < maxRecoveryPromptCount
          ) {
            recoveryPromptCount += 1;
            conversation.push({
              role: "user",
              parts: [
                {
                  text:
                    "最新ビルドが失敗しています。エラー箇所を解析して修正し、ビルドが成功するまで継続してください。",
                },
              ],
            });
            service.markSessionDirty(targetConversationId);
            continue;
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
        exitError = error?.message ?? "AIの呼び出しに失敗しました。";
        service.emitAuditEvent(
          "run_error",
          { iteration: i, message: clipText(exitError, 400) },
          targetConversationId,
          run.token
        );
        service.sendToRenderer("agent:error", {
          message: error?.message ?? "AIの呼び出しに失敗しました。",
          conversationId: targetConversationId,
        });
        service.sendStatus("error", "AIエラー", targetConversationId);
        service.markSessionDirty(targetConversationId);
        return;
      }
    }

    if (isCurrentRun()) {
      exitReason = "max_iterations";
      service.sendToRenderer("agent:message", {
        text: "上限回数に達したため停止しました。",
        conversationId: targetConversationId,
      });
      service.sendStatus("idle", "待機中", targetConversationId);
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
