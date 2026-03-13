import { createChat as createChatState, ensureChat as ensureChatState, getChat as getChatState, } from "./ai-chat-state.js";
import { createMessageElement, updateMessageElement } from "./ai-chat-message.js";
import { createProposalCard } from "./ai-chat-proposal.js";
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
const AUTONOMOUS_LOOP_LIMIT = 100;
const USAGE_REFRESH_DELAY_MS = 300;
export const initAiChatUi = (context, deps) => {
    const { aiChatLog, aiChat, aiProposals, aiAttachments, aiAttach, aiAttachInput, aiInput, aiSend, aiStatus, aiChatNew, aiModelSelect, aiTopbarTitle, aiTopbarStatus, aiUsageMeter, aiUsageMeterText, aiHistoryToggle, aiHistory, aiHistoryList, aiAuthTopbar, aiContextBar, aiStop, aiUndo, } = context.dom;
    const chats = [];
    const chatIndex = new Map();
    const proposalIndex = new Map();
    let activeChatId = null;
    const runningConversations = new Set();
    const resumableConversations = new Set();
    let agentSettings = null;
    const streamingMessages = new Map();
    const thinkingMessages = new Map();
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
            return "シンボルリネーム";
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
            aiTopbarTitle.textContent = "新規チャット";
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
        // activeChatId === null は「新規チャット」画面 → 常に入力を有効にする（並列実行対応）
        const blockInput = activeChatId !== null && isRunning;
        if (aiSend instanceof HTMLButtonElement) {
            aiSend.disabled = blockInput;
            aiSend.classList.remove("is-loading");
            aiSend.style.display = blockInput ? "none" : "flex";
        }
        if (aiInput instanceof HTMLTextAreaElement)
            aiInput.disabled = blockInput;
        if (aiAttach instanceof HTMLButtonElement)
            aiAttach.disabled = blockInput;
        if (aiAttachInput instanceof HTMLInputElement)
            aiAttachInput.disabled = blockInput;
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
        if (proposals.parentElement !== chatLog)
            chatLog.appendChild(proposals);
        else if (chatLog.lastElementChild !== proposals)
            chatLog.appendChild(proposals);
        return proposals;
    };
    const appendToChatLog = (element) => {
        var _a;
        const chatLog = getChatLog();
        if (!chatLog)
            return;
        (_a = chatLog.querySelector(".ai-empty-state")) === null || _a === void 0 ? void 0 : _a.remove();
        const proposals = getProposalsContainer();
        if (proposals && proposals.parentElement === chatLog)
            chatLog.insertBefore(element, proposals);
        else
            chatLog.appendChild(element);
    };
    const scrollToBottom = () => { if (aiChat instanceof HTMLElement)
        aiChat.scrollTop = aiChat.scrollHeight; };
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
            return "思考中...";
        if (raw.startsWith("思考中"))
            return raw;
        return `思考中: ${raw}`;
    };
    const INDICATOR_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4L20 12L12 20L4 12Z"/><ellipse cx="12" cy="12" rx="6" ry="2.5" transform="rotate(-30 12 12)" stroke-width="1" opacity="0.4"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>';
    const createThinkingElement = (text) => {
        const wrapper = document.createElement("div");
        wrapper.className = "ai-message is-assistant ai-thinking-message";
        const indicator = document.createElement("div");
        indicator.className = "ai-message-indicator";
        indicator.innerHTML = INDICATOR_SVG;
        const body = document.createElement("div");
        body.className = "ai-message-body";
        const content = document.createElement("div");
        content.className = "ai-message-content";
        content.textContent = text;
        body.appendChild(content);
        wrapper.appendChild(indicator);
        wrapper.appendChild(body);
        return wrapper;
    };
    const upsertThinkingMessage = (chatId, text) => {
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
                if (content)
                    content.textContent = normalized;
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
    let pendingAiProposalId = null;
    const dismissProposal = (proposalId) => {
        var _a;
        const chatId = proposalIndex.get(proposalId);
        const chat = getChat(chatId);
        if (!chat)
            return;
        chat.proposals.delete(proposalId);
        proposalIndex.delete(proposalId);
        if (chat.id === activeChatId) {
            const proposals = getProposalsContainer();
            (_a = proposals === null || proposals === void 0 ? void 0 : proposals.querySelector(`[data-proposal-id="${proposalId}"]`)) === null || _a === void 0 ? void 0 : _a.remove();
            if (proposals && chat.proposals.size === 0) {
                proposals.classList.add("is-hidden");
            }
        }
        renderHistoryList();
    };
    const buildProposalCard = (proposal) => createProposalCard(proposal, {
        postToNative: deps.postToNative,
        dismissProposal,
        setPendingProposalId: (v) => { pendingAiProposalId = v; },
        showDiffModal: deps.showDiffModal,
        setDiffContext: deps.setDiffContext,
    });
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
            chat.proposals.forEach((p) => proposals.appendChild(buildProposalCard(p)));
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
    const syncModelSelect = (model) => {
        if (!(aiModelSelect instanceof HTMLSelectElement))
            return;
        const value = typeof model === "string" && model ? model : "gpt-4o-mini";
        if (aiModelSelect.value !== value) {
            aiModelSelect.value = value;
        }
    };
    const handleSettings = (s) => {
        agentSettings = s;
        syncModelSelect(s === null || s === void 0 ? void 0 : s.model);
        updateSendState();
    };
    if (aiModelSelect instanceof HTMLSelectElement) {
        aiModelSelect.addEventListener("change", () => {
            const model = aiModelSelect.value;
            deps.postToNative({ type: "agent:settings:set", settings: { model } }, true);
        });
    }
    const { handleState, handleStatus, handleMessage, handleMessageDelta, handleTool, handleProposal, handleApplyResult, handleUndoResult, handleUndoAvailability, handleScratchpad, handleThought, handleError, } = createAiChatIncomingHandlers({
        postToNative: deps.postToNative,
        dismissProposal,
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
        ensureProposalsEmbedded,
        buildProposalCard,
        getProposalsContainer,
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
        applyPendingFromDiffModal: () => { if (pendingAiProposalId) {
            deps.postToNative({ type: "agent:apply", proposalId: pendingAiProposalId });
            pendingAiProposalId = null;
        } },
        clearPending: () => { pendingAiProposalId = null; },
    };
};
