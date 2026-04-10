import type { ChatMessage } from "./ai-chat-state.js";
import type { PendingAiRequest } from "./ai-chat-runner.js";
import type { AiImageAttachment } from "./ai-chat-attachments.js";

type RestorePendingAiDraftOptions = {
  chatId: string;
  request: PendingAiRequest | null;
  activeChatId: string | null;
  aiInput: Element | null;
  autoGrow: () => void;
  appendMessage: (message: ChatMessage, chatId?: string) => void;
  setPendingAttachments?: (attachments: AiImageAttachment[]) => void;
};

export const restorePendingAiDraft = (options: RestorePendingAiDraftOptions) => {
  const { chatId, request, activeChatId, aiInput, autoGrow, appendMessage, setPendingAttachments } = options;
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

  // Restore image attachments from request parts
  const restoredImages: AiImageAttachment[] = [];
  if (Array.isArray(request.parts)) {
    for (const part of request.parts) {
      if (part && typeof part === "object" && "inlineData" in part && part.inlineData) {
        const { mimeType, data } = part.inlineData as { mimeType: string; data: string };
        if (mimeType && data) {
          restoredImages.push({
            mimeType,
            data,
            name: `restored-image-${restoredImages.length + 1}`,
            size: Math.round((data.length * 3) / 4),
          });
        }
      }
    }
  }

  if (!restored.trim() && restoredImages.length === 0) {
    return;
  }
  if (restored.trim()) {
    aiInput.value = restored;
  }
  if (restoredImages.length > 0 && setPendingAttachments) {
    setPendingAttachments(restoredImages);
  }
  autoGrow();
  aiInput.focus();
  appendMessage(
    {
      role: "system",
      text: restoredImages.length > 0
        ? `Restored unsent input (including ${restoredImages.length} attached images). Please review and resend.`
        : "Restored input that could not be sent. Please check the contents and resend.",
    },
    chatId
  );
};
