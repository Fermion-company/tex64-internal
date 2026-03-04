import type {
  AgentProposal,
  AgentStatusState,
  AgentUiState,
} from "./types.js";
import type { ChatMessage, ChatState } from "./ai-chat-state.js";
import { updateMessageElement } from "./ai-chat-message.js";

type StreamingEntry = { message: ChatMessage; element: HTMLElement | null };
type ThinkingEntry = { text: string; element: HTMLElement | null };

type PendingAiRequest = {
  message: string;
  parts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
  contextPayload?: Record<string, unknown>;
};

type CreateAiChatIncomingHandlersOptions = {
  chats: ChatState[];
  chatIndex: Map<string, ChatState>;
  proposalIndex: Map<string, string>;
  runningConversations: Set<string>;
  resumableConversations: Set<string>;
  streamingMessages: Map<string, StreamingEntry>;
  thinkingMessages: Map<string, ThinkingEntry>;
  pendingAgentRequests: Map<string, PendingAiRequest>;
  getActiveChatId: () => string | null;
  setActiveChatId: (chatId: string | null) => void;
  ensureChat: (chatId?: string | null) => ChatState | null;
  getChat: (chatId?: string | null) => ChatState | null;
  setChatTitle: (chat: ChatState) => void;
  clearPendingAttachments: () => void;
  renderHistoryList: () => void;
  renderChatContent: () => void;
  updateSendState: () => void;
  updateStatusDisplay: () => void;
  upsertThinkingMessage: (chatId?: string | null, text?: string) => void;
  clearThinkingMessage: (chatId?: string | null) => void;
  finalizeStreamingMessage: (chatId: string, text: string) => boolean;
  ensureStreamingMessage: (chatId: string) => StreamingEntry | null;
  scrollToBottom: () => void;
  appendMessage: (message: ChatMessage, chatId?: string) => void;
  disableAutonomous: (chatId?: string | null) => void;
  scheduleUsageRefresh: (force?: boolean) => void;
  ensureProposalsEmbedded: () => HTMLElement | null;
  buildProposalCard: (proposal: AgentProposal) => HTMLElement;
  getProposalsContainer: () => HTMLElement | null;
  restoreDraftFromPending: (chatId: string, request: PendingAiRequest | null) => void;
  updateContextBar: () => void;
};

export const createAiChatIncomingHandlers = (
  options: CreateAiChatIncomingHandlersOptions
) => {
  const {
    chats,
    chatIndex,
    proposalIndex,
    runningConversations,
    resumableConversations,
    streamingMessages,
    thinkingMessages,
    pendingAgentRequests,
    getActiveChatId,
    setActiveChatId,
    ensureChat,
    getChat,
    setChatTitle,
    clearPendingAttachments,
    renderHistoryList,
    renderChatContent,
    updateSendState,
    updateStatusDisplay,
    upsertThinkingMessage,
    clearThinkingMessage,
    finalizeStreamingMessage,
    ensureStreamingMessage,
    scrollToBottom,
    appendMessage,
    disableAutonomous,
    scheduleUsageRefresh,
    ensureProposalsEmbedded,
    buildProposalCard,
    getProposalsContainer,
    restoreDraftFromPending,
    updateContextBar,
  } = options;

  const handleState = (state: AgentUiState) => {
    const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
    if (sessions.length === 0) {
      return;
    }
    sessions.sort((a, b) => {
      const aUpdated = typeof a?.updatedAt === "number" ? a.updatedAt : 0;
      const bUpdated = typeof b?.updatedAt === "number" ? b.updatedAt : 0;
      return aUpdated - bUpdated;
    });

    chats.splice(0, chats.length);
    chatIndex.clear();
    proposalIndex.clear();
    runningConversations.clear();
    resumableConversations.clear();
    streamingMessages.clear();
    thinkingMessages.clear();

    setActiveChatId(null);
    clearPendingAttachments();

    sessions.forEach((session) => {
      if (!session || typeof session !== "object") {
        return;
      }
      const conversationId =
        typeof session.conversationId === "string" && session.conversationId.trim()
          ? session.conversationId.trim()
          : "";
      if (!conversationId) {
        return;
      }
      const chat = ensureChat(conversationId);
      if (!chat) {
        return;
      }
      if (typeof session.title === "string" && session.title.trim()) {
        chat.title = session.title.trim();
      }
      const restoredMessages = Array.isArray(session.messages) ? session.messages : [];
      chat.messages = restoredMessages
        .filter((msg) => msg && typeof msg === "object")
        .map((msg): ChatMessage => ({
          role: msg.role === "assistant" ? "assistant" : "user",
          text: typeof msg.text === "string" ? msg.text : "",
        }))
        .filter((msg) => msg.text.trim().length > 0);

      chat.proposals.clear();
      const restoredProposals = Array.isArray(session.proposals) ? session.proposals : [];
      restoredProposals.forEach((proposal) => {
        if (!proposal || typeof proposal !== "object") {
          return;
        }
        if (typeof proposal.id !== "string" || !proposal.id) {
          return;
        }
        chat.proposals.set(proposal.id, proposal as AgentProposal);
        proposalIndex.set(proposal.id, chat.id);
      });

      const statusState = session.status?.state;
      const statusMessage =
        typeof session.status?.message === "string" ? session.status.message : "";
      if (statusState === "running") {
        runningConversations.add(chat.id);
        chat.statusMessage = statusMessage || "思考中...";
        upsertThinkingMessage(chat.id, chat.statusMessage);
      } else if (statusState === "error") {
        resumableConversations.add(chat.id);
        chat.statusMessage = "";
      } else {
        chat.statusMessage = "";
      }
    });

    const latest = sessions[sessions.length - 1];
    if (latest && typeof latest.conversationId === "string") {
      const chat = getChat(latest.conversationId);
      if (chat) {
        setActiveChatId(chat.id);
        setChatTitle(chat);
        renderChatContent();
      }
    }
    renderHistoryList();
    updateSendState();
    updateStatusDisplay();
  };

  const handleStatus = (state: AgentStatusState, message?: string, conversationId?: string) => {
    const chat = ensureChat(conversationId);
    if (!chat) return;
    if (state === "running") {
      runningConversations.add(chat.id);
      resumableConversations.delete(chat.id);
      chat.statusMessage = message || "思考中...";
      upsertThinkingMessage(chat.id, chat.statusMessage);
    } else {
      runningConversations.delete(chat.id);
      chat.statusMessage = "";
      clearThinkingMessage(chat.id);
      if (state === "error") {
        resumableConversations.add(chat.id);
      } else {
        resumableConversations.delete(chat.id);
      }
      scheduleUsageRefresh(true);
    }
    renderHistoryList();
    updateSendState();
    if (chat.id === getActiveChatId()) updateStatusDisplay();
  };

  const handleMessage = (text: string, conversationId?: string) => {
    clearThinkingMessage(conversationId);
    if (conversationId) {
      pendingAgentRequests.delete(conversationId);
    }
    if (conversationId && finalizeStreamingMessage(conversationId, text)) scrollToBottom();
    else appendMessage({ role: "assistant", text }, conversationId);
    if (conversationId) {
      runningConversations.delete(conversationId);
      updateSendState();
      renderHistoryList();
    }
    const chat = ensureChat(conversationId);
    if (chat) chat.statusMessage = "";
    updateStatusDisplay();
    scheduleUsageRefresh(true);
  };

  const handleMessageDelta = (text: string, conversationId?: string) => {
    const chatId = conversationId ?? getActiveChatId();
    if (!chatId || !text) return;
    clearThinkingMessage(chatId);
    const entry = ensureStreamingMessage(chatId);
    if (!entry) return;
    entry.message.text += text;
    updateMessageElement(entry.element, entry.message.text);
    scrollToBottom();
  };

  const handleTool = (payload: {
    name: string;
    label?: string;
    summary?: string;
    conversationId?: string;
  }) => {
    const chat = ensureChat(payload.conversationId);
    if (!chat || !runningConversations.has(chat.id)) return;
    const label =
      typeof payload.label === "string" && payload.label.trim().length > 0
        ? payload.label.trim()
        : payload.name;
    const summary =
      typeof payload.summary === "string" && payload.summary.trim().length > 0 && payload.summary !== "ok"
        ? payload.summary.trim()
        : "";
    chat.statusMessage = summary ? `${label} (${summary})` : label;
    upsertThinkingMessage(chat.id, chat.statusMessage);
    if (chat.id === getActiveChatId()) updateStatusDisplay();
  };

  const handleProposal = (proposal: AgentProposal) => {
    const chat = ensureChat(proposal.conversationId);
    if (!chat) return;
    chat.proposals.set(proposal.id, proposal);
    proposalIndex.set(proposal.id, chat.id);
    renderHistoryList();
    if (chat.id === getActiveChatId()) {
      const proposals = ensureProposalsEmbedded();
      if (proposals) {
        proposals.classList.remove("is-hidden");
        proposals.appendChild(buildProposalCard(proposal));
      }
      scrollToBottom();
    }
  };

  const handleApplyResult = (payload: {
    proposalId: string;
    ok: boolean;
    error?: string;
    conflict?: boolean;
  }) => {
    const chatId = proposalIndex.get(payload.proposalId);
    const chat = getChat(chatId);
    if (!chat) return;
    const proposal = chat.proposals.get(payload.proposalId);
    if (!proposal) return;
    if (payload.ok) {
      chat.proposals.delete(payload.proposalId);
      proposalIndex.delete(payload.proposalId);
      if (chat.id === getActiveChatId()) {
        const proposalsContainer = getProposalsContainer();
        proposalsContainer?.querySelector(`[data-proposal-id="${payload.proposalId}"]`)?.remove();
        if (proposalsContainer && chat.proposals.size === 0) {
          proposalsContainer.classList.add("is-hidden");
        }
      }
      appendMessage({ role: "system", text: `適用完了: ${proposal.path}` }, chat.id);
      renderHistoryList();
    } else {
      const label = payload.conflict ? "適用競合" : "適用失敗";
      appendMessage({ role: "system", text: `${label}: ${payload.error ?? "不明なエラー"}` }, chat.id);
    }
  };

  const handleUndoResult = (payload: {
    ok: boolean;
    message?: string;
    path?: string;
    conversationId?: string;
  }) => {
    const targetChatId = payload.conversationId ?? getActiveChatId() ?? undefined;
    const line = payload.ok
      ? `取り消し完了: ${payload.path ?? payload.message ?? "直前の適用を戻しました。"}`
      : `取り消し失敗: ${payload.message ?? "取り消せる操作がありません。"}`;
    appendMessage({ role: "system", text: line }, targetChatId);
    updateContextBar();
  };

  const handleError = (message: string, conversationId?: string) => {
    appendMessage({ role: "system", text: message }, conversationId);
    const chat = ensureChat(conversationId);
    if (chat) {
      chat.statusMessage = "";
      disableAutonomous(chat.id);
      resumableConversations.add(chat.id);
      clearThinkingMessage(chat.id);
    }
    if (conversationId) streamingMessages.delete(conversationId);
    if (conversationId) {
      const pending = pendingAgentRequests.get(conversationId) ?? null;
      pendingAgentRequests.delete(conversationId);
      restoreDraftFromPending(conversationId, pending);
    }
    if (conversationId) {
      runningConversations.delete(conversationId);
      renderHistoryList();
      updateSendState();
    }
    updateStatusDisplay();
    scheduleUsageRefresh(true);
  };

  return {
    handleState,
    handleStatus,
    handleMessage,
    handleMessageDelta,
    handleTool,
    handleProposal,
    handleApplyResult,
    handleUndoResult,
    handleError,
  };
};
