import { buildFormatSettingsPayload as buildFormatSettingsPayloadFromSettings, defaultEditorFormatSettings, normalizeEditorFormatSettings, normalizeVerbatimInput, } from "../settings-format.js";
import { updateSettingsToggle } from "./utils.js";
export const createSettingsFormatOps = (runtime) => {
    const { editorFormatEnabledToggle, editorFormatIndentSelect, editorFormatBeginEndToggle, editorFormatDocumentNoIndentToggle, editorFormatAlignMathToggle, editorFormatAlignTableToggle, editorFormatBlankLinesSelect, editorFormatVerbatimInput, editorFormatVerbatimAdd, editorFormatVerbatimHint, editorFormatVerbatimList, } = runtime.context.dom;
    const buildFormatSettingsPayload = () => buildFormatSettingsPayloadFromSettings(runtime.state.editorFormatSettings, runtime.deps.envRegistry);
    const setEditorFormatVerbatimHint = (message) => {
        if (editorFormatVerbatimHint instanceof HTMLElement) {
            editorFormatVerbatimHint.textContent = message;
        }
    };
    const renderEditorFormatVerbatimList = () => {
        if (!(editorFormatVerbatimList instanceof HTMLElement)) {
            return;
        }
        editorFormatVerbatimList.innerHTML = "";
        const entries = Array.from(new Set(runtime.state.editorFormatSettings.customVerbatim)).sort((a, b) => a.localeCompare(b, "ja"));
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
            remove.textContent = "Delete";
            remove.dataset.verbatimAction = "remove";
            remove.dataset.verbatimName = entry;
            row.appendChild(remove);
            editorFormatVerbatimList.appendChild(row);
        });
    };
    const updateEditorFormatSettingsUI = () => {
        updateSettingsToggle(editorFormatEnabledToggle, runtime.state.editorFormatSettings.enabled);
        if (editorFormatIndentSelect instanceof HTMLSelectElement) {
            editorFormatIndentSelect.value = runtime.state.editorFormatSettings.indentStyle;
        }
        if (editorFormatBlankLinesSelect instanceof HTMLSelectElement) {
            editorFormatBlankLinesSelect.value = runtime.state.editorFormatSettings.blankLines;
        }
        updateSettingsToggle(editorFormatBeginEndToggle, runtime.state.editorFormatSettings.beginEndOnOwnLine);
        updateSettingsToggle(editorFormatDocumentNoIndentToggle, runtime.state.editorFormatSettings.documentNoIndent);
        updateSettingsToggle(editorFormatAlignMathToggle, runtime.state.editorFormatSettings.alignMathDelims);
        updateSettingsToggle(editorFormatAlignTableToggle, runtime.state.editorFormatSettings.alignTableDelims);
        renderEditorFormatVerbatimList();
    };
    const saveEditorFormatSettings = () => {
        try {
            localStorage.setItem(runtime.keys.editorFormatSettingsKey, JSON.stringify(runtime.state.editorFormatSettings));
        }
        catch {
            // ignore storage failures
        }
    };
    const setEditorFormatSettings = (next) => {
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
            }
            catch {
                runtime.state.editorFormatSettings = { ...defaultEditorFormatSettings };
            }
        }
        else {
            runtime.state.editorFormatSettings = { ...defaultEditorFormatSettings };
        }
        updateEditorFormatSettingsUI();
    };
    const addEditorFormatVerbatim = (value) => {
        const name = normalizeVerbatimInput(value);
        if (!name) {
            setEditorFormatVerbatimHint("Environment name is empty.");
            return;
        }
        if (runtime.state.editorFormatSettings.customVerbatim.includes(name)) {
            setEditorFormatVerbatimHint("Already registered.");
            return;
        }
        setEditorFormatSettings({
            customVerbatim: runtime.state.editorFormatSettings.customVerbatim.concat(name),
        });
        setEditorFormatVerbatimHint(`Added ${name}.`);
    };
    const removeEditorFormatVerbatim = (value) => {
        const name = normalizeVerbatimInput(value);
        if (!name) {
            return;
        }
        const next = runtime.state.editorFormatSettings.customVerbatim.filter((entry) => normalizeVerbatimInput(entry) !== name);
        if (next.length === runtime.state.editorFormatSettings.customVerbatim.length) {
            return;
        }
        setEditorFormatSettings({ customVerbatim: next });
        setEditorFormatVerbatimHint(`Removed ${name}.`);
    };
    const handleEditorFormatVerbatimListClick = (event) => {
        const target = event.target;
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
            editorFormatVerbatimAdd === null || editorFormatVerbatimAdd === void 0 ? void 0 : editorFormatVerbatimAdd.dispatchEvent(new MouseEvent("click"));
        });
    }
    if (editorFormatVerbatimList instanceof HTMLElement) {
        editorFormatVerbatimList.addEventListener("click", handleEditorFormatVerbatimListClick);
    }
    return { buildFormatSettingsPayload, loadEditorFormatSettings, setEditorFormatSettings };
};
