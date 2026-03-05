import { getFormatLabel, getFormatShortLabel, loadMathInsertSettings, saveMathDisplayWrap, saveMathInlineWrap, saveMathInsertMode, } from "../input-ui-settings.js";
export const createBlockInsertSettingsOps = (runtime) => {
    const { blockFormatButton, blockFormatMenu, blockFormatOptions, blockSettingsInlineOptions, blockSettingsDisplayOptions, } = runtime.context.dom;
    const setFormatMenuOpen = (open) => {
        runtime.state.formatMenuOpen = open;
        if (blockFormatMenu instanceof HTMLElement) {
            blockFormatMenu.classList.toggle("is-open", open);
            blockFormatMenu.setAttribute("aria-hidden", open ? "false" : "true");
        }
        if (blockFormatButton instanceof HTMLElement) {
            blockFormatButton.setAttribute("aria-expanded", open ? "true" : "false");
        }
    };
    const setMathInsertMode = (value) => {
        runtime.state.mathInsertMode = value;
        if (blockFormatButton instanceof HTMLElement) {
            const fullLabel = getFormatLabel(value);
            blockFormatButton.textContent = getFormatShortLabel(value);
            blockFormatButton.setAttribute("title", fullLabel);
            blockFormatButton.setAttribute("aria-label", `挿入形式: ${fullLabel}`);
        }
        if (Array.isArray(blockFormatOptions)) {
            blockFormatOptions.forEach((option) => {
                const isActive = option.dataset.format === value;
                option.classList.toggle("is-active", isActive);
                option.setAttribute("aria-selected", isActive ? "true" : "false");
            });
        }
        saveMathInsertMode(value);
    };
    const setMathInlineWrap = (value) => {
        runtime.state.mathInlineWrap = value;
        if (Array.isArray(blockSettingsInlineOptions)) {
            blockSettingsInlineOptions.forEach((option) => {
                const isActive = option.dataset.inlineFormat === value;
                option.classList.toggle("is-active", isActive);
                option.setAttribute("aria-pressed", isActive ? "true" : "false");
            });
        }
        saveMathInlineWrap(value);
    };
    const setMathDisplayWrap = (value) => {
        runtime.state.mathDisplayWrap = value;
        if (Array.isArray(blockSettingsDisplayOptions)) {
            blockSettingsDisplayOptions.forEach((option) => {
                const isActive = option.dataset.displayFormat === value;
                option.classList.toggle("is-active", isActive);
                option.setAttribute("aria-pressed", isActive ? "true" : "false");
            });
        }
        saveMathDisplayWrap(value);
    };
    const applyMathInsertSettings = () => {
        const resolved = loadMathInsertSettings({
            mode: runtime.state.mathInsertMode,
            inlineWrap: runtime.state.mathInlineWrap,
            displayWrap: runtime.state.mathDisplayWrap,
        });
        setMathInsertMode(resolved.mode);
        setMathInlineWrap(resolved.inlineWrap);
        setMathDisplayWrap(resolved.displayWrap);
    };
    if (Array.isArray(blockSettingsInlineOptions)) {
        blockSettingsInlineOptions.forEach((option) => {
            option.addEventListener("click", () => {
                const next = option.dataset.inlineFormat;
                if (!next) {
                    return;
                }
                setMathInlineWrap(next);
            });
        });
    }
    if (Array.isArray(blockSettingsDisplayOptions)) {
        blockSettingsDisplayOptions.forEach((option) => {
            option.addEventListener("click", () => {
                const next = option.dataset.displayFormat;
                if (!next) {
                    return;
                }
                setMathDisplayWrap(next);
            });
        });
    }
    if (blockFormatButton instanceof HTMLButtonElement) {
        blockFormatButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            setFormatMenuOpen(!runtime.state.formatMenuOpen);
        });
    }
    if (blockFormatMenu instanceof HTMLElement) {
        blockFormatMenu.addEventListener("click", (event) => {
            var _a;
            const target = (_a = event.target) === null || _a === void 0 ? void 0 : _a.closest(".block-format-option");
            if (!target) {
                return;
            }
            const nextFormat = target.dataset.format;
            if (!nextFormat) {
                return;
            }
            setMathInsertMode(nextFormat);
            setFormatMenuOpen(false);
        });
    }
    document.addEventListener("click", (event) => {
        if (!runtime.state.formatMenuOpen) {
            return;
        }
        const target = event.target;
        if ((blockFormatButton === null || blockFormatButton === void 0 ? void 0 : blockFormatButton.contains(target)) || (blockFormatMenu === null || blockFormatMenu === void 0 ? void 0 : blockFormatMenu.contains(target))) {
            return;
        }
        setFormatMenuOpen(false);
    });
    return { setFormatMenuOpen, setMathInsertMode, setMathInlineWrap, setMathDisplayWrap, applyMathInsertSettings };
};
