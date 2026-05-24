import type { ChatMessage, ChatState } from "./ai-chat-state.js";

const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_PDF_SOURCE_BYTES = 25 * 1024 * 1024;
const PDF_RENDER_TARGET_MAX_SIDE = 1600;

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

// pdfjs is vendored at Resources/web/pdfjs/ (ESM). Load it lazily so the chat
// panel doesn't pay for it unless a PDF is actually attached.
let pdfjsLibPromise: Promise<any> | null = null;
const loadPdfjs = async (): Promise<any> => {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const lib: any = await import(new URL("../pdfjs/pdf.min.mjs", import.meta.url).href);
      try {
        lib.GlobalWorkerOptions.workerSrc = new URL("../pdfjs/pdf.worker.min.mjs", import.meta.url).href;
      } catch {
        // worker URL is best-effort; pdfjs falls back to a fake worker if unset.
      }
      return lib;
    })();
  }
  return pdfjsLibPromise;
};

// Rasterize a PDF's pages to PNG/JPEG attachments so they flow through the
// existing image pipeline. Respects the caller's remaining count/byte budget.
const renderPdfToImageAttachments = async (
  file: File,
  budget: { remainingCount: number; remainingBytes: number }
): Promise<{ attachments: AiImageAttachment[]; truncatedPages: boolean }> => {
  const attachments: AiImageAttachment[] = [];
  if (budget.remainingCount <= 0 || budget.remainingBytes <= 0) {
    return { attachments, truncatedPages: true };
  }
  const pdfjsLib = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const baseName = (file.name || "pdf").replace(/\.pdf$/i, "");
  const maxPages = Math.min(doc.numPages, budget.remainingCount);
  let truncatedPages = doc.numPages > maxPages;
  let usedBytes = 0;
  try {
    for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const base = page.getViewport({ scale: 1 });
      const maxSide = Math.max(base.width, base.height) || PDF_RENDER_TARGET_MAX_SIDE;
      const scale = Math.min(2, Math.max(0.75, PDF_RENDER_TARGET_MAX_SIDE / maxSide));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      await page.render({ canvasContext: ctx, viewport }).promise;
      let parsed = parseBase64FromDataUrl(canvas.toDataURL("image/png"));
      let sizeBytes = parsed ? Math.round(parsed.data.length * 0.75) : Number.POSITIVE_INFINITY;
      if (sizeBytes > MAX_IMAGE_ATTACHMENT_BYTES) {
        parsed = parseBase64FromDataUrl(canvas.toDataURL("image/jpeg", 0.82));
        sizeBytes = parsed ? Math.round(parsed.data.length * 0.75) : Number.POSITIVE_INFINITY;
      }
      if (!parsed || sizeBytes > MAX_IMAGE_ATTACHMENT_BYTES) {
        truncatedPages = true;
        continue;
      }
      if (usedBytes + sizeBytes > budget.remainingBytes) {
        truncatedPages = true;
        break;
      }
      attachments.push({
        mimeType: parsed.mimeType || "image/png",
        data: parsed.data,
        name: `${baseName} p.${pageNum}`,
        size: sizeBytes,
      });
      usedBytes += sizeBytes;
    }
  } finally {
    try {
      await doc.cleanup?.();
      doc.destroy?.();
    } catch {
      // ignore cleanup errors
    }
  }
  return { attachments, truncatedPages };
};

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
    let rejectedUnsupported = 0;
    let rejectedTooLarge = 0;
    let rejectedByCount = 0;
    let rejectedByTotal = 0;
    let rejectedUnreadable = 0;
    let truncatedPages = false;
    let totalBytes = pendingAttachments.reduce((sum, item) => sum + item.size, 0);
    for (const file of files) {
      const isImage = file.type.startsWith("image/");
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      if (!isImage && !isPdf) {
        rejectedUnsupported += 1;
        continue;
      }
      if (pendingAttachments.length >= MAX_IMAGE_ATTACHMENTS) {
        rejectedByCount += 1;
        continue;
      }
      if (isImage) {
        if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
          rejectedTooLarge += 1;
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
        continue;
      }
      // PDF → rasterize pages to images via pdfjs, then attach as images.
      if (file.size > MAX_PDF_SOURCE_BYTES) {
        rejectedTooLarge += 1;
        continue;
      }
      let rendered: { attachments: AiImageAttachment[]; truncatedPages: boolean };
      try {
        rendered = await renderPdfToImageAttachments(file, {
          remainingCount: MAX_IMAGE_ATTACHMENTS - pendingAttachments.length,
          remainingBytes: MAX_IMAGE_ATTACHMENT_TOTAL_BYTES - totalBytes,
        });
      } catch {
        rejectedUnreadable += 1;
        continue;
      }
      if (rendered.truncatedPages) truncatedPages = true;
      if (rendered.attachments.length === 0) {
        rejectedUnreadable += 1;
        continue;
      }
      for (const att of rendered.attachments) {
        if (pendingAttachments.length >= MAX_IMAGE_ATTACHMENTS) {
          truncatedPages = true;
          break;
        }
        if (totalBytes + att.size > MAX_IMAGE_ATTACHMENT_TOTAL_BYTES) {
          truncatedPages = true;
          break;
        }
        pendingAttachments.push(att);
        totalBytes += att.size;
      }
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
    if (rejectedUnsupported > 0) {
      notices.push(`Only image or PDF files can be attached (excluding ${rejectedUnsupported}).`);
    }
    if (truncatedPages) {
      notices.push("Some PDF pages were not attached (limit: 4 images / 8MB total).");
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
