import type { AgentSettings } from "./types.js";
import type { ChatState } from "./ai-chat-state.js";

export type AiRequestPart = {
  text?: string;
  inlineData?: { mimeType: string; data: string };
};

export type PendingAiRequest = {
  message: string;
  parts?: AiRequestPart[];
  contextPayload?: Record<string, unknown>;
};

type CreateAiChatRunnerOptions = {
  isAiBlocked: () => boolean;
  needsLogin: () => boolean;
  requestAiAccessCheck: (force?: boolean) => void;
  requestPlatformUsage: (force?: boolean) => void;
  updateStatusDisplay: () => void;
  ensureChat: (chatId?: string | null) => ChatState | null;
  runningConversations: Set<string>;
  pendingAgentRequests: Map<string, PendingAiRequest>;
  buildContextPayload: (settings: AgentSettings | null) => Record<string, unknown>;
  getAgentSettings: () => AgentSettings | null;
  upsertThinkingMessage: (chatId?: string | null, text?: string) => void;
  renderHistoryList: () => void;
  updateSendState: () => void;
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  clearThinkingMessage: (chatId?: string | null) => void;
  restoreDraftFromPending: (chatId: string, request: PendingAiRequest | null) => void;
};

export const createAiChatRunner = (options: CreateAiChatRunnerOptions) => {
  const {
    isAiBlocked,
    needsLogin,
    requestAiAccessCheck,
    requestPlatformUsage,
    updateStatusDisplay,
    ensureChat,
    runningConversations,
    pendingAgentRequests,
    buildContextPayload,
    getAgentSettings,
    upsertThinkingMessage,
    renderHistoryList,
    updateSendState,
    postToNative,
    clearThinkingMessage,
    restoreDraftFromPending,
  } = options;

  const requestAgentRun = (
    chatId: string,
    message: string,
    parts?: AiRequestPart[],
    contextPayload?: Record<string, unknown>
  ) => {
    if (isAiBlocked() || needsLogin()) {
      requestAiAccessCheck(true);
      requestPlatformUsage(true);
      updateStatusDisplay();
      return false;
    }
    const hasText = typeof message === "string" && message.trim().length > 0;
    const hasParts = Array.isArray(parts) && parts.length > 0;
    if (!hasText && !hasParts) return false;
    const chat = ensureChat(chatId);
    if (!chat) return false;
    if (runningConversations.has(chat.id)) return false;
    const contextToSend = contextPayload ?? buildContextPayload(getAgentSettings());
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
      const pending = pendingAgentRequests.get(chat.id) ?? null;
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
