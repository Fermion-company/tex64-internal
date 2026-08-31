"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AgentService } = require("../electron/services/agent.cjs");
const { createAgentHandlers } = require("../electron/handlers/agent.cjs");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");
const {
  WorkspaceWriterCoordinator,
} = require("../electron/services/workspace-writer-coordinator.cjs");

test("renderer saves and external Axiom writers cannot overlap", () => {
  const rootPath = "/workspace";
  const coordinator = new WorkspaceWriterCoordinator();
  const service = new AgentService({
    workspace: { getRootPath: () => rootPath },
    sendToRenderer: () => {},
    isRendererWorkspaceMutationActive: (root) =>
      coordinator.hasRendererMutation(root),
  });
  coordinator.setAgentActiveCheck((root) =>
    service.runningWorkspaceRoots.has(root));

  const releaseSave = coordinator.beginRendererMutation(rootPath);
  assert.throws(
    () => service.startConversationRun("save-race"),
    { code: "RENDERER_WORKSPACE_MUTATION_IN_PROGRESS" },
  );
  releaseSave();

  const run = service.startConversationRun("agent-race");
  assert.throws(
    () => coordinator.beginRendererMutation(rootPath),
    { code: "AGENT_WORKSPACE_BUSY" },
  );
  service.finishConversationRun("agent-race", run.token);

  const releaseAfter = coordinator.beginRendererMutation(rootPath);
  releaseAfter();
  assert.equal(coordinator.hasRendererMutation(rootPath), false);
});

test("sending during a renderer save returns a scoped terminal error", async () => {
  const events = [];
  const statuses = [];
  const service = {
    startConversationRun: () => {
      const error = new Error("save active");
      error.code = "RENDERER_WORKSPACE_MUTATION_IN_PROGRESS";
      throw error;
    },
    sendStatus: (state, message, conversationId) =>
      statuses.push({ state, message, conversationId }),
  };
  const handlers = createAgentHandlers({
    agentService: service,
    ensureUserSettings: () => ({
      getAgentSettings: async () => assert.fail("preflight must not start"),
    }),
    sendToRenderer: (type, payload) => events.push({ type, payload }),
  });

  await handlers.handleAgentRun("edit", {}, "conversation-save-race");

  assert.deepEqual(statuses.map((entry) => entry.state), ["error"]);
  assert.equal(statuses[0].conversationId, "conversation-save-race");
  assert.equal(events[0].type, "agent:error");
  assert.equal(events[0].payload.conversationId, "conversation-save-race");
});

test("a send racing manual Apply is explicitly rejected without replacing its run", async () => {
  const events = [];
  const service = {
    startConversationRun: () => {
      const error = new Error("apply active");
      error.code = "AGENT_RUN_IN_PROGRESS";
      throw error;
    },
  };
  const handlers = createAgentHandlers({
    agentService: service,
    ensureUserSettings: () => ({
      getAgentSettings: async () => assert.fail("preflight must not start"),
    }),
    sendToRenderer: (type, payload) => events.push({ type, payload }),
  });

  await handlers.handleAgentRun("new request", {}, "manual-operation-chat");

  assert.deepEqual(events, [
    {
      type: "agent:requestRejected",
      payload: {
        conversationId: "manual-operation-chat",
        message: "A change is still being applied. Your message was not sent.",
      },
    },
  ]);
});

test("an unresolved conflict blocks every conversation in its workspace only", () => {
  let rootPath = "/workspace-a";
  const service = new AgentService({
    workspace: { getRootPath: () => rootPath },
    sendToRenderer: () => {},
  });

  service.reportContentConflict("conversation-a", "main.tex");
  assert.throws(
    () => service.startConversationRun("conversation-b"),
    { code: "AGENT_CONTENT_CONFLICT" },
  );

  rootPath = "/workspace-b";
  const otherWorkspaceRun = service.startConversationRun("conversation-b");
  service.finishConversationRun("conversation-b", otherWorkspaceRun.token);

  service.discardContentConflictsForWorkspace("/workspace-a");
  rootPath = "/workspace-a";
  const resumed = service.startConversationRun("conversation-c");
  service.finishConversationRun("conversation-c", resumed.token);
});

test("the post-conflict build owns the workspace until it settles", async () => {
  let releaseBuild;
  let buildStartedResolve;
  const buildStarted = new Promise((resolve) => {
    buildStartedResolve = resolve;
  });
  const buildGate = new Promise((resolve) => {
    releaseBuild = resolve;
  });
  const service = new AgentService({
    workspace: { getRootPath: () => "/workspace" },
    sendToRenderer: () => {},
  });
  service.executeToolCall = async () => {
    buildStartedResolve();
    await buildGate;
    return { status: "success" };
  };

  service.reportContentConflict("conversation-a", "main.tex");
  service.resolveContentConflict("conversation-a", "main.tex");
  await buildStarted;
  assert.throws(
    () => service.startConversationRun("conversation-b"),
    { code: "AGENT_WORKSPACE_RUN_IN_PROGRESS" },
  );
  releaseBuild();
  assert.equal(await service.waitForIdle(500), true);
});

test("manual Apply and Undo cannot overlap a turn in another chat", async () => {
  const events = [];
  const service = new AgentService({
    workspace: { getRootPath: () => "/workspace" },
    sendToRenderer: (type, payload) => events.push({ type, payload }),
  });
  service.proposals.set("proposal-b", {
    id: "proposal-b",
    type: "write",
    path: "main.tex",
    content: "new",
    conversationId: "conversation-b",
    workspaceRootPath: "/workspace",
  });
  const owner = service.startConversationRun("conversation-a");

  const apply = await service.applyProposal("proposal-b");
  const undo = await service.undoLastRunApply("conversation-b", {
    emitRenderer: false,
  });
  const legacyUndo = await service.undoLastApply("conversation-b", {
    emitRenderer: false,
  });

  assert.equal(apply.ok, false);
  assert.match(apply.error, /Another Axiom turn/);
  assert.equal(undo.ok, false);
  assert.equal(undo.reason, "workspace_busy");
  assert.match(undo.message, /Another Axiom turn/);
  assert.equal(legacyUndo.ok, false);
  assert.equal(legacyUndo.reason, "workspace_busy");
  assert.equal(service.proposals.has("proposal-b"), true);
  assert.equal(
    events.some(
      (event) => event.type === "agent:applyResult" && event.payload.ok === false,
    ),
    true,
  );
  service.finishConversationRun("conversation-a", owner.token);
});

test("an Apply owned by the active turn may mutate its workspace", async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-apply-lease-"));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(rootPath);
  const service = new AgentService({
    workspace,
    sendToRenderer: () => {},
    updateWorkspaceIfNeeded: async () => true,
    requestIndex: () => {},
  });
  service.proposals.set("mkdir-active", {
    id: "mkdir-active",
    type: "mkdir",
    path: "created",
    conversationId: "conversation-active",
    workspaceRootPath: rootPath,
  });
  const owner = service.startConversationRun("conversation-active");

  try {
    const result = await service.applyProposal("mkdir-active", {
      _workspaceRunToken: owner.token,
      skipAutoBuild: true,
    });
    assert.equal(result.ok, true);
    assert.equal((await fs.stat(path.join(rootPath, "created"))).isDirectory(), true);
  } finally {
    service.finishConversationRun("conversation-active", owner.token);
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test("creating an existing directory is a no-op that Undo never owns", async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-mkdir-existing-"));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(rootPath);
  await fs.mkdir(path.join(rootPath, "chapters"));
  const service = new AgentService({
    workspace,
    sendToRenderer: () => {},
    updateWorkspaceIfNeeded: async () => true,
    requestIndex: () => {},
  });
  service.proposals.set("mkdir-existing", {
    id: "mkdir-existing",
    type: "mkdir",
    path: "chapters",
    conversationId: "conversation-mkdir-existing",
    workspaceRootPath: rootPath,
  });
  const owner = service.startConversationRun("conversation-mkdir-existing");

  try {
    const result = await service.applyProposal("mkdir-existing", {
      _workspaceRunToken: owner.token,
      skipAutoBuild: true,
    });
    assert.equal(result.ok, true);
    assert.equal(service.applyUndoStack.length, 0);
    assert.equal((await fs.stat(path.join(rootPath, "chapters"))).isDirectory(), true);
  } finally {
    service.finishConversationRun("conversation-mkdir-existing", owner.token);
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test("manual Apply and Undo publish a complete running-to-idle lifecycle", async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-manual-status-"));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(rootPath);
  const events = [];
  const service = new AgentService({
    workspace,
    sendToRenderer: (type, payload) => events.push({ type, payload }),
    updateWorkspaceIfNeeded: async () => true,
    requestIndex: () => {},
  });
  service.agentOptions.autoBuild = false;
  service.proposals.set("manual-mkdir", {
    id: "manual-mkdir",
    type: "mkdir",
    path: "created",
    conversationId: "manual-status-chat",
    workspaceRootPath: rootPath,
  });

  try {
    assert.equal((await service.applyProposal("manual-mkdir")).ok, true);
    assert.equal(
      (await service.undoLastRunApply("manual-status-chat", { emitRenderer: false })).ok,
      true,
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "agent:status")
        .map((event) => event.payload.state),
      ["running", "idle", "running", "idle"],
    );
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test("workspace symbol rename holds one lease and CAS-checks its scan", async () => {
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-rename-root-a-"));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-rename-root-b-"));
  await fs.writeFile(path.join(rootA, "main.tex"), "\\label{old}\\ref{old}", "utf8");
  await fs.writeFile(path.join(rootB, "main.tex"), "\\label{old}\\ref{old}", "utf8");
  const workspace = new WorkspaceManager();
  workspace.setRootPath(rootA);
  const events = [];
  const service = new AgentService({
    workspace,
    sendToRenderer: (type, payload) => events.push({ type, payload }),
    updateWorkspaceIfNeeded: async () => true,
    requestIndex: () => {},
  });
  service.agentOptions.autoApply = false;
  service.agentOptions.autoBuild = false;
  const originalExecute = service.executeToolCall.bind(service);
  service.executeToolCall = async (...args) => {
    assert.equal(service.runningWorkspaceRoots.has(workspace.getRootPath()), true);
    return originalExecute(...args);
  };
  const handlers = createAgentHandlers({
    agentService: service,
    sendToRenderer: (type, payload) => events.push({ type, payload }),
  });

  try {
    await handlers.handleSearchRename({
      conversationId: "search-rename",
      from: "old",
      to: "new",
      kinds: ["label", "ref"],
      context: {},
    });
    const firstProposal = [...service.proposals.values()][0];
    assert.ok(firstProposal);
    assert.match(firstProposal.conversationId, /^search-rename:[a-f0-9]{20}$/);
    assert.equal(typeof firstProposal.baseContentHash, "string");
    const firstConversationId = firstProposal.conversationId;

    await fs.writeFile(path.join(rootA, "main.tex"), "user edit", "utf8");
    const staleApply = await service.applyProposal(firstProposal.id, {
      skipAutoBuild: true,
    });
    assert.equal(staleApply.ok, false);
    assert.equal(staleApply.conflict, true);
    assert.equal(await fs.readFile(path.join(rootA, "main.tex"), "utf8"), "user edit");

    workspace.setRootPath(rootB);
    await handlers.handleSearchRename({
      conversationId: "search-rename",
      from: "old",
      to: "new",
      kinds: ["label", "ref"],
      context: {},
    });
    const secondProposal = [...service.proposals.values()].find(
      (proposal) => proposal.conversationId !== firstConversationId,
    );
    assert.ok(secondProposal);
    assert.match(secondProposal.conversationId, /^search-rename:[a-f0-9]{20}$/);
    assert.notEqual(secondProposal.conversationId, firstConversationId);
  } finally {
    await fs.rm(rootA, { recursive: true, force: true });
    await fs.rm(rootB, { recursive: true, force: true });
  }
});

test("a running chat cannot be cleared until its workspace turn finishes", async () => {
  const service = new AgentService({
    workspace: { getRootPath: () => "/workspace" },
    sendToRenderer: () => {},
  });
  service.buildConversation("running-chat").push({ role: "user", content: "edit" });
  service.proposals.set("running-proposal", {
    id: "running-proposal",
    conversationId: "running-chat",
  });
  const owner = service.startConversationRun("running-chat");

  const blocked = service.clearConversation("running-chat");
  assert.equal(blocked.ok, false);
  assert.equal(service.buildConversation("running-chat").length, 1);
  assert.equal(service.proposals.has("running-proposal"), true);

  service.finishConversationRun("running-chat", owner.token);
  assert.deepEqual(service.clearConversation("running-chat"), { ok: true });
  assert.equal(service.conversations.has("running-chat"), false);
  assert.equal(
    (await service.getUiState()).sessions.some(
      (session) => session.conversationId === "running-chat",
    ),
    false,
  );
  assert.equal(service.proposals.has("running-proposal"), false);
});

test("clearing a chat tombstones late persistence and cannot resurrect it", async () => {
  let releaseRestore;
  const restoreGate = new Promise((resolve) => {
    releaseRestore = resolve;
  });
  const saved = [];
  const deleted = [];
  const service = new AgentService({
    workspace: { getRootPath: () => "/workspace" },
    sendToRenderer: () => {},
    sessionsService: {
      loadSessions: async () => {
        await restoreGate;
        return [];
      },
      saveSession: async (snapshot) => saved.push(snapshot),
      deleteSession: async (conversationId) => deleted.push(conversationId),
    },
  });
  service.buildConversation("delete-race").push({ role: "user", content: "edit" });
  const latePersist = service.persistSession("delete-race");

  assert.deepEqual(service.clearConversation("delete-race"), { ok: true });
  releaseRestore();
  await latePersist;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(saved, []);
  assert.deepEqual(deleted, ["delete-race"]);
  assert.equal(service.conversations.has("delete-race"), false);
  assert.equal(
    (await service.getUiState()).sessions.some(
      (session) => session.conversationId === "delete-race",
    ),
    false,
  );
});
