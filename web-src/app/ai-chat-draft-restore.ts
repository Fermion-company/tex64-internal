import type { ChatMessage } from "./ai-chat-state.js";
import type { PendingAiRequest } from "./ai-chat-runner.js";

type RestorePendingAiDraftOptions = {
  chatId: string;
  request: PendingAiRequest | null;
  activeChatId: string | null;
  aiInput: Element | null;
  autoGrow: () => void;
  appendMessage: (message: ChatMessage, chatId?: string) => void;
};

export const restorePendingAiDraft = (options: RestorePendingAiDraftOptions) => {
  const { chatId, request, activeChatId, aiInput, autoGrow, appendMessage } = options;
  if (!request || chatId !== activeChatId) {
    return;
  }
  if (!(aiInput instanceof HTMLTextAreaElement)) {
    return;
  }
  if ((aiInput.value ?? "").trim().length > 0) {
    return;
  }
  const restored = typeof request.message === "string" ? request.message : "";
  if (!restored.trim()) {
    return;
  }
  aiInput.value = restored;
  autoGrow();
  aiInput.focus();
  appendMessage(
    {
      role: "system",
      text: "送信できなかった入力を復元しました。内容を確認して再送信してください。",
    },
    chatId
  );
};
