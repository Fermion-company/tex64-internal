const assert = require("node:assert/strict");
const test = require("node:test");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { PlatformAccessService } = require("../electron/services/platform-access.cjs");

const ACCESS_TOKEN = "unit-access-token-secret";
const REFRESH_TOKEN = "unit-refresh-token-secret";

const createSession = () => ({
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  accessTokenExpiresAt: Date.now() + 60_000,
  plan: "basic",
  user: { id: "unit-user", email: "unit@example.com" },
});

const createFakeProtectedStorage = () => ({
  required: true,
  encrypt: (plaintext) => `protected:${Buffer.from(plaintext, "utf8").toString("base64")}`,
  decrypt: (ciphertext) => {
    if (!ciphertext.startsWith("protected:")) {
      return null;
    }
    return Buffer.from(ciphertext.slice("protected:".length), "base64").toString("utf8");
  },
});

const createTempUserData = async (t, suffix) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `tex64-session-${suffix}-`));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
};

const sessionFile = (directory) => path.join(directory, "tex64-platform-session.json");

const createFileSystem = (overrides = {}) => ({
  readFile: (...args) => fsp.readFile(...args),
  mkdir: (...args) => fsp.mkdir(...args),
  writeFile: (...args) => fsp.writeFile(...args),
  rename: (...args) => fsp.rename(...args),
  chmod: (...args) => fsp.chmod(...args),
  unlink: (...args) => fsp.unlink(...args),
  ...overrides,
});

test("required session storage protects tokens at rest and round-trips them", async (t) => {
  const userDataPath = await createTempUserData(t, "protected");
  const options = {
    userDataPath,
    sessionSecretStorage: createFakeProtectedStorage(),
  };
  const service = new PlatformAccessService(options);
  service.state = { session: createSession(), oauthPending: null };
  await service.save();

  const raw = await fsp.readFile(sessionFile(userDataPath), "utf8");
  assert.equal(raw.includes(ACCESS_TOKEN), false);
  assert.equal(raw.includes(REFRESH_TOKEN), false);
  const stored = JSON.parse(raw);
  assert.equal(stored.session.accessToken, undefined);
  assert.equal(stored.session.refreshToken, undefined);
  assert.deepEqual(
    {
      scheme: stored.session.sessionSecrets.scheme,
      version: stored.session.sessionSecrets.version,
    },
    { scheme: "electron-safe-storage", version: 1 }
  );

  const reloaded = await new PlatformAccessService(options).load();
  assert.equal(reloaded.session.accessToken, ACCESS_TOKEN);
  assert.equal(reloaded.session.refreshToken, REFRESH_TOKEN);
  assert.equal(reloaded.session.plan, "basic");
});

test("legacy plaintext tokens are loaded once and migrated immediately", async (t) => {
  const userDataPath = await createTempUserData(t, "migration");
  await fsp.writeFile(
    sessionFile(userDataPath),
    JSON.stringify({ session: createSession(), oauthPending: null }, null, 2),
    { mode: 0o600 }
  );

  const options = {
    userDataPath,
    sessionSecretStorage: createFakeProtectedStorage(),
  };
  const loaded = await new PlatformAccessService(options).load();
  assert.equal(loaded.session.accessToken, ACCESS_TOKEN);
  assert.equal(loaded.session.refreshToken, REFRESH_TOKEN);

  const migratedRaw = await fsp.readFile(sessionFile(userDataPath), "utf8");
  assert.equal(migratedRaw.includes(ACCESS_TOKEN), false);
  assert.equal(migratedRaw.includes(REFRESH_TOKEN), false);
  assert.equal(JSON.parse(migratedRaw).session.sessionSecrets.scheme, "electron-safe-storage");

  const reloaded = await new PlatformAccessService(options).load();
  assert.equal(reloaded.session.accessToken, ACCESS_TOKEN);
  assert.equal(reloaded.session.refreshToken, REFRESH_TOKEN);
});

for (const failingOperation of ["writeFile", "rename"]) {
  test(
    `legacy plaintext session fails closed when migration ${failingOperation} fails`,
    async (t) => {
      const userDataPath = await createTempUserData(t, `migration-${failingOperation}`);
      const filePath = sessionFile(userDataPath);
      await fsp.writeFile(
        filePath,
        JSON.stringify({ session: createSession(), oauthPending: null }, null, 2),
        { mode: 0o600 }
      );

      const injectedError = new Error(`injected ${failingOperation} failure`);
      const fileSystem = createFileSystem({
        [failingOperation]: async () => {
          throw injectedError;
        },
      });
      const service = new PlatformAccessService({
        userDataPath,
        sessionSecretStorage: createFakeProtectedStorage(),
        fileSystem,
      });

      const loaded = await service.load();
      assert.equal(loaded.session, null);
      assert.equal(service.state.session, null);

      const legacyRaw = await fsp.readFile(filePath, "utf8");
      assert.equal(legacyRaw.includes(ACCESS_TOKEN), true);
      assert.equal(legacyRaw.includes(REFRESH_TOKEN), true);
      assert.deepEqual(await fsp.readdir(userDataPath), ["tex64-platform-session.json"]);

      const recovered = await new PlatformAccessService({
        userDataPath,
        sessionSecretStorage: createFakeProtectedStorage(),
      }).load();
      assert.equal(recovered.session.accessToken, ACCESS_TOKEN);
      assert.equal(recovered.session.refreshToken, REFRESH_TOKEN);
      const migratedRaw = await fsp.readFile(filePath, "utf8");
      assert.equal(migratedRaw.includes(ACCESS_TOKEN), false);
      assert.equal(migratedRaw.includes(REFRESH_TOKEN), false);
    }
  );
}

test("unavailable required storage never persists plaintext secrets", async (t) => {
  const userDataPath = await createTempUserData(t, "unavailable");
  const unavailableStorage = {
    required: true,
    encrypt: () => null,
    decrypt: () => null,
  };
  const service = new PlatformAccessService({
    userDataPath,
    sessionSecretStorage: unavailableStorage,
  });
  service.state = { session: createSession(), oauthPending: null };
  await service.save();

  let raw = await fsp.readFile(sessionFile(userDataPath), "utf8");
  assert.equal(raw.includes(ACCESS_TOKEN), false);
  assert.equal(raw.includes(REFRESH_TOKEN), false);
  assert.equal(JSON.parse(raw).session, null);

  await fsp.writeFile(
    sessionFile(userDataPath),
    JSON.stringify({ session: createSession(), oauthPending: null }, null, 2),
    { mode: 0o600 }
  );
  const migrated = await new PlatformAccessService({
    userDataPath,
    sessionSecretStorage: unavailableStorage,
  }).load();
  assert.equal(migrated.session, null);
  raw = await fsp.readFile(sessionFile(userDataPath), "utf8");
  assert.equal(raw.includes(ACCESS_TOKEN), true);
  assert.equal(raw.includes(REFRESH_TOKEN), true);
});

test("non-packaged callers without protected storage keep the existing format", async (t) => {
  const userDataPath = await createTempUserData(t, "compat");
  const service = new PlatformAccessService({ userDataPath });
  service.state = { session: createSession(), oauthPending: null };
  await service.save();

  const raw = await fsp.readFile(sessionFile(userDataPath), "utf8");
  assert.equal(raw.includes(ACCESS_TOKEN), true);
  assert.equal(raw.includes(REFRESH_TOKEN), true);
  const reloaded = await new PlatformAccessService({ userDataPath }).load();
  assert.equal(reloaded.session.accessToken, ACCESS_TOKEN);
  assert.equal(reloaded.session.refreshToken, REFRESH_TOKEN);
});
