import { updateMessageElement } from "./ai-chat-message.js";
import { aiText, localizeAgentStatus, localizeToolLabel } from "./ai-i18n.js";
export const createAiChatIncomingHandlers = (options) => {
    const { chats, chatIndex, proposalIndex, runningConversations, resumableConversations, streamingMessages, thinkingMessages, pendingAgentRequests, getActiveChatId, setActiveChatId, ensureChat, getChat, setChatTitle, clearPendingAttachments, renderHistoryList, renderChatContent, updateSendState, updateStatusDisplay, upsertThinkingMessage, clearThinkingMessage, finalizeStreamingMessage, ensureStreamingMessage, scrollToBottom, appendMessage, scheduleUsageRefresh, rebuildProposalCards, restoreDraftFromPending, updateContextBar, switchActiveChat, } = options;
    // バックグラウンドでDoneしたエージェントのトースト通知
    const showCompletionToast = (chatId, isError) => {
        const chat = getChat(chatId);
        if (!chat || chat.id === getActiveChatId())
            return;
        const existing = document.querySelector(".ai-bg-toast");
        if (existing)
            existing.remove();
        const toast = document.createElement("div");
        toast.className = `ai-bg-toast${isError ? " is-error" : ""}`;
        const label = document.createElement("span");
        label.textContent = `${chat.title || "Chat"}: ${aiText(isError ? "toast_issues" : "toast_done")}`;
        toast.appendChild(label);
        if (switchActiveChat) {
            const viewBtn = document.createElement("button");
            viewBtn.type = "button";
            viewBtn.className = "ai-bg-toast-action";
            viewBtn.textContent = aiText("toast_view");
            viewBtn.addEventListener("click", () => {
                switchActiveChat(chat.id);
                toast.remove();
            });
            toast.appendChild(viewBtn);
        }
        const chatContainer = document.getElementById("ai-chat");
        if (chatContainer) {
            chatContainer.prepend(toast);
            setTimeout(() => { if (toast.parentNode)
                toast.remove(); }, 6000);
        }
    };
    const handleState = (state) => {
        const sessions = Array.isArray(state === null || state === void 0 ? void 0 : state.sessions) ? state.sessions : [];
        sessions.sort((a, b) => {
            const aUpdated = typeof (a === null || a === void 0 ? void 0 : a.updatedAt) === "number" ? a.updatedAt : 0;
            const bUpdated = typeof (b === null || b === void 0 ? void 0 : b.updatedAt) === "number" ? b.updatedAt : 0;
            return aUpdated - bUpdated;
        });
        chats.splice(0, chats.length);
        chatIndex.clear();
        proposalIndex.clear();
        runningConversations.clear();
        resumableConversations.clear();
        streamingMessages.clear();
        thinkingMessages.clear();
        setActiveChatId(null);
        clearPendingAttachments();
        sessions.forEach((session) => {
            var _a, _b, _c;
            if (!session || typeof session !== "object") {
                return;
            }
            const conversationId = typeof session.conversationId === "string" && session.conversationId.trim()
                ? session.conversationId.trim()
                : "";
            if (!conversationId) {
                return;
            }
            const chat = ensureChat(conversationId);
            if (!chat) {
                return;
            }
            if (typeof session.title === "string" && session.title.trim()) {
                chat.title = session.title.trim();
            }
            const restoredMessages = Array.isArray(session.messages) ? session.messages : [];
            chat.messages = restoredMessages
                .filter((msg) => msg && typeof msg === "object")
                .map((msg) => ({
                role: msg.role === "assistant" ? "assistant" : "user",
                text: typeof msg.text === "string" ? msg.text : "",
            }))
                .filter((msg) => msg.text.trim().length > 0);
            chat.proposals.clear();
            chat.appliedProposalIds.clear();
            const restoredProposals = Array.isArray(session.proposals) ? session.proposals : [];
            restoredProposals.forEach((proposal) => {
                if (!proposal || typeof proposal !== "object") {
                    return;
                }
                if (typeof proposal.id !== "string" || !proposal.id) {
                    return;
                }
                chat.proposals.set(proposal.id, proposal);
                proposalIndex.set(proposal.id, chat.id);
                if (proposal.autoApplied === true) {
                    chat.appliedProposalIds.add(proposal.id);
                }
            });
            const statusState = (_a = session.status) === null || _a === void 0 ? void 0 : _a.state;
            const statusMessage = typeof ((_b = session.status) === null || _b === void 0 ? void 0 : _b.message) === "string" ? session.status.message : "";
            chat.hasUndo = ((_c = session.status) === null || _c === void 0 ? void 0 : _c.undoAvailable) === true;
            if (statusState === "running" || statusState === "stopping") {
                runningConversations.add(chat.id);
                chat.statusMessage = localizeAgentStatus(statusMessage ||
                    (statusState === "stopping" ? "Finishing partial changes..." : "Thinking..."));
                upsertThinkingMessage(chat.id, chat.statusMessage);
            }
            else if (statusState === "error" || statusState === "resumable") {
                resumableConversations.add(chat.id);
                chat.statusMessage = "";
            }
            else {
                chat.statusMessage = "";
            }
        });
        // Always start with a fresh "new chat" view (history remains accessible)
        renderHistoryList();
        updateSendState();
        updateStatusDisplay();
    };
    const handleStatus = (state, message, conversationId) => {
        var _a;
        if (!conversationId)
            return;
        const chat = ensureChat(conversationId);
        if (!chat)
            return;
        if (state === "running" || state === "stopping") {
            runningConversations.add(chat.id);
            resumableConversations.delete(chat.id);
            chat.statusMessage = localizeAgentStatus(message || (state === "stopping" ? "Finishing partial changes..." : "Thinking..."));
            upsertThinkingMessage(chat.id, chat.statusMessage);
        }
        else {
            runningConversations.delete(chat.id);
            chat.statusMessage = "";
            clearThinkingMessage(chat.id);
            if (state === "resumable") {
                // A new provider turn always requires the explicit Resume action.
                // This prevents compile/conflict failures (and processing limits) from
                // silently consuming more API quota in a retry loop.
                resumableConversations.add(chat.id);
            }
            else if (state === "error") {
                resumableConversations.add(chat.id);
            }
            else {
                resumableConversations.delete(chat.id);
            }
            const pending = (_a = pendingAgentRequests.get(chat.id)) !== null && _a !== void 0 ? _a : null;
            pendingAgentRequests.delete(chat.id);
            if ((state === "error" || state === "resumable") && pending) {
                restoreDraftFromPending(chat.id, pending);
            }
            showCompletionToast(chat.id, state === "error" || state === "resumable");
            scheduleUsageRefresh(true);
        }
        renderHistoryList();
        updateSendState();
        if (chat.id === getActiveChatId())
            updateStatusDisplay();
    };
    const handleMessage = (text, conversationId) => {
        if (!conversationId)
            return;
        clearThinkingMessage(conversationId);
        if (finalizeStreamingMessage(conversationId, text))
            scrollToBottom();
        else
            appendMessage({ role: "assistant", text }, conversationId);
        renderHistoryList();
        ensureChat(conversationId);
        updateStatusDisplay();
        scheduleUsageRefresh(true);
    };
    // Streaming deltas arrive far faster than the display refreshes, and each
    // render re-parses the whole message (markdown + KaTeX). Coalesce renders
    // to one per animation frame; the final agent:message repaints anyway.
    const pendingDeltaRenders = new Set();
    const handleMessageDelta = (text, conversationId) => {
        if (!conversationId || !text)
            return;
        const chatId = conversationId;
        clearThinkingMessage(chatId);
        const entry = ensureStreamingMessage(chatId);
        if (!entry)
            return;
        entry.message.text += text;
        if (pendingDeltaRenders.has(chatId))
            return;
        pendingDeltaRenders.add(chatId);
        requestAnimationFrame(() => {
            pendingDeltaRenders.delete(chatId);
            const current = streamingMessages.get(chatId);
            if (!current)
                return;
            updateMessageElement(current.element, current.message.text);
            scrollToBottom();
        });
    };
    const handleTool = (payload) => {
        if (!payload.conversationId)
            return;
        const chat = ensureChat(payload.conversationId);
        if (!chat || !runningConversations.has(chat.id))
            return;
        const fallback = typeof payload.label === "string" && payload.label.trim().length > 0
            ? payload.label.trim()
            : aiText("status_thinking");
        const label = localizeToolLabel(payload.name, fallback);
        // Append the tool target (file path, command, query…) so the activity
        // line says WHAT is being worked on, e.g. "Reading file — main.tex".
        const detail = typeof payload.detail === "string" && payload.detail.trim().length > 0
            ? payload.detail.trim()
            : "";
        chat.statusMessage = detail ? `${label} — ${detail}` : label;
        upsertThinkingMessage(chat.id, chat.statusMessage);
        if (chat.id === getActiveChatId())
            updateStatusDisplay();
    };
    const handleProposal = (proposal) => {
        if (!proposal.conversationId)
            return;
        const chat = ensureChat(proposal.conversationId);
        if (!chat)
            return;
        chat.proposals.set(proposal.id, proposal);
        proposalIndex.set(proposal.id, chat.id);
        if (proposal.autoApplied === true) {
            chat.appliedProposalIds.add(proposal.id);
        }
        renderHistoryList();
        if (chat.id === getActiveChatId()) {
            rebuildProposalCards(chat.id);
            scrollToBottom();
        }
    };
    const handleApplyResult = (payload) => {
        var _a;
        const chatId = (_a = proposalIndex.get(payload.proposalId)) !== null && _a !== void 0 ? _a : payload.conversationId;
        const chat = getChat(chatId);
        if (!chat)
            return;
        if (payload.ok) {
            chat.hasUndo = true;
            const proposal = chat.proposals.get(payload.proposalId);
            if (!proposal) {
                // Auto-apply with no proposal card — just update undo state
                renderHistoryList();
                updateSendState();
                return;
            }
            chat.appliedProposalIds.add(payload.proposalId);
            if (chat.id === getActiveChatId()) {
                rebuildProposalCards(chat.id);
            }
            // Clear the editor's Undo/Confirm bar so it stays in sync with
            // the chat-side proposal state. Without this, confirming in the
            // chat panel leaves a stale Undo/Confirm bar in the editor.
            const editorBar = document.getElementById("ai-undo-keep-bar");
            if (editorBar)
                editorBar.remove();
            renderHistoryList();
            updateSendState();
        }
        else {
            appendMessage({
                role: "system",
                text: payload.error || "The proposed change could not be applied.",
            }, chat.id);
            renderHistoryList();
            updateSendState();
        }
    };
    const handleUndoResult = (payload) => {
        var _a;
        const targetChatId = (_a = payload.conversationId) !== null && _a !== void 0 ? _a : getActiveChatId();
        if (payload.ok) {
            const chat = getChat(targetChatId);
            if (chat) {
                if (payload.path) {
                    for (const [pid, proposal] of chat.proposals) {
                        if (proposal.path === payload.path) {
                            chat.appliedProposalIds.delete(pid);
                        }
                    }
                }
                else {
                    chat.appliedProposalIds.clear();
                }
                if (chat.id === getActiveChatId()) {
                    rebuildProposalCards(chat.id);
                }
                renderHistoryList();
                updateSendState();
            }
        }
        else {
            const chat = getChat(targetChatId);
            if (chat) {
                appendMessage({
                    role: "system",
                    text: payload.message || "The change could not be undone.",
                }, chat.id);
                renderHistoryList();
                updateSendState();
            }
        }
        updateContextBar();
    };
    const handleUndoAvailability = (payload) => {
        const targetChat = ensureChat(payload.conversationId);
        if (!targetChat) {
            return;
        }
        targetChat.hasUndo = payload.available === true || (typeof payload.count === "number" && payload.count > 0);
        renderHistoryList();
        updateSendState();
        if (targetChat.id === getActiveChatId()) {
            updateStatusDisplay();
        }
    };
    const handleScratchpad = (payload) => {
        if (!payload.conversationId)
            return;
        const chat = ensureChat(payload.conversationId);
        if (!chat || !runningConversations.has(chat.id))
            return;
        chat.statusMessage = aiText("status_thinking");
        upsertThinkingMessage(chat.id, chat.statusMessage);
    };
    const handleThought = (payload) => {
        if (!payload.conversationId)
            return;
        const chat = ensureChat(payload.conversationId);
        if (!chat || !runningConversations.has(chat.id))
            return;
        chat.statusMessage = aiText("status_thinking");
        upsertThinkingMessage(chat.id, chat.statusMessage);
    };
    const handleError = (message, conversationId) => {
        if (!conversationId)
            return;
        const chat = ensureChat(conversationId);
        if (chat) {
            // agent:error is diagnostic and may arrive while a Codex/OpenPrism turn
            // continues. Only terminal agent:status owns the run lock and draft
            // restoration; unlocking here permits a second request to be dropped or
            // to race unfinished file settlement.
            chat.statusMessage = message;
            upsertThinkingMessage(chat.id, message);
        }
        renderHistoryList();
        updateSendState();
        updateStatusDisplay();
    };
    const handleRequestRejected = (payload) => {
        var _a, _b;
        if (!payload.conversationId)
            return;
        const chat = getChat(payload.conversationId);
        const pending = (_a = pendingAgentRequests.get(payload.conversationId)) !== null && _a !== void 0 ? _a : null;
        if (!chat || !pending)
            return;
        pendingAgentRequests.delete(payload.conversationId);
        // submitMessage adds this optimistic user row immediately before posting.
        // The host rejected that post, so remove exactly the newest user row and
        // restore its draft without unlocking the operation already in progress.
        for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
            if (((_b = chat.messages[index]) === null || _b === void 0 ? void 0 : _b.role) !== "user")
                continue;
            chat.messages.splice(index, 1);
            break;
        }
        restoreDraftFromPending(chat.id, pending);
        if (chat.id === getActiveChatId())
            renderChatContent();
        renderHistoryList();
        updateSendState();
        updateStatusDisplay();
    };
    return {
        handleState,
        handleStatus,
        handleMessage,
        handleMessageDelta,
        handleTool,
        handleProposal,
        handleApplyResult,
        handleUndoResult,
        handleUndoAvailability,
        handleScratchpad,
        handleThought,
        handleError,
        handleRequestRejected,
    };
};
