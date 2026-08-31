const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AgentService } = require("../electron/services/agent.cjs");

const contentHash = (value) =>
  crypto.createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");

const createService = ({ rootPath, loadSessions, saveSession, events = [] }) =>
  new AgentService({
    workspace: {
      getRootPath: () => rootPath(),
      resolvePath: (relativePath) => path.join(rootPath(), relativePath),
    },
    sendToRenderer: (type, payload) => events.push({ type, payload }),
    updateWorkspaceIfNeeded: async () => {},
    requestIndex: () => {},
    sessionsService: {
      maxSessionBytes: 8 * 1024 * 1024,
      loadSessions,
      saveSession,
      deleteSession: async () => {},
    },
  });

test("AI undo snapshots survive restart and restore the previous file", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-undo-persist-"));
  const target = path.join(tempRoot, "main.tex");
  await fs.writeFile(target, "new", "utf8");
  let savedSnapshot = null;
  const first = createService({
    rootPath: () => tempRoot,
    loadSessions: async () => [],
    saveSession: async (snapshot) => {
      savedSnapshot = structuredClone(snapshot);
    },
  });

  try {
    first.pushUndoEntry({
      type: "write",
      conversationId: "tex64-ai-mode:workspace:main.tex",
      runId: "run-1",
      path: "main.tex",
      existed: true,
      previousBuffer: Buffer.from("old", "utf8"),
      wasBinary: false,
      appliedHash: contentHash("new"),
    });
    await first.flushPendingSessions();
    assert.ok(savedSnapshot);
    assert.equal(savedSnapshot.version, 4);
    assert.equal(savedSnapshot.undoGroups.length, 1);
    assert.equal(savedSnapshot.undoGroups[0].entryCount, 1);
    assert.equal(
      savedSnapshot.undoGroups[0].entries[0].previousBase64,
      Buffer.from("old").toString("base64"),
    );
    assert.equal("previousBuffer" in savedSnapshot.undoGroups[0].entries[0], false);

    const secondEvents = [];
    const second = createService({
      rootPath: () => tempRoot,
      loadSessions: async () => [savedSnapshot],
      saveSession: async () => {},
      events: secondEvents,
    });
    const state = await second.getUiState();
    const restored = state.sessions.find(
      (entry) => entry.conversationId === "tex64-ai-mode:workspace:main.tex",
    );
    assert.equal(restored.status.undoCount, 1);

    const result = await second.undoLastRunApply(
      "tex64-ai-mode:workspace:main.tex",
      { emitRenderer: false },
    );
    assert.equal(result.ok, true);
    assert.equal(await fs.readFile(target, "utf8"), "old");
    assert.equal(second.getUndoAvailability("tex64-ai-mode:workspace:main.tex").count, 0);
    assert.ok(
      secondEvents.some(
        (event) =>
          event.type === "agent:applyContent" &&
          event.payload.path === "main.tex" &&
          event.payload.content === "old",
      ),
    );
    await second.flushPendingSessions();
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("persisted AI undo refuses to touch a different workspace", async () => {
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-undo-root-a-"));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-undo-root-b-"));
  await fs.writeFile(path.join(secondRoot, "main.tex"), "workspace-b", "utf8");
  let activeRoot = firstRoot;
  let snapshot = null;
  const first = createService({
    rootPath: () => activeRoot,
    loadSessions: async () => [],
    saveSession: async (value) => {
      snapshot = structuredClone(value);
    },
  });

  try {
    first.pushUndoEntry({
      type: "write",
      conversationId: "scoped",
      runId: "run-1",
      path: "main.tex",
      existed: true,
      previousBuffer: Buffer.from("workspace-a", "utf8"),
      wasBinary: false,
      appliedHash: contentHash("workspace-b"),
    });
    await first.flushPendingSessions();
    activeRoot = secondRoot;
    const restored = createService({
      rootPath: () => activeRoot,
      loadSessions: async () => [snapshot],
      saveSession: async () => {},
    });
    await restored.ensureSessionsRestored();
    const result = await restored.undoLastRunApply("scoped", { emitRenderer: false });
    assert.equal(result.ok, false);
    assert.ok(["workspace_changed", "workspace_busy"].includes(result.reason));
    assert.equal(await fs.readFile(path.join(secondRoot, "main.tex"), "utf8"), "workspace-b");
  } finally {
    await fs.rm(firstRoot, { recursive: true, force: true });
    await fs.rm(secondRoot, { recursive: true, force: true });
  }
});

test("dirty AI session snapshots flush immediately without waiting for the debounce", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-session-flush-"));
  let savedSnapshot = null;
  const service = createService({
    rootPath: () => tempRoot,
    loadSessions: async () => [],
    saveSession: async (snapshot) => {
      savedSnapshot = structuredClone(snapshot);
    },
  });

  try {
    service.pushUndoEntry({
      type: "write",
      conversationId: "flush-now",
      runId: "run-flush",
      path: "main.tex",
      existed: true,
      previousBuffer: Buffer.from("before", "utf8"),
      wasBinary: false,
      appliedHash: contentHash("after"),
    });
    assert.equal(savedSnapshot, null);
    assert.equal(service.persistTimers.size, 1);

    await service.flushPendingSessions();

    assert.equal(service.persistTimers.size, 0);
    assert.ok(savedSnapshot);
    assert.equal(savedSnapshot.conversationId, "flush-now");
    assert.equal(savedSnapshot.undoGroups[0].entryCount, 1);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("a run that exceeds the persisted undo entry limit is unavailable, never partially restored", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-undo-atomic-limit-"));
  let savedSnapshot = null;
  const first = createService({
    rootPath: () => tempRoot,
    loadSessions: async () => [],
    saveSession: async (snapshot) => {
      savedSnapshot = structuredClone(snapshot);
    },
  });

  try {
    for (let index = 0; index < 21; index += 1) {
      first.pushUndoEntry({
        type: "write",
        conversationId: "atomic-limit",
        runId: "run-too-large",
        path: `file-${index}.tex`,
        existed: true,
        previousBuffer: Buffer.from(`old-${index}`, "utf8"),
        wasBinary: false,
        appliedHash: contentHash(`new-${index}`),
      });
    }
    await first.flushPendingSessions();
    assert.deepEqual(savedSnapshot.undoGroups, []);
    assert.equal(savedSnapshot.undoBarrier.runId, "run-too-large");
    assert.equal(savedSnapshot.undoBarrier.entryCount, 21);

    const restored = createService({
      rootPath: () => tempRoot,
      loadSessions: async () => [savedSnapshot],
      saveSession: async () => {},
    });
    const state = await restored.getUiState();
    const session = state.sessions.find((entry) => entry.conversationId === "atomic-limit");
    assert.equal(session.status.undoAvailable, false);
    assert.equal(session.status.undoCount, 0);
    assert.equal(session.status.undoUnavailableReason, "persistence_limit");

    const result = await restored.undoLastRunApply("atomic-limit", {
      emitRenderer: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "undo_persistence_limit");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("persisted undo keeps only complete newer runs before an atomic barrier", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-undo-atomic-tail-"));
  let savedSnapshot = null;
  const first = createService({
    rootPath: () => tempRoot,
    loadSessions: async () => [],
    saveSession: async (snapshot) => {
      savedSnapshot = structuredClone(snapshot);
    },
  });

  try {
    for (let index = 0; index < 21; index += 1) {
      await fs.writeFile(path.join(tempRoot, `file-${index}.tex`), `new-${index}`, "utf8");
      first.pushUndoEntry({
        type: "write",
        conversationId: "atomic-tail",
        runId: index < 19 ? "run-older" : "run-newer",
        path: `file-${index}.tex`,
        existed: true,
        previousBuffer: Buffer.from(`old-${index}`, "utf8"),
        wasBinary: false,
        appliedHash: contentHash(`new-${index}`),
      });
    }
    await first.flushPendingSessions();
    assert.equal(savedSnapshot.undoGroups.length, 1);
    assert.equal(savedSnapshot.undoGroups[0].runId, "run-newer");
    assert.equal(savedSnapshot.undoGroups[0].entryCount, 2);
    assert.equal(savedSnapshot.undoBarrier.runId, "run-older");
    assert.equal(savedSnapshot.undoBarrier.entryCount, 19);

    const restored = createService({
      rootPath: () => tempRoot,
      loadSessions: async () => [savedSnapshot],
      saveSession: async () => {},
    });
    const undone = await restored.undoLastRunApply("atomic-tail", {
      emitRenderer: false,
    });
    assert.equal(undone.ok, true);
    assert.equal(undone.runId, "run-newer");
    assert.equal(undone.count, 2);
    assert.equal(await fs.readFile(path.join(tempRoot, "file-19.tex"), "utf8"), "old-19");
    assert.equal(await fs.readFile(path.join(tempRoot, "file-20.tex"), "utf8"), "old-20");
    assert.equal(await fs.readFile(path.join(tempRoot, "file-0.tex"), "utf8"), "new-0");

    const availability = restored.getUndoAvailability("atomic-tail");
    assert.equal(availability.available, false);
    assert.equal(availability.unavailableReason, "persistence_limit");
    const blocked = await restored.undoLastRunApply("atomic-tail", {
      emitRenderer: false,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "undo_persistence_limit");
    await restored.flushPendingSessions();
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("the process-wide restore cap evicts a complete oldest run", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-undo-global-cap-"));
  const snapshots = [];
  for (let conversationIndex = 0; conversationIndex < 11; conversationIndex += 1) {
    const entryCount = conversationIndex === 10 ? 1 : 20;
    snapshots.push({
      version: 4,
      conversationId: `conversation-${conversationIndex}`,
      workspaceRootPath: tempRoot,
      conversation: [],
      proposals: [],
      undoGroups: [
        {
          runId: `run-${conversationIndex}`,
          entryCount,
          entries: Array.from({ length: entryCount }, (_, entryIndex) => ({
            type: "write",
            conversationId: `conversation-${conversationIndex}`,
            runId: `run-${conversationIndex}`,
            path: `file-${conversationIndex}-${entryIndex}.tex`,
            workspaceRootPath: tempRoot,
            existed: true,
            wasBinary: false,
            previousBase64: Buffer.from(
              `old-${conversationIndex}-${entryIndex}`,
              "utf8",
            ).toString("base64"),
            appliedHash: contentHash(`new-${conversationIndex}-${entryIndex}`),
          })),
        },
      ],
      undoBarrier: null,
    });
  }
  const restored = createService({
    rootPath: () => tempRoot,
    loadSessions: async () => snapshots,
    saveSession: async () => {},
  });

  try {
    await restored.ensureSessionsRestored();
    assert.equal(restored.applyUndoStack.length, 181);
    assert.equal(
      restored.applyUndoStack.some(
        (entry) => entry.conversationId === "conversation-0",
      ),
      false,
    );
    const availability = restored.getUndoAvailability("conversation-0");
    assert.equal(availability.available, false);
    assert.equal(availability.unavailableReason, "persistence_limit");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("a persisted resumable terminal state remains resumable after restart", async () => {
  const service = createService({
    rootPath: () => "/workspace",
    loadSessions: async () => [
      {
        version: 4,
        conversationId: "resumable-session",
        workspaceRootPath: "/workspace",
        conversation: [{ role: "user", content: "Fix the document" }],
        proposals: [],
        undoGroups: [],
        undoBarrier: null,
        lastStatus: {
          state: "resumable",
          message: "Compilation needs another turn.",
          ts: Date.now(),
        },
      },
    ],
    saveSession: async () => {},
  });

  const state = await service.getUiState();
  const session = state.sessions.find(
    (entry) => entry.conversationId === "resumable-session",
  );
  assert.ok(session);
  assert.equal(session.status.state, "resumable");
  assert.equal(session.status.message, "Compilation needs another turn.");
});

test("run Undo preflights every file before reverting any of them", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-undo-atomic-preflight-"));
  const aPath = path.join(tempRoot, "a.tex");
  const bPath = path.join(tempRoot, "b.tex");
  await fs.writeFile(aPath, "new-a", "utf8");
  await fs.writeFile(bPath, "new-b", "utf8");
  const service = createService({
    rootPath: () => tempRoot,
    loadSessions: async () => [],
    saveSession: async () => {},
  });

  try {
    service.pushUndoEntry({
      type: "write",
      conversationId: "atomic-preflight",
      runId: "run-atomic",
      path: "a.tex",
      existed: true,
      previousBuffer: Buffer.from("old-a"),
      wasBinary: false,
      appliedHash: contentHash("new-a"),
    });
    service.pushUndoEntry({
      type: "write",
      conversationId: "atomic-preflight",
      runId: "run-atomic",
      path: "b.tex",
      existed: true,
      previousBuffer: Buffer.from("old-b"),
      wasBinary: false,
      appliedHash: contentHash("new-b"),
    });
    await fs.writeFile(aPath, "user-a", "utf8");

    const result = await service.undoLastRunApply("atomic-preflight", {
      emitRenderer: false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "preflight_failed");
    assert.match(result.message, /changed after Axiom edited/);
    assert.equal(await fs.readFile(aPath, "utf8"), "user-a");
    assert.equal(await fs.readFile(bPath, "utf8"), "new-b");
    assert.equal(service.applyUndoStack.length, 2);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("run Undo compensates repeated writes and emits no partial renderer update", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-undo-repeat-"));
  await fs.writeFile(path.join(tempRoot, "shared.tex"), "new", "utf8");
  await fs.writeFile(path.join(tempRoot, "late.tex"), "late-new", "utf8");
  const events = [];
  const service = createService({
    rootPath: () => tempRoot,
    loadSessions: async () => [],
    saveSession: async () => {},
    events,
  });
  service.pushUndoEntry({
    type: "write",
    conversationId: "repeat-run",
    runId: "repeat-run-id",
    path: "late.tex",
    existed: true,
    previousBuffer: Buffer.from("late-old"),
    appliedHash: contentHash("late-new"),
  });
  service.pushUndoEntry({
    type: "write",
    conversationId: "repeat-run",
    runId: "repeat-run-id",
    path: "shared.tex",
    existed: true,
    previousBuffer: Buffer.from("old"),
    appliedHash: contentHash("mid"),
  });
  service.pushUndoEntry({
    type: "write",
    conversationId: "repeat-run",
    runId: "repeat-run-id",
    path: "shared.tex",
    existed: true,
    previousBuffer: Buffer.from("mid"),
    appliedHash: contentHash("new"),
  });
  const originalResolve = service.workspace.resolvePath.bind(service.workspace);
  let lateResolveCount = 0;
  service.workspace.resolvePath = (relativePath) => {
    const resolved = originalResolve(relativePath);
    if (relativePath === "late.tex") {
      lateResolveCount += 1;
      // preflight, then undo's destination resolve, then its verification read
      if (lateResolveCount === 3) fsSync.writeFileSync(resolved, "user-late");
    }
    return resolved;
  };

  try {
    const result = await service.undoLastRunApply("repeat-run", {
      emitRenderer: false,
    });
    assert.equal(result.ok, false);
    assert.equal(await fs.readFile(path.join(tempRoot, "shared.tex"), "utf8"), "new");
    assert.equal(await fs.readFile(path.join(tempRoot, "late.tex"), "utf8"), "user-late");
    assert.equal(service.applyUndoStack.length, 3);
    assert.equal(
      events.some((event) =>
        event.type === "agent:applyContent" || event.type === "renameResult"
      ),
      false,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("a compensated rename restores its conversation routing after a later Undo fails", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-undo-rename-context-"));
  await fs.writeFile(path.join(tempRoot, "new.tex"), "renamed", "utf8");
  await fs.writeFile(path.join(tempRoot, "late.tex"), "late-new", "utf8");
  const service = createService({
    rootPath: () => tempRoot,
    loadSessions: async () => [],
    saveSession: async () => {},
  });
  service.setContext("rename-context", {
    documentMainFile: "new.tex",
    activeFilePath: "new.tex",
  });
  service.pushUndoEntry({
    type: "write",
    conversationId: "rename-context",
    runId: "rename-context-run",
    path: "late.tex",
    existed: true,
    previousBuffer: Buffer.from("late-old"),
    appliedHash: contentHash("late-new"),
  });
  service.pushUndoEntry({
    type: "rename",
    conversationId: "rename-context",
    runId: "rename-context-run",
    path: "new.tex",
    oldPath: "old.tex",
    newPath: "new.tex",
    appliedHash: contentHash("renamed"),
  });
  const originalResolve = service.workspace.resolvePath.bind(service.workspace);
  let lateResolveCount = 0;
  service.workspace.resolvePath = (relativePath) => {
    const resolved = originalResolve(relativePath);
    if (relativePath === "late.tex") {
      lateResolveCount += 1;
      if (lateResolveCount === 3) fsSync.writeFileSync(resolved, "user-late");
    }
    return resolved;
  };

  try {
    const result = await service.undoLastRunApply("rename-context", {
      emitRenderer: false,
    });
    assert.equal(result.ok, false);
    assert.equal((await fs.stat(path.join(tempRoot, "new.tex"))).isFile(), true);
    await assert.rejects(fs.stat(path.join(tempRoot, "old.tex")), { code: "ENOENT" });
    const context = service.contextByConversation.get("rename-context");
    assert.equal(context.documentMainFile, "new.tex");
    assert.equal(context.activeFilePath, "new.tex");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("a failed Undo compensation rebuilds the actual partial disk state", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-undo-rollback-build-"));
  await fs.writeFile(path.join(tempRoot, "new.tex"), "renamed", "utf8");
  await fs.writeFile(path.join(tempRoot, "late.tex"), "late-new", "utf8");
  const service = createService({
    rootPath: () => tempRoot,
    loadSessions: async () => [],
    saveSession: async () => {},
  });
  service.buildService = {};
  service.setContext("rollback-build", { documentMainFile: "new.tex" });
  const buildCalls = [];
  service.executeToolCall = async (call) => {
    buildCalls.push(call);
    return { status: "success" };
  };
  service.pushUndoEntry({
    type: "write",
    conversationId: "rollback-build",
    runId: "rollback-build-run",
    path: "late.tex",
    existed: true,
    previousBuffer: Buffer.from("late-old"),
    appliedHash: contentHash("late-new"),
  });
  service.pushUndoEntry({
    type: "rename",
    conversationId: "rollback-build",
    runId: "rollback-build-run",
    path: "new.tex",
    oldPath: "old.tex",
    newPath: "new.tex",
    appliedHash: contentHash("renamed"),
  });
  const originalResolve = service.workspace.resolvePath.bind(service.workspace);
  let lateResolveCount = 0;
  let newResolveCount = 0;
  service.workspace.resolvePath = (relativePath) => {
    const resolved = originalResolve(relativePath);
    if (relativePath === "late.tex") {
      lateResolveCount += 1;
      if (lateResolveCount === 3) fsSync.writeFileSync(resolved, "user-late");
    }
    if (relativePath === "new.tex") {
      newResolveCount += 1;
      // preflight, Undo source, rollback missing check, rollback mkdir parent
      if (newResolveCount === 4) fsSync.mkdirSync(resolved);
    }
    return resolved;
  };

  try {
    const result = await service.undoLastRunApply("rollback-build", {
      emitRenderer: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "rollback_failed");
    assert.equal(result.workspaceMayHaveChanged, true);
    assert.deepEqual(buildCalls, [
      { name: "run_build", args: { mainFile: "new.tex" } },
    ]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("Undo builds every file change once, skips mkdir, and never builds a rejected Undo", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-undo-build-owner-"));
  const service = createService({
    rootPath: () => tempRoot,
    loadSessions: async () => [],
    saveSession: async () => {},
  });
  service.buildService = {};
  service.setContext("undo-build-owner", { documentMainFile: "main.tex" });
  const buildCalls = [];
  service.executeToolCall = async (call, conversationId) => {
    assert.equal(service.runningWorkspaceRoots.has(tempRoot), true);
    buildCalls.push({ call, conversationId });
    return { status: "success" };
  };

  try {
    await fs.writeFile(path.join(tempRoot, "main.tex"), "new-tex", "utf8");
    service.pushUndoEntry({
      type: "write",
      conversationId: "undo-build-owner",
      runId: "run-tex",
      path: "main.tex",
      existed: true,
      previousBuffer: Buffer.from("old-tex"),
      wasBinary: false,
      appliedHash: contentHash("new-tex"),
    });
    const texResult = await service.undoLastRunApply("undo-build-owner", {
      emitRenderer: false,
    });
    assert.equal(texResult.ok, true);
    assert.equal(await fs.readFile(path.join(tempRoot, "main.tex"), "utf8"), "old-tex");
    assert.equal(buildCalls.length, 1);
    assert.deepEqual(buildCalls[0], {
      call: { name: "run_build", args: { mainFile: "main.tex" } },
      conversationId: "undo-build-owner",
    });
    assert.equal(service.runningWorkspaceRoots.has(tempRoot), false);

    await fs.writeFile(path.join(tempRoot, "notes.txt"), "new-text", "utf8");
    service.pushUndoEntry({
      type: "write",
      conversationId: "undo-build-owner",
      runId: "run-text",
      path: "notes.txt",
      existed: true,
      previousBuffer: Buffer.from("old-text"),
      wasBinary: false,
      appliedHash: contentHash("new-text"),
    });
    const textResult = await service.undoLastRunApply("undo-build-owner", {
      emitRenderer: false,
    });
    assert.equal(textResult.ok, true);
    assert.equal(buildCalls.length, 2);

    await fs.mkdir(path.join(tempRoot, "empty-dir"));
    service.pushUndoEntry({
      type: "mkdir",
      conversationId: "undo-build-owner",
      runId: "run-mkdir",
      path: "empty-dir",
    });
    const mkdirResult = await service.undoLastRunApply("undo-build-owner", {
      emitRenderer: false,
    });
    assert.equal(mkdirResult.ok, true);
    assert.equal(buildCalls.length, 2);

    await fs.writeFile(path.join(tempRoot, "broken.tex"), "user-change", "utf8");
    service.pushUndoEntry({
      type: "write",
      conversationId: "undo-build-owner",
      runId: "run-rejected",
      path: "broken.tex",
      existed: true,
      previousBuffer: Buffer.from("old-broken"),
      wasBinary: false,
      appliedHash: contentHash("axiom-change"),
    });
    const rejected = await service.undoLastRunApply("undo-build-owner", {
      emitRenderer: false,
    });
    assert.equal(rejected.ok, false);
    assert.equal(buildCalls.length, 2);
    assert.equal(await fs.readFile(path.join(tempRoot, "broken.tex"), "utf8"), "user-change");
    await service.flushPendingSessions();
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("a restarted Code chat rebuilds the exact persisted nested main file after Undo", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-undo-main-target-"));
  await fs.mkdir(path.join(tempRoot, "papers"));
  await fs.writeFile(path.join(tempRoot, "papers", "main.tex"), "new", "utf8");
  let snapshot = null;
  const first = createService({
    rootPath: () => tempRoot,
    loadSessions: async () => [],
    saveSession: async (value) => {
      snapshot = structuredClone(value);
    },
  });

  try {
    first.setContext("code-nested-chat", { documentMainFile: "papers/main.tex" });
    first.pushUndoEntry({
      type: "write",
      conversationId: "code-nested-chat",
      runId: "nested-run",
      path: "papers/main.tex",
      existed: true,
      previousBuffer: Buffer.from("old"),
      wasBinary: false,
      appliedHash: contentHash("new"),
    });
    await first.flushPendingSessions();
    assert.equal(snapshot.context.documentMainFile, "papers/main.tex");

    const restored = createService({
      rootPath: () => tempRoot,
      loadSessions: async () => [snapshot],
      saveSession: async () => {},
    });
    restored.buildService = {};
    const calls = [];
    restored.executeToolCall = async (call) => {
      calls.push(call);
      return { status: "success" };
    };
    const result = await restored.undoLastRunApply("code-nested-chat", {
      emitRenderer: false,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      { name: "run_build", args: { mainFile: "papers/main.tex" } },
    ]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
