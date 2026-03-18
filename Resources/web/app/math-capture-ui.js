export const initMathCaptureUi = (context, deps = {}) => {
    const { mathCaptureWindowModal, mathCaptureWindowCancel, mathCaptureWindowSearch, mathCaptureWindowGrid, mathCaptureWindowItemTemplate, mathCaptureCropModal, mathCaptureCropRetry, mathCaptureCropCancel, mathCaptureCropApply, mathCaptureCropImage, mathCaptureCropSize, capturePermissionModal, capturePermissionOpen, capturePermissionRetry, capturePermissionClose, } = context.dom;
    let sources = [];
    let selectedId = null;
    let searchText = "";
    let handlers = { ...deps };
    const setModalOpen = (modal, open) => {
        if (!modal)
            return;
        modal.classList.toggle("is-open", open);
        modal.setAttribute("aria-hidden", open ? "false" : "true");
    };
    const renderSources = () => {
        if (!(mathCaptureWindowGrid instanceof HTMLElement)) {
            return;
        }
        mathCaptureWindowGrid.textContent = "";
        const template = mathCaptureWindowItemTemplate instanceof HTMLTemplateElement
            ? mathCaptureWindowItemTemplate
            : null;
        if (!template) {
            return;
        }
        const filtered = sources.filter((source) => {
            var _a;
            if (!searchText)
                return true;
            const key = `${source.title} ${(_a = source.app) !== null && _a !== void 0 ? _a : ""}`.toLowerCase();
            return key.includes(searchText.toLowerCase());
        });
        filtered.forEach((source) => {
            var _a;
            const fragment = template.content.cloneNode(true);
            const root = fragment.querySelector(".capture-window-item");
            if (!root)
                return;
            root.dataset.id = source.id;
            if (source.id === selectedId) {
                root.classList.add("is-active");
            }
            const titleEl = root.querySelector(".capture-window-title");
            if (titleEl)
                titleEl.textContent = source.title;
            const appEl = root.querySelector(".capture-window-app");
            if (appEl)
                appEl.textContent = (_a = source.app) !== null && _a !== void 0 ? _a : "";
            const thumb = root.querySelector(".capture-window-thumb");
            if (thumb && source.thumbnailUrl) {
                thumb.style.backgroundImage = `url("${source.thumbnailUrl}")`;
                thumb.style.backgroundSize = "cover";
                thumb.style.backgroundPosition = "center";
            }
            mathCaptureWindowGrid.appendChild(fragment);
        });
    };
    const handleWindowPickerKeyDown = (event) => {
        var _a;
        if (event.key === "Escape") {
            event.preventDefault();
            closeWindowPicker();
            (_a = handlers.onWindowCancel) === null || _a === void 0 ? void 0 : _a.call(handlers);
        }
    };
    const openWindowPicker = (nextSources, nextSelected) => {
        sources = nextSources;
        selectedId = nextSelected !== null && nextSelected !== void 0 ? nextSelected : null;
        searchText = "";
        if (mathCaptureWindowSearch instanceof HTMLInputElement) {
            mathCaptureWindowSearch.value = "";
        }
        renderSources();
        setModalOpen(mathCaptureWindowModal, true);
        if (mathCaptureWindowSearch instanceof HTMLInputElement) {
            requestAnimationFrame(() => {
                mathCaptureWindowSearch.focus();
            });
        }
        window.addEventListener("keydown", handleWindowPickerKeyDown);
    };
    const closeWindowPicker = () => {
        setModalOpen(mathCaptureWindowModal, false);
        window.removeEventListener("keydown", handleWindowPickerKeyDown);
    };
    const handleKeyDown = (event) => {
        var _a, _b;
        if (event.key === "Enter") {
            event.preventDefault();
            (_a = handlers.onCropApply) === null || _a === void 0 ? void 0 : _a.call(handlers);
        }
        if (event.key === "Escape") {
            event.preventDefault();
            (_b = handlers.onCropCancel) === null || _b === void 0 ? void 0 : _b.call(handlers);
        }
    };
    const openCropper = (options) => {
        var _a;
        if (mathCaptureCropImage instanceof HTMLImageElement) {
            mathCaptureCropImage.src = (_a = options === null || options === void 0 ? void 0 : options.imageUrl) !== null && _a !== void 0 ? _a : "";
        }
        if (mathCaptureCropSize instanceof HTMLElement && (options === null || options === void 0 ? void 0 : options.sizeLabel)) {
            mathCaptureCropSize.textContent = options.sizeLabel;
        }
        setModalOpen(mathCaptureCropModal, true);
        window.addEventListener("keydown", handleKeyDown);
    };
    const closeCropper = () => {
        setModalOpen(mathCaptureCropModal, false);
        window.removeEventListener("keydown", handleKeyDown);
    };
    const setCropSizeLabel = (label) => {
        if (mathCaptureCropSize instanceof HTMLElement) {
            mathCaptureCropSize.textContent = label;
        }
    };
    const setCropBusy = (busy, message) => {
        if (mathCaptureCropApply instanceof HTMLElement) {
            mathCaptureCropApply.classList.toggle("is-busy", busy);
            mathCaptureCropApply.textContent = busy ? (message !== null && message !== void 0 ? message : "認識中…") : "確定";
            mathCaptureCropApply.disabled = busy;
        }
        if (mathCaptureCropRetry instanceof HTMLElement) {
            mathCaptureCropRetry.disabled = busy;
        }
        if (mathCaptureCropCancel instanceof HTMLElement) {
            mathCaptureCropCancel.disabled = busy;
        }
        // Disable Esc/Enter during processing
        if (busy) {
            window.removeEventListener("keydown", handleKeyDown);
        }
        else {
            window.addEventListener("keydown", handleKeyDown);
        }
    };
    const setCropError = (message) => {
        const hint = context.dom.mathCaptureCropHint;
        if (hint instanceof HTMLElement) {
            hint.textContent = message;
            hint.classList.add("is-error");
            // Auto-clear after 6 seconds
            setTimeout(() => {
                hint.classList.remove("is-error");
                hint.textContent = "";
            }, 6000);
        }
    };
    // Permission guide modal
    const handlePermissionKeyDown = (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            hidePermissionGuide();
        }
    };
    const showPermissionGuide = () => {
        setModalOpen(capturePermissionModal, true);
        window.addEventListener("keydown", handlePermissionKeyDown);
    };
    const hidePermissionGuide = () => {
        setModalOpen(capturePermissionModal, false);
        window.removeEventListener("keydown", handlePermissionKeyDown);
    };
    if (capturePermissionOpen instanceof HTMLElement) {
        capturePermissionOpen.addEventListener("click", () => {
            var _a;
            (_a = handlers.onPermissionOpenSettings) === null || _a === void 0 ? void 0 : _a.call(handlers);
        });
    }
    if (capturePermissionRetry instanceof HTMLElement) {
        capturePermissionRetry.addEventListener("click", () => {
            var _a;
            hidePermissionGuide();
            (_a = handlers.onPermissionRetry) === null || _a === void 0 ? void 0 : _a.call(handlers);
        });
    }
    if (capturePermissionClose instanceof HTMLElement) {
        capturePermissionClose.addEventListener("click", () => {
            hidePermissionGuide();
        });
    }
    if (mathCaptureWindowSearch instanceof HTMLInputElement) {
        mathCaptureWindowSearch.addEventListener("input", () => {
            searchText = mathCaptureWindowSearch.value.trim();
            renderSources();
        });
    }
    if (mathCaptureWindowGrid instanceof HTMLElement) {
        mathCaptureWindowGrid.addEventListener("click", (event) => {
            var _a;
            const target = event.target;
            if (!target)
                return;
            const button = target.closest(".capture-window-item");
            if (!button)
                return;
            const id = button.dataset.id;
            if (!id)
                return;
            selectedId = id;
            renderSources();
            (_a = handlers.onWindowSelect) === null || _a === void 0 ? void 0 : _a.call(handlers, id);
        });
    }
    if (mathCaptureWindowCancel instanceof HTMLElement) {
        mathCaptureWindowCancel.addEventListener("click", () => {
            var _a;
            closeWindowPicker();
            (_a = handlers.onWindowCancel) === null || _a === void 0 ? void 0 : _a.call(handlers);
        });
    }
    if (mathCaptureCropRetry instanceof HTMLElement) {
        mathCaptureCropRetry.addEventListener("click", () => {
            var _a;
            closeCropper();
            (_a = handlers.onCropRetry) === null || _a === void 0 ? void 0 : _a.call(handlers);
        });
    }
    if (mathCaptureCropCancel instanceof HTMLElement) {
        mathCaptureCropCancel.addEventListener("click", () => {
            var _a;
            closeCropper();
            (_a = handlers.onCropCancel) === null || _a === void 0 ? void 0 : _a.call(handlers);
        });
    }
    if (mathCaptureCropApply instanceof HTMLElement) {
        mathCaptureCropApply.addEventListener("click", () => {
            var _a;
            (_a = handlers.onCropApply) === null || _a === void 0 ? void 0 : _a.call(handlers);
        });
    }
    return {
        openWindowPicker,
        closeWindowPicker,
        openCropper,
        closeCropper,
        setCropSizeLabel,
        setCropBusy,
        setCropError,
        showPermissionGuide,
        hidePermissionGuide,
        setHandlers: (next) => {
            handlers = { ...handlers, ...next };
        },
    };
};
