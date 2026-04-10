import { AUTONOMOUS_LOOP_LIMIT, createChat as createChatState, ensureChat as ensureChatState, getChat as getChatState, } from "./ai-chat-state.js";
import { createMessageElement, updateMessageElement } from "./ai-chat-message.js";
import { createUnifiedProposalCard } from "./ai-chat-proposal.js";
import { TEX64_LINKS } from "./platform-links.js";
import { createAiChatStatusController } from "./ai-chat-status.js";
import { createContextPayloadBuilder } from "./ai-chat-context-payload.js";
import { createContextBarUpdater } from "./ai-chat-context-bar.js";
import { initAiChatEventBindings } from "./ai-chat-ui-events.js";
import { createHistoryController } from "./ai-chat-history.js";
import { createAiChatAttachmentsController } from "./ai-chat-attachments.js";
import { createAiChatIncomingHandlers } from "./ai-chat-incoming-handlers.js";
import { createAiChatRunner } from "./ai-chat-runner.js";
import { restorePendingAiDraft } from "./ai-chat-draft-restore.js";
import { createMentionController } from "./ai-chat-mention.js";
const USAGE_REFRESH_DELAY_MS = 300;
export const initAiChatUi = (context, deps) => {
    const { aiChatLog, aiChat, aiProposals, aiAttachments, aiAttach, aiAttachInput, aiInput, aiSend, aiStatus, aiChatNew, aiTopbarTitle, aiTopbarStatus, aiUsageMeter, aiUsageMeterText, aiHistoryToggle, aiHistory, aiHistoryList, aiAuthTopbar, aiContextBar, aiStop, aiUndo, } = context.dom;
    const chats = [];
    const chatIndex = new Map();
    const proposalIndex = new Map();
    let activeChatId = null;
    const runningConversations = new Set();
    const resumableConversations = new Set();
    let agentSettings = null;
    const streamingMessages = new Map();
    const thinkingMessages = new Map();
    const thinkingTransitionTimers = new Map();
    const pendingAgentRequests = new Map();
    let getPendingAttachments = () => [];
    let renderAttachmentBar = () => { };
    let clearPendingAttachments = (_resetInput = true) => { };
    let addImageFiles = async (_fileList) => { };
    const platformState = {
        platformAuth: null,
        platformAiAccess: null,
        platformUsage: null,
        platformError: null,
        requestedInitialUsage: false,
    };
    let usageRefreshTimer = null;
    const makeChatId = () => `chat-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const requestPlatformState = () => {
        deps.postToNative({ type: "platform:state:get" }, true);
    };
    const requestAiAccessCheck = (force = false) => {
        deps.postToNative({ type: "feature:check", names: ["ai"], force }, true);
    };
    const requestPlatformUsage = (force = false) => {
        deps.postToNative({ type: "platform:usage:get", force }, true);
    };
    const scheduleUsageRefresh = (force = true) => {
        if (usageRefreshTimer !== null) {
            window.clearTimeout(usageRefreshTimer);
            usageRefreshTimer = null;
        }
        usageRefreshTimer = window.setTimeout(() => {
            usageRefreshTimer = null;
            requestPlatformUsage(force);
        }, USAGE_REFRESH_DELAY_MS);
    };
    // ── Login Overlay ──────────────────────────────────────
    const aiLoginOverlay = document.getElementById("ai-login-overlay");
    const aiLoginOverlayBtn = document.getElementById("ai-login-overlay-btn");
    const showLoginOverlay = () => {
        if (aiLoginOverlay)
            aiLoginOverlay.classList.add("is-visible");
    };
    const hideLoginOverlay = () => {
        if (aiLoginOverlay)
            aiLoginOverlay.classList.remove("is-visible");
    };
    if (aiLoginOverlayBtn) {
        aiLoginOverlayBtn.addEventListener("click", () => {
            deps.postToNative({ type: "auth:google:start" });
        });
    }
    const { isAiBlocked, needsLogin, openExternalUrl, resolvePricingUrl, updateStatusDisplay, handlePlatformAuth, handlePlatformAiAccess, handlePlatformUsage, handlePlatformUpdate, } = createAiChatStatusController({
        aiStatus,
        aiAuthTopbar,
        aiUsageMeter,
        aiUsageMeterText,
        postToNative: deps.postToNative,
        requestAiAccessCheck,
        requestPlatformUsage,
        pricingFallbackUrl: TEX64_LINKS.pricing,
        state: platformState,
        onStatusUpdate: () => {
            if (needsLogin())
                showLoginOverlay();
            else
                hideLoginOverlay();
        },
    });
    const _rawUpdateStatusDisplay = updateStatusDisplay;
    const wrappedUpdateStatusDisplay = () => {
        _rawUpdateStatusDisplay();
        if (needsLogin())
            showLoginOverlay();
        else
            hideLoginOverlay();
    };
    const getChat = (chatId) => getChatState(chatIndex, activeChatId, chatId);
    const resolveChatTitle = (chatId) => {
        if (chatId === "search-rename")
            return "symbol rename";
        return `Chat ${chats.length + 1}`;
    };
    const ensureChat = (chatId) => ensureChatState({
        chatId,
        activeChatId,
        chats,
        chatIndex,
        defaultAutonomous: true,
        defaultAutoLoopBudget: AUTONOMOUS_LOOP_LIMIT,
        resolveChatTitle,
    });
    const createChat = () => {
        const chat = createChatState({
            chats,
            chatIndex,
            makeChatId,
            resolveChatTitle,
            defaultAutonomous: true,
            defaultAutoLoopBudget: AUTONOMOUS_LOOP_LIMIT,
        });
        return chat;
    };
    const setChatTitle = (chat) => {
        if (aiTopbarTitle instanceof HTMLElement) {
            aiTopbarTitle.textContent = chat.title;
        }
    };
    const switchActiveChat = (chatId) => {
        const chat = getChat(chatId);
        if (!chat)
            return;
        activeChatId = chat.id;
        setChatTitle(chat);
        clearPendingAttachments();
        renderChatContent();
        wrappedUpdateStatusDisplay();
        updateSendState();
        renderHistoryList();
    };
    const resetToNewChatState = () => {
        activeChatId = null;
        clearPendingAttachments();
        if (aiTopbarTitle instanceof HTMLElement) {
            aiTopbarTitle.textContent = "New chat";
        }
        const chatLog = getChatLog();
        if (chatLog) {
            chatLog.replaceChildren();
        }
        const proposals = getProposalsContainer();
        if (proposals) {
            proposals.replaceChildren();
            proposals.classList.add("is-hidden");
        }
        wrappedUpdateStatusDisplay();
        updateSendState();
        renderHistoryList();
    };
    const { renderHistoryList } = createHistoryController({
        aiHistory,
        aiHistoryList,
        aiHistoryToggle,
        chats,
        chatIndex,
        proposalIndex,
        runningConversations,
        getActiveChatId: () => activeChatId,
        switchActiveChat,
        resetToNewChatState,
        postToNative: deps.postToNative,
    });
    if (aiAuthTopbar instanceof HTMLButtonElement) {
        aiAuthTopbar.addEventListener("click", () => {
            deps.postToNative({ type: "auth:google:start" });
        });
    }
    const updateContextBar = createContextBarUpdater({
        aiContextBar,
        getActiveFilePath: deps.getActiveFilePath,
        getActiveSelectionSnapshot: deps.getActiveSelectionSnapshot,
        getActiveCursorPosition: deps.getActiveCursorPosition,
    });
    const autoGrow = () => {
        if (!(aiInput instanceof HTMLTextAreaElement))
            return;
        aiInput.style.height = "auto";
        aiInput.style.height = Math.min(aiInput.scrollHeight, 200) + "px";
    };
    if (aiInput instanceof HTMLTextAreaElement)
        aiInput.addEventListener("input", autoGrow);
    // ── @-mention file picker ──
    const mentionController = aiInput instanceof HTMLTextAreaElement && deps.getWorkspaceFiles
        ? createMentionController({
            aiInput,
            getWorkspaceFiles: deps.getWorkspaceFiles,
        })
        : null;
    const updateSendState = () => {
        const active = getChat(activeChatId);
        const isRunning = Boolean(active && runningConversations.has(active.id));
        const canResume = Boolean(active && !isRunning && resumableConversations.has(active.id));
        const canUndo = Boolean(active && active.hasUndo && !isRunning);
        // AI running 中でも入力欄は常に有効 (ChatGPT/Claude と同じ UX)。
        // ユーザーは返答を待ちながら次のメッセージを準備できる。
        // 送信ボタンは非表示にし、代わりに停止ボタンを表示する。
        const blockSend = activeChatId !== null && isRunning;
        if (aiSend instanceof HTMLButtonElement) {
            aiSend.disabled = blockSend;
            aiSend.classList.remove("is-loading");
            aiSend.style.display = blockSend ? "none" : "flex";
        }
        if (aiInput instanceof HTMLTextAreaElement)
            aiInput.disabled = false;
        if (aiAttach instanceof HTMLButtonElement)
            aiAttach.disabled = blockSend;
        if (aiAttachInput instanceof HTMLInputElement)
            aiAttachInput.disabled = blockSend;
        if (aiStop instanceof HTMLButtonElement) {
            aiStop.disabled = false;
            aiStop.innerHTML = isRunning
                ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
                : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="8,5 20,12 8,19"/></svg>';
            aiStop.style.display = isRunning || canResume ? "flex" : "none";
        }
        if (aiUndo instanceof HTMLButtonElement) {
            aiUndo.style.display = canUndo ? "flex" : "none";
            aiUndo.disabled = !canUndo;
        }
    };
    const _rawBuildContextPayload = createContextPayloadBuilder(deps);
    const buildContextPayload = (agentSettings) => {
        const payload = _rawBuildContextPayload(agentSettings);
        if (mentionController) {
            const paths = mentionController.getExplicitPaths();
            if (paths.length > 0) {
                const existing = Array.isArray(payload.explicitContextPaths)
                    ? payload.explicitContextPaths
                    : [];
                payload.explicitContextPaths = [...existing, ...paths.filter((p) => !existing.includes(p))];
            }
        }
        return payload;
    };
    const getChatLog = () => (aiChatLog instanceof HTMLElement ? aiChatLog : null);
    const getProposalsContainer = () => (aiProposals instanceof HTMLElement ? aiProposals : null);
    const ensureProposalsEmbedded = () => {
        const chatLog = getChatLog();
        const proposals = getProposalsContainer();
        if (!chatLog || !proposals)
            return null;
        // Insert proposals right after the last assistant message, not at the very end
        const assistantMessages = chatLog.querySelectorAll(".ai-message.is-assistant");
        const lastAssistant = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
        if (lastAssistant && lastAssistant.nextSibling !== proposals) {
            lastAssistant.after(proposals);
        }
        else if (!lastAssistant && proposals.parentElement !== chatLog) {
            chatLog.appendChild(proposals);
        }
        return proposals;
    };
    const appendToChatLog = (element) => {
        var _a;
        const chatLog = getChatLog();
        if (!chatLog)
            return;
        (_a = chatLog.querySelector(".ai-empty-state")) === null || _a === void 0 ? void 0 : _a.remove();
        chatLog.appendChild(element);
    };
    const scrollToBottom = () => {
        if (!(aiChatLog instanceof HTMLElement))
            return;
        // Use rAF to ensure the DOM layout is up-to-date before scrolling.
        requestAnimationFrame(() => {
            aiChatLog.scrollTop = aiChatLog.scrollHeight;
        });
    };
    const ensureStreamingMessage = (chatId) => {
        const existing = streamingMessages.get(chatId);
        if (existing)
            return existing;
        const chat = ensureChat(chatId);
        if (!chat)
            return null;
        const message = { role: "assistant", text: "" };
        chat.messages.push(message);
        let element = null;
        if (chat.id === activeChatId && aiChatLog instanceof HTMLElement) {
            element = createMessageElement(message);
            appendToChatLog(element);
            scrollToBottom();
        }
        const entry = { message, element };
        streamingMessages.set(chatId, entry);
        return entry;
    };
    const finalizeStreamingMessage = (chatId, text) => {
        const entry = streamingMessages.get(chatId);
        if (!entry)
            return false;
        entry.message.text = text;
        updateMessageElement(entry.element, text);
        streamingMessages.delete(chatId);
        return true;
    };
    const appendMessage = (message, chatId) => {
        const chat = ensureChat(chatId);
        if (!chat)
            return;
        chat.messages.push(message);
        if (chat.id !== activeChatId || !(aiChatLog instanceof HTMLElement))
            return;
        appendToChatLog(createMessageElement(message));
        scrollToBottom();
    };
    let setPendingAttachments = (_attachments) => { };
    ({
        getPendingAttachments,
        renderAttachmentBar,
        clearPendingAttachments,
        addImageFiles,
        setPendingAttachments,
    } = createAiChatAttachmentsController({
        aiAttachments,
        aiAttachInput,
        aiStatus,
        getActiveChatId: () => activeChatId,
        getChat,
        appendMessage,
    }));
    const normalizeThinkingText = (text) => {
        const raw = typeof text === "string" ? text.trim() : "";
        if (!raw)
            return "Thinking...";
        return raw;
    };
    const createThinkingElement = (text) => {
        const wrapper = document.createElement("div");
        wrapper.className = "ai-message is-assistant ai-thinking-message";
        const body = document.createElement("div");
        body.className = "ai-message-body";
        const content = document.createElement("div");
        content.className = "ai-message-content";
        content.textContent = text;
        body.appendChild(content);
        wrapper.appendChild(body);
        return wrapper;
    };
    const upsertThinkingMessage = (chatId, text) => {
        var _a;
        const chat = ensureChat(chatId);
        if (!chat)
            return;
        const normalized = normalizeThinkingText(text);
        let entry = thinkingMessages.get(chat.id);
        if (!entry) {
            entry = { text: normalized, element: null };
            thinkingMessages.set(chat.id, entry);
        }
        else {
            entry.text = normalized;
        }
        if (chat.id === activeChatId && aiChatLog instanceof HTMLElement) {
            if (entry.element && entry.element.parentElement) {
                const content = entry.element.querySelector(".ai-message-content");
                if (content) {
                    const prev = (_a = content.textContent) !== null && _a !== void 0 ? _a : "";
                    if (prev !== normalized) {
                        // Cancel any in-flight transition before starting a new one
                        const prevTimer = thinkingTransitionTimers.get(chat.id);
                        if (prevTimer !== undefined)
                            window.clearTimeout(prevTimer);
                        // Fade out → swap text → fade in
                        content.classList.add("is-transitioning");
                        const timerId = window.setTimeout(() => {
                            thinkingTransitionTimers.delete(chat.id);
                            content.textContent = normalized;
                            content.classList.remove("is-transitioning");
                        }, 200);
                        thinkingTransitionTimers.set(chat.id, timerId);
                    }
                }
            }
            else {
                entry.element = createThinkingElement(normalized);
                appendToChatLog(entry.element);
                scrollToBottom();
            }
        }
    };
    const clearThinkingMessage = (chatId) => {
        const chat = getChat(chatId);
        if (!chat)
            return;
        const prevTimer = thinkingTransitionTimers.get(chat.id);
        if (prevTimer !== undefined) {
            window.clearTimeout(prevTimer);
            thinkingTransitionTimers.delete(chat.id);
        }
        const entry = thinkingMessages.get(chat.id);
        if (!entry)
            return;
        if (entry.element && entry.element.parentElement) {
            entry.element.remove();
        }
        entry.element = null;
        thinkingMessages.delete(chat.id);
    };
    const disableAutonomous = (chatId) => {
        const chat = getChat(chatId);
        if (!chat)
            return;
        chat.autonomous = false;
        chat.autoLoopBudget = 0;
    };
    const enableAutonomous = (chat) => {
        chat.autonomous = true;
        chat.autoLoopBudget = AUTONOMOUS_LOOP_LIMIT;
    };
    let pendingAiProposalIds = [];
    const buildUnifiedProposalCard = (proposals, chat) => createUnifiedProposalCard(proposals, chat.appliedProposalIds, {
        postToNative: deps.postToNative,
        setPendingProposalIds: (ids) => { pendingAiProposalIds = ids; },
        showDiffModal: deps.showDiffModal,
        showMultiFileDiff: deps.showMultiFileDiff,
        setDiffContext: deps.setDiffContext,
    });
    const rebuildProposalCards = (chatId) => {
        const chat = getChat(chatId);
        if (!chat || chat.id !== activeChatId)
            return;
        const container = ensureProposalsEmbedded();
        if (!container)
            return;
        container.replaceChildren();
        container.classList.toggle("is-hidden", chat.proposals.size === 0);
        if (chat.proposals.size > 0) {
            const allProposals = Array.from(chat.proposals.values());
            container.appendChild(buildUnifiedProposalCard(allProposals, chat));
        }
    };
    const renderChatContent = () => {
        const chat = getChat(activeChatId);
        if (!chat)
            return;
        const chatLog = getChatLog();
        thinkingMessages.forEach((entry) => {
            entry.element = null;
        });
        chatLog === null || chatLog === void 0 ? void 0 : chatLog.replaceChildren();
        chat.messages.forEach((msg) => { if (chatLog)
            chatLog.appendChild(createMessageElement(msg)); });
        const proposals = ensureProposalsEmbedded();
        if (proposals) {
            proposals.replaceChildren();
            proposals.classList.toggle("is-hidden", chat.proposals.size === 0);
            if (chat.proposals.size > 0) {
                const allProposals = Array.from(chat.proposals.values());
                proposals.appendChild(buildUnifiedProposalCard(allProposals, chat));
            }
        }
        const se = streamingMessages.get(chat.id);
        const last = chatLog === null || chatLog === void 0 ? void 0 : chatLog.querySelectorAll(".ai-message");
        if (se && last && last.length > 0)
            se.element = last[last.length - 1];
        // Re-create thinking element in chat log if this chat is running.
        const thinking = thinkingMessages.get(chat.id);
        if (thinking) {
            thinking.element = createThinkingElement(thinking.text);
            appendToChatLog(thinking.element);
        }
        scrollToBottom();
    };
    const restoreDraftFromPending = (chatId, request) => restorePendingAiDraft({ chatId, request, activeChatId, aiInput, autoGrow, appendMessage, setPendingAttachments });
    const { requestAgentRun } = createAiChatRunner({
        isAiBlocked,
        needsLogin,
        requestAiAccessCheck,
        requestPlatformUsage,
        updateStatusDisplay: wrappedUpdateStatusDisplay,
        ensureChat,
        runningConversations,
        pendingAgentRequests,
        buildContextPayload,
        getAgentSettings: () => agentSettings,
        upsertThinkingMessage,
        renderHistoryList,
        updateSendState,
        postToNative: deps.postToNative,
        clearThinkingMessage,
        restoreDraftFromPending,
    });
    initAiChatEventBindings({
        aiInput,
        aiSend,
        aiAttach,
        aiAttachInput,
        aiStatus,
        aiUndo,
        aiStop,
        aiChatNew,
        postToNative: deps.postToNative,
        getActiveChatId: () => activeChatId,
        setActiveChatId: (chatId) => {
            activeChatId = chatId;
        },
        getPendingAttachments,
        getChat,
        createChat,
        setChatTitle,
        renderHistoryList,
        appendMessage,
        autoGrow,
        updateContextBar,
        requestAgentRun,
        buildContextPayload,
        getAgentSettings: () => agentSettings,
        clearPendingAttachments,
        clearMentionPaths: mentionController
            ? () => mentionController.clearExplicitPaths()
            : undefined,
        addImageFiles,
        isAiBlocked,
        needsLogin,
        requestAiAccessCheck,
        requestPlatformUsage,
        updateStatusDisplay: wrappedUpdateStatusDisplay,
        showLoginOverlay,
        resolvePricingUrl,
        openExternalUrl,
        runningConversations,
        resumableConversations,
        pendingAgentRequests,
        clearThinkingMessage,
        upsertThinkingMessage,
        updateSendState,
        disableAutonomous,
        resetToNewChatState,
    });
    const handleSettings = (s) => {
        agentSettings = s;
        updateSendState();
    };
    const { handleState, handleStatus, handleMessage, handleMessageDelta, handleTool, handleProposal, handleApplyResult, handleUndoResult, handleUndoAvailability, handleScratchpad, handleThought, handleError, } = createAiChatIncomingHandlers({
        postToNative: deps.postToNative,
        chats,
        chatIndex,
        proposalIndex,
        runningConversations,
        resumableConversations,
        streamingMessages,
        thinkingMessages,
        pendingAgentRequests,
        getActiveChatId: () => activeChatId,
        setActiveChatId: (chatId) => {
            activeChatId = chatId;
        },
        ensureChat,
        getChat,
        setChatTitle,
        clearPendingAttachments,
        renderHistoryList,
        renderChatContent,
        updateSendState,
        updateStatusDisplay: wrappedUpdateStatusDisplay,
        upsertThinkingMessage,
        clearThinkingMessage,
        finalizeStreamingMessage,
        ensureStreamingMessage,
        scrollToBottom,
        appendMessage,
        disableAutonomous,
        enableAutonomous,
        scheduleUsageRefresh,
        rebuildProposalCards,
        restoreDraftFromPending,
        updateContextBar,
        buildContextPayload,
        getAgentSettings: () => agentSettings,
        switchActiveChat,
    });
    resetToNewChatState();
    updateContextBar();
    renderAttachmentBar();
    requestPlatformState();
    return {
        handleSettings, handleState, handleStatus, handleMessage, handleMessageDelta, handleTool,
        handleProposal, handleApplyResult, handleUndoResult, handleUndoAvailability, handleScratchpad, handleThought, handleError,
        refreshContextBar: updateContextBar,
        handlePlatformAuth, handlePlatformAiAccess, handlePlatformUsage,
        handlePlatformUpdate,
        applyPendingFromDiffModal: () => {
            for (const id of pendingAiProposalIds) {
                deps.postToNative({ type: "agent:apply", proposalId: id });
            }
            pendingAiProposalIds = [];
            // Clear the editor's Undo/Confirm bar to keep it in sync
            const bar = document.getElementById("ai-undo-keep-bar");
            if (bar)
                bar.remove();
        },
        clearPending: () => { pendingAiProposalIds = []; },
    };
};
