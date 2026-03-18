import type {
  AgentProposal,
  AgentStatusState,
  AgentUiState,
} from "./types.js";
import { AUTONOMOUS_LOOP_LIMIT, type ChatMessage, type ChatState } from "./ai-chat-state.js";
import type { PendingAiRequest } from "./ai-chat-runner.js";
import { updateMessageElement } from "./ai-chat-message.js";

type StreamingEntry = { message: ChatMessage; element: HTMLElement | null };
type ThinkingEntry = { text: string; element: HTMLElement | null };

type CreateAiChatIncomingHandlersOptions = {
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
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
  enableAutonomous: (chat: ChatState) => void;
  scheduleUsageRefresh: (force?: boolean) => void;
  rebuildProposalCards: (chatId: string) => void;
  restoreDraftFromPending: (chatId: string, request: PendingAiRequest | null) => void;
  updateContextBar: () => void;
  buildContextPayload: (settings: unknown) => Record<string, unknown>;
  getAgentSettings: () => unknown;
  switchActiveChat?: (chatId: string) => void;
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
    enableAutonomous,
    scheduleUsageRefresh,
    rebuildProposalCards,
    restoreDraftFromPending,
    updateContextBar,
    buildContextPayload,
    getAgentSettings,
    postToNative,
    switchActiveChat,
  } = options;

  const AUTONOMOUS_RESUME_DELAY_MS = 600;

  // バックグラウンドで完了したエージェントのトースト通知
  const showCompletionToast = (chatId: string, isError: boolean) => {
    const chat = getChat(chatId);
    if (!chat || chat.id === getActiveChatId()) return;
    const existing = document.querySelector(".ai-bg-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = `ai-bg-toast${isError ? " is-error" : ""}`;
    const label = document.createElement("span");
    label.textContent = isError
      ? `${chat.title || "チャット"}: エラー`
      : `${chat.title || "チャット"}: 完了`;
    toast.appendChild(label);
    if (switchActiveChat) {
      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "ai-bg-toast-action";
      viewBtn.textContent = "表示";
      viewBtn.addEventListener("click", () => {
        switchActiveChat(chat.id);
        toast.remove();
      });
      toast.appendChild(viewBtn);
    }
    const chatContainer = document.getElementById("ai-chat");
    if (chatContainer) {
      chatContainer.prepend(toast);
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 6000);
    }
  };

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
      chat.appliedProposalIds.clear();
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
        if ((proposal as AgentProposal & { autoApplied?: boolean }).autoApplied === true) {
          chat.appliedProposalIds.add(proposal.id);
        }
      });

      const statusState = session.status?.state;
      const statusMessage =
        typeof session.status?.message === "string" ? session.status.message : "";
      chat.hasUndo = session.status?.undoAvailable === true;
      if (statusState === "running") {
        runningConversations.add(chat.id);
        chat.statusMessage = statusMessage || "考えています...";
        upsertThinkingMessage(chat.id, chat.statusMessage);
      } else if (statusState === "error") {
        resumableConversations.add(chat.id);
        chat.statusMessage = "";
      } else {
        chat.statusMessage = "";
      }
    });

    // Always start with a fresh "new chat" view (history remains accessible)
    renderHistoryList();
    updateSendState();
    updateStatusDisplay();
  };

  const tryAutonomousContinuation = (chat: ChatState) => {
    if (!chat.autonomous || chat.autoLoopBudget <= 0) return false;
    chat.autoLoopBudget -= 1;
    chat.statusMessage = "作業中...";
    runningConversations.add(chat.id);
    resumableConversations.delete(chat.id);
    upsertThinkingMessage(chat.id, chat.statusMessage);
    renderHistoryList();
    updateSendState();
    updateStatusDisplay();
    const contextToSend = buildContextPayload(getAgentSettings());
    window.setTimeout(() => {
      const posted = postToNative(
        { type: "agent:resume", conversationId: chat.id, context: contextToSend },
        true
      );
      if (!posted) {
        runningConversations.delete(chat.id);
        resumableConversations.add(chat.id);
        chat.statusMessage = "";
        clearThinkingMessage(chat.id);
        renderHistoryList();
        updateSendState();
        updateStatusDisplay();
      }
    }, AUTONOMOUS_RESUME_DELAY_MS);
    return true;
  };

  const handleStatus = (state: AgentStatusState, message?: string, conversationId?: string) => {
    if (!conversationId) return;
    const chat = ensureChat(conversationId);
    if (!chat) return;
    if (state === "running") {
      runningConversations.add(chat.id);
      resumableConversations.delete(chat.id);
      chat.statusMessage = message || "考えています...";
      upsertThinkingMessage(chat.id, chat.statusMessage);
    } else {
      runningConversations.delete(chat.id);
      chat.statusMessage = "";
      clearThinkingMessage(chat.id);
      if (state === "resumable") {
        // max_iterations reached — try autonomous continuation
        if (tryAutonomousContinuation(chat)) {
          // auto-continuation started, skip marking as idle
          return;
        }
        // fallback: mark as resumable for manual resume button
        resumableConversations.add(chat.id);
      } else if (state === "error") {
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
    if (!conversationId) return;
    clearThinkingMessage(conversationId);
    pendingAgentRequests.delete(conversationId);
    if (finalizeStreamingMessage(conversationId, text)) scrollToBottom();
    else appendMessage({ role: "assistant", text }, conversationId);
    runningConversations.delete(conversationId);
    resumableConversations.delete(conversationId);
    updateSendState();
    renderHistoryList();
    // バックグラウンド会話の完了トースト
    if (conversationId !== getActiveChatId()) {
      showCompletionToast(conversationId, false);
    }
    const chat = ensureChat(conversationId);
    if (chat) chat.statusMessage = "";
    updateStatusDisplay();
    scheduleUsageRefresh(true);
  };

  const handleMessageDelta = (text: string, conversationId?: string) => {
    if (!conversationId || !text) return;
    const chatId = conversationId;
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
    if (!payload.conversationId) return;
    const chat = ensureChat(payload.conversationId);
    if (!chat || !runningConversations.has(chat.id)) return;
    const label =
      typeof payload.label === "string" && payload.label.trim().length > 0
        ? payload.label.trim()
        : "考えています...";
    // Filter out internal status values — only show the label
    chat.statusMessage = label;
    upsertThinkingMessage(chat.id, chat.statusMessage);
    if (chat.id === getActiveChatId()) updateStatusDisplay();
  };

  const handleProposal = (proposal: AgentProposal) => {
    if (!proposal.conversationId) return;
    const chat = ensureChat(proposal.conversationId);
    if (!chat) return;
    chat.proposals.set(proposal.id, proposal);
    proposalIndex.set(proposal.id, chat.id);
    if ((proposal as AgentProposal & { autoApplied?: boolean }).autoApplied === true) {
      chat.appliedProposalIds.add(proposal.id);
    }
    renderHistoryList();
    if (chat.id === getActiveChatId()) {
      rebuildProposalCards(chat.id);
      scrollToBottom();
    }
  };

  const handleApplyResult = (payload: {
    proposalId: string;
    ok: boolean;
    error?: string;
    conflict?: boolean;
    conversationId?: string;
  }) => {
    const chatId = proposalIndex.get(payload.proposalId) ?? payload.conversationId;
    const chat = getChat(chatId);
    if (!chat) return;
    if (payload.ok) {
      chat.hasUndo = true;
      const proposal = chat.proposals.get(payload.proposalId);
      if (!proposal) {
        // Auto-apply with no proposal card — just update undo state
        renderHistoryList();
        updateSendState();
        return;
      }
      chat.appliedProposalIds.add(payload.proposalId);
      if (chat.id === getActiveChatId()) {
        rebuildProposalCards(chat.id);
      }
      renderHistoryList();
      updateSendState();
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
    const targetChatId = payload.conversationId ?? getActiveChatId();
    if (payload.ok) {
      const chat = getChat(targetChatId);
      if (chat) {
        if (payload.path) {
          for (const [pid, proposal] of chat.proposals) {
            if (proposal.path === payload.path) {
              chat.appliedProposalIds.delete(pid);
            }
          }
        } else {
          chat.appliedProposalIds.clear();
        }
        if (chat.id === getActiveChatId()) {
          rebuildProposalCards(chat.id);
        }
        renderHistoryList();
        updateSendState();
      }
    } else {
      appendMessage({ role: "system", text: `取り消し失敗: ${payload.message ?? "取り消せる操作がありません。"}` }, targetChatId);
    }
    updateContextBar();
  };

  const handleUndoAvailability = (payload: {
    conversationId?: string;
    available?: boolean;
    count?: number;
  }) => {
    const targetChat = ensureChat(payload.conversationId);
    if (!targetChat) {
      return;
    }
    targetChat.hasUndo = payload.available === true || (typeof payload.count === "number" && payload.count > 0);
    renderHistoryList();
    updateSendState();
    if (targetChat.id === getActiveChatId()) {
      updateStatusDisplay();
    }
  };

  const handleScratchpad = (payload: { content: string; conversationId?: string }) => {
    if (!payload.conversationId) return;
    const chat = ensureChat(payload.conversationId);
    if (!chat || !runningConversations.has(chat.id)) return;
    chat.statusMessage = "考えています...";
    upsertThinkingMessage(chat.id, chat.statusMessage);
  };

  const handleThought = (payload: { text: string; conversationId?: string }) => {
    if (!payload.conversationId) return;
    const chat = ensureChat(payload.conversationId);
    if (!chat || !runningConversations.has(chat.id)) return;
    chat.statusMessage = "考えています...";
    upsertThinkingMessage(chat.id, chat.statusMessage);
  };

  const handleError = (message: string, conversationId?: string) => {
    if (!conversationId) return;
    appendMessage({ role: "system", text: message }, conversationId);
    const chat = ensureChat(conversationId);
    if (chat) {
      chat.statusMessage = "";
      disableAutonomous(chat.id);
      resumableConversations.add(chat.id);
      clearThinkingMessage(chat.id);
    }
    streamingMessages.delete(conversationId);
    const pending = pendingAgentRequests.get(conversationId) ?? null;
    pendingAgentRequests.delete(conversationId);
    restoreDraftFromPending(conversationId, pending);
    runningConversations.delete(conversationId);
    renderHistoryList();
    updateSendState();
    // バックグラウンド会話のエラートースト
    if (conversationId !== getActiveChatId()) {
      showCompletionToast(conversationId, true);
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
    handleUndoAvailability,
    handleScratchpad,
    handleThought,
    handleError,
  };
};
