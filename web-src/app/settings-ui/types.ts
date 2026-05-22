import type { AppSettingsSnapshot, BuildProfile, EditorFormatSettings, FormatSettingsPayload, PlatformAuthSnapshot, PlatformUpdateSnapshot, PlatformUpdateStatusSnapshot } from "../types.js";
import type { EnvRegistryApi } from "../env-registry-ui.js";
import type { EnvStatusSummary } from "../settings-env.js";

export type SettingsUiDeps = {
  envRegistry: EnvRegistryApi;
  getWorkspaceRootKey: () => string | null;
  getBuildProfiles: () => BuildProfile[];
  getBuildProfileId: () => string | null;
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  onEditorWordWrapChange?: (enabled: boolean) => void;
  onUpdateAttentionChange?: (hasAttention: boolean) => void;
  onRuntimeSetupNeeded?: (summary: EnvStatusSummary) => void;
  onRequestFirstBuild?: () => void;
};

export type FeedbackCategory = "bug" | "idea" | "other" | "general";

export type FeedbackQueueItem = {
  id: string;
  category: FeedbackCategory;
  message: string;
  createdAt: number;
  attempts: number;
  nextRetryAt: number;
};

export type SettingsUiApi = {
  getEditorAlignEnvEnabled: () => boolean;
  getEditorWordWrapEnabled: () => boolean;
  getAutoSynctexOnBuildEnabled: () => boolean;
  getReverseSynctexEnabled: () => boolean;
  getPdfViewerMode: () => "window" | "tab";
  buildFormatSettingsPayload: () => FormatSettingsPayload;
  getSettingsSnapshot: () => AppSettingsSnapshot;
  applySettingsPatch: (patch: Partial<AppSettingsSnapshot>) => AppSettingsSnapshot;
  checkEnvironmentStatus: () => void;
  updateEnvStatus: (command: string, available: boolean) => void;
  handleEnvInstallStart: (payload: { target?: string }) => void;
  handleEnvInstallResult: (payload: { target?: string; success?: boolean; message?: string }) => void;
  handleEnvInstallProgress: (payload: {
    phase?: string;
    current?: number | null;
    total?: number | null;
    percent?: number | null;
  }) => void;
  refreshCompileEngine: () => void;
  handlePlatformFeedback: (payload: {
    ok: boolean;
    feedbackId?: string | null;
    error?: { code?: string; message?: string };
  }) => void;
  submitFeedback: (category: FeedbackCategory, message: string) => boolean;
  onFeedbackStatus: (
    listener: (status: { message: string; tone: "neutral" | "success" | "error" }) => void
  ) => () => void;
  handlePlatformAuth: (payload: { auth: PlatformAuthSnapshot; error?: { code?: string; message?: string } }) => void;
  handlePlatformUpdate: (payload: {
    source?: string;
    update: PlatformUpdateSnapshot | null;
    error?: { code?: string; message?: string };
  }) => void;
  handlePlatformUpdateStatus: (payload: { source?: string; status: PlatformUpdateStatusSnapshot }) => void;
  openSettingsPage: (pageId: string | null) => void;
  getRuntimeStatusSummary: () => EnvStatusSummary | null;
  loadStartupSettings: () => void;
  loadWorkspaceSettings: () => void;
};

export type SettingsUiStorageRanges = Record<string, never>;

export type SettingsUiStorageKeys = {
  compileEngineKey: string;
  editorWordWrapKey: string;
  editorAutoSynctexOnBuildKey: string;
  editorReverseSynctexKey: string;
  editorAutoSynctexOnPdfOpenKey: string;
  editorPdfViewerModeKey: string;
  editorAlignEnvKey: string;
  editorFormatSettingsKey: string;
  runtimeSetupPromptedKey: string;
  firstBuildCompletedKey: string;
  updateLastAutoCheckAtKey: string;
  feedbackQueueKey: string;
};

export type SettingsUiConfig = {
  updateAutoCheckIntervalMs: number;
  texEngineCommands: Set<string>;
  envCheckTargets: string[];
  envDisplayTargets: string[];
};

export type SettingsUiState = {
  activeSettingsPage: string | null;
  editorAlignEnvEnabled: boolean;
  editorWordWrapEnabled: boolean;
  editorFormatSettings: EditorFormatSettings;
  autoSynctexOnBuildEnabled: boolean;
  reverseSynctexEnabled: boolean;
  pdfViewerMode: "window" | "tab";
  platformAuth: PlatformAuthSnapshot | null;
  platformUpdate: PlatformUpdateSnapshot | null;
  platformUpdateStatus: PlatformUpdateStatusSnapshot | null;
  updateAutoCheckStarted: boolean;
  updateAutoCheckTimer: number | null;
  runtimeStatusSummary: EnvStatusSummary | null;
  runtimeSetupPromptInFlight: boolean;
  feedbackPending: boolean;
  feedbackQueue: FeedbackQueueItem[];
  feedbackFlushTimer: number | null;
  feedbackInFlightId: string | null;
};

