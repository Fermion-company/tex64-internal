import { getUiLocale, normalizeUiLocale, onUiLocaleChange, setUiLocale } from "../i18n.js";
import type { SettingsUiRuntime } from "./runtime.js";

export const initSettingsUiLocale = (runtime: SettingsUiRuntime) => {
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
      const next = normalizeUiLocale(settingsUiLanguageSelect.value) ?? "ja";
      setUiLocale(next);
    });
  }
};

