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
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  dismissProposal: (proposalId: string) => void;
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
  ensureProposalsEmbedded: () => HTMLElement | null;
  buildProposalCard: (proposal: AgentProposal) => HTMLElement;
  getProposalsContainer: () => HTMLElement | null;
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
    ensureProposalsEmbedded,
    buildProposalCard,
    getProposalsContainer,
    restoreDraftFromPending,
    updateContextBar,
    buildContextPayload,
    getAgentSettings,
    postToNative,
    dismissProposal,
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
      chat.hasUndo = session.status?.undoAvailable === true;
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

    // Always start with a fresh "new chat" view (history remains accessible)
    renderHistoryList();
    updateSendState();
    updateStatusDisplay();
  };

  const AUTONOMOUS_LOOP_LIMIT = 100;

  const tryAutonomousContinuation = (chat: ChatState) => {
    if (!chat.autonomous || chat.autoLoopBudget <= 0) return false;
    chat.autoLoopBudget -= 1;
    const round = AUTONOMOUS_LOOP_LIMIT - chat.autoLoopBudget;
    chat.statusMessage = `自動継続中 (ラウンド ${round}/${AUTONOMOUS_LOOP_LIMIT})`;
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
    clearThinkingMessage(conversationId);
    // Mark any open tool log as completed
    const msgChat = ensureChat(conversationId);
    if (msgChat) {
      const toolLogPrefix = "\u{1F527} ";
      const openLogIdx = msgChat.messages.findIndex(
        (msg) => msg.role === "system" && msg.text.startsWith(toolLogPrefix) && !msg.text.includes("[完了]")
      );
      if (openLogIdx >= 0) {
        msgChat.messages[openLogIdx].text += "\n[完了]";
      }
      // Clear thought message for next turn
      const thoughtIdx = msgChat.messages.findIndex(
        (msg) => msg.role === "system" && msg.text.startsWith("\u{1F4AD} ")
      );
      if (thoughtIdx >= 0) {
        msgChat.messages.splice(thoughtIdx, 1);
      }
    }
    if (conversationId) {
      pendingAgentRequests.delete(conversationId);
    }
    if (conversationId && finalizeStreamingMessage(conversationId, text)) scrollToBottom();
    else appendMessage({ role: "assistant", text }, conversationId);
    if (conversationId) {
      runningConversations.delete(conversationId);
      updateSendState();
      renderHistoryList();
      // バックグラウンド会話の完了トースト
      if (conversationId !== getActiveChatId()) {
        showCompletionToast(conversationId, false);
      }
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
    // Append tool execution to a running tool log message
    const toolLogPrefix = "\u{1F527} ";
    const toolEntry = summary ? `${label}: ${summary}` : label;
    const existingLogIdx = chat.messages.findIndex(
      (msg) => msg.role === "system" && msg.text.startsWith(toolLogPrefix) && !msg.text.includes("[完了]")
    );
    if (existingLogIdx >= 0) {
      chat.messages[existingLogIdx].text += `\n${toolEntry}`;
    } else {
      chat.messages.push({ role: "system", text: `${toolLogPrefix}ツール実行ログ\n${toolEntry}` });
    }
    if (chat.id === getActiveChatId()) {
      renderChatContent();
      scrollToBottom();
    }
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
    conversationId?: string;
  }) => {
    const chatId = proposalIndex.get(payload.proposalId) ?? payload.conversationId;
    const chat = getChat(chatId);
    if (!chat) return;
    const proposal = chat.proposals.get(payload.proposalId);
    if (payload.ok) {
      chat.hasUndo = true;
      if (!proposal) {
        // Auto-apply: no proposal card, just update undo state
        renderHistoryList();
        updateSendState();
        return;
      }
      if (chat.id === getActiveChatId()) {
        const pc = getProposalsContainer();
        const cardEl = pc?.querySelector(`[data-proposal-id="${payload.proposalId}"]`);
        if (cardEl instanceof HTMLElement) {
          cardEl.classList.add("is-applied");
          const actionsEl = cardEl.querySelector(".ai-proposal-actions");
          if (actionsEl) {
            actionsEl.replaceChildren();
            const undoBtn = document.createElement("button");
            undoBtn.type = "button";
            undoBtn.className = "panel-button ghost";
            undoBtn.textContent = "取り消し";
            undoBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              postToNative({ type: "agent:undoLastApply", conversationId: chat.id });
            });
            actionsEl.appendChild(undoBtn);
          }
          const badgeEl = cardEl.querySelector(".ai-proposal-badge");
          if (badgeEl instanceof HTMLElement) {
            badgeEl.textContent = "適用済み";
            badgeEl.style.background = "rgba(99, 102, 241, 0.1)";
            badgeEl.style.color = "#818cf8";
            badgeEl.style.borderColor = "rgba(99, 102, 241, 0.2)";
          }
        }
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
    const targetChatId = payload.conversationId ?? getActiveChatId() ?? undefined;
    if (payload.ok) {
      const chat = getChat(targetChatId);
      if (chat && chat.id === getActiveChatId()) {
        const pc = getProposalsContainer();
        if (pc) {
          const cards = Array.from(pc.querySelectorAll(".ai-proposal.is-applied"));
          for (let ci = 0; ci < cards.length; ci++) {
            const cardEl = cards[ci];
            if (!(cardEl instanceof HTMLElement)) continue;
            const pid = cardEl.dataset.proposalId ?? "";
            const proposal = chat.proposals.get(pid);
            if (!proposal) continue;
            if (payload.path && proposal.path !== payload.path) continue;
            cardEl.classList.remove("is-applied");
            const badgeEl = cardEl.querySelector(".ai-proposal-badge");
            if (badgeEl instanceof HTMLElement) {
              const rawType = proposal.type || "write";
              const pType = rawType === "write" && proposal.isNewFile ? "new" : rawType;
              badgeEl.textContent = pType === "delete" ? "削除" : pType === "rename" ? "移動" : pType === "mkdir" ? "フォルダ" : pType === "new" ? "新規" : "編集";
              badgeEl.style.background = "";
              badgeEl.style.color = "";
              badgeEl.style.borderColor = "";
            }
            const actionsEl = cardEl.querySelector(".ai-proposal-actions");
            if (actionsEl) {
              actionsEl.replaceChildren();
              const previewBtn = document.createElement("button");
              previewBtn.type = "button";
              previewBtn.className = "panel-button ghost";
              previewBtn.textContent = "差分を見る";
              const cancelBtn = document.createElement("button");
              cancelBtn.type = "button";
              cancelBtn.className = "panel-button ghost";
              cancelBtn.textContent = "取り消し";
              cancelBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                postToNative({ type: "agent:proposal:dismiss", proposalId: pid }, true);
                dismissProposal(pid);
              });
              const applyBtn = document.createElement("button");
              applyBtn.type = "button";
              applyBtn.className = "panel-button";
              applyBtn.textContent = "適用";
              applyBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                postToNative({ type: "agent:apply", proposalId: pid });
              });
              actionsEl.append(previewBtn, cancelBtn, applyBtn);
            }
            break;
          }
        }
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
    const chat = ensureChat(payload.conversationId);
    if (!chat) return;
    const content = typeof payload.content === "string" ? payload.content.trim() : "";
    if (!content) return;
    // Show the scratchpad plan as a system message so users can see the agent's thinking
    const existingPlanIdx = chat.messages.findIndex(
      (msg) => msg.role === "system" && msg.text.startsWith("📋 ")
    );
    const planText = `📋 エージェント計画メモ\n\n${content}`;
    if (existingPlanIdx >= 0) {
      chat.messages[existingPlanIdx].text = planText;
    } else {
      chat.messages.push({ role: "system", text: planText });
    }
    if (chat.id === getActiveChatId()) {
      renderChatContent();
      scrollToBottom();
    }
  };

  const handleThought = (payload: { text: string; conversationId?: string }) => {
    const chat = ensureChat(payload.conversationId);
    if (!chat) return;
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) return;
    const existingIdx = chat.messages.findIndex(
      (msg) => msg.role === "system" && msg.text.startsWith("\u{1F4AD} ")
    );
    const thoughtText = `\u{1F4AD} 思考過程\n\n${text}`;
    if (existingIdx >= 0) {
      chat.messages[existingIdx].text = thoughtText;
    } else {
      chat.messages.push({ role: "system", text: thoughtText });
    }
    if (chat.id === getActiveChatId()) {
      renderChatContent();
      scrollToBottom();
    }
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
      // バックグラウンド会話のエラートースト
      if (conversationId !== getActiveChatId()) {
        showCompletionToast(conversationId, true);
      }
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
