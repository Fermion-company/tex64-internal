import { getCurrentAppearanceTheme, normalizeAppearanceTheme, setAppearanceTheme, } from "../appearance.js";
export const createSettingsAppearanceOps = (runtime) => {
    const { settingsAppearanceThemeSelect } = runtime.context.dom;
    const updateAppearanceThemeUi = () => {
        if (settingsAppearanceThemeSelect instanceof HTMLSelectElement) {
            settingsAppearanceThemeSelect.value = runtime.state.appearanceTheme;
        }
    };
    const loadAppearanceThemeState = () => {
        runtime.state.appearanceTheme = getCurrentAppearanceTheme();
        updateAppearanceThemeUi();
    };
    const setAppearanceThemeState = (theme) => {
        var _a;
        const nextTheme = (_a = normalizeAppearanceTheme(theme)) !== null && _a !== void 0 ? _a : "dark";
        runtime.state.appearanceTheme = nextTheme;
        setAppearanceTheme(nextTheme);
        updateAppearanceThemeUi();
    };
    if (settingsAppearanceThemeSelect instanceof HTMLSelectElement) {
        settingsAppearanceThemeSelect.addEventListener("change", () => {
            var _a;
            setAppearanceThemeState((_a = normalizeAppearanceTheme(settingsAppearanceThemeSelect.value)) !== null && _a !== void 0 ? _a : "dark");
        });
    }
    return {
        loadAppearanceThemeState,
        setAppearanceThemeState,
    };
};
