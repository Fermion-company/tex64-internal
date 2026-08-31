const {
  isOfficialPlatformProxyUrl,
  migrateLegacyAxiomModel,
  normalizeChatEndpoint,
  resolveLLMConfig,
  resolveOwnApiKey,
} = require("../services/openprism/llm-config.cjs");
const crypto = require("crypto");

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
  const parseNumber = (value, fallback = 0) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return fallback;
  };
  const normalizeQuotaSummary = (quota, periodOverrides = {}) => {
    if (!quota || typeof quota !== "object") {
      return null;
    }
    const limitTokens = Math.max(0, Math.round(parseNumber(quota.limitTokens, 0)));
    const usedTokens = Math.max(0, Math.round(parseNumber(quota.usedTokens, 0)));
    const maxRemainingTokens = Math.max(0, limitTokens - usedTokens);
    const rawRemainingTokens = parseNumber(quota.remainingTokens, Number.NaN);
    const normalizedRemainingTokens = Number.isFinite(rawRemainingTokens)
      ? Math.max(0, Math.round(rawRemainingTokens))
      : maxRemainingTokens;
    return {
      limitTokens,
      usedTokens,
      remainingTokens: Math.min(normalizedRemainingTokens, maxRemainingTokens),
      usedRequests: Math.max(0, Math.round(parseNumber(quota.usedRequests, 0))),
      remainingRequests: Math.max(
        0,
        Math.round(parseNumber(quota.remainingRequests, 0))
      ),
      periodStart:
        typeof periodOverrides.periodStart === "string"
          ? periodOverrides.periodStart
          : typeof quota.periodStart === "string"
          ? quota.periodStart
          : null,
      periodEnd:
        typeof periodOverrides.periodEnd === "string"
          ? periodOverrides.periodEnd
          : typeof quota.periodEnd === "string"
          ? quota.periodEnd
          : null,
    };
  };

  const buildUsageFromAccess = (access) => {
    if (!access || typeof access !== "object") {
      return null;
    }
    const quota = access.quota && typeof access.quota === "object" ? access.quota : null;
    return {
      authenticated: Boolean(access.authenticated),
      plan: typeof access.plan === "string" ? access.plan : null,
      period: null,
      summary: normalizeQuotaSummary(quota, {
        periodStart:
          typeof access.periodStart === "string" ? access.periodStart : null,
        periodEnd:
          typeof access.periodEnd === "string" ? access.periodEnd : null,
      }),
      byFeature: null,
      errorCode: access.allowed ? null : access.reason ?? "FEATURE_NOT_ENABLED",
      message: typeof access.message === "string" ? access.message : null,
      fetchedAt:
        typeof access.fetchedAt === "number" && Number.isFinite(access.fetchedAt)
          ? access.fetchedAt
          : Date.now(),
    };
  };

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
  };
};

module.exports = { createAgentHandlers };
