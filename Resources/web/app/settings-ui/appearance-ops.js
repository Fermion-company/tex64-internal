import { getAppearanceThemePreference, normalizeAppearanceThemePreference, setAppearanceThemePreference, } from "../appearance.js";
export const createSettingsAppearanceOps = (runtime) => {
    const { settingsAppearanceThemeSelect } = runtime.context.dom;
    const updateAppearanceThemeUi = () => {
        if (settingsAppearanceThemeSelect instanceof HTMLSelectElement) {
            settingsAppearanceThemeSelect.value = runtime.state.appearanceTheme;
        }
    };
    const loadAppearanceThemeState = () => {
        runtime.state.appearanceTheme = getAppearanceThemePreference();
        updateAppearanceThemeUi();
    };
    const setAppearanceThemeState = (theme) => {
        var _a;
        const nextTheme = (_a = normalizeAppearanceThemePreference(theme)) !== null && _a !== void 0 ? _a : "system";
        runtime.state.appearanceTheme = nextTheme;
        setAppearanceThemePreference(nextTheme);
        updateAppearanceThemeUi();
    };
    if (settingsAppearanceThemeSelect instanceof HTMLSelectElement) {
        settingsAppearanceThemeSelect.addEventListener("change", () => {
            var _a;
            setAppearanceThemeState((_a = normalizeAppearanceThemePreference(settingsAppearanceThemeSelect.value)) !== null && _a !== void 0 ? _a : "system");
        });
    }
    return {
        loadAppearanceThemeState,
        setAppearanceThemeState,
    };
};
