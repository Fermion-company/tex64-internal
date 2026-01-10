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

  return {
    handleAgentSettingsGet,
    handleAgentSettingsSet,
    handleAgentRun,
    handleAgentAbort,
    handleAgentApply,
    handleAgentClear,
  };
};

module.exports = { createAgentHandlers };
