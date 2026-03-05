import type { SettingsUiRuntime } from "./runtime.js";

export type SettingsEngineOps = {
  updateEngineUI: () => void;
  setCompileEngine: (engine: string) => void;
};

export const createSettingsEngineOps = (runtime: SettingsUiRuntime): SettingsEngineOps => {
  const { settingsCompileEngineSelect } = runtime.context.dom;

  const updateEngineUI = () => {
    if (!(settingsCompileEngineSelect instanceof HTMLSelectElement)) {
      return;
    }
    const savedEngine = localStorage.getItem(runtime.keys.compileEngineKey) || "lualatex";
    const hasOption = Array.from(settingsCompileEngineSelect.options).some(
      (option) => option.value === savedEngine
    );
    settingsCompileEngineSelect.value = hasOption ? savedEngine : "lualatex";
  };

  const setCompileEngine = (engine: string) => {
    if (!engine || !runtime.config.texEngineCommands.has(engine)) {
      return;
    }
    localStorage.setItem(runtime.keys.compileEngineKey, engine);
    updateEngineUI();
  };

  if (settingsCompileEngineSelect instanceof HTMLSelectElement) {
    settingsCompileEngineSelect.addEventListener("change", () => {
      if (settingsCompileEngineSelect.value) {
        localStorage.setItem(runtime.keys.compileEngineKey, settingsCompileEngineSelect.value);
      }
    });
  }

  return { updateEngineUI, setCompileEngine };
};

