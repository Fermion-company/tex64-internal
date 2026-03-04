export const restorePendingAiDraft = (options) => {
    var _a;
    const { chatId, request, activeChatId, aiInput, autoGrow, appendMessage } = options;
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
    if (!restored.trim()) {
        return;
    }
    aiInput.value = restored;
    autoGrow();
    aiInput.focus();
    appendMessage({
        role: "system",
        text: "送信できなかった入力を復元しました。内容を確認して再送信してください。",
    }, chatId);
};
