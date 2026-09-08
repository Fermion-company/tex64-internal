import type { AppContext } from "./context.js";
import { aiText } from "./ai-i18n.js";
import { onUiLocaleChange, uiText } from "./i18n.js";
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
  createChat as createChatState,
  ensureChat as ensureChatState,
  getChat as getChatState,
  type ChatMessage,
  type ChatState,
} from "./ai-chat-state.js";
import { createMessageElement, createRatingBox, setMessageRating, updateMessageElement } from "./ai-chat-message.js";
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
import { createMentionController, type MentionCandidate } from "./ai-chat-mention.js";
import type { ContextExtras } from "./ai-chat-context-payload.js";
import { createVoiceController } from "./ai-chat-voice.js";
import type { MessageExtras } from "./ai-chat-incoming-handlers.js";

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
  getWorkspaceRoot?: () => string | null;
  showDiffModal: (original: string, modified: string, lineOffset?: number, options?: { title?: string; fileName?: string; submitLabel?: string; viewOnly?: boolean; closeLabel?: string }) => void;
  showMultiFileDiff: (files: FileDiff[], options?: { title?: string; submitLabel?: string; viewOnly?: boolean; closeLabel?: string }) => void;
  setDiffContext: (context: DiffContext) => void;
  /** Opens the settings overlay on a page (the usage line points at Account). */
};

export type AiChatApi = {
  handleSettings: (settings: AgentSettings) => void;
  handleState: (state: AgentUiState) => void;
  handleStatus: (state: AgentStatusState, message?: string, conversationId?: string) => void;
  handleMessage: (text: string, conversationId?: string, extras?: MessageExtras) => void;
  handleMessageDelta: (text: string, conversationId?: string) => void;
  handleTool: (payload: {
    name: string;
    label?: string;
    detail?: string;
    summary?: string;
    conversationId?: string;
  }) => void;
  handleProposal: (proposal: AgentProposal) => void;
  handleApplyResult: (payload: { proposalId: string; ok: boolean; error?: string; conflict?: boolean }) => void;
  handleUndoResult: (payload: { ok: boolean; message?: string; path?: string; conversationId?: string }) => void;
  handleUndoAvailability: (payload: { conversationId?: string; available?: boolean; count?: number }) => void;
  handleScratchpad: (payload: { content: string; conversationId?: string }) => void;
  handleThought: (payload: { text: string; conversationId?: string }) => void;
  handleError: (message: string, conversationId?: string) => void;
  handleRequestRejected: (payload: {
    conversationId?: string;
    message?: string;
  }) => void;
  /** Forgets the previous workspace's chats; true when the root actually changed. */
  handleWorkspaceChanged: (rootPath: string | null) => boolean;
  handleTitle: (payload: { conversationId?: string; title?: string }) => void;
  handleMessageReset: (payload: { conversationId?: string }) => void;
  /** The reader marked a place on the typeset page; resolve it and open the chat there. */
  askFromPdf: (payload: {
    page: number;
    x: number;
    y: number;
    text: string;
    pdfPath: string | null;
    source?: { file: string; line: number; column: number } | null;
    sourcePath?: string | null;
  }) => void;
  handlePdfReverseResult: (payload: { requestId?: string; ok?: boolean; path?: string; line?: number; error?: string }) => void;
  handleFeedbackResult: (payload: { conversationId?: string; assistantIndex?: number; rating?: "up" | "down"; ok?: boolean; error?: string }) => void;
  handleBranchResult: (payload: { ok?: boolean; conversationId?: string; error?: string }) => void;
  handleProposalScope: (payload: { conversationId?: string; proposalId?: string; page?: number }) => void;
  handleTranscribeResult: (payload: { requestId?: string; ok?: boolean; text?: string; error?: string; code?: string }) => void;
  handleDocumentMap: (payload: {
    requestId?: string;
    mainFile?: string | null;
    sections?: Array<{ path: string; id: number; type: string; number?: string; title: string; line: number; endLine: number }>;
    labels?: Array<{ key: string; path: string; line: number }>;
    bibKeys?: Array<{ key: string; path: string; line?: number; title?: string }>;
    git?: { isRepo?: boolean; changed?: number };
    rules?: { exists?: boolean };
  }) => void;
  getCurrentPlan: () => string;
  getUsageSnapshot: () => PlatformUsageSnapshot | null;
  refreshPlan: (force?: boolean) => void;
  refreshUsage: (force?: boolean) => void;
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
    aiTopbarTitle, aiTopbarStatus, aiHistoryToggle, aiHistory, aiHistoryList,
    aiContextBar, aiStop, aiUndo, aiModelPicker, aiModelTrigger, aiModelLabel, aiModelMenu,
    aiMic, aiMicTimer, aiModeToggle,
  } = context.dom;

  const chats: ChatState[] = [];
  const chatIndex = new Map<string, ChatState>();
  const proposalIndex = new Map<string, string>();
  let activeChatId: string | null = null;
  const runningConversations = new Set<string>();
  const resumableConversations = new Set<string>();
  let agentSettings: AgentSettings | null = null;
  const streamingMessages = new Map<string, { message: ChatMessage; element: HTMLElement | null }>();
  let submitFromUi: ((text: string) => void) | null = null;
  let eventApi: ReturnType<typeof initAiChatEventBindings> | null = null;
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
  // After a turn the host pushes the allowance it just spent; nothing here
  // asks the server again.
  const scheduleUsageRefresh = () => {};
  // ── Model picker (custom dropdown) ─────────────────────
  // Two selectable models live in agentSettings.model. The server maps the id
  // to the real upstream model and enforces the Pro gate; the renderer reflects
  // the choice and shows Axiom 1.0 Pro as a locked row for non-Pro plans.
  const DEFAULT_MODEL = "Axiom1.0";
  const PRO_MODEL = "Axiom1.0-pro";
  const MODEL_LABELS: Record<string, string> = {
    [DEFAULT_MODEL]: "Axiom 1.0",
    [PRO_MODEL]: "Axiom 1.0 Pro",
  };
  const MODEL_OPTIONS: Array<{ id: string; name: string; descKey: string; pro: boolean }> = [
    { id: DEFAULT_MODEL, name: "Axiom 1.0", descKey: "model_efficient", pro: false },
    { id: PRO_MODEL, name: "Axiom 1.0 Pro", descKey: "model_autonomous", pro: true },
  ];
  const migrateLegacyModelId = (model: string) =>
    model === "Axiom0.9.1"
      ? DEFAULT_MODEL
      : model === "Axiom0.9.1-pro"
        ? PRO_MODEL
        : model;
  // Localize the static AI-panel chrome (login overlay, delete modal, upsell).
  const applyAiStaticI18n = () => {
    const set = (selector: string, key: string) => {
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement) el.textContent = aiText(key);
    };
    set(".ai-chat-delete-modal-title", "delete_chat");
    set("#ai-chat-delete-cancel", "cancel");
    set("#ai-chat-delete-confirm", "confirm_delete");
    set(".ai-model-upsell-title", "upsell_title");
    set(".ai-model-upsell-btn", "see_pro_plans");
    // The mode pill also owns the composer placeholder (it differs per mode).
    eventApi?.syncModeLabels();
    voice?.syncLabels();
    renderEmptyState(true);
  };
  const isProPlan = () =>
    typeof platformState.platformAiAccess?.plan === "string" &&
    platformState.platformAiAccess.plan.toLowerCase() === "pro";
  const hasResolvedPlan = () =>
    typeof platformState.platformAiAccess?.plan === "string" &&
    platformState.platformAiAccess.plan.trim().length > 0;
  const escapeHtml = (value: string) =>
    value.replace(/[&<>"]/g, (ch) =>
      ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"
    );
  // The selected model, falling back to the standard model when a stored Pro
  // model is no longer permitted by the current plan.
  const currentModelId = () => {
    const configured = agentSettings?.model || DEFAULT_MODEL;
    const stored = migrateLegacyModelId(configured);
    if (stored !== DEFAULT_MODEL && stored !== PRO_MODEL) return DEFAULT_MODEL;
    return stored === PRO_MODEL && !isProPlan() ? DEFAULT_MODEL : stored;
  };
  const persistCompatibleModelSelection = () => {
    if (!agentSettings) return;
    const configured = agentSettings.model || DEFAULT_MODEL;
    const migrated = migrateLegacyModelId(configured);
    const canonical =
      migrated === DEFAULT_MODEL || migrated === PRO_MODEL ? migrated : DEFAULT_MODEL;
    const allowed =
      canonical === PRO_MODEL && hasResolvedPlan() && !isProPlan()
        ? DEFAULT_MODEL
        : canonical;
    if (configured === allowed) return;
    agentSettings.model = allowed;
    deps.postToNative({ type: "agent:settings:set", settings: { model: allowed } }, true);
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
        window.dispatchEvent(new CustomEvent("tex64:open-plans"));
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
    postToNative: deps.postToNative,
    requestAiAccessCheck,
    requestPlatformUsage,
    pricingFallbackUrl: TEX64_LINKS.pricing,
    state: platformState,
    onStatusUpdate: () => {
      // Plan may have changed (e.g. AI access refreshed) — re-gate the Pro option.
      persistCompatibleModelSelection();
      syncModelSelect();
    },
  });

  const gatedNeedsLogin = () => needsLogin();
  const gatedAiBlocked = () => isAiBlocked();

  const _rawUpdateStatusDisplay = updateStatusDisplay;
  const wrappedUpdateStatusDisplay = () => {
    _rawUpdateStatusDisplay();
    syncModelSelect();
  };

  const getChat = (chatId?: string | null) => getChatState(chatIndex, activeChatId, chatId);
  const normalizeWorkspaceRoot = (value: string | null | undefined) => {
    const normalized = typeof value === "string"
      ? value.trim().replace(/\\/g, "/").replace(/\/$/, "")
      : "";
    return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  let chatWorkspaceRoot = normalizeWorkspaceRoot(deps.getWorkspaceRoot?.());

  const resolveChatTitle = (chatId: string) => {
    if (chatId === "search-rename" || chatId.startsWith("search-rename:")) {
      return "symbol rename";
    }
    return `Chat ${chats.length + 1}`;
  };

  const ensureChat = (chatId?: string | null) =>
    ensureChatState({
      chatId,
      activeChatId,
      chats,
      chatIndex,
      resolveChatTitle,
    });

  const createChat = () => {
    const chat = createChatState({
      chats,
      chatIndex,
      makeChatId,
      resolveChatTitle,
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
    // "+" while the history list is open closes it: the new chat is the view.
    closeHistory();
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
    renderEmptyState();
    wrappedUpdateStatusDisplay();
    updateSendState();
    renderHistoryList();
  };

  const { renderHistoryList, closeHistory } = createHistoryController({
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
  // A place on the page: page number, the text there, and the source line
  // SyncTeX found for it. It rides along with the next request as its
  // first referenced item and clears once sent.
  let pdfPlace: { page: number; path: string; line: number; text: string } | null = null;
  let pendingPdfAsk: { requestId: string; page: number; text: string } | null = null;
  const updateContextBar = createContextBarUpdater({
    aiContextBar,
    getActiveFilePath: deps.getActiveFilePath,
    getActiveSelectionSnapshot: deps.getActiveSelectionSnapshot,
    getActiveCursorPosition: deps.getActiveCursorPosition,
    getPdfPlace: () => pdfPlace,
    onClearPdfPlace: () => {
      pdfPlace = null;
      updateContextBar();
    },
  });
  const askFromPdf: AiChatApi["askFromPdf"] = (payload) => {
    // The live preview brings the source line with it: no SyncTeX round trip.
    if (payload.source && typeof payload.sourcePath === "string" && payload.sourcePath) {
      pendingPdfAsk = null;
      pdfPlace = { page: payload.page, path: payload.sourcePath, line: payload.source.line, text: payload.text };
      updateContextBar();
      if (aiInput instanceof HTMLTextAreaElement) aiInput.focus();
      return;
    }
    const requestId = `ask-axiom:${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
    pendingPdfAsk = { requestId, page: payload.page, text: payload.text };
    deps.postToNative(
      {
        type: "synctex:reverse",
        requestId,
        page: payload.page,
        x: payload.x,
        y: payload.y,
        pdfPath: payload.pdfPath ?? undefined,
        preferExact: true,
      },
      true,
    );
    if (aiInput instanceof HTMLTextAreaElement) aiInput.focus();
  };
  const handlePdfReverseResult: AiChatApi["handlePdfReverseResult"] = (payload) => {
    if (!pendingPdfAsk || payload?.requestId !== pendingPdfAsk.requestId) return;
    const pending = pendingPdfAsk;
    pendingPdfAsk = null;
    if (payload.ok && typeof payload.path === "string" && typeof payload.line === "number") {
      pdfPlace = { page: pending.page, path: payload.path, line: payload.line, text: pending.text };
    } else {
      // Without a source line the page still says where; the text carries the rest.
      pdfPlace = { page: pending.page, path: deps.getActiveFilePath() ?? "", line: 0, text: pending.text };
    }
    updateContextBar();
    if (aiInput instanceof HTMLTextAreaElement) aiInput.focus();
  };

  const autoGrow = () => {
    if (!(aiInput instanceof HTMLTextAreaElement)) return;
    aiInput.style.height = "auto";
    aiInput.style.height = Math.min(aiInput.scrollHeight, 200) + "px";
  };
  if (aiInput instanceof HTMLTextAreaElement) {
    aiInput.addEventListener("input", autoGrow);
    aiInput.addEventListener("input", () => updateSendState());
  }
  if (aiAttachments instanceof HTMLElement) {
    new MutationObserver(() => updateSendState()).observe(aiAttachments, { childList: true });
  }

  // ── @ picker: files, sections, labels, bib entries, issues ──
  // The document index comes from the host on demand (a scan of the .tex and
  // .bib files, milliseconds); it is asked for when the picker opens.
  let documentIndex: {
    sections: Array<{ path: string; id: number; type: string; number?: string; title: string; line: number; endLine: number }>;
    labels: Array<{ key: string; path: string; line: number }>;
    bibKeys: Array<{ key: string; path: string; line?: number; title?: string }>;
    git: { isRepo: boolean; changed: number };
    rules: { exists: boolean };
  } = { sections: [], labels: [], bibKeys: [], git: { isRepo: false, changed: 0 }, rules: { exists: false } };
  let documentIndexRequestedAt = 0;
  const requestDocumentMap = (force = false) => {
    const now = Date.now();
    if (!force && now - documentIndexRequestedAt < 2_000) return;
    documentIndexRequestedAt = now;
    deps.postToNative(
      { type: "agent:documentMap:get", requestId: `map-${now.toString(36)}`, activeFilePath: deps.getActiveFilePath() ?? undefined },
      true,
    );
  };
  const mentionCandidates = (): MentionCandidate[] => {
    const files = (deps.getWorkspaceFiles?.() ?? []).map((path): MentionCandidate => ({ kind: "file", path }));
    const sections = documentIndex.sections.map((section): MentionCandidate => ({ kind: "section", ...section }));
    const labels = documentIndex.labels.map((label): MentionCandidate => ({ kind: "label", ...label }));
    const bib = documentIndex.bibKeys.map((entry): MentionCandidate => ({ kind: "bib", ...entry }));
    const issueSnapshot = deps.getRecentIssuesSnapshot?.() ?? null;
    const issues = (issueSnapshot?.issues ?? []).slice(0, 8).map((issue): MentionCandidate => ({
      kind: "issue",
      message: issue.message,
      path: issue.path ?? undefined,
      line: typeof issue.line === "number" ? issue.line : undefined,
      severity: issue.severity,
    }));
    return [...sections, ...labels, ...files, ...bib, ...issues];
  };
  const mentionController =
    aiInput instanceof HTMLTextAreaElement
      ? createMentionController({
          aiInput,
          getCandidates: mentionCandidates,
          onOpen: () => requestDocumentMap(),
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
    const hasDraft =
      (aiInput instanceof HTMLTextAreaElement && aiInput.value.trim().length > 0) ||
      getPendingAttachments().length > 0;
    if (aiSend instanceof HTMLButtonElement) {
      aiSend.disabled = blockSend;
      aiSend.classList.remove("is-loading");
      aiSend.style.display = blockSend || !hasDraft ? "none" : "flex";
    }
    if (aiInput instanceof HTMLTextAreaElement) aiInput.disabled = false;
    // Attachments are allowed while a turn runs: the request queues with them.
    if (aiAttach instanceof HTMLButtonElement) aiAttach.disabled = false;
    if (aiAttachInput instanceof HTMLInputElement) aiAttachInput.disabled = false;
    if (aiStop instanceof HTMLButtonElement) {
      aiStop.disabled = false;
      aiStop.innerHTML = isRunning
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="8,5 20,12 8,19"/></svg>';
      aiStop.classList.toggle("is-resume", canResume && !isRunning);
      aiStop.title = canResume && !isRunning ? uiText("Continue", "続きから進める") : uiText("Stop", "止める");
      aiStop.style.display = isRunning || canResume ? "flex" : "none";
    }
    if (aiUndo instanceof HTMLButtonElement) {
      aiUndo.style.display = canUndo ? "flex" : "none";
      aiUndo.disabled = !canUndo;
    }
  };

  const _rawBuildContextPayload = createContextPayloadBuilder(deps);
  const buildContextPayload = (extras: ContextExtras = {}) => {
    const refs = mentionController ? mentionController.getExplicitRefs() : [];
    const placeRefs = pdfPlace
      ? [{ kind: "pdf" as const, page: pdfPlace.page, path: pdfPlace.path, line: pdfPlace.line, text: pdfPlace.text }]
      : [];
    const payload = _rawBuildContextPayload({
      ...extras,
      explicitContextRefs: [...placeRefs, ...(extras.explicitContextRefs ?? []), ...refs],
    });
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

  // What an empty chat offers: four ways to start on the open document.
  // Rows, not chips; each is a request the user could have typed.
  const STARTERS: Array<{ key: "review" | "build" | "math" | "bib"; icon: string }> = [
    {
      key: "review",
      icon: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h6a3 3 0 0 1 3 3v11a2 2 0 0 0-2-2H4z"/><path d="M20 5h-6a3 3 0 0 0-3 3v11a2 2 0 0 1 2-2h7z"/></svg>',
    },
    {
      key: "build",
      icon: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5.5"/></svg>',
    },
    {
      key: "math",
      icon: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6H7l6 6-6 6h11"/></svg>',
    },
    {
      key: "bib",
      icon: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>',
    },
  ];

  const buildEmptyState = () => {
    const root = document.createElement("div");
    root.className = "ai-empty-state";
    const head = document.createElement("div");
    head.className = "ai-empty-head";
    const title = document.createElement("span");
    title.className = "ai-empty-title";
    title.textContent = aiText("empty_title");
    const desc = document.createElement("span");
    desc.className = "ai-empty-desc";
    desc.textContent = aiText("empty_desc");
    head.append(title, desc);
    const list = document.createElement("div");
    list.className = "ai-empty-starts";
    STARTERS.forEach((starter, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ai-start-row";
      row.dataset.aiStart = aiText(`start_${starter.key}_request`);
      row.style.setProperty("--ai-row-index", String(index));
      const icon = document.createElement("span");
      icon.className = "ai-start-icon";
      icon.innerHTML = starter.icon;
      const text = document.createElement("span");
      text.className = "ai-start-text";
      const rowTitle = document.createElement("span");
      rowTitle.className = "ai-start-title";
      rowTitle.textContent = aiText(`start_${starter.key}_title`);
      const rowDesc = document.createElement("span");
      rowDesc.className = "ai-start-desc";
      rowDesc.textContent = aiText(`start_${starter.key}_desc`);
      text.append(rowTitle, rowDesc);
      row.append(icon, text);
      list.appendChild(row);
    });
    // A git workspace with changes gets one more way in: a review of the
    // diff, which reads and reports rather than edits.
    if (documentIndex.git.isRepo && documentIndex.git.changed > 0) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ai-start-row";
      row.dataset.aiStart = aiText("start_review_changes_request");
      row.dataset.aiStartMode = "ask";
      row.style.setProperty("--ai-row-index", String(STARTERS.length));
      const icon = document.createElement("span");
      icon.className = "ai-start-icon";
      icon.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M6 17c0-4 12-2 12-6"/></svg>';
      const text = document.createElement("span");
      text.className = "ai-start-text";
      const rowTitle = document.createElement("span");
      rowTitle.className = "ai-start-title";
      rowTitle.textContent = aiText("start_review_changes_title");
      const rowDesc = document.createElement("span");
      rowDesc.className = "ai-start-desc";
      rowDesc.textContent = aiText("start_review_changes_desc").replace("{n}", String(documentIndex.git.changed));
      text.append(rowTitle, rowDesc);
      row.append(icon, text);
      list.appendChild(row);
    }
    // The project's writing rules: opened (or created) in the editor.
    const foot = document.createElement("button");
    foot.type = "button";
    foot.className = "ai-empty-foot";
    foot.dataset.aiRules = "true";
    const footIcon = document.createElement("span");
    footIcon.className = "ai-start-icon";
    footIcon.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/></svg>';
    const footText = document.createElement("span");
    footText.className = "ai-start-text";
    const footTitle = document.createElement("span");
    footTitle.className = "ai-start-title";
    footTitle.textContent = aiText("rules_title");
    const footDesc = document.createElement("span");
    footDesc.className = "ai-start-desc";
    footDesc.textContent = documentIndex.rules.exists ? aiText("rules_desc") : `${aiText("rules_desc")} · ${aiText("rules_missing")}`;
    footText.append(footTitle, footDesc);
    foot.append(footIcon, footText);
    root.append(head, list, foot);
    return root;
  };

  // Shown only while the log has nothing else in it; `refresh` rebuilds the
  // copy after a locale change.
  const renderEmptyState = (refresh = false) => {
    const chatLog = getChatLog();
    if (!chatLog) return;
    const existing = chatLog.querySelector(".ai-empty-state");
    if (chatLog.querySelector(".ai-message, .ai-trace")) {
      existing?.remove();
      return;
    }
    if (existing && !refresh) return;
    existing?.remove();
    chatLog.prepend(buildEmptyState());
    // The review row and the rules line depend on the workspace: ask.
    requestDocumentMap();
  };

  const createTraceGroup = () => {
    const group = document.createElement("div");
    group.className = "ai-trace";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ai-trace-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML =
      '<svg class="ai-trace-caret" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>' +
      `<span class="ai-trace-title">${aiText("trace_title")}</span>` +
      '<span class="ai-trace-count">0</span>';
    toggle.addEventListener("click", () => {
      const open = group.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    const body = document.createElement("div");
    body.className = "ai-trace-body";
    group.append(toggle, body);
    return group;
  };

  // A work-log line folds into the open log just above the working line;
  // anything else goes to the end, as before.
  const placeInChatLog = (chatLog: HTMLElement, element: HTMLElement) => {
    if (!element.classList.contains("ai-trace-line")) {
      chatLog.appendChild(element);
      return;
    }
    const thinking = chatLog.querySelector<HTMLElement>(".ai-thinking-message");
    let group: Element | null =
      thinking && thinking.parentElement === chatLog
        ? thinking.previousElementSibling
        : chatLog.lastElementChild;
    if (group && group.id === "ai-proposals") group = group.previousElementSibling;
    if (!(group instanceof HTMLElement) || !group.classList.contains("ai-trace")) {
      group = createTraceGroup();
      if (thinking && thinking.parentElement === chatLog) chatLog.insertBefore(group, thinking);
      else chatLog.appendChild(group);
    }
    const body = group.querySelector(".ai-trace-body");
    body?.appendChild(element);
    const counter = group.querySelector(".ai-trace-count");
    if (counter) counter.textContent = String(body?.childElementCount ?? 0);
  };

  const appendToChatLog = (element: HTMLElement) => {
    const chatLog = getChatLog();
    if (!chatLog) return;
    chatLog.querySelector(".ai-empty-state")?.remove();
    placeInChatLog(chatLog, element);
  };

  // Stick-to-bottom scrolling: while the user is reading older messages
  // (scrolled up), streaming updates must NOT yank the view back down.
  // The log stays "pinned" as long as the user is at (or near) the bottom;
  // scrolling up unpins, scrolling back down re-pins. Forced scrolls
  // (sending a message, switching chats) always re-pin.
  let chatPinnedToBottom = true;
  if (aiChatLog instanceof HTMLElement) {
    aiChatLog.addEventListener(
      "scroll",
      () => {
        const distanceFromBottom =
          aiChatLog.scrollHeight - aiChatLog.scrollTop - aiChatLog.clientHeight;
        chatPinnedToBottom = distanceFromBottom < 48;
      },
      { passive: true }
    );
    // File chips and web links inside assistant messages. Both are rendered as
    // inert elements by the markdown renderer and only act through here, so a
    // link in model output can never navigate the renderer itself.
    aiChatLog.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const actionEl = target?.closest?.("[data-ai-action]") as HTMLElement | null;
      if (actionEl) {
        event.preventDefault();
        const messageEl = actionEl.closest(".ai-message") as HTMLElement | null;
        if (actionEl.dataset.aiAction === "copy") {
          const text =
            messageEl?.dataset.rawText ??
            messageEl?.querySelector(".ai-message-content")?.textContent ??
            "";
          if (text) {
            void navigator.clipboard?.writeText(text).then(() => {
              actionEl.classList.add("is-done");
              actionEl.title = aiText("action_copied");
              window.setTimeout(() => {
                actionEl.classList.remove("is-done");
                actionEl.title = aiText("action_copy");
              }, 1400);
            });
          }
          return;
        }
        if (actionEl.dataset.aiAction === "retry") {
          // The request that produced this reply is the nearest user turn above.
          let node: Element | null = messageEl?.previousElementSibling ?? null;
          while (node && !node.classList.contains("is-user")) node = node.previousElementSibling;
          const text = node?.querySelector(".ai-message-content")?.textContent?.trim() ?? "";
          if (text) submitFromUi?.(text);
          return;
        }
        const assistantIndex = Number(messageEl?.dataset.assistantIndex);
        const chat = getChat(activeChatId);
        if (!messageEl || !chat || !Number.isFinite(assistantIndex)) return;
        if (actionEl.dataset.aiAction === "rate-up") {
          messageEl.querySelector(".ai-rate-box")?.remove();
          sendRating(chat, messageEl, assistantIndex, "up", "");
          return;
        }
        if (actionEl.dataset.aiAction === "rate-down") {
          // A short note on what went wrong makes the rating useful; it is
          // optional, and the box says where the exchange goes.
          let box = messageEl.querySelector<HTMLElement>(".ai-rate-box");
          if (!box) {
            box = createRatingBox();
            messageEl.appendChild(box);
          }
          box.querySelector<HTMLTextAreaElement>("textarea")?.focus();
          return;
        }
        if (actionEl.dataset.aiAction === "branch") {
          deps.postToNative({ type: "agent:branch", conversationId: chat.id, assistantIndex });
          return;
        }
      }
      const rateCancel = target?.closest?.("[data-ai-rate-cancel]") as HTMLElement | null;
      if (rateCancel) {
        event.preventDefault();
        rateCancel.closest(".ai-rate-box")?.remove();
        return;
      }
      const fileEl = target?.closest?.("[data-open-file]") as HTMLElement | null;
      if (fileEl) {
        event.preventDefault();
        const filePath = fileEl.dataset.openFile ?? "";
        if (filePath) deps.postToNative({ type: "openFile", path: filePath });
        return;
      }
      const rulesEl = target?.closest?.("[data-ai-rules]") as HTMLElement | null;
      if (rulesEl) {
        event.preventDefault();
        deps.postToNative({ type: "agent:rules:open" }, true);
        return;
      }
      const urlEl = target?.closest?.("[data-open-url]") as HTMLElement | null;
      if (urlEl) {
        event.preventDefault();
        const url = urlEl.dataset.openUrl ?? "";
        if (url) openExternalUrl(url);
      }
    });
  }

  if (aiChatLog instanceof HTMLElement) {
    aiChatLog.addEventListener("submit", (event) => {
      const form = event.target as HTMLFormElement | null;
      if (!(form instanceof HTMLFormElement) || !form.dataset.aiRateBox) return;
      event.preventDefault();
      const messageEl = form.closest<HTMLElement>(".ai-message.is-assistant");
      const assistantIndex = Number(messageEl?.dataset.assistantIndex);
      const chat = getChat(activeChatId);
      if (!messageEl || !chat || !Number.isFinite(assistantIndex)) return;
      const comment = form.querySelector<HTMLTextAreaElement>("textarea")?.value.trim() ?? "";
      sendRating(chat, messageEl, assistantIndex, "down", comment);
    });
  }

  /** A rating goes to the host (and on to the team) with the exchange attached. */
  const sendRating = (
    chat: ChatState,
    messageEl: HTMLElement,
    assistantIndex: number,
    rating: "up" | "down",
    comment: string,
  ) => {
    const replies = chat.messages.filter((msg) => msg.role === "assistant");
    const message = replies[assistantIndex];
    if (message) message.rating = rating;
    setMessageRating(messageEl, rating);
    const box = messageEl.querySelector<HTMLElement>(".ai-rate-box");
    if (box) {
      box.replaceChildren();
      box.classList.add("is-done");
      box.textContent = "…";
    }
    deps.postToNative({ type: "agent:feedback", conversationId: chat.id, assistantIndex, rating, comment }, true);
  };

  const scrollToBottom = (force = false) => {
    if (!(aiChatLog instanceof HTMLElement)) return;
    if (force) chatPinnedToBottom = true;
    if (!chatPinnedToBottom) return;
    // Use rAF to ensure the DOM layout is up-to-date before scrolling.
    requestAnimationFrame(() => {
      if (!chatPinnedToBottom) return;
      aiChatLog.scrollTop = aiChatLog.scrollHeight;
    });
  };

  const ensureStreamingMessage = (chatId: string) => {
    const existing = streamingMessages.get(chatId);
    if (existing) return existing;
    const chat = ensureChat(chatId);
    if (!chat) return null;
    const message: ChatMessage = { role: "assistant", text: "", createdAt: Date.now() };
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

  const assistantOrdinal = (chat: ChatState, message: ChatMessage) => {
    let ordinal = -1;
    for (const entry of chat.messages) {
      if (entry.role === "assistant") ordinal += 1;
      if (entry === message) break;
    }
    return ordinal;
  };

  const appendMessage = (message: ChatMessage, chatId?: string) => {
    const chat = ensureChat(chatId);
    if (!chat) return;
    if (message.createdAt === undefined) message.createdAt = Date.now();
    chat.messages.push(message);
    if (chat.id !== activeChatId || !(aiChatLog instanceof HTMLElement)) return;
    if (message.role === "assistant") {
      // A new reply takes over Tab and Enter from the previous one's steps.
      aiChatLog.querySelectorAll(".ai-next-steps.is-latest").forEach((el) => el.classList.remove("is-latest"));
      aiChatLog.querySelectorAll(".ai-question").forEach((el) => el.remove());
    }
    appendToChatLog(
      createMessageElement(message, {
        assistantIndex: message.role === "assistant" ? assistantOrdinal(chat, message) : undefined,
        latest: message.role === "assistant",
        renderChanges: renderChangesForMessage(chat),
      }),
    );
    // Sending your own message always snaps to the bottom; incoming
    // assistant/system messages respect the user's scroll position.
    scrollToBottom(message.role === "user");
  };

  /** A queued request the reader took back, or that went out. */
  const removeQueuedMessage = (chatId: string, queueId: string) => {
    const chat = getChat(chatId);
    if (!chat) return;
    const index = chat.messages.findIndex((msg) => msg.queued && msg.queueId === queueId);
    if (index >= 0) chat.messages.splice(index, 1);
    if (chat.id === activeChatId && aiChatLog instanceof HTMLElement) {
      aiChatLog.querySelector(`.ai-message.is-queued[data-ai-queue-id="${queueId}"]`)?.remove();
    }
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
    if (!raw) return aiText("status_thinking");
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

  let pendingAiProposalIds: string[] = [];
  const buildUnifiedProposalCard = (proposals: AgentProposal[], chat: ChatState, canUndo: boolean) =>
    createUnifiedProposalCard(proposals, chat.appliedProposalIds, {
      postToNative: deps.postToNative,
      setPendingProposalIds: (ids) => { pendingAiProposalIds = ids; },
      showDiffModal: deps.showDiffModal,
      showMultiFileDiff: deps.showMultiFileDiff,
      setDiffContext: deps.setDiffContext,
      canUndo: canUndo && chat.hasUndo && !runningConversations.has(chat.id),
      undoRun: () => {
        deps.postToNative({ type: "agent:undoLastRunApply", conversationId: chat.id });
      },
    });

  // The latest reply that wrote files is the one "Undo" can take back.
  const latestReplyWithChanges = (chat: ChatState) =>
    [...chat.messages].reverse().find((msg) => msg.role === "assistant" && Array.isArray(msg.changes) && msg.changes.length > 0) ?? null;

  /** The change card inside a reply; Undo only on the newest one. */
  const renderChangesForMessage = (chat: ChatState) => (message: ChatMessage) => {
    if (!Array.isArray(message.changes) || message.changes.length === 0) return null;
    return buildUnifiedProposalCard(message.changes, chat, message === latestReplyWithChanges(chat));
  };

  // Changes arrive while the turn runs; they live in the running card until
  // the reply finalizes, then move into that reply. Only applied changes
  // move; one waiting for Apply stays in the running card.
  const settleLiveProposals = (chat: ChatState, target?: ChatMessage | null) => {
    if (chat.proposals.size === 0) return;
    const reply = target ?? [...chat.messages].reverse().find((msg) => msg.role === "assistant") ?? null;
    const applied: AgentProposal[] = [];
    for (const [id, proposal] of chat.proposals) {
      const isApplied =
        (proposal as AgentProposal & { autoApplied?: boolean }).autoApplied === true || chat.appliedProposalIds.has(id);
      if (!isApplied) continue;
      applied.push(proposal);
    }
    if (reply && applied.length > 0) {
      reply.changes = [...(reply.changes ?? []), ...applied];
    }
    for (const proposal of applied) chat.proposals.delete(proposal.id);
  };

  // The running card: changes of the turn in progress (and any still waiting for Apply).
  const rebuildProposalCards = (chatId: string) => {
    const chat = getChat(chatId);
    if (!chat || chat.id !== activeChatId) return;
    const container = ensureProposalsEmbedded();
    if (!container) return;
    container.replaceChildren();
    container.classList.toggle("is-hidden", chat.proposals.size === 0);
    if (chat.proposals.size > 0) {
      const allProposals = Array.from(chat.proposals.values());
      container.appendChild(buildUnifiedProposalCard(allProposals, chat, false));
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
    const lastAssistant = [...chat.messages].reverse().find((msg) => msg.role === "assistant") ?? null;
    let ordinal = -1;
    chat.messages.forEach((msg) => {
      if (!chatLog) return;
      if (msg.role === "assistant") ordinal += 1;
      placeInChatLog(
        chatLog,
        createMessageElement(msg, {
          assistantIndex: msg.role === "assistant" ? ordinal : undefined,
          latest: msg === lastAssistant,
          renderChanges: renderChangesForMessage(chat),
        }),
      );
    });
    renderEmptyState();
    const proposals = ensureProposalsEmbedded();
    if (proposals) {
      proposals.replaceChildren();
      proposals.classList.toggle("is-hidden", chat.proposals.size === 0);
      if (chat.proposals.size > 0) {
        const allProposals = Array.from(chat.proposals.values());
        proposals.appendChild(buildUnifiedProposalCard(allProposals, chat, false));
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
    scrollToBottom(true);
  };

  const restoreDraftFromPending = (chatId: string, request: PendingAiRequest | null) =>
    restorePendingAiDraft({ chatId, request, activeChatId, aiInput, autoGrow, appendMessage, setPendingAttachments });

  const { requestAgentRun } = createAiChatRunner({
    isAiBlocked: gatedAiBlocked,
    needsLogin: gatedNeedsLogin,
    requestAiAccessCheck,
    requestPlatformUsage,
    updateStatusDisplay: wrappedUpdateStatusDisplay,
    ensureChat,
    runningConversations,
    pendingAgentRequests,
    upsertThinkingMessage,
    renderHistoryList,
    updateSendState,
    postToNative: deps.postToNative,
    buildContextPayload: () => buildContextPayload({ axiomMode: eventApi?.getMode() ?? "agent" }),
    getAgentSettings: () => agentSettings,
    clearThinkingMessage,
    restoreDraftFromPending,
  });

  // ── Voice: the microphone in the composer ──
  const voice = createVoiceController({
    aiMic,
    aiMicTimer,
    aiInput,
    postToNative: deps.postToNative,
    notify: (message) => {
      if (!(aiStatus instanceof HTMLElement)) return;
      if (!message) {
        wrappedUpdateStatusDisplay();
        return;
      }
      aiStatus.replaceChildren();
      aiStatus.classList.remove("ai-status--error", "ai-status--warn", "ai-status--ok", "ai-status--actions-only");
      const line = document.createElement("div");
      line.className = "ai-status-line";
      line.textContent = message;
      aiStatus.appendChild(line);
      aiStatus.style.display = "block";
    },
    onTextInserted: () => {
      autoGrow();
      updateSendState();
    },
  });

  eventApi = initAiChatEventBindings({
    aiChatLog,
    aiInput,
    aiSend,
    aiAttach,
    aiAttachInput,
    aiStatus,
    aiUndo,
    aiStop,
    aiChatNew,
    aiModeToggle,
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
    removeQueuedMessage,
    settleLiveProposals: (chat) => {
      settleLiveProposals(chat);
      if (chat.id === activeChatId) rebuildProposalCards(chat.id);
    },
    autoGrow,
    updateContextBar,
    requestAgentRun,
    buildContextPayload,
    clearPendingAttachments,
    clearMentionPaths: () => {
      mentionController?.clearExplicitPaths();
      pdfPlace = null;
      updateContextBar();
    },
    addImageFiles,
    isAiBlocked: gatedAiBlocked,
    needsLogin: gatedNeedsLogin,
    requestAiAccessCheck,
    requestPlatformUsage,
    updateStatusDisplay: wrappedUpdateStatusDisplay,
    resolvePricingUrl,
    openExternalUrl,
    runningConversations,
    resumableConversations,
    pendingAgentRequests,
    clearThinkingMessage,
    upsertThinkingMessage,
    updateSendState,
    resetToNewChatState,
    scrollToBottom,
  });
  submitFromUi = (text: string) => eventApi?.submitMessage(text, { clearInput: false });

  const handleSettings = (s: AgentSettings) => {
    agentSettings = s;
    persistCompatibleModelSelection();
    updateSendState();
    syncModelSelect();
  };
  const {
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
  } = createAiChatIncomingHandlers({
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
    scheduleUsageRefresh,
    rebuildProposalCards,
    restoreDraftFromPending,
    updateContextBar,
    switchActiveChat,
    drainQueue: (chatId) => eventApi?.drainQueue(chatId),
    refreshActiveChat: () => renderChatContent(),
    settleLiveProposals,
    latestReplyWithChanges,
  });

  const handleDocumentMap: AiChatApi["handleDocumentMap"] = (payload) => {
    const previousGit = `${documentIndex.git.isRepo}:${documentIndex.git.changed}:${documentIndex.rules.exists}`;
    documentIndex = {
      sections: Array.isArray(payload?.sections) ? payload.sections : [],
      labels: Array.isArray(payload?.labels) ? payload.labels : [],
      bibKeys: Array.isArray(payload?.bibKeys) ? payload.bibKeys : [],
      git: {
        isRepo: payload?.git?.isRepo === true,
        changed: typeof payload?.git?.changed === "number" ? payload.git.changed : 0,
      },
      rules: { exists: payload?.rules?.exists === true },
    };
    mentionController?.refresh();
    const nextGit = `${documentIndex.git.isRepo}:${documentIndex.git.changed}:${documentIndex.rules.exists}`;
    if (nextGit !== previousGit && getChatLog()?.querySelector(".ai-empty-state")) {
      const chatLog = getChatLog();
      chatLog?.querySelector(".ai-empty-state")?.remove();
      chatLog?.prepend(buildEmptyState());
    }
  };

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

  const handleWorkspaceChanged = (rootPath: string | null) => {
    const nextRoot = normalizeWorkspaceRoot(rootPath);
    if (nextRoot === chatWorkspaceRoot) return false;
    chatWorkspaceRoot = nextRoot;
    chats.splice(0, chats.length);
    chatIndex.clear();
    proposalIndex.clear();
    runningConversations.clear();
    resumableConversations.clear();
    streamingMessages.clear();
    thinkingMessages.clear();
    pendingAgentRequests.clear();
    documentIndex = { sections: [], labels: [], bibKeys: [], git: { isRepo: false, changed: 0 }, rules: { exists: false } };
    resetToNewChatState();
    renderHistoryList();
    return true;
  };

  return {
    handleSettings,
    handleState: (state) =>
      handleState({
        ...state,
        sessions: (Array.isArray(state.sessions) ? state.sessions : []).filter(
          (session) =>
            normalizeWorkspaceRoot(session.workspaceRootPath) === chatWorkspaceRoot,
        ),
      }),
    handleStatus, handleMessage, handleMessageDelta, handleTool,
    handleProposal, handleApplyResult, handleUndoResult, handleUndoAvailability, handleScratchpad, handleThought, handleError, handleRequestRejected,
    handleTitle,
    handleMessageReset,
    handleFeedbackResult,
    handleBranchResult,
    handleProposalScope,
    askFromPdf,
    handlePdfReverseResult,
    handleTranscribeResult: (payload) => voice.handleTranscribeResult(payload),
    handleDocumentMap,
    handleWorkspaceChanged,
    refreshContextBar: updateContextBar,
    getCurrentPlan: () => platformState.platformAiAccess?.plan ?? "free",
    getUsageSnapshot: () => platformState.platformUsage,
    refreshPlan: (force = true) => requestAiAccessCheck(force),
    refreshUsage: (force = true) => requestPlatformUsage(force),
    handlePlatformAuth, handlePlatformAiAccess, handlePlatformUsage,
    handlePlatformUpdate,
    applyPendingFromDiffModal: () => {
      deps.postToNative({
        type: "agent:applyBatch",
        proposalIds: [...pendingAiProposalIds],
      });
      pendingAiProposalIds = [];
      // Clear the editor's Undo/Confirm bar to keep it in sync
      const bar = document.getElementById("ai-undo-keep-bar");
      if (bar) bar.remove();
    },
    clearPending: () => { pendingAiProposalIds = []; },
  };
};
