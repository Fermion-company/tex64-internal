import type { PlatformUpdateSnapshot, PlatformUpdateStatusSnapshot } from "../types.js";
import { TEX64_LINKS } from "../platform-links.js";
import type { SettingsUiRuntime } from "./runtime.js";
import type { SettingsAttentionOps } from "./attention.js";
import { formatBytes, openExternalUrl } from "./utils.js";

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

export const createSettingsPlatformUpdateOps = (
  runtime: SettingsUiRuntime,
  attentionOps: SettingsAttentionOps
): SettingsPlatformUpdateOps => {
  const {
    settingsUpdateCurrent,
    settingsUpdateLatest,
    settingsUpdateStatus,
    settingsUpdateProgress,
    settingsUpdateProgressFill,
    settingsUpdateCheck,
    settingsUpdateApply,
    settingsUpdateOpen,
    updateButton,
  } = runtime.context.dom;

  const resolveUpdateStatusText = () => {
    const phase = runtime.state.platformUpdateStatus?.phase ?? "idle";
    const latest =
      runtime.state.platformUpdate?.latestVersion ?? runtime.state.platformUpdateStatus?.latestVersion ?? null;
    if (runtime.state.platformUpdateStatus?.message && runtime.state.platformUpdateStatus.message.trim()) {
      return runtime.state.platformUpdateStatus.message.trim();
    }
    if (phase === "checking") {
      return "Checking for updates.";
    }
    if (phase === "up-to-date") {
      return latest ? `Latest version ${latest}.` : "Up to date.";
    }
    if (phase === "available") {
      return latest ? `A new version of ${latest} is available.` : "A new version is available.";
    }
    if (phase === "downloading") {
      const transferred = formatBytes(runtime.state.platformUpdateStatus?.transferredBytes ?? 0);
      const total = formatBytes(runtime.state.platformUpdateStatus?.totalBytes ?? 0);
      return `Downloading updates (${transferred} / ${total}).`;
    }
    if (phase === "downloaded") {
      return "Download completed. You can launch the installer with the Apply button.";
    }
    if (phase === "installing") {
      return "I started the installer. Follow the on-screen instructions to update.";
    }
    if (phase === "error") {
      const message = runtime.state.platformUpdateStatus?.error?.message;
      return message && message.trim() ? message.trim() : "Update processing failed.";
    }
    return "Waiting for update check.";
  };

  const updatePlatformUpdateUi = () => {
    const currentVersion =
      runtime.state.platformUpdate?.currentVersion ??
      runtime.state.platformUpdateStatus?.currentVersion ??
      "-";
    const latestVersion =
      runtime.state.platformUpdate?.latestVersion ??
      runtime.state.platformUpdateStatus?.latestVersion ??
      "-";
    if (settingsUpdateCurrent instanceof HTMLElement) {
      settingsUpdateCurrent.textContent = currentVersion;
    }
    if (settingsUpdateLatest instanceof HTMLElement) {
      settingsUpdateLatest.textContent = latestVersion;
    }
    const statusText = resolveUpdateStatusText();
    if (settingsUpdateStatus instanceof HTMLElement) {
      settingsUpdateStatus.textContent = statusText;
      const phase = runtime.state.platformUpdateStatus?.phase ?? "idle";
      settingsUpdateStatus.classList.toggle("is-error", phase === "error");
      settingsUpdateStatus.classList.toggle("is-success", phase === "downloaded");
    }
    const progress =
      typeof runtime.state.platformUpdateStatus?.progressPercent === "number" &&
      Number.isFinite(runtime.state.platformUpdateStatus.progressPercent)
        ? Math.max(0, Math.min(100, runtime.state.platformUpdateStatus.progressPercent))
        : 0;
    const showProgress = (runtime.state.platformUpdateStatus?.phase ?? "") === "downloading";
    if (settingsUpdateProgress instanceof HTMLElement) {
      settingsUpdateProgress.classList.toggle("is-hidden", !showProgress);
      settingsUpdateProgress.setAttribute("aria-hidden", showProgress ? "false" : "true");
    }
    if (settingsUpdateProgressFill instanceof HTMLElement) {
      settingsUpdateProgressFill.style.width = `${progress}%`;
    }
    const phase = runtime.state.platformUpdateStatus?.phase ?? "idle";
    const hasUpdate = Boolean(runtime.state.platformUpdate?.hasUpdate);
    const hasDownloadedInstaller = Boolean(runtime.state.platformUpdateStatus?.downloadedPath);
    if (settingsUpdateCheck instanceof HTMLButtonElement) {
      settingsUpdateCheck.disabled = phase === "checking" || phase === "downloading";
    }
    const canApplyUpdate =
      hasUpdate || hasDownloadedInstaller || phase === "available" || phase === "downloaded";
    if (settingsUpdateApply instanceof HTMLButtonElement) {
      settingsUpdateApply.classList.toggle("is-hidden", !canApplyUpdate);
      settingsUpdateApply.setAttribute("aria-hidden", canApplyUpdate ? "false" : "true");
      settingsUpdateApply.disabled =
        !canApplyUpdate || phase === "checking" || phase === "downloading" || phase === "installing";
    }
    // Mirror the Apply button in the header bar: show a one-click Update button
    // whenever an update can be applied. Pulse (is-attention) when ready, show
    // a spinner (is-busy) while downloading/installing.
    if (updateButton instanceof HTMLButtonElement) {
      const busy = phase === "downloading" || phase === "installing";
      updateButton.classList.toggle("is-hidden", !canApplyUpdate);
      updateButton.setAttribute("aria-hidden", canApplyUpdate ? "false" : "true");
      updateButton.classList.toggle("is-busy", busy);
      updateButton.classList.toggle("is-attention", canApplyUpdate && !busy);
      updateButton.disabled = !canApplyUpdate || phase === "checking" || busy;
    }
    if (settingsUpdateOpen instanceof HTMLButtonElement) {
      settingsUpdateOpen.disabled = false;
    }
    attentionOps.syncUpdateAttentionUi();
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
    updatePlatformUpdateUi();
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
    if (runtime.state.updateAutoCheckTimer !== null) {
      window.clearTimeout(runtime.state.updateAutoCheckTimer);
      runtime.state.updateAutoCheckTimer = null;
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
    runtime.deps.postToNative({ type: "update:status:get" }, true);
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

  if (settingsUpdateCheck instanceof HTMLButtonElement) {
    settingsUpdateCheck.addEventListener("click", () => {
      maybeRequestPlatformUpdateCheck(true);
    });
  }

  const applyUpdate = () => {
    const phase = runtime.state.platformUpdateStatus?.phase ?? "idle";
    const hasDownloadedInstaller = Boolean(runtime.state.platformUpdateStatus?.downloadedPath);
    if (phase === "downloaded" || hasDownloadedInstaller) {
      runtime.deps.postToNative({ type: "update:install", openFallbackOnError: true }, true);
      return;
    }
    runtime.deps.postToNative(
      {
        type: "update:download",
        forceCheck: true,
        autoInstall: true,
        openFallbackOnError: true,
      },
      true
    );
  };

  if (settingsUpdateApply instanceof HTMLButtonElement) {
    settingsUpdateApply.addEventListener("click", () => {
      applyUpdate();
    });
  }

  if (updateButton instanceof HTMLButtonElement) {
    updateButton.addEventListener("click", () => {
      applyUpdate();
    });
  }

  if (settingsUpdateOpen instanceof HTMLButtonElement) {
    settingsUpdateOpen.addEventListener("click", () => {
      const fallbackUrl =
        runtime.state.platformUpdate?.artifactUrl ??
        runtime.state.platformUpdate?.notesUrl ??
        TEX64_LINKS.download;
      openExternalUrl(runtime, fallbackUrl);
    });
  }

  return {
    updatePlatformUpdateUi,
    handlePlatformUpdate,
    handlePlatformUpdateStatus,
    maybeRequestPlatformUpdateCheck,
  };
};

