"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const { createAgentHandlers } = require("../electron/handlers/agent.cjs");
const { AgentService } = require("../electron/services/agent.cjs");
const {
  OFFICIAL_PLATFORM_CHAT_ENDPOINT,
  isOfficialPlatformProxyUrl,
} = require("../electron/services/openprism/llm-config.cjs");
const {
  completeSingleChat,
  resolveRequestIdentity,
} = require("../electron/services/openprism/run-loop.cjs");

const withEnv = async (overrides, callback) => {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("platform identity is restricted to the exact production proxy", async () => {
  const platformCalls = [];
  const service = {
    platformAccess: {
      refreshAccessToken: async () => {
        platformCalls.push("token");
        return "platform-jwt";
      },
      ensureDeviceId: async () => {
        platformCalls.push("device");
        return "platform-device";
      },
    },
  };

  assert.equal(isOfficialPlatformProxyUrl(OFFICIAL_PLATFORM_CHAT_ENDPOINT), true);
  assert.deepEqual(
    await resolveRequestIdentity(service, OFFICIAL_PLATFORM_CHAT_ENDPOINT, {
      apiKey: "must-not-replace-platform-identity",
    }),
    { accessToken: "platform-jwt", deviceId: "platform-device" }
  );
  assert.deepEqual(platformCalls, ["token", "device"]);

  const lookalikes = [
    "http://tex64.com/api/v2/ai/openai/chat/completions",
    "https://tex64.com:444/api/v2/ai/openai/chat/completions",
    "https://tex64.com.evil.test/api/v2/ai/openai/chat/completions",
    "https://evil.test/api/v2/ai/openai/chat/completions",
    "https://tex64.com/api/v2/ai/openai/chat/completions?forward=evil",
    "https://tex64.com/api/v2/ai/openai/chat/completions/extra",
    "https://user@tex64.com/api/v2/ai/openai/chat/completions",
  ];
  for (const endpoint of lookalikes) {
    assert.equal(isOfficialPlatformProxyUrl(endpoint), false, endpoint);
    assert.deepEqual(
      await resolveRequestIdentity(service, endpoint, { apiKey: "own-custom-key" }),
      { accessToken: "own-custom-key", deviceId: null },
      endpoint
    );
  }
  assert.deepEqual(
    platformCalls,
    ["token", "device"],
    "custom endpoints must not even request platform credentials"
  );
});

test("custom endpoints require a settings or environment API key", async () => {
  const service = {
    platformAccess: {
      refreshAccessToken: async () => {
        throw new Error("platform token must not be read");
      },
      ensureDeviceId: async () => {
        throw new Error("platform device must not be read");
      },
    },
  };
  const endpoint = "https://llm.example.test/v1/chat/completions";

  await withEnv({ TEX64_LLM_API_KEY: undefined }, async () => {
    await assert.rejects(
      resolveRequestIdentity(service, endpoint, {}),
      (error) => error?.code === "CUSTOM_LLM_API_KEY_REQUIRED"
    );
  });
  await withEnv({ TEX64_LLM_API_KEY: "environment-own-key" }, async () => {
    assert.deepEqual(await resolveRequestIdentity(service, endpoint, {}), {
      accessToken: "environment-own-key",
      deviceId: null,
    });
  });
});

test("a custom request sends only the user's own key", async () => {
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, headers: options.headers };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const service = {
    ensureUserSettings: () => ({
      getAgentSettings: async () => ({
        model: "provider/model",
        endpoint: "https://llm.example.test/v1/chat/completions",
        apiKey: "user-owned-key",
      }),
    }),
    platformAccess: {
      refreshAccessToken: async () => {
        throw new Error("platform token must not be read");
      },
      ensureDeviceId: async () => {
        throw new Error("platform device must not be read");
      },
    },
  };

  try {
    assert.equal(await completeSingleChat(service, { system: "system", user: "hello" }), "ok");
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(captured.url, "https://llm.example.test/v1/chat/completions");
  assert.equal(captured.headers.Authorization, "Bearer user-owned-key");
  assert.equal("X-Tex64-Device-Id" in captured.headers, false);
});

const createHandlerHarness = ({ initialSettings, access, checkAiAccess }) => {
  let settings = { ...initialSettings };
  const events = [];
  const updates = [];
  const runs = [];
  const statuses = [];
  const runningControllers = new Map();
  let tokenCounter = 0;
  let accessChecks = 0;
  const agentService = {
    startConversationRun: (conversationId) => {
      const controller = new AbortController();
      const token = `handler-run-${++tokenCounter}`;
      runningControllers.set(conversationId, { controller, token });
      return { conversationId, controller, token };
    },
    isRunCurrent: (conversationId, token) =>
      runningControllers.get(conversationId)?.token === token,
    finishConversationRun: (conversationId, token) => {
      if (runningControllers.get(conversationId)?.token === token) {
        runningControllers.delete(conversationId);
      }
    },
    markSessionDirty: () => {},
    sendStatus: (state, message, conversationId) =>
      statuses.push({ state, message, conversationId }),
    abort: (conversationId) => {
      runningControllers.get(conversationId)?.controller.abort();
    },
    waitForIdle: async () => runningControllers.size === 0,
    run: async (payload, run) => {
      runs.push(payload);
      if (run) agentService.finishConversationRun(payload.conversationId, run.token);
    },
  };
  const handlers = createAgentHandlers({
    agentService,
    ensureUserSettings: () => ({
      getAgentSettings: async () => ({ ...settings }),
      updateAgentSettings: async (partial) => {
        updates.push({ ...partial });
        settings = { ...settings, ...partial };
        return { ...settings };
      },
    }),
    sendToRenderer: (type, payload) => events.push({ type, payload }),
    platformService: {
      checkAiAccess: async () => {
        accessChecks += 1;
        if (typeof checkAiAccess === "function") return checkAiAccess();
        return access ?? {
          authenticated: true,
          allowed: false,
          reason: "QUOTA_EXCEEDED",
        };
      },
    },
  });
  return {
    handlers,
    events,
    updates,
    runs,
    statuses,
    runningControllers,
    agentService,
    get accessChecks() {
      return accessChecks;
    },
  };
};

test("agent run is stoppable and identity-checked during entitlement preflight", async () => {
  let releaseAccess;
  const accessGate = new Promise((resolve) => {
    releaseAccess = resolve;
  });
  const stopped = createHandlerHarness({
    initialSettings: { model: "Axiom1.0" },
    checkAiAccess: () => accessGate,
  });
  const conversationId = "tex64-ai-mode:workspace:main.tex";
  const pending = stopped.handlers.handleAgentRun(
    "write",
    {},
    conversationId,
    undefined,
    () => true,
  );
  assert.equal(stopped.runningControllers.size, 1);
  stopped.handlers.handleAgentAbort(conversationId);
  assert.equal(await stopped.agentService.waitForIdle(), false);
  releaseAccess({ authenticated: true, allowed: true });
  await pending;
  assert.equal(stopped.runs.length, 0, "an aborted preflight must never reach a backend");
  assert.equal(stopped.runningControllers.size, 0);
  assert.equal(stopped.statuses.at(-1)?.state, "idle");

  let releaseIdentityAccess;
  const identityGate = new Promise((resolve) => {
    releaseIdentityAccess = resolve;
  });
  let identityCurrent = true;
  const changed = createHandlerHarness({
    initialSettings: { model: "Axiom1.0" },
    checkAiAccess: () => identityGate,
  });
  const changedPending = changed.handlers.handleAgentRun(
    "write",
    {},
    conversationId,
    undefined,
    () => identityCurrent,
  );
  identityCurrent = false;
  releaseIdentityAccess({ authenticated: true, allowed: true });
  await changedPending;
  assert.equal(changed.runs.length, 0);
  assert.equal(changed.runningControllers.size, 0);
  assert.match(
    changed.events.find((event) => event.type === "agent:error")?.payload.message ?? "",
    /workspace changed/i,
  );
});

test("model-only protocol accepts only canonical ids and emits no settings secrets", async () => {
  const harness = createHandlerHarness({
    initialSettings: {
      model: "provider/private-model",
      endpoint: "https://private.example.test/v1/chat/completions",
      apiKey: "never-relay-this",
    },
  });

  assert.equal(await harness.handlers.handleAgentModelGet(), "Axiom1.0");
  assert.deepEqual(harness.events, [
    { type: "agent:model", payload: { model: "Axiom1.0" } },
  ]);
  assert.deepEqual(harness.updates, [{ model: "Axiom1.0" }]);
  assert.equal(JSON.stringify(harness.events).includes("never-relay-this"), false);
  assert.equal(JSON.stringify(harness.events).includes("private.example"), false);

  harness.events.length = 0;
  assert.deepEqual(await harness.handlers.handleAgentModelSet("Axiom1.0-pro"), {
    ok: true,
    model: "Axiom1.0-pro",
  });
  assert.deepEqual(harness.updates, [
    { model: "Axiom1.0" },
    { model: "Axiom1.0-pro" },
  ]);
  assert.deepEqual(
    harness.events.find((event) => event.type === "agent:model"),
    { type: "agent:model", payload: { model: "Axiom1.0-pro" } }
  );
  assert.deepEqual(
    Object.keys(harness.events.find((event) => event.type === "agent:model").payload),
    ["model"]
  );

  harness.events.length = 0;
  assert.deepEqual(await harness.handlers.handleAgentModelSet("gpt-5.6-sol"), {
    ok: false,
    model: "Axiom1.0-pro",
  });
  assert.deepEqual(
    harness.updates,
    [{ model: "Axiom1.0" }, { model: "Axiom1.0-pro" }],
    "an invalid guest model must not mutate full settings"
  );
  assert.deepEqual(harness.events, [
    { type: "agent:model", payload: { model: "Axiom1.0-pro" } },
  ]);

  harness.events.length = 0;
  assert.deepEqual(await harness.handlers.handleAgentModelSet("codex"), {
    ok: false,
    model: "Axiom1.0-pro",
  });
  assert.deepEqual(harness.updates, [
    { model: "Axiom1.0" },
    { model: "Axiom1.0-pro" },
  ]);
});

test("entitlement bypass is limited to Codex or custom endpoint plus own key", async () => {
  await withEnv(
    { TEX64_LLM_ENDPOINT: undefined, TEX64_LLM_API_KEY: undefined },
    async () => {
      const endpointOnly = createHandlerHarness({
        initialSettings: {
          model: "Axiom1.0",
          endpoint: "https://llm.example.test/v1/chat/completions",
        },
      });
      await endpointOnly.handlers.handleAgentRun("hello", {}, "endpoint-only");
      assert.equal(endpointOnly.runs.length, 0);
      assert.equal(endpointOnly.accessChecks, 0);
      assert.match(endpointOnly.events.at(-1).payload.message, /requires its own API key/);

      const customWithKey = createHandlerHarness({
        initialSettings: {
          model: "provider/model",
          endpoint: "https://llm.example.test/v1/chat/completions",
          apiKey: "own-key",
        },
      });
      await customWithKey.handlers.handleAgentRun("hello", {}, "custom-key");
      assert.equal(customWithKey.runs.length, 1);
      assert.equal(customWithKey.accessChecks, 0);

      const codex = createHandlerHarness({
        initialSettings: { model: "codex", endpoint: "" },
      });
      await codex.handlers.handleAgentRun("hello", {}, "codex");
      assert.equal(codex.runs.length, 1);
      assert.equal(codex.accessChecks, 0);

      const nativeCodex = createHandlerHarness({
        initialSettings: { model: "codex", endpoint: "" },
      });
      await nativeCodex.handlers.handleAgentRun(
        "hello",
        {},
        "tex64-ai-mode:workspace:main.tex",
      );
      assert.equal(nativeCodex.runs.length, 0);
      assert.equal(
        nativeCodex.accessChecks,
        1,
        "AI mode must not bypass TeX64 entitlement through a legacy Codex setting",
      );

      const nativeCustom = createHandlerHarness({
        initialSettings: {
          model: "provider/model",
          endpoint: "https://llm.example.test/v1/chat/completions",
          apiKey: "own-key",
        },
      });
      await nativeCustom.handlers.handleAgentRun(
        "hello",
        {},
        "tex64-ai-mode:workspace:main.tex",
      );
      assert.equal(nativeCustom.runs.length, 0);
      assert.equal(nativeCustom.accessChecks, 1);

      const officialWithOwnKey = createHandlerHarness({
        initialSettings: {
          model: "Axiom1.0",
          endpoint: OFFICIAL_PLATFORM_CHAT_ENDPOINT,
          apiKey: "must-not-bypass-platform",
        },
      });
      await officialWithOwnKey.handlers.handleAgentRun("hello", {}, "official");
      assert.equal(officialWithOwnKey.runs.length, 0);
      assert.equal(officialWithOwnKey.accessChecks, 1);
    }
  );

  await withEnv(
    {
      TEX64_LLM_ENDPOINT: "https://env-llm.example.test/v1/chat/completions",
      TEX64_LLM_API_KEY: "environment-own-key",
    },
    async () => {
      const envCustom = createHandlerHarness({
        initialSettings: { model: "provider/model", endpoint: "" },
      });
      await envCustom.handlers.handleAgentRun("hello", {}, "env-custom");
      assert.equal(envCustom.runs.length, 1);
      assert.equal(envCustom.accessChecks, 0);
    }
  );
});

test("state and undo replies echo request ids without duplicate undo results", async () => {
  const events = [];
  const agentService = new AgentService({
    workspace: { getRootPath: () => "/tmp/tex64-request-correlation" },
    ensureUserSettings: () => ({
      getAgentSettings: async () => ({ model: "Axiom1.0" }),
    }),
    sendToRenderer: (type, payload) => events.push({ type, payload }),
  });
  const handlers = createAgentHandlers({
    agentService,
    ensureUserSettings: agentService.ensureUserSettings,
    sendToRenderer: (type, payload) => events.push({ type, payload }),
    platformService: null,
  });

  await handlers.handleAgentStateGet("state-request-1");
  const stateEvents = events.filter((event) => event.type === "agent:state");
  assert.equal(stateEvents.length, 1);
  assert.equal(stateEvents[0].payload.requestId, "state-request-1");
  assert.ok(Array.isArray(stateEvents[0].payload.sessions));

  agentService.conversations.set("tex64-ai-mode:workspace:main.tex", [
    { role: "user", content: "AI document prompt" },
  ]);
  agentService.conversations.set("code-private", [
    { role: "user", content: "Code-only prompt" },
  ]);
  events.length = 0;
  await handlers.handleAgentStateGet(
    "state-request-scoped",
    "tex64-ai-mode:workspace:main.tex",
  );
  const scoped = events.find((event) => event.type === "agent:state")?.payload;
  assert.equal(scoped.conversationId, "tex64-ai-mode:workspace:main.tex");
  assert.deepEqual(
    scoped.sessions.map((session) => session.conversationId),
    ["tex64-ai-mode:workspace:main.tex"],
  );

  events.length = 0;
  await handlers.handleAgentUndoLastRunApply(
    "correlated-conversation",
    "undo-request-1"
  );
  const undoEvents = events.filter((event) => event.type === "agent:undoResult");
  assert.deepEqual(undoEvents, [
    {
      type: "agent:undoResult",
      payload: {
        requestId: "undo-request-1",
        conversationId: "correlated-conversation",
        ok: false,
        error: "No operations to undo.",
      },
    },
  ]);
});

test("AI guest bridge exposes correlated agent and platform state but not full settings", () => {
  const bridgeSource = readFileSync(
    require.resolve("../web-src/app/ai-mode-ui.ts"),
    "utf8"
  );
  const mainInitSource = readFileSync(
    require.resolve("../web-src/main-init.ts"),
    "utf8"
  );
  const requestBlock = bridgeSource.match(
    /const GUEST_REQUESTS:[\s\S]*?new Set\(\[([\s\S]*?)\]\);/
  )?.[1] ?? "";
  const eventBlock = bridgeSource.match(
    /const GUEST_EVENTS:[\s\S]*?new Set\(\[([\s\S]*?)\]\);/
  )?.[1] ?? "";

  for (const type of [
    "agent:model:get",
    "agent:model:set",
    "agent:state:get",
    "agent:undoLastRunApply",
    "platform:state:get",
    "feature:check",
    "platform:usage:get",
  ]) {
    assert.match(requestBlock, new RegExp(`"${type.replaceAll(":", "\\:")}"`));
  }
  assert.doesNotMatch(requestBlock, /agent:settings:(?:get|set)/);

  for (const type of [
    "agent:model",
    "agent:state",
    "agent:undoResult",
    "platform:auth",
    "platform:aiAccess",
    "platform:usage",
  ]) {
    assert.match(eventBlock, new RegExp(`"${type.replaceAll(":", "\\:")}"`));
  }
  assert.match(
    mainInitSource,
    /tex64Bridge\?\.onMessage\?\.\(\(message\) => aiModeApi\.deliver\(message\)\)/
  );
});

test("main dispatcher exposes the model-only protocol and AgentService restores first", () => {
  const mainSource = readFileSync(require.resolve("../electron/main.cjs"), "utf8");
  const agentSource = readFileSync(
    require.resolve("../electron/services/agent.cjs"),
    "utf8"
  );
  const rendererTypesSource = readFileSync(
    require.resolve("../web-src/app/types.ts"),
    "utf8"
  );
  const incomingHandlersSource = readFileSync(
    require.resolve("../web-src/app/ai-chat-incoming-handlers.ts"),
    "utf8"
  );
  assert.match(
    incomingHandlersSource,
    /statusState === "error" \|\| statusState === "resumable"[\s\S]{0,100}resumableConversations\.add\(chat\.id\)/,
    "restored resumable sessions must keep the Resume affordance",
  );
  assert.doesNotMatch(
    incomingHandlersSource,
    /agent:resume/,
    "terminal status handlers must never start another paid provider turn automatically",
  );
  assert.match(
    mainSource,
    /type === "agent:model:get"[\s\S]{0,160}handleAgentModelGet\(\)/
  );
  assert.match(
    mainSource,
    /type === "agent:model:set"[\s\S]{0,160}handleAgentModelSet\(message\.model\)/
  );
  assert.match(
    mainSource,
    /type === "agent:state:get"[\s\S]{0,200}handleAgentStateGet\(message\.requestId, message\.conversationId\)/
  );
  assert.match(
    mainSource,
    /type === "agent:undoLastRunApply"[\s\S]{0,220}message\.conversationId,[\s\S]{0,80}message\.requestId/
  );
  assert.match(
    mainSource,
    /const expectedConversationId =[\s\S]{0,240}conversationId !== expectedConversationId/,
    "main must bind an AI-mode conversation to its exact workspace document",
  );
  const runMethod = agentSource.slice(
    agentSource.indexOf("  async run(payload, prestartedRun = null)"),
  );
  const startRunIndex = runMethod.indexOf(
    "prestartedRun ?? this.startConversationRun(conversationId)",
  );
  const restoreIndex = runMethod.indexOf(
    "awaitAbortable(this.ensureSessionsRestored()",
  );
  assert.ok(
    startRunIndex >= 0 && restoreIndex >= 0 && startRunIndex < restoreIndex,
    "the run controller must exist before restored state or settings can await",
  );
  assert.match(rendererTypesSource, /AgentStatusState[\s\S]{0,100}"stopping"/);
  assert.match(
    incomingHandlersSource,
    /state === "running" \|\| state === "stopping"/,
    "Code mode must keep the conversation locked while abort settlement builds",
  );
});

test("renderer restores a send rejected by an existing manual operation", () => {
  const bridgeSource = readFileSync(
    require.resolve("../Resources/web/app/bridge-handlers.js"),
    "utf8",
  );
  const incomingSource = readFileSync(
    require.resolve("../Resources/web/app/ai-chat-incoming-handlers.js"),
    "utf8",
  );
  assert.match(bridgeSource, /case "agent:requestRejected"/);
  const start = incomingSource.indexOf("const handleRequestRejected");
  assert.ok(start >= 0);
  const handler = incomingSource.slice(start, start + 1800);
  assert.match(handler, /pendingAgentRequests\.delete/);
  assert.match(handler, /restoreDraftFromPending/);
  assert.doesNotMatch(handler, /runningConversations\.delete/);
});

test("abort keeps the run current until finally emits Aborted and waitForIdle observes cleanup", async () => {
  const originalFetch = global.fetch;
  const events = [];
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });
  global.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      markFetchStarted();
      const rejectAbort = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (options.signal.aborted) rejectAbort();
      else options.signal.addEventListener("abort", rejectAbort, { once: true });
    });

  const service = new AgentService({
    workspace: { getRootPath: () => "/tmp/tex64-abort-test" },
    ensureUserSettings: () => ({
      getAgentSettings: async () => ({ model: "Axiom1.0" }),
    }),
    sendToRenderer: (type, payload) => events.push({ type, payload }),
    platformAccess: {
      refreshAccessToken: async () => "platform-jwt",
      ensureDeviceId: async () => "platform-device",
    },
  });

  try {
    const runPromise = service.run({
      message: "hello",
      context: {},
      conversationId: "abort-test",
    });
    await fetchStarted;
    const entry = service.runningControllers.get("abort-test");
    assert.ok(entry);

    service.abort("abort-test");
    assert.equal(entry.controller.signal.aborted, true);
    assert.equal(
      service.runningControllers.has("abort-test"),
      true,
      "the run must stay current until its finally block"
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "agent:status" &&
          event.payload?.state === "stopping" &&
          event.payload?.conversationId === "abort-test"
      ),
      "abort must acknowledge settlement before the terminal status",
    );

    const idlePromise = service.waitForIdle(500);
    await runPromise;
    assert.equal(await idlePromise, true);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(service.runningControllers.size, 0);
  assert.ok(
    events.some(
      (event) =>
        event.type === "agent:status" &&
        event.payload?.state === "idle" &&
        event.payload?.message === "Aborted." &&
        event.payload?.conversationId === "abort-test"
    )
  );

  service.startConversationRun("timeout-test");
  assert.equal(await service.waitForIdle(5), false);
  const timeoutEntry = service.runningControllers.get("timeout-test");
  service.finishConversationRun("timeout-test", timeoutEntry.token);
});

test("abort during settings preflight prevents provider, identity, and build work", async () => {
  const originalFetch = global.fetch;
  let providerCalls = 0;
  let identityCalls = 0;
  let buildCalls = 0;
  let resolveSettings;
  let markSettingsRequested;
  const settingsRequested = new Promise((resolve) => {
    markSettingsRequested = resolve;
  });
  const delayedSettings = new Promise((resolve) => {
    resolveSettings = resolve;
  });
  const events = [];
  global.fetch = async () => {
    providerCalls += 1;
    throw new Error("provider must not be called after preflight abort");
  };

  const service = new AgentService({
    workspace: { getRootPath: () => "/tmp/tex64-preflight-abort-test" },
    ensureUserSettings: () => ({
      getAgentSettings: async () => {
        markSettingsRequested();
        return delayedSettings;
      },
    }),
    sendToRenderer: (type, payload) => events.push({ type, payload }),
    buildService: {
      build: async () => {
        buildCalls += 1;
        return { kind: "success", issues: [] };
      },
    },
    platformAccess: {
      refreshAccessToken: async () => {
        identityCalls += 1;
        return "platform-jwt";
      },
      ensureDeviceId: async () => {
        identityCalls += 1;
        return "platform-device";
      },
    },
  });

  try {
    const runPromise = service.run({
      message: "edit the paper",
      context: { activeFilePath: "main.tex" },
      conversationId: "preflight-abort-test",
      forcePlatformAxiom: true,
    });
    await settingsRequested;
    assert.equal(service.runningControllers.has("preflight-abort-test"), true);
    service.abort("preflight-abort-test");
    resolveSettings({ model: "Axiom1.0" });
    await runPromise;
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(providerCalls, 0);
  assert.equal(identityCalls, 0);
  assert.equal(buildCalls, 0);
  assert.equal(service.runningControllers.size, 0);
  assert.ok(
    events.some(
      (event) =>
        event.type === "agent:status" &&
        event.payload?.state === "stopping" &&
        event.payload?.conversationId === "preflight-abort-test",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "agent:status" &&
        event.payload?.state === "idle" &&
        event.payload?.message === "Aborted." &&
        event.payload?.conversationId === "preflight-abort-test",
    ),
  );
});
