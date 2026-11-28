import { aiText } from "./ai-i18n.js";
export const createAiChatRunner = (options) => {
    const { isAiBlocked, needsLogin, requestAiAccessCheck, requestPlatformUsage, updateStatusDisplay, ensureChat, runningConversations, pendingAgentRequests, buildContextPayload, getAgentSettings, upsertThinkingMessage, renderHistoryList, updateSendState, postToNative, clearThinkingMessage, } = options;
    const requestAgentRun = (chatId, message, parts, contextPayload, draft) => {
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
            draft,
            optimisticRow: chat.messages[chat.messages.length - 1],
            parts: Array.isArray(parts) ? parts : undefined,
            contextPayload: contextToSend,
        });
        chat.statusMessage = aiText("status_thinking");
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
            pendingAgentRequests.delete(chat.id);
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
