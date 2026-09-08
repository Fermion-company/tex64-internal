import { aiText } from "./ai-i18n.js";
import { setLocalizedAttribute } from "./i18n.js";
import { createQuestionElement, readPlanRequest, readQuestionAnswer } from "./ai-chat-message.js";
const MODE_STORAGE_KEY = "tex64.axiom.mode";
const loadStoredMode = () => {
    try {
        const stored = localStorage.getItem(MODE_STORAGE_KEY);
        return stored === "ask" || stored === "plan" ? stored : "agent";
    }
    catch {
        return "agent";
    }
};
const PLACEHOLDER_BY_MODE = {
    agent: "Ask anything about this document. @ adds a file",
    ask: "Ask a question. Nothing is changed",
    plan: "Plan first. Nothing is written yet",
};
export const initAiChatEventBindings = (params) => {
    const { aiChatLog, aiInput, aiSend, aiAttach, aiAttachInput, aiStatus, aiUndo, aiStop, aiChatNew, aiModeToggle, postToNative, getActiveChatId, setActiveChatId, getPendingAttachments, getChat, createChat, setChatTitle, renderHistoryList, appendMessage, removeQueuedMessage, settleLiveProposals, autoGrow, updateContextBar, requestAgentRun, buildContextPayload, clearPendingAttachments, clearMentionPaths, addImageFiles, isAiBlocked, needsLogin, requestAiAccessCheck, requestPlatformUsage, updateStatusDisplay, runningConversations, resumableConversations, pendingAgentRequests, clearThinkingMessage, upsertThinkingMessage, updateSendState, resetToNewChatState, onModeChange, scrollToBottom, } = params;
    // ── Mode: Agent edits and builds, Ask only answers ──
    let mode = loadStoredMode();
    const applyModeToDom = () => {
        if (aiModeToggle instanceof HTMLElement) {
            aiModeToggle.querySelectorAll("[data-ai-mode]").forEach((option) => {
                const active = option.dataset.aiMode === mode;
                option.classList.toggle("is-active", active);
                option.setAttribute("aria-checked", active ? "true" : "false");
            });
        }
        if (aiInput instanceof HTMLTextAreaElement) {
            // The locale pass translates from the recorded English source.
            setLocalizedAttribute(aiInput, "placeholder", PLACEHOLDER_BY_MODE[mode]);
        }
    };
    const setMode = (next) => {
        mode = next === "ask" || next === "plan" ? next : "agent";
        try {
            localStorage.setItem(MODE_STORAGE_KEY, mode);
        }
        catch {
            // stays for the session
        }
        applyModeToDom();
        onModeChange === null || onModeChange === void 0 ? void 0 : onModeChange(mode);
    };
    // The pill's words and titles live in the markup and the locale dictionary.
    const syncModeLabels = () => applyModeToDom();
    if (aiModeToggle instanceof HTMLElement) {
        aiModeToggle.addEventListener("click", (event) => {
            var _a;
            const option = (_a = event.target) === null || _a === void 0 ? void 0 : _a.closest("[data-ai-mode]");
            if (!option)
                return;
            event.preventDefault();
            const chosen = option.dataset.aiMode;
            setMode(chosen === "ask" || chosen === "plan" ? chosen : "agent");
            if (aiInput instanceof HTMLTextAreaElement)
                aiInput.focus();
        });
    }
    syncModeLabels();
    const buildPayload = () => buildContextPayload({ axiomMode: mode });
    // ── Queue: a request typed while a turn runs waits behind it ──
    const makeQueueId = () => `q-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
    const dispatchQueued = (chat, item) => {
        removeQueuedMessage(chat.id, item.id);
        chat.queue = chat.queue.filter((entry) => entry.id !== item.id);
        settleLiveProposals(chat);
        appendMessage({ role: "user", text: item.text }, chat.id);
        const sent = requestAgentRun(chat.id, item.text, item.parts, item.contextPayload);
        if (!sent) {
            // Put it back at the front; the reader can send it again by hand.
            chat.queue.unshift(item);
            appendMessage({ role: "user", text: item.text, queued: true, queueId: item.id }, chat.id);
        }
        renderHistoryList();
        updateSendState();
    };
    /** Send the next waiting request of a chat, if any. */
    const drainQueue = (chatId) => {
        const chat = getChat(chatId);
        if (!chat || runningConversations.has(chat.id))
            return;
        const next = chat.queue[0];
        if (!next)
            return;
        if (isAiBlocked() || needsLogin())
            return;
        dispatchQueued(chat, next);
    };
    let sendGuard = false;
    // Core submit path shared by the send button, Enter, the starting points,
    // the next steps and the queue. clearInput is false for quick actions so
    // a half-typed draft is kept.
    const submitMessage = (rawText, opts) => {
        var _a;
        if (sendGuard)
            return;
        const clearInput = (opts === null || opts === void 0 ? void 0 : opts.clearInput) !== false;
        const text = typeof rawText === "string" ? rawText.trim() : "";
        const pendingAttachments = getPendingAttachments();
        const hasAttachments = pendingAttachments.length > 0;
        if (!text && !hasAttachments)
            return;
        if (isAiBlocked() || needsLogin()) {
            if (needsLogin()) {
                // The line above the composer already says so; sending starts the sign-in.
                postToNative({ type: "auth:google:start" });
            }
            else {
                requestAiAccessCheck(true);
                requestPlatformUsage(true);
                updateStatusDisplay();
            }
            return;
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
        const contextPayload = buildContextPayload({ axiomMode: mode, ...((_a = opts === null || opts === void 0 ? void 0 : opts.extras) !== null && _a !== void 0 ? _a : {}) });
        const userLabel = text || "The image has been sent.";
        const attachmentNote = hasAttachments ? `\n[attached images ${pendingAttachments.length}]` : "";
        // A running turn keeps the chat: the new request waits behind it, in
        // view, and goes out by itself when the turn ends.
        if (runningConversations.has(chat.id) && (opts === null || opts === void 0 ? void 0 : opts.queueIfRunning) !== false) {
            const item = {
                id: makeQueueId(),
                text: requestMessage,
                parts: requestParts,
                contextPayload,
            };
            chat.queue.push(item);
            appendMessage({ role: "user", text: `${userLabel}${attachmentNote}`, queued: true, queueId: item.id }, chat.id);
            if (clearInput && aiInput instanceof HTMLTextAreaElement) {
                aiInput.value = "";
                autoGrow();
            }
            clearPendingAttachments();
            clearMentionPaths === null || clearMentionPaths === void 0 ? void 0 : clearMentionPaths();
            renderHistoryList();
            updateSendState();
            scrollToBottom === null || scrollToBottom === void 0 ? void 0 : scrollToBottom(true);
            return;
        }
        // The previous turn's changes stay with its reply; the running card
        // starts empty for this request.
        settleLiveProposals(chat);
        renderHistoryList();
        appendMessage({ role: "user", text: `${userLabel}${attachmentNote}` }, chat.id);
        if (clearInput && aiInput instanceof HTMLTextAreaElement) {
            aiInput.value = "";
            autoGrow();
        }
        updateContextBar();
        sendGuard = true;
        const sent = requestAgentRun(chat.id, requestMessage, requestParts, contextPayload);
        if (sent) {
            clearPendingAttachments();
            clearMentionPaths === null || clearMentionPaths === void 0 ? void 0 : clearMentionPaths();
        }
        sendGuard = false;
    };
    const handleSend = () => {
        if (!(aiInput instanceof HTMLTextAreaElement))
            return;
        submitMessage(aiInput.value, { clearInput: true });
    };
    if (aiSend instanceof HTMLButtonElement)
        aiSend.addEventListener("click", handleSend);
    // ── Choosable rows: the starting points of an empty chat, or the newest
    // next steps under a reply. Tab moves the highlight, Enter on an empty
    // composer takes the highlighted one, Escape lets go.
    const choiceRows = () => {
        if (!(aiChatLog instanceof HTMLElement))
            return [];
        const starts = Array.from(aiChatLog.querySelectorAll(".ai-start-row"));
        if (starts.length > 0)
            return starts;
        return Array.from(aiChatLog.querySelectorAll(".ai-next-steps.is-latest .ai-step-row"));
    };
    const highlightChoice = (index) => {
        choiceRows().forEach((row, rowIndex) => {
            row.classList.toggle("is-active", index !== null && rowIndex === index);
        });
    };
    const activeChoiceIndex = () => choiceRows().findIndex((row) => row.classList.contains("is-active"));
    const openStepQuestion = (row) => {
        var _a, _b, _c, _d, _e, _f;
        const asksRaw = (_a = row.dataset.aiAsks) !== null && _a !== void 0 ? _a : "";
        let asks = null;
        try {
            asks = asksRaw ? JSON.parse(asksRaw) : null;
        }
        catch {
            asks = null;
        }
        const steps = row.closest(".ai-next-steps");
        if (!asks || !steps)
            return false;
        (_b = steps.querySelector(".ai-question")) === null || _b === void 0 ? void 0 : _b.remove();
        const form = createQuestionElement(asks, {
            lead: (_d = (_c = row.querySelector(".ai-step-title")) === null || _c === void 0 ? void 0 : _c.textContent) !== null && _d !== void 0 ? _d : "",
            request: (_e = row.dataset.aiRequest) !== null && _e !== void 0 ? _e : "",
            stepId: (_f = row.dataset.aiStepId) !== null && _f !== void 0 ? _f : "",
        });
        steps.appendChild(form);
        const first = form.querySelector("input, textarea");
        first === null || first === void 0 ? void 0 : first.focus();
        scrollToBottom === null || scrollToBottom === void 0 ? void 0 : scrollToBottom(true);
        return true;
    };
    const takeChoice = (row) => {
        var _a, _b;
        if (row.classList.contains("ai-start-row")) {
            const request = (_a = row.dataset.aiStart) !== null && _a !== void 0 ? _a : "";
            // A review reads and reports; it runs as Ask whatever the pill says.
            const extras = row.dataset.aiStartMode === "ask" ? { axiomMode: "ask" } : undefined;
            if (request)
                submitMessage(request, { clearInput: true, extras });
            return;
        }
        if (row.dataset.aiAsks && openStepQuestion(row))
            return;
        // A step without its own question still starts with the brief: the
        // agent asks what decides the outcome before it writes.
        const request = (_b = row.dataset.aiRequest) !== null && _b !== void 0 ? _b : "";
        if (request) {
            submitMessage(request, {
                clearInput: true,
                extras: { turnOrigin: "step", stepKind: row.dataset.aiStepKind === "mechanical" ? "mechanical" : "writing" },
            });
        }
    };
    // Typing takes over from the highlighted row.
    if (aiInput instanceof HTMLTextAreaElement) {
        aiInput.addEventListener("input", () => {
            if (aiInput.value.trim().length > 0 && activeChoiceIndex() >= 0)
                highlightChoice(null);
        });
    }
    if (aiChatLog instanceof HTMLElement) {
        aiChatLog.addEventListener("click", (event) => {
            var _a, _b, _c, _d, _e, _f, _g;
            const target = event.target;
            const option = (_a = target === null || target === void 0 ? void 0 : target.closest) === null || _a === void 0 ? void 0 : _a.call(target, ".ai-question-option");
            if (option) {
                event.preventDefault();
                const form = option.closest("form");
                form === null || form === void 0 ? void 0 : form.querySelectorAll(".ai-question-option").forEach((el) => el.classList.toggle("is-chosen", el === option));
                return;
            }
            const cancel = (_b = target === null || target === void 0 ? void 0 : target.closest) === null || _b === void 0 ? void 0 : _b.call(target, "[data-ai-question-cancel]");
            if (cancel) {
                event.preventDefault();
                (_c = cancel.closest(".ai-question")) === null || _c === void 0 ? void 0 : _c.remove();
                return;
            }
            const queued = (_d = target === null || target === void 0 ? void 0 : target.closest) === null || _d === void 0 ? void 0 : _d.call(target, "[data-ai-queue-action]");
            if (queued) {
                event.preventDefault();
                const wrapper = queued.closest(".ai-message.is-queued");
                const chat = getChat(getActiveChatId());
                const queueId = (_e = wrapper === null || wrapper === void 0 ? void 0 : wrapper.dataset.aiQueueId) !== null && _e !== void 0 ? _e : "";
                if (!chat || !queueId)
                    return;
                const item = chat.queue.find((entry) => entry.id === queueId);
                if (!item)
                    return;
                if (queued.dataset.aiQueueAction === "remove") {
                    chat.queue = chat.queue.filter((entry) => entry.id !== queueId);
                    removeQueuedMessage(chat.id, queueId);
                    renderHistoryList();
                    updateSendState();
                    return;
                }
                if (runningConversations.has(chat.id))
                    return;
                dispatchQueued(chat, item);
                return;
            }
            const planRun = (_f = target === null || target === void 0 ? void 0 : target.closest) === null || _f === void 0 ? void 0 : _f.call(target, "[data-ai-plan-run]");
            if (planRun) {
                event.preventDefault();
                const planEl = planRun.closest(".ai-plan");
                let plan = null;
                try {
                    plan = (planEl === null || planEl === void 0 ? void 0 : planEl.dataset.aiPlanJson) ? JSON.parse(planEl.dataset.aiPlanJson) : null;
                }
                catch {
                    plan = null;
                }
                if (!planEl || !plan)
                    return;
                // The reviewed plan runs in Agent mode; the pill follows.
                setMode("agent");
                submitMessage(readPlanRequest(planEl, plan), { clearInput: false, extras: { axiomMode: "agent" } });
                return;
            }
            const row = (_g = target === null || target === void 0 ? void 0 : target.closest) === null || _g === void 0 ? void 0 : _g.call(target, ".ai-start-row, .ai-step-row");
            if (!row)
                return;
            event.preventDefault();
            takeChoice(row);
        });
        // A question form: the answer becomes the next message, together with
        // the step's request when it belongs to a step.
        aiChatLog.addEventListener("submit", (event) => {
            var _a, _b;
            const form = event.target;
            if (!(form instanceof HTMLFormElement) || !form.dataset.aiQuestion)
                return;
            event.preventDefault();
            const answer = readQuestionAnswer(form);
            if (!answer.trim()) {
                (_a = form.querySelector("input, textarea")) === null || _a === void 0 ? void 0 : _a.focus();
                return;
            }
            const request = (_b = form.dataset.aiRequest) !== null && _b !== void 0 ? _b : "";
            const text = request ? `${request}\n\n${aiText("answer_placeholder")}: ${answer}` : answer;
            form.remove();
            submitMessage(text, { clearInput: false });
        });
        aiChatLog.addEventListener("keydown", (event) => {
            var _a;
            const target = event.target;
            if (!(target instanceof HTMLTextAreaElement) || !target.classList.contains("ai-question-answer"))
                return;
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                (_a = target.form) === null || _a === void 0 ? void 0 : _a.requestSubmit();
            }
        });
        aiChatLog.addEventListener("input", (event) => {
            const target = event.target;
            if (target instanceof HTMLTextAreaElement && (target.classList.contains("ai-question-answer") || target.classList.contains("ai-rate-input") || target.classList.contains("ai-plan-note"))) {
                target.style.height = "auto";
                target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
            }
        });
    }
    if (aiInput instanceof HTMLTextAreaElement) {
        aiInput.addEventListener("keydown", (e) => {
            var _a;
            const rows = choiceRows();
            const composerEmpty = aiInput.value.trim().length === 0;
            if (e.key === "Tab" && rows.length > 0 && composerEmpty && !e.isComposing) {
                e.preventDefault();
                const current = activeChoiceIndex();
                const next = current < 0
                    ? e.shiftKey ? rows.length - 1 : 0
                    : (current + (e.shiftKey ? -1 : 1) + rows.length) % rows.length;
                highlightChoice(next);
                (_a = rows[next]) === null || _a === void 0 ? void 0 : _a.scrollIntoView({ block: "nearest" });
                return;
            }
            if (e.key === "Escape" && activeChoiceIndex() >= 0) {
                e.preventDefault();
                highlightChoice(null);
                return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                if (composerEmpty && rows.length > 0) {
                    const index = Math.max(0, activeChoiceIndex());
                    const row = rows[index];
                    if (row)
                        takeChoice(row);
                    return;
                }
                handleSend();
            }
        });
        aiInput.addEventListener("paste", (event) => {
            var _a, _b;
            const files = (_b = (_a = event.clipboardData) === null || _a === void 0 ? void 0 : _a.files) !== null && _b !== void 0 ? _b : null;
            if (!files || files.length === 0)
                return;
            const hasSupported = Array.from(files).some((file) => file.type.startsWith("image/") || file.type === "application/pdf" || /\.pdf$/i.test(file.name));
            if (!hasSupported)
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
                window.dispatchEvent(new CustomEvent("tex64:open-plans"));
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
            const hasSupported = Array.from(files).some((file) => file.type.startsWith("image/") || file.type === "application/pdf" || /\.pdf$/i.test(file.name));
            if (!hasSupported)
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
                postToNative({ type: "agent:abort", conversationId: chat.id }, true);
                resumableConversations.delete(chat.id);
                pendingAgentRequests.delete(chat.id);
                // Keep the conversation locked until main reports a terminal state.
                // Main may still be compiling a completed partial edit; reopening send
                // here can replace its run token and abandon that definitive build.
                chat.statusMessage = "Finishing partial changes...";
                upsertThinkingMessage(chat.id, chat.statusMessage);
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
            const contextToSend = buildPayload();
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
    return { submitMessage, drainQueue, getMode: () => mode, setMode, syncModeLabels, openStepQuestion };
};
