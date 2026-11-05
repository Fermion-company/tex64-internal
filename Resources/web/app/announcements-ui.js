import { getUiLocale, onUiLocaleChange, uiText } from "./i18n.js";
import { axiomTryText, isAxiomTryAnnouncement, renderAxiomTry } from "./announcement-axiom.js";
const renderBodyInto = (host, body) => {
    host.replaceChildren();
    if (!body)
        return;
    const blocks = body.split(/\r?\n\s*\r?\n/).filter((block) => block.trim());
    blocks.forEach((block) => {
        const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const isList = lines.length > 0 && lines.every((line) => /^[•-]\s+/.test(line));
        if (isList) {
            const list = document.createElement("ul");
            lines.forEach((line) => {
                const item = document.createElement("li");
                item.textContent = line.replace(/^[•-]\s+/, "");
                list.appendChild(item);
            });
            host.appendChild(list);
            return;
        }
        const paragraph = document.createElement("p");
        lines.forEach((line, index) => {
            paragraph.appendChild(document.createTextNode(line));
            if (index < lines.length - 1)
                paragraph.appendChild(document.createElement("br"));
        });
        host.appendChild(paragraph);
    });
};
// API may deliver title/body either as a plain string or as a locale-keyed
// object such as { en, ja, zh, ko, fr, de, es }. Pick the active locale,
// fall back to English (the source language), then any other available value.
const resolveLocalized = (value) => {
    if (typeof value === "string")
        return value;
    if (!value || typeof value !== "object")
        return "";
    const locale = getUiLocale();
    const direct = value[locale];
    if (typeof direct === "string" && direct.trim())
        return direct;
    const englishFallback = value.en;
    if (typeof englishFallback === "string" && englishFallback.trim())
        return englishFallback;
    for (const key of Object.keys(value)) {
        const candidate = value[key];
        if (typeof candidate === "string" && candidate.trim())
            return candidate;
    }
    return "";
};
export const initAnnouncementsUi = (deps) => {
    var _a;
    const modal = document.getElementById("announcement-modal");
    const eyebrowEl = document.getElementById("announcement-modal-eyebrow");
    const titleEl = document.getElementById("announcement-modal-title");
    const bodyEl = document.getElementById("announcement-modal-body");
    const closeBtn = document.getElementById("announcement-modal-close");
    const linkBtn = document.getElementById("announcement-modal-link");
    const submitBtn = document.getElementById("announcement-modal-submit");
    const primaryBtn = document.getElementById("announcement-modal-primary");
    const inputWrap = document.getElementById("announcement-modal-input-wrap");
    const inputEl = document.getElementById("announcement-modal-input");
    const statusEl = document.getElementById("announcement-modal-status");
    const card = (_a = modal === null || modal === void 0 ? void 0 : modal.querySelector(".announcement-card")) !== null && _a !== void 0 ? _a : null;
    // A closed announcement keeps its buttons out of the Tab order.
    if (modal instanceof HTMLElement)
        modal.inert = true;
    const queue = [];
    const seenInThisSession = new Set();
    let activeId = null;
    let activeEntry = null;
    let isOpen = false;
    let isSubmitting = false;
    let axiomView = null;
    // Where focus was before the first announcement opened; it goes back there
    // when the last one closes.
    let returnFocus = null;
    // The "Try Axiom" screen: its demo in place of the body, and Open Axiom as
    // the main action (the plans link steps back beside it).
    const setAxiomTemplate = (entry) => {
        axiomView === null || axiomView === void 0 ? void 0 : axiomView.stop();
        axiomView = null;
        const enabled = isAxiomTryAnnouncement(entry);
        if (modal instanceof HTMLElement) {
            if (enabled)
                modal.dataset.template = "axiom-try";
            else
                delete modal.dataset.template;
        }
        if (primaryBtn instanceof HTMLButtonElement) {
            primaryBtn.textContent = enabled ? axiomTryText.openAxiom() : "";
            primaryBtn.classList.toggle("is-hidden", !enabled);
            primaryBtn.setAttribute("aria-hidden", enabled ? "false" : "true");
        }
        if (!enabled || !entry || !(bodyEl instanceof HTMLElement))
            return;
        const paragraphs = resolveLocalized(entry.body).split(/\r?\n\s*\r?\n/).map((block) => block.trim()).filter(Boolean);
        axiomView = renderAxiomTry(paragraphs.slice(1));
        bodyEl.replaceChildren(axiomView.root);
    };
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
        modal.inert = true;
        isOpen = false;
        activeId = null;
        activeEntry = null;
        if (modal instanceof HTMLElement) {
            delete modal.dataset.kind;
        }
        isSubmitting = false;
        setInputMode(false);
        setLinkButton(null, null);
        setAxiomTemplate(null);
    };
    const renderActiveEntry = () => {
        if (!activeEntry ||
            !(titleEl instanceof HTMLElement) ||
            !(bodyEl instanceof HTMLElement)) {
            return;
        }
        const resolvedTitle = resolveLocalized(activeEntry.title);
        const resolvedBody = resolveLocalized(activeEntry.body);
        titleEl.textContent = resolvedTitle || uiText("Notice", "お知らせ");
        renderBodyInto(bodyEl, resolvedBody);
        if (eyebrowEl instanceof HTMLElement) {
            eyebrowEl.textContent =
                activeEntry.kind === "feedback"
                    ? uiText("Help shape TeX64", "TeX64 をより良くする")
                    : activeEntry.kind === "update"
                        ? uiText("What's new in TeX64", "TeX64 の新着情報")
                        : uiText("From TeX64", "TeX64 からのお知らせ");
        }
        setLinkButton(activeEntry.kind === "feedback" ? null : activeEntry.url, resolveLocalized(activeEntry.urlLabel));
        setAxiomTemplate(activeEntry);
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
        activeEntry = next;
        modal.dataset.kind = next.kind;
        renderActiveEntry();
        const isFeedback = next.kind === "feedback";
        setInputMode(isFeedback);
        const focused = document.activeElement;
        if (!returnFocus && focused instanceof HTMLElement && !modal.contains(focused))
            returnFocus = focused;
        modal.inert = false;
        modal.classList.add("is-open");
        modal.setAttribute("aria-hidden", "false");
        isOpen = true;
        if (isFeedback && inputEl instanceof HTMLTextAreaElement) {
            inputEl.focus();
        }
        else if (axiomView && card) {
            // The demo is the point here; a ring on Close would pull the eye away.
            // Focus waits in the dialog itself, and Tab still reaches every control.
            card.tabIndex = -1;
            card.focus();
        }
        else if (closeBtn instanceof HTMLButtonElement) {
            closeBtn.focus();
        }
    };
    const persistDismiss = (id) => {
        deps.postToNative({ type: "announcement:dismiss", id }, true);
    };
    const giveFocusBack = () => {
        const target = returnFocus;
        returnFocus = null;
        if ((target === null || target === void 0 ? void 0 : target.isConnected) && target.getClientRects().length && !target.closest("[inert]")) {
            target.focus({ preventScroll: true });
        }
    };
    // The next queued announcement, or focus back where it was.
    const showNextOrReturn = () => {
        showNext();
        if (!isOpen)
            giveFocusBack();
    };
    const closeAndDismiss = () => {
        if (isSubmitting)
            return;
        if (activeId) {
            persistDismiss(activeId);
        }
        hide();
        showNextOrReturn();
    };
    // Tab and Shift+Tab stay inside the open announcement.
    const keepTabInside = (event) => {
        if (!card)
            return;
        // tabIndex -1 leaves out the card itself and the tabs not selected.
        const items = Array.from(card.querySelectorAll("button, [href], input, textarea, select, [tabindex]")).filter((node) => node.tabIndex >= 0 && !node.matches(":disabled") && node.getClientRects().length > 0 && !node.closest("[hidden]"));
        if (!items.length)
            return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        const inside = active instanceof HTMLElement && active !== card && card.contains(active);
        if (!inside || active === (event.shiftKey ? first : last)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        }
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
            showNextOrReturn();
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
    if (primaryBtn instanceof HTMLButtonElement) {
        primaryBtn.addEventListener("click", () => {
            // Focus goes to the Axiom chat. Another announcement opening now would
            // lose it at once, so the rest stay undismissed for the next check.
            if (activeId)
                persistDismiss(activeId);
            hide();
            returnFocus = null;
            deps.openAxiom();
        });
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
        else if (event.key === "Tab") {
            keepTabInside(event);
        }
    });
    onUiLocaleChange(() => {
        if (isOpen) {
            renderActiveEntry();
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
