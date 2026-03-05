export const createHistoryController = (params) => {
    const { aiHistory, aiHistoryList, aiHistoryToggle, chats, chatIndex, proposalIndex, runningConversations, getActiveChatId, switchActiveChat, resetToNewChatState, postToNative, } = params;
    let historyOpen = false;
    // ── Delete Modal ─────────────────────────────────────
    const chatDeleteModal = document.getElementById("ai-chat-delete-modal");
    const chatDeleteTarget = document.getElementById("ai-chat-delete-target");
    const chatDeleteCancel = document.getElementById("ai-chat-delete-cancel");
    const chatDeleteConfirm = document.getElementById("ai-chat-delete-confirm");
    let pendingDeleteChatId = null;
    const openChatDeleteModal = (chatId, title) => {
        pendingDeleteChatId = chatId;
        if (chatDeleteTarget)
            chatDeleteTarget.textContent = title;
        if (chatDeleteModal)
            chatDeleteModal.classList.add("is-visible");
    };
    const closeChatDeleteModal = () => {
        pendingDeleteChatId = null;
        if (chatDeleteModal)
            chatDeleteModal.classList.remove("is-visible");
    };
    const confirmDeleteChat = () => {
        const chatId = pendingDeleteChatId;
        closeChatDeleteModal();
        if (!chatId)
            return;
        const chat = chatIndex.get(chatId);
        if (!chat)
            return;
        // Remove from data
        chat.proposals.forEach((_p, pid) => proposalIndex.delete(pid));
        chat.proposals.clear();
        chatIndex.delete(chatId);
        runningConversations.delete(chatId);
        const idx = chats.findIndex((c) => c.id === chatId);
        if (idx >= 0)
            chats.splice(idx, 1);
        // Notify native to clear persisted data
        postToNative({ type: "agent:clear", conversationId: chatId }, true);
        // If we deleted the active chat, reset to new chat view
        if (getActiveChatId() === chatId) {
            resetToNewChatState();
        }
        renderHistoryList();
    };
    if (chatDeleteCancel)
        chatDeleteCancel.addEventListener("click", closeChatDeleteModal);
    if (chatDeleteConfirm)
        chatDeleteConfirm.addEventListener("click", confirmDeleteChat);
    if (chatDeleteModal) {
        chatDeleteModal.addEventListener("click", (e) => {
            if (e.target === chatDeleteModal)
                closeChatDeleteModal();
        });
    }
    // ── History List ──────────────────────────────────────
    const renderHistoryList = () => {
        if (!(aiHistoryList instanceof HTMLElement))
            return;
        aiHistoryList.replaceChildren();
        if (chats.length === 0) {
            const empty = document.createElement("div");
            empty.className = "ai-history-empty";
            empty.textContent = "履歴なし";
            aiHistoryList.appendChild(empty);
            return;
        }
        for (let i = chats.length - 1; i >= 0; i--) {
            const chat = chats[i];
            const item = document.createElement("div");
            item.className = "ai-history-item-wrap";
            if (chat.id === getActiveChatId())
                item.classList.add("is-active");
            if (runningConversations.has(chat.id))
                item.classList.add("is-running");
            const suffixParts = [];
            if (runningConversations.has(chat.id))
                suffixParts.push("実行中");
            if (chat.proposals.size > 0)
                suffixParts.push(`提案 ${chat.proposals.size}`);
            const suffix = suffixParts.length > 0 ? ` (${suffixParts.join(" / ")})` : "";
            const label = document.createElement("button");
            label.className = "ai-history-item";
            label.type = "button";
            label.textContent = `${chat.title}${suffix}`;
            label.addEventListener("click", () => {
                switchActiveChat(chat.id);
                closeHistory();
            });
            const delBtn = document.createElement("button");
            delBtn.className = "ai-history-delete";
            delBtn.type = "button";
            delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
            delBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                openChatDeleteModal(chat.id, chat.title);
            });
            item.append(label, delBtn);
            aiHistoryList.appendChild(item);
        }
    };
    const toggleHistory = () => {
        historyOpen = !historyOpen;
        if (aiHistory instanceof HTMLElement)
            aiHistory.classList.toggle("is-open", historyOpen);
        if (historyOpen)
            renderHistoryList();
    };
    const closeHistory = () => {
        historyOpen = false;
        if (aiHistory instanceof HTMLElement)
            aiHistory.classList.remove("is-open");
    };
    if (aiHistoryToggle instanceof HTMLButtonElement) {
        aiHistoryToggle.addEventListener("click", toggleHistory);
    }
    return {
        renderHistoryList,
        closeHistory,
    };
};
