export type AppearanceTheme = "dark" | "light";

export const APPEARANCE_THEME_STORAGE_KEY = "tex64.appearance.theme";

let currentTheme: AppearanceTheme = "dark";
const listeners = new Set<(theme: AppearanceTheme) => void>();

export const normalizeAppearanceTheme = (value: unknown): AppearanceTheme | null =>
  value === "light" || value === "dark" ? value : null;

export const getStoredAppearanceTheme = (): AppearanceTheme | null => {
  try {
    return normalizeAppearanceTheme(localStorage.getItem(APPEARANCE_THEME_STORAGE_KEY));
  } catch {
    return null;
  }
};

export const getCurrentAppearanceTheme = (): AppearanceTheme => currentTheme;

const applyAppearanceTheme = (theme: AppearanceTheme) => {
  currentTheme = theme;
  document.documentElement.dataset.theme = theme;
};

export const initAppearanceTheme = () => {
  applyAppearanceTheme(getStoredAppearanceTheme() ?? "dark");
};

export const setAppearanceTheme = (theme: AppearanceTheme) => {
  const nextTheme = normalizeAppearanceTheme(theme) ?? "dark";
  applyAppearanceTheme(nextTheme);
  try {
    localStorage.setItem(APPEARANCE_THEME_STORAGE_KEY, nextTheme);
  } catch {
    // Ignore storage failures; the live theme still changes.
  }
  listeners.forEach((listener) => {
    try {
      listener(nextTheme);
    } catch {
      // Ignore listener failures.
    }
  });
};

export const onAppearanceThemeChange = (listener: (theme: AppearanceTheme) => void) => {
  if (typeof listener !== "function") {
    return () => {};
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
};
