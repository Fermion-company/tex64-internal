"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  WorkspaceError,
  WorkspaceManager,
} = require("../electron/services/workspace.cjs");
const {
  undoLastApply,
} = require("../electron/services/agent-proposal-runtime.cjs");
const {
  createWorkspaceFileHandlers,
} = require("../electron/handlers/workspace/file-handlers.cjs");
const { buildAgentPolicy } = require("../electron/services/agent-policy.cjs");
const { executeToolCall } = require("../electron/services/agent-tool-executor.cjs");
const { buildTools } = require("../electron/services/openprism/tools.cjs");

const makeFixture = async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-symlink-"));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await Promise.all([
    fsp.mkdir(root, { recursive: true }),
    fsp.mkdir(outside, { recursive: true }),
  ]);
  const link = path.join(root, "escape");
  try {
    await fsp.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlinks are unavailable: ${error?.code ?? error}`);
    return null;
  }
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  return { root, outside, workspace };
};

test("WorkspaceManager rejects existing and new files through an external symlink", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const { outside, workspace } = fixture;
  const outsideFile = path.join(outside, "secret.tex");
  await fsp.writeFile(outsideFile, "outside\n", "utf8");

  assert.throws(() => workspace.resolvePath("escape/secret.tex"), /Invalid path/);
  await assert.rejects(workspace.readFile("escape/secret.tex"), /Invalid path/);
  await assert.rejects(
    workspace.writeFile("escape/secret.tex", "overwritten\n"),
    /Invalid path/,
  );
  await assert.rejects(
    workspace.writeBinaryFile("escape/new.bin", Buffer.from("created")),
    /Invalid path/,
  );

  assert.equal(await fsp.readFile(outsideFile, "utf8"), "outside\n");
  assert.equal(fs.existsSync(path.join(outside, "new.bin")), false);
});

test("workspace and agent undo cannot restore through an external symlink", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const { root, outside, workspace } = fixture;
  const trashDir = path.join(root, ".tex64", ".trash");
  await fsp.mkdir(trashDir, { recursive: true });
  const trashedPath = path.join(trashDir, "saved.tex");
  await fsp.writeFile(trashedPath, "saved\n", "utf8");
  workspace.undoStack.push({
    kind: "delete",
    fromPath: "escape/restored.tex",
    trashedPath,
    isDirectory: false,
    affectsIndex: false,
  });

  await assert.rejects(workspace.undoLastOperation(), /Invalid path/);
  assert.equal(fs.existsSync(path.join(outside, "restored.tex")), false);
  assert.equal(fs.existsSync(trashedPath), true);

  const conversationId = "tex64-ai-mode:workspace:main.tex";
  const service = {
    sessionsRestored: true,
    workspace,
    applyUndoStack: [
      {
        type: "write",
        path: "escape/secret.tex",
        existed: true,
        previousBuffer: Buffer.from("previous\n"),
        conversationId,
        workspaceRootPath: root,
      },
    ],
    emitAuditEvent() {},
    sendToRenderer() {},
    markSessionDirty() {},
    emitUndoAvailability() {},
    updateWorkspaceIfNeeded: async () => {},
    requestIndex() {},
  };
  const result = await undoLastApply(service, conversationId, {
    emitRenderer: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /Invalid path/);
  assert.equal(fs.existsSync(path.join(outside, "secret.tex")), false);
  assert.equal(service.applyUndoStack.length, 1, "failed undo remains available");
});

test("AI direct line replacement cannot follow an external symlink", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const { root, outside, workspace } = fixture;
  const outsideFile = path.join(outside, "secret.tex");
  await fsp.writeFile(outsideFile, "outside\n", "utf8");
  const replies = [];
  const state = { workspaceId: "workspace", workspaceGeneration: 3 };
  const handlers = createWorkspaceFileHandlers({
    fs,
    workspace,
    formatterService: {},
    sendToRenderer: (type, payload) => replies.push({ type, payload }),
    sendIssues() {},
    WorkspaceError,
    state,
    userSettings: {},
    IMAGE_MIME_TYPES: new Map(),
    getFileExtension: (value) => path.extname(value).slice(1),
    isTextFilePath: () => true,
    isExtendedTextFilePath: () => false,
    isImageFilePath: () => false,
    isPdfFilePath: () => false,
    sendWorkspace: async () => {},
    updateWorkspaceIfNeeded: async () => {},
    requestIndex() {},
    ensureWorkspace: () => root,
    resolveWorkspacePath: (value) => workspace.resolvePath(value),
    openInTerminal() {},
    revealInFinder() {},
  });

  const result = await handlers.handleReplaceLines("ai-direct-1", "escape/secret.tex", {
    startLine: 1,
    endLine: 1,
    expectedText: "outside",
    replacementText: "changed",
    workspaceId: state.workspaceId,
    workspaceGeneration: state.workspaceGeneration,
    documentMainFile: "main.tex",
    conversationId: "tex64-ai-mode:workspace:main.tex",
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid path/);
  assert.equal(await fsp.readFile(outsideFile, "utf8"), "outside\n");
  assert.equal(replies.at(-1)?.type, "file:replaceLinesResult");
  assert.equal(replies.at(-1)?.payload.ok, false);
});

test("OpenPrism apply_patch cannot preview an external file through a symlink", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const { root, outside, workspace } = fixture;
  const outsideFile = path.join(outside, "secret.tex");
  await fsp.writeFile(outsideFile, "outside\n", "utf8");
  const service = {
    workspace,
    sendToRenderer() {},
  };
  const tools = buildTools(service, "code-agent-test", buildAgentPolicy(), {
    rootPath: root,
  });
  const applyPatch = tools.find((entry) => entry.function.name === "apply_patch");
  assert.ok(applyPatch);

  const result = JSON.parse(
    await applyPatch.execute({
      path: "escape/secret.tex",
      patch:
        "--- a/escape/secret.tex\n+++ b/escape/secret.tex\n@@ -1 +1 @@\n-outside\n+changed\n",
    }),
  );

  assert.match(result.error, /Invalid path/);
  assert.equal(await fsp.readFile(outsideFile, "utf8"), "outside\n");
});

test("compile_document cannot build a TeX file reached through an external symlink", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const { root, outside, workspace } = fixture;
  await fsp.writeFile(path.join(outside, "secret.tex"), "\\documentclass{article}\n", "utf8");
  let buildCalls = 0;
  const conversationId = "tex64-ai-mode:workspace:main.tex";
  const service = {
    workspace,
    workspaceRootByConversation: new Map([[conversationId, root]]),
    contextByConversation: new Map(),
    agentPolicy: buildAgentPolicy(),
    agentOptions: {},
    ensureSessionsRestored: async () => {},
    buildService: {
      build: async () => {
        buildCalls += 1;
        return { kind: "success", summary: "unexpected", issues: [] };
      },
    },
    sendStatus() {},
    sendBuildState() {},
    sendIssues() {},
  };

  const result = await executeToolCall(
    service,
    { name: "run_build", args: { mainFile: "escape/secret.tex" } },
    conversationId,
  );

  assert.equal(buildCalls, 0);
  assert.match(result.error, /inside the current workspace/);
});
