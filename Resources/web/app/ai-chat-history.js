import { aiText } from "./ai-i18n.js";
import { formatRelativeTime } from "./ai-chat-message.js";
export const createHistoryController = (params) => {
    const { aiHistory, aiHistoryList, aiHistoryToggle, chats, chatIndex, proposalIndex, runningConversations, getActiveChatId, switchActiveChat, resetToNewChatState, postToNative, } = params;
    let historyOpen = false;
    const setHistoryOpen = (open) => {
        historyOpen = open;
        if (aiHistory instanceof HTMLElement) {
            aiHistory.inert = !open;
            aiHistory.classList.toggle("is-open", open);
        }
        aiHistoryToggle === null || aiHistoryToggle === void 0 ? void 0 : aiHistoryToggle.setAttribute("aria-expanded", String(open));
    };
    setHistoryOpen(false);
    // ── Delete Modal ─────────────────────────────────────
    const chatDeleteModal = document.getElementById("ai-chat-delete-modal");
    const chatDeleteTarget = document.getElementById("ai-chat-delete-target");
    const chatDeleteCancel = document.getElementById("ai-chat-delete-cancel");
    const chatDeleteConfirm = document.getElementById("ai-chat-delete-confirm");
    let pendingDeleteChatId = null;
    let deleteOpener = null;
    const openChatDeleteModal = (chatId, title) => {
        if (runningConversations.has(chatId))
            return;
        pendingDeleteChatId = chatId;
        deleteOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (chatDeleteTarget)
            chatDeleteTarget.textContent = title;
        if (chatDeleteModal)
            chatDeleteModal.classList.add("is-visible");
        chatDeleteCancel === null || chatDeleteCancel === void 0 ? void 0 : chatDeleteCancel.focus();
    };
    const closeChatDeleteModal = () => {
        pendingDeleteChatId = null;
        if (chatDeleteModal)
            chatDeleteModal.classList.remove("is-visible");
        deleteOpener === null || deleteOpener === void 0 ? void 0 : deleteOpener.focus();
        deleteOpener = null;
    };
    const confirmDeleteChat = () => {
        const chatId = pendingDeleteChatId;
        closeChatDeleteModal();
        if (!chatId)
            return;
        if (runningConversations.has(chatId))
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
        params.forgetDraft(chatId);
        renderHistoryList();
    };
    if (chatDeleteCancel)
        chatDeleteCancel.addEventListener("click", closeChatDeleteModal);
    if (chatDeleteConfirm)
        chatDeleteConfirm.addEventListener("click", confirmDeleteChat);
    if (chatDeleteModal) {
        chatDeleteModal.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                closeChatDeleteModal();
            }
            if (event.key === "Tab" && chatDeleteConfirm && chatDeleteCancel) {
                event.preventDefault();
                (document.activeElement === chatDeleteCancel ? chatDeleteConfirm : chatDeleteCancel).focus();
            }
        });
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
            empty.textContent = "No history";
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
            const label = document.createElement("button");
            label.className = "ai-history-item";
            label.type = "button";
            const title = document.createElement("span");
            title.className = "ai-history-title";
            title.textContent = chat.title;
            label.appendChild(title);
            const meta = document.createElement("span");
            meta.className = "ai-history-meta";
            const when = chat.updatedAt ? formatRelativeTime(chat.updatedAt) : "";
            const parts = [when];
            if (chat.branchedFrom)
                parts.push(aiText("branched"));
            meta.textContent = parts.filter(Boolean).join(" · ");
            if (meta.textContent)
                label.appendChild(meta);
            label.addEventListener("click", () => {
                switchActiveChat(chat.id);
                closeHistory();
            });
            const delBtn = document.createElement("button");
            delBtn.className = "ai-history-delete";
            delBtn.type = "button";
            delBtn.disabled = runningConversations.has(chat.id);
            delBtn.setAttribute("aria-label", `Delete ${chat.title}`);
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
        setHistoryOpen(!historyOpen);
        if (historyOpen)
            renderHistoryList();
    };
    const closeHistory = () => {
        if ((aiHistory === null || aiHistory === void 0 ? void 0 : aiHistory.contains(document.activeElement)) && aiHistoryToggle instanceof HTMLElement)
            aiHistoryToggle.focus();
        setHistoryOpen(false);
    };
    aiHistory === null || aiHistory === void 0 ? void 0 : aiHistory.addEventListener("keydown", (event) => {
        if (event instanceof KeyboardEvent && event.key === "Escape")
            closeHistory();
    });
    if (aiHistoryToggle instanceof HTMLButtonElement) {
        if (aiHistory === null || aiHistory === void 0 ? void 0 : aiHistory.id)
            aiHistoryToggle.setAttribute("aria-controls", aiHistory.id);
        aiHistoryToggle.addEventListener("click", toggleHistory);
    }
    return {
        renderHistoryList,
        closeHistory,
    };
};
