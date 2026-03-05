export const createSettingsEngineOps = (runtime) => {
    const { settingsCompileEngineSelect } = runtime.context.dom;
    const updateEngineUI = () => {
        if (!(settingsCompileEngineSelect instanceof HTMLSelectElement)) {
            return;
        }
        const savedEngine = localStorage.getItem(runtime.keys.compileEngineKey) || "lualatex";
        const hasOption = Array.from(settingsCompileEngineSelect.options).some((option) => option.value === savedEngine);
        settingsCompileEngineSelect.value = hasOption ? savedEngine : "lualatex";
    };
    const setCompileEngine = (engine) => {
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
