import { getUiLocale, uiText } from "./i18n.js";
const renderBodyInto = (host, body) => {
    host.replaceChildren();
    if (!body)
        return;
    const lines = body.split(/\r?\n/);
    lines.forEach((line, index) => {
        host.appendChild(document.createTextNode(line));
        if (index < lines.length - 1) {
            host.appendChild(document.createElement("br"));
        }
    });
};
// API may deliver title/body either as a plain string or as a locale-keyed
// object: { en: "...", ja: "..." }. The Electron-side sanitizer keeps both
// forms intact; we resolve the active locale here.
const resolveLocalized = (value) => {
    var _a;
    if (typeof value === "string")
        return value;
    if (!value || typeof value !== "object")
        return "";
    const locale = getUiLocale();
    const direct = value[locale];
    if (typeof direct === "string" && direct.trim())
        return direct;
    const fallback = (_a = value.en) !== null && _a !== void 0 ? _a : value.ja;
    return typeof fallback === "string" ? fallback : "";
};
export const initAnnouncementsUi = (deps) => {
    const modal = document.getElementById("announcement-modal");
    const titleEl = document.getElementById("announcement-modal-title");
    const bodyEl = document.getElementById("announcement-modal-body");
    const closeBtn = document.getElementById("announcement-modal-close");
    const linkBtn = document.getElementById("announcement-modal-link");
    const submitBtn = document.getElementById("announcement-modal-submit");
    const inputWrap = document.getElementById("announcement-modal-input-wrap");
    const inputEl = document.getElementById("announcement-modal-input");
    const statusEl = document.getElementById("announcement-modal-status");
    const queue = [];
    const seenInThisSession = new Set();
    let activeId = null;
    let activeKind = "info";
    let isOpen = false;
    let isSubmitting = false;
    const setStatus = (message, tone = "") => {
        if (!(statusEl instanceof HTMLElement))
            return;
        statusEl.textContent = message;
        statusEl.classList.toggle("is-error", tone === "error");
        statusEl.classList.toggle("is-success", tone === "success");
    };
    const setInputMode = (enabled) => {
        if (inputWrap instanceof HTMLElement) {
            inputWrap.classList.toggle("is-hidden", !enabled);
            inputWrap.setAttribute("aria-hidden", enabled ? "false" : "true");
        }
        if (submitBtn instanceof HTMLButtonElement) {
            submitBtn.classList.toggle("is-hidden", !enabled);
            submitBtn.setAttribute("aria-hidden", enabled ? "false" : "true");
            submitBtn.disabled = false;
        }
        if (inputEl instanceof HTMLTextAreaElement) {
            inputEl.value = "";
            inputEl.disabled = false;
        }
        setStatus("");
    };
    const setLinkButton = (url, label) => {
        if (!(linkBtn instanceof HTMLButtonElement))
            return;
        if (url) {
            linkBtn.textContent =
                label && label.trim() ? label : uiText("Open details", "詳細を開く");
            linkBtn.dataset.url = url;
            linkBtn.classList.remove("is-hidden");
            linkBtn.setAttribute("aria-hidden", "false");
        }
        else {
            linkBtn.textContent = "";
            delete linkBtn.dataset.url;
            linkBtn.classList.add("is-hidden");
            linkBtn.setAttribute("aria-hidden", "true");
        }
    };
    const hide = () => {
        if (!modal)
            return;
        modal.classList.remove("is-open");
        modal.setAttribute("aria-hidden", "true");
        isOpen = false;
        activeId = null;
        activeKind = "info";
        isSubmitting = false;
        setInputMode(false);
        setLinkButton(null, null);
    };
    const showNext = () => {
        if (isOpen ||
            !(modal instanceof HTMLElement) ||
            !(titleEl instanceof HTMLElement) ||
            !(bodyEl instanceof HTMLElement)) {
            return;
        }
        const next = queue.shift();
        if (!next)
            return;
        activeId = next.id;
        activeKind = next.kind;
        const resolvedTitle = resolveLocalized(next.title);
        const resolvedBody = resolveLocalized(next.body);
        titleEl.textContent = resolvedTitle || uiText("Notice", "お知らせ");
        renderBodyInto(bodyEl, resolvedBody);
        const isFeedback = next.kind === "feedback";
        setInputMode(isFeedback);
        setLinkButton(isFeedback ? null : next.url, resolveLocalized(next.urlLabel));
        modal.classList.add("is-open");
        modal.setAttribute("aria-hidden", "false");
        isOpen = true;
        if (isFeedback && inputEl instanceof HTMLTextAreaElement) {
            inputEl.focus();
        }
        else if (closeBtn instanceof HTMLButtonElement) {
            closeBtn.focus();
        }
    };
    const persistDismiss = (id) => {
        deps.postToNative({ type: "announcement:dismiss", id }, true);
    };
    const closeAndDismiss = () => {
        if (isSubmitting)
            return;
        if (activeId) {
            persistDismiss(activeId);
        }
        hide();
        showNext();
    };
    const submitFeedback = () => {
        if (isSubmitting || !(inputEl instanceof HTMLTextAreaElement))
            return;
        const message = inputEl.value.trim();
        if (!message) {
            setStatus(uiText("Please enter your feedback.", "フィードバック内容を入力してください。"), "error");
            inputEl.focus();
            return;
        }
        isSubmitting = true;
        if (submitBtn instanceof HTMLButtonElement)
            submitBtn.disabled = true;
        inputEl.disabled = true;
        setStatus(uiText("Sending...", "送信中..."));
        deps.postToNative({ type: "feedback:send", category: "general", message }, true);
        // We don't wait for the platform:feedback ack here — the queued
        // pipeline in feedback-ops will retry on failure. Dismiss immediately
        // so the modal never reappears for this announcement.
        if (activeId)
            persistDismiss(activeId);
        setStatus(uiText("Thanks for sharing your feedback.", "送信しました。ご協力ありがとうございます。"), "success");
        window.setTimeout(() => {
            hide();
            showNext();
        }, 900);
    };
    if (closeBtn instanceof HTMLButtonElement) {
        closeBtn.addEventListener("click", () => closeAndDismiss());
    }
    if (linkBtn instanceof HTMLButtonElement) {
        linkBtn.addEventListener("click", () => {
            const url = linkBtn.dataset.url;
            if (typeof url === "string" && url) {
                deps.postToNative({ type: "shell:openExternal", url }, true);
            }
            closeAndDismiss();
        });
    }
    if (submitBtn instanceof HTMLButtonElement) {
        submitBtn.addEventListener("click", () => submitFeedback());
    }
    if (inputEl instanceof HTMLTextAreaElement) {
        inputEl.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submitFeedback();
            }
        });
    }
    if (modal instanceof HTMLElement) {
        modal.addEventListener("click", (event) => {
            if (event.target === modal)
                closeAndDismiss();
        });
    }
    document.addEventListener("keydown", (event) => {
        if (!isOpen)
            return;
        if (event.key === "Escape") {
            event.preventDefault();
            closeAndDismiss();
        }
    });
    const handleAnnouncements = (payload) => {
        const incoming = Array.isArray(payload === null || payload === void 0 ? void 0 : payload.announcements) ? payload.announcements : [];
        incoming.forEach((entry) => {
            if (!entry || typeof entry.id !== "string" || !entry.id)
                return;
            if (seenInThisSession.has(entry.id))
                return;
            if (activeId === entry.id)
                return;
            seenInThisSession.add(entry.id);
            queue.push(entry);
        });
        showNext();
    };
    return { handleAnnouncements };
};
