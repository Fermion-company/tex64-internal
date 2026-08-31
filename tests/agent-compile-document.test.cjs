"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildAgentPolicy } = require("../electron/services/agent-policy.cjs");
const { AgentService } = require("../electron/services/agent.cjs");
const { executeToolCall } = require("../electron/services/agent-tool-executor.cjs");
const { BuildService } = require("../electron/services/build/service.cjs");
const {
  runAgentConversation,
  writeToolResultApplied,
} = require("../electron/services/openprism/run-loop.cjs");
const { buildTools } = require("../electron/services/openprism/tools.cjs");
const { buildSystemPrompt } = require("../electron/services/agent-prompt-utils.cjs");
const { UserSettingsService } = require("../electron/services/user-settings.cjs");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");

const ROOT = "/workspace/original";
const CONVERSATION_ID = "tex64-ai-mode:workspace:document";

test("partial write results latch a terminal compile despite per-file errors", () => {
  assert.equal(
    writeToolResultApplied({
      status: "partially_applied",
      files: [
        { path: "one.tex", ok: true },
        { path: "two.tex", ok: false, error: "CAS failed" },
      ],
    }),
    true,
  );
  assert.equal(
    writeToolResultApplied({
      status: "apply_failed",
      writeApplied: false,
      error: "CAS failed",
    }),
    false,
  );
});

const makeHarness = ({
  activeFilePath = "documents/notes/main.tex",
  buildResult,
  magicRoot = null,
  settings = {},
  onBuild,
  envService = null,
} = {}) => {
  const root = { current: ROOT };
  const events = [];
  const service = {
    workspace: {
      getRootPath: () => root.current,
      resolvePath: (value) => {
        const resolvedRoot = path.resolve(root.current);
        const resolved = path.resolve(resolvedRoot, String(value ?? ""));
        if (
          resolved !== resolvedRoot &&
          !resolved.startsWith(`${resolvedRoot}${path.sep}`)
        ) {
          throw new Error("The requested path must stay inside the captured workspace.");
        }
        return resolved;
      },
      resolveTexRootFromMagic: async () => magicRoot,
      rootInfo: async () => ({ path: "main.tex", source: "manual" }),
      loadSettings: async () => settings,
    },
    workspaceRootByConversation: new Map([[CONVERSATION_ID, ROOT]]),
    contextByConversation: new Map([
      [CONVERSATION_ID, activeFilePath ? { activeFilePath } : {}],
    ]),
    agentPolicy: buildAgentPolicy(),
    ensureSessionsRestored: async () => {},
    buildService: {
      build: async (...args) => {
        onBuild?.(...args);
        return (
          buildResult ?? {
            kind: "success",
            summary: "Build succeeded",
            issues: [],
            pdfPath: "/workspace/original/documents/notes/main.pdf",
            log: "compiler output",
          }
        );
      },
    },
    envService,
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
    sendStatus: () => {},
    sendBuildState: () => {},
    sendBuildLog: () => {},
    sendIssues: () => {},
  };
  service.executeToolCall = (toolCall, conversationId) =>
    executeToolCall(service, toolCall, conversationId);
  return { root, service, events };
};

const compileToolFor = (service) => {
  const tools = buildTools(service, CONVERSATION_ID, buildAgentPolicy(), {
    rootPath: ROOT,
    context: service.contextByConversation.get(CONVERSATION_ID),
  });
  const tool = tools.find((entry) => entry.function.name === "compile_document");
  assert.ok(tool, "compile_document must be exposed to the model");
  return tool;
};

test("agent builds wait for external builds and serialize across conversations", async () => {
  const buildService = { isBuilding: true };
  const service = new AgentService({
    workspace: { getRootPath: () => ROOT },
    ensureUserSettings: () => ({ getAgentSettings: async () => ({}) }),
    sendToRenderer: () => {},
    buildService,
  });
  const firstGate = {};
  firstGate.promise = new Promise((resolve) => {
    firstGate.resolve = resolve;
  });
  const order = [];
  const first = service.runSerializedBuild(async () => {
    order.push("first:start");
    await firstGate.promise;
    order.push("first:end");
    return "first";
  });
  const second = service.runSerializedBuild(async () => {
    order.push("second:start");
    order.push("second:end");
    return "second";
  });

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(order, [], "an ordinary Build-button run must finish first");
  buildService.isBuilding = false;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(order, ["first:start"]);
  firstGate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(order, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("Stop cancels an agent build still queued behind a manual build", async () => {
  const buildService = { isBuilding: true };
  const service = new AgentService({
    workspace: { getRootPath: () => ROOT },
    ensureUserSettings: () => ({ getAgentSettings: async () => ({}) }),
    sendToRenderer: () => {},
    buildService,
  });
  const conversationId = "queued-build";
  const run = service.startConversationRun(conversationId);
  let taskStarted = false;
  const pending = service.runSerializedBuild(async () => {
    taskStarted = true;
  }, conversationId);
  await new Promise((resolve) => setTimeout(resolve, 35));
  run.controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(taskStarted, false);
  buildService.isBuilding = false;
  service.finishConversationRun(conversationId, run.token);
});

test("compile_document defaults to the exact active nested document", async () => {
  let invocation = null;
  const { service } = makeHarness({
    settings: {
      buildProfileId: "release",
      buildProfiles: [
        { id: "release", outDir: "artifacts", extraArgs: "-halt-on-error" },
      ],
    },
    onBuild: (...args) => {
      invocation = args;
    },
  });

  const result = JSON.parse(await compileToolFor(service).execute({}));

  assert.equal(result.status, "success");
  assert.equal(result.targetFile, "documents/notes/main.tex");
  assert.deepEqual(invocation, [
    ROOT,
    "documents/notes/main.tex",
    "lualatex",
    { outDir: "artifacts", extraArgs: "-halt-on-error" },
  ]);
});

test("compile_document honors a file-local magic root without falling back to the workspace root", async () => {
  let targetFile = null;
  const { service } = makeHarness({
    activeFilePath: "documents/notes/chapters/intro.tex",
    magicRoot: "documents/notes/book.tex",
    onBuild: (_root, target) => {
      targetFile = target;
    },
  });

  const result = JSON.parse(await compileToolFor(service).execute({}));

  assert.equal(result.status, "success");
  assert.equal(result.targetFile, "documents/notes/book.tex");
  assert.equal(targetFile, "documents/notes/book.tex");
});

test("compile_document returns compiler issues and a bounded useful log", async () => {
  const longLog = `first failure\n${"context\n".repeat(2_000)}! Undefined control sequence.`;
  const { service } = makeHarness({
    buildResult: {
      kind: "failure",
      summary: "Undefined control sequence",
      issues: [
        {
          severity: "error",
          path: "documents/notes/main.tex",
          line: 42,
          message: "Undefined control sequence",
        },
      ],
      log: longLog,
    },
  });

  const result = JSON.parse(await compileToolFor(service).execute({}));

  assert.equal(result.status, "failure");
  assert.equal(result.targetFile, "documents/notes/main.tex");
  assert.equal(result.issues[0].line, 42);
  assert.match(result.logExcerpt, /earlier output omitted/);
  assert.match(result.logExcerpt, /Undefined control sequence/);
  assert.ok(result.logExcerpt.length < 12_100);
});

test("compile_document retries the same document after managed package recovery", async () => {
  const calls = [];
  let buildCount = 0;
  const { service } = makeHarness({
    onBuild: (rootPath, targetFile) => {
      calls.push([rootPath, targetFile]);
    },
    envService: {
      installMissingPackagesFromLog: async (_log, options) => {
        options.onPackagesResolved();
        return { success: true, packages: ["physics"], message: "Installed physics." };
      },
    },
  });
  service.buildService.build = async (rootPath, targetFile) => {
    calls.push([rootPath, targetFile]);
    buildCount += 1;
    if (buildCount === 1) {
      return {
        kind: "failure",
        summary: "physics.sty not found",
        issues: [{ severity: "error", message: "physics.sty not found" }],
        log: "! LaTeX Error: File `physics.sty' not found.",
      };
    }
    return {
      kind: "success",
      summary: "Build succeeded",
      issues: [],
      pdfPath: "/workspace/original/documents/notes/main.pdf",
      log: "ok",
    };
  };

  const result = JSON.parse(await compileToolFor(service).execute({}));

  assert.equal(result.status, "success");
  assert.deepEqual(calls, [
    [ROOT, "documents/notes/main.tex"],
    [ROOT, "documents/notes/main.tex"],
  ]);
});

test("all OpenPrism tools refuse work after the captured workspace changes", async () => {
  let buildCalled = false;
  const { root, service } = makeHarness({
    onBuild: () => {
      buildCalled = true;
    },
  });
  const tools = buildTools(service, CONVERSATION_ID, buildAgentPolicy(), {
    rootPath: ROOT,
  });
  root.current = "/workspace/replacement";

  const compileResult = JSON.parse(
    await tools.find((entry) => entry.function.name === "compile_document").execute({}),
  );
  const readResult = JSON.parse(
    await tools.find((entry) => entry.function.name === "read_file").execute({ path: "main.tex" }),
  );

  assert.equal(buildCalled, false);
  assert.match(compileResult.error, /workspace changed/i);
  assert.match(readResult.error, /workspace changed/i);
});

test("apply_patch cannot read a path outside the captured workspace", async () => {
  const { service } = makeHarness();
  const tools = buildTools(service, CONVERSATION_ID, buildAgentPolicy(), {
    rootPath: ROOT,
  });

  const result = JSON.parse(
    await tools.find((entry) => entry.function.name === "apply_patch").execute({
      path: "../outside.tex",
      patch: "--- a/outside.tex\n+++ b/outside.tex\n@@ -0,0 +1 @@\n+secret\n",
    }),
  );

  assert.match(result.error, /inside the captured workspace/i);
});

test("Code and AI tool sets never expose the unjournaled run_command shell", () => {
  const { service } = makeHarness();
  for (const conversationId of [
    "code-agent-test",
    "tex64-ai-mode:workspace:paper%2Fmain.tex",
  ]) {
    const tools = buildTools(service, conversationId, buildAgentPolicy(), {
      rootPath: ROOT,
    });
    assert.equal(
      tools.some((entry) => entry.function.name === "run_command"),
      false,
    );
  }
  assert.doesNotMatch(buildSystemPrompt({ uiLocale: "en" }, ROOT), /run_command/);
});

test("persisted settings cannot re-enable run_command", async (t) => {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-agent-settings-"));
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));
  const settingsPath = path.join(userData, "tex64-user-settings.json");
  await fsp.writeFile(
    settingsPath,
    JSON.stringify({ agent: { model: "Axiom1.0", allowRunCommand: true } }),
    "utf8",
  );
  const settings = new UserSettingsService(userData);

  assert.equal((await settings.getAgentSettings()).allowRunCommand, false);
  assert.equal(
    JSON.parse(await fsp.readFile(settingsPath, "utf8")).agent.allowRunCommand,
    false,
    "loading legacy settings persists the disabled shell boundary",
  );
  assert.equal(
    (await settings.updateAgentSettings({ allowRunCommand: true })).allowRunCommand,
    false,
  );
  const persisted = JSON.parse(await fsp.readFile(settingsPath, "utf8"));
  assert.equal(persisted.agent.allowRunCommand, false);
});

test("run_build preserves the workspace root fallback when no file is active", async () => {
  let targetFile = null;
  const { service } = makeHarness({
    activeFilePath: null,
    onBuild: (_root, target) => {
      targetFile = target;
    },
  });

  const result = JSON.parse(await compileToolFor(service).execute({}));

  assert.equal(result.status, "success");
  assert.equal(result.targetFile, "main.tex");
  assert.equal(targetFile, "main.tex");
});

test("run_build falls back to the document main file while a bibliography is active", async () => {
  let targetFile = null;
  const { service } = makeHarness({
    activeFilePath: "references.bib",
    onBuild: (_root, target) => {
      targetFile = target;
    },
  });
  service.contextByConversation.set(CONVERSATION_ID, {
    activeFilePath: "references.bib",
    documentMainFile: "paper/main.tex",
  });

  const result = JSON.parse(await compileToolFor(service).execute({}));

  assert.equal(result.status, "success");
  assert.equal(result.targetFile, "paper/main.tex");
  assert.equal(targetFile, "paper/main.tex");
});

test("run_build still rejects an explicit non-TeX target", async () => {
  let buildCalled = false;
  const { service } = makeHarness({
    onBuild: () => {
      buildCalled = true;
    },
  });

  const result = await executeToolCall(
    service,
    { name: "run_build", args: { mainFile: "references.bib" } },
    CONVERSATION_ID,
  );

  assert.equal(buildCalled, false);
  assert.match(result.error, /requires a \.tex document/i);
});

test("a completed build is not held by a stuck workspace refresh after Stop", async () => {
  const refreshStarted = {};
  refreshStarted.promise = new Promise((resolve) => {
    refreshStarted.resolve = resolve;
  });
  const never = new Promise(() => {});
  const { service } = makeHarness();
  const controller = new AbortController();
  service.runningControllers = new Map([
    [CONVERSATION_ID, { controller }],
  ]);
  service.updateWorkspaceIfNeeded = async () => {
    refreshStarted.resolve();
    return never;
  };

  const pending = executeToolCall(
    service,
    { name: "run_build", args: {} },
    CONVERSATION_ID,
  );
  await refreshStarted.promise;
  controller.abort();
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), 300)),
  ]);

  assert.equal(outcome.status, "success");
});

test("run_build refuses a document outside the captured workspace", async () => {
  let buildCalled = false;
  const { service } = makeHarness({
    onBuild: () => {
      buildCalled = true;
    },
  });

  const result = await executeToolCall(
    service,
    { name: "run_build", args: { mainFile: "../outside.tex" } },
    CONVERSATION_ID,
  );

  assert.equal(buildCalled, false);
  assert.match(result.error, /inside the current workspace/i);
});

test("the run loop advertises compile_document and stops if its workspace changes", async () => {
  const originalFetch = global.fetch;
  const root = { current: ROOT };
  const events = [];
  const conversation = [];
  const run = { token: "run-token", controller: new AbortController() };
  let requestBody = null;
  const service = {
    workspace: { getRootPath: () => root.current },
    ensureUserSettings: () => ({
      getAgentSettings: async () => ({ model: "Axiom1.0" }),
    }),
    resolveAgentPolicy: () => buildAgentPolicy(),
    resolveAgentOptions: () => ({ maxIterations: 1 }),
    contextByConversation: new Map(),
    workspaceRootByConversation: new Map(),
    buildConversation: () => conversation,
    markSessionDirty: () => {},
    startConversationRun: () => run,
    isRunCurrent: (_conversationId, token) => token === run.token,
    finishConversationRun: () => {},
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
    sendStatus: () => {},
    platformAccess: {
      refreshAccessToken: async () => "test-token",
      ensureDeviceId: async () => "test-device",
    },
  };
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    root.current = "/workspace/replacement";
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "stale" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    await runAgentConversation(service, {
      message: "Compile this document.",
      context: { activeFilePath: "documents/notes/main.tex" },
      conversationId: CONVERSATION_ID,
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.ok(
    requestBody.tools.some((entry) => entry.function?.name === "compile_document"),
  );
  assert.match(requestBody.messages[0].content, /Compile LaTeX only with compile_document/);
  assert.equal(
    events.some((event) => event.channel === "agent:message" && event.payload.text === "stale"),
    false,
  );
  const errorEvent = events.find((event) => event.channel === "agent:error");
  assert.match(errorEvent?.payload?.message ?? "", /workspace changed/i);
});

const runWriteCompletionScenario = async (
  t,
  { modelCompiles, buildStatus = "success", interruption = null },
) => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-agent-final-build-"));
  t.after(() => fsp.rm(rootPath, { recursive: true, force: true }));
  const sourcePath = path.join(rootPath, "main.tex");
  const originalSource = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Before",
    "\\end{document}",
    "",
  ].join("\n");
  const updatedSource = originalSource.replace("Before", "After");
  await fsp.writeFile(sourcePath, originalSource, "utf8");

  const originalFetch = global.fetch;
  const conversationId = [
    CONVERSATION_ID,
    modelCompiles ? "model-build" : "fallback-build",
    interruption || "normal",
  ].join(":");
  const conversation = [];
  const proposals = new Map();
  const events = [];
  const run = { token: "final-build-run", controller: new AbortController() };
  let providerCalls = 0;
  let fetchAttempts = 0;
  let buildCalls = 0;

  const toolResponse = (id, name, args) => ({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
  const firstWriteResponse =
    interruption === "abort-during-multi-write"
      ? {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "write-1",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "main.tex",
                        content: updatedSource,
                        mode: "overwrite",
                        summary: "Update body",
                      }),
                    },
                  },
                  {
                    id: "write-2",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "main.tex",
                        content: updatedSource.replace("After", "Should not run"),
                        mode: "overwrite",
                        summary: "Unexpected second write",
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }
      : toolResponse("write-1", "write_file", {
          path: "main.tex",
          content: updatedSource,
          mode: "overwrite",
          summary: "Update body",
        });
  const responses = [
    firstWriteResponse,
    ...(modelCompiles
      ? [toolResponse("compile-1", "compile_document", {})]
      : []),
    {
      choices: [{ message: { role: "assistant", content: "Done." } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    },
  ];

  const resolvePath = (value) => {
    const resolved = path.resolve(rootPath, String(value ?? ""));
    assert.ok(
      resolved === rootPath || resolved.startsWith(`${rootPath}${path.sep}`),
      "test tool target must remain inside its temporary workspace",
    );
    return resolved;
  };
  const service = {
    workspace: {
      getRootPath: () => rootPath,
      resolvePath,
    },
    ensureUserSettings: () => ({
      getAgentSettings: async () => ({ model: "Axiom1.0" }),
    }),
    resolveAgentPolicy: () => buildAgentPolicy(),
    resolveAgentOptions: () => ({ maxIterations: 5 }),
    contextByConversation: new Map(),
    workspaceRootByConversation: new Map(),
    buildConversation: () => conversation,
    markSessionDirty: () => {},
    startConversationRun: () => run,
    isRunCurrent: (_conversationId, token) => token === run.token,
    finishConversationRun: () => {},
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
    sendStatus: (state, message, targetConversationId) =>
      events.push({ channel: "agent:status", payload: { state, message, conversationId: targetConversationId } }),
    proposals,
    getContextSnapshot: () => null,
    applyProposal: async (proposalId) => {
      const proposal = proposals.get(proposalId);
      assert.ok(proposal, "write proposal must exist before auto-apply");
      await fsp.writeFile(resolvePath(proposal.path), proposal.content, "utf8");
      if (interruption === "network-after-write-verification") {
        await fsp.appendFile(resolvePath(proposal.path), "% simulated mismatch\n", "utf8");
      }
      proposals.delete(proposalId);
      if (
        interruption === "abort-after-write" ||
        interruption === "abort-during-multi-write"
      ) {
        run.controller.abort();
      }
      return { ok: true, proposalId, path: proposal.path };
    },
    executeToolCall: async (toolCall) => {
      assert.equal(toolCall.name, "run_build");
      buildCalls += 1;
      const result = {
        status: buildStatus,
        targetFile: "main.tex",
        summary: buildStatus === "success" ? "Build succeeded" : "Build failed",
        ...(buildStatus === "success"
          ? { pdfPath: path.join(rootPath, "main.pdf") }
          : {}),
      };
      if (interruption === "abort-after-compile") run.controller.abort();
      return result;
    },
    platformAccess: {
      refreshAccessToken: async () => "test-token",
      ensureDeviceId: async () => "test-device",
      checkAiAccess: async () => ({
        allowed: true,
        reason: "active",
        quota: { remainingTokens: 1_000_000 },
      }),
    },
  };

  global.fetch = async (_url, options = {}) => {
    fetchAttempts += 1;
    if (options.signal?.aborted) {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    }
    if (
      ["network-after-write", "network-after-write-verification"].includes(interruption) &&
      providerCalls === 1
    ) {
      throw new Error("Simulated provider failure.");
    }
    const body = responses[providerCalls];
    providerCalls += 1;
    assert.ok(body, "the run loop must not make an unexpected provider call");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await runAgentConversation(service, {
      message: "Update the body and compile it.",
      context: {
        activeFilePath: "main.tex",
        documentMainFile: "main.tex",
        uiLocale: "en",
      },
      conversationId,
      forcePlatformAxiom: true,
    });
  } finally {
    global.fetch = originalFetch;
  }

  const expectedSource =
    interruption === "network-after-write-verification"
      ? `${updatedSource}% simulated mismatch\n`
      : updatedSource;
  assert.equal(await fsp.readFile(sourcePath, "utf8"), expectedSource);
  assert.equal(buildCalls, 1);
  const expectedProviderCalls =
    interruption === "abort-after-write" ||
    interruption === "abort-during-multi-write" ||
    interruption === "network-after-write" ||
    interruption === "network-after-write-verification"
      ? 1
      : interruption === "abort-after-compile"
        ? 2
        : modelCompiles
          ? 3
          : 2;
  assert.equal(providerCalls, expectedProviderCalls);
  assert.equal(
    fetchAttempts,
    expectedProviderCalls +
      (["network-after-write", "network-after-write-verification"].includes(interruption)
        ? 1
        : 0),
  );
  assert.equal(
    events.filter(
      (event) =>
        event.channel === "agent:tool" &&
        event.payload.name === "compile_document" &&
        event.payload.summary === "running",
    ).length,
    1,
  );
  assert.equal(
    events.at(-1)?.payload?.state,
    interruption === "network-after-write" || interruption === "network-after-write-verification"
      ? "error"
      : buildStatus === "success"
        ? "idle"
        : "resumable",
  );
  const finalMessage = events.findLast(
    (event) => event.channel === "agent:message",
  );
  if (
    interruption === "network-after-write" ||
    interruption === "network-after-write-verification"
  ) {
    assert.match(
      events.findLast((event) => event.channel === "agent:error")?.payload
        ?.message ?? "",
      /simulated provider failure/i,
    );
    assert.equal(finalMessage, undefined);
  } else if (interruption) {
    assert.equal(
      events.some((event) => event.channel === "agent:error"),
      buildStatus !== "success",
    );
    assert.equal(finalMessage, undefined);
  } else if (buildStatus === "success") {
    assert.equal(
      events.some((event) => event.channel === "agent:error"),
      false,
    );
    assert.equal(finalMessage?.payload?.text, "Done.");
  } else {
    const errorEvent = events.findLast(
      (event) => event.channel === "agent:error",
    );
    assert.match(
      errorEvent?.payload?.message ?? "",
      /compilation error remains/i,
    );
    assert.match(
      finalMessage?.payload?.text ?? "",
      /compilation error remains/i,
    );
  }
};

test("a normal final response compiles pending writes exactly once without another model call", async (t) => {
  await runWriteCompletionScenario(t, { modelCompiles: false });
});

test("a successful model compile prevents the normal completion fallback from building twice", async (t) => {
  await runWriteCompletionScenario(t, { modelCompiles: true });
});

test("a failed normal-completion fallback leaves the turn resumable", async (t) => {
  await runWriteCompletionScenario(t, {
    modelCompiles: false,
    buildStatus: "failure",
  });
});

test("a failed model compile is reported without retrying the unchanged document", async (t) => {
  await runWriteCompletionScenario(t, {
    modelCompiles: true,
    buildStatus: "failure",
  });
});

test("aborting after a write compiles the partial edit exactly once in the host", async (t) => {
  await runWriteCompletionScenario(t, {
    modelCompiles: false,
    interruption: "abort-after-write",
  });
});

test("aborting during a multi-tool response stops before the next write", async (t) => {
  await runWriteCompletionScenario(t, {
    modelCompiles: false,
    interruption: "abort-during-multi-write",
  });
});

test("aborting after a successful model compile does not build again", async (t) => {
  await runWriteCompletionScenario(t, {
    modelCompiles: true,
    interruption: "abort-after-compile",
  });
});

test("a provider failure after a write still compiles the partial edit once", async (t) => {
  await runWriteCompletionScenario(t, {
    modelCompiles: false,
    interruption: "network-after-write",
  });
});

test("a provider failure after post-write verification fails still compiles committed bytes once", async (t) => {
  await runWriteCompletionScenario(t, {
    modelCompiles: false,
    interruption: "network-after-write-verification",
  });
});

test("compile_document produces a real PDF for a nested active document", async (t) => {
  const buildService = new BuildService();
  if (!buildService.findLatexmk()) {
    t.skip("latexmk is not installed in this test environment");
    return;
  }

  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-agent-compile-"));
  t.after(() => fsp.rm(rootPath, { recursive: true, force: true }));
  await fsp.mkdir(path.join(rootPath, "documents", "notes"), { recursive: true });
  await fsp.writeFile(
    path.join(rootPath, "main.tex"),
    "\\documentclass{article}\\begin{document}\\undefinedRootCommand\\end{document}\n",
    "utf8",
  );
  await fsp.writeFile(
    path.join(rootPath, "documents", "notes", "main.tex"),
    "\\documentclass{article}\\begin{document}Nested document\\end{document}\n",
    "utf8",
  );

  const conversationId = "real-nested-build";
  const workspace = new WorkspaceManager();
  workspace.setRootPath(rootPath);
  const service = {
    workspace,
    workspaceRootByConversation: new Map([[conversationId, rootPath]]),
    contextByConversation: new Map([
      [conversationId, { activeFilePath: "documents/notes/main.tex" }],
    ]),
    agentPolicy: buildAgentPolicy(),
    ensureSessionsRestored: async () => {},
    buildService,
    updateWorkspaceIfNeeded: async () => {},
    sendToRenderer: () => {},
    sendStatus: () => {},
    sendBuildState: () => {},
    sendBuildLog: () => {},
    sendIssues: () => {},
  };

  const result = await executeToolCall(
    service,
    { name: "run_build", args: {} },
    conversationId,
  );

  assert.equal(result.status, "success", result.summary || result.error);
  assert.equal(result.targetFile, "documents/notes/main.tex");
  assert.equal(
    await fsp
      .stat(path.join(rootPath, "documents", "notes", "main.pdf"))
      .then((stat) => stat.isFile()),
    true,
  );
});
