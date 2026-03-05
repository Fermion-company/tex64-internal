import type { AppContext } from "./context.js";
import type {
  AgentProposal,
  AgentSettings,
  AgentStatusState,
  AgentUiState,
  IssueItem,
  IssuesStatus,
  PlatformAiAccessSnapshot,
  PlatformAuthSnapshot,
  PlatformUsageSnapshot,
  PlatformUpdateSnapshot,
} from "./types.js";
import type { DiffContext } from "./diff-modal.js";
import {
  createChat as createChatState,
  ensureChat as ensureChatState,
  getChat as getChatState,
  type ChatMessage,
  type ChatState,
} from "./ai-chat-state.js";
import { createMessageElement, updateMessageElement } from "./ai-chat-message.js";
import { createProposalCard } from "./ai-chat-proposal.js";
import { TEX64_LINKS } from "./platform-links.js";
import { createAiChatStatusController } from "./ai-chat-status.js";
import { createContextPayloadBuilder } from "./ai-chat-context-payload.js";
import { createContextBarUpdater } from "./ai-chat-context-bar.js";
import { initAiChatEventBindings } from "./ai-chat-ui-events.js";
import { createHistoryController } from "./ai-chat-history.js";
import { createAiChatAttachmentsController, type AiImageAttachment } from "./ai-chat-attachments.js";
import { createAiChatIncomingHandlers } from "./ai-chat-incoming-handlers.js";
import { createAiChatRunner, type PendingAiRequest } from "./ai-chat-runner.js";
import { restorePendingAiDraft } from "./ai-chat-draft-restore.js";

type AiChatDeps = {
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  getActiveFilePath: () => string | null;
  getActiveFileSnapshot?: () => { path: string; content: string; isDirty: boolean } | null;
  getActiveCursorPosition?: () => { lineNumber: number; column: number } | null;
  getActiveSelectionSnapshot?: () => {
    path: string;
    text: string;
    isDirty: boolean;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  } | null;
  getOpenFileSnapshots?: (options?: { maxFiles?: number; maxChars?: number }) => {
    files: Array<{ path: string; isDirty: boolean; isActive: boolean }>;
    snapshots: Array<{ path: string; content: string; isDirty: boolean; truncated: boolean; contentLength: number }>;
  };
  getRecentIssuesSnapshot?: () => {
    count: number; summary: string; status: IssuesStatus; issues: IssueItem[]; updatedAt: number;
  } | null;
  showDiffModal?: (original: string, modified: string, lineOffset?: number, options?: { title?: string; fileName?: string; submitLabel?: string }) => void;
  setDiffContext?: (context: DiffContext) => void;
};

export type AiChatApi = {
  handleSettings: (settings: AgentSettings) => void;
  handleState: (state: AgentUiState) => void;
  handleStatus: (state: AgentStatusState, message?: string, conversationId?: string) => void;
  handleMessage: (text: string, conversationId?: string) => void;
  handleMessageDelta: (text: string, conversationId?: string) => void;
  handleTool: (payload: { name: string; label?: string; summary?: string; conversationId?: string }) => void;
  handleProposal: (proposal: AgentProposal) => void;
  handleApplyResult: (payload: { proposalId: string; ok: boolean; error?: string; conflict?: boolean }) => void;
  handleUndoResult: (payload: { ok: boolean; message?: string; path?: string; conversationId?: string }) => void;
  handleUndoAvailability: (payload: { conversationId?: string; available?: boolean; count?: number }) => void;
  handleError: (message: string, conversationId?: string) => void;
  refreshContextBar: () => void;
  handlePlatformAuth: (payload: {
    auth: PlatformAuthSnapshot;
    error?: { code?: string; message?: string };
  }) => void;
  handlePlatformAiAccess: (payload: { source?: string; access: PlatformAiAccessSnapshot }) => void;
  handlePlatformUsage: (payload: { source?: string; usage: PlatformUsageSnapshot }) => void;
  handlePlatformUpdate: (payload: {
    source?: string;
    update: PlatformUpdateSnapshot | null;
    error?: { code?: string; message?: string };
  }) => void;
  applyPendingFromDiffModal: () => void;
  clearPending: () => void;
};

const AUTONOMOUS_LOOP_LIMIT = 8;
const USAGE_REFRESH_DELAY_MS = 300;

export const initAiChatUi = (context: AppContext, deps: AiChatDeps): AiChatApi => {
  const {
    aiChatLog, aiChat, aiProposals, aiAttachments, aiAttach, aiAttachInput, aiInput, aiSend, aiStatus, aiChatNew,
    aiTopbarTitle, aiUsageMeter, aiUsageMeterText, aiHistoryToggle, aiHistory, aiHistoryList, aiAuthTopbar,
    aiContextBar, aiStop, aiUndo,
  } = context.dom;

  const chats: ChatState[] = [];
  const chatIndex = new Map<string, ChatState>();
  const proposalIndex = new Map<string, string>();
  let activeChatId: string | null = null;
  const runningConversations = new Set<string>();
  const resumableConversations = new Set<string>();
  let agentSettings: AgentSettings | null = null;
  const streamingMessages = new Map<string, { message: ChatMessage; element: HTMLElement | null }>();
  const thinkingMessages = new Map<string, { text: string; element: HTMLElement | null }>();
  const pendingAgentRequests = new Map<string, PendingAiRequest>();
  let getPendingAttachments = (): AiImageAttachment[] => [];
  let renderAttachmentBar = () => {};
  let clearPendingAttachments = (_resetInput = true) => {};
  let addImageFiles = async (_fileList: FileList | null) => {};
  const platformState = {
    platformAuth: null as PlatformAuthSnapshot | null,
    platformAiAccess: null as PlatformAiAccessSnapshot | null,
    platformUsage: null as PlatformUsageSnapshot | null,
    platformError: null as { code?: string; message?: string } | null,
    requestedInitialUsage: false,
  };
  let usageRefreshTimer: number | null = null;

  const makeChatId = () => `chat-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const requestPlatformState = () => {
    deps.postToNative({ type: "platform:state:get" }, true);
  };
  const requestAiAccessCheck = (force = false) => {
    deps.postToNative({ type: "feature:check", names: ["ai"], force }, true);
  };
  const requestPlatformUsage = (force = false) => {
    deps.postToNative({ type: "platform:usage:get", force }, true);
  };
  const scheduleUsageRefresh = (force = true) => {
    if (usageRefreshTimer !== null) {
      window.clearTimeout(usageRefreshTimer);
      usageRefreshTimer = null;
    }
    usageRefreshTimer = window.setTimeout(() => {
      usageRefreshTimer = null;
      requestPlatformUsage(force);
    }, USAGE_REFRESH_DELAY_MS);
  };
  // ── Login Overlay ──────────────────────────────────────
  const aiLoginOverlay = document.getElementById("ai-login-overlay");
  const aiLoginOverlayBtn = document.getElementById("ai-login-overlay-btn");
  const showLoginOverlay = () => {
    if (aiLoginOverlay) aiLoginOverlay.classList.add("is-visible");
  };
  const hideLoginOverlay = () => {
    if (aiLoginOverlay) aiLoginOverlay.classList.remove("is-visible");
  };
  if (aiLoginOverlayBtn) {
    aiLoginOverlayBtn.addEventListener("click", () => {
      deps.postToNative({ type: "auth:google:start" });
    });
  }

  const {
    isAiBlocked,
    needsLogin,
    openExternalUrl,
    resolvePricingUrl,
    updateStatusDisplay,
    handlePlatformAuth,
    handlePlatformAiAccess,
    handlePlatformUsage,
    handlePlatformUpdate,
  } = createAiChatStatusController({
    aiStatus,
    aiAuthTopbar,
    aiUsageMeter,
    aiUsageMeterText,
    postToNative: deps.postToNative,
    requestAiAccessCheck,
    requestPlatformUsage,
    pricingFallbackUrl: TEX64_LINKS.pricing,
    state: platformState,
    onStatusUpdate: () => {
      if (needsLogin()) showLoginOverlay();
      else hideLoginOverlay();
    },
  });

  const _rawUpdateStatusDisplay = updateStatusDisplay;
  const wrappedUpdateStatusDisplay = () => {
    _rawUpdateStatusDisplay();
    if (needsLogin()) showLoginOverlay();
    else hideLoginOverlay();
  };

  const getChat = (chatId?: string | null) => getChatState(chatIndex, activeChatId, chatId);

  const resolveChatTitle = (chatId: string) => {
    if (chatId === "search-rename") return "シンボルリネーム";
    return `Chat ${chats.length + 1}`;
  };

  const ensureChat = (chatId?: string | null) =>
    ensureChatState({
      chatId,
      activeChatId,
      chats,
      chatIndex,
      defaultAutonomous: true,
      defaultAutoLoopBudget: AUTONOMOUS_LOOP_LIMIT,
      resolveChatTitle,
    });

  const createChat = () => {
    const chat = createChatState({
      chats,
      chatIndex,
      makeChatId,
      resolveChatTitle,
      defaultAutonomous: true,
      defaultAutoLoopBudget: AUTONOMOUS_LOOP_LIMIT,
    });
    return chat;
  };

  const setChatTitle = (chat: ChatState) => {
    if (aiTopbarTitle instanceof HTMLElement) {
      aiTopbarTitle.textContent = chat.title;
    }
  };

  const switchActiveChat = (chatId: string) => {
    const chat = getChat(chatId);
    if (!chat) return;
    activeChatId = chat.id;
    setChatTitle(chat);
    clearPendingAttachments();
    renderChatContent();
    wrappedUpdateStatusDisplay();
    updateSendState();
    renderHistoryList();
  };

  const resetToNewChatState = () => {
    activeChatId = null;
    clearPendingAttachments();
    if (aiTopbarTitle instanceof HTMLElement) {
      aiTopbarTitle.textContent = "新規チャット";
    }
    const chatLog = getChatLog();
    if (chatLog) {
      chatLog.replaceChildren();
    }
    const proposals = getProposalsContainer();
    if (proposals) {
      proposals.replaceChildren();
      proposals.classList.add("is-hidden");
    }
    wrappedUpdateStatusDisplay();
    updateSendState();
    renderHistoryList();
  };

  const { renderHistoryList } = createHistoryController({
    aiHistory,
    aiHistoryList,
    aiHistoryToggle,
    chats,
    chatIndex,
    proposalIndex,
    runningConversations,
    getActiveChatId: () => activeChatId,
    switchActiveChat,
    resetToNewChatState,
    postToNative: deps.postToNative,
  });
  if (aiAuthTopbar instanceof HTMLButtonElement) {
    aiAuthTopbar.addEventListener("click", () => {
      deps.postToNative({ type: "auth:google:start" });
    });
  }

  const updateContextBar = createContextBarUpdater({
    aiContextBar,
    getActiveFilePath: deps.getActiveFilePath,
    getActiveSelectionSnapshot: deps.getActiveSelectionSnapshot,
    getActiveCursorPosition: deps.getActiveCursorPosition,
  });

  const autoGrow = () => {
    if (!(aiInput instanceof HTMLTextAreaElement)) return;
    aiInput.style.height = "auto";
    aiInput.style.height = Math.min(aiInput.scrollHeight, 200) + "px";
  };
  if (aiInput instanceof HTMLTextAreaElement) aiInput.addEventListener("input", autoGrow);

  const updateSendState = () => {
    const active = getChat(activeChatId);
    const isRunning = Boolean(active && runningConversations.has(active.id));
    const canResume = Boolean(active && !isRunning && resumableConversations.has(active.id));
    const canUndo = Boolean(active && active.hasUndo && !isRunning);
    if (aiSend instanceof HTMLButtonElement) {
      aiSend.disabled = isRunning;
      aiSend.classList.remove("is-loading");
      aiSend.style.display = isRunning ? "none" : "flex";
    }
    if (aiInput instanceof HTMLTextAreaElement) aiInput.disabled = isRunning;
    if (aiAttach instanceof HTMLButtonElement) aiAttach.disabled = isRunning;
    if (aiAttachInput instanceof HTMLInputElement) aiAttachInput.disabled = isRunning;
    if (aiStop instanceof HTMLButtonElement) {
      aiStop.disabled = false;
      aiStop.innerHTML = isRunning
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="8,5 20,12 8,19"/></svg>';
      aiStop.style.display = isRunning || canResume ? "flex" : "none";
    }
    if (aiUndo instanceof HTMLButtonElement) {
      aiUndo.style.display = canUndo ? "flex" : "none";
      aiUndo.disabled = !canUndo;
    }
  };

  const buildContextPayload = createContextPayloadBuilder(deps);

  const getChatLog = () => (aiChatLog instanceof HTMLElement ? aiChatLog : null);
  const getProposalsContainer = () => (aiProposals instanceof HTMLElement ? aiProposals : null);

  const ensureProposalsEmbedded = () => {
    const chatLog = getChatLog();
    const proposals = getProposalsContainer();
    if (!chatLog || !proposals) return null;
    if (proposals.parentElement !== chatLog) chatLog.appendChild(proposals);
    else if (chatLog.lastElementChild !== proposals) chatLog.appendChild(proposals);
    return proposals;
  };

  const appendToChatLog = (element: HTMLElement) => {
    const chatLog = getChatLog();
    if (!chatLog) return;
    chatLog.querySelector(".ai-empty-state")?.remove();
    const proposals = getProposalsContainer();
    if (proposals && proposals.parentElement === chatLog) chatLog.insertBefore(element, proposals);
    else chatLog.appendChild(element);
  };

  const scrollToBottom = () => { if (aiChat instanceof HTMLElement) aiChat.scrollTop = aiChat.scrollHeight; };

  const ensureStreamingMessage = (chatId: string) => {
    const existing = streamingMessages.get(chatId);
    if (existing) return existing;
    const chat = ensureChat(chatId);
    if (!chat) return null;
    const message: ChatMessage = { role: "assistant", text: "" };
    chat.messages.push(message);
    let element: HTMLElement | null = null;
    if (chat.id === activeChatId && aiChatLog instanceof HTMLElement) {
      element = createMessageElement(message);
      appendToChatLog(element);
      scrollToBottom();
    }
    const entry = { message, element };
    streamingMessages.set(chatId, entry);
    return entry;
  };

  const finalizeStreamingMessage = (chatId: string, text: string) => {
    const entry = streamingMessages.get(chatId);
    if (!entry) return false;
    entry.message.text = text;
    updateMessageElement(entry.element, text);
    streamingMessages.delete(chatId);
    return true;
  };

  const appendMessage = (message: ChatMessage, chatId?: string) => {
    const chat = ensureChat(chatId);
    if (!chat) return;
    chat.messages.push(message);
    if (chat.id !== activeChatId || !(aiChatLog instanceof HTMLElement)) return;
    appendToChatLog(createMessageElement(message));
    scrollToBottom();
  };

  ({
    getPendingAttachments,
    renderAttachmentBar,
    clearPendingAttachments,
    addImageFiles,
  } = createAiChatAttachmentsController({
    aiAttachments,
    aiAttachInput,
    aiStatus,
    getActiveChatId: () => activeChatId,
    getChat,
    appendMessage,
  }));

  const normalizeThinkingText = (text?: string) => {
    const raw = typeof text === "string" ? text.trim() : "";
    if (!raw) return "思考中...";
    if (raw.startsWith("思考中")) return raw;
    return `思考中: ${raw}`;
  };

  const upsertThinkingMessage = (chatId?: string | null, text?: string) => {
    const chat = ensureChat(chatId);
    if (!chat) return;
    const normalized = normalizeThinkingText(text);
    let entry = thinkingMessages.get(chat.id);
    if (!entry) {
      entry = { text: normalized, element: null };
      thinkingMessages.set(chat.id, entry);
    } else {
      entry.text = normalized;
    }
    if (chat.id !== activeChatId || !(aiChatLog instanceof HTMLElement)) return;
    if (!entry.element) {
      entry.element = createMessageElement({ role: "assistant", text: normalized });
      entry.element.classList.add("ai-thinking-message");
      appendToChatLog(entry.element);
      scrollToBottom();
      return;
    }
    updateMessageElement(entry.element, normalized);
  };

  const clearThinkingMessage = (chatId?: string | null) => {
    const chat = getChat(chatId);
    if (!chat) return;
    const entry = thinkingMessages.get(chat.id);
    if (!entry) return;
    entry.element?.remove();
    thinkingMessages.delete(chat.id);
  };

  const disableAutonomous = (chatId?: string | null) => {
    const chat = getChat(chatId);
    if (!chat) return;
    chat.autonomous = false;
    chat.autoLoopBudget = 0;
  };

  const enableAutonomous = (chat: ChatState) => {
    chat.autonomous = true;
    chat.autoLoopBudget = AUTONOMOUS_LOOP_LIMIT;
  };

  let pendingAiProposalId: string | null = null;
  const dismissProposal = (proposalId: string) => {
    const chatId = proposalIndex.get(proposalId);
    const chat = getChat(chatId);
    if (!chat) return;
    chat.proposals.delete(proposalId);
    proposalIndex.delete(proposalId);
    if (chat.id === activeChatId) {
      const proposals = getProposalsContainer();
      proposals?.querySelector(`[data-proposal-id="${proposalId}"]`)?.remove();
      if (proposals && chat.proposals.size === 0) {
        proposals.classList.add("is-hidden");
      }
    }
    renderHistoryList();
  };
  const buildProposalCard = (proposal: AgentProposal) =>
    createProposalCard(proposal, {
      postToNative: deps.postToNative,
      dismissProposal,
      setPendingProposalId: (v) => { pendingAiProposalId = v; },
      showDiffModal: deps.showDiffModal,
      setDiffContext: deps.setDiffContext,
    });

  const renderChatContent = () => {
    const chat = getChat(activeChatId);
    if (!chat) return;
    const chatLog = getChatLog();
    thinkingMessages.forEach((entry) => {
      entry.element = null;
    });
    chatLog?.replaceChildren();
    chat.messages.forEach((msg) => { if (chatLog) chatLog.appendChild(createMessageElement(msg)); });
    const proposals = ensureProposalsEmbedded();
    if (proposals) {
      proposals.replaceChildren();
      proposals.classList.toggle("is-hidden", chat.proposals.size === 0);
      chat.proposals.forEach((p) => proposals.appendChild(buildProposalCard(p)));
    }
    const se = streamingMessages.get(chat.id);
    const last = chatLog?.querySelectorAll(".ai-message");
    if (se && last && last.length > 0) se.element = last[last.length - 1] as HTMLElement;
    const thinking = thinkingMessages.get(chat.id);
    if (thinking) {
      const element = createMessageElement({ role: "assistant", text: thinking.text });
      element.classList.add("ai-thinking-message");
      thinking.element = element;
      appendToChatLog(element);
    }
    scrollToBottom();
  };

  const restoreDraftFromPending = (chatId: string, request: PendingAiRequest | null) =>
    restorePendingAiDraft({ chatId, request, activeChatId, aiInput, autoGrow, appendMessage });

  const { requestAgentRun } = createAiChatRunner({
    isAiBlocked,
    needsLogin,
    requestAiAccessCheck,
    requestPlatformUsage,
    updateStatusDisplay: wrappedUpdateStatusDisplay,
    ensureChat,
    runningConversations,
    pendingAgentRequests,
    buildContextPayload,
    getAgentSettings: () => agentSettings,
    upsertThinkingMessage,
    renderHistoryList,
    updateSendState,
    postToNative: deps.postToNative,
    clearThinkingMessage,
    restoreDraftFromPending,
  });

  initAiChatEventBindings({
    aiInput,
    aiSend,
    aiAttach,
    aiAttachInput,
    aiStatus,
    aiUndo,
    aiStop,
    aiChatNew,
    postToNative: deps.postToNative,
    getActiveChatId: () => activeChatId,
    setActiveChatId: (chatId) => {
      activeChatId = chatId;
    },
    getPendingAttachments,
    getChat,
    createChat,
    setChatTitle,
    renderHistoryList,
    appendMessage,
    autoGrow,
    updateContextBar,
    requestAgentRun,
    buildContextPayload,
    getAgentSettings: () => agentSettings,
    clearPendingAttachments,
    addImageFiles,
    isAiBlocked,
    needsLogin,
    requestAiAccessCheck,
    requestPlatformUsage,
    updateStatusDisplay: wrappedUpdateStatusDisplay,
    showLoginOverlay,
    resolvePricingUrl,
    openExternalUrl,
    runningConversations,
    resumableConversations,
    pendingAgentRequests,
    clearThinkingMessage,
    upsertThinkingMessage,
    updateSendState,
    disableAutonomous,
    resetToNewChatState,
  });

  const handleSettings = (s: AgentSettings) => { agentSettings = s; updateSendState(); };
  const {
    handleState,
    handleStatus,
    handleMessage,
    handleMessageDelta,
    handleTool,
    handleProposal,
    handleApplyResult,
    handleUndoResult,
    handleUndoAvailability,
    handleError,
  } = createAiChatIncomingHandlers({
    postToNative: deps.postToNative,
    dismissProposal,
    chats,
    chatIndex,
    proposalIndex,
    runningConversations,
    resumableConversations,
    streamingMessages,
    thinkingMessages,
    pendingAgentRequests,
    getActiveChatId: () => activeChatId,
    setActiveChatId: (chatId) => {
      activeChatId = chatId;
    },
    ensureChat,
    getChat,
    setChatTitle,
    clearPendingAttachments,
    renderHistoryList,
    renderChatContent,
    updateSendState,
    updateStatusDisplay: wrappedUpdateStatusDisplay,
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
  });

  resetToNewChatState();
  updateContextBar();
  renderAttachmentBar();
  requestPlatformState();

  return {
    handleSettings, handleState, handleStatus, handleMessage, handleMessageDelta, handleTool,
    handleProposal, handleApplyResult, handleUndoResult, handleUndoAvailability, handleError,
    refreshContextBar: updateContextBar,
    handlePlatformAuth, handlePlatformAiAccess, handlePlatformUsage,
    handlePlatformUpdate,
    applyPendingFromDiffModal: () => { if (pendingAiProposalId) { deps.postToNative({ type: "agent:apply", proposalId: pendingAiProposalId }); pendingAiProposalId = null; } },
    clearPending: () => { pendingAiProposalId = null; },
  };
};
