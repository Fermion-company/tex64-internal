import { updateMessageElement } from "./ai-chat-message.js";
export const createAiChatIncomingHandlers = (options) => {
    const { chats, chatIndex, proposalIndex, runningConversations, resumableConversations, streamingMessages, thinkingMessages, pendingAgentRequests, getActiveChatId, setActiveChatId, ensureChat, getChat, setChatTitle, clearPendingAttachments, renderHistoryList, renderChatContent, updateSendState, updateStatusDisplay, upsertThinkingMessage, clearThinkingMessage, finalizeStreamingMessage, ensureStreamingMessage, scrollToBottom, appendMessage, disableAutonomous, enableAutonomous, scheduleUsageRefresh, ensureProposalsEmbedded, buildProposalCard, getProposalsContainer, restoreDraftFromPending, updateContextBar, buildContextPayload, getAgentSettings, postToNative, dismissProposal, } = options;
    const AUTONOMOUS_RESUME_DELAY_MS = 600;
    const handleState = (state) => {
        const sessions = Array.isArray(state === null || state === void 0 ? void 0 : state.sessions) ? state.sessions : [];
        if (sessions.length === 0) {
            return;
        }
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
            });
            const statusState = (_a = session.status) === null || _a === void 0 ? void 0 : _a.state;
            const statusMessage = typeof ((_b = session.status) === null || _b === void 0 ? void 0 : _b.message) === "string" ? session.status.message : "";
            chat.hasUndo = ((_c = session.status) === null || _c === void 0 ? void 0 : _c.undoAvailable) === true;
            if (statusState === "running") {
                runningConversations.add(chat.id);
                chat.statusMessage = statusMessage || "思考中...";
                upsertThinkingMessage(chat.id, chat.statusMessage);
            }
            else if (statusState === "error") {
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
    const AUTONOMOUS_LOOP_LIMIT = 100;
    const tryAutonomousContinuation = (chat) => {
        if (!chat.autonomous || chat.autoLoopBudget <= 0)
            return false;
        chat.autoLoopBudget -= 1;
        const round = AUTONOMOUS_LOOP_LIMIT - chat.autoLoopBudget;
        chat.statusMessage = `自動継続中 (ラウンド ${round}/${AUTONOMOUS_LOOP_LIMIT})`;
        runningConversations.add(chat.id);
        resumableConversations.delete(chat.id);
        upsertThinkingMessage(chat.id, chat.statusMessage);
        renderHistoryList();
        updateSendState();
        updateStatusDisplay();
        const contextToSend = buildContextPayload(getAgentSettings());
        window.setTimeout(() => {
            const posted = postToNative({ type: "agent:resume", conversationId: chat.id, context: contextToSend }, true);
            if (!posted) {
                runningConversations.delete(chat.id);
                resumableConversations.add(chat.id);
                chat.statusMessage = "";
                clearThinkingMessage(chat.id);
                renderHistoryList();
                updateSendState();
                updateStatusDisplay();
            }
        }, AUTONOMOUS_RESUME_DELAY_MS);
        return true;
    };
    const handleStatus = (state, message, conversationId) => {
        const chat = ensureChat(conversationId);
        if (!chat)
            return;
        if (state === "running") {
            runningConversations.add(chat.id);
            resumableConversations.delete(chat.id);
            chat.statusMessage = message || "思考中...";
            upsertThinkingMessage(chat.id, chat.statusMessage);
        }
        else {
            runningConversations.delete(chat.id);
            chat.statusMessage = "";
            clearThinkingMessage(chat.id);
            if (state === "resumable") {
                // max_iterations reached — try autonomous continuation
                if (tryAutonomousContinuation(chat)) {
                    // auto-continuation started, skip marking as idle
                    return;
                }
                // fallback: mark as resumable for manual resume button
                resumableConversations.add(chat.id);
            }
            else if (state === "error") {
                resumableConversations.add(chat.id);
            }
            else {
                resumableConversations.delete(chat.id);
            }
            scheduleUsageRefresh(true);
        }
        renderHistoryList();
        updateSendState();
        if (chat.id === getActiveChatId())
            updateStatusDisplay();
    };
    const handleMessage = (text, conversationId) => {
        clearThinkingMessage(conversationId);
        if (conversationId) {
            pendingAgentRequests.delete(conversationId);
        }
        if (conversationId && finalizeStreamingMessage(conversationId, text))
            scrollToBottom();
        else
            appendMessage({ role: "assistant", text }, conversationId);
        if (conversationId) {
            runningConversations.delete(conversationId);
            updateSendState();
            renderHistoryList();
        }
        const chat = ensureChat(conversationId);
        if (chat)
            chat.statusMessage = "";
        updateStatusDisplay();
        scheduleUsageRefresh(true);
    };
    const handleMessageDelta = (text, conversationId) => {
        const chatId = conversationId !== null && conversationId !== void 0 ? conversationId : getActiveChatId();
        if (!chatId || !text)
            return;
        clearThinkingMessage(chatId);
        const entry = ensureStreamingMessage(chatId);
        if (!entry)
            return;
        entry.message.text += text;
        updateMessageElement(entry.element, entry.message.text);
        scrollToBottom();
    };
    const handleTool = (payload) => {
        const chat = ensureChat(payload.conversationId);
        if (!chat || !runningConversations.has(chat.id))
            return;
        const label = typeof payload.label === "string" && payload.label.trim().length > 0
            ? payload.label.trim()
            : payload.name;
        const summary = typeof payload.summary === "string" && payload.summary.trim().length > 0 && payload.summary !== "ok"
            ? payload.summary.trim()
            : "";
        chat.statusMessage = summary ? `${label} (${summary})` : label;
        upsertThinkingMessage(chat.id, chat.statusMessage);
        if (chat.id === getActiveChatId())
            updateStatusDisplay();
    };
    const handleProposal = (proposal) => {
        const chat = ensureChat(proposal.conversationId);
        if (!chat)
            return;
        chat.proposals.set(proposal.id, proposal);
        proposalIndex.set(proposal.id, chat.id);
        renderHistoryList();
        if (chat.id === getActiveChatId()) {
            const proposals = ensureProposalsEmbedded();
            if (proposals) {
                proposals.classList.remove("is-hidden");
                proposals.appendChild(buildProposalCard(proposal));
            }
            scrollToBottom();
        }
    };
    const handleApplyResult = (payload) => {
        var _a;
        const chatId = proposalIndex.get(payload.proposalId);
        const chat = getChat(chatId);
        if (!chat)
            return;
        const proposal = chat.proposals.get(payload.proposalId);
        if (!proposal)
            return;
        if (payload.ok) {
            chat.hasUndo = true;
            if (chat.id === getActiveChatId()) {
                const pc = getProposalsContainer();
                const cardEl = pc === null || pc === void 0 ? void 0 : pc.querySelector(`[data-proposal-id="${payload.proposalId}"]`);
                if (cardEl instanceof HTMLElement) {
                    cardEl.classList.add("is-applied");
                    const actionsEl = cardEl.querySelector(".ai-proposal-actions");
                    if (actionsEl) {
                        actionsEl.replaceChildren();
                        const undoBtn = document.createElement("button");
                        undoBtn.type = "button";
                        undoBtn.className = "panel-button ghost";
                        undoBtn.textContent = "取り消し";
                        undoBtn.addEventListener("click", (e) => {
                            e.stopPropagation();
                            postToNative({ type: "agent:undoLastApply", conversationId: chat.id });
                        });
                        actionsEl.appendChild(undoBtn);
                    }
                    const badgeEl = cardEl.querySelector(".ai-proposal-badge");
                    if (badgeEl instanceof HTMLElement) {
                        badgeEl.textContent = "適用済み";
                        badgeEl.style.background = "rgba(99, 102, 241, 0.1)";
                        badgeEl.style.color = "#818cf8";
                        badgeEl.style.borderColor = "rgba(99, 102, 241, 0.2)";
                    }
                }
            }
            renderHistoryList();
            updateSendState();
        }
        else {
            const label = payload.conflict ? "適用競合" : "適用失敗";
            appendMessage({ role: "system", text: `${label}: ${(_a = payload.error) !== null && _a !== void 0 ? _a : "不明なエラー"}` }, chat.id);
        }
    };
    const handleUndoResult = (payload) => {
        var _a, _b, _c, _d;
        const targetChatId = (_b = (_a = payload.conversationId) !== null && _a !== void 0 ? _a : getActiveChatId()) !== null && _b !== void 0 ? _b : undefined;
        if (payload.ok) {
            const chat = getChat(targetChatId);
            if (chat && chat.id === getActiveChatId()) {
                const pc = getProposalsContainer();
                if (pc) {
                    const cards = Array.from(pc.querySelectorAll(".ai-proposal.is-applied"));
                    for (let ci = 0; ci < cards.length; ci++) {
                        const cardEl = cards[ci];
                        if (!(cardEl instanceof HTMLElement))
                            continue;
                        const pid = (_c = cardEl.dataset.proposalId) !== null && _c !== void 0 ? _c : "";
                        const proposal = chat.proposals.get(pid);
                        if (!proposal)
                            continue;
                        if (payload.path && proposal.path !== payload.path)
                            continue;
                        cardEl.classList.remove("is-applied");
                        const badgeEl = cardEl.querySelector(".ai-proposal-badge");
                        if (badgeEl instanceof HTMLElement) {
                            const rawType = proposal.type || "write";
                            const pType = rawType === "write" && proposal.isNewFile ? "new" : rawType;
                            badgeEl.textContent = pType === "delete" ? "削除" : pType === "rename" ? "移動" : pType === "mkdir" ? "フォルダ" : pType === "new" ? "新規" : "編集";
                            badgeEl.style.background = "";
                            badgeEl.style.color = "";
                            badgeEl.style.borderColor = "";
                        }
                        const actionsEl = cardEl.querySelector(".ai-proposal-actions");
                        if (actionsEl) {
                            actionsEl.replaceChildren();
                            const previewBtn = document.createElement("button");
                            previewBtn.type = "button";
                            previewBtn.className = "panel-button ghost";
                            previewBtn.textContent = "差分を見る";
                            const cancelBtn = document.createElement("button");
                            cancelBtn.type = "button";
                            cancelBtn.className = "panel-button ghost";
                            cancelBtn.textContent = "取り消し";
                            cancelBtn.addEventListener("click", (e) => {
                                e.stopPropagation();
                                postToNative({ type: "agent:proposal:dismiss", proposalId: pid }, true);
                                dismissProposal(pid);
                            });
                            const applyBtn = document.createElement("button");
                            applyBtn.type = "button";
                            applyBtn.className = "panel-button";
                            applyBtn.textContent = "適用";
                            applyBtn.addEventListener("click", (e) => {
                                e.stopPropagation();
                                postToNative({ type: "agent:apply", proposalId: pid });
                            });
                            actionsEl.append(previewBtn, applyBtn);
                        }
                        break;
                    }
                }
            }
        }
        else {
            appendMessage({ role: "system", text: `取り消し失敗: ${(_d = payload.message) !== null && _d !== void 0 ? _d : "取り消せる操作がありません。"}` }, targetChatId);
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
    const handleError = (message, conversationId) => {
        var _a;
        appendMessage({ role: "system", text: message }, conversationId);
        const chat = ensureChat(conversationId);
        if (chat) {
            chat.statusMessage = "";
            disableAutonomous(chat.id);
            resumableConversations.add(chat.id);
            clearThinkingMessage(chat.id);
        }
        if (conversationId)
            streamingMessages.delete(conversationId);
        if (conversationId) {
            const pending = (_a = pendingAgentRequests.get(conversationId)) !== null && _a !== void 0 ? _a : null;
            pendingAgentRequests.delete(conversationId);
            restoreDraftFromPending(conversationId, pending);
        }
        if (conversationId) {
            runningConversations.delete(conversationId);
            renderHistoryList();
            updateSendState();
        }
        updateStatusDisplay();
        scheduleUsageRefresh(true);
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
        handleError,
    };
};
