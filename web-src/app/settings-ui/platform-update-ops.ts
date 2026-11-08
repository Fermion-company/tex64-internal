import type { PlatformUpdateSnapshot, PlatformUpdateStatusSnapshot } from "../types.js";
import type { SettingsUiRuntime } from "./runtime.js";
import { getUiLocale, onUiLocaleChange, setLocalizedAttribute, uiText } from "../i18n.js";

const MICROSOFT_STORE_UPDATE_MODE = "microsoft-store";

export type SettingsPlatformUpdateOps = {
  updatePlatformUpdateUi: () => void;
  handlePlatformUpdate: (payload: {
    source?: string;
    update: PlatformUpdateSnapshot | null;
    error?: { code?: string; message?: string };
  }) => void;
  handlePlatformUpdateStatus: (payload: { source?: string; status: PlatformUpdateStatusSnapshot }) => void;
  maybeRequestPlatformUpdateCheck: (force?: boolean) => boolean;
};

// "Update" alone is the figure editor's 「更新」 in the dictionaries; the app's
// own update is 「アップデート」 (and its counterpart in each language) under
// "Update app".
const appUpdateLabel = () => (getUiLocale() === "en" ? "Update" : uiText("Update app", "アップデート"));

// Updates work like the Claude desktop app: the main process downloads and
// verifies a new version quietly whenever a check finds one, and the top bar
// shows one small chip only once the installer is ready. The chip and the one
// button in Settings > Account save every open file before opening the
// installer.
export const createSettingsPlatformUpdateOps = (runtime: SettingsUiRuntime): SettingsPlatformUpdateOps => {
  const { settingsUpdateVersion, settingsUpdateStatus, settingsUpdateAction, updateButton } = runtime.context.dom;

  const isMicrosoftStoreManaged = () =>
    runtime.state.platformUpdateStatus?.mode === MICROSOFT_STORE_UPDATE_MODE ||
    runtime.state.platformUpdate?.channel === MICROSOFT_STORE_UPDATE_MODE;

  const clearUpdateAutoCheckTimer = () => {
    if (runtime.state.updateAutoCheckTimer !== null) {
      window.clearTimeout(runtime.state.updateAutoCheckTimer);
      runtime.state.updateAutoCheckTimer = null;
    }
  };

  const getPhase = () => runtime.state.platformUpdateStatus?.phase ?? "idle";

  // The verified installer is on disk: "downloaded", or "installing" once it
  // has been opened (the user may close it and come back).
  const isInstallerReady = () => {
    const phase = getPhase();
    return (
      !isMicrosoftStoreManaged() &&
      Boolean(runtime.state.platformUpdateStatus?.downloadedPath) &&
      (phase === "downloaded" || phase === "installing")
    );
  };

  const isDownloading = () => {
    const phase = getPhase();
    return !isMicrosoftStoreManaged() && (phase === "available" || phase === "downloading");
  };

  // Failures and the Store's own management are the only states with words.
  const resolveUpdateStatusText = () => {
    if (isMicrosoftStoreManaged()) {
      return uiText("Updates are managed automatically by Microsoft Store.", "アップデートはMicrosoft Storeによって自動的に管理されます。",
      );
    }
    if (getPhase() === "error") {
      const message =
        runtime.state.platformUpdateStatus?.message?.trim() ||
        runtime.state.platformUpdateStatus?.error?.message?.trim();
      return message || "Update processing failed.";
    }
    return "";
  };

  const resolveVersionText = () => {
    const current =
      runtime.state.platformUpdate?.currentVersion ??
      runtime.state.platformUpdateStatus?.currentVersion ??
      "-";
    const latest =
      runtime.state.platformUpdate?.latestVersion ??
      runtime.state.platformUpdateStatus?.latestVersion ??
      null;
    const phase = getPhase();
    const hasNewer =
      !isMicrosoftStoreManaged() &&
      Boolean(latest) &&
      latest !== current &&
      (Boolean(runtime.state.platformUpdate?.hasUpdate) ||
        phase === "available" ||
        phase === "downloading" ||
        phase === "downloaded" ||
        phase === "installing");
    return hasNewer ? `${current} → ${latest}` : current;
  };

  const updatePlatformUpdateUi = () => {
    if (settingsUpdateVersion instanceof HTMLElement) {
      settingsUpdateVersion.textContent = resolveVersionText();
    }
    const statusText = resolveUpdateStatusText();
    if (settingsUpdateStatus instanceof HTMLElement) {
      settingsUpdateStatus.textContent = statusText;
      settingsUpdateStatus.classList.toggle("is-hidden", !statusText);
      settingsUpdateStatus.classList.toggle("is-error", getPhase() === "error");
    }
    const ready = isInstallerReady();
    const downloading = isDownloading();
    if (settingsUpdateAction instanceof HTMLButtonElement) {
      const storeManaged = isMicrosoftStoreManaged();
      settingsUpdateAction.hidden = storeManaged;
      settingsUpdateAction.dataset.noI18n = "";
      settingsUpdateAction.textContent = ready
        ? appUpdateLabel()
        : downloading
          ? uiText("Downloading…", "ダウンロード中…")
          : uiText("Check for updates", "アップデートを確認");
      settingsUpdateAction.classList.toggle("ghost", !ready);
      settingsUpdateAction.disabled = storeManaged || downloading || getPhase() === "checking";
      settingsUpdateAction.setAttribute("aria-busy", downloading || getPhase() === "checking" ? "true" : "false");
    }
    if (updateButton instanceof HTMLButtonElement) {
      updateButton.hidden = !ready;
      const label = updateButton.querySelector<HTMLElement>(".update-chip-label");
      if (label) label.textContent = appUpdateLabel();
      setLocalizedAttribute(updateButton, "aria-label", appUpdateLabel());
    }
  };

  const handlePlatformUpdate = (payload: {
    source?: string;
    update: PlatformUpdateSnapshot | null;
    error?: { code?: string; message?: string };
  }) => {
    runtime.state.platformUpdate = payload?.update ?? null;
    if (runtime.state.platformUpdateStatus) {
      runtime.state.platformUpdateStatus = {
        ...runtime.state.platformUpdateStatus,
        latestVersion:
          runtime.state.platformUpdate?.latestVersion ??
          runtime.state.platformUpdateStatus.latestVersion ??
          null,
        currentVersion:
          runtime.state.platformUpdate?.currentVersion ??
          runtime.state.platformUpdateStatus.currentVersion ??
          null,
      };
    }
    if (payload?.error?.message) {
      runtime.state.platformUpdateStatus = {
        phase: "error",
        mode: runtime.state.platformUpdateStatus?.mode ?? null,
        message: payload.error.message,
        progressPercent: null,
        transferredBytes: null,
        totalBytes: null,
        downloadedPath: runtime.state.platformUpdateStatus?.downloadedPath ?? null,
        currentVersion:
          runtime.state.platformUpdate?.currentVersion ??
          runtime.state.platformUpdateStatus?.currentVersion ??
          null,
        latestVersion:
          runtime.state.platformUpdate?.latestVersion ??
          runtime.state.platformUpdateStatus?.latestVersion ??
          null,
        checkedAt: runtime.state.platformUpdate?.checkedAt ?? Date.now(),
        updatedAt: Date.now(),
        error: {
          code: payload.error.code ?? null,
          message: payload.error.message,
        },
      };
    }
    if (isMicrosoftStoreManaged()) {
      clearUpdateAutoCheckTimer();
      runtime.state.updateAutoCheckStarted = true;
    }
    updatePlatformUpdateUi();
  };

  const handlePlatformUpdateStatus = (payload: { source?: string; status: PlatformUpdateStatusSnapshot }) => {
    const status = payload?.status ?? null;
    if (!status) {
      return;
    }
    runtime.state.platformUpdateStatus = {
      ...status,
      updatedAt:
        typeof status.updatedAt === "number" && Number.isFinite(status.updatedAt) ? status.updatedAt : Date.now(),
    };
    if (isMicrosoftStoreManaged()) {
      clearUpdateAutoCheckTimer();
      runtime.state.updateAutoCheckStarted = true;
    }
    updatePlatformUpdateUi();
    if (!isMicrosoftStoreManaged() && !runtime.state.updateAutoCheckStarted) {
      maybeRequestPlatformUpdateCheck(false);
    }
  };

  const readUpdateLastAutoCheckAt = () => {
    try {
      const raw = localStorage.getItem(runtime.keys.updateLastAutoCheckAtKey);
      if (!raw) {
        return 0;
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
      }
      return parsed;
    } catch {
      return 0;
    }
  };

  const markUpdateAutoCheckAt = (timestamp: number) => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return;
    }
    try {
      localStorage.setItem(runtime.keys.updateLastAutoCheckAtKey, String(Math.round(timestamp)));
    } catch {
      // ignore storage failures
    }
  };

  const scheduleUpdateAutoCheck = () => {
    clearUpdateAutoCheckTimer();
    if (isMicrosoftStoreManaged()) {
      return;
    }
    const now = Date.now();
    const last = readUpdateLastAutoCheckAt();
    const elapsed = Math.max(0, now - last);
    const remaining = Math.max(30_000, runtime.config.updateAutoCheckIntervalMs - elapsed);
    runtime.state.updateAutoCheckTimer = window.setTimeout(() => {
      runtime.state.updateAutoCheckTimer = null;
      maybeRequestPlatformUpdateCheck(false);
      scheduleUpdateAutoCheck();
    }, remaining);
  };

  const maybeRequestPlatformUpdateCheck = (force = false) => {
    if (
      !force &&
      runtime.state.platformUpdate === null &&
      runtime.state.platformUpdateStatus === null
    ) {
      runtime.deps.postToNative({ type: "update:status:get" }, true);
      return false;
    }
    runtime.deps.postToNative({ type: "update:status:get" }, true);
    if (isMicrosoftStoreManaged()) {
      clearUpdateAutoCheckTimer();
      runtime.state.updateAutoCheckStarted = true;
      return false;
    }
    let dispatched = false;
    if (force) {
      markUpdateAutoCheckAt(Date.now());
      runtime.state.updateAutoCheckStarted = true;
      runtime.deps.postToNative({ type: "update:check", force: true }, true);
      dispatched = true;
      scheduleUpdateAutoCheck();
      return dispatched;
    }
    if (!runtime.state.updateAutoCheckStarted) {
      runtime.state.updateAutoCheckStarted = true;
      markUpdateAutoCheckAt(Date.now());
      runtime.deps.postToNative({ type: "update:check", force: false, source: "background" }, true);
      dispatched = true;
      scheduleUpdateAutoCheck();
      return dispatched;
    }
    const now = Date.now();
    const last = readUpdateLastAutoCheckAt();
    if (now - last >= runtime.config.updateAutoCheckIntervalMs) {
      markUpdateAutoCheckAt(now);
      runtime.deps.postToNative({ type: "update:check", force: false, source: "background" }, true);
      dispatched = true;
    }
    scheduleUpdateAutoCheck();
    return dispatched;
  };

  // Every unsaved file is written first; the installer may close the app. A
  // build that is running keeps running: nothing is asked.
  let installing = false;
  const installUpdate = async () => {
    if (installing || !isInstallerReady()) {
      return;
    }
    installing = true;
    try {
      const saved = (await runtime.deps.saveDirtyFiles?.()) ?? true;
      // A file that could not be saved says so in the toolbar; the installer
      // waits for the next click.
      if (!saved) return;
      runtime.deps.postToNative({ type: "update:install", openFallbackOnError: true }, true);
    } finally {
      installing = false;
    }
  };

  onUiLocaleChange(() => updatePlatformUpdateUi());

  if (updateButton instanceof HTMLButtonElement) {
    updateButton.addEventListener("click", () => {
      void installUpdate();
    });
  }

  if (settingsUpdateAction instanceof HTMLButtonElement) {
    settingsUpdateAction.addEventListener("click", () => {
      if (isMicrosoftStoreManaged() || isDownloading()) {
        return;
      }
      if (isInstallerReady()) {
        void installUpdate();
        return;
      }
      if (getPhase() === "error") {
        // Try again in full; if the download fails once more, the download
        // page opens in the browser instead.
        markUpdateAutoCheckAt(Date.now());
        runtime.deps.postToNative(
          { type: "update:download", forceCheck: true, openFallbackOnError: true },
          true,
        );
        return;
      }
      maybeRequestPlatformUpdateCheck(true);
    });
  }

  return {
    updatePlatformUpdateUi,
    handlePlatformUpdate,
    handlePlatformUpdateStatus,
    maybeRequestPlatformUpdateCheck,
  };
};
