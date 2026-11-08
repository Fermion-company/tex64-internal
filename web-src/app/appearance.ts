// The app's theme. The user picks dark, light or "system" (follow the OS);
// everything that draws reads the effective dark or light value.
export type AppearanceTheme = "dark" | "light";
export type AppearanceThemePreference = AppearanceTheme | "system";

export const APPEARANCE_THEME_STORAGE_KEY = "tex64.appearance.theme";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

let currentPreference: AppearanceThemePreference = "system";
let currentTheme: AppearanceTheme = "dark";
let watchingSystemTheme = false;
const listeners = new Set<(theme: AppearanceTheme) => void>();

export const normalizeAppearanceTheme = (value: unknown): AppearanceTheme | null =>
  value === "light" || value === "dark" ? value : null;

export const normalizeAppearanceThemePreference = (value: unknown): AppearanceThemePreference | null =>
  value === "system" ? "system" : normalizeAppearanceTheme(value);

export const getStoredAppearanceThemePreference = (): AppearanceThemePreference | null => {
  try {
    return normalizeAppearanceThemePreference(localStorage.getItem(APPEARANCE_THEME_STORAGE_KEY));
  } catch {
    return null;
  }
};

const darkSchemeQuery = (): MediaQueryList | null => {
  try {
    return typeof window.matchMedia === "function" ? window.matchMedia(DARK_SCHEME_QUERY) : null;
  } catch {
    return null;
  }
};

// In the app, prefers-color-scheme follows Electron's nativeTheme, which the
// host sets to "system" for this choice; elsewhere it is the OS itself.
const resolveTheme = (preference: AppearanceThemePreference): AppearanceTheme =>
  preference === "system" ? (darkSchemeQuery()?.matches === false ? "light" : "dark") : preference;

export const getCurrentAppearanceTheme = (): AppearanceTheme => currentTheme;

export const getAppearanceThemePreference = (): AppearanceThemePreference => currentPreference;

const notify = (theme: AppearanceTheme) => {
  listeners.forEach((listener) => {
    try {
      listener(theme);
    } catch {
      // Ignore listener failures.
    }
  });
};

const applyEffectiveTheme = () => {
  const next = resolveTheme(currentPreference);
  const changed = next !== currentTheme;
  currentTheme = next;
  document.documentElement.dataset.theme = next;
  if (changed) notify(next);
};

// The AI workspace (a webview) and native dialogs follow nativeTheme, so hand
// the host the choice itself ("system" included).
const postPreference = () => {
  try {
    (window as Window & { tex64Bridge?: { postMessage?: (message: unknown) => void } }).tex64Bridge?.postMessage?.({
      type: "appearance:theme",
      theme: currentPreference,
    });
  } catch {
    // No host (tests, plain browser): the page theme still applies.
  }
};

const watchSystemTheme = () => {
  if (watchingSystemTheme) return;
  const query = darkSchemeQuery();
  if (!query || typeof query.addEventListener !== "function") return;
  watchingSystemTheme = true;
  query.addEventListener("change", () => {
    if (currentPreference === "system") applyEffectiveTheme();
  });
};

export const initAppearanceTheme = () => {
  // No saved choice: follow the OS. A saved dark or light choice is kept.
  currentPreference = getStoredAppearanceThemePreference() ?? "system";
  watchSystemTheme();
  currentTheme = resolveTheme(currentPreference);
  document.documentElement.dataset.theme = currentTheme;
  postPreference();
};

export const setAppearanceThemePreference = (preference: AppearanceThemePreference) => {
  currentPreference = normalizeAppearanceThemePreference(preference) ?? "system";
  try {
    localStorage.setItem(APPEARANCE_THEME_STORAGE_KEY, currentPreference);
  } catch {
    // Ignore storage failures; the live theme still changes.
  }
  postPreference();
  // Switching to "system" can land on the old value first: the media query
  // catches up once the host has set nativeTheme, and the listener above
  // applies it then.
  applyEffectiveTheme();
};

export const onAppearanceThemeChange = (listener: (theme: AppearanceTheme) => void) => {
  if (typeof listener !== "function") {
    return () => {};
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
};
