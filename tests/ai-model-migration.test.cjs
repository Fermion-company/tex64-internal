"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { UserSettingsService } = require("../electron/services/user-settings.cjs");
const {
  migrateLegacyAxiomModel,
  resolveLLMConfig,
} = require("../electron/services/openprism/llm-config.cjs");
const {
  buildChatRequestBody,
  requiresReasoningNoneForChatTools,
  runAgentConversation,
} = require("../electron/services/openprism/run-loop.cjs");

test("persisted Axiom 0.9.1 settings migrate to Axiom 1.0 without losing other settings", async (t) => {
  const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-ai-model-migration-"));
  t.after(() => fsp.rm(userDataPath, { recursive: true, force: true }));

  const settingsPath = path.join(userDataPath, "tex64-user-settings.json");
  await fsp.writeFile(
    settingsPath,
    JSON.stringify({
      agent: { model: "Axiom0.9.1-pro", maxIterations: 37 },
      recentProjects: [{ path: "/tmp/paper", name: "paper", openedAt: 123 }],
      customPreference: "preserved",
    }),
    "utf8"
  );

  const service = new UserSettingsService(userDataPath);
  const loaded = await service.load();

  assert.equal(loaded.agent.model, "Axiom1.0-pro");
  assert.equal(loaded.agent.maxIterations, 24);
  assert.equal(loaded.customPreference, "preserved");
  assert.equal(
    JSON.parse(await fsp.readFile(settingsPath, "utf8")).agent.maxIterations,
    24,
    "legacy runaway iteration settings are clamped and persisted"
  );

  const updated = await service.updateAgentSettings({ model: " Axiom0.9.1 " });
  assert.equal(updated.model, "Axiom1.0", "legacy updates from an older renderer are normalized");
});

test("new settings and LLM config use Axiom 1.0 while preserving custom model ids", async (t) => {
  const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-ai-model-default-"));
  t.after(() => fsp.rm(userDataPath, { recursive: true, force: true }));

  assert.equal((await new UserSettingsService(userDataPath).getAgentSettings()).model, "Axiom1.0");
  assert.equal(resolveLLMConfig({ model: "Axiom0.9.1" }).model, "Axiom1.0");
  assert.equal(resolveLLMConfig({ model: "Axiom0.9.1-pro" }).model, "Axiom1.0-pro");
  assert.equal(migrateLegacyAxiomModel("provider/custom-model"), "provider/custom-model");
});

test("Axiom 1.0 and GPT-5.6 Chat tool requests explicitly disable reasoning", () => {
  for (const model of [
    "Axiom1.0",
    "Axiom1.0-pro",
    "gpt-5.6",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ]) {
    assert.equal(requiresReasoningNoneForChatTools(model), true, model);
    assert.equal(
      buildChatRequestBody({ model, messages: [], tools: [] }).reasoning_effort,
      "none",
      model
    );
  }

  for (const model of ["Axiom0.9.1", "Axiom1.01", "gpt-5.60", "provider/custom-model"]) {
    assert.equal(requiresReasoningNoneForChatTools(model), false, model);
    assert.equal(
      Object.hasOwn(buildChatRequestBody({ model, messages: [], tools: [] }), "reasoning_effort"),
      false,
      model
    );
  }
});

const createAgentService = (model) => {
  const conversation = [];
  const run = { token: "test-run", controller: new AbortController() };
  return {
    workspace: { getRootPath: () => "/tmp/tex64-test-project" },
    ensureUserSettings: () => ({ getAgentSettings: async () => ({ model }) }),
    resolveAgentPolicy: () => ({}),
    resolveAgentOptions: () => ({ maxIterations: 1 }),
    contextByConversation: new Map(),
    workspaceRootByConversation: new Map(),
    buildConversation: () => conversation,
    markSessionDirty: () => {},
    startConversationRun: () => run,
    isRunCurrent: (_conversationId, token) => token === run.token,
    finishConversationRun: () => {},
    sendToRenderer: () => {},
    sendStatus: () => {},
    platformAccess: {
      refreshAccessToken: async () => "test-token",
      ensureDeviceId: async () => "test-device",
    },
  };
};

test("run loop sends the canonical model and reasoning_effort none to fetch", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    await runAgentConversation(createAgentService("Axiom0.9.1"), {
      message: "Write a short introduction.",
      conversationId: "legacy",
    });
    await runAgentConversation(createAgentService("gpt-5.6-terra"), {
      message: "Write a short introduction.",
      conversationId: "terra",
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.deepEqual(
    requests.map(({ model, reasoning_effort }) => ({ model, reasoning_effort })),
    [
      { model: "Axiom1.0", reasoning_effort: "none" },
      { model: "gpt-5.6-terra", reasoning_effort: "none" },
    ]
  );
  assert.ok(requests.every((body) => Array.isArray(body.tools) && body.tools.length > 0));
});
