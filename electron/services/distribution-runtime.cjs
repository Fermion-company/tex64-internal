const MICROSOFT_STORE_UPDATE_MODE = "microsoft-store";
const MICROSOFT_STORE_UPDATE_MESSAGE =
  "Updates are managed automatically by Microsoft Store.";

const resolveDistributionRuntime = (windowsStoreValue) => {
  const windowsStore = windowsStoreValue === true;
  return {
    windowsStore,
    registerCustomProtocol: !windowsStore,
    useIndependentUpdater: !windowsStore,
  };
};

const createMicrosoftStoreUpdateState = ({
  appVersion,
  appPlatform = "win32",
  appArch = null,
  now = Date.now(),
}) => {
  const version =
    typeof appVersion === "string" && appVersion.trim()
      ? appVersion.trim()
      : "0.0.0";
  const timestamp = Number.isFinite(now) ? now : Date.now();
  return {
    update: {
      platform: appPlatform,
      arch: appArch,
      channel: MICROSOFT_STORE_UPDATE_MODE,
      currentVersion: version,
      latestVersion: version,
      hasUpdate: false,
      required: false,
      checkedAt: timestamp,
    },
    status: {
      phase: "up-to-date",
      mode: MICROSOFT_STORE_UPDATE_MODE,
      message: MICROSOFT_STORE_UPDATE_MESSAGE,
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      downloadedPath: null,
      currentVersion: version,
      latestVersion: version,
      checkedAt: timestamp,
      updatedAt: timestamp,
      error: null,
    },
  };
};

module.exports = {
  MICROSOFT_STORE_UPDATE_MESSAGE,
  MICROSOFT_STORE_UPDATE_MODE,
  createMicrosoftStoreUpdateState,
  resolveDistributionRuntime,
};
