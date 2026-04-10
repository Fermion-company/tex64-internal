export const restorePendingAiDraft = (options) => {
    var _a;
    const { chatId, request, activeChatId, aiInput, autoGrow, appendMessage, setPendingAttachments } = options;
    if (!request || chatId !== activeChatId) {
        return;
    }
    if (!(aiInput instanceof HTMLTextAreaElement)) {
        return;
    }
    if (((_a = aiInput.value) !== null && _a !== void 0 ? _a : "").trim().length > 0) {
        return;
    }
    const restored = typeof request.message === "string" ? request.message : "";
    // Restore image attachments from request parts
    const restoredImages = [];
    if (Array.isArray(request.parts)) {
        for (const part of request.parts) {
            if (part && typeof part === "object" && "inlineData" in part && part.inlineData) {
                const { mimeType, data } = part.inlineData;
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
    appendMessage({
        role: "system",
        text: restoredImages.length > 0
            ? `Restored unsent input (including ${restoredImages.length} attached images). Please review and resend.`
            : "Restored input that could not be sent. Please check the contents and resend.",
    }, chatId);
};
