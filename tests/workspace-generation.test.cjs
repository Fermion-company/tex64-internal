const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createWorkspaceContext } = require("../electron/handlers/workspace/context.cjs");
const {
  createWorkspaceProjectHandlers,
} = require("../electron/handlers/workspace/project-handlers.cjs");
const {
  createWorkspaceFileHandlers,
} = require("../electron/handlers/workspace/file-handlers.cjs");
const { AgentService } = require("../electron/services/agent.cjs");
const {
  WorkspaceWriterCoordinator,
} = require("../electron/services/workspace-writer-coordinator.cjs");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const makeContext = ({ listFiles } = {}) => {
  const sent = [];
  const state = { currentWorkspacePath: null };
  let rootPath = "/workspace-a";
  const workspace = {
    getRootPath: () => rootPath,
    setRootPath: (next) => {
      rootPath = next;
    },
    listFiles: listFiles ?? (async () => [`${rootPath}:file`]),
    listFolders: async () => [],
    rootInfo: async () => ({ path: "main.tex", source: "auto" }),
    loadSettings: async () => null,
  };
  const ctx = createWorkspaceContext({
    dialog: {},
    shell: {},
    spawn: () => {},
    fs: { realpathSync: Object.assign((value) => value, { native: (value) => value }) },
    fsp: {},
    path,
    workspace,
    indexerService: { requestIndex: () => {} },
    formatterService: {},
    searchService: {},
    sendToRenderer: (type, payload) => sent.push({ type, payload }),
    sendIssues: () => {},
    WorkspaceError: { invalidPath: "invalid" },
    state,
    userSettings: null,
  });
  return { ctx, workspace, state, sent, getRoot: () => rootPath };
};

test("late workspace snapshot cannot mix an old root with new-root files", async () => {
  const gate = deferred();
  let first = true;
  const harness = makeContext({
    listFiles: async () => {
      if (first) {
        first = false;
        await gate.promise;
      }
      return [`${harness.getRoot()}:file`];
    },
  });
  harness.ctx.beginWorkspaceSession("/workspace-a");
  const staleSend = harness.ctx.sendWorkspace("/workspace-a");

  harness.workspace.setRootPath("/workspace-b");
  harness.ctx.beginWorkspaceSession("/workspace-b");
  gate.resolve();
  assert.equal(await staleSend, false);
  assert.equal(harness.sent.some((entry) => entry.type === "updateWorkspace"), false);

  assert.equal(await harness.ctx.updateWorkspaceIfNeeded("/workspace-b", true), true);
  const update = harness.sent.find((entry) => entry.type === "updateWorkspace")?.payload;
  assert.equal(update.rootPath, "/workspace-b");
  assert.equal(update.files[0], "/workspace-b:file");
  assert.equal(update.workspaceGeneration, 2);
  assert.equal(typeof update.workspaceId, "string");
  assert.equal(update.workspaceId.length, 24);
});

test("a failed first listing still publishes the new workspace identity with empty files", async () => {
  const harness = makeContext({
    listFiles: async () => {
      throw new Error("listing failed");
    },
  });
  harness.workspace.setRootPath("/workspace-b");
  const session = harness.ctx.beginWorkspaceSession("/workspace-b");

  assert.equal(await harness.ctx.updateWorkspaceIfNeeded("/workspace-b", true), true);
  const update = harness.sent.find((entry) => entry.type === "updateWorkspace")?.payload;
  assert.ok(update);
  assert.equal(update.rootPath, "/workspace-b");
  assert.equal(update.workspaceGeneration, session.workspaceGeneration);
  assert.equal(update.workspaceId, session.workspaceId);
  assert.deepEqual(update.files, []);
  assert.deepEqual(update.folders, []);
});

test("project root is not changed until the injected transition barrier resolves", async () => {
  const barrier = deferred();
  const calls = [];
  let rootPath = "/old";
  const state = { mainWindow: {}, currentWorkspacePath: "/old" };
  const handlers = createWorkspaceProjectHandlers({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ["/new"] }),
    },
    fsp: {},
    workspace: {
      getRootPath: () => rootPath,
      setRootPath: (next) => {
        calls.push(`set:${next}`);
        rootPath = next;
      },
    },
    sendToRenderer: () => {},
    sendIssues: () => {},
    state,
    userSettings: null,
    sendLauncherStatus: () => {},
    updateWorkspaceIfNeeded: async () => calls.push("update"),
    requestIndex: () => calls.push("index"),
    ensureWorkspace: () => rootPath,
    sendWorkspace: async () => {},
    searchService: {},
    fileAccess: { ensureAccess: async () => true },
    beforeWorkspaceChange: async ({ fromRootPath, toRootPath }) => {
      calls.push(`barrier:${fromRootPath}->${toRootPath}`);
      await barrier.promise;
    },
    beginWorkspaceSession: (next) => calls.push(`begin:${next}`),
  });

  const opening = handlers.handleOpenWorkspace({ locale: "ja" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["barrier:/old->/new"]);
  assert.equal(rootPath, "/old");
  barrier.resolve();
  await opening;
  assert.deepEqual(calls, [
    "barrier:/old->/new",
    "set:/new",
    "begin:/new",
    "update",
    "index",
  ]);
});

test("new-project initialization also waits behind the old-workspace barrier", async () => {
  const barrier = deferred();
  const calls = [];
  let rootPath = "/old";
  const handlers = createWorkspaceProjectHandlers({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ["/new"] }),
    },
    fsp: {},
    workspace: {
      getRootPath: () => rootPath,
      initializeProject: async (next) => calls.push(`initialize:${next}`),
      setRootPath: (next) => {
        calls.push(`set:${next}`);
        rootPath = next;
      },
    },
    sendToRenderer: () => {},
    sendIssues: () => {},
    state: { mainWindow: {}, currentWorkspacePath: "/old" },
    userSettings: null,
    sendLauncherStatus: () => {},
    updateWorkspaceIfNeeded: async () => calls.push("update"),
    requestIndex: () => calls.push("index"),
    ensureWorkspace: () => rootPath,
    sendWorkspace: async () => {},
    searchService: {},
    fileAccess: { ensureAccess: async () => true },
    beforeWorkspaceChange: async () => {
      calls.push("barrier");
      await barrier.promise;
    },
    beginWorkspaceSession: (next) => calls.push(`begin:${next}`),
  });

  const creating = handlers.handleCreateProject({ locale: "ja" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["barrier"]);
  barrier.resolve();
  await creating;
  assert.deepEqual(calls, [
    "barrier",
    "initialize:/new",
    "set:/new",
    "begin:/new",
    "update",
    "index",
  ]);
});

test("a project switch waits until an in-flight direct edit has written to its captured root", async () => {
  const readStarted = deferred();
  const readGate = deferred();
  const calls = [];
  const writes = [];
  let rootPath = "/old";
  const state = { mainWindow: {}, currentWorkspacePath: null };
  const realpathSync = Object.assign((value) => value, { native: (value) => value });
  const workspace = {
    getRootPath: () => rootPath,
    setRootPath: (next) => {
      calls.push(`set:${next}`);
      rootPath = next;
    },
    listFiles: async () => ["main.tex"],
    listFolders: async () => [],
    rootInfo: async () => ({ path: "main.tex", source: "auto" }),
    loadSettings: async () => null,
    readFile: async () => {
      readStarted.resolve();
      await readGate.promise;
      return "old text";
    },
    writeFile: async (relativePath, content) => {
      writes.push([rootPath, relativePath, content]);
    },
    isIndexTarget: () => false,
  };
  const ctx = createWorkspaceContext({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ["/new"] }),
    },
    shell: {},
    spawn: () => {},
    fs: { realpathSync },
    fsp: {},
    path,
    workspace,
    indexerService: { requestIndex: () => {} },
    formatterService: {},
    searchService: {},
    sendToRenderer: () => {},
    sendIssues: () => {},
    WorkspaceError: { invalidPath: "invalid" },
    state,
    userSettings: null,
    beforeWorkspaceChange: async () => calls.push("barrier"),
  });
  ctx.beginWorkspaceSession("/old");
  const files = createWorkspaceFileHandlers(ctx);
  const projects = createWorkspaceProjectHandlers(ctx);
  const editing = files.handleReplaceLines("edit-before-switch", "main.tex", {
    startLine: 1,
    endLine: 1,
    expectedText: "old text",
    replacementText: "new text",
    workspaceGeneration: state.workspaceGeneration,
    workspaceId: state.workspaceId,
  });
  await readStarted.promise;
  const opening = projects.handleOpenWorkspace({ locale: "ja" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rootPath, "/old");
  assert.deepEqual(calls, []);
  readGate.resolve();
  assert.equal((await editing).ok, true);
  await opening;

  assert.deepEqual(writes, [["/old", "main.tex", "new text"]]);
  assert.deepEqual(calls, ["barrier", "set:/new"]);
  assert.equal(rootPath, "/new");
});

test("a turn starting after the idle check prevents the project root switch", async () => {
  let rootPath = "/old";
  const statuses = [];
  const coordinator = new WorkspaceWriterCoordinator();
  const agent = new AgentService({
    workspace: { getRootPath: () => rootPath },
    sendToRenderer: () => {},
  });
  coordinator.setAgentActiveCheck((root) => agent.runningWorkspaceRoots.has(root));
  let racingRun = null;
  const handlers = createWorkspaceProjectHandlers({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ["/new"] }),
    },
    fsp: {},
    workspace: {
      getRootPath: () => rootPath,
      setRootPath: (next) => {
        rootPath = next;
      },
    },
    sendToRenderer: () => {},
    sendIssues: () => {},
    state: { mainWindow: {}, currentWorkspacePath: "/old" },
    userSettings: null,
    sendLauncherStatus: (value) => statuses.push(value),
    updateWorkspaceIfNeeded: async () => true,
    requestIndex: () => {},
    ensureWorkspace: () => rootPath,
    sendWorkspace: async () => {},
    searchService: {},
    fileAccess: { ensureAccess: async () => true },
    beforeWorkspaceChange: async () => {
      racingRun = agent.startConversationRun("racing-turn");
    },
    beginRendererWorkspaceMutation: (root) => coordinator.beginRendererMutation(root),
    beginWorkspaceSession: () => {},
  });

  await handlers.handleOpenWorkspace({ locale: "en" });

  assert.equal(rootPath, "/old");
  assert.match(statuses.at(-1)?.message ?? "", /Axiom is updating/);
  agent.finishConversationRun("racing-turn", racingRun.token);
});

test("a project transition leases both roots through the first new-root snapshot", async () => {
  const updateGate = deferred();
  const calls = [];
  let rootPath = "/old";
  const handlers = createWorkspaceProjectHandlers({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ["/new"] }),
    },
    fsp: {},
    workspace: {
      getRootPath: () => rootPath,
      setRootPath: (next) => {
        calls.push(`set:${next}`);
        rootPath = next;
      },
    },
    sendToRenderer: () => {},
    sendIssues: () => {},
    state: { mainWindow: {}, currentWorkspacePath: "/old" },
    userSettings: null,
    sendLauncherStatus: () => {},
    updateWorkspaceIfNeeded: async () => {
      calls.push("update:start");
      await updateGate.promise;
      calls.push("update:end");
    },
    requestIndex: () => calls.push("index"),
    ensureWorkspace: () => rootPath,
    sendWorkspace: async () => {},
    searchService: {},
    fileAccess: { ensureAccess: async () => true },
    beforeWorkspaceChange: async () => calls.push("idle"),
    beginRendererWorkspaceMutation: (root) => {
      calls.push(`lease:${root}`);
      return () => calls.push(`release:${root}`);
    },
    beginWorkspaceSession: () => calls.push("session"),
  });

  const opening = handlers.handleOpenWorkspace({ locale: "en" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    "idle",
    "lease:/old",
    "lease:/new",
    "set:/new",
    "session",
    "update:start",
  ]);
  updateGate.resolve();
  await opening;
  assert.deepEqual(calls, [
    "idle",
    "lease:/old",
    "lease:/new",
    "set:/new",
    "session",
    "update:start",
    "update:end",
    "index",
    "release:/new",
    "release:/old",
  ]);
});
