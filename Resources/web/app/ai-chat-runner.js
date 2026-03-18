export const createAiChatRunner = (options) => {
    const { isAiBlocked, needsLogin, requestAiAccessCheck, requestPlatformUsage, updateStatusDisplay, ensureChat, runningConversations, pendingAgentRequests, buildContextPayload, getAgentSettings, upsertThinkingMessage, renderHistoryList, updateSendState, postToNative, clearThinkingMessage, restoreDraftFromPending, } = options;
    const requestAgentRun = (chatId, message, parts, contextPayload) => {
        var _a;
        if (isAiBlocked() || needsLogin()) {
            requestAiAccessCheck(true);
            requestPlatformUsage(true);
            updateStatusDisplay();
            return false;
        }
        const hasText = typeof message === "string" && message.trim().length > 0;
        const hasParts = Array.isArray(parts) && parts.length > 0;
        if (!hasText && !hasParts)
            return false;
        const chat = ensureChat(chatId);
        if (!chat)
            return false;
        if (runningConversations.has(chat.id))
            return false;
        const contextToSend = contextPayload !== null && contextPayload !== void 0 ? contextPayload : buildContextPayload(getAgentSettings());
        pendingAgentRequests.set(chat.id, {
            message,
            parts: Array.isArray(parts) ? parts : undefined,
            contextPayload: contextToSend,
        });
        chat.statusMessage = "考えています...";
        runningConversations.add(chat.id);
        upsertThinkingMessage(chat.id, chat.statusMessage);
        renderHistoryList();
        updateSendState();
        updateStatusDisplay();
        const posted = postToNative({
            type: "agent:run",
            message,
            parts,
            conversationId: chat.id,
            context: contextToSend,
        });
        if (!posted) {
            runningConversations.delete(chat.id);
            chat.statusMessage = "";
            clearThinkingMessage(chat.id);
            const pending = (_a = pendingAgentRequests.get(chat.id)) !== null && _a !== void 0 ? _a : null;
            pendingAgentRequests.delete(chat.id);
            restoreDraftFromPending(chat.id, pending);
            renderHistoryList();
            updateSendState();
            updateStatusDisplay();
            return false;
        }
        return true;
    };
    return {
        requestAgentRun,
    };
};
