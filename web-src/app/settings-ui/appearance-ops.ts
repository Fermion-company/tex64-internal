import {
  getAppearanceThemePreference,
  getDarkPdfPages,
  setDarkPdfPages,
  DARK_PDF_PAGES_EVENT,
  normalizeAppearanceThemePreference,
  setAppearanceThemePreference,
  type AppearanceThemePreference,
} from "../appearance.js";
import type { SettingsUiRuntime } from "./runtime.js";

export type SettingsAppearanceOps = {
  loadAppearanceThemeState: () => void;
  setAppearanceThemeState: (theme: AppearanceThemePreference) => void;
};

export const createSettingsAppearanceOps = (runtime: SettingsUiRuntime): SettingsAppearanceOps => {
  const { settingsAppearanceThemeSelect, settingsDarkPdfPages } = runtime.context.dom;
  if (settingsDarkPdfPages instanceof HTMLInputElement) {
    settingsDarkPdfPages.checked = getDarkPdfPages();
    settingsDarkPdfPages.addEventListener("change", () => setDarkPdfPages(settingsDarkPdfPages.checked));
    window.addEventListener(DARK_PDF_PAGES_EVENT, () => { settingsDarkPdfPages.checked = getDarkPdfPages(); });
  }

  const updateAppearanceThemeUi = () => {
    if (settingsAppearanceThemeSelect instanceof HTMLSelectElement) {
      settingsAppearanceThemeSelect.value = runtime.state.appearanceTheme;
    }
  };

  const loadAppearanceThemeState = () => {
    runtime.state.appearanceTheme = getAppearanceThemePreference();
    updateAppearanceThemeUi();
  };

  const setAppearanceThemeState = (theme: AppearanceThemePreference) => {
    const nextTheme = normalizeAppearanceThemePreference(theme) ?? "system";
    runtime.state.appearanceTheme = nextTheme;
    setAppearanceThemePreference(nextTheme);
    updateAppearanceThemeUi();
  };

  if (settingsAppearanceThemeSelect instanceof HTMLSelectElement) {
    settingsAppearanceThemeSelect.addEventListener("change", () => {
      setAppearanceThemeState(
        normalizeAppearanceThemePreference(settingsAppearanceThemeSelect.value) ?? "system"
      );
    });
  }

  return {
    loadAppearanceThemeState,
    setAppearanceThemeState,
  };
};
