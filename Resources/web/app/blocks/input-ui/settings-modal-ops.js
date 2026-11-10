export const createBlockSettingsModalOps = (runtime) => {
    const { blockSettingsButton, blockCaptureButton, blockSettingsModal, blockSettingsClose, } = runtime.context.dom;
    const setBlockSettingsOpen = (open) => {
        runtime.state.blockSettingsOpen = open;
        if (blockSettingsModal instanceof HTMLElement) {
            blockSettingsModal.classList.toggle("is-open", open);
            blockSettingsModal.setAttribute("aria-hidden", open ? "false" : "true");
        }
        if (blockSettingsButton instanceof HTMLElement) {
            blockSettingsButton.setAttribute("aria-expanded", open ? "true" : "false");
        }
    };
    if (blockSettingsButton instanceof HTMLButtonElement) {
        blockSettingsButton.addEventListener("click", () => {
            setBlockSettingsOpen(!runtime.state.blockSettingsOpen);
        });
    }
    if (blockCaptureButton instanceof HTMLButtonElement) {
        blockCaptureButton.addEventListener("click", () => {
            var _a, _b;
            (_b = (_a = runtime.deps).onMathCaptureRequest) === null || _b === void 0 ? void 0 : _b.call(_a);
        });
    }
    if (blockSettingsClose instanceof HTMLButtonElement) {
        blockSettingsClose.addEventListener("click", () => {
            setBlockSettingsOpen(false);
        });
    }
    if (blockSettingsModal instanceof HTMLElement) {
        blockSettingsModal.addEventListener("click", (event) => {
            if (event.target === blockSettingsModal) {
                setBlockSettingsOpen(false);
            }
        });
    }
    return { setBlockSettingsOpen };
};
