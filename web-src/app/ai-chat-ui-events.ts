import type { AgentSettings } from "./types.js";
import type { ChatState } from "./ai-chat-state.js";
import type { AiRequestPart } from "./ai-chat-runner.js";
import type { AiImageAttachment } from "./ai-chat-attachments.js";

type InitAiChatEventBindingsParams = {
  aiInput: Element | null | undefined;
  aiSend: Element | null | undefined;
  aiAttach: Element | null | undefined;
  aiAttachInput: Element | null | undefined;
  aiStatus: Element | null | undefined;
  aiUndo: Element | null | undefined;
  aiStop: Element | null | undefined;
  aiChatNew: Element | null | undefined;
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  getActiveChatId: () => string | null;
  setActiveChatId: (chatId: string | null) => void;
  getPendingAttachments: () => AiImageAttachment[];
  getChat: (chatId?: string | null) => ChatState | null;
  createChat: () => ChatState;
  setChatTitle: (chat: ChatState) => void;
  renderHistoryList: () => void;
  appendMessage: (message: { role: "user" | "assistant" | "system"; text: string }, chatId?: string) => void;
  autoGrow: () => void;
  updateContextBar: () => void;
  requestAgentRun: (
    chatId: string,
    message: string,
    parts?: AiRequestPart[],
    contextPayload?: Record<string, unknown>
  ) => boolean;
  buildContextPayload: (settings: AgentSettings | null) => Record<string, unknown>;
  getAgentSettings: () => AgentSettings | null;
  clearPendingAttachments: (resetInput?: boolean) => void;
  clearMentionPaths?: () => void;
  addImageFiles: (files: FileList | null) => Promise<void>;
  isAiBlocked: () => boolean;
  needsLogin: () => boolean;
  requestAiAccessCheck: (force?: boolean) => void;
  requestPlatformUsage: (force?: boolean) => void;
  updateStatusDisplay: () => void;
  showLoginOverlay: () => void;
  resolvePricingUrl: () => string;
  openExternalUrl: (url: string) => void;
  runningConversations: Set<string>;
  resumableConversations: Set<string>;
  pendingAgentRequests: Map<string, { message: string; parts?: AiRequestPart[]; contextPayload?: Record<string, unknown> }>;
  clearThinkingMessage: (chatId?: string | null) => void;
  upsertThinkingMessage: (chatId?: string | null, text?: string) => void;
  updateSendState: () => void;
  disableAutonomous: (chatId?: string | null) => void;
  resetToNewChatState: () => void;
};

export const initAiChatEventBindings = (params: InitAiChatEventBindingsParams) => {
  const {
    aiInput,
    aiSend,
    aiAttach,
    aiAttachInput,
    aiStatus,
    aiUndo,
    aiStop,
    aiChatNew,
    postToNative,
    getActiveChatId,
    setActiveChatId,
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
    getAgentSettings,
    clearPendingAttachments,
    clearMentionPaths,
    addImageFiles,
    isAiBlocked,
    needsLogin,
    requestAiAccessCheck,
    requestPlatformUsage,
    updateStatusDisplay,
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
  } = params;

  const handleSend = () => {
    if (!(aiInput instanceof HTMLTextAreaElement)) return;
    const text = aiInput.value.trim();
    const pendingAttachments = getPendingAttachments();
    const hasAttachments = pendingAttachments.length > 0;
    if (!text && !hasAttachments) return;
    if (isAiBlocked() || needsLogin()) {
      if (needsLogin()) {
        showLoginOverlay();
      } else {
        requestAiAccessCheck(true);
        requestPlatformUsage(true);
        updateStatusDisplay();
      }
      return;
    }

    // アクティブチャットが実行中なら、新規チャットを作成して送信先にする（並列実行対応）
    const currentActive = getChat(getActiveChatId());
    if (currentActive && runningConversations.has(currentActive.id)) {
      const c = createChat();
      setActiveChatId(c.id);
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

    renderHistoryList();
    const userLabel = text || "画像を送信しました。";
    const attachmentNote = hasAttachments ? `\n[添付画像 ${pendingAttachments.length}件]` : "";
    appendMessage({ role: "user", text: `${userLabel}${attachmentNote}` }, chat.id);
    aiInput.value = "";
    autoGrow();
    updateContextBar();
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
    const requestMessage = text || "添付画像を解析してください。";
    const contextPayload = buildContextPayload(getAgentSettings());
    const sent = requestAgentRun(chat.id, requestMessage, requestParts, contextPayload);
    if (sent) {
      clearPendingAttachments();
      clearMentionPaths?.();
    }
  };

  if (aiSend instanceof HTMLButtonElement) aiSend.addEventListener("click", handleSend);
  if (aiInput instanceof HTMLTextAreaElement) {
    aiInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        handleSend();
      }
    });
    aiInput.addEventListener("paste", (event) => {
      const files = event.clipboardData?.files ?? null;
      if (!files || files.length === 0) return;
      const hasImage = Array.from(files).some((file) => file.type.startsWith("image/"));
      if (!hasImage) return;
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
        openExternalUrl(resolvePricingUrl());
      }
    });
  }
  const attachDropHost = aiAttach instanceof HTMLElement ? aiAttach.closest(".ai-chat-input") : null;
  if (attachDropHost instanceof HTMLElement) {
    attachDropHost.addEventListener("dragover", (event) => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const hasImage = Array.from(files).some((file) => file.type.startsWith("image/"));
      if (!hasImage) return;
      event.preventDefault();
    });
    attachDropHost.addEventListener("drop", (event) => {
      const files = event.dataTransfer?.files ?? null;
      if (!files || files.length === 0) return;
      const hasImage = Array.from(files).some((file) => file.type.startsWith("image/"));
      if (!hasImage) return;
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
        disableAutonomous(chat.id);
        postToNative({ type: "agent:abort", conversationId: chat.id }, true);
        resumableConversations.delete(chat.id);
        pendingAgentRequests.delete(chat.id);
        chat.statusMessage = "";
        runningConversations.delete(chat.id);
        clearThinkingMessage(chat.id);
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
      const contextToSend = buildContextPayload(getAgentSettings());
      chat.statusMessage = "思考中...";
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
  if (aiInput instanceof HTMLTextAreaElement && !aiInput.placeholder.trim()) {
    aiInput.placeholder = "執筆内容を指示してください...";
  }
};
