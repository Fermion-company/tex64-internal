export const initAiChatUi = (context, deps) => {
    const { aiChatLog, aiChat, aiProposals, aiInput, aiSend, aiStatus, aiClear, aiChatList, aiChatNew, } = context.dom;
    const chats = [];
    const chatIndex = new Map();
    const proposalIndex = new Map();
    let activeChatId = null;
    let pendingProposalId = null;
    let runningConversationId = null;
    const makeChatId = () => `chat-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    // --- Two-Stage View State ---
    let viewMode = "list";
    // Create Back Button Container (Toolbar)
    const aiChatToolbar = document.createElement("div");
    aiChatToolbar.style.padding = "8px 0 0";
    aiChatToolbar.style.display = "none"; // Initially hidden
    aiChatToolbar.style.alignItems = "center"; // Vertical alignment
    aiChatToolbar.style.gap = "0"; // Gap handling via margin
    const aiBack = document.createElement("button");
    aiBack.className = "panel-button ghost";
    aiBack.style.padding = "4px 8px";
    aiBack.style.fontSize = "9px";
    aiBack.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px;"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> 戻る`;
    aiChatToolbar.appendChild(aiBack);
    // Chat Title in Toolbar
    const aiChatTitle = document.createElement("span");
    aiChatTitle.style.marginLeft = "8px";
    aiChatTitle.style.fontSize = "10px";
    aiChatTitle.style.fontWeight = "600";
    aiChatTitle.style.color = "var(--text)";
    aiChatTitle.style.overflow = "hidden";
    aiChatTitle.style.textOverflow = "ellipsis";
    aiChatTitle.style.whiteSpace = "nowrap";
    aiChatTitle.style.display = "flex";
    aiChatTitle.style.alignItems = "center";
    aiChatTitle.style.height = "24px"; // Match button height
    aiChatToolbar.appendChild(aiChatTitle);
    // Insert Toolbar at the top of aiChat
    if (aiChat) {
        aiChat.prepend(aiChatToolbar);
    }
    const setViewMode = (mode) => {
        viewMode = mode;
        const { aiPanel } = context.dom;
        if (aiPanel) {
            aiPanel.classList.toggle("is-view-list", mode === "list");
            aiPanel.classList.toggle("is-view-chat", mode === "chat");
        }
        // Toggle Toolbar visibility
        aiChatToolbar.style.display = mode === "chat" ? "flex" : "none";
        // Clear button is removed from header, no need to toggle
    };
    aiBack.addEventListener("click", () => {
        setViewMode("list");
    });
    const getChat = (chatId) => {
        var _a, _b;
        if (chatId && chatIndex.has(chatId)) {
            return (_a = chatIndex.get(chatId)) !== null && _a !== void 0 ? _a : null;
        }
        return activeChatId ? (_b = chatIndex.get(activeChatId)) !== null && _b !== void 0 ? _b : null : null;
    };
    const ensureChat = (chatId) => {
        if (chatId && !chatIndex.has(chatId)) {
            const chat = {
                id: chatId,
                title: `Chat ${chats.length + 1}`,
                messages: [],
                proposals: new Map(),
                statusMessage: "待機中",
            };
            chats.push(chat);
            chatIndex.set(chatId, chat);
            renderChatList();
        }
        return getChat(chatId);
    };
    const createChat = () => {
        const id = makeChatId();
        const title = `Chat ${chats.length + 1}`;
        const chat = {
            id,
            title,
            messages: [],
            proposals: new Map(),
            statusMessage: "待機中",
        };
        chats.push(chat);
        chatIndex.set(id, chat);
        return chat;
    };
    const updateSendState = () => {
        const isRunning = Boolean(runningConversationId);
        if (aiSend instanceof HTMLButtonElement) {
            aiSend.disabled = isRunning;
            aiSend.classList.toggle("is-loading", isRunning);
        }
        if (aiInput instanceof HTMLTextAreaElement) {
            aiInput.disabled = isRunning;
        }
    };
    const updateStatusDisplay = () => {
        if (!(aiStatus instanceof HTMLElement)) {
            return;
        }
        const activeChat = getChat(activeChatId);
        if (!activeChat) {
            aiStatus.textContent = "待機中";
            return;
        }
        if (runningConversationId && runningConversationId !== activeChat.id) {
            aiStatus.textContent = "他のチャットが応答中です...";
            return;
        }
        // Only show status when actively running, otherwise hide
        if (runningConversationId === activeChat.id) {
            aiStatus.textContent = activeChat.statusMessage || "";
        }
        else {
            aiStatus.textContent = "";
        }
    };
    function setActiveChat(chatId) {
        if (!chatIndex.has(chatId)) {
            return;
        }
        activeChatId = chatId;
        pendingProposalId = null;
        // Update title in toolbar
        const chat = getChat(chatId);
        if (chat) {
            aiChatTitle.textContent = chat.title;
        }
        renderChatList();
        renderChatContent();
        updateStatusDisplay();
        setViewMode("chat");
    }
    const createMessageElement = (message) => {
        const wrapper = document.createElement("div");
        wrapper.className = "ai-message";
        if (message.role === "user") {
            wrapper.classList.add("is-user");
        }
        else if (message.role === "assistant") {
            wrapper.classList.add("is-assistant");
        }
        else if (message.role === "system") {
            wrapper.classList.add("is-system");
        }
        const content = document.createElement("div");
        content.className = "ai-message-content";
        content.textContent = message.text;
        if (message.role === "assistant") {
            const avatar = document.createElement("div");
            avatar.className = "ai-message-avatar";
            avatar.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7V5.73A2 2 0 0 1 10 4a2 2 0 0 1 2-2z" fill="currentColor"/></svg>`;
            const body = document.createElement("div");
            body.className = "ai-message-body";
            const name = document.createElement("div");
            name.className = "ai-message-name";
            name.textContent = "AI Assistant";
            body.appendChild(name);
            body.appendChild(content); // Move content inside body
            wrapper.appendChild(avatar);
            wrapper.appendChild(body);
        }
        else {
            wrapper.appendChild(content);
        }
        return wrapper;
    };
    const appendMessage = (message, chatId) => {
        const chat = ensureChat(chatId);
        if (!chat) {
            return;
        }
        chat.messages.push(message);
        if (chat.id !== activeChatId) {
            return;
        }
        if (!(aiChatLog instanceof HTMLElement)) {
            return;
        }
        aiChatLog.appendChild(createMessageElement(message));
        if (aiChat instanceof HTMLElement) {
            aiChat.scrollTop = aiChat.scrollHeight;
        }
    };
    const createProposalCard = (proposal) => {
        const card = document.createElement("div");
        card.className = "ai-proposal";
        card.dataset.proposalId = proposal.id;
        const header = document.createElement("div");
        header.className = "ai-proposal-header";
        const icon = document.createElement("div");
        icon.className = "ai-proposal-icon";
        icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`;
        const path = document.createElement("div");
        path.className = "ai-proposal-path";
        path.textContent = proposal.path;
        header.append(icon, path);
        // Add badge based on proposal type
        const proposalType = proposal.type || (proposal.isNewFile ? "new" : "write");
        const badge = document.createElement("span");
        badge.className = "ai-proposal-badge";
        switch (proposalType) {
            case "delete":
                badge.textContent = "削除";
                badge.style.background = "var(--danger, #dc3545)";
                break;
            case "rename":
                badge.textContent = "移動";
                badge.style.background = "var(--warning, #ffc107)";
                badge.style.color = "#000";
                break;
            case "mkdir":
                badge.textContent = "フォルダ";
                badge.style.background = "var(--info, #17a2b8)";
                break;
            case "patch":
                badge.textContent = "部分編集";
                badge.style.background = "var(--secondary, #6c757d)";
                break;
            case "new":
                badge.textContent = "新規";
                break;
            default:
                badge.textContent = "編集";
                break;
        }
        header.appendChild(badge);
        const summary = document.createElement("div");
        summary.className = "ai-proposal-summary";
        summary.textContent = proposal.summary || "ファイルの変更案";
        const actions = document.createElement("div");
        actions.className = "ai-proposal-actions";
        const previewButton = document.createElement("button");
        previewButton.type = "button";
        previewButton.className = "panel-button";
        // Customize button text based on type
        const buttonText = proposalType === "delete" ? "削除を確認"
            : proposalType === "mkdir" ? "作成を確認"
                : "差分を確認";
        previewButton.textContent = buttonText;
        previewButton.addEventListener("click", () => {
            var _a;
            pendingProposalId = proposal.id;
            deps.diffModal.setDiffContext({ type: "aiApply", proposalId: proposal.id });
            const modalTitle = proposalType === "delete" ? "削除の確認"
                : proposalType === "rename" ? "移動の確認"
                    : proposalType === "mkdir" ? "フォルダ作成の確認"
                        : "AI提案の確認";
            const submitLabel = proposalType === "delete" ? "削除"
                : proposalType === "mkdir" ? "作成"
                    : "適用";
            deps.diffModal.showDiffModal((_a = proposal.originalContent) !== null && _a !== void 0 ? _a : "", proposal.content, 0, {
                title: modalTitle,
                fileName: proposal.path,
                submitLabel: submitLabel,
            });
        });
        actions.appendChild(previewButton);
        card.append(header, summary, actions);
        return card;
    };
    function renderChatList() {
        if (!(aiChatList instanceof HTMLElement)) {
            return;
        }
        aiChatList.replaceChildren();
        // "New Chat" button removed from list view as per request.
        // New chats are now created by sending a message from the list view.
        // Reverse chats to show newest first
        const reversedChats = [...chats].reverse();
        // Determine items to show
        const isExpanded = aiChatList._isExpanded || false;
        const limit = 3;
        const showAll = isExpanded || reversedChats.length <= limit;
        const visibleChats = showAll ? reversedChats : reversedChats.slice(0, limit);
        visibleChats.forEach((chat) => {
            const row = document.createElement("div");
            row.className = "ai-chat-item";
            if (chat.id === activeChatId) {
                row.classList.add("is-active");
            }
            row.dataset.chatId = chat.id;
            row.addEventListener("click", () => setActiveChat(chat.id));
            // Title/Input container
            const titleContainer = document.createElement("div");
            titleContainer.style.flex = "1";
            titleContainer.style.overflow = "hidden";
            titleContainer.style.display = "flex";
            titleContainer.style.alignItems = "center";
            const titleSpan = document.createElement("span");
            titleSpan.className = "ai-chat-item-text";
            titleSpan.textContent = chat.title;
            titleContainer.appendChild(titleSpan);
            row.appendChild(titleContainer);
            // Actions container (Rename + Close)
            const actions = document.createElement("div");
            actions.className = "ai-chat-item-actions";
            // Rename Button (Pen)
            const renameBtn = document.createElement("button");
            renameBtn.className = "ai-chat-item-btn";
            renameBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
            renameBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                // Switch to edit mode
                titleSpan.style.display = "none";
                const input = document.createElement("input");
                input.className = "ai-chat-item-rename-input";
                input.value = chat.title;
                input.onclick = (ev) => ev.stopPropagation(); // Prevent row click
                const save = () => {
                    const newTitle = input.value.trim() || chat.title;
                    chat.title = newTitle;
                    // Update logic updates (assuming toolbar update happens on render or setActive)
                    if (activeChatId === chat.id) {
                        aiChatTitle.textContent = newTitle;
                    }
                    renderChatList();
                };
                input.addEventListener("blur", save);
                input.addEventListener("keydown", (ev) => {
                    if (ev.key === "Enter") {
                        input.blur();
                    }
                });
                titleContainer.appendChild(input);
                input.focus();
            });
            actions.appendChild(renameBtn);
            if (chats.length > 1) {
                const closeButton = document.createElement("button");
                closeButton.type = "button";
                closeButton.className = "ai-chat-item-btn"; // Use generic btn class
                closeButton.textContent = "×";
                closeButton.style.fontSize = "18px"; // Larger X
                closeButton.addEventListener("click", (event) => {
                    event.stopPropagation();
                    removeChat(chat.id);
                });
                actions.appendChild(closeButton);
            }
            row.appendChild(actions);
            aiChatList.appendChild(row);
        });
        // Expand Button
        if (!showAll) {
            const expandWrapper = document.createElement("div");
            expandWrapper.className = "ai-chat-expand-wrapper";
            const expandBtn = document.createElement("button");
            expandBtn.className = "ai-chat-expand-btn";
            expandBtn.innerHTML = `<span>すべて表示 (${chats.length})</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>`;
            expandBtn.onclick = () => {
                aiChatList._isExpanded = true;
                renderChatList();
            };
            expandWrapper.appendChild(expandBtn);
            aiChatList.appendChild(expandWrapper);
        }
        else if (chats.length > limit) {
            // Optional: Collapse button? User didn't ask for collapse, but "expand capability". 
            // User said "click long button to look for chats". 
            // Often implies toggle. I'll add toggle back to collapsed if already expanded?
            // Just keeping expanded for now is safer unless requested.
            // Actually, let's allow collapsing for convenience.
            const expandWrapper = document.createElement("div");
            expandWrapper.className = "ai-chat-expand-wrapper";
            const collapseBtn = document.createElement("button");
            collapseBtn.className = "ai-chat-expand-btn";
            collapseBtn.innerHTML = `<span>閉じる</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>`;
            collapseBtn.onclick = () => {
                aiChatList._isExpanded = false;
                renderChatList();
            };
            expandWrapper.appendChild(collapseBtn);
            aiChatList.appendChild(expandWrapper);
        }
    }
    const renderChatContent = () => {
        const chat = getChat(activeChatId);
        if (!chat) {
            return;
        }
        aiChatLog === null || aiChatLog === void 0 ? void 0 : aiChatLog.replaceChildren();
        aiProposals === null || aiProposals === void 0 ? void 0 : aiProposals.replaceChildren();
        chat.messages.forEach((message) => {
            aiChatLog === null || aiChatLog === void 0 ? void 0 : aiChatLog.appendChild(createMessageElement(message));
        });
        chat.proposals.forEach((proposal) => {
            aiProposals === null || aiProposals === void 0 ? void 0 : aiProposals.appendChild(createProposalCard(proposal));
        });
        if (aiChat instanceof HTMLElement) {
            aiChat.scrollTop = aiChat.scrollHeight;
        }
    };
    const removeChat = (chatId) => {
        var _a;
        if (chats.length <= 1) {
            return;
        }
        const index = chats.findIndex((entry) => entry.id === chatId);
        if (index < 0) {
            return;
        }
        const [removed] = chats.splice(index, 1);
        chatIndex.delete(removed.id);
        removed.proposals.forEach((proposal) => proposalIndex.delete(proposal.id));
        if (activeChatId === removed.id) {
            const next = (_a = chats[Math.max(0, index - 1)]) !== null && _a !== void 0 ? _a : chats[0];
            activeChatId = next.id;
        }
        renderChatList();
        renderChatContent();
        updateStatusDisplay();
    };
    const handleSend = () => {
        if (!(aiInput instanceof HTMLTextAreaElement)) {
            return;
        }
        const text = aiInput.value.trim();
        if (!text) {
            return;
        }
        // Auto-create chat if in list view or no active chat
        if (viewMode === "list" || !activeChatId) {
            const chat = createChat();
            setActiveChat(chat.id); // Switches to chat view
        }
        const chat = getChat(activeChatId);
        if (!chat) {
            return;
        }
        if (chat.title.startsWith("Chat ")) {
            chat.title = text.slice(0, 18).replace(/\s+/g, " ") || chat.title;
            aiChatTitle.textContent = chat.title; // Update toolbar title
            renderChatList();
        }
        appendMessage({ role: "user", text }, chat.id);
        aiInput.value = "";
        // No status text - button visual indicates sending
        runningConversationId = chat.id;
        updateSendState();
        deps.postToNative({
            type: "agent:run",
            message: text,
            conversationId: chat.id,
            context: {
                activeFilePath: deps.getActiveFilePath(),
            },
        });
    };
    if (aiSend instanceof HTMLButtonElement) {
        aiSend.addEventListener("click", () => handleSend());
    }
    if (aiInput instanceof HTMLTextAreaElement) {
        aiInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                handleSend();
            }
        });
    }
    if (aiClear instanceof HTMLButtonElement) {
        aiClear.addEventListener("click", () => {
            const chat = getChat(activeChatId);
            if (!chat) {
                return;
            }
            chat.messages = [];
            chat.proposals.clear();
            renderChatContent();
            proposalIndex.forEach((value, key) => {
                if (value === chat.id) {
                    proposalIndex.delete(key);
                }
            });
            deps.postToNative({ type: "agent:clear", conversationId: chat.id }, true);
            chat.statusMessage = "履歴をクリアしました。";
            updateStatusDisplay();
        });
    }
    if (aiChatNew instanceof HTMLButtonElement) {
        aiChatNew.addEventListener("click", () => {
            const chat = createChat();
            setActiveChat(chat.id);
        });
    }
    const handleSettings = (_settings) => {
        updateSendState();
    };
    const handleStatus = (state, message, conversationId) => {
        const chat = ensureChat(conversationId);
        if (!chat) {
            return;
        }
        if (state === "running") {
            runningConversationId = chat.id;
            chat.statusMessage = message || "AIが応答中です...";
        }
        else {
            if (runningConversationId === chat.id) {
                runningConversationId = null;
            }
            chat.statusMessage = message || "待機中";
        }
        updateSendState();
        if (chat.id === activeChatId) {
            updateStatusDisplay();
        }
    };
    const handleMessage = (text, conversationId) => {
        appendMessage({ role: "assistant", text }, conversationId);
        if (conversationId && runningConversationId === conversationId) {
            runningConversationId = null;
            updateSendState();
        }
        const chat = ensureChat(conversationId);
        if (chat) {
            chat.statusMessage = "待機中";
        }
        updateStatusDisplay();
    };
    const handleTool = (payload) => {
        // const summary = payload.summary ? `: ${payload.summary}` : "";
        // appendMessage({ role: "system", text: `ツール: ${payload.name}${summary}` }, payload.conversationId);
    };
    const handleProposal = (proposal) => {
        const chat = ensureChat(proposal.conversationId);
        if (!chat) {
            return;
        }
        chat.proposals.set(proposal.id, proposal);
        proposalIndex.set(proposal.id, chat.id);
        if (chat.id === activeChatId) {
            aiProposals === null || aiProposals === void 0 ? void 0 : aiProposals.appendChild(createProposalCard(proposal));
        }
    };
    const handleApplyResult = (payload) => {
        var _a, _b;
        const chatId = proposalIndex.get(payload.proposalId);
        const chat = getChat(chatId);
        if (!chat) {
            return;
        }
        const proposal = chat.proposals.get(payload.proposalId);
        if (!proposal) {
            return;
        }
        if (payload.ok) {
            chat.proposals.delete(payload.proposalId);
            proposalIndex.delete(payload.proposalId);
            (_a = aiProposals === null || aiProposals === void 0 ? void 0 : aiProposals.querySelector(`[data-proposal-id="${payload.proposalId}"]`)) === null || _a === void 0 ? void 0 : _a.remove();
            appendMessage({ role: "system", text: `適用完了: ${proposal.path}` }, chat.id);
        }
        else {
            appendMessage({ role: "system", text: `適用失敗: ${(_b = payload.error) !== null && _b !== void 0 ? _b : "不明なエラー"}` }, chat.id);
        }
    };
    const handleError = (message, conversationId) => {
        appendMessage({ role: "system", text: message }, conversationId);
        const chat = ensureChat(conversationId);
        if (chat) {
            chat.statusMessage = message;
        }
        if (conversationId && runningConversationId === conversationId) {
            runningConversationId = null;
            updateSendState();
        }
        updateStatusDisplay();
    };
    const applyPendingFromDiffModal = () => {
        if (!pendingProposalId) {
            return;
        }
        deps.postToNative({ type: "agent:apply", proposalId: pendingProposalId });
        pendingProposalId = null;
    };
    const clearPending = () => {
        pendingProposalId = null;
    };
    if (chats.length === 0) {
        const initial = createChat();
        activeChatId = initial.id;
        // Do not set active view here, stay in list
    }
    // Initial View Setup
    setViewMode("list");
    renderChatList();
    return {
        handleSettings,
        handleStatus,
        handleMessage,
        handleTool,
        handleProposal,
        handleApplyResult,
        handleError,
        applyPendingFromDiffModal,
        clearPending,
    };
};
