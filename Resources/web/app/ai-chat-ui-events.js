export const initAiChatEventBindings = (params) => {
    const { aiInput, aiSend, aiAttach, aiAttachInput, aiStatus, aiUndo, aiStop, aiChatNew, postToNative, getActiveChatId, setActiveChatId, getPendingAttachments, getChat, createChat, setChatTitle, renderHistoryList, appendMessage, autoGrow, updateContextBar, requestAgentRun, buildContextPayload, getAgentSettings, clearPendingAttachments, clearMentionPaths, addImageFiles, isAiBlocked, needsLogin, requestAiAccessCheck, requestPlatformUsage, updateStatusDisplay, showLoginOverlay, resolvePricingUrl, openExternalUrl, runningConversations, resumableConversations, pendingAgentRequests, clearThinkingMessage, upsertThinkingMessage, updateSendState, disableAutonomous, resetToNewChatState, } = params;
    let sendGuard = false;
    const handleSend = () => {
        if (sendGuard)
            return;
        if (!(aiInput instanceof HTMLTextAreaElement))
            return;
        const text = aiInput.value.trim();
        const pendingAttachments = getPendingAttachments();
        const hasAttachments = pendingAttachments.length > 0;
        if (!text && !hasAttachments)
            return;
        if (isAiBlocked() || needsLogin()) {
            if (needsLogin()) {
                showLoginOverlay();
            }
            else {
                requestAiAccessCheck(true);
                requestPlatformUsage(true);
                updateStatusDisplay();
            }
            return;
        }
        // アクティブChatがRunningなら、New chatをCreateしてSend先にする（並列execution対応）
        const currentActive = getChat(getActiveChatId());
        if (currentActive && runningConversations.has(currentActive.id)) {
            const c = createChat();
            setActiveChatId(c.id);
        }
        if (!getActiveChatId()) {
            const c = createChat();
            setActiveChatId(c.id);
        }
        const chat = getChat(getActiveChatId());
        if (!chat)
            return;
        if (chat.title.startsWith("Chat ") && text) {
            chat.title = text.slice(0, 24).replace(/\s+/g, " ") || chat.title;
        }
        setChatTitle(chat);
        // Clear previous turn's proposals — they're already applied to the editor
        chat.proposals.clear();
        chat.appliedProposalIds.clear();
        const proposalsEl = document.getElementById("ai-proposals");
        if (proposalsEl) {
            proposalsEl.replaceChildren();
            proposalsEl.classList.add("is-hidden");
        }
        renderHistoryList();
        const userLabel = text || "The image has been sent.";
        const attachmentNote = hasAttachments ? `\n[attached images ${pendingAttachments.length}]` : "";
        appendMessage({ role: "user", text: `${userLabel}${attachmentNote}` }, chat.id);
        aiInput.value = "";
        autoGrow();
        updateContextBar();
        const requestParts = [];
        if (text) {
            requestParts.push({ text });
        }
        pendingAttachments.forEach((attachment) => {
            requestParts.push({
                inlineData: {
                    mimeType: attachment.mimeType,
                    data: attachment.data,
                },
            });
        });
        const requestMessage = text || "Please analyze the attached image.";
        const contextPayload = buildContextPayload(getAgentSettings());
        sendGuard = true;
        const sent = requestAgentRun(chat.id, requestMessage, requestParts, contextPayload);
        if (sent) {
            clearPendingAttachments();
            clearMentionPaths === null || clearMentionPaths === void 0 ? void 0 : clearMentionPaths();
        }
        sendGuard = false;
    };
    if (aiSend instanceof HTMLButtonElement)
        aiSend.addEventListener("click", handleSend);
    if (aiInput instanceof HTMLTextAreaElement) {
        aiInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                handleSend();
            }
        });
        aiInput.addEventListener("paste", (event) => {
            var _a, _b;
            const files = (_b = (_a = event.clipboardData) === null || _a === void 0 ? void 0 : _a.files) !== null && _b !== void 0 ? _b : null;
            if (!files || files.length === 0)
                return;
            const hasImage = Array.from(files).some((file) => file.type.startsWith("image/"));
            if (!hasImage)
                return;
            event.preventDefault();
            void addImageFiles(files);
        });
    }
    if (aiAttach instanceof HTMLButtonElement && aiAttachInput instanceof HTMLInputElement) {
        aiAttach.addEventListener("click", () => {
            if (!aiAttach.disabled)
                aiAttachInput.click();
        });
        aiAttachInput.addEventListener("change", () => {
            void addImageFiles(aiAttachInput.files);
        });
    }
    if (aiStatus instanceof HTMLElement) {
        aiStatus.addEventListener("click", (event) => {
            const target = event.target;
            const button = target === null || target === void 0 ? void 0 : target.closest("[data-ai-status-action]");
            if (!button) {
                return;
            }
            const action = button.dataset.aiStatusAction;
            if (action === "login") {
                postToNative({ type: "auth:google:start" });
                return;
            }
            if (action === "pricing") {
                openExternalUrl(resolvePricingUrl());
            }
        });
    }
    const attachDropHost = aiAttach instanceof HTMLElement ? aiAttach.closest(".ai-chat-input") : null;
    if (attachDropHost instanceof HTMLElement) {
        attachDropHost.addEventListener("dragover", (event) => {
            var _a;
            if (!((_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.types.includes("Files")))
                return;
            event.preventDefault();
        });
        attachDropHost.addEventListener("drop", (event) => {
            var _a, _b;
            const files = (_b = (_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.files) !== null && _b !== void 0 ? _b : null;
            if (!files || files.length === 0)
                return;
            const hasImage = Array.from(files).some((file) => file.type.startsWith("image/"));
            if (!hasImage)
                return;
            event.preventDefault();
            void addImageFiles(files);
        });
    }
    if (aiUndo instanceof HTMLButtonElement) {
        aiUndo.addEventListener("click", () => {
            const chat = getChat(getActiveChatId());
            if (!chat)
                return;
            postToNative({ type: "agent:undoLastRunApply", conversationId: chat.id });
        });
    }
    if (aiStop instanceof HTMLButtonElement) {
        aiStop.addEventListener("click", () => {
            const chat = getChat(getActiveChatId());
            if (!chat)
                return;
            if (runningConversations.has(chat.id)) {
                disableAutonomous(chat.id);
                postToNative({ type: "agent:abort", conversationId: chat.id }, true);
                resumableConversations.delete(chat.id);
                pendingAgentRequests.delete(chat.id);
                chat.statusMessage = "";
                runningConversations.delete(chat.id);
                clearThinkingMessage(chat.id);
                renderHistoryList();
                updateSendState();
                updateStatusDisplay();
                return;
            }
            if (!resumableConversations.has(chat.id)) {
                return;
            }
            if (isAiBlocked() || needsLogin()) {
                requestAiAccessCheck(true);
                requestPlatformUsage(true);
                updateStatusDisplay();
                return;
            }
            const contextToSend = buildContextPayload(getAgentSettings());
            chat.statusMessage = "Thinking...";
            runningConversations.add(chat.id);
            resumableConversations.delete(chat.id);
            upsertThinkingMessage(chat.id, chat.statusMessage);
            renderHistoryList();
            updateSendState();
            updateStatusDisplay();
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
        });
    }
    if (aiChatNew instanceof HTMLButtonElement) {
        aiChatNew.addEventListener("click", () => {
            resetToNewChatState();
            if (aiInput instanceof HTMLTextAreaElement)
                aiInput.focus();
        });
    }
    if (aiInput instanceof HTMLTextAreaElement && !aiInput.placeholder.trim()) {
        aiInput.placeholder = "Please tell me what to write...";
    }
};
