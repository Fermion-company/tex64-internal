const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const { PlatformAccessService } = require("../electron/services/platform-access.cjs");
const mainSource = readFileSync(require.resolve("../electron/main.cjs"), "utf8");

const baseState = () => ({
  deviceId: "activity-device-1234",
  session: null,
  oauthPending: null,
  aiAccessCache: null,
  aiAccessFetchedAt: 0,
  aiUsageCache: null,
  aiUsageFetchedAt: 0,
  lastActivityDay: null,
});

test("product activity sends one anonymous installation update per UTC day", async () => {
  const service = new PlatformAccessService({
    apiBaseUrl: "https://example.test/api/v2",
  });
  service.state = baseState();
  service.save = async () => {};
  const requests = [];
  service.requestJson = async (url, options) => {
    requests.push({ url, options });
    return { status: "accepted", day: new Date().toISOString().slice(0, 10) };
  };

  const payload = {
    version: "0.1.22",
    platform: "win32",
    arch: "x64",
    distribution: "microsoft-store",
  };
  const [first, concurrent] = await Promise.all([
    service.recordActivity(payload),
    service.recordActivity(payload),
  ]);
  const repeated = await service.recordActivity(payload);

  assert.equal(first.status, "accepted");
  assert.equal(concurrent.status, "accepted");
  assert.equal(repeated.status, "already-recorded");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.test/api/v2/activity");
  assert.deepEqual(requests[0].options, {
    method: "POST",
    headers: {
      "X-Tex64-Device-Id": "activity-device-1234",
      "X-Tex64-Client": "desktop",
    },
    body: payload,
  });
  assert.equal("email" in requests[0].options.body, false);
  assert.equal("content" in requests[0].options.body, false);
});

test("signed-in activity remains pseudonymous and does not send account identity", async () => {
  const service = new PlatformAccessService({
    apiBaseUrl: "https://example.test/api/v2",
  });
  service.state = {
    ...baseState(),
    session: {
      accessToken: "access-token",
      refreshToken: null,
      accessTokenExpiresAt: Date.now() + 60_000,
      user: { id: "user-1", email: "person@example.test" },
    },
  };
  service.save = async () => {};
  let captured = null;
  service.requestJson = async (url, options) => {
    captured = { url, options };
    return { status: "accepted" };
  };

  await service.recordActivity({
    version: "0.1.22",
    platform: "darwin",
    arch: "arm64",
    distribution: "direct",
  });

  assert.equal(captured.options.headers["X-Tex64-Device-Id"], "activity-device-1234");
  assert.equal(captured.options.headers["X-Tex64-Client"], "desktop");
  assert.equal("Authorization" in captured.options.headers, false);
  assert.equal(JSON.stringify(captured.options.body).includes("person@example.test"), false);
});

test("activity is scheduled only for a focused packaged desktop app", () => {
  assert.match(mainSource, /app\.isPackaged === true/);
  assert.match(mainSource, /BrowserWindow\.getFocusedWindow\(\)/);
  assert.match(mainSource, /app\.on\("browser-window-focus", triggerProductActivity\)/);
});
