export const createSettingsEngineOps = (runtime) => {
    const { settingsCompileEngineSelect } = runtime.context.dom;
    // When the workspace's active build profile pins an engine, that engine is
    // what Build runs; the select shows it and stays locked until the profile
    // changes.
    let profileEngine = null;
    const updateEngineUI = () => {
        if (!(settingsCompileEngineSelect instanceof HTMLSelectElement)) {
            return;
        }
        settingsCompileEngineSelect.disabled = Boolean(profileEngine);
        const savedEngine = profileEngine || localStorage.getItem(runtime.keys.compileEngineKey) || "lualatex";
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
    const setProfileEngine = (engine) => {
        const next = engine && runtime.config.texEngineCommands.has(engine) ? engine : null;
        if (next === profileEngine)
            return;
        profileEngine = next;
        updateEngineUI();
    };
    return { updateEngineUI, setCompileEngine, setProfileEngine };
};
