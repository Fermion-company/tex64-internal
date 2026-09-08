"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { HistoryController } = require("../electron/services/history-controller.cjs");

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-history-controller-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project"); await fs.mkdir(root);
  await fs.writeFile(path.join(root, "main.tex"), "first");
  const identity = { workspaceId: "project", workspaceGeneration: 1 };
  const controller = new HistoryController({
    state: identity, workspace: { getRootPath: () => root, rootInfo: async () => ({ path: "main.tex" }), setRootFile: async () => {} },
    directory: () => path.join(dir, "history"), notify: () => {},
    withMutation: async (action) => action(), isAgentBusy: () => false, hasTerminals: () => false,
    quiesce: async () => {}, afterRestore: async () => {}, advanceGeneration: () => { identity.workspaceGeneration++; },
  });
  const request = (action, args = {}) => controller.request(action, { ...identity, ...args });
  return { root, controller, request, identity };
}

test("startup recovery completes before exposing a writable workspace", async (t) => {
  const f = await fixture(t);
  await f.controller.prepareWorkspace(f.root);
  assert.equal(f.controller.status().phase, "idle");
  assert.equal(f.controller.preparedRoot, f.root);
});

test("restore keeps writers blocked until synchronized buffers are acknowledged", async (t) => {
  const f = await fixture(t);
  let token = (await f.request("begin", { purpose: "record" })).token;
  const first = await f.request("record", { token });
  await f.request("release", { token });
  await fs.writeFile(path.join(f.root, "main.tex"), "second");
  token = (await f.request("begin", { purpose: "restore" })).token;
  const { plan } = await f.request("plan", { token, id: first.record.id });
  const oldIdentity = { ...f.identity };
  const result = await f.request("restore", { token, planId: plan.id });
  assert.equal(f.identity.workspaceGeneration, oldIdentity.workspaceGeneration + 1);
  await assert.rejects(f.controller.request("status", oldIdentity), { code: "STALE_WORKSPACE" });
  assert.equal(f.controller.boundary(f.root), result.record.id);
  assert.equal(result.files[0].content, "first");
  assert.throws(() => f.controller.assertWriterAllowed(), { code: "HISTORY_BUSY" });
  await assert.rejects(f.request("release", { token }), { code: "HISTORY_BUSY" });
  await assert.rejects(f.request("ack", { token, buffers: [{ path: "main.tex", content: "second", savedContent: "second" }] }), { code: "SYNC_REQUIRED" });
  assert.equal(f.controller.status().phase, "syncing");
  const retry = await f.request("sync");
  assert.equal(retry.token, token);
  assert.equal(retry.files[0].content, "first");
  await f.request("ack", { token, buffers: [{ path: "main.tex", content: "first", savedContent: "first" }] });
  assert.equal(f.controller.status().phase, "idle");
  f.controller.assertWriterAllowed();
});


test("binary restore closes stale text models before releasing writers, including sync retry", async (t) => {
  const f = await fixture(t);
  const binary = Buffer.from([137, 80, 78, 71, 0, 255]);
  await fs.writeFile(path.join(f.root, "figure.dat"), binary);
  let token = (await f.request("begin", { purpose: "record" })).token;
  const version = await f.request("record", { token });
  await f.request("release", { token });
  await fs.writeFile(path.join(f.root, "figure.dat"), "old editable text");
  token = (await f.request("begin", { purpose: "restore" })).token;
  const { plan } = await f.request("plan", { token, id: version.record.id });
  const result = await f.request("restore", { token, planId: plan.id });
  assert.deepEqual(result.files, [{ path: "figure.dat", content: null }]);
  assert.deepEqual(await fs.readFile(path.join(f.root, "figure.dat")), binary);
  const oldBuffers = [{ path: "figure.dat", content: "old editable text", savedContent: "old editable text" }];
  await assert.rejects(f.request("ack", { token, buffers: oldBuffers }), { code: "SYNC_REQUIRED" });
  // Simulate interrupted initial sync construction; retry must carry binary paths too.
  delete f.controller.operation.syncFiles;
  const retry = await f.request("sync");
  assert.deepEqual(retry.files, [{ path: "figure.dat", content: null }]);
  await assert.rejects(f.request("ack", { token, buffers: oldBuffers }), { code: "SYNC_REQUIRED" });
  await f.request("ack", { token, buffers: [] });
  assert.equal(f.controller.status().phase, "idle");
});

test("current comparisons do not consume durable history and reject changed live previews", async (t) => {
  const f = await fixture(t);
  const token = (await f.request("begin", { purpose: "record" })).token;
  const first = await f.request("record", { token });
  await f.request("release", { token });
  const store = await f.controller.store();
  const before = { bytes: await store.usage(), trees: await fs.readdir(path.join(store.directory, "trees")) };
  store.maxBytes = before.bytes; // A full durable store must still allow read-only comparisons.
  let comparison;
  for (let i = 0; i < 12; i++) {
    await fs.writeFile(path.join(f.root, "main.tex"), `revision ${i}`);
    comparison = await f.request("compare", { left: first.record.id, buffers: [] });
  }
  assert.equal((await f.request("list")).versions.length, 1);
  assert.equal(await store.usage(), before.bytes);
  assert.deepEqual(await fs.readdir(path.join(store.directory, "trees")), before.trees);
  const shown = await f.request("diff", { comparisonId: comparison.comparisonId, path: "main.tex" });
  assert.equal(shown.original, "first"); assert.equal(shown.modified, "revision 11");
  await fs.writeFile(path.join(f.root, "main.tex"), "external change");
  await assert.rejects(f.request("diff", { comparisonId: comparison.comparisonId, path: "main.tex" }), { code: "COMPARISON_STALE" });
  const dirty = await f.request("compare", { left: first.record.id, buffers: [{ path: "main.tex", content: "unsaved snapshot", savedContent: "external change" }] });
  await fs.writeFile(path.join(f.root, "main.tex"), "changed again");
  assert.equal((await f.request("diff", { comparisonId: dirty.comparisonId, path: "main.tex" })).modified, "unsaved snapshot");
  assert.equal(await store.usage(), before.bytes);
  await assert.rejects(f.request("diff", { comparisonId: comparison.comparisonId, path: "main.tex" }), { code: "NOT_FOUND" });
});


test("cancelled restore previews do not fill durable history", async (t) => {
  const f = await fixture(t);
  let token = (await f.request("begin", { purpose: "record" })).token;
  const first = await f.request("record", { token }); await f.request("release", { token });
  const store = await f.controller.store();
  const bytes = await store.usage();
  const trees = await fs.readdir(path.join(store.directory, "trees"));
  for (let i = 0; i < 3; i++) {
    await fs.writeFile(path.join(f.root, "main.tex"), `preview ${i}`);
    token = (await f.request("begin", { purpose: "restore" })).token;
    await f.request("plan", { token, id: first.record.id });
    await f.request("release", { token });
  }
  assert.equal(f.controller.plans.size, 1);
  assert.equal(await store.usage(), bytes);
  assert.deepEqual(await fs.readdir(path.join(store.directory, "trees")), trees);
  assert.equal((await f.request("list")).versions.length, 1);
});

test("comparison source to selected version reverses additions, text and image previews together", async (t) => {
  const f = await fixture(t);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
  await fs.writeFile(path.join(f.root, "old.png"), png);
  let token = (await f.request("begin", { purpose: "record" })).token;
  const selected = await f.request("record", { token });
  await f.request("release", { token });
  await fs.writeFile(path.join(f.root, "main.tex"), "second");
  await fs.unlink(path.join(f.root, "old.png"));
  await fs.writeFile(path.join(f.root, "new.tex"), "new");
  token = (await f.request("begin", { purpose: "record" })).token;
  const source = await f.request("record", { token });
  await f.request("release", { token });
  for (const right of [null, source.record.id]) {
    const value = await f.request("compare", { left: selected.record.id, right, direction: "to-selected" });
    assert.equal(value.changes.find((item) => item.path === "old.png").kind, "added");
    assert.equal(value.changes.find((item) => item.path === "new.tex").kind, "deleted");
    const text = await f.request("diff", { comparisonId: value.comparisonId, path: "main.tex" });
    assert.equal(text.original, "second"); assert.equal(text.modified, "first");
    const image = await f.request("diff", { comparisonId: value.comparisonId, path: "old.png" });
    assert.equal(image.originalImage, null);
    assert.equal(image.modifiedImage, `data:image/png;base64,${png.toString("base64")}`);
    assert.equal(image.originalSize, 0); assert.equal(image.modifiedSize, png.length);
    const deleted = await f.request("diff", { comparisonId: value.comparisonId, path: "new.tex" });
    assert.equal(deleted.original, "new"); assert.equal(deleted.modified, "");
  }
});

test("version details use recorded exclusions independently of the live comparison source", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, ".env"), "test only");
  const token = (await f.request("begin", { purpose: "record" })).token;
  const selected = await f.request("record", { token });
  await f.request("release", { token });
  await fs.unlink(path.join(f.root, ".env"));
  await fs.writeFile(path.join(f.root, "main.log"), "build log");
  const current = await f.request("compare", { left: selected.record.id, right: null });
  assert(current.excluded.some((item) => item.path === "main.log"));
  const details = await f.request("inspect", { id: selected.record.id });
  assert(details.excluded.some((item) => item.path === ".env"));
  assert(!details.excluded.some((item) => item.path === "main.log"));
});

test("active Axiom and terminal sessions block history before quiescing or changing files", async (t) => {
  const f = await fixture(t);
  let quiesced = 0;
  f.controller.deps.quiesce = async () => { quiesced++; };
  f.controller.deps.isAgentBusy = () => true;
  for (const purpose of ["record", "restore"]) await assert.rejects(f.request("begin", { purpose }), { code: "WORKSPACE_BUSY" });
  f.controller.deps.isAgentBusy = () => false;
  f.controller.deps.hasTerminals = () => true;
  await assert.rejects(f.request("begin", { purpose: "restore" }), { code: "TERMINAL_BUSY" });
  assert.equal(quiesced, 0);
  assert.equal(f.controller.status().phase, "idle");
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "first");
  assert.equal((await f.request("list")).versions.length, 0);
});
