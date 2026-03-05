import { initBuildProfilesUi } from "../settings-build-profiles.js";
import { TEX64_LINKS } from "../platform-links.js";
import { createSettingsUiRuntime } from "./runtime.js";
import { initSettingsUiLocale } from "./ui-locale.js";
import { createSettingsAttentionOps } from "./attention.js";
import { createSettingsEngineOps } from "./engine-ops.js";
import { createSettingsFormatOps } from "./format-ops.js";
import { createSettingsEditorPreferenceOps } from "./editor-preferences-ops.js";
import { createSettingsEnvOps } from "./env-ops.js";
import { createSettingsPlatformAuthOps } from "./platform-auth-ops.js";
import { createSettingsPlatformUpdateOps } from "./platform-update-ops.js";
import { createSettingsFeedbackOps } from "./feedback-ops.js";
import { createSettingsPageNavOps } from "./page-nav-ops.js";
import { openExternalUrl } from "./utils.js";
export const initSettingsUi = (context, deps) => {
    const runtime = createSettingsUiRuntime(context, deps);
    initSettingsUiLocale(runtime);
    const attentionOps = createSettingsAttentionOps(runtime);
    const engineOps = createSettingsEngineOps(runtime);
    const formatOps = createSettingsFormatOps(runtime);
    const editorPrefOps = createSettingsEditorPreferenceOps(runtime);
    const envOps = createSettingsEnvOps(runtime, attentionOps);
    const platformAuthOps = createSettingsPlatformAuthOps(runtime);
    const platformUpdateOps = createSettingsPlatformUpdateOps(runtime, attentionOps);
    const feedbackOps = createSettingsFeedbackOps(runtime);
    const buildProfilesUi = initBuildProfilesUi(context, {
        getWorkspaceRootKey: deps.getWorkspaceRootKey,
        getBuildProfiles: deps.getBuildProfiles,
        getBuildProfileId: deps.getBuildProfileId,
        postToNative: deps.postToNative,
    });
    const pageNavOps = createSettingsPageNavOps(runtime, attentionOps, {
        checkEnvironmentStatus: envOps.checkEnvironmentStatus,
        updateRuntimeOnboardingUi: envOps.updateRuntimeOnboardingUi,
        maybeRequestPlatformUpdateCheck: platformUpdateOps.maybeRequestPlatformUpdateCheck,
    });
    const loadStartupSettings = () => {
        editorPrefOps.loadEditorWordWrapState();
        editorPrefOps.loadEditorAutoSynctexBuildState();
        editorPrefOps.loadEditorReverseSynctexState();
        editorPrefOps.loadEditorGhostCompletionState();
        editorPrefOps.loadEditorGhostCompletionConfig();
        editorPrefOps.loadEditorPdfViewerModeState();
        feedbackOps.loadStartupFeedbackState();
        envOps.checkEnvironmentStatus();
        deps.postToNative({ type: "platform:state:get" }, true);
        platformUpdateOps.maybeRequestPlatformUpdateCheck(false);
        envOps.updateRuntimeOnboardingUi();
    };
    const loadWorkspaceSettings = () => {
        loadStartupSettings();
        editorPrefOps.loadEditorAlignEnvState();
        formatOps.loadEditorFormatSettings();
        buildProfilesUi.render();
        envOps.updateRuntimeOnboardingUi();
    };
    const getSettingsSnapshot = () => ({
        compileEngine: localStorage.getItem(runtime.keys.compileEngineKey) || "lualatex",
        wordWrapEnabled: runtime.state.editorWordWrapEnabled,
        autoSynctexOnBuild: runtime.state.autoSynctexOnBuildEnabled,
        reverseSynctexEnabled: runtime.state.reverseSynctexEnabled,
        pdfViewerMode: runtime.state.pdfViewerMode,
        ghostCompletionEnabled: runtime.state.ghostCompletionEnabled,
        ghostCompletionDebounceMs: runtime.state.ghostCompletionDebounceMs,
        ghostCompletionMaxChars: runtime.state.ghostCompletionMaxChars,
        alignEnv: runtime.state.editorAlignEnvEnabled,
        formatSettings: {
            ...runtime.state.editorFormatSettings,
            customVerbatim: [...runtime.state.editorFormatSettings.customVerbatim],
        },
    });
    const applySettingsPatch = (patch) => {
        if (!patch || typeof patch !== "object") {
            return getSettingsSnapshot();
        }
        if (typeof patch.compileEngine === "string") {
            engineOps.setCompileEngine(patch.compileEngine);
        }
        if (typeof patch.wordWrapEnabled === "boolean") {
            editorPrefOps.setEditorWordWrapEnabled(patch.wordWrapEnabled);
        }
        if (typeof patch.autoSynctexOnBuild === "boolean") {
            editorPrefOps.setEditorAutoSynctexBuildEnabled(patch.autoSynctexOnBuild);
        }
        if (typeof patch.reverseSynctexEnabled === "boolean") {
            editorPrefOps.setEditorReverseSynctexEnabled(patch.reverseSynctexEnabled);
        }
        if (typeof patch.ghostCompletionEnabled === "boolean") {
            editorPrefOps.setGhostCompletionEnabled(patch.ghostCompletionEnabled);
        }
        if (typeof patch.ghostCompletionDebounceMs === "number") {
            editorPrefOps.setGhostCompletionConfig({ debounceMs: patch.ghostCompletionDebounceMs });
        }
        if (typeof patch.ghostCompletionMaxChars === "number") {
            editorPrefOps.setGhostCompletionConfig({ maxChars: patch.ghostCompletionMaxChars });
        }
        if (patch.pdfViewerMode === "window" || patch.pdfViewerMode === "tab") {
            editorPrefOps.setPdfViewerMode(patch.pdfViewerMode);
        }
        if (typeof patch.alignEnv === "boolean") {
            editorPrefOps.setEditorAlignEnvEnabled(patch.alignEnv);
        }
        if (patch.formatSettings && typeof patch.formatSettings === "object") {
            formatOps.setEditorFormatSettings(patch.formatSettings);
        }
        return getSettingsSnapshot();
    };
    const settingsLinkEntries = [
        { button: context.dom.settingsLinkTerms, url: TEX64_LINKS.legalTerms },
        { button: context.dom.settingsLinkPrivacy, url: TEX64_LINKS.legalPrivacy },
        { button: context.dom.settingsLinkCommercial, url: TEX64_LINKS.legalCommercial },
        { button: context.dom.settingsLinkRefund, url: TEX64_LINKS.legalRefund },
        { button: context.dom.settingsLinkSupport, url: TEX64_LINKS.support },
        { button: context.dom.settingsLinkContact, url: TEX64_LINKS.contact },
        { button: context.dom.settingsLinkReleases, url: TEX64_LINKS.releases },
    ];
    settingsLinkEntries.forEach((entry) => {
        if (!(entry.button instanceof HTMLButtonElement)) {
            return;
        }
        entry.button.addEventListener("click", () => {
            openExternalUrl(runtime, entry.url);
        });
    });
    pageNavOps.setSettingsPage(runtime.state.activeSettingsPage);
    engineOps.updateEngineUI();
    feedbackOps.initFeedbackUi();
    platformAuthOps.updatePlatformAuthUi();
    envOps.updateRuntimeSetupUi();
    envOps.updateRuntimeOnboardingUi();
    platformUpdateOps.updatePlatformUpdateUi();
    return {
        getEditorAlignEnvEnabled: () => runtime.state.editorAlignEnvEnabled,
        getEditorWordWrapEnabled: () => runtime.state.editorWordWrapEnabled,
        getAutoSynctexOnBuildEnabled: () => runtime.state.autoSynctexOnBuildEnabled,
        getReverseSynctexEnabled: () => runtime.state.reverseSynctexEnabled,
        getPdfViewerMode: () => runtime.state.pdfViewerMode,
        getGhostCompletionEnabled: () => runtime.state.ghostCompletionEnabled,
        getGhostCompletionConfig: editorPrefOps.getGhostCompletionConfig,
        buildFormatSettingsPayload: formatOps.buildFormatSettingsPayload,
        getSettingsSnapshot,
        applySettingsPatch,
        checkEnvironmentStatus: envOps.checkEnvironmentStatus,
        updateEnvStatus: envOps.updateEnvStatus,
        handleEnvInstallStart: envOps.handleEnvInstallStart,
        handleEnvInstallResult: envOps.handleEnvInstallResult,
        refreshCompileEngine: engineOps.updateEngineUI,
        handlePlatformFeedback: feedbackOps.handlePlatformFeedback,
        handlePlatformAuth: platformAuthOps.handlePlatformAuth,
        handlePlatformUpdate: platformUpdateOps.handlePlatformUpdate,
        handlePlatformUpdateStatus: platformUpdateOps.handlePlatformUpdateStatus,
        openSettingsPage: (pageId) => pageNavOps.setSettingsPage(pageId),
        getRuntimeStatusSummary: envOps.getRuntimeStatusSummary,
        loadStartupSettings,
        loadWorkspaceSettings,
    };
};
