export const initFeedbackModal = (context, deps) => {
    const { feedbackTab, feedbackModal, feedbackModalMessage, feedbackModalSend, feedbackModalCancel, feedbackModalStatus, } = context.dom;
    let isOpen = false;
    let focusReturn = null;
    if (feedbackModal instanceof HTMLElement)
        feedbackModal.inert = true;
    const setStatus = (message, tone = "neutral") => {
        if (!(feedbackModalStatus instanceof HTMLElement)) {
            return;
        }
        feedbackModalStatus.textContent = message;
        feedbackModalStatus.classList.toggle("is-hidden", message.trim().length === 0);
        feedbackModalStatus.classList.toggle("is-error", tone === "error");
        feedbackModalStatus.classList.toggle("is-success", tone === "success");
    };
    const close = () => {
        var _a;
        if (!(feedbackModal instanceof HTMLElement)) {
            return;
        }
        isOpen = false;
        (_a = ((focusReturn === null || focusReturn === void 0 ? void 0 : focusReturn.isConnected) ? focusReturn : feedbackTab)) === null || _a === void 0 ? void 0 : _a.focus();
        focusReturn = null;
        feedbackModal.inert = true;
        feedbackModal.classList.remove("is-open");
        feedbackModal.setAttribute("aria-hidden", "true");
    };
    const open = () => {
        if (!(feedbackModal instanceof HTMLElement)) {
            return;
        }
        if (!isOpen)
            focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : feedbackTab;
        isOpen = true;
        feedbackModal.inert = false;
        feedbackModal.classList.add("is-open");
        feedbackModal.setAttribute("aria-hidden", "false");
        setStatus("");
        if (feedbackModalMessage instanceof HTMLTextAreaElement) {
            feedbackModalMessage.focus();
        }
    };
    const send = () => {
        const message = feedbackModalMessage instanceof HTMLTextAreaElement ? feedbackModalMessage.value : "";
        // Category was removed from the UI; submit everything as general feedback.
        const queued = deps.submitFeedback("other", message, (delivery) => {
            if (delivery === "delivered" && feedbackModalMessage instanceof HTMLTextAreaElement && feedbackModalMessage.value === message) {
                feedbackModalMessage.value = "";
            }
        });
        if (!queued && feedbackModalMessage instanceof HTMLTextAreaElement) {
            feedbackModalMessage.focus();
        }
    };
    if (feedbackTab instanceof HTMLElement) {
        feedbackTab.addEventListener("click", open);
    }
    if (feedbackModalSend instanceof HTMLButtonElement) {
        feedbackModalSend.addEventListener("click", send);
    }
    if (feedbackModalCancel instanceof HTMLButtonElement) {
        feedbackModalCancel.addEventListener("click", close);
    }
    if (feedbackModal instanceof HTMLElement) {
        feedbackModal.addEventListener("keydown", (event) => {
            if (event.key !== "Tab")
                return;
            const controls = Array.from(feedbackModal.querySelectorAll("button:enabled, textarea:enabled"));
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last === null || last === void 0 ? void 0 : last.focus();
            }
            else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first === null || first === void 0 ? void 0 : first.focus();
            }
        });
        // Click on the backdrop (outside the card) closes the modal.
        feedbackModal.addEventListener("mousedown", (event) => {
            if (event.target === feedbackModal) {
                close();
            }
        });
    }
    if (feedbackModalMessage instanceof HTMLTextAreaElement) {
        feedbackModalMessage.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                send();
            }
        });
    }
    document.addEventListener("keydown", (event) => {
        if (isOpen && event.key === "Escape") {
            close();
        }
    });
    // The queue also carries feedback from other screens. Only this form's delivery may clear its draft.
    deps.onFeedbackStatus((status) => {
        if (!isOpen) {
            return;
        }
        if (status.tone === "success") {
            setStatus("");
            return;
        }
        setStatus(status.message, status.tone);
    });
    return { open, close };
};
