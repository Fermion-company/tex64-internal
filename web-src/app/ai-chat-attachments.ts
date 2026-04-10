import type { ChatMessage, ChatState } from "./ai-chat-state.js";

const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;

export type AiImageAttachment = {
  mimeType: string;
  data: string;
  name: string;
  size: number;
};

type CreateAiChatAttachmentsControllerOptions = {
  aiAttachments: Element | null;
  aiAttachInput: Element | null;
  aiStatus: Element | null;
  getActiveChatId: () => string | null;
  getChat: (chatId?: string | null) => ChatState | null;
  appendMessage: (message: ChatMessage, chatId?: string) => void;
};

const parseBase64FromDataUrl = (dataUrl: string) => {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
};

const readImageAttachment = async (file: File): Promise<AiImageAttachment | null> =>
  new Promise((resolve) => {
    if (!file || !file.type.startsWith("image/")) {
      resolve(null);
      return;
    }
    if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const parsed = parseBase64FromDataUrl(value);
      if (!parsed || !parsed.data) {
        resolve(null);
        return;
      }
      resolve({
        mimeType: parsed.mimeType || file.type || "image/png",
        data: parsed.data,
        name: file.name || "image",
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });

export const createAiChatAttachmentsController = (
  options: CreateAiChatAttachmentsControllerOptions
) => {
  const {
    aiAttachments,
    aiAttachInput,
    aiStatus,
    getActiveChatId,
    getChat,
    appendMessage,
  } = options;
  let pendingAttachments: AiImageAttachment[] = [];

  const renderAttachmentBar = () => {
    if (!(aiAttachments instanceof HTMLElement)) return;
    aiAttachments.replaceChildren();
    if (pendingAttachments.length === 0) {
      aiAttachments.classList.add("is-empty");
      return;
    }
    aiAttachments.classList.remove("is-empty");
    pendingAttachments.forEach((attachment, index) => {
      const chip = document.createElement("div");
      chip.className = "ai-attachment-chip";

      const name = document.createElement("span");
      name.className = "ai-attachment-name";
      name.textContent = attachment.name || `image-${index + 1}`;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ai-attachment-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "remove attachment");
      remove.addEventListener("click", () => {
        pendingAttachments = pendingAttachments.filter((_, targetIndex) => targetIndex !== index);
        renderAttachmentBar();
      });

      chip.append(name, remove);
      aiAttachments.appendChild(chip);
    });
  };

  const clearPendingAttachments = (resetInput = true) => {
    pendingAttachments = [];
    renderAttachmentBar();
    if (resetInput && aiAttachInput instanceof HTMLInputElement) {
      aiAttachInput.value = "";
    }
  };

  const addImageFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    let rejectedNonImage = 0;
    let rejectedTooLarge = 0;
    let rejectedByCount = 0;
    let rejectedByTotal = 0;
    let rejectedUnreadable = 0;
    let totalBytes = pendingAttachments.reduce((sum, item) => sum + item.size, 0);
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        rejectedNonImage += 1;
        continue;
      }
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        rejectedTooLarge += 1;
        continue;
      }
      if (pendingAttachments.length >= MAX_IMAGE_ATTACHMENTS) {
        rejectedByCount += 1;
        continue;
      }
      if (totalBytes + file.size > MAX_IMAGE_ATTACHMENT_TOTAL_BYTES) {
        rejectedByTotal += 1;
        continue;
      }
      const attachment = await readImageAttachment(file);
      if (!attachment) {
        rejectedUnreadable += 1;
        continue;
      }
      pendingAttachments.push(attachment);
      totalBytes += attachment.size;
    }
    renderAttachmentBar();
    const notices: string[] = [];
    if (rejectedTooLarge > 0) {
      notices.push(`Images larger than 5MB cannot be attached (${rejectedTooLarge}).`);
    }
    if (rejectedByTotal > 0) {
      notices.push("The total size of attached images is up to 8MB.");
    }
    if (rejectedByCount > 0) {
      notices.push("Up to 4 images can be attached.");
    }
    if (rejectedNonImage > 0) {
      notices.push(`Only image files can be attached (excluding ${rejectedNonImage}).`);
    }
    if (rejectedUnreadable > 0) {
      notices.push(`The image could not be attached because it failed to load (${rejectedUnreadable} items).`);
    }
    if (notices.length > 0) {
      const chat = getChat(getActiveChatId());
      if (chat) {
        appendMessage({ role: "system", text: notices.join("\n") }, chat.id);
      } else if (aiStatus instanceof HTMLElement) {
        aiStatus.textContent = notices.join(" ");
      }
    }
  };

  const setPendingAttachments = (attachments: AiImageAttachment[]) => {
    pendingAttachments = attachments.slice(0, MAX_IMAGE_ATTACHMENTS);
    renderAttachmentBar();
  };

  return {
    getPendingAttachments: () => pendingAttachments,
    renderAttachmentBar,
    clearPendingAttachments,
    addImageFiles,
    setPendingAttachments,
  };
};
