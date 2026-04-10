export const createSettingsFeedbackOps = (runtime) => {
    const { settingsFeedbackCategory, settingsFeedbackMessage, settingsFeedbackEmail, settingsFeedbackIncludeDiagnostics, settingsFeedbackSend, settingsFeedbackStatus, settingsErrorReportingEnabled, } = runtime.context.dom;
    const setFeedbackStatus = (message, tone = "neutral") => {
        if (!(settingsFeedbackStatus instanceof HTMLElement)) {
            return;
        }
        settingsFeedbackStatus.textContent = message;
        settingsFeedbackStatus.classList.toggle("is-hidden", message.trim().length === 0);
        settingsFeedbackStatus.classList.toggle("is-success", tone === "success");
        settingsFeedbackStatus.classList.toggle("is-error", tone === "error");
    };
    const updateFeedbackSendState = () => {
        if (!(settingsFeedbackSend instanceof HTMLButtonElement)) {
            return;
        }
        settingsFeedbackSend.disabled = runtime.state.feedbackPending;
        settingsFeedbackSend.textContent = runtime.state.feedbackPending ? "Sending..." : "Send";
    };
    const saveFeedbackQueue = () => {
        try {
            localStorage.setItem(runtime.keys.feedbackQueueKey, JSON.stringify(runtime.state.feedbackQueue));
        }
        catch {
            // ignore storage failures
        }
    };
    const normalizeFeedbackQueueItem = (value) => {
        if (!value || typeof value !== "object") {
            return null;
        }
        const record = value;
        const id = typeof record.id === "string" && record.id.trim()
            ? record.id.trim()
            : `fb-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
        const rawCategory = typeof record.category === "string" && record.category.trim() ? record.category.trim() : "other";
        const category = rawCategory === "bug" || rawCategory === "idea" || rawCategory === "other" || rawCategory === "general"
            ? rawCategory
            : "other";
        const message = typeof record.message === "string" && record.message.trim() ? record.message.trim() : "";
        if (!message) {
            return null;
        }
        const contactEmail = typeof record.contactEmail === "string" && record.contactEmail.trim()
            ? record.contactEmail.trim()
            : undefined;
        const diagnostics = record.diagnostics && typeof record.diagnostics === "object"
            ? record.diagnostics
            : undefined;
        const createdAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : Date.now();
        const attempts = typeof record.attempts === "number" && Number.isFinite(record.attempts) ? Math.max(0, Math.round(record.attempts)) : 0;
        const nextRetryAt = typeof record.nextRetryAt === "number" && Number.isFinite(record.nextRetryAt)
            ? Math.max(0, Math.round(record.nextRetryAt))
            : 0;
        return {
            id,
            category,
            message,
            contactEmail,
            diagnostics,
            createdAt,
            attempts,
            nextRetryAt,
        };
    };
    const loadFeedbackQueue = () => {
        const raw = localStorage.getItem(runtime.keys.feedbackQueueKey);
        if (!raw) {
            runtime.state.feedbackQueue = [];
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                runtime.state.feedbackQueue = [];
                return;
            }
            runtime.state.feedbackQueue = parsed
                .map((entry) => normalizeFeedbackQueueItem(entry))
                .filter((entry) => Boolean(entry));
            saveFeedbackQueue();
        }
        catch {
            runtime.state.feedbackQueue = [];
        }
    };
    const readFeedbackIncludeDiagnosticsState = () => {
        try {
            const stored = localStorage.getItem(runtime.keys.feedbackIncludeDiagnosticsKey);
            return stored === "true";
        }
        catch {
            return false;
        }
    };
    const saveFeedbackIncludeDiagnosticsState = () => {
        try {
            localStorage.setItem(runtime.keys.feedbackIncludeDiagnosticsKey, runtime.state.feedbackIncludeDiagnostics ? "true" : "false");
        }
        catch {
            // ignore storage failures
        }
    };
    const updateFeedbackIncludeDiagnosticsUi = () => {
        if (settingsFeedbackIncludeDiagnostics instanceof HTMLInputElement) {
            settingsFeedbackIncludeDiagnostics.checked = runtime.state.feedbackIncludeDiagnostics;
        }
    };
    const readErrorReportingEnabledState = () => {
        try {
            const stored = localStorage.getItem(runtime.keys.errorReportingEnabledKey);
            if (stored === null) {
                return true;
            }
            return stored !== "false";
        }
        catch {
            return true;
        }
    };
    const saveErrorReportingEnabledState = () => {
        try {
            localStorage.setItem(runtime.keys.errorReportingEnabledKey, runtime.state.errorReportingEnabled ? "true" : "false");
        }
        catch {
            // ignore storage failures
        }
    };
    const updateErrorReportingUi = () => {
        if (settingsErrorReportingEnabled instanceof HTMLInputElement) {
            settingsErrorReportingEnabled.checked = runtime.state.errorReportingEnabled;
        }
    };
    const syncErrorReportingEnabled = () => {
        runtime.deps.postToNative({
            type: "error:reporting:set",
            enabled: runtime.state.errorReportingEnabled,
        }, true);
    };
    const buildFeedbackDiagnostics = () => {
        var _a;
        if (!runtime.state.feedbackIncludeDiagnostics) {
            return undefined;
        }
        const diagnostics = {
            source: "settings-feedback-form",
            sentAt: new Date().toISOString(),
            appUrl: typeof ((_a = window.location) === null || _a === void 0 ? void 0 : _a.href) === "string" ? window.location.href : "",
            online: typeof (navigator === null || navigator === void 0 ? void 0 : navigator.onLine) === "boolean" ? navigator.onLine : undefined,
            language: typeof (navigator === null || navigator === void 0 ? void 0 : navigator.language) === "string" ? navigator.language : undefined,
            userAgent: typeof (navigator === null || navigator === void 0 ? void 0 : navigator.userAgent) === "string" ? navigator.userAgent : undefined,
        };
        if (Array.isArray(navigator === null || navigator === void 0 ? void 0 : navigator.languages) && navigator.languages.length > 0) {
            diagnostics.languages = navigator.languages.slice(0, 8);
        }
        return diagnostics;
    };
    const computeFeedbackRetryDelayMs = (attempts) => {
        const safeAttempts = Math.max(1, Math.round(attempts));
        const baseMs = 5000;
        return Math.min(1000 * 60 * 5, baseMs * 2 ** Math.min(7, safeAttempts - 1));
    };
    const scheduleFeedbackFlush = (delayMs = 0) => {
        if (runtime.state.feedbackFlushTimer !== null) {
            window.clearTimeout(runtime.state.feedbackFlushTimer);
            runtime.state.feedbackFlushTimer = null;
        }
        runtime.state.feedbackFlushTimer = window.setTimeout(() => {
            runtime.state.feedbackFlushTimer = null;
            flushFeedbackQueue();
        }, Math.max(0, Math.round(delayMs)));
    };
    const removeFeedbackQueueItem = (itemId) => {
        if (!itemId) {
            return null;
        }
        const index = runtime.state.feedbackQueue.findIndex((entry) => entry.id === itemId);
        if (index < 0) {
            return null;
        }
        const [removed] = runtime.state.feedbackQueue.splice(index, 1);
        saveFeedbackQueue();
        return removed !== null && removed !== void 0 ? removed : null;
    };
    const markFeedbackRetry = (item, baseMessage) => {
        item.attempts = Math.max(0, item.attempts) + 1;
        const delayMs = computeFeedbackRetryDelayMs(item.attempts);
        item.nextRetryAt = Date.now() + delayMs;
        saveFeedbackQueue();
        const seconds = Math.max(1, Math.round(delayMs / 1000));
        const prefix = typeof baseMessage === "string" && baseMessage.trim()
            ? baseMessage.trim()
            : "Failed to send feedback. I will resend it.";
        setFeedbackStatus(`${prefix} (retry after ${seconds} seconds)`, "error");
        scheduleFeedbackFlush(delayMs + 60);
    };
    const flushFeedbackQueue = () => {
        if (runtime.state.feedbackPending) {
            return;
        }
        if (runtime.state.feedbackQueue.length === 0) {
            return;
        }
        const now = Date.now();
        let nextItem = null;
        for (const entry of runtime.state.feedbackQueue) {
            if (entry.nextRetryAt <= now) {
                nextItem = entry;
                break;
            }
        }
        if (!nextItem) {
            const nextRetryAt = runtime.state.feedbackQueue.reduce((min, entry) => {
                if (!Number.isFinite(entry.nextRetryAt) || entry.nextRetryAt <= 0) {
                    return min;
                }
                return Math.min(min, entry.nextRetryAt);
            }, Number.POSITIVE_INFINITY);
            if (Number.isFinite(nextRetryAt)) {
                scheduleFeedbackFlush(Math.max(250, nextRetryAt - now));
            }
            return;
        }
        runtime.state.feedbackPending = true;
        runtime.state.feedbackInFlightId = nextItem.id;
        updateFeedbackSendState();
        setFeedbackStatus("Submitting feedback...");
        const posted = runtime.deps.postToNative({
            type: "feedback:send",
            category: nextItem.category,
            message: nextItem.message,
            contactEmail: nextItem.contactEmail || undefined,
            diagnostics: nextItem.diagnostics || undefined,
        }, true);
        if (!posted) {
            runtime.state.feedbackPending = false;
            runtime.state.feedbackInFlightId = null;
            updateFeedbackSendState();
            markFeedbackRetry(nextItem, "Failed to start sending feedback.");
        }
    };
    const sendFeedback = () => {
        if (!(settingsFeedbackMessage instanceof HTMLTextAreaElement)) {
            return;
        }
        const message = settingsFeedbackMessage.value.trim();
        if (!message) {
            setFeedbackStatus("Please enter your feedback.", "error");
            settingsFeedbackMessage.focus();
            return;
        }
        const rawCategory = settingsFeedbackCategory instanceof HTMLSelectElement ? settingsFeedbackCategory.value : "";
        const category = rawCategory === "bug" || rawCategory === "idea" || rawCategory === "other" ? rawCategory : "other";
        const contactEmail = settingsFeedbackEmail instanceof HTMLInputElement ? settingsFeedbackEmail.value.trim() : "";
        if (contactEmail && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(contactEmail)) {
            setFeedbackStatus("Please check the format of your contact email address.", "error");
            settingsFeedbackEmail.focus();
            return;
        }
        const item = {
            id: `fb-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
            category,
            message,
            contactEmail: contactEmail || undefined,
            diagnostics: buildFeedbackDiagnostics(),
            createdAt: Date.now(),
            attempts: 0,
            nextRetryAt: 0,
        };
        runtime.state.feedbackQueue.push(item);
        saveFeedbackQueue();
        setFeedbackStatus("Added to send queue.");
        flushFeedbackQueue();
    };
    const handlePlatformFeedback = (payload) => {
        var _a, _b;
        const inFlightId = runtime.state.feedbackInFlightId;
        const inFlightItem = inFlightId !== null
            ? (_a = runtime.state.feedbackQueue.find((entry) => entry.id === inFlightId)) !== null && _a !== void 0 ? _a : null
            : null;
        runtime.state.feedbackPending = false;
        runtime.state.feedbackInFlightId = null;
        updateFeedbackSendState();
        if (payload === null || payload === void 0 ? void 0 : payload.ok) {
            const removed = removeFeedbackQueueItem(inFlightId);
            if (removed &&
                settingsFeedbackMessage instanceof HTMLTextAreaElement &&
                settingsFeedbackMessage.value.trim() === removed.message) {
                settingsFeedbackMessage.value = "";
            }
            const suffix = payload.feedbackId ? ` (ID: ${payload.feedbackId})` : "";
            const remainCount = runtime.state.feedbackQueue.length;
            const remainLabel = remainCount > 0 ? ` We are waiting for the remaining ${remainCount} items to be resent.` : "";
            setFeedbackStatus(`Submitted feedback${suffix}${remainLabel}`, "success");
            scheduleFeedbackFlush(40);
            return;
        }
        const message = ((_b = payload === null || payload === void 0 ? void 0 : payload.error) === null || _b === void 0 ? void 0 : _b.message) && payload.error.message.trim()
            ? payload.error.message.trim()
            : "Failed to send feedback.";
        if (inFlightItem) {
            markFeedbackRetry(inFlightItem, `${message} Saved in retransmission queue.`);
            return;
        }
        setFeedbackStatus(message, "error");
    };
    const loadStartupFeedbackState = () => {
        loadFeedbackQueue();
        runtime.state.feedbackIncludeDiagnostics = readFeedbackIncludeDiagnosticsState();
        updateFeedbackIncludeDiagnosticsUi();
        runtime.state.errorReportingEnabled = readErrorReportingEnabledState();
        updateErrorReportingUi();
        syncErrorReportingEnabled();
        if (runtime.state.feedbackQueue.length > 0) {
            scheduleFeedbackFlush(200);
        }
    };
    const initFeedbackUi = () => {
        updateFeedbackSendState();
        setFeedbackStatus("");
        updateFeedbackIncludeDiagnosticsUi();
        updateErrorReportingUi();
    };
    if (settingsFeedbackSend instanceof HTMLButtonElement) {
        settingsFeedbackSend.addEventListener("click", () => {
            sendFeedback();
        });
    }
    if (settingsFeedbackMessage instanceof HTMLTextAreaElement) {
        settingsFeedbackMessage.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                sendFeedback();
            }
        });
    }
    if (settingsFeedbackIncludeDiagnostics instanceof HTMLInputElement) {
        settingsFeedbackIncludeDiagnostics.addEventListener("change", () => {
            runtime.state.feedbackIncludeDiagnostics = settingsFeedbackIncludeDiagnostics.checked;
            saveFeedbackIncludeDiagnosticsState();
            updateFeedbackIncludeDiagnosticsUi();
        });
    }
    if (settingsErrorReportingEnabled instanceof HTMLInputElement) {
        settingsErrorReportingEnabled.addEventListener("change", () => {
            runtime.state.errorReportingEnabled = settingsErrorReportingEnabled.checked;
            saveErrorReportingEnabledState();
            updateErrorReportingUi();
            syncErrorReportingEnabled();
        });
    }
    window.addEventListener("online", () => {
        scheduleFeedbackFlush(120);
    });
    return {
        handlePlatformFeedback,
        loadStartupFeedbackState,
        initFeedbackUi,
    };
};
