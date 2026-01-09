export const initCaptureUi = (context, deps = {}) => {
    const { captureWindowModal, captureWindowCancel, captureWindowSearch, captureWindowGrid, captureWindowItemTemplate, captureWindowShortcut, captureCropModal, captureCropRetry, captureCropCancel, captureCropApply, captureCropImage, captureCropSize, } = context.dom;
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
        if (!(captureWindowGrid instanceof HTMLElement)) {
            return;
        }
        captureWindowGrid.textContent = "";
        const template = captureWindowItemTemplate instanceof HTMLTemplateElement
            ? captureWindowItemTemplate
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
            captureWindowGrid.appendChild(fragment);
        });
    };
    const openWindowPicker = (nextSources, nextSelected) => {
        sources = nextSources;
        selectedId = nextSelected !== null && nextSelected !== void 0 ? nextSelected : null;
        searchText = "";
        if (captureWindowSearch instanceof HTMLInputElement) {
            captureWindowSearch.value = "";
        }
        renderSources();
        setModalOpen(captureWindowModal, true);
    };
    const closeWindowPicker = () => {
        setModalOpen(captureWindowModal, false);
    };
    const openCropper = (options) => {
        if (captureCropImage instanceof HTMLImageElement && (options === null || options === void 0 ? void 0 : options.imageUrl)) {
            captureCropImage.src = options.imageUrl;
        }
        if (captureCropSize instanceof HTMLElement && (options === null || options === void 0 ? void 0 : options.sizeLabel)) {
            captureCropSize.textContent = options.sizeLabel;
        }
        setModalOpen(captureCropModal, true);
    };
    const closeCropper = () => {
        setModalOpen(captureCropModal, false);
    };
    const setShortcutLabel = (label) => {
        if (captureWindowShortcut instanceof HTMLElement) {
            captureWindowShortcut.textContent = label;
        }
    };
    const setCropSizeLabel = (label) => {
        if (captureCropSize instanceof HTMLElement) {
            captureCropSize.textContent = label;
        }
    };
    if (captureWindowSearch instanceof HTMLInputElement) {
        captureWindowSearch.addEventListener("input", () => {
            searchText = captureWindowSearch.value.trim();
            renderSources();
        });
    }
    if (captureWindowGrid instanceof HTMLElement) {
        captureWindowGrid.addEventListener("click", (event) => {
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
    if (captureWindowCancel instanceof HTMLElement) {
        captureWindowCancel.addEventListener("click", () => {
            var _a;
            closeWindowPicker();
            (_a = handlers.onWindowCancel) === null || _a === void 0 ? void 0 : _a.call(handlers);
        });
    }
    if (captureCropRetry instanceof HTMLElement) {
        captureCropRetry.addEventListener("click", () => {
            var _a;
            closeCropper();
            (_a = handlers.onCropRetry) === null || _a === void 0 ? void 0 : _a.call(handlers);
        });
    }
    if (captureCropCancel instanceof HTMLElement) {
        captureCropCancel.addEventListener("click", () => {
            var _a;
            closeCropper();
            (_a = handlers.onCropCancel) === null || _a === void 0 ? void 0 : _a.call(handlers);
        });
    }
    if (captureCropApply instanceof HTMLElement) {
        captureCropApply.addEventListener("click", () => {
            var _a;
            (_a = handlers.onCropApply) === null || _a === void 0 ? void 0 : _a.call(handlers);
        });
    }
    return {
        openWindowPicker,
        closeWindowPicker,
        openCropper,
        closeCropper,
        setShortcutLabel,
        setCropSizeLabel,
        setHandlers: (next) => {
            handlers = { ...handlers, ...next };
        },
    };
};
