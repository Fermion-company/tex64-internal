"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync, execFileSync } = require("node:child_process");
const { HistoryStore } = require("../electron/services/history-store.cjs");
const { HistoryTransaction } = require("../electron/services/history-transaction.cjs");
const { HistoryController } = require("../electron/services/history-controller.cjs");
const { AgentService } = require("../electron/services/agent.cjs");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-history-integration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "project"); await fs.mkdir(root);
  const history = path.join(directory, "history");
  const store = new HistoryStore({ root, directory: history });
  const tx = new HistoryTransaction(store);
  const write = (name, text) => fs.writeFile(path.join(root, name), text);
  const record = () => store.exclusive(async () => store.publish(await store.capture({ rootFile: "main.tex" })));
  const restore = id => store.exclusive(async () => tx.restore(await tx.plan(id, "main.tex")));
  const state = { workspaceId: "project", workspaceGeneration: 1 };
  let rootFile = "main.tex";
  const workspace = { getRootPath: () => root, rootInfo: async () => ({ path: rootFile }), setRootFile: async value => { rootFile = value; } };
  const deps = { workspace, state, directory: () => history, notify: () => {}, withMutation: async operation => operation(), isAgentBusy: () => false, hasTerminals: () => false, quiesce: async () => {}, afterRestore: async () => {}, advanceGeneration: () => { state.workspaceGeneration++; } };
  return { root, history, store, tx, write, record, restore, state, workspace, deps };
}

async function hashes(directory, relative = "") {
  const result = {};
  for (const item of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, item.name);
    if (item.isDirectory()) Object.assign(result, await hashes(directory, name));
    else result[name] = crypto.createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

test("local history restore and undo leave a real repository's refs, branch, tags, config and staged index untouched", async t => {
  const f = await fixture(t);
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd: f.root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_NAME: "History Test", GIT_AUTHOR_EMAIL: "history@example.invalid", GIT_COMMITTER_NAME: "History Test", GIT_COMMITTER_EMAIL: "history@example.invalid" },
  });
  git("init", "--quiet");
  await f.write("main.tex", "version A"); await f.write("staged.tex", "committed");
  git("add", "main.tex", "staged.tex"); git("commit", "--quiet", "-m", "initial document");
  git("checkout", "--quiet", "-b", "author-work"); git("tag", "submission");
  git("config", "tex64.fixture", "keep this setting");
  await f.write("staged.tex", "staged change"); git("add", "staged.tex");
  await f.write("staged.tex", "unstaged change after staging");
  const beforeRecording = await hashes(path.join(f.root, ".git"));
  const first = await f.record();
  assert.deepEqual(await hashes(path.join(f.root, ".git")), beforeRecording);
  await f.write("main.tex", "version B");
  const before = { metadata: await hashes(path.join(f.root, ".git")), refs: git("show-ref"), branch: git("symbolic-ref", "HEAD"), tags: git("tag", "--list"), config: git("config", "--local", "--list"), staged: git("diff", "--cached", "--binary"), status: git("status", "--porcelain=v1", "--untracked-files=all") };
  const restored = await f.restore(first.id);
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "version A");
  assert.deepEqual(await hashes(path.join(f.root, ".git")), before.metadata);
  assert.equal(git("diff", "--cached", "--binary"), before.staged);
  await f.restore(restored.record.preRestore);
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "version B");
  assert.deepEqual(await hashes(path.join(f.root, ".git")), before.metadata);
  assert.equal(git("show-ref"), before.refs);
  assert.equal(git("symbolic-ref", "HEAD"), before.branch);
  assert.equal(git("tag", "--list"), before.tags);
  assert.equal(git("config", "--local", "--list"), before.config);
  assert.equal(git("diff", "--cached", "--binary"), before.staged);
  assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), before.status);
});

test("controller startup keeps editing blocked while recovering an actual process-interrupted mixed project", async t => {
  const f = await fixture(t);
  await f.write("a.tex", "A auxiliary"); await f.write("main.tex", "A main");
  const first = await f.record();
  await f.write("a.tex", "B auxiliary"); await f.write("main.tex", "B main");
  const code = `
    const {HistoryStore}=require(${JSON.stringify(require.resolve("../electron/services/history-store.cjs"))});
    const {HistoryTransaction}=require(${JSON.stringify(require.resolve("../electron/services/history-transaction.cjs"))});
    const store=new HistoryStore({root:${JSON.stringify(f.root)},directory:${JSON.stringify(f.history)},fault:async point=>{if(point==="after-install-0")process.exit(71)}});
    store.exclusive(async()=>{const tx=new HistoryTransaction(store);await tx.restore(await tx.plan(${JSON.stringify(first.id)},"main.tex"));}).catch(error=>{console.error(error);process.exit(2)});
  `;
  const child = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  assert.equal(child.status, 71, child.stderr);
  assert.equal(await fs.readFile(path.join(f.root, "a.tex"), "utf8"), "A auxiliary");
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "B main");
  const controller = new HistoryController(f.deps);
  const recovering = controller.prepareWorkspace(f.root);
  assert.equal(controller.status().phase, "recovery");
  assert.throws(() => controller.assertWriterAllowed(), { code: "HISTORY_BUSY" });
  await recovering;
  assert.equal(await fs.readFile(path.join(f.root, "a.tex"), "utf8"), "B auxiliary");
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "B main");
  assert.equal(controller.status().phase, "idle");
  controller.assertWriterAllowed();
  assert.equal(controller.preparedRoot, f.root);
  assert.equal((await (await controller.store()).list()).filter(version => version.kind === "restore").length, 0);
  await assert.rejects(fs.access(f.tx.journalFile));
});

test("actual AgentService admission and history admission exclude each other and reopen after acknowledgement", async t => {
  const f = await fixture(t); await f.write("main.tex", "A");
  let controller;
  const agent = new AgentService({ workspace: f.workspace, sendToRenderer: () => {}, isRendererWorkspaceMutationActive: () => controller.blocked() });
  controller = new HistoryController({ ...f.deps, isAgentBusy: () => agent.runningControllers.size > 0 || agent.hasContentConflictInWorkspace(f.root) });
  const request = (action, args = {}) => controller.request(action, { ...f.state, ...args });
  const run = agent.startConversationRun("chat");
  await assert.rejects(request("begin", { purpose: "record" }), { code: "WORKSPACE_BUSY" });
  await assert.rejects(request("begin", { purpose: "restore" }), { code: "WORKSPACE_BUSY" });
  agent.finishConversationRun(run.conversationId, run.token);
  let token = (await request("begin", { purpose: "record" })).token;
  assert.throws(() => agent.startConversationRun("chat"), { code: "RENDERER_WORKSPACE_MUTATION_IN_PROGRESS" });
  const first = await request("record", { token }); await request("release", { token });
  const next = agent.startConversationRun("chat"); agent.finishConversationRun(next.conversationId, next.token);
  await f.write("main.tex", "B");
  token = (await request("begin", { purpose: "restore" })).token;
  const { plan } = await request("plan", { token, id: first.record.id });
  await request("restore", { token, planId: plan.id });
  assert.equal(controller.status().phase, "syncing");
  assert.throws(() => agent.startConversationRun("chat"), { code: "RENDERER_WORKSPACE_MUTATION_IN_PROGRESS" });
  await assert.rejects(request("ack", { token, buffers: [{ path: "main.tex", content: "B", savedContent: "B" }] }), { code: "SYNC_REQUIRED" });
  assert.throws(() => agent.startConversationRun("chat"), { code: "RENDERER_WORKSPACE_MUTATION_IN_PROGRESS" });
  await request("ack", { token, buffers: [{ path: "main.tex", content: "A", savedContent: "A" }] });
  const resumed = agent.startConversationRun("chat");
  assert.equal(agent.runningControllers.size, 1);
  agent.finishConversationRun(resumed.conversationId, resumed.token);
});
