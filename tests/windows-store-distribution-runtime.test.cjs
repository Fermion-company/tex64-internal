const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MICROSOFT_STORE_UPDATE_MESSAGE,
  MICROSOFT_STORE_UPDATE_MODE,
  createMicrosoftStoreUpdateState,
  resolveDistributionRuntime,
} = require("../electron/services/distribution-runtime.cjs");
const {
  createUpdateHandlers,
} = require("../electron/handlers/misc-update-handlers.cjs");

test("Microsoft Store runtime delegates protocol and updates to the package manifest and Store", () => {
  assert.deepEqual(resolveDistributionRuntime(true), {
    windowsStore: true,
    registerCustomProtocol: false,
    useIndependentUpdater: false,
  });
  assert.deepEqual(resolveDistributionRuntime(false), {
    windowsStore: false,
    registerCustomProtocol: true,
    useIndependentUpdater: true,
  });
  assert.deepEqual(resolveDistributionRuntime(undefined), {
    windowsStore: false,
    registerCustomProtocol: true,
    useIndependentUpdater: true,
  });
});

test("Microsoft Store update state is explicit and contains no installer path", () => {
  const state = createMicrosoftStoreUpdateState({
    appVersion: " 1.2.3 ",
    appPlatform: "win32",
    appArch: "x64",
    now: 42,
  });

  assert.equal(state.update.channel, MICROSOFT_STORE_UPDATE_MODE);
  assert.equal(state.update.currentVersion, "1.2.3");
  assert.equal(state.update.latestVersion, "1.2.3");
  assert.equal(state.update.hasUpdate, false);
  assert.equal(state.status.mode, MICROSOFT_STORE_UPDATE_MODE);
  assert.equal(state.status.message, MICROSOFT_STORE_UPDATE_MESSAGE);
  assert.equal(state.status.downloadedPath, null);
  assert.equal(state.status.checkedAt, 42);
});

test("all Store-managed update handlers avoid manifest, download, and installer operations", async () => {
  let manifestCalls = 0;
  let artifactFetchCalls = 0;
  let openExternalCalls = 0;
  let openPathCalls = 0;
  const messages = [];
  const handlers = createUpdateHandlers({
    platformService: {
      async fetchUpdateManifest() {
        manifestCalls += 1;
        throw new Error("Store runtime must not fetch the independent update manifest");
      },
    },
    shell: {
      async openExternal() {
        openExternalCalls += 1;
      },
      async openPath() {
        openPathCalls += 1;
        return "";
      },
    },
    Notification: null,
    sendToRenderer(type, payload) {
      messages.push({ type, payload });
    },
    appPlatform: "win32",
    appArch: "x64",
    appVersion: "1.2.3",
    defaultUpdateChannel: "stable",
    updateDownloadDir: "/unused/store-update-dir",
    storeManagedUpdates: true,
    async fetchImpl() {
      artifactFetchCalls += 1;
      throw new Error("Store runtime must not fetch an external installer");
    },
  });

  const checkResult = await handlers.handleUpdateCheck({
    force: true,
    source: "background",
  });
  await handlers.handleUpdateDownload({
    forceCheck: true,
    autoInstall: true,
    openFallbackOnError: true,
  });
  await handlers.handleUpdateInstall({ openFallbackOnError: true });
  await handlers.handleUpdateStatusGet();

  assert.equal(manifestCalls, 0);
  assert.equal(artifactFetchCalls, 0);
  assert.equal(openExternalCalls, 0);
  assert.equal(openPathCalls, 0);
  assert.equal(checkResult.channel, MICROSOFT_STORE_UPDATE_MODE);
  assert.equal(checkResult.hasUpdate, false);

  const updateMessages = messages.filter(({ type }) => type === "platform:update");
  const statusMessages = messages.filter(({ type }) => type === "platform:updateStatus");
  assert.equal(updateMessages.length, 4);
  assert.equal(statusMessages.length, 4);
  for (const { payload } of statusMessages) {
    assert.equal(payload.status.mode, MICROSOFT_STORE_UPDATE_MODE);
    assert.equal(payload.status.message, MICROSOFT_STORE_UPDATE_MESSAGE);
    assert.equal(payload.status.downloadedPath, null);
  }
});

test("non-Store update checks keep using the existing manifest path", async () => {
  let manifestCalls = 0;
  const handlers = createUpdateHandlers({
    platformService: {
      async fetchUpdateManifest() {
        manifestCalls += 1;
        return {
          currentVersion: "1.2.3",
          latestVersion: "1.2.3",
          hasUpdate: false,
          checkedAt: 42,
        };
      },
    },
    shell: {},
    Notification: null,
    sendToRenderer() {},
    appPlatform: "win32",
    appArch: "x64",
    appVersion: "1.2.3",
    defaultUpdateChannel: "stable",
    updateDownloadDir: "/unused/desktop-update-dir",
    storeManagedUpdates: false,
  });

  const result = await handlers.handleUpdateCheck({ force: false, source: "background" });
  assert.equal(manifestCalls, 1);
  assert.equal(result.hasUpdate, false);
});
