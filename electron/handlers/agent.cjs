const createAgentHandlers = (deps) => {
  const { agentService, ensureUserSettings, sendToRenderer, platformService } = deps;
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
      return "AI機能を使うには Google ログインが必要です。";
    }
    if (reason === "QUOTA_EXCEEDED") {
      return `今月のAIトークン上限に達しました。プランの変更は ${pricingUrl} から行えます。`;
    }
    if (
      reason === "PLAN_REQUIRED" ||
      reason === "FEATURE_NOT_ENABLED" ||
      reason === "PAYMENT_PAST_DUE"
    ) {
      return `現在の契約状態ではAI機能を利用できません。プラン確認: ${pricingUrl}`;
    }
    return "AI機能を利用できません。しばらくしてから再試行してください。";
  };

  const guardAiAccess = async (conversationId, source) => {
    if (!platformService) {
      return true;
    }
    const access = await platformService.checkAiAccess({ force: false });
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

  const handleAgentSettingsSet = async (partial) => {
    const settings = await ensureUserSettings().updateAgentSettings(partial);
    sendToRenderer("agent:settings", { settings });
  };

  const handleAgentRun = async (message, context, conversationId, parts) => {
    const normalizedMessage = typeof message === "string" ? message : "";
    const hasText = normalizedMessage.trim().length > 0;
    const hasParts = Array.isArray(parts) && parts.length > 0;
    if (!hasText && !hasParts) {
      return;
    }
    const allowed = await guardAiAccess(conversationId, "chat");
    if (!allowed) {
      return;
    }
    await agentService.run({
      message: normalizedMessage,
      parts: hasParts ? parts : undefined,
      context,
      conversationId,
    });
  };

  const handleAgentStateGet = async () => {
    const state = (await agentService.getUiState?.()) ?? { sessions: [] };
    sendToRenderer("agent:state", state);
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
    const allowed = await guardAiAccess(normalizedConversationId, "chat");
    if (!allowed) {
      return;
    }
    await agentService.run({
      message:
        "直前のユーザー指示と会話の目的を最優先して、途中から継続してください。必要なら編集とビルド検証を繰り返して完了まで進めてください。",
      context,
      conversationId: normalizedConversationId,
    });
  };

  const handleSearchRename = async (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const conversationId =
      typeof payload.conversationId === "string" && payload.conversationId.trim()
        ? payload.conversationId.trim()
        : "search-rename";
    if (payload.context && typeof payload.context === "object") {
      agentService.setContext(conversationId, payload.context);
    }
    const result = await agentService.executeToolCall(
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
    const files = Array.isArray(result?.files) ? result.files : [];
    const appliedCount = files.reduce((sum, entry) => {
      const value = typeof entry.appliedCount === "number" ? entry.appliedCount : 0;
      return sum + value;
    }, 0);
    const skippedCount = Array.isArray(result?.skipped) ? result.skipped.length : 0;
    sendToRenderer("search:renameResult", {
      ok: !result?.error,
      from: payload.from,
      to: payload.to,
      fileCount: files.length,
      appliedCount,
      skippedCount,
      error: result?.error,
      conversationId,
    });
  };

  const handleAgentAbort = (conversationId) => {
    agentService.abort(conversationId);
  };

  const handleAgentApply = async (proposalId) => {
    if (!proposalId || typeof proposalId !== "string") {
      return;
    }
    await agentService.applyProposal(proposalId);
  };

  const handleAgentUndoLastRunApply = async (conversationId) => {
    await agentService.undoLastRunApply(conversationId);
  };

  const handleAgentClear = (conversationId) => {
    agentService.clearConversation(conversationId || "default");
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
    handleAgentRun,
    handleAgentAbort,
    handleAgentApply,
    handleAgentUndoLastRunApply,
    handleAgentClear,
    handleAgentStateGet,
    handleAgentResume,
    handleAgentProposalDismiss,
    handleSearchRename,
    handleSettingsResponse,
  };
};

module.exports = { createAgentHandlers };
