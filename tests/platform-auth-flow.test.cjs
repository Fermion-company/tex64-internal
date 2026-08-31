"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createPlatformHandlers,
} = require("../electron/handlers/misc-platform-handlers.cjs");

const makeHarness = ({ failBrowser = false } = {}) => {
  const calls = [];
  const events = [];
  let auth = {
    authenticated: false,
    pending: false,
    plan: null,
    user: null,
  };
  const platformService = {
    getAuthSnapshot: async () => ({ ...auth }),
    startGoogleAuth: async () => {
      calls.push("start");
      auth = { ...auth, pending: true };
      return { authUrl: "https://tex64.com/api/v2/auth/google/start?desktop=1" };
    },
    cancelGoogleAuthPending: async () => {
      calls.push("cancel");
      auth = { ...auth, pending: false };
    },
  };
  const handlers = createPlatformHandlers({
    platformService,
    shell: {
      openExternal: async (url) => {
        calls.push(["browser", url]);
        if (failBrowser) throw new Error("browser unavailable");
      },
    },
    sendToRenderer: (type, payload) => events.push({ type, payload }),
    ensureProtocolClient: () => calls.push("protocol"),
    appVersion: "0.1.24",
    appPlatform: "darwin",
    appArch: "arm64",
  });
  return { calls, events, handlers };
};

test("login starts the desktop callback flow and opens the exact returned URL", async () => {
  const { calls, events, handlers } = makeHarness();
  await handlers.handleAuthGoogleStart();

  assert.deepEqual(calls, [
    "protocol",
    "start",
    ["browser", "https://tex64.com/api/v2/auth/google/start?desktop=1"],
  ]);
  const authEvents = events.filter((event) => event.type === "platform:auth");
  assert.equal(authEvents.length, 2);
  assert.equal(authEvents[0].payload.auth.pending, false);
  assert.equal(authEvents[1].payload.auth.pending, true);
});

test("login clears its pending state when Chrome cannot be opened", async () => {
  const { calls, events, handlers } = makeHarness({ failBrowser: true });
  await handlers.handleAuthGoogleStart();

  assert.equal(calls.includes("cancel"), true);
  const authEvents = events.filter((event) => event.type === "platform:auth");
  const last = authEvents.at(-1)?.payload;
  assert.equal(last.auth.pending, false);
  assert.equal(last.error.code, "AUTH_BROWSER_OPEN_FAILED");
});
