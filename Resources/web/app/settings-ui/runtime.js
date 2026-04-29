import { defaultEditorFormatSettings } from "../settings-format.js";
export const createSettingsUiRuntime = (context, deps) => {
    const keys = {
        compileEngineKey: "tex64.compileEngine",
        editorWordWrapKey: "tex64.editor.wordWrap",
        editorAutoSynctexOnBuildKey: "tex64.editor.autoSynctexOnBuild",
        editorReverseSynctexKey: "tex64.editor.reverseSynctex",
        editorAutoSynctexOnPdfOpenKey: "tex64.editor.autoSynctexOnPdfOpen",
        editorPdfViewerModeKey: "tex64.editor.pdfViewerMode",
        editorAlignEnvKey: "tex64.editor.alignEnv",
        editorFormatSettingsKey: "tex64.editor.formatSettings",
        runtimeSetupPromptedKey: "tex64.runtimeSetupPrompted.v1",
        firstBuildCompletedKey: "tex64.onboarding.firstBuildCompleted.v1",
        updateLastAutoCheckAtKey: "tex64.update.lastAutoCheckAt.v1",
        feedbackQueueKey: "tex64.feedback.queue.v1",
    };
    const ranges = {};
    const texEngineCommands = new Set(["lualatex", "pdflatex", "xelatex", "uplatex"]);
    const config = {
        updateAutoCheckIntervalMs: 1000 * 60 * 60 * 6,
        texEngineCommands,
        envCheckTargets: [
            "lualatex",
            "pdflatex",
            "xelatex",
            "uplatex",
            "latexmk",
            "latexindent",
            "synctex",
        ],
        envDisplayTargets: ["lualatex", "latexmk", "latexindent", "synctex"],
    };
    const state = {
        activeSettingsPage: null,
        editorAlignEnvEnabled: true,
        editorWordWrapEnabled: false,
        editorFormatSettings: {
            ...defaultEditorFormatSettings,
        },
        autoSynctexOnBuildEnabled: true,
        reverseSynctexEnabled: true,
        pdfViewerMode: "window",
        platformAuth: null,
        platformUpdate: null,
        platformUpdateStatus: null,
        updateAutoCheckStarted: false,
        updateAutoCheckTimer: null,
        runtimeStatusSummary: null,
        runtimeSetupPromptInFlight: false,
        feedbackPending: false,
        feedbackQueue: [],
        feedbackFlushTimer: null,
        feedbackInFlightId: null,
    };
    return { context, deps, state, keys, ranges, config };
};
