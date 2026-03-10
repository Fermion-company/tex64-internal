import type { EditorFormatSettings, FormatSettingsPayload } from "../types.js";
import {
  buildFormatSettingsPayload as buildFormatSettingsPayloadFromSettings,
  defaultEditorFormatSettings,
  normalizeEditorFormatSettings,
  normalizeVerbatimInput,
} from "../settings-format.js";
import type { SettingsUiRuntime } from "./runtime.js";
import { updateSettingsToggle } from "./utils.js";

export type SettingsFormatOps = {
  buildFormatSettingsPayload: () => FormatSettingsPayload;
  loadEditorFormatSettings: () => void;
  setEditorFormatSettings: (next: Partial<EditorFormatSettings>) => void;
};

export const createSettingsFormatOps = (runtime: SettingsUiRuntime): SettingsFormatOps => {
  const {
    editorFormatEnabledToggle,
    editorFormatIndentSelect,
    editorFormatBeginEndToggle,
    editorFormatDocumentNoIndentToggle,
    editorFormatAlignMathToggle,
    editorFormatAlignTableToggle,
    editorFormatBlankLinesSelect,
    editorFormatVerbatimInput,
    editorFormatVerbatimAdd,
    editorFormatVerbatimHint,
    editorFormatVerbatimList,
  } = runtime.context.dom;

  const buildFormatSettingsPayload = (): FormatSettingsPayload =>
    buildFormatSettingsPayloadFromSettings(runtime.state.editorFormatSettings, runtime.deps.envRegistry);

  const setEditorFormatVerbatimHint = (message: string) => {
    if (editorFormatVerbatimHint instanceof HTMLElement) {
      editorFormatVerbatimHint.textContent = message;
    }
  };

  const renderEditorFormatVerbatimList = () => {
    if (!(editorFormatVerbatimList instanceof HTMLElement)) {
      return;
    }
    editorFormatVerbatimList.innerHTML = "";
    const entries = Array.from(new Set(runtime.state.editorFormatSettings.customVerbatim)).sort((a, b) =>
      a.localeCompare(b, "ja")
    );
    entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "env-registry-row";
      row.dataset.verbatimName = entry;

      const spacer = document.createElement("div");
      spacer.className = "env-registry-spacer";
      row.appendChild(spacer);

      const label = document.createElement("div");
      label.className = "env-registry-label";

      const name = document.createElement("span");
      name.className = "env-registry-name";
      name.textContent = entry;
      label.appendChild(name);

      const flag = document.createElement("span");
      flag.className = "env-registry-flag is-custom";
      flag.textContent = "custom";
      label.appendChild(flag);

      row.appendChild(label);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "panel-button ghost env-registry-remove";
      remove.textContent = "削除";
      remove.dataset.verbatimAction = "remove";
      remove.dataset.verbatimName = entry;
      row.appendChild(remove);

      editorFormatVerbatimList.appendChild(row);
    });
  };

  const updateEditorFormatSettingsUI = () => {
    updateSettingsToggle(
      editorFormatEnabledToggle,
      runtime.state.editorFormatSettings.enabled
    );
    if (editorFormatIndentSelect instanceof HTMLSelectElement) {
      editorFormatIndentSelect.value = runtime.state.editorFormatSettings.indentStyle;
    }
    if (editorFormatBlankLinesSelect instanceof HTMLSelectElement) {
      editorFormatBlankLinesSelect.value = runtime.state.editorFormatSettings.blankLines;
    }
    updateSettingsToggle(
      editorFormatBeginEndToggle,
      runtime.state.editorFormatSettings.beginEndOnOwnLine
    );
    updateSettingsToggle(
      editorFormatDocumentNoIndentToggle,
      runtime.state.editorFormatSettings.documentNoIndent
    );
    updateSettingsToggle(
      editorFormatAlignMathToggle,
      runtime.state.editorFormatSettings.alignMathDelims
    );
    updateSettingsToggle(
      editorFormatAlignTableToggle,
      runtime.state.editorFormatSettings.alignTableDelims
    );
    renderEditorFormatVerbatimList();
  };

  const saveEditorFormatSettings = () => {
    try {
      localStorage.setItem(runtime.keys.editorFormatSettingsKey, JSON.stringify(runtime.state.editorFormatSettings));
    } catch {
      // ignore storage failures
    }
  };

  const setEditorFormatSettings = (next: Partial<EditorFormatSettings>) => {
    runtime.state.editorFormatSettings = normalizeEditorFormatSettings({
      ...runtime.state.editorFormatSettings,
      ...next,
    });
    saveEditorFormatSettings();
    updateEditorFormatSettingsUI();
  };

  const loadEditorFormatSettings = () => {
    const stored = localStorage.getItem(runtime.keys.editorFormatSettingsKey);
    if (stored !== null) {
      try {
        runtime.state.editorFormatSettings = normalizeEditorFormatSettings(JSON.parse(stored));
      } catch {
        runtime.state.editorFormatSettings = { ...defaultEditorFormatSettings };
      }
    } else {
      runtime.state.editorFormatSettings = { ...defaultEditorFormatSettings };
    }
    updateEditorFormatSettingsUI();
  };

  const addEditorFormatVerbatim = (value: string) => {
    const name = normalizeVerbatimInput(value);
    if (!name) {
      setEditorFormatVerbatimHint("環境名が空です。");
      return;
    }
    if (runtime.state.editorFormatSettings.customVerbatim.includes(name)) {
      setEditorFormatVerbatimHint("既に登録されています。");
      return;
    }
    setEditorFormatSettings({
      customVerbatim: runtime.state.editorFormatSettings.customVerbatim.concat(name),
    });
    setEditorFormatVerbatimHint(`${name} を追加しました。`);
  };

  const removeEditorFormatVerbatim = (value: string) => {
    const name = normalizeVerbatimInput(value);
    if (!name) {
      return;
    }
    const next = runtime.state.editorFormatSettings.customVerbatim.filter(
      (entry) => normalizeVerbatimInput(entry) !== name
    );
    if (next.length === runtime.state.editorFormatSettings.customVerbatim.length) {
      return;
    }
    setEditorFormatSettings({ customVerbatim: next });
    setEditorFormatVerbatimHint(`${name} を削除しました。`);
  };

  const handleEditorFormatVerbatimListClick = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }
    if (target.dataset.verbatimAction !== "remove") {
      return;
    }
    const name = target.dataset.verbatimName;
    if (!name) {
      return;
    }
    removeEditorFormatVerbatim(name);
  };

  if (editorFormatEnabledToggle instanceof HTMLInputElement) {
    editorFormatEnabledToggle.addEventListener("change", () => {
      setEditorFormatSettings({ enabled: editorFormatEnabledToggle.checked });
    });
  }

  if (editorFormatIndentSelect instanceof HTMLSelectElement) {
    editorFormatIndentSelect.addEventListener("change", () => {
      const value = editorFormatIndentSelect.value;
      if (value === "spaces-2" || value === "spaces-4" || value === "tab") {
        setEditorFormatSettings({ indentStyle: value });
      }
    });
  }

  if (editorFormatBlankLinesSelect instanceof HTMLSelectElement) {
    editorFormatBlankLinesSelect.addEventListener("change", () => {
      const value = editorFormatBlankLinesSelect.value;
      if (value === "preserve" || value === "condense" || value === "remove") {
        setEditorFormatSettings({ blankLines: value });
      }
    });
  }

  if (editorFormatBeginEndToggle instanceof HTMLInputElement) {
    editorFormatBeginEndToggle.addEventListener("change", () => {
      setEditorFormatSettings({
        beginEndOnOwnLine: editorFormatBeginEndToggle.checked,
      });
    });
  }

  if (editorFormatDocumentNoIndentToggle instanceof HTMLInputElement) {
    editorFormatDocumentNoIndentToggle.addEventListener("change", () => {
      setEditorFormatSettings({
        documentNoIndent: editorFormatDocumentNoIndentToggle.checked,
      });
    });
  }

  if (editorFormatAlignMathToggle instanceof HTMLInputElement) {
    editorFormatAlignMathToggle.addEventListener("change", () => {
      setEditorFormatSettings({
        alignMathDelims: editorFormatAlignMathToggle.checked,
      });
    });
  }

  if (editorFormatAlignTableToggle instanceof HTMLInputElement) {
    editorFormatAlignTableToggle.addEventListener("change", () => {
      setEditorFormatSettings({
        alignTableDelims: editorFormatAlignTableToggle.checked,
      });
    });
  }

  if (editorFormatVerbatimAdd instanceof HTMLButtonElement) {
    editorFormatVerbatimAdd.addEventListener("click", () => {
      if (!(editorFormatVerbatimInput instanceof HTMLInputElement)) {
        return;
      }
      addEditorFormatVerbatim(editorFormatVerbatimInput.value);
      editorFormatVerbatimInput.value = "";
      editorFormatVerbatimInput.focus();
      editorFormatVerbatimInput.select();
    });
  }

  if (editorFormatVerbatimInput instanceof HTMLInputElement) {
    editorFormatVerbatimInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      editorFormatVerbatimAdd?.dispatchEvent(new MouseEvent("click"));
    });
  }

  if (editorFormatVerbatimList instanceof HTMLElement) {
    editorFormatVerbatimList.addEventListener("click", handleEditorFormatVerbatimListClick);
  }

  return { buildFormatSettingsPayload, loadEditorFormatSettings, setEditorFormatSettings };
};

