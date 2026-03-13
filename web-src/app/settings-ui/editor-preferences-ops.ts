import type { SettingsUiRuntime } from "./runtime.js";

export type SettingsEditorPreferenceOps = {
  loadEditorAlignEnvState: () => void;
  loadEditorWordWrapState: () => void;
  loadEditorAutoSynctexBuildState: () => void;
  loadEditorReverseSynctexState: () => void;
  loadEditorPdfViewerModeState: () => void;
  setEditorAlignEnvEnabled: (enabled: boolean) => void;
  setEditorWordWrapEnabled: (enabled: boolean) => void;
  setEditorAutoSynctexBuildEnabled: (enabled: boolean) => void;
  setEditorReverseSynctexEnabled: (enabled: boolean) => void;
  setPdfViewerMode: (mode: "window" | "tab") => void;
};

export const createSettingsEditorPreferenceOps = (runtime: SettingsUiRuntime): SettingsEditorPreferenceOps => {
  const {
    editorAlignEnvToggle,
    editorWordWrapToggle,
    editorAutoSynctexBuildToggle,
    editorReverseSynctexToggle,
    editorPdfWindowToggle,
  } = runtime.context.dom;

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
    localStorage.setItem(
      runtime.keys.editorAutoSynctexOnBuildKey,
      runtime.state.autoSynctexOnBuildEnabled ? "true" : "false"
    );
  };

  const saveEditorReverseSynctexState = () => {
    localStorage.setItem(
      runtime.keys.editorReverseSynctexKey,
      runtime.state.reverseSynctexEnabled ? "true" : "false"
    );
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
        localStorage.setItem(
          runtime.keys.editorAlignEnvKey,
          runtime.state.editorAlignEnvEnabled ? "true" : "false"
        );
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
    } else {
      const legacy = localStorage.getItem(runtime.keys.editorAutoSynctexOnPdfOpenKey);
      runtime.state.autoSynctexOnBuildEnabled = legacy !== null ? legacy !== "false" : true;
      if (legacy !== null) {
        localStorage.setItem(
          runtime.keys.editorAutoSynctexOnBuildKey,
          runtime.state.autoSynctexOnBuildEnabled ? "true" : "false"
        );
      }
    }
    updateEditorAutoSynctexBuildUI();
  };

  const loadEditorReverseSynctexState = () => {
    const stored = localStorage.getItem(runtime.keys.editorReverseSynctexKey);
    if (stored !== null) {
      runtime.state.reverseSynctexEnabled = stored !== "false";
    } else {
      runtime.state.reverseSynctexEnabled = true;
    }
    updateEditorReverseSynctexUI();
  };

  const loadEditorPdfViewerModeState = () => {
    const stored = localStorage.getItem(runtime.keys.editorPdfViewerModeKey);
    if (stored === "tab" || stored === "window") {
      runtime.state.pdfViewerMode = stored;
    } else {
      runtime.state.pdfViewerMode = "window";
    }
    updateEditorPdfViewerModeUI();
  };

  const setEditorAlignEnvEnabled = (enabled: boolean) => {
    runtime.state.editorAlignEnvEnabled = Boolean(enabled);
    saveEditorAlignEnvState();
    updateEditorAlignEnvUI();
  };

  const toggleEditorAlignEnv = () => {
    runtime.state.editorAlignEnvEnabled = !runtime.state.editorAlignEnvEnabled;
    saveEditorAlignEnvState();
    updateEditorAlignEnvUI();
  };

  const setEditorWordWrapEnabled = (enabled: boolean) => {
    runtime.state.editorWordWrapEnabled = Boolean(enabled);
    saveEditorWordWrapState();
    updateEditorWordWrapUI();
    runtime.deps.onEditorWordWrapChange?.(runtime.state.editorWordWrapEnabled);
  };

  const toggleEditorWordWrap = () => {
    runtime.state.editorWordWrapEnabled = !runtime.state.editorWordWrapEnabled;
    saveEditorWordWrapState();
    updateEditorWordWrapUI();
    runtime.deps.onEditorWordWrapChange?.(runtime.state.editorWordWrapEnabled);
  };

  const toggleEditorAutoSynctexBuild = () => {
    runtime.state.autoSynctexOnBuildEnabled = !runtime.state.autoSynctexOnBuildEnabled;
    saveEditorAutoSynctexBuildState();
    updateEditorAutoSynctexBuildUI();
  };

  const setEditorAutoSynctexBuildEnabled = (enabled: boolean) => {
    runtime.state.autoSynctexOnBuildEnabled = Boolean(enabled);
    saveEditorAutoSynctexBuildState();
    updateEditorAutoSynctexBuildUI();
  };

  const toggleEditorReverseSynctex = () => {
    runtime.state.reverseSynctexEnabled = !runtime.state.reverseSynctexEnabled;
    saveEditorReverseSynctexState();
    updateEditorReverseSynctexUI();
  };

  const setEditorReverseSynctexEnabled = (enabled: boolean) => {
    runtime.state.reverseSynctexEnabled = Boolean(enabled);
    saveEditorReverseSynctexState();
    updateEditorReverseSynctexUI();
  };

  const setPdfViewerMode = (mode: "window" | "tab") => {
    runtime.state.pdfViewerMode = mode;
    saveEditorPdfViewerModeState();
    updateEditorPdfViewerModeUI();
  };

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
    loadEditorPdfViewerModeState,
    setEditorAlignEnvEnabled,
    setEditorWordWrapEnabled,
    setEditorAutoSynctexBuildEnabled,
    setEditorReverseSynctexEnabled,
    setPdfViewerMode,
  };
};
