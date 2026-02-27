import { buildFormatSettingsPayload as buildFormatSettingsPayloadFromSettings, defaultEditorFormatSettings, normalizeEditorFormatSettings, normalizeVerbatimInput, } from "./settings-format.js";
import { clampNumber, loadGhostCompletionConfig, saveGhostCompletionConfig, } from "./settings-completion.js";
import { createEnvStatusManager, } from "./settings-env.js";
import { initBuildProfilesUi } from "./settings-build-profiles.js";
import { TEX64_LINKS } from "./platform-links.js";
import { getUiLocale, normalizeUiLocale, onUiLocaleChange, setUiLocale, } from "./i18n.js";
export const initSettingsUi = (context, deps) => {
    var _a, _b;
    const { settingsPanel, settingsNav, settingsNavItems, settingsPages, settingsPageItems, settingsBackButtons, settingsCompileEngineSelect, settingsEnvRefresh, editorAlignEnvToggle, editorFormatIndentSelect, editorFormatBeginEndToggle, editorFormatDocumentNoIndentToggle, editorFormatAlignMathToggle, editorFormatAlignTableToggle, editorFormatBlankLinesSelect, editorFormatVerbatimInput, editorFormatVerbatimAdd, editorFormatVerbatimHint, editorFormatVerbatimList, editorWordWrapToggle, settingsUiLanguageSelect, editorAutoSynctexBuildToggle, editorReverseSynctexToggle, editorGhostCompletionToggle, editorGhostCompletionDebounce, editorGhostCompletionMaxChars, editorPdfWindowToggle, settingsUpdateCurrent, settingsUpdateLatest, settingsUpdateStatus, settingsUpdateProgress, settingsUpdateProgressFill, settingsUpdateCheck, settingsUpdateApply, settingsUpdateOpen, settingsAuthStatus, settingsAuthLogin, settingsAuthLogout, settingsRuntimeAttention, settingsAccountAttention, settingsRuntimeInstallStatus, settingsRuntimeSetupStatus, settingsRuntimeOnboardingStatus, settingsRuntimeRunFirstBuild, settingsRuntimeOpenGettingStarted, settingsRuntimeOpenInstallDocs, settingsRuntimeOpenTexDocs, settingsFeedbackCategory, settingsFeedbackMessage, settingsFeedbackEmail, settingsFeedbackIncludeDiagnostics, settingsFeedbackSend, settingsFeedbackStatus, settingsErrorReportingEnabled, settingsLinkTerms, settingsLinkPrivacy, settingsLinkCommercial, settingsLinkRefund, settingsLinkSupport, settingsLinkContact, settingsLinkReleases, } = context.dom;
    let activeSettingsPage = null;
    let editorAlignEnvEnabled = true;
    let editorWordWrapEnabled = false;
    let editorFormatSettings = {
        ...defaultEditorFormatSettings,
    };
    let autoSynctexOnBuildEnabled = true;
    let reverseSynctexEnabled = true;
    let ghostCompletionEnabled = true;
    let ghostCompletionDebounceMs = 120;
    let ghostCompletionMaxChars = 140;
    let pdfViewerMode = "window";
    let platformAuth = null;
    let platformUpdate = null;
    let platformUpdateStatus = null;
    let updateAutoCheckStarted = false;
    let updateAutoCheckTimer = null;
    let runtimeStatusSummary = null;
    let runtimeSetupPromptInFlight = false;
    let feedbackPending = false;
    let feedbackQueue = [];
    let feedbackFlushTimer = null;
    let feedbackInFlightId = null;
    let feedbackIncludeDiagnostics = false;
    let errorReportingEnabled = true;
    const compileEngineKey = "tex64.compileEngine";
    const editorWordWrapKey = "tex64.editor.wordWrap";
    const editorAutoSynctexOnBuildKey = "tex64.editor.autoSynctexOnBuild";
    const editorReverseSynctexKey = "tex64.editor.reverseSynctex";
    const editorGhostCompletionKey = "tex64.editor.ghostCompletion";
    const syncUiLocaleSelect = () => {
        if (settingsUiLanguageSelect instanceof HTMLSelectElement) {
            settingsUiLanguageSelect.value = getUiLocale();
        }
    };
    syncUiLocaleSelect();
    onUiLocaleChange(() => syncUiLocaleSelect());
    if (settingsUiLanguageSelect instanceof HTMLSelectElement) {
        settingsUiLanguageSelect.addEventListener("change", () => {
            var _a;
            const next = (_a = normalizeUiLocale(settingsUiLanguageSelect.value)) !== null && _a !== void 0 ? _a : "ja";
            setUiLocale(next);
        });
    }
    const editorGhostCompletionDebounceKey = "tex64.editor.ghostCompletion.debounceMs";
    const editorGhostCompletionMaxCharsKey = "tex64.editor.ghostCompletion.maxChars";
    const editorAutoSynctexOnPdfOpenKey = "tex64.editor.autoSynctexOnPdfOpen";
    const editorPdfViewerModeKey = "tex64.editor.pdfViewerMode";
    const editorAlignEnvKey = "tex64.editor.alignEnv";
    const editorFormatSettingsKey = "tex64.editor.formatSettings";
    const runtimeSetupPromptedKey = "tex64.runtimeSetupPrompted.v1";
    const firstBuildCompletedKey = "tex64.onboarding.firstBuildCompleted.v1";
    const updateLastAutoCheckAtKey = "tex64.update.lastAutoCheckAt.v1";
    const feedbackQueueKey = "tex64.feedback.queue.v1";
    const feedbackIncludeDiagnosticsKey = "tex64.feedback.includeDiagnostics.v1";
    const errorReportingEnabledKey = "tex64.errorReporting.enabled.v1";
    const updateAutoCheckIntervalMs = 1000 * 60 * 60 * 6;
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
    ];
    const envDisplayTargets = ["lualatex", "latexmk", "latexindent", "synctex"];
    const envManager = createEnvStatusManager({
        postToNative: deps.postToNative,
        envCheckTargets,
        envDisplayTargets,
        texEngineCommands,
        onStatusSummaryChange: (summary) => {
            runtimeStatusSummary = summary;
            updateRuntimeSetupUi();
            syncUpdateAttentionUi();
            maybePromptRuntimeSetup(summary);
        },
    });
    const { checkEnvironmentStatus, updateEnvStatus } = envManager;
    const runtimeSettingsNavItem = (_a = settingsNavItems.find((button) => button.dataset.settingsTarget === "env")) !== null && _a !== void 0 ? _a : null;
    const accountSettingsNavItem = (_b = settingsNavItems.find((button) => button.dataset.settingsTarget === "account")) !== null && _b !== void 0 ? _b : null;
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
    const resolveEnvInstallTargetLabel = (target) => {
        if (target === "basictex") {
            return "TeX Distribution";
        }
        if (target === "latexmk") {
            return "latexmk";
        }
        return target || "実行環境";
    };
    const setRuntimeInstallStatus = (message, tone = "neutral") => {
        if (!(settingsRuntimeInstallStatus instanceof HTMLElement)) {
            return;
        }
        const text = typeof message === "string" ? message.trim() : "";
        const isVisible = Boolean(text);
        settingsRuntimeInstallStatus.textContent = text;
        settingsRuntimeInstallStatus.classList.toggle("is-hidden", !isVisible);
        settingsRuntimeInstallStatus.setAttribute("aria-hidden", isVisible ? "false" : "true");
        settingsRuntimeInstallStatus.classList.toggle("is-success", tone === "success");
        settingsRuntimeInstallStatus.classList.toggle("is-error", tone === "error");
    };
    const handleEnvInstallStart = (payload) => {
        const target = typeof (payload === null || payload === void 0 ? void 0 : payload.target) === "string" && payload.target.trim()
            ? payload.target.trim()
            : "";
        if (!target) {
            setRuntimeInstallStatus("インストールを開始しました。");
            return;
        }
        const label = resolveEnvInstallTargetLabel(target);
        setRuntimeInstallStatus(`${label} をインストールしています...`);
        envBtns
            .filter((btn) => btn.dataset.target === target)
            .forEach((btn) => {
            btn.textContent = "インストール中...";
            btn.disabled = true;
        });
    };
    const handleEnvInstallResult = (payload) => {
        const target = typeof (payload === null || payload === void 0 ? void 0 : payload.target) === "string" && payload.target.trim()
            ? payload.target.trim()
            : "";
        const success = (payload === null || payload === void 0 ? void 0 : payload.success) === true;
        const rawMessage = typeof (payload === null || payload === void 0 ? void 0 : payload.message) === "string" && payload.message.trim()
            ? payload.message.trim()
            : "";
        const label = resolveEnvInstallTargetLabel(target);
        const message = rawMessage ||
            (success
                ? `${label} のインストールを実行しました。`
                : `${label} のインストールに失敗しました。`);
        setRuntimeInstallStatus(message, success ? "success" : "error");
        checkEnvironmentStatus();
    };
    envBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
            const target = btn.dataset.target;
            if (!target) {
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
    const updateEditorWordWrapUI = () => {
        if (editorWordWrapToggle instanceof HTMLInputElement) {
            editorWordWrapToggle.checked = editorWordWrapEnabled;
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
    const buildProfilesUi = initBuildProfilesUi(context, {
        getWorkspaceRootKey: deps.getWorkspaceRootKey,
        getBuildProfiles: deps.getBuildProfiles,
        getBuildProfileId: deps.getBuildProfileId,
        postToNative: deps.postToNative,
    });
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
        syncUpdateAttentionUi();
        if (pageId === "env") {
            updateRuntimeOnboardingUi();
            checkEnvironmentStatus();
        }
        if (pageId === "env" || pageId === "account") {
            maybeRequestPlatformUpdateCheck(false);
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
    const loadEditorWordWrapState = () => {
        const stored = localStorage.getItem(editorWordWrapKey);
        editorWordWrapEnabled = stored === "true";
        updateEditorWordWrapUI();
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
            defaults: { debounceMs: 120, maxChars: 140 },
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
    const saveEditorWordWrapState = () => {
        localStorage.setItem(editorWordWrapKey, editorWordWrapEnabled ? "true" : "false");
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
    const openExternalUrl = (url) => {
        const normalized = typeof url === "string" ? url.trim() : "";
        if (!/^https?:\/\//i.test(normalized)) {
            return;
        }
        deps.postToNative({ type: "shell:openExternal", url: normalized }, true);
    };
    const formatBytes = (value) => {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            return "0 B";
        }
        if (value < 1024) {
            return `${Math.round(value)} B`;
        }
        if (value < 1024 * 1024) {
            return `${(value / 1024).toFixed(1)} KB`;
        }
        if (value < 1024 * 1024 * 1024) {
            return `${(value / (1024 * 1024)).toFixed(1)} MB`;
        }
        return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    };
    const resolveRuntimeMissingLabel = (key) => {
        if (key === "engine") {
            return "TeX Engine (lualatex / pdflatex / xelatex / uplatex)";
        }
        if (key === "latexmk") {
            return "latexmk";
        }
        if (key === "synctex") {
            return "synctex";
        }
        if (key === "latexindent") {
            return "latexindent";
        }
        return key;
    };
    const hasPromptedRuntimeSetup = () => {
        try {
            return localStorage.getItem(runtimeSetupPromptedKey) === "1";
        }
        catch {
            return false;
        }
    };
    const markRuntimeSetupPrompted = () => {
        try {
            localStorage.setItem(runtimeSetupPromptedKey, "1");
        }
        catch {
            // ignore storage failures
        }
    };
    const maybePromptRuntimeSetup = (summary) => {
        var _a;
        if (!summary || !summary.hasAnyResult || summary.runtimeReady) {
            runtimeSetupPromptInFlight = false;
            return;
        }
        if (runtimeSetupPromptInFlight || hasPromptedRuntimeSetup()) {
            return;
        }
        runtimeSetupPromptInFlight = true;
        markRuntimeSetupPrompted();
        (_a = deps.onRuntimeSetupNeeded) === null || _a === void 0 ? void 0 : _a.call(deps, summary);
    };
    const hasCompletedFirstBuild = () => {
        try {
            return localStorage.getItem(firstBuildCompletedKey) === "1";
        }
        catch {
            return false;
        }
    };
    const updateRuntimeOnboardingUi = () => {
        const summary = runtimeStatusSummary;
        const hasWorkspace = Boolean(deps.getWorkspaceRootKey());
        const firstBuildCompleted = hasCompletedFirstBuild();
        if (settingsRuntimeOnboardingStatus instanceof HTMLElement) {
            settingsRuntimeOnboardingStatus.classList.remove("is-warning", "is-success");
            if (!summary || !summary.hasAnyResult) {
                settingsRuntimeOnboardingStatus.textContent =
                    "初回セットアップ: 1) 実行環境を確認中 2) ワークスペースを開く 3) 最初のビルドを実行";
            }
            else if (firstBuildCompleted) {
                settingsRuntimeOnboardingStatus.classList.add("is-success");
                settingsRuntimeOnboardingStatus.textContent =
                    "初回セットアップ完了: いつでも Build を実行できます。";
            }
            else if (!summary.runtimeReady) {
                const missing = summary.missingRequired.map((item) => resolveRuntimeMissingLabel(item));
                settingsRuntimeOnboardingStatus.classList.add("is-warning");
                settingsRuntimeOnboardingStatus.textContent =
                    missing.length > 0
                        ? `初回セットアップ: 1/3 実行環境が不足 (${missing.join(", ")})。`
                        : "初回セットアップ: 1/3 実行環境が不足しています。";
            }
            else if (!hasWorkspace) {
                settingsRuntimeOnboardingStatus.classList.add("is-warning");
                settingsRuntimeOnboardingStatus.textContent =
                    "初回セットアップ: 2/3 ワークスペースを開いてください。";
            }
            else {
                settingsRuntimeOnboardingStatus.classList.add("is-success");
                settingsRuntimeOnboardingStatus.textContent =
                    "初回セットアップ: 3/3 最初のビルドを実行してください。";
            }
        }
        if (settingsRuntimeRunFirstBuild instanceof HTMLButtonElement) {
            const canRunBuild = Boolean((summary === null || summary === void 0 ? void 0 : summary.runtimeReady) && hasWorkspace);
            settingsRuntimeRunFirstBuild.disabled = !canRunBuild;
            settingsRuntimeRunFirstBuild.textContent = firstBuildCompleted
                ? "ビルドを実行"
                : "最初のビルドを実行";
        }
    };
    const updateRuntimeSetupUi = () => {
        if (!(settingsRuntimeSetupStatus instanceof HTMLElement)) {
            return;
        }
        const summary = runtimeStatusSummary;
        settingsRuntimeSetupStatus.classList.remove("is-warning", "is-success");
        if (!summary || !summary.hasAnyResult) {
            settingsRuntimeSetupStatus.textContent = "実行環境を確認中です。";
            updateRuntimeOnboardingUi();
            return;
        }
        if (summary.runtimeReady) {
            settingsRuntimeSetupStatus.classList.add("is-success");
            if (summary.missingRecommended.includes("latexindent")) {
                settingsRuntimeSetupStatus.textContent =
                    "利用開始の準備は完了しています（任意: latexindent 未検出）。";
            }
            else {
                settingsRuntimeSetupStatus.textContent = "利用開始の準備が完了しています。";
            }
            updateRuntimeOnboardingUi();
            return;
        }
        settingsRuntimeSetupStatus.classList.add("is-warning");
        const missing = summary.missingRequired.map((item) => resolveRuntimeMissingLabel(item));
        settingsRuntimeSetupStatus.textContent = `不足: ${missing.join(", ")}。TeX環境を整備して再チェックしてください。`;
        updateRuntimeOnboardingUi();
    };
    const hasRuntimeSetupAttention = () => Boolean((runtimeStatusSummary === null || runtimeStatusSummary === void 0 ? void 0 : runtimeStatusSummary.hasAnyResult) && (runtimeStatusSummary === null || runtimeStatusSummary === void 0 ? void 0 : runtimeStatusSummary.runtimeReady) === false);
    const hasUpdateAttention = () => {
        var _a;
        const phase = (_a = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.phase) !== null && _a !== void 0 ? _a : "idle";
        if (phase === "available" || phase === "downloaded" || phase === "error") {
            return true;
        }
        if (phase === "idle" && (platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.hasUpdate)) {
            return true;
        }
        return false;
    };
    const syncUpdateAttentionUi = () => {
        var _a;
        const updateAttention = hasUpdateAttention();
        const runtimeAttention = hasRuntimeSetupAttention();
        const anyAttention = updateAttention || runtimeAttention;
        const hideAlertWhileRuntimeOpen = activeSettingsPage === "env" || activeSettingsPage === "account";
        const showTabAlert = anyAttention && !hideAlertWhileRuntimeOpen;
        if (runtimeSettingsNavItem instanceof HTMLElement) {
            runtimeSettingsNavItem.classList.toggle("has-alert", runtimeAttention);
        }
        if (accountSettingsNavItem instanceof HTMLElement) {
            accountSettingsNavItem.classList.toggle("has-alert", updateAttention);
        }
        if (settingsRuntimeAttention instanceof HTMLElement) {
            settingsRuntimeAttention.textContent = "要設定";
            settingsRuntimeAttention.classList.toggle("is-hidden", !runtimeAttention);
            settingsRuntimeAttention.setAttribute("aria-hidden", runtimeAttention ? "false" : "true");
        }
        if (settingsAccountAttention instanceof HTMLElement) {
            settingsAccountAttention.textContent = "更新あり";
            settingsAccountAttention.classList.toggle("is-hidden", !updateAttention);
            settingsAccountAttention.setAttribute("aria-hidden", updateAttention ? "false" : "true");
        }
        (_a = deps.onUpdateAttentionChange) === null || _a === void 0 ? void 0 : _a.call(deps, showTabAlert);
    };
    const resolveUpdateStatusText = () => {
        var _a, _b, _c, _d, _e, _f;
        const phase = (_a = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.phase) !== null && _a !== void 0 ? _a : "idle";
        const latest = (_c = (_b = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.latestVersion) !== null && _b !== void 0 ? _b : platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.latestVersion) !== null && _c !== void 0 ? _c : null;
        if ((platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.message) && platformUpdateStatus.message.trim()) {
            return platformUpdateStatus.message.trim();
        }
        if (phase === "checking") {
            return "更新を確認しています。";
        }
        if (phase === "up-to-date") {
            return latest ? `最新バージョン ${latest} です。` : "最新状態です。";
        }
        if (phase === "available") {
            return latest ? `新しいバージョン ${latest} を利用できます。` : "新しいバージョンを利用できます。";
        }
        if (phase === "downloading") {
            const transferred = formatBytes((_d = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.transferredBytes) !== null && _d !== void 0 ? _d : 0);
            const total = formatBytes((_e = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.totalBytes) !== null && _e !== void 0 ? _e : 0);
            return `更新をダウンロード中です（${transferred} / ${total}）。`;
        }
        if (phase === "downloaded") {
            return "ダウンロード完了。適用ボタンでインストーラを起動できます。";
        }
        if (phase === "installing") {
            return "インストーラを起動しました。画面の手順に沿って更新してください。";
        }
        if (phase === "error") {
            const message = (_f = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.error) === null || _f === void 0 ? void 0 : _f.message;
            return message && message.trim()
                ? message.trim()
                : "アップデート処理に失敗しました。";
        }
        return "更新確認待ちです。";
    };
    const updatePlatformUpdateUi = () => {
        var _a, _b, _c, _d, _e, _f, _g;
        const currentVersion = (_b = (_a = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.currentVersion) !== null && _a !== void 0 ? _a : platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.currentVersion) !== null && _b !== void 0 ? _b : "-";
        const latestVersion = (_d = (_c = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.latestVersion) !== null && _c !== void 0 ? _c : platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.latestVersion) !== null && _d !== void 0 ? _d : "-";
        if (settingsUpdateCurrent instanceof HTMLElement) {
            settingsUpdateCurrent.textContent = currentVersion;
        }
        if (settingsUpdateLatest instanceof HTMLElement) {
            settingsUpdateLatest.textContent = latestVersion;
        }
        const statusText = resolveUpdateStatusText();
        if (settingsUpdateStatus instanceof HTMLElement) {
            settingsUpdateStatus.textContent = statusText;
            const phase = (_e = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.phase) !== null && _e !== void 0 ? _e : "idle";
            settingsUpdateStatus.classList.toggle("is-error", phase === "error");
            settingsUpdateStatus.classList.toggle("is-success", phase === "downloaded");
        }
        const progress = typeof (platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.progressPercent) === "number" &&
            Number.isFinite(platformUpdateStatus.progressPercent)
            ? Math.max(0, Math.min(100, platformUpdateStatus.progressPercent))
            : 0;
        const showProgress = ((_f = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.phase) !== null && _f !== void 0 ? _f : "") === "downloading";
        if (settingsUpdateProgress instanceof HTMLElement) {
            settingsUpdateProgress.classList.toggle("is-hidden", !showProgress);
            settingsUpdateProgress.setAttribute("aria-hidden", showProgress ? "false" : "true");
        }
        if (settingsUpdateProgressFill instanceof HTMLElement) {
            settingsUpdateProgressFill.style.width = `${progress}%`;
        }
        const phase = (_g = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.phase) !== null && _g !== void 0 ? _g : "idle";
        const hasUpdate = Boolean(platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.hasUpdate);
        const hasDownloadedInstaller = Boolean(platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.downloadedPath);
        if (settingsUpdateCheck instanceof HTMLButtonElement) {
            settingsUpdateCheck.disabled = phase === "checking" || phase === "downloading";
        }
        const canApplyUpdate = hasUpdate || hasDownloadedInstaller || phase === "available" || phase === "downloaded";
        if (settingsUpdateApply instanceof HTMLButtonElement) {
            settingsUpdateApply.classList.toggle("is-hidden", !canApplyUpdate);
            settingsUpdateApply.setAttribute("aria-hidden", canApplyUpdate ? "false" : "true");
            settingsUpdateApply.disabled =
                !canApplyUpdate ||
                    phase === "checking" ||
                    phase === "downloading" ||
                    phase === "installing";
        }
        if (settingsUpdateOpen instanceof HTMLButtonElement) {
            settingsUpdateOpen.disabled = false;
        }
        syncUpdateAttentionUi();
    };
    const updatePlatformAuthUi = () => {
        var _a;
        const authenticated = Boolean(platformAuth === null || platformAuth === void 0 ? void 0 : platformAuth.authenticated);
        const pending = Boolean(platformAuth === null || platformAuth === void 0 ? void 0 : platformAuth.pending);
        const userLabel = typeof ((_a = platformAuth === null || platformAuth === void 0 ? void 0 : platformAuth.user) === null || _a === void 0 ? void 0 : _a.email) === "string" && platformAuth.user.email.trim()
            ? platformAuth.user.email.trim()
            : "";
        if (settingsAuthStatus instanceof HTMLElement) {
            if (authenticated) {
                settingsAuthStatus.textContent = userLabel
                    ? `ログイン済み: ${userLabel}`
                    : "ログイン済み";
            }
            else if (pending) {
                settingsAuthStatus.textContent = "ログイン処理中";
            }
            else {
                settingsAuthStatus.textContent = "未ログイン";
            }
        }
        if (settingsAuthLogin instanceof HTMLButtonElement) {
            const showLogin = !authenticated;
            settingsAuthLogin.classList.toggle("is-hidden", !showLogin);
            settingsAuthLogin.setAttribute("aria-hidden", showLogin ? "false" : "true");
            settingsAuthLogin.disabled = pending;
            settingsAuthLogin.textContent = pending ? "ログイン処理中..." : "ログイン";
        }
        if (settingsAuthLogout instanceof HTMLButtonElement) {
            settingsAuthLogout.classList.toggle("is-hidden", !authenticated);
            settingsAuthLogout.disabled = !authenticated;
        }
    };
    const handlePlatformAuth = (payload) => {
        var _a;
        platformAuth = (_a = payload === null || payload === void 0 ? void 0 : payload.auth) !== null && _a !== void 0 ? _a : null;
        updatePlatformAuthUi();
    };
    const handlePlatformUpdate = (payload) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
        platformUpdate = (_a = payload === null || payload === void 0 ? void 0 : payload.update) !== null && _a !== void 0 ? _a : null;
        if (platformUpdateStatus) {
            platformUpdateStatus = {
                ...platformUpdateStatus,
                latestVersion: (_c = (_b = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.latestVersion) !== null && _b !== void 0 ? _b : platformUpdateStatus.latestVersion) !== null && _c !== void 0 ? _c : null,
                currentVersion: (_e = (_d = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.currentVersion) !== null && _d !== void 0 ? _d : platformUpdateStatus.currentVersion) !== null && _e !== void 0 ? _e : null,
            };
        }
        if ((_f = payload === null || payload === void 0 ? void 0 : payload.error) === null || _f === void 0 ? void 0 : _f.message) {
            platformUpdateStatus = {
                phase: "error",
                mode: (_g = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.mode) !== null && _g !== void 0 ? _g : null,
                message: payload.error.message,
                progressPercent: null,
                transferredBytes: null,
                totalBytes: null,
                downloadedPath: (_h = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.downloadedPath) !== null && _h !== void 0 ? _h : null,
                currentVersion: (_k = (_j = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.currentVersion) !== null && _j !== void 0 ? _j : platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.currentVersion) !== null && _k !== void 0 ? _k : null,
                latestVersion: (_m = (_l = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.latestVersion) !== null && _l !== void 0 ? _l : platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.latestVersion) !== null && _m !== void 0 ? _m : null,
                checkedAt: (_o = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.checkedAt) !== null && _o !== void 0 ? _o : Date.now(),
                updatedAt: Date.now(),
                error: {
                    code: (_p = payload.error.code) !== null && _p !== void 0 ? _p : null,
                    message: payload.error.message,
                },
            };
        }
        updatePlatformUpdateUi();
    };
    const handlePlatformUpdateStatus = (payload) => {
        var _a;
        const status = (_a = payload === null || payload === void 0 ? void 0 : payload.status) !== null && _a !== void 0 ? _a : null;
        if (!status) {
            return;
        }
        platformUpdateStatus = {
            ...status,
            updatedAt: typeof status.updatedAt === "number" && Number.isFinite(status.updatedAt)
                ? status.updatedAt
                : Date.now(),
        };
        updatePlatformUpdateUi();
    };
    const setFeedbackStatus = (message, tone = "neutral") => {
        if (!(settingsFeedbackStatus instanceof HTMLElement)) {
            return;
        }
        settingsFeedbackStatus.textContent = message;
        settingsFeedbackStatus.classList.toggle("is-hidden", message.trim().length === 0);
        settingsFeedbackStatus.classList.toggle("is-success", tone === "success");
        settingsFeedbackStatus.classList.toggle("is-error", tone === "error");
    };
    const updateFeedbackSendState = () => {
        if (!(settingsFeedbackSend instanceof HTMLButtonElement)) {
            return;
        }
        settingsFeedbackSend.disabled = feedbackPending;
        settingsFeedbackSend.textContent = feedbackPending ? "送信中..." : "送信";
    };
    const saveFeedbackQueue = () => {
        try {
            localStorage.setItem(feedbackQueueKey, JSON.stringify(feedbackQueue));
        }
        catch {
            // ignore storage failures
        }
    };
    const normalizeFeedbackQueueItem = (value) => {
        if (!value || typeof value !== "object") {
            return null;
        }
        const record = value;
        const id = typeof record.id === "string" && record.id.trim()
            ? record.id.trim()
            : `fb-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
        const rawCategory = typeof record.category === "string" && record.category.trim()
            ? record.category.trim()
            : "other";
        const category = rawCategory === "bug" ||
            rawCategory === "idea" ||
            rawCategory === "other" ||
            rawCategory === "general"
            ? rawCategory
            : "other";
        const message = typeof record.message === "string" && record.message.trim()
            ? record.message.trim()
            : "";
        if (!message) {
            return null;
        }
        const contactEmail = typeof record.contactEmail === "string" && record.contactEmail.trim()
            ? record.contactEmail.trim()
            : undefined;
        const diagnostics = record.diagnostics && typeof record.diagnostics === "object"
            ? record.diagnostics
            : undefined;
        const createdAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
            ? record.createdAt
            : Date.now();
        const attempts = typeof record.attempts === "number" && Number.isFinite(record.attempts)
            ? Math.max(0, Math.round(record.attempts))
            : 0;
        const nextRetryAt = typeof record.nextRetryAt === "number" && Number.isFinite(record.nextRetryAt)
            ? Math.max(0, Math.round(record.nextRetryAt))
            : 0;
        return {
            id,
            category,
            message,
            contactEmail,
            diagnostics,
            createdAt,
            attempts,
            nextRetryAt,
        };
    };
    const loadFeedbackQueue = () => {
        const raw = localStorage.getItem(feedbackQueueKey);
        if (!raw) {
            feedbackQueue = [];
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                feedbackQueue = [];
                return;
            }
            feedbackQueue = parsed
                .map((entry) => normalizeFeedbackQueueItem(entry))
                .filter((entry) => Boolean(entry));
            saveFeedbackQueue();
        }
        catch {
            feedbackQueue = [];
        }
    };
    const readFeedbackIncludeDiagnosticsState = () => {
        try {
            const stored = localStorage.getItem(feedbackIncludeDiagnosticsKey);
            return stored === "true";
        }
        catch {
            return false;
        }
    };
    const saveFeedbackIncludeDiagnosticsState = () => {
        try {
            localStorage.setItem(feedbackIncludeDiagnosticsKey, feedbackIncludeDiagnostics ? "true" : "false");
        }
        catch {
            // ignore storage failures
        }
    };
    const updateFeedbackIncludeDiagnosticsUi = () => {
        if (settingsFeedbackIncludeDiagnostics instanceof HTMLInputElement) {
            settingsFeedbackIncludeDiagnostics.checked = feedbackIncludeDiagnostics;
        }
    };
    const readErrorReportingEnabledState = () => {
        try {
            const stored = localStorage.getItem(errorReportingEnabledKey);
            if (stored === null) {
                return true;
            }
            return stored !== "false";
        }
        catch {
            return true;
        }
    };
    const saveErrorReportingEnabledState = () => {
        try {
            localStorage.setItem(errorReportingEnabledKey, errorReportingEnabled ? "true" : "false");
        }
        catch {
            // ignore storage failures
        }
    };
    const updateErrorReportingUi = () => {
        if (settingsErrorReportingEnabled instanceof HTMLInputElement) {
            settingsErrorReportingEnabled.checked = errorReportingEnabled;
        }
    };
    const syncErrorReportingEnabled = () => {
        deps.postToNative({
            type: "error:reporting:set",
            enabled: errorReportingEnabled,
        }, true);
    };
    const buildFeedbackDiagnostics = () => {
        var _a;
        if (!feedbackIncludeDiagnostics) {
            return undefined;
        }
        const diagnostics = {
            source: "settings-feedback-form",
            sentAt: new Date().toISOString(),
            appUrl: typeof ((_a = window.location) === null || _a === void 0 ? void 0 : _a.href) === "string" ? window.location.href : "",
            online: typeof (navigator === null || navigator === void 0 ? void 0 : navigator.onLine) === "boolean" ? navigator.onLine : undefined,
            language: typeof (navigator === null || navigator === void 0 ? void 0 : navigator.language) === "string" ? navigator.language : undefined,
            userAgent: typeof (navigator === null || navigator === void 0 ? void 0 : navigator.userAgent) === "string" ? navigator.userAgent : undefined,
        };
        if (Array.isArray(navigator === null || navigator === void 0 ? void 0 : navigator.languages) && navigator.languages.length > 0) {
            diagnostics.languages = navigator.languages.slice(0, 8);
        }
        return diagnostics;
    };
    const computeFeedbackRetryDelayMs = (attempts) => {
        const safeAttempts = Math.max(1, Math.round(attempts));
        const baseMs = 5000;
        return Math.min(1000 * 60 * 5, baseMs * 2 ** Math.min(7, safeAttempts - 1));
    };
    const scheduleFeedbackFlush = (delayMs = 0) => {
        if (feedbackFlushTimer !== null) {
            window.clearTimeout(feedbackFlushTimer);
            feedbackFlushTimer = null;
        }
        feedbackFlushTimer = window.setTimeout(() => {
            feedbackFlushTimer = null;
            flushFeedbackQueue();
        }, Math.max(0, Math.round(delayMs)));
    };
    const removeFeedbackQueueItem = (itemId) => {
        if (!itemId) {
            return null;
        }
        const index = feedbackQueue.findIndex((entry) => entry.id === itemId);
        if (index < 0) {
            return null;
        }
        const [removed] = feedbackQueue.splice(index, 1);
        saveFeedbackQueue();
        return removed !== null && removed !== void 0 ? removed : null;
    };
    const markFeedbackRetry = (item, baseMessage) => {
        item.attempts = Math.max(0, item.attempts) + 1;
        const delayMs = computeFeedbackRetryDelayMs(item.attempts);
        item.nextRetryAt = Date.now() + delayMs;
        saveFeedbackQueue();
        const seconds = Math.max(1, Math.round(delayMs / 1000));
        const prefix = typeof baseMessage === "string" && baseMessage.trim()
            ? baseMessage.trim()
            : "フィードバック送信に失敗しました。再送します。";
        setFeedbackStatus(`${prefix} (${seconds}秒後に再試行)`, "error");
        scheduleFeedbackFlush(delayMs + 60);
    };
    const flushFeedbackQueue = () => {
        if (feedbackPending) {
            return;
        }
        if (feedbackQueue.length === 0) {
            return;
        }
        const now = Date.now();
        let nextItem = null;
        for (const entry of feedbackQueue) {
            if (entry.nextRetryAt <= now) {
                nextItem = entry;
                break;
            }
        }
        if (!nextItem) {
            const nextRetryAt = feedbackQueue.reduce((min, entry) => {
                if (!Number.isFinite(entry.nextRetryAt) || entry.nextRetryAt <= 0) {
                    return min;
                }
                return Math.min(min, entry.nextRetryAt);
            }, Number.POSITIVE_INFINITY);
            if (Number.isFinite(nextRetryAt)) {
                scheduleFeedbackFlush(Math.max(250, nextRetryAt - now));
            }
            return;
        }
        feedbackPending = true;
        feedbackInFlightId = nextItem.id;
        updateFeedbackSendState();
        setFeedbackStatus("フィードバックを送信しています...");
        const posted = deps.postToNative({
            type: "feedback:send",
            category: nextItem.category,
            message: nextItem.message,
            contactEmail: nextItem.contactEmail || undefined,
            diagnostics: nextItem.diagnostics || undefined,
        }, true);
        if (!posted) {
            feedbackPending = false;
            feedbackInFlightId = null;
            updateFeedbackSendState();
            markFeedbackRetry(nextItem, "フィードバック送信を開始できませんでした。");
        }
    };
    const sendFeedback = () => {
        if (!(settingsFeedbackMessage instanceof HTMLTextAreaElement)) {
            return;
        }
        const message = settingsFeedbackMessage.value.trim();
        if (!message) {
            setFeedbackStatus("フィードバック内容を入力してください。", "error");
            settingsFeedbackMessage.focus();
            return;
        }
        const rawCategory = settingsFeedbackCategory instanceof HTMLSelectElement
            ? settingsFeedbackCategory.value
            : "";
        const category = rawCategory === "bug" || rawCategory === "idea" || rawCategory === "other"
            ? rawCategory
            : "other";
        const contactEmail = settingsFeedbackEmail instanceof HTMLInputElement
            ? settingsFeedbackEmail.value.trim()
            : "";
        if (contactEmail &&
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
            setFeedbackStatus("連絡先メールアドレスの形式を確認してください。", "error");
            settingsFeedbackEmail.focus();
            return;
        }
        const item = {
            id: `fb-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
            category,
            message,
            contactEmail: contactEmail || undefined,
            diagnostics: buildFeedbackDiagnostics(),
            createdAt: Date.now(),
            attempts: 0,
            nextRetryAt: 0,
        };
        feedbackQueue.push(item);
        saveFeedbackQueue();
        setFeedbackStatus("送信キューに追加しました。");
        flushFeedbackQueue();
    };
    const handlePlatformFeedback = (payload) => {
        var _a, _b;
        const inFlightId = feedbackInFlightId;
        const inFlightItem = inFlightId !== null
            ? (_a = feedbackQueue.find((entry) => entry.id === inFlightId)) !== null && _a !== void 0 ? _a : null
            : null;
        feedbackPending = false;
        feedbackInFlightId = null;
        updateFeedbackSendState();
        if (payload === null || payload === void 0 ? void 0 : payload.ok) {
            const removed = removeFeedbackQueueItem(inFlightId);
            if (removed &&
                settingsFeedbackMessage instanceof HTMLTextAreaElement &&
                settingsFeedbackMessage.value.trim() === removed.message) {
                settingsFeedbackMessage.value = "";
            }
            const suffix = payload.feedbackId ? ` (ID: ${payload.feedbackId})` : "";
            const remainCount = feedbackQueue.length;
            const remainLabel = remainCount > 0 ? ` 残り${remainCount}件を再送待ちです。` : "";
            setFeedbackStatus(`フィードバックを送信しました${suffix}${remainLabel}`, "success");
            scheduleFeedbackFlush(40);
            return;
        }
        const message = ((_b = payload === null || payload === void 0 ? void 0 : payload.error) === null || _b === void 0 ? void 0 : _b.message) && payload.error.message.trim()
            ? payload.error.message.trim()
            : "フィードバック送信に失敗しました。";
        if (inFlightItem) {
            markFeedbackRetry(inFlightItem, `${message} 再送キューに保存しました。`);
            return;
        }
        setFeedbackStatus(message, "error");
    };
    const setEditorAlignEnvEnabled = (enabled) => {
        editorAlignEnvEnabled = Boolean(enabled);
        saveEditorAlignEnvState();
        updateEditorAlignEnvUI();
    };
    const setEditorWordWrapEnabled = (enabled) => {
        var _a;
        editorWordWrapEnabled = Boolean(enabled);
        saveEditorWordWrapState();
        updateEditorWordWrapUI();
        (_a = deps.onEditorWordWrapChange) === null || _a === void 0 ? void 0 : _a.call(deps, editorWordWrapEnabled);
    };
    const toggleEditorAlignEnv = () => {
        editorAlignEnvEnabled = !editorAlignEnvEnabled;
        saveEditorAlignEnvState();
        updateEditorAlignEnvUI();
    };
    const toggleEditorWordWrap = () => {
        var _a;
        editorWordWrapEnabled = !editorWordWrapEnabled;
        saveEditorWordWrapState();
        updateEditorWordWrapUI();
        (_a = deps.onEditorWordWrapChange) === null || _a === void 0 ? void 0 : _a.call(deps, editorWordWrapEnabled);
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
    const readUpdateLastAutoCheckAt = () => {
        try {
            const raw = localStorage.getItem(updateLastAutoCheckAtKey);
            if (!raw) {
                return 0;
            }
            const parsed = Number.parseInt(raw, 10);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                return 0;
            }
            return parsed;
        }
        catch {
            return 0;
        }
    };
    const markUpdateAutoCheckAt = (timestamp) => {
        if (!Number.isFinite(timestamp) || timestamp <= 0) {
            return;
        }
        try {
            localStorage.setItem(updateLastAutoCheckAtKey, String(Math.round(timestamp)));
        }
        catch {
            // ignore storage failures
        }
    };
    const scheduleUpdateAutoCheck = () => {
        if (updateAutoCheckTimer !== null) {
            window.clearTimeout(updateAutoCheckTimer);
            updateAutoCheckTimer = null;
        }
        const now = Date.now();
        const last = readUpdateLastAutoCheckAt();
        const elapsed = Math.max(0, now - last);
        const remaining = Math.max(30000, updateAutoCheckIntervalMs - elapsed);
        updateAutoCheckTimer = window.setTimeout(() => {
            updateAutoCheckTimer = null;
            maybeRequestPlatformUpdateCheck(false);
            scheduleUpdateAutoCheck();
        }, remaining);
    };
    const maybeRequestPlatformUpdateCheck = (force = false) => {
        deps.postToNative({ type: "update:status:get" }, true);
        let dispatched = false;
        if (force) {
            markUpdateAutoCheckAt(Date.now());
            updateAutoCheckStarted = true;
            deps.postToNative({ type: "update:check", force: true }, true);
            dispatched = true;
            scheduleUpdateAutoCheck();
            return dispatched;
        }
        if (!updateAutoCheckStarted) {
            updateAutoCheckStarted = true;
            markUpdateAutoCheckAt(Date.now());
            deps.postToNative({ type: "update:check", force: false, source: "background" }, true);
            dispatched = true;
            scheduleUpdateAutoCheck();
            return dispatched;
        }
        const now = Date.now();
        const last = readUpdateLastAutoCheckAt();
        if (now - last >= updateAutoCheckIntervalMs) {
            markUpdateAutoCheckAt(now);
            deps.postToNative({ type: "update:check", force: false, source: "background" }, true);
            dispatched = true;
        }
        scheduleUpdateAutoCheck();
        return dispatched;
    };
    const loadStartupSettings = () => {
        loadEditorWordWrapState();
        loadEditorAutoSynctexBuildState();
        loadEditorReverseSynctexState();
        loadEditorGhostCompletionState();
        loadEditorGhostCompletionConfig();
        loadEditorPdfViewerModeState();
        loadFeedbackQueue();
        feedbackIncludeDiagnostics = readFeedbackIncludeDiagnosticsState();
        updateFeedbackIncludeDiagnosticsUi();
        errorReportingEnabled = readErrorReportingEnabledState();
        updateErrorReportingUi();
        syncErrorReportingEnabled();
        if (feedbackQueue.length > 0) {
            scheduleFeedbackFlush(200);
        }
        checkEnvironmentStatus();
        deps.postToNative({ type: "platform:state:get" }, true);
        maybeRequestPlatformUpdateCheck(false);
        updateRuntimeOnboardingUi();
    };
    const loadWorkspaceSettings = () => {
        loadStartupSettings();
        loadEditorAlignEnvState();
        loadEditorFormatSettings();
        buildProfilesUi.render();
        updateRuntimeOnboardingUi();
    };
    const getSettingsSnapshot = () => ({
        compileEngine: localStorage.getItem(compileEngineKey) || "lualatex",
        wordWrapEnabled: editorWordWrapEnabled,
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
        if (typeof patch.wordWrapEnabled === "boolean") {
            setEditorWordWrapEnabled(patch.wordWrapEnabled);
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
    if (settingsEnvRefresh instanceof HTMLButtonElement) {
        settingsEnvRefresh.addEventListener("click", () => {
            checkEnvironmentStatus();
        });
    }
    if (settingsUpdateCheck instanceof HTMLButtonElement) {
        settingsUpdateCheck.addEventListener("click", () => {
            maybeRequestPlatformUpdateCheck(true);
        });
    }
    if (settingsUpdateApply instanceof HTMLButtonElement) {
        settingsUpdateApply.addEventListener("click", () => {
            var _a;
            const phase = (_a = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.phase) !== null && _a !== void 0 ? _a : "idle";
            const hasDownloadedInstaller = Boolean(platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.downloadedPath);
            if (phase === "downloaded" || hasDownloadedInstaller) {
                deps.postToNative({ type: "update:install", openFallbackOnError: true }, true);
                return;
            }
            deps.postToNative({
                type: "update:download",
                forceCheck: true,
                autoInstall: true,
                openFallbackOnError: true,
            }, true);
        });
    }
    if (settingsUpdateOpen instanceof HTMLButtonElement) {
        settingsUpdateOpen.addEventListener("click", () => {
            var _a, _b;
            const fallbackUrl = (_b = (_a = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.artifactUrl) !== null && _a !== void 0 ? _a : platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.notesUrl) !== null && _b !== void 0 ? _b : TEX64_LINKS.download;
            openExternalUrl(fallbackUrl);
        });
    }
    if (settingsAuthLogout instanceof HTMLButtonElement) {
        settingsAuthLogout.addEventListener("click", () => {
            deps.postToNative({ type: "auth:signout" });
        });
    }
    if (settingsAuthLogin instanceof HTMLButtonElement) {
        settingsAuthLogin.addEventListener("click", () => {
            if (settingsAuthLogin.disabled) {
                return;
            }
            deps.postToNative({ type: "auth:google:start" });
        });
    }
    if (settingsRuntimeOpenInstallDocs instanceof HTMLButtonElement) {
        settingsRuntimeOpenInstallDocs.addEventListener("click", () => {
            openExternalUrl(TEX64_LINKS.docsInstallMac);
        });
    }
    if (settingsRuntimeOpenGettingStarted instanceof HTMLButtonElement) {
        settingsRuntimeOpenGettingStarted.addEventListener("click", () => {
            openExternalUrl(TEX64_LINKS.docsGettingStarted);
        });
    }
    if (settingsRuntimeOpenTexDocs instanceof HTMLButtonElement) {
        settingsRuntimeOpenTexDocs.addEventListener("click", () => {
            openExternalUrl(TEX64_LINKS.docsTexDistribution);
        });
    }
    if (settingsRuntimeRunFirstBuild instanceof HTMLButtonElement) {
        settingsRuntimeRunFirstBuild.addEventListener("click", () => {
            var _a;
            if (settingsRuntimeRunFirstBuild.disabled) {
                return;
            }
            (_a = deps.onRequestFirstBuild) === null || _a === void 0 ? void 0 : _a.call(deps);
        });
    }
    const settingsLinkEntries = [
        { button: settingsLinkTerms, url: TEX64_LINKS.legalTerms },
        { button: settingsLinkPrivacy, url: TEX64_LINKS.legalPrivacy },
        { button: settingsLinkCommercial, url: TEX64_LINKS.legalCommercial },
        { button: settingsLinkRefund, url: TEX64_LINKS.legalRefund },
        { button: settingsLinkSupport, url: TEX64_LINKS.support },
        { button: settingsLinkContact, url: TEX64_LINKS.contact },
        { button: settingsLinkReleases, url: TEX64_LINKS.releases },
    ];
    settingsLinkEntries.forEach((entry) => {
        if (!(entry.button instanceof HTMLButtonElement)) {
            return;
        }
        entry.button.addEventListener("click", () => {
            openExternalUrl(entry.url);
        });
    });
    if (settingsFeedbackSend instanceof HTMLButtonElement) {
        settingsFeedbackSend.addEventListener("click", () => {
            sendFeedback();
        });
    }
    if (settingsFeedbackMessage instanceof HTMLTextAreaElement) {
        settingsFeedbackMessage.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                sendFeedback();
            }
        });
    }
    if (settingsFeedbackIncludeDiagnostics instanceof HTMLInputElement) {
        settingsFeedbackIncludeDiagnostics.addEventListener("change", () => {
            feedbackIncludeDiagnostics = settingsFeedbackIncludeDiagnostics.checked;
            saveFeedbackIncludeDiagnosticsState();
            updateFeedbackIncludeDiagnosticsUi();
        });
    }
    if (settingsErrorReportingEnabled instanceof HTMLInputElement) {
        settingsErrorReportingEnabled.addEventListener("change", () => {
            errorReportingEnabled = settingsErrorReportingEnabled.checked;
            saveErrorReportingEnabledState();
            updateErrorReportingUi();
            syncErrorReportingEnabled();
        });
    }
    window.addEventListener("online", () => {
        scheduleFeedbackFlush(120);
    });
    updateFeedbackSendState();
    setFeedbackStatus("");
    updateFeedbackIncludeDiagnosticsUi();
    updateErrorReportingUi();
    updatePlatformAuthUi();
    updateRuntimeSetupUi();
    updateRuntimeOnboardingUi();
    updatePlatformUpdateUi();
    return {
        getEditorAlignEnvEnabled: () => editorAlignEnvEnabled,
        getEditorWordWrapEnabled: () => editorWordWrapEnabled,
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
        handleEnvInstallStart,
        handleEnvInstallResult,
        refreshCompileEngine: updateEngineUI,
        handlePlatformFeedback,
        handlePlatformAuth,
        handlePlatformUpdate,
        handlePlatformUpdateStatus,
        openSettingsPage: (pageId) => setSettingsPage(pageId),
        getRuntimeStatusSummary: () => runtimeStatusSummary ? { ...runtimeStatusSummary } : null,
        loadStartupSettings,
        loadWorkspaceSettings,
    };
};
