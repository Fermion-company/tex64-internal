export const APPEARANCE_THEME_STORAGE_KEY = "tex64.appearance.theme";
let currentTheme = "dark";
const listeners = new Set();
export const normalizeAppearanceTheme = (value) => value === "light" || value === "dark" ? value : null;
export const getStoredAppearanceTheme = () => {
    try {
        return normalizeAppearanceTheme(localStorage.getItem(APPEARANCE_THEME_STORAGE_KEY));
    }
    catch {
        return null;
    }
};
export const getCurrentAppearanceTheme = () => currentTheme;
const applyAppearanceTheme = (theme) => {
    var _a, _b;
    currentTheme = theme;
    document.documentElement.dataset.theme = theme;
    // The AI workspace (a webview) and native dialogs follow the OS-level scheme, so hand it the app's choice.
    try {
        (_b = (_a = window.tex64Bridge) === null || _a === void 0 ? void 0 : _a.postMessage) === null || _b === void 0 ? void 0 : _b.call(_a, { type: "appearance:theme", theme });
    }
    catch {
        // No host (tests, plain browser): the page theme still applies.
    }
};
export const initAppearanceTheme = () => {
    var _a;
    applyAppearanceTheme((_a = getStoredAppearanceTheme()) !== null && _a !== void 0 ? _a : "dark");
};
export const setAppearanceTheme = (theme) => {
    var _a;
    const nextTheme = (_a = normalizeAppearanceTheme(theme)) !== null && _a !== void 0 ? _a : "dark";
    applyAppearanceTheme(nextTheme);
    try {
        localStorage.setItem(APPEARANCE_THEME_STORAGE_KEY, nextTheme);
    }
    catch {
        // Ignore storage failures; the live theme still changes.
    }
    listeners.forEach((listener) => {
        try {
            listener(nextTheme);
        }
        catch {
            // Ignore listener failures.
        }
    });
};
export const onAppearanceThemeChange = (listener) => {
    if (typeof listener !== "function") {
        return () => { };
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
};
