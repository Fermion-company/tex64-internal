import { buildFormatSettingsPayload as buildFormatSettingsPayloadFromSettings, defaultEditorFormatSettings, normalizeEditorFormatSettings, normalizeVerbatimInput, } from "./settings-format.js";
import { clampNumber, loadGhostCompletionConfig, saveGhostCompletionConfig, } from "./settings-completion.js";
import { createEnvStatusManager } from "./settings-env.js";
export const initSettingsUi = (context, deps) => {
    const { settingsPanel, settingsNav, settingsNavItems, settingsPages, settingsPageItems, settingsBackButtons, settingsCompileEngineSelect, settingsBuildProfileSelect, settingsBuildProfileName, settingsBuildOutDir, settingsBuildExtraArgs, settingsBuildProfileAdd, settingsBuildProfileDelete, settingsBuildProfileHint, settingsBuildCleanButton, settingsBuildCleanAllButton, settingsEnvRefresh, editorAlignEnvToggle, editorFormatIndentSelect, editorFormatBeginEndToggle, editorFormatDocumentNoIndentToggle, editorFormatAlignMathToggle, editorFormatAlignTableToggle, editorFormatBlankLinesSelect, editorFormatVerbatimInput, editorFormatVerbatimAdd, editorFormatVerbatimHint, editorFormatVerbatimList, editorAutoSynctexBuildToggle, editorReverseSynctexToggle, editorGhostCompletionToggle, editorGhostCompletionDebounce, editorGhostCompletionMaxChars, editorPdfWindowToggle, } = context.dom;
    let activeSettingsPage = null;
    let editorAlignEnvEnabled = true;
    let editorFormatSettings = {
        ...defaultEditorFormatSettings,
    };
    let autoSynctexOnBuildEnabled = true;
    let reverseSynctexEnabled = true;
    let ghostCompletionEnabled = true;
    let ghostCompletionDebounceMs = 260;
    let ghostCompletionMaxChars = 140;
    let pdfViewerMode = "window";
    let buildProfiles = [];
    let buildProfileId = null;
    let buildProfileSaveTimer = null;
    const compileEngineKey = "tex64.compileEngine";
    const editorAutoSynctexOnBuildKey = "tex64.editor.autoSynctexOnBuild";
    const editorReverseSynctexKey = "tex64.editor.reverseSynctex";
    const editorGhostCompletionKey = "tex64.editor.ghostCompletion";
    const editorGhostCompletionDebounceKey = "tex64.editor.ghostCompletion.debounceMs";
    const editorGhostCompletionMaxCharsKey = "tex64.editor.ghostCompletion.maxChars";
    const editorAutoSynctexOnPdfOpenKey = "tex64.editor.autoSynctexOnPdfOpen";
    const editorPdfViewerModeKey = "tex64.editor.pdfViewerMode";
    const editorAlignEnvKey = "tex64.editor.alignEnv";
    const editorFormatSettingsKey = "tex64.editor.formatSettings";
    const ghostCompletionDebounceRange = { min: 0, max: 2000 };
    const ghostCompletionMaxCharsRange = { min: 20, max: 400 };
    const texEngineCommands = new Set(["lualatex", "pdflatex", "xelatex", "uplatex"]);
    const envCheckTargets = [
        "lualatex",
        "pdflatex",
        "xelatex",
        "uplatex",
        "latexmk",
        "latexindent",
        "synctex",
        "chktex",
    ];
    const envDisplayTargets = ["lualatex", "latexmk", "latexindent", "synctex", "chktex"];
    const envManager = createEnvStatusManager({
        postToNative: deps.postToNative,
        envCheckTargets,
        envDisplayTargets,
        texEngineCommands,
    });
    const { checkEnvironmentStatus, updateEnvStatus } = envManager;
    const updateEngineUI = () => {
        if (!(settingsCompileEngineSelect instanceof HTMLSelectElement)) {
            return;
        }
        const savedEngine = localStorage.getItem(compileEngineKey) || "lualatex";
        const hasOption = Array.from(settingsCompileEngineSelect.options).some((option) => option.value === savedEngine);
        settingsCompileEngineSelect.value = hasOption ? savedEngine : "lualatex";
    };
    const buildFormatSettingsPayload = () => buildFormatSettingsPayloadFromSettings(editorFormatSettings, deps.envRegistry);
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
    const updateEditorReverseSynctexUI = () => {
        if (editorReverseSynctexToggle instanceof HTMLInputElement) {
            editorReverseSynctexToggle.checked = reverseSynctexEnabled;
        }
    };
    const updateEditorGhostCompletionUI = () => {
        if (editorGhostCompletionToggle instanceof HTMLInputElement) {
            editorGhostCompletionToggle.checked = ghostCompletionEnabled;
        }
        const configItems = Array.from(document.querySelectorAll("[data-ghost-config]"));
        configItems.forEach((item) => {
            item.classList.toggle("is-disabled", !ghostCompletionEnabled);
            item.setAttribute("aria-disabled", ghostCompletionEnabled ? "false" : "true");
        });
        if (editorGhostCompletionDebounce instanceof HTMLInputElement) {
            editorGhostCompletionDebounce.disabled = !ghostCompletionEnabled;
        }
        if (editorGhostCompletionMaxChars instanceof HTMLInputElement) {
            editorGhostCompletionMaxChars.disabled = !ghostCompletionEnabled;
        }
    };
    const updateEditorGhostCompletionConfigUI = () => {
        if (editorGhostCompletionDebounce instanceof HTMLInputElement) {
            editorGhostCompletionDebounce.value = String(ghostCompletionDebounceMs);
        }
        if (editorGhostCompletionMaxChars instanceof HTMLInputElement) {
            editorGhostCompletionMaxChars.value = String(ghostCompletionMaxChars);
        }
        updateEditorGhostCompletionUI();
    };
    const updateEditorPdfViewerModeUI = () => {
        if (editorPdfWindowToggle instanceof HTMLInputElement) {
            editorPdfWindowToggle.checked = pdfViewerMode === "window";
        }
    };
    const isWorkspaceReadyForBuildProfiles = () => Boolean(deps.getWorkspaceRootKey());
    const loadBuildProfileState = () => {
        const profiles = deps.getBuildProfiles();
        buildProfiles = Array.isArray(profiles)
            ? profiles
                .map((profile) => (profile && typeof profile === "object" ? profile : null))
                .filter(Boolean)
                .map((profile) => {
                var _a, _b, _c, _d;
                return ({
                    id: String((_a = profile.id) !== null && _a !== void 0 ? _a : "").trim(),
                    name: String((_b = profile.name) !== null && _b !== void 0 ? _b : "").trim(),
                    outDir: typeof profile.outDir === "string"
                        ? ((_c = profile.outDir) === null || _c === void 0 ? void 0 : _c.trim()) || null
                        : null,
                    extraArgs: typeof profile.extraArgs === "string"
                        ? ((_d = profile.extraArgs) === null || _d === void 0 ? void 0 : _d.trim()) || null
                        : null,
                });
            })
                .filter((profile) => profile.id)
            : [];
        const active = deps.getBuildProfileId();
        buildProfileId = typeof active === "string" && active.trim() ? active.trim() : null;
    };
    const updateBuildProfileHint = (text) => {
        if (settingsBuildProfileHint instanceof HTMLElement) {
            settingsBuildProfileHint.textContent = text;
        }
    };
    const getSelectedBuildProfileId = () => {
        if (!(settingsBuildProfileSelect instanceof HTMLSelectElement)) {
            return "";
        }
        return settingsBuildProfileSelect.value;
    };
    const renderBuildProfileSelect = () => {
        if (!(settingsBuildProfileSelect instanceof HTMLSelectElement)) {
            return;
        }
        settingsBuildProfileSelect.innerHTML = "";
        const defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = "Default";
        settingsBuildProfileSelect.appendChild(defaultOption);
        buildProfiles.forEach((profile) => {
            const option = document.createElement("option");
            option.value = profile.id;
            option.textContent = profile.name || profile.id;
            settingsBuildProfileSelect.appendChild(option);
        });
        const preferred = buildProfileId !== null && buildProfileId !== void 0 ? buildProfileId : "";
        const hasPreferred = Array.from(settingsBuildProfileSelect.options).some((option) => option.value === preferred);
        settingsBuildProfileSelect.value = hasPreferred ? preferred : "";
    };
    const renderBuildProfileFields = () => {
        var _a, _b, _c, _d;
        const enabled = isWorkspaceReadyForBuildProfiles();
        const selectedId = getSelectedBuildProfileId();
        const selected = selectedId && selectedId !== ""
            ? (_a = buildProfiles.find((profile) => profile.id === selectedId)) !== null && _a !== void 0 ? _a : null
            : null;
        const isCustom = Boolean(selected);
        if (settingsBuildProfileName instanceof HTMLInputElement) {
            settingsBuildProfileName.disabled = !enabled || !isCustom;
            settingsBuildProfileName.value = (_b = selected === null || selected === void 0 ? void 0 : selected.name) !== null && _b !== void 0 ? _b : "";
        }
        if (settingsBuildOutDir instanceof HTMLInputElement) {
            settingsBuildOutDir.disabled = !enabled || !isCustom;
            settingsBuildOutDir.value = (_c = selected === null || selected === void 0 ? void 0 : selected.outDir) !== null && _c !== void 0 ? _c : "";
        }
        if (settingsBuildExtraArgs instanceof HTMLInputElement) {
            settingsBuildExtraArgs.disabled = !enabled || !isCustom;
            settingsBuildExtraArgs.value = (_d = selected === null || selected === void 0 ? void 0 : selected.extraArgs) !== null && _d !== void 0 ? _d : "";
        }
        if (settingsBuildProfileAdd instanceof HTMLButtonElement) {
            settingsBuildProfileAdd.disabled = !enabled;
        }
        if (settingsBuildProfileDelete instanceof HTMLButtonElement) {
            settingsBuildProfileDelete.disabled = !enabled || !isCustom;
        }
        if (settingsBuildCleanButton instanceof HTMLButtonElement) {
            settingsBuildCleanButton.disabled = !enabled;
        }
        if (settingsBuildCleanAllButton instanceof HTMLButtonElement) {
            settingsBuildCleanAllButton.disabled = !enabled;
        }
        if (settingsBuildProfileSelect instanceof HTMLSelectElement) {
            settingsBuildProfileSelect.disabled = !enabled;
        }
        updateBuildProfileHint(enabled
            ? isCustom
                ? "変更は自動で保存されます。"
                : "Default は tex64 の標準設定です。プロジェクト固有の outDir や biber/shell-escape が必要な場合はプロファイルを作成してください。"
            : "ワークスペースを開くとビルドプロファイルを編集できます。");
    };
    const renderBuildProfilesUi = () => {
        loadBuildProfileState();
        renderBuildProfileSelect();
        renderBuildProfileFields();
    };
    const generateBuildProfileId = () => {
        var _a;
        if (typeof ((_a = window.crypto) === null || _a === void 0 ? void 0 : _a.randomUUID) === "function") {
            return window.crypto.randomUUID();
        }
        const rand = Math.random().toString(36).slice(2, 8);
        return `profile-${Date.now().toString(36)}-${rand}`;
    };
    const postBuildProfilesUpdate = (silent = true) => {
        const activeId = getSelectedBuildProfileId();
        deps.postToNative({
            type: "build:profiles:update",
            profiles: buildProfiles,
            activeId,
        }, silent);
    };
    const scheduleBuildProfilesSave = () => {
        if (buildProfileSaveTimer !== null) {
            window.clearTimeout(buildProfileSaveTimer);
            buildProfileSaveTimer = null;
        }
        buildProfileSaveTimer = window.setTimeout(() => {
            buildProfileSaveTimer = null;
            postBuildProfilesUpdate(true);
        }, 320);
    };
    const updateSelectedProfile = (patch) => {
        const selectedId = getSelectedBuildProfileId();
        if (!selectedId) {
            return;
        }
        const index = buildProfiles.findIndex((profile) => profile.id === selectedId);
        if (index < 0) {
            return;
        }
        const current = buildProfiles[index];
        const next = {
            ...current,
            ...patch,
            id: current.id,
        };
        buildProfiles = buildProfiles.map((profile) => profile.id === selectedId ? next : profile);
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
        if (pageId === "runtime") {
            checkEnvironmentStatus();
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
    const loadEditorReverseSynctexState = () => {
        const stored = localStorage.getItem(editorReverseSynctexKey);
        if (stored !== null) {
            reverseSynctexEnabled = stored !== "false";
        }
        else {
            reverseSynctexEnabled = true;
        }
        updateEditorReverseSynctexUI();
    };
    const loadEditorGhostCompletionState = () => {
        const stored = localStorage.getItem(editorGhostCompletionKey);
        if (stored !== null) {
            ghostCompletionEnabled = stored !== "false";
        }
        else {
            ghostCompletionEnabled = true;
        }
        updateEditorGhostCompletionUI();
    };
    const loadEditorGhostCompletionConfig = () => {
        const config = loadGhostCompletionConfig({
            debounceKey: editorGhostCompletionDebounceKey,
            maxCharsKey: editorGhostCompletionMaxCharsKey,
            debounceRange: ghostCompletionDebounceRange,
            maxCharsRange: ghostCompletionMaxCharsRange,
            defaults: { debounceMs: 260, maxChars: 140 },
        });
        ghostCompletionDebounceMs = config.debounceMs;
        ghostCompletionMaxChars = config.maxChars;
        updateEditorGhostCompletionConfigUI();
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
    const saveEditorReverseSynctexState = () => {
        localStorage.setItem(editorReverseSynctexKey, reverseSynctexEnabled ? "true" : "false");
    };
    const saveEditorGhostCompletionState = () => {
        localStorage.setItem(editorGhostCompletionKey, ghostCompletionEnabled ? "true" : "false");
    };
    const saveEditorGhostCompletionConfig = () => {
        saveGhostCompletionConfig({
            debounceKey: editorGhostCompletionDebounceKey,
            maxCharsKey: editorGhostCompletionMaxCharsKey,
            debounceMs: ghostCompletionDebounceMs,
            maxChars: ghostCompletionMaxChars,
        });
    };
    const saveEditorPdfViewerModeState = () => {
        localStorage.setItem(editorPdfViewerModeKey, pdfViewerMode);
    };
    const setCompileEngine = (engine) => {
        if (!engine || !texEngineCommands.has(engine)) {
            return;
        }
        localStorage.setItem(compileEngineKey, engine);
        updateEngineUI();
    };
    const setEditorAlignEnvEnabled = (enabled) => {
        editorAlignEnvEnabled = Boolean(enabled);
        saveEditorAlignEnvState();
        updateEditorAlignEnvUI();
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
    const setEditorAutoSynctexBuildEnabled = (enabled) => {
        autoSynctexOnBuildEnabled = Boolean(enabled);
        saveEditorAutoSynctexBuildState();
        updateEditorAutoSynctexBuildUI();
    };
    const toggleEditorReverseSynctex = () => {
        reverseSynctexEnabled = !reverseSynctexEnabled;
        saveEditorReverseSynctexState();
        updateEditorReverseSynctexUI();
    };
    const setEditorReverseSynctexEnabled = (enabled) => {
        reverseSynctexEnabled = Boolean(enabled);
        saveEditorReverseSynctexState();
        updateEditorReverseSynctexUI();
    };
    const toggleEditorGhostCompletion = () => {
        var _a;
        ghostCompletionEnabled = !ghostCompletionEnabled;
        saveEditorGhostCompletionState();
        updateEditorGhostCompletionUI();
        (_a = deps.onGhostCompletionChange) === null || _a === void 0 ? void 0 : _a.call(deps, ghostCompletionEnabled);
    };
    const setGhostCompletionEnabled = (enabled) => {
        var _a;
        ghostCompletionEnabled = Boolean(enabled);
        saveEditorGhostCompletionState();
        updateEditorGhostCompletionUI();
        (_a = deps.onGhostCompletionChange) === null || _a === void 0 ? void 0 : _a.call(deps, ghostCompletionEnabled);
    };
    const setGhostCompletionConfig = (next) => {
        var _a;
        const debounce = clampNumber(typeof next.debounceMs === "number" ? next.debounceMs : ghostCompletionDebounceMs, ghostCompletionDebounceRange.min, ghostCompletionDebounceRange.max, ghostCompletionDebounceMs);
        const maxChars = clampNumber(typeof next.maxChars === "number" ? next.maxChars : ghostCompletionMaxChars, ghostCompletionMaxCharsRange.min, ghostCompletionMaxCharsRange.max, ghostCompletionMaxChars);
        ghostCompletionDebounceMs = debounce;
        ghostCompletionMaxChars = maxChars;
        saveEditorGhostCompletionConfig();
        updateEditorGhostCompletionConfigUI();
        (_a = deps.onGhostCompletionConfigChange) === null || _a === void 0 ? void 0 : _a.call(deps, {
            debounceMs: ghostCompletionDebounceMs,
            maxChars: ghostCompletionMaxChars,
        });
    };
    const setPdfViewerMode = (mode) => {
        pdfViewerMode = mode;
        saveEditorPdfViewerModeState();
        updateEditorPdfViewerModeUI();
    };
    const loadStartupSettings = () => {
        loadEditorAutoSynctexBuildState();
        loadEditorReverseSynctexState();
        loadEditorGhostCompletionState();
        loadEditorGhostCompletionConfig();
        loadEditorPdfViewerModeState();
    };
    const loadWorkspaceSettings = () => {
        loadStartupSettings();
        loadEditorAlignEnvState();
        loadEditorFormatSettings();
        renderBuildProfilesUi();
    };
    const getSettingsSnapshot = () => ({
        compileEngine: localStorage.getItem(compileEngineKey) || "lualatex",
        autoSynctexOnBuild: autoSynctexOnBuildEnabled,
        reverseSynctexEnabled,
        pdfViewerMode,
        ghostCompletionEnabled,
        ghostCompletionDebounceMs,
        ghostCompletionMaxChars,
        alignEnv: editorAlignEnvEnabled,
        formatSettings: {
            ...editorFormatSettings,
            customVerbatim: [...editorFormatSettings.customVerbatim],
        },
    });
    const applySettingsPatch = (patch) => {
        if (!patch || typeof patch !== "object") {
            return getSettingsSnapshot();
        }
        if (typeof patch.compileEngine === "string") {
            setCompileEngine(patch.compileEngine);
        }
        if (typeof patch.autoSynctexOnBuild === "boolean") {
            setEditorAutoSynctexBuildEnabled(patch.autoSynctexOnBuild);
        }
        if (typeof patch.reverseSynctexEnabled === "boolean") {
            setEditorReverseSynctexEnabled(patch.reverseSynctexEnabled);
        }
        if (typeof patch.ghostCompletionEnabled === "boolean") {
            setGhostCompletionEnabled(patch.ghostCompletionEnabled);
        }
        if (typeof patch.ghostCompletionDebounceMs === "number") {
            setGhostCompletionConfig({ debounceMs: patch.ghostCompletionDebounceMs });
        }
        if (typeof patch.ghostCompletionMaxChars === "number") {
            setGhostCompletionConfig({ maxChars: patch.ghostCompletionMaxChars });
        }
        if (patch.pdfViewerMode === "window" || patch.pdfViewerMode === "tab") {
            setPdfViewerMode(patch.pdfViewerMode);
        }
        if (typeof patch.alignEnv === "boolean") {
            setEditorAlignEnvEnabled(patch.alignEnv);
        }
        if (patch.formatSettings && typeof patch.formatSettings === "object") {
            setEditorFormatSettings(patch.formatSettings);
        }
        return getSettingsSnapshot();
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
    if (settingsBuildProfileSelect instanceof HTMLSelectElement) {
        settingsBuildProfileSelect.addEventListener("change", () => {
            renderBuildProfileFields();
            postBuildProfilesUpdate(true);
        });
    }
    if (settingsBuildProfileAdd instanceof HTMLButtonElement) {
        settingsBuildProfileAdd.addEventListener("click", () => {
            if (!isWorkspaceReadyForBuildProfiles()) {
                return;
            }
            const id = generateBuildProfileId();
            const next = { id, name: "New profile", outDir: null, extraArgs: null };
            buildProfiles = buildProfiles.concat(next);
            buildProfileId = id;
            renderBuildProfileSelect();
            if (settingsBuildProfileSelect instanceof HTMLSelectElement) {
                settingsBuildProfileSelect.value = id;
            }
            renderBuildProfileFields();
            postBuildProfilesUpdate(false);
        });
    }
    if (settingsBuildProfileDelete instanceof HTMLButtonElement) {
        settingsBuildProfileDelete.addEventListener("click", () => {
            if (!isWorkspaceReadyForBuildProfiles()) {
                return;
            }
            const selectedId = getSelectedBuildProfileId();
            if (!selectedId) {
                return;
            }
            const selected = buildProfiles.find((profile) => profile.id === selectedId);
            if (!selected) {
                return;
            }
            const ok = window.confirm(`プロファイル「${selected.name || selected.id}」を削除しますか？`);
            if (!ok) {
                return;
            }
            buildProfiles = buildProfiles.filter((profile) => profile.id !== selectedId);
            buildProfileId = null;
            renderBuildProfileSelect();
            renderBuildProfileFields();
            postBuildProfilesUpdate(false);
        });
    }
    const handleBuildProfileTextChange = () => {
        if (!isWorkspaceReadyForBuildProfiles()) {
            return;
        }
        const selectedId = getSelectedBuildProfileId();
        if (!selectedId) {
            return;
        }
        const name = settingsBuildProfileName instanceof HTMLInputElement
            ? settingsBuildProfileName.value.trim()
            : "";
        const outDir = settingsBuildOutDir instanceof HTMLInputElement
            ? settingsBuildOutDir.value.trim()
            : "";
        const extraArgs = settingsBuildExtraArgs instanceof HTMLInputElement
            ? settingsBuildExtraArgs.value.trim()
            : "";
        updateSelectedProfile({
            name: name || selectedId,
            outDir: outDir || null,
            extraArgs: extraArgs || null,
        });
        if (settingsBuildProfileSelect instanceof HTMLSelectElement) {
            const option = Array.from(settingsBuildProfileSelect.options).find((entry) => entry.value === selectedId);
            if (option) {
                option.textContent = name || selectedId;
            }
        }
        updateBuildProfileHint("保存中...");
        scheduleBuildProfilesSave();
    };
    if (settingsBuildProfileName instanceof HTMLInputElement) {
        settingsBuildProfileName.addEventListener("input", () => {
            handleBuildProfileTextChange();
        });
    }
    if (settingsBuildOutDir instanceof HTMLInputElement) {
        settingsBuildOutDir.addEventListener("input", () => {
            handleBuildProfileTextChange();
        });
    }
    if (settingsBuildExtraArgs instanceof HTMLInputElement) {
        settingsBuildExtraArgs.addEventListener("input", () => {
            handleBuildProfileTextChange();
        });
    }
    const requestBuildClean = (deep) => {
        if (!isWorkspaceReadyForBuildProfiles()) {
            return;
        }
        const message = deep
            ? "clean -C を実行します。PDF なども削除されます。よろしいですか？"
            : "clean を実行します。補助ファイルを削除します。よろしいですか？";
        if (!window.confirm(message)) {
            return;
        }
        deps.postToNative({ type: "build:clean", deep: deep === true }, false);
    };
    if (settingsBuildCleanButton instanceof HTMLButtonElement) {
        settingsBuildCleanButton.addEventListener("click", () => {
            requestBuildClean(false);
        });
    }
    if (settingsBuildCleanAllButton instanceof HTMLButtonElement) {
        settingsBuildCleanAllButton.addEventListener("click", () => {
            requestBuildClean(true);
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
        getReverseSynctexEnabled: () => reverseSynctexEnabled,
        getPdfViewerMode: () => pdfViewerMode,
        getGhostCompletionEnabled: () => ghostCompletionEnabled,
        getGhostCompletionConfig: () => ({
            debounceMs: ghostCompletionDebounceMs,
            maxChars: ghostCompletionMaxChars,
        }),
        buildFormatSettingsPayload,
        getSettingsSnapshot,
        applySettingsPatch,
        checkEnvironmentStatus,
        updateEnvStatus,
        refreshCompileEngine: updateEngineUI,
        openSettingsPage: (pageId) => setSettingsPage(pageId),
        loadStartupSettings,
        loadWorkspaceSettings,
    };
};
