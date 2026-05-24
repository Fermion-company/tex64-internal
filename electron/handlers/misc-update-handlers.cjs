const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { toErrorPayload } = require("./misc-platform-utils.cjs");

const fetch = async (...args) => {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is unavailable. Node.js 18+ is required.");
  }
  return globalThis.fetch(...args);
};

const createUpdateHandlers = ({
  platformService,
  shell,
  Notification,
  sendToRenderer,
  appPlatform,
  appArch,
  appVersion,
  defaultUpdateChannel,
  updateDownloadDir,
}) => {
  let latestUpdateSnapshot = null;
  let downloadedInstallerPath = null;
  let updateStatus = {
    phase: "idle",
    mode: "artifact",
    message: "Waiting for update check.",
    progressPercent: null,
    transferredBytes: null,
    totalBytes: null,
    downloadedPath: null,
    currentVersion: appVersion,
    latestVersion: null,
    checkedAt: null,
    updatedAt: Date.now(),
    error: null,
  };
  let lastNotifiedUpdateVersion = null;
  const toUpdateErrorPayload = (error, fallbackCode = "UPDATE_ERROR") => ({
    code: typeof error?.code === "string" && error.code ? error.code : fallbackCode,
    message:
      typeof error?.message === "string" && error.message
        ? error.message
        : "Update processing failed.",
  });

  const emitUpdateStatus = (source = "update") => {
    sendToRenderer("platform:updateStatus", {
      source,
      status: {
        ...updateStatus,
        downloadedPath: downloadedInstallerPath,
      },
    });
  };
  const setUpdateStatus = (patch, source = "update") => {
    updateStatus = {
      ...updateStatus,
      ...(patch && typeof patch === "object" ? patch : {}),
      downloadedPath: downloadedInstallerPath,
      updatedAt: Date.now(),
    };
    emitUpdateStatus(source);
  };
  const canShowDesktopNotification = () => {
    if (typeof Notification !== "function") {
      return false;
    }
    if (typeof Notification.isSupported === "function") {
      try {
        return Notification.isSupported() === true;
      } catch {
        return false;
      }
    }
    return true;
  };
  const resolveUpdateArtifactUrl = (update = latestUpdateSnapshot) => {
    if (
      update &&
      typeof update.artifactUrl === "string" &&
      update.artifactUrl.trim()
    ) {
      return update.artifactUrl.trim();
    }
    return null;
  };
  const resolveUpdateFallbackUrl = () => {
    if (
      latestUpdateSnapshot &&
      typeof latestUpdateSnapshot.notesUrl === "string" &&
      latestUpdateSnapshot.notesUrl.trim()
    ) {
      return latestUpdateSnapshot.notesUrl.trim();
    }
    return resolveUpdateArtifactUrl() || "https://tex64.com/download";
  };
  const notifyUpdateAvailable = (update, source = "manual") => {
    if (source !== "background") {
      return;
    }
    if (!update?.hasUpdate) {
      lastNotifiedUpdateVersion = null;
      return;
    }
    const latestVersion =
      typeof update.latestVersion === "string" && update.latestVersion.trim()
        ? update.latestVersion.trim()
        : "";
    if (!latestVersion || latestVersion === lastNotifiedUpdateVersion) {
      return;
    }
    lastNotifiedUpdateVersion = latestVersion;
    if (!canShowDesktopNotification()) {
      return;
    }
    try {
      const notification = new Notification({
        title: "TeX64 Update",
        body: `Version ${latestVersion} is available.`,
        silent: true,
      });
      if (typeof notification.on === "function" && shell?.openExternal) {
        notification.on("click", () => {
          const fallbackUrl = resolveUpdateFallbackUrl();
          if (fallbackUrl) {
            shell.openExternal(fallbackUrl).catch(() => {});
          }
        });
      }
      if (typeof notification.show === "function") {
        notification.show();
      }
    } catch {
      // ignore notification failures
    }
  };
  const emitPlatformUpdate = async (payload = {}, source = "update") => {
    if (!platformService || typeof platformService.fetchUpdateManifest !== "function") {
      return null;
    }
    const update = await platformService.fetchUpdateManifest({
      platform: payload.platform ?? appPlatform,
      arch: payload.arch ?? appArch,
      channel:
        typeof payload.channel === "string" && payload.channel.trim()
          ? payload.channel.trim()
          : defaultUpdateChannel,
      currentVersion: appVersion,
    });
    latestUpdateSnapshot = update;
    sendToRenderer("platform:update", { source, update });
    return update;
  };
  const resolveUpdateFileName = (artifactUrl, latestVersion) => {
    if (typeof artifactUrl === "string" && artifactUrl.trim()) {
      try {
        const parsed = new URL(artifactUrl);
        const name = path.basename(parsed.pathname);
        if (name && name !== "/" && name !== ".") {
          return name;
        }
      } catch {
        // ignore malformed URL
      }
    }
    const version =
      typeof latestVersion === "string" && latestVersion.trim()
        ? latestVersion.trim()
        : "latest";
    if (appPlatform === "darwin") return `tex64-${version}.zip`;
    if (appPlatform === "win32") return `tex64-${version}.exe`;
    return `tex64-${version}.AppImage`;
  };
  const normalizeBase64Digest = (value) => {
    if (typeof value !== "string") {
      return null;
    }
    const raw = value.trim().replace(/\s+/g, "");
    if (!raw) {
      return null;
    }
    if (/[^A-Za-z0-9+/=_-]/.test(raw)) {
      return null;
    }
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const mod = normalized.length % 4;
    if (mod === 1) {
      return null;
    }
    if (mod === 0) {
      return normalized;
    }
    return `${normalized}${"=".repeat(4 - mod)}`;
  };
  const parseSha256Digest = (value) => {
    if (typeof value !== "string") {
      return null;
    }
    let text = value.trim();
    if (!text) {
      return null;
    }
    const prefixed = text.match(/^sha[-_]?256(?:[:=\s-]+)(.+)$/i);
    if (prefixed && prefixed[1]) {
      text = prefixed[1].trim();
    }
    if (/^[a-f0-9]{64}$/i.test(text)) {
      return { algorithm: "sha256", hex: text.toLowerCase() };
    }
    const normalizedBase64 = normalizeBase64Digest(text);
    if (!normalizedBase64) {
      return null;
    }
    let decoded = null;
    try {
      decoded = Buffer.from(normalizedBase64, "base64");
    } catch {
      decoded = null;
    }
    if (!decoded || decoded.length !== 32) {
      return null;
    }
    if (decoded.toString("base64") !== normalizedBase64) {
      return null;
    }
    return { algorithm: "sha256", hex: decoded.toString("hex") };
  };
  const resolveExpectedArtifactDigest = (update) => {
    if (!update || typeof update !== "object") {
      return null;
    }
    const candidates = [
      update.artifactSha256,
      update.sha256,
      update.checksum,
      update.signature,
    ];
    for (const candidate of candidates) {
      const parsed = parseSha256Digest(candidate);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  };
  const handleUpdateCheck = async (payload) => {
    if (!platformService || typeof platformService.fetchUpdateManifest !== "function") {
      return null;
    }
    const source = payload?.source === "background" ? "background" : "manual";
    setUpdateStatus(
      {
        phase: "checking",
        message: "Checking for updates.",
        progressPercent: null,
        transferredBytes: null,
        totalBytes: null,
        checkedAt: null,
        error: null,
      },
      source
    );
    try {
      const update = await emitPlatformUpdate(payload, source);
      if (!update?.hasUpdate) {
        downloadedInstallerPath = null;
        lastNotifiedUpdateVersion = null;
        setUpdateStatus(
          {
            phase: "up-to-date",
            latestVersion: update?.latestVersion ?? null,
            currentVersion: update?.currentVersion ?? appVersion,
            checkedAt: update?.checkedAt ?? Date.now(),
            message: "Already using latest version.",
            error: null,
          },
          source
        );
        return update ?? null;
      }
      downloadedInstallerPath = null;
      setUpdateStatus(
        {
          phase: "available",
          latestVersion: update.latestVersion ?? null,
          currentVersion: update.currentVersion ?? appVersion,
          checkedAt: update.checkedAt ?? Date.now(),
          message:
            typeof update.latestVersion === "string" && update.latestVersion
              ? `A new version ${update.latestVersion} is available.`
              : "A new version is available.",
          error: null,
        },
        source
      );
      notifyUpdateAvailable(update, source);
      return update ?? null;
    } catch (error) {
      sendToRenderer("platform:update", {
        source,
        update: null,
        error: toErrorPayload(error, "UPDATE_CHECK_FAILED"),
      });
      setUpdateStatus(
        {
          phase: "error",
          message: "Update check failed.",
          error: toUpdateErrorPayload(error, "UPDATE_CHECK_FAILED"),
        },
        source
      );
      return null;
    }
  };
  const downloadUpdateArtifact = async (artifactUrl, latestVersion, expectedDigest) => {
    const fileName = resolveUpdateFileName(artifactUrl, latestVersion);
    await fsp.mkdir(updateDownloadDir, { recursive: true });
    const finalPath = path.join(updateDownloadDir, fileName);
    const tempPath = `${finalPath}.part`;
    if (!expectedDigest || expectedDigest.algorithm !== "sha256") {
      throw {
        code: "UPDATE_VERIFY_METADATA_MISSING",
        message: "Update file verification info is missing.",
      };
    }
    let completed = false;
    try {
      const response = await fetch(artifactUrl);
      if (!response.ok || !response.body) {
        throw {
          code: "UPDATE_DOWNLOAD_FAILED",
          message: `Failed to fetch update file: HTTP ${response.status}.`,
        };
      }
      const responseStream = Readable.fromWeb(response.body);
      const totalBytesRaw = Number.parseInt(response.headers.get("content-length") || "", 10);
      const totalBytes = Number.isFinite(totalBytesRaw) && totalBytesRaw > 0 ? totalBytesRaw : null;
      let transferredBytes = 0;
      const hash = crypto.createHash("sha256");
      responseStream.on("data", (chunk) => {
        transferredBytes += chunk?.length ?? 0;
        if (chunk) {
          hash.update(chunk);
        }
        const progressPercent =
          totalBytes && totalBytes > 0
            ? Math.max(0, Math.min(100, (transferredBytes / totalBytes) * 100))
            : null;
        setUpdateStatus(
          {
            phase: "downloading",
            message: "Downloading update files.",
            progressPercent,
            transferredBytes,
            totalBytes,
            error: null,
          },
          "download"
        );
      });
      await pipeline(responseStream, fs.createWriteStream(tempPath));
      const downloadedDigest = hash.digest("hex");
      if (downloadedDigest !== expectedDigest.hex) {
        throw {
          code: "UPDATE_VERIFY_MISMATCH",
          message: "Update file verification failed. Please try again.",
        };
      }
      await fsp.rm(finalPath, { force: true }).catch(() => {});
      await fsp.rename(tempPath, finalPath);
      downloadedInstallerPath = finalPath;
      completed = true;
      return {
        path: finalPath,
        totalBytes,
      };
    } finally {
      if (!completed) {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
      }
    }
  };
  const handleUpdateDownload = async (payload) => {
    let update = latestUpdateSnapshot;
    const shouldForceCheck = payload?.forceCheck === true;
    if (!update || shouldForceCheck) {
      update = await handleUpdateCheck({ force: true });
    }
    if (!update) {
      if (updateStatus.phase === "error") {
        return;
      }
      setUpdateStatus(
        {
          phase: "up-to-date",
          message: "No applicable update available.",
          error: null,
        },
        "download"
      );
      return;
    }
    if (!update.hasUpdate) {
      setUpdateStatus(
        {
          phase: "up-to-date",
          message: "No applicable update available.",
          error: null,
        },
        "download"
      );
      return;
    }
    const artifactUrl = resolveUpdateArtifactUrl(update);
    if (!artifactUrl) {
      downloadedInstallerPath = null;
      setUpdateStatus(
        {
          phase: "error",
          message: "Download URL not found. Please use manual download.",
          error: {
            code: "UPDATE_ARTIFACT_URL_MISSING",
            message: "artifactUrl is not set.",
          },
        },
        "download"
      );
      return;
    }
    const expectedDigest = resolveExpectedArtifactDigest(update);
    if (!expectedDigest) {
      downloadedInstallerPath = null;
      setUpdateStatus(
        {
          phase: "error",
          message: "Update file verification info missing. Please use manual download.",
          error: {
            code: "UPDATE_VERIFY_METADATA_MISSING",
            message: "manifest is missing sha256/checksum/signature.",
          },
        },
        "download"
      );
      return;
    }
    downloadedInstallerPath = null;
    setUpdateStatus(
      {
        phase: "downloading",
        latestVersion: update.latestVersion ?? null,
        currentVersion: update.currentVersion ?? appVersion,
        checkedAt: update.checkedAt ?? Date.now(),
        message: "Downloading update files.",
        progressPercent: 0,
        transferredBytes: 0,
        totalBytes: null,
        error: null,
      },
      "download"
    );
    try {
      const downloaded = await downloadUpdateArtifact(
        artifactUrl,
        update.latestVersion ?? null,
        expectedDigest
      );
      setUpdateStatus(
        {
          phase: "downloaded",
          latestVersion: update.latestVersion ?? null,
          currentVersion: update.currentVersion ?? appVersion,
          checkedAt: update.checkedAt ?? Date.now(),
          message: "Update file download and verification complete.",
          progressPercent: 100,
          transferredBytes: downloaded.totalBytes ?? null,
          totalBytes: downloaded.totalBytes ?? null,
          error: null,
        },
        "download"
      );
      if (payload?.autoInstall === true) {
        await handleUpdateInstall({ openFallbackOnError: true });
      }
    } catch (error) {
      setUpdateStatus(
        {
          phase: "error",
          message: "Download failed.",
          error: toUpdateErrorPayload(error, "UPDATE_DOWNLOAD_FAILED"),
        },
        "download"
      );
      if (payload?.openFallbackOnError && shell?.openExternal) {
        const fallbackUrl = resolveUpdateFallbackUrl();
        if (fallbackUrl) {
          await shell.openExternal(fallbackUrl).catch(() => {});
        }
      }
    }
  };
  const handleUpdateInstall = async (payload = {}) => {
    if (!downloadedInstallerPath) {
      setUpdateStatus(
        {
          phase: "error",
          message: "Please download the update file first.",
          error: {
            code: "UPDATE_INSTALL_MISSING_FILE",
            message: "No installation target file.",
          },
        },
        "install"
      );
      return;
    }
    try {
      await fsp.access(downloadedInstallerPath, fs.constants.F_OK);
    } catch {
      setUpdateStatus(
        {
          phase: "error",
          message: "Update file not found. Please re-download.",
          error: {
            code: "UPDATE_INSTALL_FILE_NOT_FOUND",
            message: "Update file does not exist.",
          },
        },
        "install"
      );
      return;
    }
    setUpdateStatus(
      {
        phase: "installing",
        message: "Starting installer.",
        error: null,
      },
      "install"
    );
    try {
      const result = shell?.openPath
        ? await shell.openPath(downloadedInstallerPath)
        : "openPath is unavailable";
      if (typeof result === "string" && result.trim()) {
        throw {
          code: "UPDATE_INSTALL_OPEN_FAILED",
          message: result,
        };
      }
      setUpdateStatus(
        {
          phase: "installing",
          message: "Installer started. Follow the on-screen instructions to update.",
          error: null,
        },
        "install"
      );
    } catch (error) {
      setUpdateStatus(
        {
          phase: "error",
          message: "Failed to start installer.",
          error: toUpdateErrorPayload(error, "UPDATE_INSTALL_FAILED"),
        },
        "install"
      );
      if (payload?.openFallbackOnError && shell?.openExternal) {
        const fallbackUrl = resolveUpdateFallbackUrl();
        if (fallbackUrl) {
          await shell.openExternal(fallbackUrl).catch(() => {});
        }
      }
    }
  };
  const handleUpdateStatusGet = async () => {
    if (latestUpdateSnapshot) {
      sendToRenderer("platform:update", { source: "status", update: latestUpdateSnapshot });
    }
    emitUpdateStatus("status");
  };
  return {
    handleUpdateCheck,
    handleUpdateDownload,
    handleUpdateInstall,
    handleUpdateStatusGet,
  };
};
module.exports = {
  createUpdateHandlers,
};
