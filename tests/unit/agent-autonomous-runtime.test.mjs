import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { AgentService } = require("../../electron/services/agent.cjs");

const createWorkspace = (rootPath) => ({
  getRootPath: () => rootPath,
  resolvePath: (relativePath) => path.join(rootPath, relativePath),
  writeFile: async (relativePath, content) => {
    const absPath = path.join(rootPath, relativePath);
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, content, "utf8");
  },
  listFiles: async () => {
    const entries = await fsp.readdir(rootPath).catch(() => []);
    return entries;
  },
  rootInfo: async () => ({ path: "main.tex" }),
  resolveTexRootFromMagic: async (relativePath) => relativePath,
  loadSettings: async () => ({ buildProfileId: "", buildProfiles: [] }),
});

const createService = (rootPath) =>
  new AgentService({
    workspace: createWorkspace(rootPath),
    searchService: null,
    ensureUserSettings: () => ({
      getAgentSettings: async () => ({
        stream: false,
        autoApply: true,
        autoBuild: false,
        allowRunCommand: true,
        maxIterations: 12,
      }),
      updateAgentSettings: async () => ({}),
    }),
    sendToRenderer: () => {},
    updateWorkspaceIfNeeded: async () => {},
    requestIndex: () => {},
    buildService: null,
    sendBuildState: () => {},
    sendBuildLog: () => {},
    sendIssues: () => {},
    indexerService: null,
    apiUsageService: null,
    auditService: { append: async () => {} },
    sessionsService: null,
    requestAiChat: null,
  });

test("direct edit aliases apply immediately and can be undone", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-agent-direct-"));
  const mainFile = path.join(rootPath, "main.tex");
  await fsp.writeFile(mainFile, "before\n", "utf8");
  try {
    const service = createService(rootPath);
    const result = await service.executeToolCall(
      {
        name: "write_file",
        args: { path: "main.tex", content: "after\n", summary: "rewrite main" },
      },
      "direct-edit"
    );
    assert.equal(result.status, "applied");
    const current = await fsp.readFile(mainFile, "utf8");
    assert.equal(current, "after\n");

    const undo = await service.undoLastApply("direct-edit");
    assert.equal(undo.ok, true);
    const reverted = await fsp.readFile(mainFile, "utf8");
    assert.equal(reverted, "before\n");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("scratchpad read/write supports replace and append", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-agent-scratch-"));
  try {
    const service = createService(rootPath);
    const cid = "scratch";
    const writeA = await service.executeToolCall(
      { name: "write_scratchpad", args: { mode: "replace", content: "plan A" } },
      cid
    );
    assert.equal(writeA.status, "ok");
    const writeB = await service.executeToolCall(
      { name: "write_scratchpad", args: { mode: "append", content: "next step" } },
      cid
    );
    assert.equal(writeB.status, "ok");
    const read = await service.executeToolCall({ name: "read_scratchpad", args: {} }, cid);
    assert.match(read.content, /plan A/);
    assert.match(read.content, /next step/);
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("autonomous shell tools support unrestricted shell command execution", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-agent-shell-"));
  try {
    const service = createService(rootPath);
    const cid = "shell";

    const session = await service.executeToolCall(
      { name: "open_terminal_session", args: {} },
      cid
    );
    assert.equal(session.status, "ready");
    assert.ok(typeof session.sessionId === "string" && session.sessionId.length > 0);

    const terminalExec = await service.executeToolCall(
      {
        name: "execute_bash_command",
        args: {
          sessionId: session.sessionId,
          command: "printf 'a\\nb\\n' | wc -l",
        },
      },
      cid
    );
    assert.equal(terminalExec.status, "success");
    assert.match(terminalExec.stdout, /2/);

    const runCommandExec = await service.executeToolCall(
      {
        name: "run_command",
        args: { command: "printf 'x\\ny\\n' | wc -l" },
      },
      cid
    );
    assert.equal(runCommandExec.exitCode, 0);
    assert.match(runCommandExec.stdout, /2/);

    const killed = await service.executeToolCall(
      { name: "kill_terminal", args: { sessionId: session.sessionId } },
      cid
    );
    assert.equal(killed.status, "killed");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});
