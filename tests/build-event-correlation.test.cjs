const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createBuildCoreHandlers } = require("../electron/handlers/build/build-core.cjs");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const eventually = async (predicate, timeoutMs = 1000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const makeHarness = ({ magicRoot = null, runtimeGate = null } = {}) => {
  const states = [];
  const buildCalls = [];
  const firstGate = deferred();
  const session = {
    rootPath: "/ws",
    workspaceGeneration: 3,
    workspaceId: "workspace-a",
  };
  const buildService = {
    isBuilding: false,
    cancelCurrentRun: () => false,
    build: async (rootPath, targetFile) => {
      buildService.isBuilding = true;
      buildCalls.push({ rootPath, targetFile });
      if (buildCalls.length === 1) await firstGate.promise;
      buildService.isBuilding = false;
      return {
        kind: "success",
        summary: "ok",
        pdfPath: `/ws/output/${targetFile.replace(/\.tex$/, ".pdf")}`,
        issues: [],
        log: "",
      };
    },
  };
  const handlers = createBuildCoreHandlers(
    {
      fs: { existsSync: () => true },
      buildService,
      envService: {
        checkCommand: async () => {
          if (runtimeGate) await runtimeGate.promise;
          return true;
        },
      },
      formatterService: {},
      workspace: {
        rootInfo: async () => null,
        resolveTexRootFromMagic: async () => magicRoot,
        loadSettings: async () => null,
        resolvePath: (relativePath) => {
          const resolved = path.resolve(session.rootPath, relativePath);
          if (
            resolved !== session.rootPath &&
            !resolved.startsWith(session.rootPath + path.sep)
          ) {
            throw new Error("invalid path");
          }
          return resolved;
        },
      },
      pdfWindowManager: { show: () => {} },
      sendBuildState: (state, message, extra) => states.push({ state, message, ...extra }),
      sendIssues: () => {},
      sendBuildLog: () => {},
      ensureWorkspace: () => session.rootPath,
      updateWorkspaceIfNeeded: async () => true,
      handleOpenFile: async () => {},
      state: session,
    },
    {
      resolveWorkspaceRelativePath: (_root, absolute) =>
        absolute.startsWith("/ws/") ? absolute.slice(4) : null,
    },
  );
  return { handlers, states, buildCalls, firstGate, session };
};

const options = (requestId) => ({
  requestId,
  workspaceGeneration: 3,
  workspaceId: "workspace-a",
  exactTarget: true,
  queueIfBusy: true,
  pdfViewerMode: "none",
});

test("AI build queue is latest-wins and terminal events keep the exact target", async () => {
  const { handlers, states, buildCalls, firstGate } = makeHarness();
  const first = handlers.handleBuild("doc-a/main.tex", options("build-a"));
  await eventually(() => buildCalls.length === 1);

  await handlers.handleBuild("doc-b/main.tex", options("build-b"));
  await handlers.handleBuild("doc-c/main.tex", options("build-c"));
  firstGate.resolve();
  await first;
  await eventually(
    () => states.some((entry) => entry.state === "success" && entry.requestId === "build-c"),
  );

  assert.deepEqual(
    buildCalls.map((entry) => entry.targetFile),
    ["doc-a/main.tex", "doc-c/main.tex"],
  );
  const superseded = states.find(
    (entry) => entry.state === "idle" && entry.requestId === "build-b",
  );
  assert.equal(superseded.targetFile, "doc-b/main.tex");
  const success = states.find(
    (entry) => entry.state === "success" && entry.requestId === "build-c",
  );
  assert.equal(success.workspaceGeneration, 3);
  assert.equal(success.workspaceId, "workspace-a");
  assert.equal(success.targetFile, "doc-c/main.tex");
  assert.equal(success.pdfPath, "output/doc-c/main.pdf");
});

test("queued build is discarded after the workspace generation changes", async () => {
  const { handlers, states, buildCalls, firstGate, session } = makeHarness();
  const first = handlers.handleBuild("doc-a/main.tex", options("build-a"));
  await eventually(() => buildCalls.length === 1);
  await handlers.handleBuild("doc-b/main.tex", options("build-b"));
  session.rootPath = "/other";
  session.workspaceGeneration = 4;
  session.workspaceId = "workspace-b";
  firstGate.resolve();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(buildCalls.map((entry) => entry.targetFile), ["doc-a/main.tex"]);
  assert.equal(
    states.some((entry) => entry.state === "success" && entry.requestId === "build-b"),
    false,
  );
});

test("an exact AI document build does not drift to a magic root", async () => {
  const { handlers, states, buildCalls, firstGate } = makeHarness({
    magicRoot: "workspace-book.tex",
  });
  const run = handlers.handleBuild("doc/main.tex", {
    ...options("build-exact"),
    documentMainFile: "doc/main.tex",
  });
  await eventually(() => buildCalls.length === 1);
  firstGate.resolve();
  await run;

  assert.equal(buildCalls[0].targetFile, "doc/main.tex");
  const success = states.find(
    (entry) => entry.state === "success" && entry.requestId === "build-exact",
  );
  assert.equal(success.targetFile, "doc/main.tex");
  assert.equal(success.documentMainFile, "doc/main.tex");
});

test("an exact AI build rejects a target outside the workspace", async () => {
  const { handlers, states, buildCalls } = makeHarness();
  await handlers.handleBuild("../outside.tex", {
    ...options("build-outside"),
    documentMainFile: "doc/main.tex",
  });

  assert.deepEqual(buildCalls, []);
  assert.ok(
    states.some(
      (entry) =>
        entry.state === "failed" &&
        entry.requestId === "build-outside" &&
        /invalid path/i.test(entry.message),
    ),
  );
});

test("cancel-all discards the pending build and prevents an old handler from restarting", async () => {
  const { handlers, states, buildCalls, firstGate } = makeHarness();
  const first = handlers.handleBuild("doc-a/main.tex", options("build-a"));
  await eventually(() => buildCalls.length === 1);
  await handlers.handleBuild("doc-b/main.tex", options("build-b"));

  assert.equal(handlers.cancelAllBuilds(), true);
  firstGate.resolve();
  await first;
  assert.equal(await handlers.waitForBuildIdle(500), true);

  assert.deepEqual(buildCalls.map((entry) => entry.targetFile), ["doc-a/main.tex"]);
  assert.ok(
    states.some(
      (entry) =>
        entry.state === "idle" &&
        entry.requestId === "build-b" &&
        entry.message === "Build cancelled.",
    ),
  );
});

test("cancel-all waits for an active preflight handler that never reached BuildService", async () => {
  const runtimeGate = deferred();
  const { handlers, buildCalls } = makeHarness({ runtimeGate });
  const run = handlers.handleBuild("doc-a/main.tex", options("preflight"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(handlers.cancelAllBuilds(), true);
  const waiting = handlers.waitForBuildIdle(500);
  runtimeGate.resolve();
  await run;
  assert.equal(await waiting, true);
  assert.deepEqual(buildCalls, []);
});
