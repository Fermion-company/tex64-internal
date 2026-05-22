import type { AppContext } from "./context.js";
import { aiText } from "./ai-i18n.js";
import { onUiLocaleChange } from "./i18n.js";
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
import type { DiffContext, FileDiff } from "./diff-modal.js";
import {
  AUTONOMOUS_LOOP_LIMIT,
  createChat as createChatState,
  ensureChat as ensureChatState,
  getChat as getChatState,
  type ChatMessage,
  type ChatState,
} from "./ai-chat-state.js";
import { createMessageElement, updateMessageElement } from "./ai-chat-message.js";
import { createUnifiedProposalCard } from "./ai-chat-proposal.js";
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
import { createMentionController } from "./ai-chat-mention.js";

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
  getWorkspaceFiles?: () => string[];
  showDiffModal: (original: string, modified: string, lineOffset?: number, options?: { title?: string; fileName?: string; submitLabel?: string }) => void;
  showMultiFileDiff: (files: FileDiff[], options?: { title?: string; submitLabel?: string }) => void;
  setDiffContext: (context: DiffContext) => void;
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
  handleScratchpad: (payload: { content: string; conversationId?: string }) => void;
  handleThought: (payload: { text: string; conversationId?: string }) => void;
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

const USAGE_REFRESH_DELAY_MS = 300;

export const initAiChatUi = (context: AppContext, deps: AiChatDeps): AiChatApi => {
  const {
    aiChatLog, aiChat, aiProposals, aiAttachments, aiAttach, aiAttachInput, aiInput, aiSend, aiStatus, aiChatNew,
    aiTopbarTitle, aiTopbarStatus, aiUsageMeter, aiUsageMeterText, aiHistoryToggle, aiHistory, aiHistoryList, aiAuthTopbar,
    aiContextBar, aiStop, aiUndo, aiModelPicker, aiModelTrigger, aiModelLabel, aiModelMenu,
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
  const thinkingTransitionTimers = new Map<string, number>();
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

  // ── Model picker (custom dropdown) ─────────────────────
  // Two selectable models live in agentSettings.model. The server maps the id
  // to the real upstream model and enforces the Pro gate; the renderer reflects
  // the choice and shows Axiom 0.9.1 Pro as a locked row for non-Pro plans.
  const DEFAULT_MODEL = "Axiom0.9.1";
  const PRO_MODEL = "Axiom0.9.1-pro";
  const MODEL_LABELS: Record<string, string> = {
    [DEFAULT_MODEL]: "Axiom 0.9.1",
    [PRO_MODEL]: "Axiom 0.9.1 Pro",
  };
  const MODEL_OPTIONS: Array<{ id: string; name: string; descKey: string; pro: boolean }> = [
    { id: DEFAULT_MODEL, name: "Axiom 0.9.1", descKey: "model_standard", pro: false },
    { id: PRO_MODEL, name: "Axiom 0.9.1 Pro", descKey: "model_most_capable", pro: true },
  ];
  // Localize the static AI-panel chrome (login overlay, delete modal, upsell).
  const applyAiStaticI18n = () => {
    const set = (selector: string, key: string) => {
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement) el.textContent = aiText(key);
    };
    set(".ai-login-overlay-title", "overlay_title");
    set(".ai-login-overlay-subtitle", "overlay_subtitle");
    set("#ai-login-overlay-btn span", "login_with_google");
    set(".ai-chat-delete-modal-title", "delete_chat");
    set("#ai-chat-delete-cancel", "cancel");
    set("#ai-chat-delete-confirm", "confirm_delete");
    set(".ai-model-upsell-title", "upsell_title");
    set(".ai-model-upsell-sub", "upsell_sub");
    set(".ai-model-upsell-btn", "see_pro_plans");
  };
  const isProPlan = () =>
    typeof platformState.platformAiAccess?.plan === "string" &&
    platformState.platformAiAccess.plan.toLowerCase() === "pro";
  const escapeHtml = (value: string) =>
    value.replace(/[&<>"]/g, (ch) =>
      ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"
    );
  // The selected model, falling back to the standard model when a stored Pro
  // model is no longer permitted by the current plan.
  const currentModelId = () => {
    const stored = agentSettings?.model || DEFAULT_MODEL;
    return stored === PRO_MODEL && !isProPlan() ? DEFAULT_MODEL : stored;
  };
  const hideModelUpsell = () => {
    const upsell =
      aiModelMenu instanceof HTMLElement ? aiModelMenu.querySelector(".ai-model-upsell") : null;
    if (upsell instanceof HTMLElement) upsell.classList.remove("is-visible");
  };
  const closeModelMenu = () => {
    if (!(aiModelPicker instanceof HTMLElement)) return;
    aiModelPicker.classList.remove("is-open");
    if (aiModelTrigger instanceof HTMLElement) {
      aiModelTrigger.setAttribute("aria-expanded", "false");
    }
    hideModelUpsell();
  };

  // Rebuild the trigger label + menu rows for the current plan/selection.
  const syncModelSelect = () => {
    const pro = isProPlan();
    const selected = currentModelId();
    if (aiModelLabel instanceof HTMLElement) {
      aiModelLabel.textContent = MODEL_LABELS[selected] || MODEL_LABELS[DEFAULT_MODEL];
    }
    if (!(aiModelMenu instanceof HTMLElement)) return;
    const list = aiModelMenu.querySelector(".ai-model-menu-list");
    if (!(list instanceof HTMLElement)) return;
    list.replaceChildren();
    for (const model of MODEL_OPTIONS) {
      const locked = model.pro && !pro;
      const isSelected = model.id === selected;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "ai-model-menu-item";
      if (isSelected) item.classList.add("is-selected");
      if (locked) item.classList.add("is-locked");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", isSelected ? "true" : "false");
      if (locked) item.setAttribute("aria-disabled", "true");
      item.dataset.model = model.id;
      const desc = locked ? aiText("model_requires_pro") : aiText(model.descKey);
      const badge = model.pro ? '<span class="ai-model-badge">Pro</span>' : "";
      item.innerHTML =
        '<svg class="ai-model-menu-check" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>' +
        '<span class="ai-model-menu-text">' +
        `<span class="ai-model-menu-name">${escapeHtml(model.name)}${badge}</span>` +
        `<span class="ai-model-menu-desc">${escapeHtml(desc)}</span>` +
        "</span>";
      list.appendChild(item);
    }
  };

  if (aiModelTrigger instanceof HTMLElement) {
    aiModelTrigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!(aiModelPicker instanceof HTMLElement)) return;
      if (aiModelPicker.classList.contains("is-open")) {
        closeModelMenu();
      } else {
        hideModelUpsell();
        syncModelSelect();
        aiModelPicker.classList.add("is-open");
        aiModelTrigger.setAttribute("aria-expanded", "true");
      }
    });
  }
  if (aiModelMenu instanceof HTMLElement) {
    aiModelMenu.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      // Upsell CTA → open the pricing page in the browser.
      if (target?.closest(".ai-model-upsell-btn")) {
        event.stopPropagation();
        deps.postToNative({ type: "shell:openExternal", url: "https://tex64.com/pricing" });
        closeModelMenu();
        return;
      }
      const item = target?.closest(".ai-model-menu-item");
      if (!(item instanceof HTMLElement)) return;
      // Locked Pro-only row on a non-Pro plan → reveal the upgrade prompt
      // instead of selecting.
      if (item.classList.contains("is-locked")) {
        const upsell = aiModelMenu.querySelector(".ai-model-upsell");
        if (upsell instanceof HTMLElement) upsell.classList.add("is-visible");
        return;
      }
      const value = item.dataset.model || DEFAULT_MODEL;
      // Update the local copy so anything reading agentSettings sees it at once,
      // and persist via the main process (which re-broadcasts agent:settings).
      if (agentSettings) {
        agentSettings.model = value;
      }
      deps.postToNative({ type: "agent:settings:set", settings: { model: value } }, true);
      closeModelMenu();
      syncModelSelect();
    });
  }
  document.addEventListener("click", (event) => {
    if (!(aiModelPicker instanceof HTMLElement) || !aiModelPicker.classList.contains("is-open")) {
      return;
    }
    if (!aiModelPicker.contains(event.target as Node)) {
      closeModelMenu();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      aiModelPicker instanceof HTMLElement &&
      aiModelPicker.classList.contains("is-open")
    ) {
      closeModelMenu();
    }
  });

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
      // Plan may have changed (e.g. AI access refreshed) — re-gate the Pro option.
      syncModelSelect();
    },
  });

  const _rawUpdateStatusDisplay = updateStatusDisplay;
  const wrappedUpdateStatusDisplay = () => {
    _rawUpdateStatusDisplay();
    if (needsLogin()) showLoginOverlay();
    else hideLoginOverlay();
    syncModelSelect();
  };

  const getChat = (chatId?: string | null) => getChatState(chatIndex, activeChatId, chatId);

  const resolveChatTitle = (chatId: string) => {
    if (chatId === "search-rename") return "symbol rename";
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
      aiTopbarTitle.textContent = aiText("new_chat");
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

  // ── @-mention file picker ──
  const mentionController =
    aiInput instanceof HTMLTextAreaElement && deps.getWorkspaceFiles
      ? createMentionController({
          aiInput,
          getWorkspaceFiles: deps.getWorkspaceFiles,
        })
      : null;

  const updateSendState = () => {
    const active = getChat(activeChatId);
    const isRunning = Boolean(active && runningConversations.has(active.id));
    const canResume = Boolean(active && !isRunning && resumableConversations.has(active.id));
    const canUndo = Boolean(active && active.hasUndo && !isRunning);
    // AI running 中でも入力欄は常に有効 (ChatGPT/Claude と同じ UX)。
    // ユーザーは返答を待ちながら次のメッセージを準備できる。
    // 送信ボタンは非表示にし、代わりに停止ボタンを表示する。
    const blockSend = activeChatId !== null && isRunning;
    if (aiSend instanceof HTMLButtonElement) {
      aiSend.disabled = blockSend;
      aiSend.classList.remove("is-loading");
      aiSend.style.display = blockSend ? "none" : "flex";
    }
    if (aiInput instanceof HTMLTextAreaElement) aiInput.disabled = false;
    if (aiAttach instanceof HTMLButtonElement) aiAttach.disabled = blockSend;
    if (aiAttachInput instanceof HTMLInputElement) aiAttachInput.disabled = blockSend;
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

  const _rawBuildContextPayload = createContextPayloadBuilder(deps);
  const buildContextPayload = (agentSettings: AgentSettings | null) => {
    const payload = _rawBuildContextPayload(agentSettings);
    if (mentionController) {
      const paths = mentionController.getExplicitPaths();
      if (paths.length > 0) {
        const existing = Array.isArray(payload.explicitContextPaths)
          ? (payload.explicitContextPaths as string[])
          : [];
        payload.explicitContextPaths = [...existing, ...paths.filter((p) => !existing.includes(p))];
      }
    }
    return payload;
  };

  const getChatLog = () => (aiChatLog instanceof HTMLElement ? aiChatLog : null);
  const getProposalsContainer = () => (aiProposals instanceof HTMLElement ? aiProposals : null);

  const ensureProposalsEmbedded = () => {
    const chatLog = getChatLog();
    const proposals = getProposalsContainer();
    if (!chatLog || !proposals) return null;
    // Insert proposals right after the last assistant message, not at the very end
    const assistantMessages = chatLog.querySelectorAll(".ai-message.is-assistant");
    const lastAssistant = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
    if (lastAssistant && lastAssistant.nextSibling !== proposals) {
      lastAssistant.after(proposals);
    } else if (!lastAssistant && proposals.parentElement !== chatLog) {
      chatLog.appendChild(proposals);
    }
    return proposals;
  };

  const appendToChatLog = (element: HTMLElement) => {
    const chatLog = getChatLog();
    if (!chatLog) return;
    chatLog.querySelector(".ai-empty-state")?.remove();
    chatLog.appendChild(element);
  };

  const scrollToBottom = () => {
    if (!(aiChatLog instanceof HTMLElement)) return;
    // Use rAF to ensure the DOM layout is up-to-date before scrolling.
    requestAnimationFrame(() => {
      aiChatLog.scrollTop = aiChatLog.scrollHeight;
    });
  };

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

  let setPendingAttachments = (_attachments: AiImageAttachment[]) => {};
  ({
    getPendingAttachments,
    renderAttachmentBar,
    clearPendingAttachments,
    addImageFiles,
    setPendingAttachments,
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
    if (!raw) return "Thinking...";
    return raw;
  };

  const createThinkingElement = (text: string): HTMLElement => {
    const wrapper = document.createElement("div");
    wrapper.className = "ai-message is-assistant ai-thinking-message";
    const body = document.createElement("div");
    body.className = "ai-message-body";
    const content = document.createElement("div");
    content.className = "ai-message-content";
    content.textContent = text;
    body.appendChild(content);
    wrapper.appendChild(body);
    return wrapper;
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
    if (chat.id === activeChatId && aiChatLog instanceof HTMLElement) {
      if (entry.element && entry.element.parentElement) {
        const content = entry.element.querySelector(".ai-message-content");
        if (content) {
          const prev = content.textContent ?? "";
          if (prev !== normalized) {
            // Cancel any in-flight transition before starting a new one
            const prevTimer = thinkingTransitionTimers.get(chat.id);
            if (prevTimer !== undefined) window.clearTimeout(prevTimer);
            // Fade out → swap text → fade in
            content.classList.add("is-transitioning");
            const timerId = window.setTimeout(() => {
              thinkingTransitionTimers.delete(chat.id);
              content.textContent = normalized;
              content.classList.remove("is-transitioning");
            }, 200);
            thinkingTransitionTimers.set(chat.id, timerId);
          }
        }
      } else {
        entry.element = createThinkingElement(normalized);
        appendToChatLog(entry.element);
        scrollToBottom();
      }
    }
  };

  const clearThinkingMessage = (chatId?: string | null) => {
    const chat = getChat(chatId);
    if (!chat) return;
    const prevTimer = thinkingTransitionTimers.get(chat.id);
    if (prevTimer !== undefined) {
      window.clearTimeout(prevTimer);
      thinkingTransitionTimers.delete(chat.id);
    }
    const entry = thinkingMessages.get(chat.id);
    if (!entry) return;
    if (entry.element && entry.element.parentElement) {
      entry.element.remove();
    }
    entry.element = null;
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

  let pendingAiProposalIds: string[] = [];
  const buildUnifiedProposalCard = (proposals: AgentProposal[], chat: ChatState) =>
    createUnifiedProposalCard(proposals, chat.appliedProposalIds, {
      postToNative: deps.postToNative,
      setPendingProposalIds: (ids) => { pendingAiProposalIds = ids; },
      showDiffModal: deps.showDiffModal,
      showMultiFileDiff: deps.showMultiFileDiff,
      setDiffContext: deps.setDiffContext,
    });

  const rebuildProposalCards = (chatId: string) => {
    const chat = getChat(chatId);
    if (!chat || chat.id !== activeChatId) return;
    const container = ensureProposalsEmbedded();
    if (!container) return;
    container.replaceChildren();
    container.classList.toggle("is-hidden", chat.proposals.size === 0);
    if (chat.proposals.size > 0) {
      const allProposals = Array.from(chat.proposals.values());
      container.appendChild(buildUnifiedProposalCard(allProposals, chat));
    }
  };

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
      if (chat.proposals.size > 0) {
        const allProposals = Array.from(chat.proposals.values());
        proposals.appendChild(buildUnifiedProposalCard(allProposals, chat));
      }
    }
    const se = streamingMessages.get(chat.id);
    const last = chatLog?.querySelectorAll(".ai-message");
    if (se && last && last.length > 0) se.element = last[last.length - 1] as HTMLElement;
    // Re-create thinking element in chat log if this chat is running.
    const thinking = thinkingMessages.get(chat.id);
    if (thinking) {
      thinking.element = createThinkingElement(thinking.text);
      appendToChatLog(thinking.element);
    }
    scrollToBottom();
  };

  const restoreDraftFromPending = (chatId: string, request: PendingAiRequest | null) =>
    restorePendingAiDraft({ chatId, request, activeChatId, aiInput, autoGrow, appendMessage, setPendingAttachments });

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
    clearMentionPaths: mentionController
      ? () => mentionController.clearExplicitPaths()
      : undefined,
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

  const handleSettings = (s: AgentSettings) => {
    agentSettings = s;
    updateSendState();
    syncModelSelect();
  };
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
    handleScratchpad,
    handleThought,
    handleError,
  } = createAiChatIncomingHandlers({
    postToNative: deps.postToNative,
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
    enableAutonomous,
    scheduleUsageRefresh,
    rebuildProposalCards,
    restoreDraftFromPending,
    updateContextBar,
    buildContextPayload,
    getAgentSettings: () => agentSettings,
    switchActiveChat,
  });

  resetToNewChatState();
  updateContextBar();
  renderAttachmentBar();
  syncModelSelect();
  applyAiStaticI18n();
  onUiLocaleChange(() => {
    applyAiStaticI18n();
    syncModelSelect();
  });
  requestPlatformState();

  return {
    handleSettings, handleState, handleStatus, handleMessage, handleMessageDelta, handleTool,
    handleProposal, handleApplyResult, handleUndoResult, handleUndoAvailability, handleScratchpad, handleThought, handleError,
    refreshContextBar: updateContextBar,
    handlePlatformAuth, handlePlatformAiAccess, handlePlatformUsage,
    handlePlatformUpdate,
    applyPendingFromDiffModal: () => {
      for (const id of pendingAiProposalIds) { deps.postToNative({ type: "agent:apply", proposalId: id }); }
      pendingAiProposalIds = [];
      // Clear the editor's Undo/Confirm bar to keep it in sync
      const bar = document.getElementById("ai-undo-keep-bar");
      if (bar) bar.remove();
    },
    clearPending: () => { pendingAiProposalIds = []; },
  };
};
