const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;
const parseBase64FromDataUrl = (dataUrl) => {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match)
        return null;
    return { mimeType: match[1], data: match[2] };
};
const readImageAttachment = async (file) => new Promise((resolve) => {
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
export const createAiChatAttachmentsController = (options) => {
    const { aiAttachments, aiAttachInput, aiStatus, getActiveChatId, getChat, appendMessage, } = options;
    let pendingAttachments = [];
    const renderAttachmentBar = () => {
        if (!(aiAttachments instanceof HTMLElement))
            return;
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
            remove.setAttribute("aria-label", "添付を削除");
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
    const addImageFiles = async (fileList) => {
        if (!fileList || fileList.length === 0)
            return;
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
        const notices = [];
        if (rejectedTooLarge > 0) {
            notices.push(`5MBを超える画像は添付できません（${rejectedTooLarge}件）。`);
        }
        if (rejectedByTotal > 0) {
            notices.push("添付画像の合計サイズは8MBまでです。");
        }
        if (rejectedByCount > 0) {
            notices.push("画像添付は最大4件までです。");
        }
        if (rejectedNonImage > 0) {
            notices.push(`画像ファイルのみ添付できます（${rejectedNonImage}件を除外）。`);
        }
        if (rejectedUnreadable > 0) {
            notices.push(`画像の読み込みに失敗したため添付できませんでした（${rejectedUnreadable}件）。`);
        }
        if (notices.length > 0) {
            const chat = getChat(getActiveChatId());
            if (chat) {
                appendMessage({ role: "system", text: notices.join("\n") }, chat.id);
            }
            else if (aiStatus instanceof HTMLElement) {
                aiStatus.textContent = notices.join(" ");
            }
        }
    };
    return {
        getPendingAttachments: () => pendingAttachments,
        renderAttachmentBar,
        clearPendingAttachments,
        addImageFiles,
    };
};
