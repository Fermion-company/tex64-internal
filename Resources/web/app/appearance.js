export const APPEARANCE_THEME_STORAGE_KEY = "tex64.appearance.theme";
const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";
let currentPreference = "system";
let currentTheme = "dark";
let watchingSystemTheme = false;
const listeners = new Set();
export const normalizeAppearanceTheme = (value) => value === "light" || value === "dark" ? value : null;
export const normalizeAppearanceThemePreference = (value) => value === "system" ? "system" : normalizeAppearanceTheme(value);
export const getStoredAppearanceThemePreference = () => {
    try {
        return normalizeAppearanceThemePreference(localStorage.getItem(APPEARANCE_THEME_STORAGE_KEY));
    }
    catch {
        return null;
    }
};
const darkSchemeQuery = () => {
    try {
        return typeof window.matchMedia === "function" ? window.matchMedia(DARK_SCHEME_QUERY) : null;
    }
    catch {
        return null;
    }
};
// In the app, prefers-color-scheme follows Electron's nativeTheme, which the
// host sets to "system" for this choice; elsewhere it is the OS itself.
const resolveTheme = (preference) => { var _a; return preference === "system" ? (((_a = darkSchemeQuery()) === null || _a === void 0 ? void 0 : _a.matches) === false ? "light" : "dark") : preference; };
export const getCurrentAppearanceTheme = () => currentTheme;
export const getAppearanceThemePreference = () => currentPreference;
const notify = (theme) => {
    listeners.forEach((listener) => {
        try {
            listener(theme);
        }
        catch {
            // Ignore listener failures.
        }
    });
};
const applyEffectiveTheme = () => {
    const next = resolveTheme(currentPreference);
    const changed = next !== currentTheme;
    currentTheme = next;
    document.documentElement.dataset.theme = next;
    if (changed)
        notify(next);
};
// The AI workspace (a webview) and native dialogs follow nativeTheme, so hand
// the host the choice itself ("system" included).
const postPreference = () => {
    var _a, _b;
    try {
        (_b = (_a = window.tex64Bridge) === null || _a === void 0 ? void 0 : _a.postMessage) === null || _b === void 0 ? void 0 : _b.call(_a, {
            type: "appearance:theme",
            theme: currentPreference,
        });
    }
    catch {
        // No host (tests, plain browser): the page theme still applies.
    }
};
const watchSystemTheme = () => {
    if (watchingSystemTheme)
        return;
    const query = darkSchemeQuery();
    if (!query || typeof query.addEventListener !== "function")
        return;
    watchingSystemTheme = true;
    query.addEventListener("change", () => {
        if (currentPreference === "system")
            applyEffectiveTheme();
    });
};
export const initAppearanceTheme = () => {
    var _a;
    // No saved choice: follow the OS. A saved dark or light choice is kept.
    currentPreference = (_a = getStoredAppearanceThemePreference()) !== null && _a !== void 0 ? _a : "system";
    watchSystemTheme();
    currentTheme = resolveTheme(currentPreference);
    document.documentElement.dataset.theme = currentTheme;
    postPreference();
};
export const setAppearanceThemePreference = (preference) => {
    var _a;
    currentPreference = (_a = normalizeAppearanceThemePreference(preference)) !== null && _a !== void 0 ? _a : "system";
    try {
        localStorage.setItem(APPEARANCE_THEME_STORAGE_KEY, currentPreference);
    }
    catch {
        // Ignore storage failures; the live theme still changes.
    }
    postPreference();
    // Switching to "system" can land on the old value first: the media query
    // catches up once the host has set nativeTheme, and the listener above
    // applies it then.
    applyEffectiveTheme();
};
export const onAppearanceThemeChange = (listener) => {
    if (typeof listener !== "function") {
        return () => { };
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
};
