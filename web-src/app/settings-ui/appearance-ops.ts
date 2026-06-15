import {
  getCurrentAppearanceTheme,
  normalizeAppearanceTheme,
  setAppearanceTheme,
  type AppearanceTheme,
} from "../appearance.js";
import type { SettingsUiRuntime } from "./runtime.js";

export type SettingsAppearanceOps = {
  loadAppearanceThemeState: () => void;
  setAppearanceThemeState: (theme: AppearanceTheme) => void;
};

export const createSettingsAppearanceOps = (runtime: SettingsUiRuntime): SettingsAppearanceOps => {
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

  const setAppearanceThemeState = (theme: AppearanceTheme) => {
    const nextTheme = normalizeAppearanceTheme(theme) ?? "dark";
    runtime.state.appearanceTheme = nextTheme;
    setAppearanceTheme(nextTheme);
    updateAppearanceThemeUi();
  };

  if (settingsAppearanceThemeSelect instanceof HTMLSelectElement) {
    settingsAppearanceThemeSelect.addEventListener("change", () => {
      setAppearanceThemeState(
        normalizeAppearanceTheme(settingsAppearanceThemeSelect.value) ?? "dark"
      );
    });
  }

  return {
    loadAppearanceThemeState,
    setAppearanceThemeState,
  };
};
