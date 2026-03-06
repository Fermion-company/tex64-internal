import { clampNumber, loadGhostCompletionConfig, saveGhostCompletionConfig } from "../settings-completion.js";
export const createSettingsEditorPreferenceOps = (runtime) => {
    const { editorAlignEnvToggle, editorWordWrapToggle, editorAutoSynctexBuildToggle, editorReverseSynctexToggle, editorGhostCompletionToggle, editorGhostCompletionDebounce, editorGhostCompletionMaxChars, editorPdfWindowToggle, } = runtime.context.dom;
    const updateEditorAlignEnvUI = () => {
        if (editorAlignEnvToggle instanceof HTMLInputElement) {
            editorAlignEnvToggle.checked = runtime.state.editorAlignEnvEnabled;
        }
    };
    const updateEditorWordWrapUI = () => {
        if (editorWordWrapToggle instanceof HTMLInputElement) {
            editorWordWrapToggle.checked = runtime.state.editorWordWrapEnabled;
        }
    };
    const updateEditorAutoSynctexBuildUI = () => {
        if (editorAutoSynctexBuildToggle instanceof HTMLInputElement) {
            editorAutoSynctexBuildToggle.checked = runtime.state.autoSynctexOnBuildEnabled;
        }
    };
    const updateEditorReverseSynctexUI = () => {
        if (editorReverseSynctexToggle instanceof HTMLInputElement) {
            editorReverseSynctexToggle.checked = runtime.state.reverseSynctexEnabled;
        }
    };
    const updateEditorGhostCompletionUI = () => {
        if (editorGhostCompletionToggle instanceof HTMLInputElement) {
            editorGhostCompletionToggle.checked = runtime.state.ghostCompletionEnabled;
        }
        const configItems = Array.from(document.querySelectorAll("[data-ghost-config]"));
        configItems.forEach((item) => {
            item.classList.toggle("is-disabled", !runtime.state.ghostCompletionEnabled);
            item.setAttribute("aria-disabled", runtime.state.ghostCompletionEnabled ? "false" : "true");
        });
        if (editorGhostCompletionDebounce instanceof HTMLInputElement) {
            editorGhostCompletionDebounce.disabled = !runtime.state.ghostCompletionEnabled;
        }
        if (editorGhostCompletionMaxChars instanceof HTMLInputElement) {
            editorGhostCompletionMaxChars.disabled = !runtime.state.ghostCompletionEnabled;
        }
    };
    const updateEditorGhostCompletionConfigUI = () => {
        if (editorGhostCompletionDebounce instanceof HTMLInputElement) {
            editorGhostCompletionDebounce.value = String(runtime.state.ghostCompletionDebounceMs);
        }
        if (editorGhostCompletionMaxChars instanceof HTMLInputElement) {
            editorGhostCompletionMaxChars.value = String(runtime.state.ghostCompletionMaxChars);
        }
        updateEditorGhostCompletionUI();
    };
    const updateEditorPdfViewerModeUI = () => {
        if (editorPdfWindowToggle instanceof HTMLInputElement) {
            editorPdfWindowToggle.checked = runtime.state.pdfViewerMode === "window";
        }
    };
    const saveEditorAlignEnvState = () => {
        localStorage.setItem(runtime.keys.editorAlignEnvKey, runtime.state.editorAlignEnvEnabled ? "true" : "false");
    };
    const saveEditorWordWrapState = () => {
        localStorage.setItem(runtime.keys.editorWordWrapKey, runtime.state.editorWordWrapEnabled ? "true" : "false");
    };
    const saveEditorAutoSynctexBuildState = () => {
        localStorage.setItem(runtime.keys.editorAutoSynctexOnBuildKey, runtime.state.autoSynctexOnBuildEnabled ? "true" : "false");
    };
    const saveEditorReverseSynctexState = () => {
        localStorage.setItem(runtime.keys.editorReverseSynctexKey, runtime.state.reverseSynctexEnabled ? "true" : "false");
    };
    const saveEditorGhostCompletionState = () => {
        localStorage.setItem(runtime.keys.editorGhostCompletionKey, runtime.state.ghostCompletionEnabled ? "true" : "false");
    };
    const saveEditorGhostCompletionConfig = () => {
        saveGhostCompletionConfig({
            debounceKey: runtime.keys.editorGhostCompletionDebounceKey,
            maxCharsKey: runtime.keys.editorGhostCompletionMaxCharsKey,
            debounceMs: runtime.state.ghostCompletionDebounceMs,
            maxChars: runtime.state.ghostCompletionMaxChars,
        });
    };
    const saveEditorPdfViewerModeState = () => {
        localStorage.setItem(runtime.keys.editorPdfViewerModeKey, runtime.state.pdfViewerMode);
    };
    const loadEditorAlignEnvState = () => {
        const stored = localStorage.getItem(runtime.keys.editorAlignEnvKey);
        if (stored !== null) {
            runtime.state.editorAlignEnvEnabled = stored !== "false";
            updateEditorAlignEnvUI();
            return;
        }
        const workspaceRootKey = runtime.deps.getWorkspaceRootKey();
        if (workspaceRootKey) {
            const legacyKey = `tex64.project.alignEnv.${workspaceRootKey}`;
            const legacy = localStorage.getItem(legacyKey);
            if (legacy !== null) {
                runtime.state.editorAlignEnvEnabled = legacy !== "false";
                localStorage.setItem(runtime.keys.editorAlignEnvKey, runtime.state.editorAlignEnvEnabled ? "true" : "false");
                updateEditorAlignEnvUI();
                return;
            }
        }
        runtime.state.editorAlignEnvEnabled = true;
        updateEditorAlignEnvUI();
    };
    const loadEditorWordWrapState = () => {
        const stored = localStorage.getItem(runtime.keys.editorWordWrapKey);
        runtime.state.editorWordWrapEnabled = stored === "true";
        updateEditorWordWrapUI();
    };
    const loadEditorAutoSynctexBuildState = () => {
        const stored = localStorage.getItem(runtime.keys.editorAutoSynctexOnBuildKey);
        if (stored !== null) {
            runtime.state.autoSynctexOnBuildEnabled = stored !== "false";
        }
        else {
            const legacy = localStorage.getItem(runtime.keys.editorAutoSynctexOnPdfOpenKey);
            runtime.state.autoSynctexOnBuildEnabled = legacy !== null ? legacy !== "false" : true;
            if (legacy !== null) {
                localStorage.setItem(runtime.keys.editorAutoSynctexOnBuildKey, runtime.state.autoSynctexOnBuildEnabled ? "true" : "false");
            }
        }
        updateEditorAutoSynctexBuildUI();
    };
    const loadEditorReverseSynctexState = () => {
        const stored = localStorage.getItem(runtime.keys.editorReverseSynctexKey);
        if (stored !== null) {
            runtime.state.reverseSynctexEnabled = stored !== "false";
        }
        else {
            runtime.state.reverseSynctexEnabled = true;
        }
        updateEditorReverseSynctexUI();
    };
    const loadEditorGhostCompletionState = () => {
        // Ghost completion is currently disabled — always force off
        runtime.state.ghostCompletionEnabled = false;
        updateEditorGhostCompletionUI();
    };
    const loadEditorGhostCompletionConfig = () => {
        const config = loadGhostCompletionConfig({
            debounceKey: runtime.keys.editorGhostCompletionDebounceKey,
            maxCharsKey: runtime.keys.editorGhostCompletionMaxCharsKey,
            debounceRange: runtime.ranges.ghostCompletionDebounceRange,
            maxCharsRange: runtime.ranges.ghostCompletionMaxCharsRange,
            defaults: { debounceMs: 120, maxChars: 140 },
        });
        runtime.state.ghostCompletionDebounceMs = config.debounceMs;
        runtime.state.ghostCompletionMaxChars = config.maxChars;
        updateEditorGhostCompletionConfigUI();
    };
    const loadEditorPdfViewerModeState = () => {
        const stored = localStorage.getItem(runtime.keys.editorPdfViewerModeKey);
        if (stored === "tab" || stored === "window") {
            runtime.state.pdfViewerMode = stored;
        }
        else {
            runtime.state.pdfViewerMode = "window";
        }
        updateEditorPdfViewerModeUI();
    };
    const setEditorAlignEnvEnabled = (enabled) => {
        runtime.state.editorAlignEnvEnabled = Boolean(enabled);
        saveEditorAlignEnvState();
        updateEditorAlignEnvUI();
    };
    const toggleEditorAlignEnv = () => {
        runtime.state.editorAlignEnvEnabled = !runtime.state.editorAlignEnvEnabled;
        saveEditorAlignEnvState();
        updateEditorAlignEnvUI();
    };
    const setEditorWordWrapEnabled = (enabled) => {
        var _a, _b;
        runtime.state.editorWordWrapEnabled = Boolean(enabled);
        saveEditorWordWrapState();
        updateEditorWordWrapUI();
        (_b = (_a = runtime.deps).onEditorWordWrapChange) === null || _b === void 0 ? void 0 : _b.call(_a, runtime.state.editorWordWrapEnabled);
    };
    const toggleEditorWordWrap = () => {
        var _a, _b;
        runtime.state.editorWordWrapEnabled = !runtime.state.editorWordWrapEnabled;
        saveEditorWordWrapState();
        updateEditorWordWrapUI();
        (_b = (_a = runtime.deps).onEditorWordWrapChange) === null || _b === void 0 ? void 0 : _b.call(_a, runtime.state.editorWordWrapEnabled);
    };
    const toggleEditorAutoSynctexBuild = () => {
        runtime.state.autoSynctexOnBuildEnabled = !runtime.state.autoSynctexOnBuildEnabled;
        saveEditorAutoSynctexBuildState();
        updateEditorAutoSynctexBuildUI();
    };
    const setEditorAutoSynctexBuildEnabled = (enabled) => {
        runtime.state.autoSynctexOnBuildEnabled = Boolean(enabled);
        saveEditorAutoSynctexBuildState();
        updateEditorAutoSynctexBuildUI();
    };
    const toggleEditorReverseSynctex = () => {
        runtime.state.reverseSynctexEnabled = !runtime.state.reverseSynctexEnabled;
        saveEditorReverseSynctexState();
        updateEditorReverseSynctexUI();
    };
    const setEditorReverseSynctexEnabled = (enabled) => {
        runtime.state.reverseSynctexEnabled = Boolean(enabled);
        saveEditorReverseSynctexState();
        updateEditorReverseSynctexUI();
    };
    const toggleEditorGhostCompletion = () => {
        var _a, _b;
        runtime.state.ghostCompletionEnabled = !runtime.state.ghostCompletionEnabled;
        saveEditorGhostCompletionState();
        updateEditorGhostCompletionUI();
        (_b = (_a = runtime.deps).onGhostCompletionChange) === null || _b === void 0 ? void 0 : _b.call(_a, runtime.state.ghostCompletionEnabled);
    };
    const setGhostCompletionEnabled = (enabled) => {
        var _a, _b;
        runtime.state.ghostCompletionEnabled = Boolean(enabled);
        saveEditorGhostCompletionState();
        updateEditorGhostCompletionUI();
        (_b = (_a = runtime.deps).onGhostCompletionChange) === null || _b === void 0 ? void 0 : _b.call(_a, runtime.state.ghostCompletionEnabled);
    };
    const setGhostCompletionConfig = (next) => {
        var _a, _b;
        const debounce = clampNumber(typeof next.debounceMs === "number" ? next.debounceMs : runtime.state.ghostCompletionDebounceMs, runtime.ranges.ghostCompletionDebounceRange.min, runtime.ranges.ghostCompletionDebounceRange.max, runtime.state.ghostCompletionDebounceMs);
        const maxChars = clampNumber(typeof next.maxChars === "number" ? next.maxChars : runtime.state.ghostCompletionMaxChars, runtime.ranges.ghostCompletionMaxCharsRange.min, runtime.ranges.ghostCompletionMaxCharsRange.max, runtime.state.ghostCompletionMaxChars);
        runtime.state.ghostCompletionDebounceMs = debounce;
        runtime.state.ghostCompletionMaxChars = maxChars;
        saveEditorGhostCompletionConfig();
        updateEditorGhostCompletionConfigUI();
        (_b = (_a = runtime.deps).onGhostCompletionConfigChange) === null || _b === void 0 ? void 0 : _b.call(_a, {
            debounceMs: runtime.state.ghostCompletionDebounceMs,
            maxChars: runtime.state.ghostCompletionMaxChars,
        });
    };
    const setPdfViewerMode = (mode) => {
        runtime.state.pdfViewerMode = mode;
        saveEditorPdfViewerModeState();
        updateEditorPdfViewerModeUI();
    };
    const getGhostCompletionConfig = () => ({
        debounceMs: runtime.state.ghostCompletionDebounceMs,
        maxChars: runtime.state.ghostCompletionMaxChars,
    });
    if (editorAlignEnvToggle instanceof HTMLInputElement) {
        editorAlignEnvToggle.addEventListener("change", () => {
            toggleEditorAlignEnv();
        });
    }
    if (editorWordWrapToggle instanceof HTMLInputElement) {
        editorWordWrapToggle.addEventListener("change", () => {
            toggleEditorWordWrap();
        });
    }
    if (editorAutoSynctexBuildToggle instanceof HTMLInputElement) {
        editorAutoSynctexBuildToggle.addEventListener("change", () => {
            toggleEditorAutoSynctexBuild();
        });
    }
    if (editorReverseSynctexToggle instanceof HTMLInputElement) {
        editorReverseSynctexToggle.addEventListener("change", () => {
            toggleEditorReverseSynctex();
        });
    }
    if (editorGhostCompletionToggle instanceof HTMLInputElement) {
        editorGhostCompletionToggle.addEventListener("change", () => {
            toggleEditorGhostCompletion();
        });
    }
    if (editorGhostCompletionDebounce instanceof HTMLInputElement) {
        editorGhostCompletionDebounce.addEventListener("change", () => {
            setGhostCompletionConfig({
                debounceMs: editorGhostCompletionDebounce.valueAsNumber,
            });
        });
    }
    if (editorGhostCompletionMaxChars instanceof HTMLInputElement) {
        editorGhostCompletionMaxChars.addEventListener("change", () => {
            setGhostCompletionConfig({
                maxChars: editorGhostCompletionMaxChars.valueAsNumber,
            });
        });
    }
    if (editorPdfWindowToggle instanceof HTMLInputElement) {
        editorPdfWindowToggle.addEventListener("change", () => {
            setPdfViewerMode(editorPdfWindowToggle.checked ? "window" : "tab");
        });
    }
    return {
        loadEditorAlignEnvState,
        loadEditorWordWrapState,
        loadEditorAutoSynctexBuildState,
        loadEditorReverseSynctexState,
        loadEditorGhostCompletionState,
        loadEditorGhostCompletionConfig,
        loadEditorPdfViewerModeState,
        setEditorAlignEnvEnabled,
        setEditorWordWrapEnabled,
        setEditorAutoSynctexBuildEnabled,
        setEditorReverseSynctexEnabled,
        setGhostCompletionEnabled,
        setGhostCompletionConfig,
        setPdfViewerMode,
        getGhostCompletionConfig,
    };
};
