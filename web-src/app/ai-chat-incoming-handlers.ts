import type {
  AgentProposal,
  AgentStatusState,
  AgentUiState,
} from "./types.js";
import type { ChatMessage, ChatState } from "./ai-chat-state.js";
import type { PendingAiRequest } from "./ai-chat-runner.js";
import { updateMessageElement } from "./ai-chat-message.js";
import { aiText, localizeAgentStatus, localizeToolLabel } from "./ai-i18n.js";

type StreamingEntry = { message: ChatMessage; element: HTMLElement | null };
type ThinkingEntry = { text: string; element: HTMLElement | null };

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
  scrollToBottom: (force?: boolean) => void;
  appendMessage: (message: ChatMessage, chatId?: string) => void;
  scheduleUsageRefresh: (force?: boolean) => void;
  rebuildProposalCards: (chatId: string) => void;
  restoreDraftFromPending: (chatId: string, request: PendingAiRequest | null) => void;
  updateContextBar: () => void;
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
    scheduleUsageRefresh,
    rebuildProposalCards,
    restoreDraftFromPending,
    updateContextBar,
    switchActiveChat,
  } = options;

  // バックグラウンドでDoneしたエージェントのトースト通知
  const showCompletionToast = (chatId: string, isError: boolean) => {
    const chat = getChat(chatId);
    if (!chat || chat.id === getActiveChatId()) return;
    const existing = document.querySelector(".ai-bg-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = `ai-bg-toast${isError ? " is-error" : ""}`;
    const label = document.createElement("span");
    label.textContent = `${chat.title || "Chat"}: ${aiText(isError ? "toast_issues" : "toast_done")}`;
    toast.appendChild(label);
    if (switchActiveChat) {
      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "ai-bg-toast-action";
      viewBtn.textContent = aiText("toast_view");
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
      if (statusState === "running" || statusState === "stopping") {
        runningConversations.add(chat.id);
        chat.statusMessage = localizeAgentStatus(
          statusMessage ||
            (statusState === "stopping" ? "Finishing partial changes..." : "Thinking..."),
        );
        upsertThinkingMessage(chat.id, chat.statusMessage);
      } else if (statusState === "error" || statusState === "resumable") {
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

  const handleStatus = (state: AgentStatusState, message?: string, conversationId?: string) => {
    if (!conversationId) return;
    const chat = ensureChat(conversationId);
    if (!chat) return;
    if (state === "running" || state === "stopping") {
      runningConversations.add(chat.id);
      resumableConversations.delete(chat.id);
      chat.statusMessage = localizeAgentStatus(
        message || (state === "stopping" ? "Finishing partial changes..." : "Thinking..."),
      );
      upsertThinkingMessage(chat.id, chat.statusMessage);
    } else {
      runningConversations.delete(chat.id);
      chat.statusMessage = "";
      clearThinkingMessage(chat.id);
      if (state === "resumable") {
        // A new provider turn always requires the explicit Resume action.
        // This prevents compile/conflict failures (and processing limits) from
        // silently consuming more API quota in a retry loop.
        resumableConversations.add(chat.id);
      } else if (state === "error") {
        resumableConversations.add(chat.id);
      } else {
        resumableConversations.delete(chat.id);
      }
      const pending = pendingAgentRequests.get(chat.id) ?? null;
      pendingAgentRequests.delete(chat.id);
      if ((state === "error" || state === "resumable") && pending) {
        restoreDraftFromPending(chat.id, pending);
      }
      showCompletionToast(
        chat.id,
        state === "error" || state === "resumable",
      );
      scheduleUsageRefresh(true);
    }
    renderHistoryList();
    updateSendState();
    if (chat.id === getActiveChatId()) updateStatusDisplay();
  };

  const handleMessage = (text: string, conversationId?: string) => {
    if (!conversationId) return;
    clearThinkingMessage(conversationId);
    if (finalizeStreamingMessage(conversationId, text)) scrollToBottom();
    else appendMessage({ role: "assistant", text }, conversationId);
    renderHistoryList();
    ensureChat(conversationId);
    updateStatusDisplay();
    scheduleUsageRefresh(true);
  };

  // Streaming deltas arrive far faster than the display refreshes, and each
  // render re-parses the whole message (markdown + KaTeX). Coalesce renders
  // to one per animation frame; the final agent:message repaints anyway.
  const pendingDeltaRenders = new Set<string>();

  const handleMessageDelta = (text: string, conversationId?: string) => {
    if (!conversationId || !text) return;
    const chatId = conversationId;
    clearThinkingMessage(chatId);
    const entry = ensureStreamingMessage(chatId);
    if (!entry) return;
    entry.message.text += text;
    if (pendingDeltaRenders.has(chatId)) return;
    pendingDeltaRenders.add(chatId);
    requestAnimationFrame(() => {
      pendingDeltaRenders.delete(chatId);
      const current = streamingMessages.get(chatId);
      if (!current) return;
      updateMessageElement(current.element, current.message.text);
      scrollToBottom();
    });
  };

  const handleTool = (payload: {
    name: string;
    label?: string;
    detail?: string;
    summary?: string;
    conversationId?: string;
  }) => {
    if (!payload.conversationId) return;
    const chat = ensureChat(payload.conversationId);
    if (!chat || !runningConversations.has(chat.id)) return;
    const fallback =
      typeof payload.label === "string" && payload.label.trim().length > 0
        ? payload.label.trim()
        : aiText("status_thinking");
    const label = localizeToolLabel(payload.name, fallback);
    // Append the tool target (file path, command, query…) so the activity
    // line says WHAT is being worked on, e.g. "Reading file — main.tex".
    const detail =
      typeof payload.detail === "string" && payload.detail.trim().length > 0
        ? payload.detail.trim()
        : "";
    chat.statusMessage = detail ? `${label} — ${detail}` : label;
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
      // Clear the editor's Undo/Confirm bar so it stays in sync with
      // the chat-side proposal state. Without this, confirming in the
      // chat panel leaves a stale Undo/Confirm bar in the editor.
      const editorBar = document.getElementById("ai-undo-keep-bar");
      if (editorBar) editorBar.remove();
      renderHistoryList();
      updateSendState();
    } else {
      appendMessage(
        {
          role: "system",
          text: payload.error || "The proposed change could not be applied.",
        },
        chat.id,
      );
      renderHistoryList();
      updateSendState();
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
      const chat = getChat(targetChatId);
      if (chat) {
        appendMessage(
          {
            role: "system",
            text: payload.message || "The change could not be undone.",
          },
          chat.id,
        );
        renderHistoryList();
        updateSendState();
      }
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
    chat.statusMessage = aiText("status_thinking");
    upsertThinkingMessage(chat.id, chat.statusMessage);
  };

  const handleThought = (payload: { text: string; conversationId?: string }) => {
    if (!payload.conversationId) return;
    const chat = ensureChat(payload.conversationId);
    if (!chat || !runningConversations.has(chat.id)) return;
    chat.statusMessage = aiText("status_thinking");
    upsertThinkingMessage(chat.id, chat.statusMessage);
  };

  const handleError = (message: string, conversationId?: string) => {
    if (!conversationId) return;
    const chat = ensureChat(conversationId);
    if (chat) {
      // agent:error is diagnostic and may arrive while a Codex/OpenPrism turn
      // continues. Only terminal agent:status owns the run lock and draft
      // restoration; unlocking here permits a second request to be dropped or
      // to race unfinished file settlement.
      chat.statusMessage = message;
      upsertThinkingMessage(chat.id, message);
    }
    renderHistoryList();
    updateSendState();
    updateStatusDisplay();
  };

  const handleRequestRejected = (payload: {
    conversationId?: string;
    message?: string;
  }) => {
    if (!payload.conversationId) return;
    const chat = getChat(payload.conversationId);
    const pending = pendingAgentRequests.get(payload.conversationId) ?? null;
    if (!chat || !pending) return;
    pendingAgentRequests.delete(payload.conversationId);
    // submitMessage adds this optimistic user row immediately before posting.
    // The host rejected that post, so remove exactly the newest user row and
    // restore its draft without unlocking the operation already in progress.
    for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
      if (chat.messages[index]?.role !== "user") continue;
      chat.messages.splice(index, 1);
      break;
    }
    restoreDraftFromPending(chat.id, pending);
    if (chat.id === getActiveChatId()) renderChatContent();
    renderHistoryList();
    updateSendState();
    updateStatusDisplay();
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
    handleRequestRejected,
  };
};
