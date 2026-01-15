const createAgentHandlers = (deps) => {
  const { agentService, ensureUserSettings, sendToRenderer } = deps;

  const handleAgentSettingsGet = async () => {
    const settings = await ensureUserSettings().getAgentSettings();
    sendToRenderer("agent:settings", { settings });
  };

  const handleAgentSettingsSet = async (partial) => {
    const settings = await ensureUserSettings().updateAgentSettings(partial);
    sendToRenderer("agent:settings", { settings });
  };

  const handleAgentRun = async (message, context, conversationId) => {
    if (!message || typeof message !== "string") {
      return;
    }
    await agentService.run({ message, context, conversationId });
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

  const handleAgentAbort = () => {
    agentService.abort();
  };

  const handleAgentApply = async (proposalId) => {
    if (!proposalId || typeof proposalId !== "string") {
      return;
    }
    await agentService.applyProposal(proposalId);
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
    handleAgentClear,
    handleSearchRename,
    handleSettingsResponse,
  };
};

module.exports = { createAgentHandlers };
