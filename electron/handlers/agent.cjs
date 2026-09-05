const {
  DEFAULT_BASE_URL,
  isOfficialPlatformProxyUrl,
  migrateLegacyAxiomModel,
  normalizeChatEndpoint,
  resolveLLMConfig,
  resolveOwnApiKey,
} = require("../services/openprism/llm-config.cjs");
const {
  buildMentionIndex,
  resolveMainTexFile,
  scanDocument,
} = require("../services/agent-document-map.cjs");
const crypto = require("crypto");
const { buildUsageFromAccess } = require("../services/platform-usage-payload.cjs");
const { runGit } = require("../services/openprism/tools.cjs");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const RULES_RELATIVE_PATH = ".tex64/rules.md";
const RULES_TEMPLATE = `# この文書の書き方

Axiom は毎ターンこのファイルを読みます。文体・記法・引用の形式など、守ってほしいことを短く書いてください。

- 文体: （例）である調。一文は短く。
- 記法: （例）数式は amsmath、ベクトルは太字。
- 引用: （例）\\cite は natbib の形式。
- 書かないこと: （例）結論を先取りしない。
`;

const MAX_TRANSCRIBE_BYTES = 12 * 1024 * 1024;
const TRANSCRIBE_ENDPOINT = `${DEFAULT_BASE_URL}/audio/transcriptions`;

const clipForFeedback = (value, max) => {
  const text = typeof value === "string" ? value.replace(/\s+$/g, "") : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** The nth assistant reply of a conversation with the user turn before it. */
const locateAssistantTurn = (conversation, assistantIndex) => {
  const entries = Array.isArray(conversation) ? conversation : [];
  let seen = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.role !== "assistant" || typeof entry.content !== "string" || !entry.content.trim()) {
      continue;
    }
    seen += 1;
    if (seen !== assistantIndex) continue;
    let userText = "";
    for (let back = index - 1; back >= 0; back -= 1) {
      if (entries[back]?.role === "user" && typeof entries[back].content === "string") {
        userText = entries[back].content;
        break;
      }
    }
    return { index, entry, userText };
  }
  return null;
};

const CANONICAL_AGENT_MODELS = new Set([
  "Axiom1.0",
  "Axiom1.0-pro",
]);
const DEFAULT_AGENT_MODEL = "Axiom1.0";
const AI_MODE_CONVERSATION_PREFIX = "tex64-ai-mode:";

const awaitAbortable = (promise, signal) => {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) {
    const error = new Error("Axiom request aborted.");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      const error = new Error("Axiom request aborted.");
      error.name = "AbortError";
      finish(reject, error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
};

const createAgentHandlers = (deps) => {
  const { agentService, ensureUserSettings, sendToRenderer, platformService } = deps;
  const normalizeRequestId = (value) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, 256) : null;
  const buildAiBlockedMessage = (access) => {
    const reason = typeof access?.reason === "string" ? access.reason : "";
    const pricingUrl =
      typeof access?.pricingUrl === "string" && access.pricingUrl.trim()
        ? access.pricingUrl.trim()
        : "https://tex64.com/pricing";
    if (!access?.authenticated || reason === "AUTH_REQUIRED" || reason === "TOKEN_EXPIRED") {
      return "Google login is required to use Axiom.";
    }
    if (reason === "QUOTA_EXCEEDED") {
      return `You have reached your AI token limit for this month. Change plan at ${pricingUrl}.`;
    }
    if (
      reason === "PLAN_REQUIRED" ||
      reason === "FEATURE_NOT_ENABLED" ||
      reason === "PAYMENT_PAST_DUE"
    ) {
      return `AI functions are not available under the current contract status. Check plan: ${pricingUrl}`;
    }
    return "Axiom is not available. Please try again later.";
  };

  const guardAiAccess = async (
    conversationId,
    source,
    forcePlatform = false,
    signal,
  ) => {
    // Codex runs on the user's own ChatGPT subscription. A custom
    // OpenAI-compatible endpoint may also bypass TeX64 entitlement, but only
    // when it has its own credential. Merely setting an endpoint must never
    // bypass quota/access checks.
    try {
      const settings = await awaitAbortable(
        ensureUserSettings().getAgentSettings(),
        signal,
      );
      const usesCodexBackend = (settings?.model || "") === "codex";
      if (!forcePlatform && usesCodexBackend) {
        return true;
      }
      const llmConfig = resolveLLMConfig(settings);
      const apiUrl = normalizeChatEndpoint(llmConfig.endpoint);
      const usesCustomEndpoint = !isOfficialPlatformProxyUrl(apiUrl);
      const ownApiKey = resolveOwnApiKey(settings);
      if (!forcePlatform && usesCustomEndpoint && ownApiKey) {
        return true;
      }
      if (!forcePlatform && usesCustomEndpoint) {
        sendToRenderer("agent:error", {
          conversationId:
            typeof conversationId === "string" ? conversationId : undefined,
          message:
            "A custom AI endpoint requires its own API key (agent apiKey or TEX64_LLM_API_KEY).",
        });
        return false;
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // fall through to platform check
    }

    if (!platformService) {
      return true;
    }
    const access = await awaitAbortable(
      platformService.checkAiAccess({ force: false }),
      signal,
    );
    sendToRenderer("platform:aiAccess", { source, access });
    const usagePayload = buildUsageFromAccess(access);
    if (usagePayload) {
      sendToRenderer("platform:usage", { source, usage: usagePayload });
    }
    if (access?.allowed) {
      return true;
    }
    sendToRenderer("agent:error", {
      conversationId: typeof conversationId === "string" ? conversationId : undefined,
      message: buildAiBlockedMessage(access),
    });
    return false;
  };

  const handleAgentSettingsGet = async () => {
    const settings = await ensureUserSettings().getAgentSettings();
    sendToRenderer("agent:settings", { settings });
  };

  const sanitizeAgentModel = (model) => {
    const migrated = migrateLegacyAxiomModel(model);
    return CANONICAL_AGENT_MODELS.has(migrated)
      ? migrated
      : DEFAULT_AGENT_MODEL;
  };

  const sendSanitizedAgentModel = (model) => {
    const sanitized = sanitizeAgentModel(model);
    // This event is safe to relay into the untrusted AI-mode webview. Never
    // add endpoint, apiKey, or the full settings object to this payload.
    sendToRenderer("agent:model", { model: sanitized });
    return sanitized;
  };

  const handleAgentModelGet = async () => {
    const settings = await ensureUserSettings().getAgentSettings();
    const sanitized = sanitizeAgentModel(settings?.model);
    if (settings?.model !== sanitized) {
      await ensureUserSettings().updateAgentSettings({ model: sanitized });
    }
    return sendSanitizedAgentModel(sanitized);
  };

  const handleAgentModelSet = async (model) => {
    if (!CANONICAL_AGENT_MODELS.has(model)) {
      const current = await handleAgentModelGet();
      return { ok: false, model: current };
    }
    const settings = await ensureUserSettings().updateAgentSettings({ model });
    // Keep the trusted Code renderer's existing settings protocol working.
    sendToRenderer("agent:settings", { settings });
    const sanitized = sendSanitizedAgentModel(settings?.model);
    return { ok: true, model: sanitized };
  };

  const handleAgentSettingsSet = async (partial) => {
    const settings = await ensureUserSettings().updateAgentSettings(partial);
    sendToRenderer("agent:settings", { settings });
    sendSanitizedAgentModel(settings?.model);
  };

  const runAfterAccessPreflight = async ({
    message,
    parts,
    context,
    conversationId,
    forcePlatformAxiom = false,
    requestStillCurrent,
  }) => {
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    // Reserve the conversation before entitlement/settings I/O. Stop and the
    // workspace-change coordinator must see this request while access checks
    // are still pending; otherwise a delayed request can start in the next
    // workspace with the previous document identity.
    let run;
    try {
      run = agentService.startConversationRun(normalizedConversationId);
    } catch (error) {
      if (error?.code === "AGENT_RUN_IN_PROGRESS") {
        // The existing controller owns any pending write and terminal build.
        // Never replace its token. Tell the renderer that this optimistic send
        // was not accepted while preserving the existing operation's lock.
        sendToRenderer("agent:requestRejected", {
          conversationId: normalizedConversationId,
          message: "A change is still being applied. Your message was not sent.",
        });
        return;
      }
      if (error?.code === "AGENT_WORKSPACE_RUN_IN_PROGRESS") {
        const message = "Another Axiom turn is still finishing in this workspace.";
        sendToRenderer("agent:error", {
          conversationId: normalizedConversationId,
          message,
        });
        agentService.sendStatus("error", message, normalizedConversationId);
        return;
      }
      if (error?.code === "RENDERER_WORKSPACE_MUTATION_IN_PROGRESS") {
        const message =
          "A file save is still finishing. Retry the Axiom request in a moment.";
        sendToRenderer("agent:error", {
          conversationId: normalizedConversationId,
          message,
        });
        agentService.sendStatus("error", message, normalizedConversationId);
        return;
      }
      if (error?.code === "AGENT_CONTENT_CONFLICT") {
        const message = "Resolve the editor conflict before starting another Axiom turn.";
        sendToRenderer("agent:error", {
          conversationId: normalizedConversationId,
          message,
        });
        agentService.sendStatus("resumable", message, normalizedConversationId);
        return;
      }
      throw error;
    }
    const isCurrentRun = () =>
      agentService.isRunCurrent(normalizedConversationId, run.token);
    agentService.sendStatus("running", "Preparing...", normalizedConversationId);
    let delegated = false;
    try {
      const allowed = await guardAiAccess(
        normalizedConversationId,
        "chat",
        forcePlatformAxiom,
        run.controller.signal,
      );
      if (!isCurrentRun()) return;
      if (run.controller.signal.aborted) {
        agentService.sendStatus("idle", "Aborted.", normalizedConversationId);
        return;
      }
      if (!allowed) {
        agentService.sendStatus(
          "error",
          "Axiom is not available for this request.",
          normalizedConversationId,
        );
        return;
      }
      if (
        typeof requestStillCurrent === "function" &&
        requestStillCurrent() !== true
      ) {
        const errorMessage =
          "The workspace changed. Retry in the document now open.";
        sendToRenderer("agent:error", {
          conversationId: normalizedConversationId,
          message: errorMessage,
        });
        agentService.sendStatus("error", errorMessage, normalizedConversationId);
        return;
      }
      delegated = true;
      await agentService.run(
        {
          message,
          parts,
          context,
          conversationId: normalizedConversationId,
          forcePlatformAxiom,
        },
        run,
      );
    } catch (error) {
      if (!isCurrentRun()) return;
      if (run.controller.signal.aborted || error?.name === "AbortError") {
        agentService.sendStatus("idle", "Aborted.", normalizedConversationId);
        return;
      }
      const errorMessage =
        typeof error?.message === "string" && error.message.trim()
          ? error.message
          : "Axiom could not start. Please try again.";
      sendToRenderer("agent:error", {
        conversationId: normalizedConversationId,
        message: errorMessage,
      });
      agentService.sendStatus("error", errorMessage, normalizedConversationId);
    } finally {
      // AgentService owns cleanup once delegated. Preflight-only exits are
      // settled here so waitForIdle() can release a pending workspace change.
      if (!delegated) {
        agentService.finishConversationRun(normalizedConversationId, run.token);
        agentService.markSessionDirty?.(normalizedConversationId);
      }
    }
  };

  const handleAgentRun = async (
    message,
    context,
    conversationId,
    parts,
    requestStillCurrent,
  ) => {
    const normalizedMessage = typeof message === "string" ? message : "";
    const hasText = normalizedMessage.trim().length > 0;
    const hasParts = Array.isArray(parts) && parts.length > 0;
    if (!hasText && !hasParts) {
      return;
    }
    const forcePlatformAxiom =
      typeof conversationId === "string" &&
      conversationId.startsWith(AI_MODE_CONVERSATION_PREFIX);
    await runAfterAccessPreflight({
      message: normalizedMessage,
      parts: hasParts ? parts : undefined,
      context,
      conversationId,
      forcePlatformAxiom,
      requestStillCurrent,
    });
  };

  const handleStashComplete = async (payload) => {
    const allowed = await guardAiAccess("pro-stash", "stash");
    if (!allowed) return { ok: false, error: buildAiBlockedMessage({}) };
    try {
      return { ok: true, text: await agentService.completeOnce(payload || {}) };
    } catch (error) {
      return { ok: false, error: error?.message || "AI edit failed." };
    }
  };

  const handleAgentStateGet = async (requestId, conversationId) => {
    const state = (await agentService.getUiState?.()) ?? { sessions: [] };
    const normalizedRequestId = normalizeRequestId(requestId);
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : null;
    const scopedState = {
      ...state,
      sessions: Array.isArray(state.sessions)
        ? state.sessions.filter((session) => {
            const id =
              typeof session?.conversationId === "string"
                ? session.conversationId
                : "";
            return normalizedConversationId
              ? id === normalizedConversationId
              : !id.startsWith(AI_MODE_CONVERSATION_PREFIX);
          })
        : [],
    };
    sendToRenderer("agent:state", {
      ...scopedState,
      ...(normalizedRequestId ? { requestId: normalizedRequestId } : {}),
      ...(normalizedConversationId
        ? { conversationId: normalizedConversationId }
        : {}),
    });
  };

  const handleAgentProposalDismiss = (proposalId) => {
    if (!proposalId || typeof proposalId !== "string") {
      return;
    }
    agentService.dismissProposal(proposalId);
  };

  const handleAgentResume = async (conversationId, context) => {
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    // AI-mode uses fresh document-scoped turns and never the Code-only resume
    // protocol. Rejecting the prefix prevents a Code history action from
    // reopening an AI document thread under the current editor context.
    if (normalizedConversationId.startsWith(AI_MODE_CONVERSATION_PREFIX)) return;
    await runAfterAccessPreflight({
      message:
        "Continue from where you left off, prioritizing the last user instruction and the conversation purpose. Repeat edits and build verification as needed until complete.",
      context,
      conversationId: normalizedConversationId,
    });
  };

  const handleSearchRename = async (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const workspaceRoot = agentService.workspace.getRootPath?.() ?? "";
    // Search rename is an operation thread, not a portable user chat. Give
    // every workspace its own identity so a persisted run in project A can
    // never bind or block the same command in project B.
    const conversationId = workspaceRoot
      ? `search-rename:${crypto
          .createHash("sha256")
          .update(workspaceRoot)
          .digest("hex")
          .slice(0, 20)}`
      : "search-rename";
    let run;
    try {
      // Symbol rename scans the complete workspace and may immediately apply
      // several edits. Hold one writer lease across both phases so a Code save
      // cannot make the scan stale between reading and applying.
      run = agentService.startConversationRun(conversationId);
      agentService.sendStatus("running", "Renaming symbols...", conversationId);
    } catch (error) {
      sendToRenderer("search:renameResult", {
        ok: false,
        error: error?.message || "The workspace is being updated. Try again.",
        conversationId,
      });
      return;
    }
    let result;
    try {
      if (payload.context && typeof payload.context === "object") {
        agentService.setContext(conversationId, payload.context);
      }
      result = await agentService.executeToolCall(
        {
          name: "rename_latex_symbol",
          args: {
            from: payload.from,
            to: payload.to,
            kinds: payload.kinds,
            extensions: payload.extensions,
          },
        },
        conversationId
      );
      if (result?.autoBuild) {
        agentService.settleManualApplyBuild(result.autoBuild, conversationId);
      } else {
        agentService.sendStatus("idle", "Waiting", conversationId);
      }
    } catch (error) {
      const message = error?.message || "Rename failed.";
      sendToRenderer("search:renameResult", {
        ok: false,
        error: message,
        conversationId,
      });
      agentService.sendStatus("error", message, conversationId);
      return;
    } finally {
      agentService.finishConversationRun(conversationId, run.token);
    }
    const files = Array.isArray(result?.files) ? result.files : [];
    const appliedCount = files.reduce((sum, entry) => {
      if (entry?.ok === false) return sum;
      const value = typeof entry.appliedCount === "number" ? entry.appliedCount : 0;
      return sum + value;
    }, 0);
    const skippedCount = Array.isArray(result?.skipped) ? result.skipped.length : 0;
    const failedCount = files.filter((entry) => entry?.ok === false).length;
    const resultError =
      result?.error ||
      (failedCount > 0
        ? failedCount === files.length
          ? "Rename could not be applied because the files changed. Try again."
          : `${failedCount} file(s) changed before rename could be applied.`
        : undefined);
    sendToRenderer("search:renameResult", {
      ok: !resultError,
      from: payload.from,
      to: payload.to,
      fileCount: files.length,
      appliedCount,
      skippedCount,
      error: resultError,
      conversationId,
    });
  };

  const handleAgentAbort = (conversationId) => {
    agentService.abort(conversationId);
  };

  const handleAgentContentConflict = (conversationId, relativePath) => {
    agentService.reportContentConflict(conversationId, relativePath);
  };

  const handleAgentContentConflictResolved = (conversationId, relativePath) => {
    agentService.resolveContentConflict(conversationId, relativePath);
  };

  const handleAgentApply = async (proposalId) => {
    if (!proposalId || typeof proposalId !== "string") {
      return;
    }
    await agentService.applyProposal(proposalId);
  };

  const handleAgentApplyBatch = async (proposalIds) => {
    await agentService.applyProposals(proposalIds);
  };

  const handleAgentUndoLastRunApply = async (conversationId, requestId) => {
    const normalizedRequestId = normalizeRequestId(requestId);
    if (!normalizedRequestId) {
      return agentService.undoLastRunApply(conversationId);
    }
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    try {
      const result = await agentService.undoLastRunApply(conversationId, {
        emitRenderer: false,
      });
      const resultConversationId =
        typeof result?.conversationId === "string" && result.conversationId.trim()
          ? result.conversationId.trim()
          : normalizedConversationId;
      const ok = result?.ok === true;
      const error =
        typeof result?.error === "string" && result.error.trim()
          ? result.error
          : typeof result?.message === "string" && result.message.trim()
          ? result.message
          : "Undo failed.";
      sendToRenderer("agent:undoResult", {
        requestId: normalizedRequestId,
        conversationId: resultConversationId,
        ok,
        ...(!ok ? { error } : {}),
      });
      return result;
    } catch (error) {
      sendToRenderer("agent:undoResult", {
        requestId: normalizedRequestId,
        conversationId: normalizedConversationId,
        ok: false,
        error: error?.message ?? "Undo failed.",
      });
      return { ok: false, error: error?.message ?? "Undo failed." };
    }
  };

  const handleAgentUndoLastApply = async (conversationId) => {
    await agentService.undoLastApply(conversationId);
  };

  const handleAgentClear = (conversationId) => {
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    if (normalizedConversationId.startsWith(AI_MODE_CONVERSATION_PREFIX)) return;
    const result = agentService.clearConversation(normalizedConversationId);
    if (result?.ok === false) {
      sendToRenderer("agent:error", {
        conversationId: normalizedConversationId,
        message: result.error || "This chat cannot be deleted while it is running.",
      });
    }
    return result;
  };

  const handleSettingsResponse = (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    agentService.handleSettingsResponse(payload);
  };

  // ---- A reply rated by the reader ----
  // The rating goes to the same feedback endpoint as the settings form, with
  // the request and the reply attached, so the team can see what worked.
  const handleAgentFeedback = async (message) => {
    const conversationId =
      typeof message?.conversationId === "string" && message.conversationId.trim()
        ? message.conversationId.trim()
        : "";
    const assistantIndex = Number.isInteger(message?.assistantIndex) ? message.assistantIndex : -1;
    const rating = message?.rating === "up" ? "up" : message?.rating === "down" ? "down" : "";
    const comment = clipForFeedback(message?.comment, 2_000);
    const reply = (ok, error) =>
      sendToRenderer("agent:feedbackResult", {
        conversationId,
        assistantIndex,
        rating,
        ok,
        ...(error ? { error } : {}),
      });
    if (!conversationId || assistantIndex < 0 || !rating) {
      reply(false, "Invalid rating request.");
      return;
    }
    await agentService.ensureSessionsRestored();
    const located = locateAssistantTurn(agentService.conversations.get(conversationId), assistantIndex);
    if (!located) {
      reply(false, "The reply is no longer available.");
      return;
    }
    located.entry.rating = rating;
    agentService.markSessionDirty(conversationId);
    if (!platformService || typeof platformService.submitFeedback !== "function") {
      reply(true);
      return;
    }
    let model = "";
    try {
      model = (await ensureUserSettings().getAgentSettings())?.model ?? "";
    } catch {
      model = "";
    }
    let appVersion = "";
    let appPlatform = "";
    try {
      const { app } = require("electron");
      appVersion = app.getVersion();
      appPlatform = `${process.platform}-${process.arch}`;
    } catch {
      // not in Electron
    }
    try {
      await platformService.submitFeedback({
        category: "axiom-rating",
        message: `[Axiom ${rating === "up" ? "+1" : "-1"}] ${comment || (rating === "up" ? "Helpful reply" : "Unhelpful reply")}`,
        app: { version: appVersion, platform: appPlatform },
        diagnostics: {
          kind: "axiom-rating",
          rating,
          model,
          conversationId,
          assistantIndex,
          userPrompt: clipForFeedback(located.userText, 2_000),
          assistantReply: clipForFeedback(located.entry.content, 4_000),
        },
      });
      reply(true);
    } catch (error) {
      reply(false, error?.message || "The rating could not be sent.");
    }
  };

  // ---- Branch: a new chat that starts from an earlier reply ----
  const handleAgentBranch = async (message) => {
    const sourceId =
      typeof message?.conversationId === "string" && message.conversationId.trim()
        ? message.conversationId.trim()
        : "";
    const assistantIndex = Number.isInteger(message?.assistantIndex) ? message.assistantIndex : -1;
    const fail = (error) =>
      sendToRenderer("agent:branchResult", { ok: false, sourceConversationId: sourceId, error });
    if (!sourceId || assistantIndex < 0 || sourceId.startsWith(AI_MODE_CONVERSATION_PREFIX)) {
      fail("Invalid branch request.");
      return;
    }
    await agentService.ensureSessionsRestored();
    const source = agentService.conversations.get(sourceId);
    const located = locateAssistantTurn(source, assistantIndex);
    if (!located) {
      fail("The reply is no longer available.");
      return;
    }
    const newId = `chat-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const copied = source.slice(0, located.index + 1).map((entry) => JSON.parse(JSON.stringify(entry)));
    const target = agentService.buildConversation(newId);
    target.push(...copied);
    const sourceRoot = agentService.workspaceRootByConversation.get(sourceId) ?? agentService.workspace.getRootPath?.();
    if (sourceRoot) agentService.workspaceRootByConversation.set(newId, sourceRoot);
    const sourceContext = agentService.contextByConversation.get(sourceId);
    if (sourceContext) agentService.contextByConversation.set(newId, { ...sourceContext });
    const sourceMeta = agentService.sessionMetaByConversation.get(sourceId);
    const now = Date.now();
    agentService.sessionMetaByConversation.set(newId, {
      createdAt: now,
      updatedAt: now,
      ...(sourceMeta?.title ? { title: sourceMeta.title } : {}),
      branchedFrom: sourceId,
    });
    agentService.markSessionDirty(newId);
    sendToRenderer("agent:branchResult", { ok: true, conversationId: newId, sourceConversationId: sourceId });
    await handleAgentStateGet();
  };

  // ---- Voice: audio from the composer to text ----
  const handleAgentTranscribe = async (message) => {
    const requestId = normalizeRequestId(message?.requestId);
    const reply = (payload) => sendToRenderer("agent:transcribeResult", { requestId, ...payload });
    const data = typeof message?.data === "string" ? message.data.replace(/\s+/g, "") : "";
    const mimeType =
      typeof message?.mimeType === "string" && /^audio\/[a-z0-9.+-]+(?:;.*)?$/i.test(message.mimeType)
        ? message.mimeType
        : "audio/webm";
    if (!requestId || !data) {
      reply({ ok: false, error: "No audio was recorded." });
      return;
    }
    let buffer;
    try {
      buffer = Buffer.from(data, "base64");
    } catch {
      reply({ ok: false, error: "The recording could not be read." });
      return;
    }
    if (buffer.byteLength < 200 || buffer.byteLength > MAX_TRANSCRIBE_BYTES) {
      reply({ ok: false, error: buffer.byteLength > MAX_TRANSCRIBE_BYTES ? "The recording is too long." : "The recording is too short." });
      return;
    }
    const allowed = await guardAiAccess("voice", "voice", true);
    if (!allowed) {
      reply({ ok: false, error: "Axiom is not available right now." });
      return;
    }
    try {
      // The platform identity, as the chat proxy gets it: the JWT when signed
      // in, else the device id for the anonymous allowance.
      let accessToken = null;
      let deviceId = null;
      if (agentService.platformAccess) {
        accessToken = await agentService.platformAccess.refreshAccessToken(false).catch(() => null);
        deviceId = await agentService.platformAccess.ensureDeviceId().catch(() => null);
      }
      if (!accessToken && !deviceId) {
        reply({ ok: false, error: "Axiom requires login or a local app identity." });
        return;
      }
      const extension = /ogg/i.test(mimeType) ? "ogg" : /mp4|m4a/i.test(mimeType) ? "m4a" : /wav/i.test(mimeType) ? "wav" : "webm";
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: mimeType.split(";")[0] }), `voice.${extension}`);
      form.append("model", "axiom-voice");
      if (Number.isFinite(message?.durationMs) && message.durationMs > 0) {
        form.append("duration_seconds", String(Math.min(180, message.durationMs / 1000)));
      }
      if (typeof message?.language === "string" && /^[a-z]{2}$/i.test(message.language)) {
        form.append("language", message.language.toLowerCase());
      }
      const response = await fetch(TRANSCRIBE_ENDPOINT, {
        method: "POST",
        headers: {
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...(deviceId ? { "X-Tex64-Device-Id": deviceId } : {}),
        },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let detail = "";
        try {
          detail = JSON.parse(text)?.error?.message || "";
        } catch {
          detail = "";
        }
        reply({ ok: false, error: detail || `Transcription failed (${response.status}).` });
        return;
      }
      const result = await response.json().catch(() => null);
      const text = typeof result?.text === "string" ? result.text.trim() : "";
      reply(text ? { ok: true, text } : { ok: false, code: "empty", error: "Nothing was heard." });
    } catch (error) {
      reply({ ok: false, error: error?.name === "TimeoutError" ? "Transcription timed out." : error?.message || "Transcription failed." });
    }
  };

  // ---- The @ picker's index: sections, labels, bib keys of the document ----
  // Also what the empty chat needs to know: whether the workspace is a git
  // repository with changes, and whether it has writing rules.
  const handleAgentDocumentMapGet = async (message) => {
    const requestId = normalizeRequestId(message?.requestId);
    const rootPath = agentService.workspace.getRootPath?.();
    const empty = { requestId, mainFile: null, sections: [], labels: [], bibKeys: [], git: { isRepo: false, changed: 0 }, rules: { exists: false } };
    if (!rootPath) {
      sendToRenderer("agent:documentMap", empty);
      return;
    }
    try {
      const mainFile = await resolveMainTexFile(agentService, {
        activeFilePath: typeof message?.activeFilePath === "string" ? message.activeFilePath : undefined,
      });
      const map = mainFile ? await scanDocument(agentService, mainFile) : null;
      const isRepo = fs.existsSync(path.join(rootPath, ".git"));
      const status = isRepo ? await runGit(rootPath, ["status", "--porcelain"]) : null;
      const changed = typeof status === "string" ? status.split(/\r?\n/).filter(Boolean).length : 0;
      sendToRenderer("agent:documentMap", {
        requestId,
        mainFile: map?.mainFile ?? null,
        ...buildMentionIndex(map),
        git: { isRepo, changed },
        rules: { exists: fs.existsSync(path.join(rootPath, RULES_RELATIVE_PATH)) },
      });
    } catch {
      sendToRenderer("agent:documentMap", empty);
    }
  };

  // ---- The project's writing rules: create with a template, open in the editor ----
  const handleAgentRulesOpen = async () => {
    const rootPath = agentService.workspace.getRootPath?.();
    if (!rootPath) return;
    const absolute = path.join(rootPath, RULES_RELATIVE_PATH);
    let content = "";
    try {
      content = await fsp.readFile(absolute, "utf8");
    } catch {
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      content = RULES_TEMPLATE;
      await fsp.writeFile(absolute, content, "utf8");
      await agentService.updateWorkspaceIfNeeded?.(rootPath, true);
    }
    sendToRenderer("openFileResult", { path: RULES_RELATIVE_PATH, content });
  };

  return {
    handleAgentSettingsGet,
    handleAgentSettingsSet,
    handleAgentModelGet,
    handleAgentModelSet,
    handleAgentRun,
    handleAgentAbort,
    handleAgentContentConflict,
    handleAgentContentConflictResolved,
    handleAgentApply,
    handleAgentApplyBatch,
    handleAgentUndoLastRunApply,
    handleAgentUndoLastApply,
    handleAgentClear,
    handleAgentStateGet,
    handleAgentResume,
    handleAgentProposalDismiss,
    handleSearchRename,
    handleSettingsResponse,
    handleStashComplete,
    handleAgentFeedback,
    handleAgentBranch,
    handleAgentTranscribe,
    handleAgentDocumentMapGet,
    handleAgentRulesOpen,
  };
};

module.exports = { createAgentHandlers };
