import type {
  AgentNextStep,
  AgentPlan,
  AgentProposal,
  AgentQuestion,
  AgentStatusState,
  AgentUiState,
} from "./types.js";
import type { ChatMessage, ChatState } from "./ai-chat-state.js";
import type { PendingAiRequest } from "./ai-chat-runner.js";
import { setMessageRating, updateMessageElement } from "./ai-chat-message.js";
import { aiText, localizeAgentStatus, localizeToolLabel } from "./ai-i18n.js";

/** What arrives with a final reply besides its text. */
export type MessageExtras = {
  proposals?: AgentNextStep[];
  question?: AgentQuestion;
  plan?: AgentPlan;
};

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
  /** Sends the next request waiting behind a finished turn. */
  drainQueue?: (chatId: string) => void;
  /** Re-renders the open chat when a reply gained steps or a question. */
  refreshActiveChat?: () => void;
  /** Moves the running card's applied changes into a reply. */
  settleLiveProposals?: (chat: ChatState, target?: ChatMessage | null) => void;
  latestReplyWithChanges?: (chat: ChatState) => ChatMessage | null;
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
    drainQueue,
    refreshActiveChat,
    settleLiveProposals,
    latestReplyWithChanges,
  } = options;
  /** A chat created by "branch": opened as soon as the host lists it. */
  let pendingBranchTarget: string | null = null;

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

    // A snapshot arrives with every file-tree refresh, including the ones a
    // running turn causes by writing files. The open chat and its live turn
    // must survive that: keep what the chat already shows.
    const previousActiveId = getActiveChatId();
    const previousChats = new Map(chats.map((chat) => [chat.id, chat] as const));
    const previouslyRunning = new Set(runningConversations);

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
      chat.updatedAt = typeof session.updatedAt === "number" ? session.updatedAt : chat.updatedAt ?? null;
      chat.branchedFrom = typeof session.branchedFrom === "string" ? session.branchedFrom : null;
      const previous = previousChats.get(conversationId) ?? null;
      if (previous) chat.queue = previous.queue;
      const liveState = session.status?.state;
      const restoredMessages = (Array.isArray(session.messages) ? session.messages : [])
        .filter((msg) => msg && typeof msg === "object")
        .map((msg): ChatMessage => ({
          role: msg.role === "assistant" ? "assistant" : "user",
          text: typeof msg.text === "string" ? msg.text : "",
          ...(Array.isArray(msg.proposals) && msg.proposals.length > 0 ? { proposals: msg.proposals } : {}),
          ...(msg.question ? { question: msg.question } : {}),
          ...(msg.rating === "up" || msg.rating === "down" ? { rating: msg.rating } : {}),
          ...(msg.plan ? { plan: msg.plan } : {}),
        }))
        .filter((msg) => msg.text.trim().length > 0);
      // The chat already holds everything the host stores plus the work log
      // and the change cards, which the host does not send back. Keep the
      // local transcript unless the host has more than we do.
      const keepLocalTranscript =
        previous !== null &&
        (previouslyRunning.has(conversationId) ||
          liveState === "running" ||
          liveState === "stopping" ||
          previous.messages.length >= restoredMessages.length);
      chat.messages = keepLocalTranscript ? previous.messages : restoredMessages;
      if (keepLocalTranscript && previous) {
        // Ratings live on the host; the local transcript learns them here.
        let ordinal = 0;
        const restoredReplies = restoredMessages.filter((msg) => msg.role === "assistant");
        for (const msg of chat.messages) {
          if (msg.role !== "assistant") continue;
          const restored = restoredReplies[ordinal];
          ordinal += 1;
          if (restored?.rating && !msg.rating) msg.rating = restored.rating;
        }
      }

      chat.proposals.clear();
      chat.appliedProposalIds.clear();
      if (previous) {
        // Change cards come over the wire as the turn runs; the host keeps
        // only the ones still waiting, so the applied ones live here.
        previous.proposals.forEach((proposal, id) => {
          chat.proposals.set(id, proposal);
          proposalIndex.set(id, chat.id);
        });
        previous.appliedProposalIds.forEach((id) => chat.appliedProposalIds.add(id));
      }
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

    if (pendingBranchTarget && chatIndex.has(pendingBranchTarget) && switchActiveChat) {
      const target = pendingBranchTarget;
      pendingBranchTarget = null;
      switchActiveChat(target);
    } else if (previousActiveId && chatIndex.has(previousActiveId)) {
      // The chat that was open stays open, with its turn still shown.
      setActiveChatId(previousActiveId);
      renderChatContent();
      const active = chatIndex.get(previousActiveId);
      if (active && runningConversations.has(active.id)) {
        upsertThinkingMessage(active.id, active.statusMessage);
      }
    }
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
      // The host took the request: it is no longer an unsent draft, so a
      // later stop must not put it back into the composer.
      pendingAgentRequests.delete(chat.id);
      chat.statusMessage = localizeAgentStatus(
        message || (state === "stopping" ? "Finishing partial changes..." : "Thinking..."),
      );
      upsertThinkingMessage(chat.id, chat.statusMessage);
    } else {
      runningConversations.delete(chat.id);
      // A turn that ended in an error leaves its reason in the transcript as
      // one quiet line; the working line that carried it goes away.
      const failure = state === "error" ? chat.statusMessage.trim() : "";
      chat.statusMessage = "";
      clearThinkingMessage(chat.id);
      if (failure && failure !== localizeAgentStatus("Thinking...") && failure !== localizeAgentStatus("Preparing...")) {
        appendMessage({ role: "system", text: failure }, chat.id);
      }
      // Undo waits for the run to end; the cards learn that here.
      if (chat.id === getActiveChatId()) {
        rebuildProposalCards(chat.id);
        if (latestReplyWithChanges?.(chat)) refreshActiveChat?.();
      }
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
      chat.updatedAt = Date.now();
      // The next request waiting behind this turn goes out now.
      if (state !== "error") drainQueue?.(chat.id);
    }
    renderHistoryList();
    updateSendState();
    if (chat.id === getActiveChatId()) updateStatusDisplay();
  };

  const handleMessage = (text: string, conversationId?: string, extras: MessageExtras = {}) => {
    if (!conversationId) return;
    clearThinkingMessage(conversationId);
    const steps = Array.isArray(extras.proposals) && extras.proposals.length > 0 ? extras.proposals : undefined;
    const question = extras.question && typeof extras.question === "object" ? extras.question : undefined;
    const plan = extras.plan && typeof extras.plan === "object" && Array.isArray(extras.plan.steps) ? extras.plan : undefined;
    const streamed = streamingMessages.get(conversationId)?.message ?? null;
    const chat = getChat(conversationId);
    let reply: ChatMessage | null = null;
    if (finalizeStreamingMessage(conversationId, text)) {
      if (streamed) {
        if (steps) streamed.proposals = steps;
        if (question) streamed.question = question;
        if (plan) streamed.plan = plan;
        reply = streamed;
      }
      scrollToBottom();
    } else {
      const message: ChatMessage = { role: "assistant", text, ...(steps ? { proposals: steps } : {}), ...(question ? { question } : {}), ...(plan ? { plan } : {}) };
      appendMessage(message, conversationId);
      reply = message;
    }
    // The changes this turn wrote belong to this reply from now on.
    const hadChanges = Boolean(chat && chat.proposals.size > 0);
    if (chat && reply) settleLiveProposals?.(chat, reply);
    // Steps, questions and cards are part of the reply's element: draw the
    // chat again so the newest reply carries them (and older steps step back).
    if ((steps || question || plan || hadChanges) && conversationId === getActiveChatId()) refreshActiveChat?.();
    renderHistoryList();
    ensureChat(conversationId);
    updateStatusDisplay();
    scheduleUsageRefresh(true);
  };

  /** The host dropped a streamed reply (it claimed an edit that never ran). */
  const handleMessageReset = (payload: { conversationId?: string }) => {
    const chatId = payload?.conversationId;
    if (!chatId) return;
    const entry = streamingMessages.get(chatId);
    if (!entry) return;
    streamingMessages.delete(chatId);
    const chat = getChat(chatId);
    if (chat) {
      const index = chat.messages.indexOf(entry.message);
      if (index >= 0) chat.messages.splice(index, 1);
    }
    entry.element?.remove();
    if (chat && runningConversations.has(chat.id)) upsertThinkingMessage(chat.id, chat.statusMessage);
  };

  /** The model's title for a chat, once its first reply exists. */
  const handleTitle = (payload: { conversationId?: string; title?: string }) => {
    const chat = payload?.conversationId ? getChat(payload.conversationId) : null;
    const title = typeof payload?.title === "string" ? payload.title.trim() : "";
    if (!chat || !title) return;
    chat.title = title;
    if (chat.id === getActiveChatId()) setChatTitle(chat);
    renderHistoryList();
  };

  /** A rating went out (or failed): reflect it on the reply. */
  const handleFeedbackResult = (payload: {
    conversationId?: string;
    assistantIndex?: number;
    rating?: "up" | "down";
    ok?: boolean;
    error?: string;
  }) => {
    const chat = payload?.conversationId ? getChat(payload.conversationId) : null;
    if (!chat || typeof payload.assistantIndex !== "number") return;
    const replies = chat.messages.filter((msg) => msg.role === "assistant");
    const message = replies[payload.assistantIndex];
    if (!message) return;
    if (payload.ok) {
      message.rating = payload.rating;
    }
    if (chat.id === getActiveChatId()) {
      const element = document.querySelector<HTMLElement>(
        `.ai-message.is-assistant[data-assistant-index="${payload.assistantIndex}"]`,
      );
      setMessageRating(element, message.rating);
      const box = element?.querySelector<HTMLElement>(".ai-rate-box");
      if (box) {
        box.replaceChildren();
        box.classList.add("is-done");
        box.textContent = payload.ok ? aiText("rate_thanks") : payload.error || aiText("rate_thanks");
        window.setTimeout(() => box.remove(), payload.ok ? 1800 : 4000);
      }
    }
  };

  /** The host made the branch; open it as soon as the state lists it. */
  const handleBranchResult = (payload: { ok?: boolean; conversationId?: string; error?: string }) => {
    if (!payload?.ok || typeof payload.conversationId !== "string") return;
    pendingBranchTarget = payload.conversationId;
    if (chatIndex.has(payload.conversationId) && switchActiveChat) {
      pendingBranchTarget = null;
      switchActiveChat(payload.conversationId);
    }
  };

  /** The page a change landed on, once the build produced the PDF. */
  const handleProposalScope = (payload: { conversationId?: string; proposalId?: string; page?: number }) => {
    if (!payload?.proposalId || typeof payload.page !== "number") return;
    const chatId = proposalIndex.get(payload.proposalId) ?? payload.conversationId;
    const chat = getChat(chatId);
    if (!chat) return;
    const live = chat.proposals.get(payload.proposalId);
    const attached = chat.messages
      .flatMap((msg) => msg.changes ?? [])
      .find((change) => change.id === payload.proposalId);
    const proposal = live ?? attached;
    if (!proposal) return;
    proposal.scope = { ...(proposal.scope ?? { line: 1 }), page: payload.page };
    if (chat.id !== getActiveChatId()) return;
    if (live) rebuildProposalCards(chat.id);
    else refreshActiveChat?.();
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
    // Recording next steps or a question is bookkeeping, not work: it shows
    // as the steps themselves, not as a line in the work log.
    if (payload.name === "propose_next_steps" || payload.name === "ask_user") return;
    // The host names the tool; the words are ours.
    const label = localizeToolLabel(payload.name, aiText("status_working"));
    // Append the tool target (file path, command, query…) so the activity
    // line says WHAT is being worked on, e.g. "Reading file — main.tex".
    const detail =
      typeof payload.detail === "string" && payload.detail.trim().length > 0
        ? payload.detail.trim()
        : "";
    chat.statusMessage = detail ? `${label} — ${detail}` : label;
    upsertThinkingMessage(chat.id, chat.statusMessage);
    // The same activity also goes into the work log under the reply, once
    // per step: a tool reports when it starts and when it finishes.
    const traceLine = `\u{1F527} ${chat.statusMessage}`;
    const lastMessage = chat.messages[chat.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "system" || lastMessage.text !== traceLine) {
      appendMessage({ role: "system", text: traceLine }, chat.id);
    }
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
        // The run's changes are gone from disk; the card goes with them and
        // the transcript says so.
        for (const pid of chat.proposals.keys()) proposalIndex.delete(pid);
        chat.proposals.clear();
        chat.appliedProposalIds.clear();
        const reverted = latestReplyWithChanges?.(chat) ?? null;
        if (reverted) {
          for (const change of reverted.changes ?? []) proposalIndex.delete(change.id);
          delete reverted.changes;
        }
        chat.hasUndo = false;
        if (chat.id === getActiveChatId()) {
          rebuildProposalCards(chat.id);
          if (reverted) refreshActiveChat?.();
        }
        appendMessage({ role: "system", text: aiText("undo_done") }, chat.id);
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
      // The change card offers "Undo" only once the host says it can.
      rebuildProposalCards(targetChat.id);
      if (!runningConversations.has(targetChat.id) && latestReplyWithChanges?.(targetChat)) refreshActiveChat?.();
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
    handleTitle,
    handleMessageReset,
    handleFeedbackResult,
    handleBranchResult,
    handleProposalScope,
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
