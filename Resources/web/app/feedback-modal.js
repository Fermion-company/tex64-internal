export const initFeedbackModal = (context, deps) => {
    const { feedbackTab, feedbackModal, feedbackModalMessage, feedbackModalSend, feedbackModalCancel, feedbackModalStatus, } = context.dom;
    let isOpen = false;
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
        if (!(feedbackModal instanceof HTMLElement)) {
            return;
        }
        isOpen = false;
        feedbackModal.classList.remove("is-open");
        feedbackModal.setAttribute("aria-hidden", "true");
    };
    const open = () => {
        if (!(feedbackModal instanceof HTMLElement)) {
            return;
        }
        isOpen = true;
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
        if (!deps.submitFeedback("other", message) && feedbackModalMessage instanceof HTMLTextAreaElement) {
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
    // Mirror the shared queue's status while the modal is open; clear the field on
    // a successful send.
    deps.onFeedbackStatus((status) => {
        if (!isOpen) {
            return;
        }
        setStatus(status.message, status.tone);
        if (status.tone === "success" && feedbackModalMessage instanceof HTMLTextAreaElement) {
            feedbackModalMessage.value = "";
        }
    });
    return { open, close };
};
