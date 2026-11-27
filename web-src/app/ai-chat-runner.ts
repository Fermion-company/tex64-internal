import type { ComposerDraft } from "./ai-chat-draft-restore.js";
import type { AgentSettings } from "./types.js";
import type { ChatMessage, ChatState } from "./ai-chat-state.js";
import { aiText } from "./ai-i18n.js";

export type AiRequestPart = {
  text?: string;
  inlineData?: { mimeType: string; data: string };
};

export type PendingAiRequest = {
  message: string;
  draft?: ComposerDraft;
  optimisticRow?: ChatMessage;
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
  } = options;

  const requestAgentRun = (
    chatId: string,
    message: string,
    parts?: AiRequestPart[],
    contextPayload?: Record<string, unknown>,
    draft?: ComposerDraft,
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
