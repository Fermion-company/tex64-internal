import { DEFAULT_WYSIWYG_PACKS } from "../../../math/wysiwyg/math-wysiwyg-packs.js";
import { ensureMathWysiwygPacks, loadMathWysiwygSettings, saveMathWysiwygAutoSuggest, saveMathWysiwygPacks, } from "../math-wysiwyg-settings.js";
export const loadInitialMathWysiwygSettings = () => {
    const defaultWysiwygSettings = {
        autoSuggest: true,
        enabledPacks: [...DEFAULT_WYSIWYG_PACKS],
    };
    return loadMathWysiwygSettings(defaultWysiwygSettings);
};
export const createBlockWysiwygSettingsOps = (runtime) => {
    const wysiwygAutoOptions = Array.from(document.querySelectorAll("[data-wysiwyg-auto]"));
    const wysiwygPackOptions = Array.from(document.querySelectorAll("[data-wysiwyg-pack]"));
    const applyMathWysiwygSettings = () => {
        var _a;
        runtime.state.mathWysiwygSettings = {
            ...runtime.state.mathWysiwygSettings,
            enabledPacks: ensureMathWysiwygPacks(runtime.state.mathWysiwygSettings.enabledPacks),
        };
        const enabledPacks = new Set(runtime.state.mathWysiwygSettings.enabledPacks);
        if (Array.isArray(wysiwygAutoOptions)) {
            wysiwygAutoOptions.forEach((button) => {
                const isAuto = button.dataset.wysiwygAuto === "on";
                const isActive = isAuto === runtime.state.mathWysiwygSettings.autoSuggest;
                button.classList.toggle("is-active", isActive);
                button.setAttribute("aria-pressed", isActive ? "true" : "false");
            });
        }
        if (Array.isArray(wysiwygPackOptions)) {
            wysiwygPackOptions.forEach((button) => {
                const packId = button.dataset.wysiwygPack;
                if (!packId) {
                    return;
                }
                const isActive = enabledPacks.has(packId);
                button.classList.toggle("is-active", isActive);
                button.setAttribute("aria-pressed", isActive ? "true" : "false");
            });
        }
        (_a = runtime.state.mathWysiwygApi) === null || _a === void 0 ? void 0 : _a.updateConfig({
            autoSuggest: runtime.state.mathWysiwygSettings.autoSuggest,
            enabledPacks: runtime.state.mathWysiwygSettings.enabledPacks,
        });
    };
    const setMathWysiwygAutoSuggest = (value) => {
        runtime.state.mathWysiwygSettings = {
            ...runtime.state.mathWysiwygSettings,
            autoSuggest: value,
        };
        saveMathWysiwygAutoSuggest(value);
        applyMathWysiwygSettings();
    };
    const toggleMathWysiwygPack = (packId) => {
        const next = new Set(runtime.state.mathWysiwygSettings.enabledPacks);
        if (next.has(packId)) {
            next.delete(packId);
        }
        else {
            next.add(packId);
        }
        const normalized = ensureMathWysiwygPacks(Array.from(next));
        runtime.state.mathWysiwygSettings = {
            ...runtime.state.mathWysiwygSettings,
            enabledPacks: normalized,
        };
        saveMathWysiwygPacks(normalized);
        applyMathWysiwygSettings();
    };
    if (Array.isArray(wysiwygAutoOptions)) {
        wysiwygAutoOptions.forEach((option) => {
            option.addEventListener("click", () => {
                const value = option.dataset.wysiwygAuto;
                if (value === "on") {
                    setMathWysiwygAutoSuggest(true);
                }
                else if (value === "off") {
                    setMathWysiwygAutoSuggest(false);
                }
            });
        });
    }
    if (Array.isArray(wysiwygPackOptions)) {
        wysiwygPackOptions.forEach((option) => {
            option.addEventListener("click", () => {
                const packId = option.dataset.wysiwygPack;
                if (!packId) {
                    return;
                }
                toggleMathWysiwygPack(packId);
            });
        });
    }
    return { applyMathWysiwygSettings, setMathWysiwygAutoSuggest, toggleMathWysiwygPack };
};
