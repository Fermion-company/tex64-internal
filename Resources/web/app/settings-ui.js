import { DEFAULT_ENV_REGISTRY, getEnvBaseName, normalizeEnvName, } from "./env-registry.js";
const defaultEditorFormatSettings = {
    indentStyle: "spaces-2",
    beginEndOnOwnLine: true,
    documentNoIndent: true,
    alignMathDelims: true,
    alignTableDelims: true,
    blankLines: "condense",
    customVerbatim: [],
};
export const initSettingsUi = (context, deps) => {
    const { settingsPanel, settingsNav, settingsNavItems, settingsPages, settingsPageItems, settingsBackButtons, settingsCompileEngineSelect, settingsEnvRefresh, editorAlignEnvToggle, editorFormatIndentSelect, editorFormatBeginEndToggle, editorFormatDocumentNoIndentToggle, editorFormatAlignMathToggle, editorFormatAlignTableToggle, editorFormatBlankLinesSelect, editorFormatVerbatimInput, editorFormatVerbatimAdd, editorFormatVerbatimHint, editorFormatVerbatimList, editorAutoSynctexBuildToggle, editorPdfWindowToggle, } = context.dom;
    let activeSettingsPage = null;
    let editorAlignEnvEnabled = true;
    let editorFormatSettings = {
        ...defaultEditorFormatSettings,
    };
    let autoSynctexOnBuildEnabled = true;
    let pdfViewerMode = "window";
    const compileEngineKey = "tex64.compileEngine";
    const editorAutoSynctexOnBuildKey = "tex64.editor.autoSynctexOnBuild";
    const editorAutoSynctexOnPdfOpenKey = "tex64.editor.autoSynctexOnPdfOpen";
    const editorPdfViewerModeKey = "tex64.editor.pdfViewerMode";
    const editorAlignEnvKey = "tex64.editor.alignEnv";
    const editorFormatSettingsKey = "tex64.editor.formatSettings";
    const updateEngineUI = () => {
        if (!(settingsCompileEngineSelect instanceof HTMLSelectElement)) {
            return;
        }
        const savedEngine = localStorage.getItem(compileEngineKey) || "lualatex";
        const hasOption = Array.from(settingsCompileEngineSelect.options).some((option) => option.value === savedEngine);
        settingsCompileEngineSelect.value = hasOption ? savedEngine : "lualatex";
    };
    const checkEnvironmentStatus = () => {
        deps.postToNative({ type: "env:check", command: "lualatex" }, true);
        deps.postToNative({ type: "env:check", command: "latexmk" }, true);
    };
    const updateEnvStatus = (command, available) => {
        let envName = command;
        if (command === "lualatex" || command === "pdflatex") {
            envName = "lualatex";
        }
        const item = document.querySelector(`.env-item[data-env="${envName}"]`);
        if (!item) {
            return;
        }
        const statusBadge = item.querySelector(".env-badge");
        const actionBtn = item.querySelector(".env-btn");
        if (statusBadge) {
            statusBadge.className = available ? "env-badge ok" : "env-badge error";
            statusBadge.textContent = available ? "利用可能" : "未検出";
        }
        if (actionBtn instanceof HTMLElement) {
            actionBtn.classList.toggle("is-hidden", available);
            if (!available) {
                actionBtn.textContent = "インストール";
                actionBtn.removeAttribute("disabled");
            }
        }
    };
    const envBtns = Array.from(document.querySelectorAll(".env-btn"));
    envBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
            const target = btn.dataset.target;
            if (!target) {
                return;
            }
            if (context.isE2E) {
                btn.textContent = "インストール (テスト)";
                return;
            }
            btn.textContent = "インストール中...";
            btn.disabled = true;
            deps.postToNative({ type: "env:install", target });
        });
    });
    if (settingsCompileEngineSelect instanceof HTMLSelectElement) {
        settingsCompileEngineSelect.addEventListener("change", () => {
            if (settingsCompileEngineSelect.value) {
                localStorage.setItem(compileEngineKey, settingsCompileEngineSelect.value);
            }
        });
    }
    const normalizeVerbatimInput = (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
            return "";
        }
        const match = trimmed.match(/\\(?:begin|end)\{([^}]+)\}/);
        let name = match ? match[1] : trimmed;
        name = name.replace(/[{}]/g, "");
        name = name.replace(/^\\+/, "");
        return getEnvBaseName(normalizeEnvName(name));
    };
    const normalizeEditorVerbatimList = (value) => {
        if (!Array.isArray(value)) {
            return [];
        }
        const entries = [];
        const seen = new Set();
        value.forEach((entry) => {
            if (typeof entry !== "string") {
                return;
            }
            const normalized = normalizeVerbatimInput(entry);
            if (!normalized || seen.has(normalized)) {
                return;
            }
            seen.add(normalized);
            entries.push(normalized);
        });
        return entries;
    };
    const normalizeEditorFormatSettings = (value) => {
        const settings = {
            ...defaultEditorFormatSettings,
        };
        if (!value || typeof value !== "object") {
            return settings;
        }
        const data = value;
        if (data.indentStyle === "spaces-2" ||
            data.indentStyle === "spaces-4" ||
            data.indentStyle === "tab") {
            settings.indentStyle = data.indentStyle;
        }
        if (typeof data.beginEndOnOwnLine === "boolean") {
            settings.beginEndOnOwnLine = data.beginEndOnOwnLine;
        }
        if (typeof data.documentNoIndent === "boolean") {
            settings.documentNoIndent = data.documentNoIndent;
        }
        if (typeof data.alignMathDelims === "boolean") {
            settings.alignMathDelims = data.alignMathDelims;
        }
        if (typeof data.alignTableDelims === "boolean") {
            settings.alignTableDelims = data.alignTableDelims;
        }
        if (data.blankLines === "preserve" ||
            data.blankLines === "condense" ||
            data.blankLines === "remove") {
            settings.blankLines = data.blankLines;
        }
        settings.customVerbatim = normalizeEditorVerbatimList(data.customVerbatim);
        return settings;
    };
    const buildEditorFormatAlignEnvs = () => {
        const math = new Set();
        const table = new Set();
        DEFAULT_ENV_REGISTRY.concat(deps.envRegistry.getCustomEnvRegistry()).forEach((entry) => {
            const base = getEnvBaseName(normalizeEnvName(entry.name));
            if (!base) {
                return;
            }
            if (entry.kind === "table") {
                table.add(base);
            }
            else {
                math.add(base);
            }
        });
        return {
            math: Array.from(math).sort((a, b) => a.localeCompare(b, "ja")),
            table: Array.from(table).sort((a, b) => a.localeCompare(b, "ja")),
        };
    };
    const buildFormatSettingsPayload = () => ({
        ...editorFormatSettings,
        alignEnvs: buildEditorFormatAlignEnvs(),
    });
    const updateSettingsToggle = (element, enabled) => {
        if (element instanceof HTMLInputElement) {
            element.checked = enabled;
        }
    };
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
        const entries = Array.from(new Set(editorFormatSettings.customVerbatim)).sort((a, b) => a.localeCompare(b, "ja"));
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
        if (editorFormatIndentSelect instanceof HTMLSelectElement) {
            editorFormatIndentSelect.value = editorFormatSettings.indentStyle;
        }
        if (editorFormatBlankLinesSelect instanceof HTMLSelectElement) {
            editorFormatBlankLinesSelect.value = editorFormatSettings.blankLines;
        }
        updateSettingsToggle(editorFormatBeginEndToggle, editorFormatSettings.beginEndOnOwnLine);
        updateSettingsToggle(editorFormatDocumentNoIndentToggle, editorFormatSettings.documentNoIndent);
        updateSettingsToggle(editorFormatAlignMathToggle, editorFormatSettings.alignMathDelims);
        updateSettingsToggle(editorFormatAlignTableToggle, editorFormatSettings.alignTableDelims);
        renderEditorFormatVerbatimList();
    };
    const updateEditorAlignEnvUI = () => {
        if (editorAlignEnvToggle instanceof HTMLInputElement) {
            editorAlignEnvToggle.checked = editorAlignEnvEnabled;
        }
    };
    const updateEditorAutoSynctexBuildUI = () => {
        if (editorAutoSynctexBuildToggle instanceof HTMLInputElement) {
            editorAutoSynctexBuildToggle.checked = autoSynctexOnBuildEnabled;
        }
    };
    const updateEditorPdfViewerModeUI = () => {
        if (editorPdfWindowToggle instanceof HTMLInputElement) {
            editorPdfWindowToggle.checked = pdfViewerMode === "window";
        }
    };
    const setSettingsPage = (pageId) => {
        activeSettingsPage = pageId;
        const hasPage = !!pageId;
        if (settingsNav instanceof HTMLElement) {
            settingsNav.classList.toggle("is-hidden", hasPage);
            settingsNav.setAttribute("aria-hidden", hasPage ? "true" : "false");
        }
        if (settingsPages instanceof HTMLElement) {
            settingsPages.classList.toggle("is-hidden", !hasPage);
            settingsPages.setAttribute("aria-hidden", hasPage ? "false" : "true");
        }
        settingsPageItems.forEach((page) => {
            const isActive = hasPage && page.dataset.settingsPage === pageId;
            page.classList.toggle("is-hidden", !isActive);
            page.classList.toggle("is-active", isActive);
            page.setAttribute("aria-hidden", isActive ? "false" : "true");
        });
        if (settingsPanel instanceof HTMLElement) {
            settingsPanel.scrollTop = 0;
        }
    };
    const loadEditorAlignEnvState = () => {
        const stored = localStorage.getItem(editorAlignEnvKey);
        if (stored !== null) {
            editorAlignEnvEnabled = stored !== "false";
            updateEditorAlignEnvUI();
            return;
        }
        const workspaceRootKey = deps.getWorkspaceRootKey();
        if (workspaceRootKey) {
            const legacyKey = `tex64.project.alignEnv.${workspaceRootKey}`;
            const legacy = localStorage.getItem(legacyKey);
            if (legacy !== null) {
                editorAlignEnvEnabled = legacy !== "false";
                localStorage.setItem(editorAlignEnvKey, editorAlignEnvEnabled ? "true" : "false");
                updateEditorAlignEnvUI();
                return;
            }
        }
        editorAlignEnvEnabled = true;
        updateEditorAlignEnvUI();
    };
    const loadEditorFormatSettings = () => {
        const stored = localStorage.getItem(editorFormatSettingsKey);
        if (stored !== null) {
            try {
                editorFormatSettings = normalizeEditorFormatSettings(JSON.parse(stored));
            }
            catch {
                editorFormatSettings = { ...defaultEditorFormatSettings };
            }
        }
        else {
            editorFormatSettings = { ...defaultEditorFormatSettings };
        }
        updateEditorFormatSettingsUI();
    };
    const loadEditorAutoSynctexBuildState = () => {
        const stored = localStorage.getItem(editorAutoSynctexOnBuildKey);
        if (stored !== null) {
            autoSynctexOnBuildEnabled = stored !== "false";
        }
        else {
            const legacy = localStorage.getItem(editorAutoSynctexOnPdfOpenKey);
            autoSynctexOnBuildEnabled = legacy !== null ? legacy !== "false" : true;
            if (legacy !== null) {
                localStorage.setItem(editorAutoSynctexOnBuildKey, autoSynctexOnBuildEnabled ? "true" : "false");
            }
        }
        updateEditorAutoSynctexBuildUI();
    };
    const loadEditorPdfViewerModeState = () => {
        const stored = localStorage.getItem(editorPdfViewerModeKey);
        if (stored === "tab" || stored === "window") {
            pdfViewerMode = stored;
        }
        else {
            pdfViewerMode = "window";
        }
        updateEditorPdfViewerModeUI();
    };
    const saveEditorAlignEnvState = () => {
        localStorage.setItem(editorAlignEnvKey, editorAlignEnvEnabled ? "true" : "false");
    };
    const saveEditorFormatSettings = () => {
        try {
            localStorage.setItem(editorFormatSettingsKey, JSON.stringify(editorFormatSettings));
        }
        catch {
            // ignore storage failures
        }
    };
    const saveEditorAutoSynctexBuildState = () => {
        localStorage.setItem(editorAutoSynctexOnBuildKey, autoSynctexOnBuildEnabled ? "true" : "false");
    };
    const saveEditorPdfViewerModeState = () => {
        localStorage.setItem(editorPdfViewerModeKey, pdfViewerMode);
    };
    const toggleEditorAlignEnv = () => {
        editorAlignEnvEnabled = !editorAlignEnvEnabled;
        saveEditorAlignEnvState();
        updateEditorAlignEnvUI();
    };
    const setEditorFormatSettings = (next) => {
        editorFormatSettings = normalizeEditorFormatSettings({
            ...editorFormatSettings,
            ...next,
        });
        saveEditorFormatSettings();
        updateEditorFormatSettingsUI();
    };
    const addEditorFormatVerbatim = (value) => {
        const name = normalizeVerbatimInput(value);
        if (!name) {
            setEditorFormatVerbatimHint("環境名が空です。");
            return;
        }
        if (editorFormatSettings.customVerbatim.includes(name)) {
            setEditorFormatVerbatimHint("既に登録されています。");
            return;
        }
        setEditorFormatSettings({
            customVerbatim: editorFormatSettings.customVerbatim.concat(name),
        });
        setEditorFormatVerbatimHint(`${name} を追加しました。`);
    };
    const removeEditorFormatVerbatim = (value) => {
        const name = normalizeVerbatimInput(value);
        if (!name) {
            return;
        }
        const next = editorFormatSettings.customVerbatim.filter((entry) => normalizeVerbatimInput(entry) !== name);
        if (next.length === editorFormatSettings.customVerbatim.length) {
            return;
        }
        setEditorFormatSettings({ customVerbatim: next });
        setEditorFormatVerbatimHint(`${name} を削除しました。`);
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
    const toggleEditorAutoSynctexBuild = () => {
        autoSynctexOnBuildEnabled = !autoSynctexOnBuildEnabled;
        saveEditorAutoSynctexBuildState();
        updateEditorAutoSynctexBuildUI();
    };
    const setPdfViewerMode = (mode) => {
        pdfViewerMode = mode;
        saveEditorPdfViewerModeState();
        updateEditorPdfViewerModeUI();
    };
    const loadStartupSettings = () => {
        loadEditorAutoSynctexBuildState();
        loadEditorPdfViewerModeState();
    };
    const loadWorkspaceSettings = () => {
        loadStartupSettings();
        loadEditorAlignEnvState();
        loadEditorFormatSettings();
    };
    setSettingsPage(activeSettingsPage);
    updateEngineUI();
    if (settingsNavItems.length > 0) {
        settingsNavItems.forEach((button) => {
            button.addEventListener("click", () => {
                const target = button.dataset.settingsTarget;
                if (!target) {
                    return;
                }
                setSettingsPage(target);
            });
        });
    }
    if (settingsBackButtons.length > 0) {
        settingsBackButtons.forEach((button) => {
            button.addEventListener("click", () => {
                setSettingsPage(null);
            });
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
    if (editorAlignEnvToggle instanceof HTMLInputElement) {
        editorAlignEnvToggle.addEventListener("change", () => {
            toggleEditorAlignEnv();
        });
    }
    if (editorAutoSynctexBuildToggle instanceof HTMLInputElement) {
        editorAutoSynctexBuildToggle.addEventListener("change", () => {
            toggleEditorAutoSynctexBuild();
        });
    }
    if (editorPdfWindowToggle instanceof HTMLInputElement) {
        editorPdfWindowToggle.addEventListener("change", () => {
            setPdfViewerMode(editorPdfWindowToggle.checked ? "window" : "tab");
        });
    }
    if (settingsEnvRefresh instanceof HTMLButtonElement) {
        settingsEnvRefresh.addEventListener("click", () => {
            checkEnvironmentStatus();
        });
    }
    return {
        getEditorAlignEnvEnabled: () => editorAlignEnvEnabled,
        getAutoSynctexOnBuildEnabled: () => autoSynctexOnBuildEnabled,
        getPdfViewerMode: () => pdfViewerMode,
        buildFormatSettingsPayload,
        checkEnvironmentStatus,
        updateEnvStatus,
        refreshCompileEngine: updateEngineUI,
        loadStartupSettings,
        loadWorkspaceSettings,
    };
};
