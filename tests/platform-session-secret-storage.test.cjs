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
  assert.equal(migrated.session.accessToken, ACCESS_TOKEN);
  raw = await fsp.readFile(sessionFile(userDataPath), "utf8");
  assert.equal(raw.includes(ACCESS_TOKEN), false);
  assert.equal(raw.includes(REFRESH_TOKEN), false);
  assert.equal(JSON.parse(raw).session, null);
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
