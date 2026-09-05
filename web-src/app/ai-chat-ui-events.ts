import type { ChatState, QueuedTurn } from "./ai-chat-state.js";
import type { AiRequestPart } from "./ai-chat-runner.js";
import type { AiImageAttachment } from "./ai-chat-attachments.js";
import type { ContextExtras } from "./ai-chat-context-payload.js";
import type { AgentQuestion } from "./types.js";
import { aiText } from "./ai-i18n.js";
import { setLocalizedAttribute } from "./i18n.js";
import { createQuestionElement, readPlanRequest, readQuestionAnswer } from "./ai-chat-message.js";
import type { AgentPlan } from "./types.js";

export type AxiomMode = "agent" | "ask" | "plan";

type InitAiChatEventBindingsParams = {
  aiChatLog?: Element | null | undefined;
  aiInput: Element | null | undefined;
  aiSend: Element | null | undefined;
  aiAttach: Element | null | undefined;
  aiAttachInput: Element | null | undefined;
  aiStatus: Element | null | undefined;
  aiUndo: Element | null | undefined;
  aiStop: Element | null | undefined;
  aiChatNew: Element | null | undefined;
  aiModeToggle?: Element | null | undefined;
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  getActiveChatId: () => string | null;
  setActiveChatId: (chatId: string | null) => void;
  getPendingAttachments: () => AiImageAttachment[];
  getChat: (chatId?: string | null) => ChatState | null;
  createChat: () => ChatState;
  setChatTitle: (chat: ChatState) => void;
  renderHistoryList: () => void;
  appendMessage: (
    message: { role: "user" | "assistant" | "system"; text: string; queued?: boolean; queueId?: string },
    chatId?: string,
  ) => void;
  removeQueuedMessage: (chatId: string, queueId: string) => void;
  /** Moves the previous turn's applied changes into its reply before a new request. */
  settleLiveProposals: (chat: ChatState) => void;
  autoGrow: () => void;
  updateContextBar: () => void;
  requestAgentRun: (
    chatId: string,
    message: string,
    parts?: AiRequestPart[],
    contextPayload?: Record<string, unknown>
  ) => boolean;
  buildContextPayload: (extras?: ContextExtras) => Record<string, unknown>;
  clearPendingAttachments: (resetInput?: boolean) => void;
  clearMentionPaths?: () => void;
  addImageFiles: (files: FileList | null) => Promise<void>;
  isAiBlocked: () => boolean;
  needsLogin: () => boolean;
  requestAiAccessCheck: (force?: boolean) => void;
  requestPlatformUsage: (force?: boolean) => void;
  updateStatusDisplay: () => void;
  resolvePricingUrl: () => string;
  openExternalUrl: (url: string) => void;
  runningConversations: Set<string>;
  resumableConversations: Set<string>;
  pendingAgentRequests: Map<string, { message: string; parts?: AiRequestPart[]; contextPayload?: Record<string, unknown> }>;
  clearThinkingMessage: (chatId?: string | null) => void;
  upsertThinkingMessage: (chatId?: string | null, text?: string) => void;
  updateSendState: () => void;
  resetToNewChatState: () => void;
  onModeChange?: (mode: AxiomMode) => void;
  scrollToBottom?: (force?: boolean) => void;
};

const MODE_STORAGE_KEY = "tex64.axiom.mode";

const loadStoredMode = (): AxiomMode => {
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    return stored === "ask" || stored === "plan" ? stored : "agent";
  } catch {
    return "agent";
  }
};

const PLACEHOLDER_BY_MODE: Record<AxiomMode, string> = {
  agent: "Ask anything about this document. @ adds a file",
  ask: "Ask a question. Nothing is changed",
  plan: "Plan first. Nothing is written yet",
};

export const initAiChatEventBindings = (params: InitAiChatEventBindingsParams) => {
  const {
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
    postToNative,
    getActiveChatId,
    setActiveChatId,
    getPendingAttachments,
    getChat,
    createChat,
    setChatTitle,
    renderHistoryList,
    appendMessage,
    removeQueuedMessage,
    settleLiveProposals,
    autoGrow,
    updateContextBar,
    requestAgentRun,
    buildContextPayload,
    clearPendingAttachments,
    clearMentionPaths,
    addImageFiles,
    isAiBlocked,
    needsLogin,
    requestAiAccessCheck,
    requestPlatformUsage,
    updateStatusDisplay,
    runningConversations,
    resumableConversations,
    pendingAgentRequests,
    clearThinkingMessage,
    upsertThinkingMessage,
    updateSendState,
    resetToNewChatState,
    onModeChange,
    scrollToBottom,
  } = params;

  // ── Mode: Agent edits and builds, Ask only answers ──
  let mode: AxiomMode = loadStoredMode();
  const applyModeToDom = () => {
    if (aiModeToggle instanceof HTMLElement) {
      aiModeToggle.querySelectorAll<HTMLElement>("[data-ai-mode]").forEach((option) => {
        const active = option.dataset.aiMode === mode;
        option.classList.toggle("is-active", active);
        option.setAttribute("aria-checked", active ? "true" : "false");
      });
    }
    if (aiInput instanceof HTMLTextAreaElement) {
      // The locale pass translates from the recorded English source.
      setLocalizedAttribute(aiInput, "placeholder", PLACEHOLDER_BY_MODE[mode]);
    }
  };
  const setMode = (next: AxiomMode) => {
    mode = next === "ask" || next === "plan" ? next : "agent";
    try {
      localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      // stays for the session
    }
    applyModeToDom();
    onModeChange?.(mode);
  };
  // The pill's words and titles live in the markup and the locale dictionary.
  const syncModeLabels = () => applyModeToDom();
  if (aiModeToggle instanceof HTMLElement) {
    aiModeToggle.addEventListener("click", (event) => {
      const option = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-ai-mode]");
      if (!option) return;
      event.preventDefault();
      const chosen = option.dataset.aiMode;
      setMode(chosen === "ask" || chosen === "plan" ? chosen : "agent");
      if (aiInput instanceof HTMLTextAreaElement) aiInput.focus();
    });
  }
  syncModeLabels();

  const buildPayload = () => buildContextPayload({ axiomMode: mode });

  // ── Queue: a request typed while a turn runs waits behind it ──
  const makeQueueId = () => `q-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;

  const dispatchQueued = (chat: ChatState, item: QueuedTurn) => {
    removeQueuedMessage(chat.id, item.id);
    chat.queue = chat.queue.filter((entry) => entry.id !== item.id);
    settleLiveProposals(chat);
    appendMessage({ role: "user", text: item.text }, chat.id);
    const sent = requestAgentRun(chat.id, item.text, item.parts, item.contextPayload);
    if (!sent) {
      // Put it back at the front; the reader can send it again by hand.
      chat.queue.unshift(item);
      appendMessage({ role: "user", text: item.text, queued: true, queueId: item.id }, chat.id);
    }
    renderHistoryList();
    updateSendState();
  };

  /** Send the next waiting request of a chat, if any. */
  const drainQueue = (chatId: string) => {
    const chat = getChat(chatId);
    if (!chat || runningConversations.has(chat.id)) return;
    const next = chat.queue[0];
    if (!next) return;
    if (isAiBlocked() || needsLogin()) return;
    dispatchQueued(chat, next);
  };

  let sendGuard = false;
  // Core submit path shared by the send button, Enter, the starting points,
  // the next steps and the queue. clearInput is false for quick actions so
  // a half-typed draft is kept.
  const submitMessage = (
    rawText: string,
    opts?: { clearInput?: boolean; extras?: ContextExtras; queueIfRunning?: boolean },
  ) => {
    if (sendGuard) return;
    const clearInput = opts?.clearInput !== false;
    const text = typeof rawText === "string" ? rawText.trim() : "";
    const pendingAttachments = getPendingAttachments();
    const hasAttachments = pendingAttachments.length > 0;
    if (!text && !hasAttachments) return;
    if (isAiBlocked() || needsLogin()) {
      if (needsLogin()) {
        // The line above the composer already says so; sending starts the sign-in.
        postToNative({ type: "auth:google:start" });
      } else {
        requestAiAccessCheck(true);
        requestPlatformUsage(true);
        updateStatusDisplay();
      }
      return;
    }

    if (!getActiveChatId()) {
      const c = createChat();
      setActiveChatId(c.id);
    }
    const chat = getChat(getActiveChatId());
    if (!chat) return;

    if (chat.title.startsWith("Chat ") && text) {
      chat.title = text.slice(0, 24).replace(/\s+/g, " ") || chat.title;
    }
    setChatTitle(chat);

    const requestParts: AiRequestPart[] = [];
    if (text) {
      requestParts.push({ text });
    }
    pendingAttachments.forEach((attachment) => {
      requestParts.push({
        inlineData: {
          mimeType: attachment.mimeType,
          data: attachment.data,
        },
      });
    });
    const requestMessage = text || "Please analyze the attached image.";
    const contextPayload = buildContextPayload({ axiomMode: mode, ...(opts?.extras ?? {}) });
    const userLabel = text || "The image has been sent.";
    const attachmentNote = hasAttachments ? `\n[attached images ${pendingAttachments.length}]` : "";

    // A running turn keeps the chat: the new request waits behind it, in
    // view, and goes out by itself when the turn ends.
    if (runningConversations.has(chat.id) && opts?.queueIfRunning !== false) {
      const item: QueuedTurn = {
        id: makeQueueId(),
        text: requestMessage,
        parts: requestParts,
        contextPayload,
      };
      chat.queue.push(item);
      appendMessage({ role: "user", text: `${userLabel}${attachmentNote}`, queued: true, queueId: item.id }, chat.id);
      if (clearInput && aiInput instanceof HTMLTextAreaElement) {
        aiInput.value = "";
        autoGrow();
      }
      clearPendingAttachments();
      clearMentionPaths?.();
      renderHistoryList();
      updateSendState();
      scrollToBottom?.(true);
      return;
    }

    // The previous turn's changes stay with its reply; the running card
    // starts empty for this request.
    settleLiveProposals(chat);

    renderHistoryList();
    appendMessage({ role: "user", text: `${userLabel}${attachmentNote}` }, chat.id);
    if (clearInput && aiInput instanceof HTMLTextAreaElement) {
      aiInput.value = "";
      autoGrow();
    }
    updateContextBar();
    sendGuard = true;
    const sent = requestAgentRun(chat.id, requestMessage, requestParts, contextPayload);
    if (sent) {
      clearPendingAttachments();
      clearMentionPaths?.();
    }
    sendGuard = false;
  };

  const handleSend = () => {
    if (!(aiInput instanceof HTMLTextAreaElement)) return;
    submitMessage(aiInput.value, { clearInput: true });
  };

  if (aiSend instanceof HTMLButtonElement) aiSend.addEventListener("click", handleSend);

  // ── Choosable rows: the starting points of an empty chat, or the newest
  // next steps under a reply. Tab moves the highlight, Enter on an empty
  // composer takes the highlighted one, Escape lets go.
  const choiceRows = (): HTMLElement[] => {
    if (!(aiChatLog instanceof HTMLElement)) return [];
    const starts = Array.from(aiChatLog.querySelectorAll<HTMLElement>(".ai-start-row"));
    if (starts.length > 0) return starts;
    return Array.from(aiChatLog.querySelectorAll<HTMLElement>(".ai-next-steps.is-latest .ai-step-row"));
  };
  const highlightChoice = (index: number | null) => {
    choiceRows().forEach((row, rowIndex) => {
      row.classList.toggle("is-active", index !== null && rowIndex === index);
    });
  };
  const activeChoiceIndex = () => choiceRows().findIndex((row) => row.classList.contains("is-active"));

  const openStepQuestion = (row: HTMLElement) => {
    const asksRaw = row.dataset.aiAsks ?? "";
    let asks: AgentQuestion | null = null;
    try {
      asks = asksRaw ? (JSON.parse(asksRaw) as AgentQuestion) : null;
    } catch {
      asks = null;
    }
    const steps = row.closest<HTMLElement>(".ai-next-steps");
    if (!asks || !steps) return false;
    steps.querySelector(".ai-question")?.remove();
    const form = createQuestionElement(asks, {
      lead: row.querySelector(".ai-step-title")?.textContent ?? "",
      request: row.dataset.aiRequest ?? "",
      stepId: row.dataset.aiStepId ?? "",
    });
    steps.appendChild(form);
    const first = form.querySelector<HTMLElement>("input, textarea");
    first?.focus();
    scrollToBottom?.(true);
    return true;
  };

  const takeChoice = (row: HTMLElement) => {
    if (row.classList.contains("ai-start-row")) {
      const request = row.dataset.aiStart ?? "";
      // A review reads and reports; it runs as Ask whatever the pill says.
      const extras: ContextExtras | undefined = row.dataset.aiStartMode === "ask" ? { axiomMode: "ask" } : undefined;
      if (request) submitMessage(request, { clearInput: true, extras });
      return;
    }
    if (row.dataset.aiAsks && openStepQuestion(row)) return;
    // A step without its own question still starts with the brief: the
    // agent asks what decides the outcome before it writes.
    const request = row.dataset.aiRequest ?? "";
    if (request) {
      submitMessage(request, {
        clearInput: true,
        extras: { turnOrigin: "step", stepKind: row.dataset.aiStepKind === "mechanical" ? "mechanical" : "writing" },
      });
    }
  };

  // Typing takes over from the highlighted row.
  if (aiInput instanceof HTMLTextAreaElement) {
    aiInput.addEventListener("input", () => {
      if (aiInput.value.trim().length > 0 && activeChoiceIndex() >= 0) highlightChoice(null);
    });
  }
  if (aiChatLog instanceof HTMLElement) {
    aiChatLog.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const option = target?.closest?.(".ai-question-option") as HTMLElement | null;
      if (option) {
        event.preventDefault();
        const form = option.closest("form");
        form?.querySelectorAll(".ai-question-option").forEach((el) => el.classList.toggle("is-chosen", el === option));
        return;
      }
      const cancel = target?.closest?.("[data-ai-question-cancel]") as HTMLElement | null;
      if (cancel) {
        event.preventDefault();
        cancel.closest(".ai-question")?.remove();
        return;
      }
      const queued = target?.closest?.("[data-ai-queue-action]") as HTMLElement | null;
      if (queued) {
        event.preventDefault();
        const wrapper = queued.closest<HTMLElement>(".ai-message.is-queued");
        const chat = getChat(getActiveChatId());
        const queueId = wrapper?.dataset.aiQueueId ?? "";
        if (!chat || !queueId) return;
        const item = chat.queue.find((entry) => entry.id === queueId);
        if (!item) return;
        if (queued.dataset.aiQueueAction === "remove") {
          chat.queue = chat.queue.filter((entry) => entry.id !== queueId);
          removeQueuedMessage(chat.id, queueId);
          renderHistoryList();
          updateSendState();
          return;
        }
        if (runningConversations.has(chat.id)) return;
        dispatchQueued(chat, item);
        return;
      }
      const planRun = target?.closest?.("[data-ai-plan-run]") as HTMLElement | null;
      if (planRun) {
        event.preventDefault();
        const planEl = planRun.closest<HTMLElement>(".ai-plan");
        let plan: AgentPlan | null = null;
        try {
          plan = planEl?.dataset.aiPlanJson ? (JSON.parse(planEl.dataset.aiPlanJson) as AgentPlan) : null;
        } catch {
          plan = null;
        }
        if (!planEl || !plan) return;
        // The reviewed plan runs in Agent mode; the pill follows.
        setMode("agent");
        submitMessage(readPlanRequest(planEl, plan), { clearInput: false, extras: { axiomMode: "agent" } });
        return;
      }
      const row = target?.closest?.(".ai-start-row, .ai-step-row") as HTMLElement | null;
      if (!row) return;
      event.preventDefault();
      takeChoice(row);
    });
    // A question form: the answer becomes the next message, together with
    // the step's request when it belongs to a step.
    aiChatLog.addEventListener("submit", (event) => {
      const form = event.target as HTMLFormElement | null;
      if (!(form instanceof HTMLFormElement) || !form.dataset.aiQuestion) return;
      event.preventDefault();
      const answer = readQuestionAnswer(form);
      if (!answer.trim()) {
        form.querySelector<HTMLElement>("input, textarea")?.focus();
        return;
      }
      const request = form.dataset.aiRequest ?? "";
      const text = request ? `${request}\n\n${aiText("answer_placeholder")}: ${answer}` : answer;
      form.remove();
      submitMessage(text, { clearInput: false });
    });
    aiChatLog.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement | null;
      if (!(target instanceof HTMLTextAreaElement) || !target.classList.contains("ai-question-answer")) return;
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        target.form?.requestSubmit();
      }
    });
    aiChatLog.addEventListener("input", (event) => {
      const target = event.target as HTMLElement | null;
      if (target instanceof HTMLTextAreaElement && (target.classList.contains("ai-question-answer") || target.classList.contains("ai-rate-input") || target.classList.contains("ai-plan-note"))) {
        target.style.height = "auto";
        target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
      }
    });
  }

  if (aiInput instanceof HTMLTextAreaElement) {
    aiInput.addEventListener("keydown", (e) => {
      const rows = choiceRows();
      const composerEmpty = aiInput.value.trim().length === 0;
      if (e.key === "Tab" && rows.length > 0 && composerEmpty && !e.isComposing) {
        e.preventDefault();
        const current = activeChoiceIndex();
        const next =
          current < 0
            ? e.shiftKey ? rows.length - 1 : 0
            : (current + (e.shiftKey ? -1 : 1) + rows.length) % rows.length;
        highlightChoice(next);
        rows[next]?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (e.key === "Escape" && activeChoiceIndex() >= 0) {
        e.preventDefault();
        highlightChoice(null);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (composerEmpty && rows.length > 0) {
          const index = Math.max(0, activeChoiceIndex());
          const row = rows[index];
          if (row) takeChoice(row);
          return;
        }
        handleSend();
      }
    });
    aiInput.addEventListener("paste", (event) => {
      const files = event.clipboardData?.files ?? null;
      if (!files || files.length === 0) return;
      const hasSupported = Array.from(files).some(
        (file) => file.type.startsWith("image/") || file.type === "application/pdf" || /\.pdf$/i.test(file.name)
      );
      if (!hasSupported) return;
      event.preventDefault();
      void addImageFiles(files);
    });
  }
  if (aiAttach instanceof HTMLButtonElement && aiAttachInput instanceof HTMLInputElement) {
    aiAttach.addEventListener("click", () => {
      if (!aiAttach.disabled) aiAttachInput.click();
    });
    aiAttachInput.addEventListener("change", () => {
      void addImageFiles(aiAttachInput.files);
    });
  }
  if (aiStatus instanceof HTMLElement) {
    aiStatus.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest<HTMLButtonElement>("[data-ai-status-action]");
      if (!button) {
        return;
      }
      const action = button.dataset.aiStatusAction;
      if (action === "login") {
        postToNative({ type: "auth:google:start" });
        return;
      }
      if (action === "pricing") {
        window.dispatchEvent(new CustomEvent("tex64:open-plans"));
      }
    });
  }
  const attachDropHost = aiAttach instanceof HTMLElement ? aiAttach.closest(".ai-chat-input") : null;
  if (attachDropHost instanceof HTMLElement) {
    attachDropHost.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
    });
    attachDropHost.addEventListener("drop", (event) => {
      const files = event.dataTransfer?.files ?? null;
      if (!files || files.length === 0) return;
      const hasSupported = Array.from(files).some(
        (file) => file.type.startsWith("image/") || file.type === "application/pdf" || /\.pdf$/i.test(file.name)
      );
      if (!hasSupported) return;
      event.preventDefault();
      void addImageFiles(files);
    });
  }
  if (aiUndo instanceof HTMLButtonElement) {
    aiUndo.addEventListener("click", () => {
      const chat = getChat(getActiveChatId());
      if (!chat) return;
      postToNative({ type: "agent:undoLastRunApply", conversationId: chat.id });
    });
  }
  if (aiStop instanceof HTMLButtonElement) {
    aiStop.addEventListener("click", () => {
      const chat = getChat(getActiveChatId());
      if (!chat) return;
      if (runningConversations.has(chat.id)) {
        postToNative({ type: "agent:abort", conversationId: chat.id }, true);
        resumableConversations.delete(chat.id);
        pendingAgentRequests.delete(chat.id);
        // Keep the conversation locked until main reports a terminal state.
        // Main may still be compiling a completed partial edit; reopening send
        // here can replace its run token and abandon that definitive build.
        chat.statusMessage = "Finishing partial changes...";
        upsertThinkingMessage(chat.id, chat.statusMessage);
        renderHistoryList();
        updateSendState();
        updateStatusDisplay();
        return;
      }
      if (!resumableConversations.has(chat.id)) {
        return;
      }
      if (isAiBlocked() || needsLogin()) {
        requestAiAccessCheck(true);
        requestPlatformUsage(true);
        updateStatusDisplay();
        return;
      }
      const contextToSend = buildPayload();
      chat.statusMessage = "Thinking...";
      runningConversations.add(chat.id);
      resumableConversations.delete(chat.id);
      upsertThinkingMessage(chat.id, chat.statusMessage);
      renderHistoryList();
      updateSendState();
      updateStatusDisplay();
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
    });
  }
  if (aiChatNew instanceof HTMLButtonElement) {
    aiChatNew.addEventListener("click", () => {
      resetToNewChatState();
      if (aiInput instanceof HTMLTextAreaElement) aiInput.focus();
    });
  }
  return { submitMessage, drainQueue, getMode: () => mode, setMode, syncModeLabels, openStepQuestion };
};
