import { getUiLocale, normalizeUiLocale, onUiLocaleChange, setUiLocale } from "../i18n.js";
export const initSettingsUiLocale = (runtime) => {
    const { settingsUiLanguageSelect } = runtime.context.dom;
    const syncUiLocaleSelect = () => {
        if (settingsUiLanguageSelect instanceof HTMLSelectElement) {
            settingsUiLanguageSelect.value = getUiLocale();
        }
    };
    syncUiLocaleSelect();
    onUiLocaleChange(() => syncUiLocaleSelect());
    if (settingsUiLanguageSelect instanceof HTMLSelectElement) {
        settingsUiLanguageSelect.addEventListener("change", () => {
            var _a;
            const next = (_a = normalizeUiLocale(settingsUiLanguageSelect.value)) !== null && _a !== void 0 ? _a : "ja";
            setUiLocale(next);
        });
    }
};
