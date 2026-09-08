"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { HistoryStore } = require("../electron/services/history-store.cjs");
const { HistoryTransaction } = require("../electron/services/history-transaction.cjs");
const { validPath, hash } = require("../electron/services/history-files.cjs");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-history-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "project");
  await fs.mkdir(root);
  const store = new HistoryStore({ root, directory: path.join(directory, "history") });
  const tx = new HistoryTransaction(store);
  const write = async (name, bytes) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), bytes); };
  const record = () => store.exclusive(async () => store.publish(await store.capture({ rootFile: "main.tex" })));
  const plan = (id) => store.exclusive(() => tx.plan(id, "main.tex"));
  const restore = (value) => store.exclusive(() => tx.restore(value));
  return { directory, root, store, tx, write, record, plan, restore };
}

test("versions persist exact source/image bytes; restore and undo append history", async (t) => {
  const f = await fixture(t);
  await f.write("main.tex", Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("first\r\n")]));
  await f.write("chapters/intro.tex", "intro");
  await f.write("references.bib", "reference");
  await f.write("images/input.pdf", Buffer.from([0, 1, 128, 255]));
  const first = await f.record();
  const expected = await fs.readFile(path.join(f.root, "main.tex"));
  await f.write("main.tex", "second");
  await f.write("new.tex", "new");
  await fs.unlink(path.join(f.root, "chapters/intro.tex"));
  const result = await f.restore(await f.plan(first.id));
  assert.deepEqual(await fs.readFile(path.join(f.root, "main.tex")), expected);
  assert.equal(await fs.readFile(path.join(f.root, "chapters/intro.tex"), "utf8"), "intro");
  await assert.rejects(fs.access(path.join(f.root, "new.tex")));
  const safety = result.record.preRestore;
  const reopened = new HistoryStore({ root: f.root, directory: path.join(f.directory, "history") });
  const undo = new HistoryTransaction(reopened);
  await reopened.exclusive(async () => {
    assert.equal((await reopened.list()).length, 3);
    await undo.restore(await undo.plan(safety, "main.tex"));
  });
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "second");
  assert.equal(await fs.readFile(path.join(f.root, "new.tex"), "utf8"), "new");
  assert.equal((await f.store.list()).length, 5);
});

test("protected secrets, Git metadata and generated output are never captured or restored", async (t) => {
  const f = await fixture(t);
  for (const [name, text] of Object.entries({ "main.tex": "one", ".env": "secret", ".git/config": "git-config", ".git/index": "index", ".gitignore": "ignored", "main.pdf": "output", "main.log": "log", "assets/figure.pdf": "input" })) await f.write(name, text);
  const first = await f.record();
  const tree = await f.store.tree(first.treeId);
  assert.deepEqual(tree.entries.map((e) => e.path), ["assets/figure.pdf", "main.tex"]);
  assert.equal((await f.store.usage()), Buffer.byteLength("oneinput"));
  await f.write(".env", "new-secret");
  await f.write("main.tex", "two");
  await f.restore(await f.plan(first.id));
  assert.equal(await fs.readFile(path.join(f.root, ".env"), "utf8"), "new-secret");
  assert.equal(await fs.readFile(path.join(f.root, ".git/index"), "utf8"), "index");
});

test("same-size external changes and newly added files invalidate confirmed plan", async (t) => {
  const f = await fixture(t);
  await f.write("main.tex", "first");
  const first = await f.record();
  await f.write("main.tex", "later");
  const plan = await f.plan(first.id);
  await f.write("main.tex", "other");
  await assert.rejects(f.restore(plan), { code: "PLAN_STALE" });
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "other");
  const nextPlan = await f.plan(first.id);
  await f.write("new.tex", "new");
  await assert.rejects(f.restore(nextPlan), { code: "PLAN_STALE" });
});

test("capture detects an external writer without relying on watcher events", async (t) => {
  const f = await fixture(t);
  await f.write("main.tex", "one");
  f.store.fault = async (point) => { if (point === "capture-between-scans") await f.write("unopened.bib", "new"); };
  await assert.rejects(f.record(), { code: "EXTERNAL_CHANGE" });
  assert.equal((await f.store.list()).length, 0);
});

test("symlinks and malicious manifest paths cannot escape the project", async (t) => {
  const f = await fixture(t);
  await f.write("main.tex", "safe");
  await fs.writeFile(path.join(f.directory, "outside"), "private");
  await fs.symlink(path.join(f.directory, "outside"), path.join(f.root, "linked.tex"));
  const record = await f.record();
  assert.equal((await f.store.tree(record.treeId)).entries.length, 1);
  for (const name of ["../outside", "/tmp/outside", "a/../../b", "C:\\file", "file:stream", "a//b", "a/CON.txt"]) assert.throws(() => validPath(name));
  const badTree = { schema: 1, rootFile: "main.tex", entries: [{ path: "../outside", blob: hash("bad"), size: 3 }], excluded: [], policy: 1 };
  const id = hash(JSON.stringify(badTree));
  await fs.writeFile(f.store.file("trees", id), JSON.stringify(badTree));
  await assert.rejects(f.store.tree(id), { code: "INVALID_PATH" });
  assert.equal(await fs.readFile(path.join(f.directory, "outside"), "utf8"), "private");
});

test("quota, large files and corrupt blobs fail before project mutation", async (t) => {
  const f = await fixture(t);
  await f.write("main.tex", "first");
  f.store.maxBytes = 1;
  await assert.rejects(f.record(), { code: "QUOTA_EXCEEDED" });
  f.store.maxBytes = 1000;
  f.store.maxFileBytes = 1;
  await assert.rejects(f.record(), { code: "FILE_TOO_LARGE" });
  f.store.maxFileBytes = 1000;
  const first = await f.record();
  const tree = await f.store.tree(first.treeId);
  await f.write("main.tex", "current");
  await fs.writeFile(f.store.file("blobs", tree.entries[0].blob), "damaged");
  await assert.rejects(f.plan(first.id), { code: "STORE_CORRUPT" });
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "current");
});

for (const point of ["journal-prepared", "before-change-0", "after-backup-0", "after-install-0", "before-verify", "before-restore-commit"]) {
  test(`injected failure at ${point} rolls back completely`, async (t) => {
    const f = await fixture(t);
    await f.write("main.tex", "first");
    const first = await f.record();
    await f.write("main.tex", "second");
    await f.write("z-added.tex", "added");
    const plan = await f.plan(first.id);
    f.store.fault = async (name) => { if (name === point) throw Object.assign(new Error("injected failure"), { code: "EIO" }); };
    await assert.rejects(f.restore(plan));
    assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "second");
    assert.equal(await fs.readFile(path.join(f.root, "z-added.tex"), "utf8"), "added");
    await assert.rejects(fs.access(f.tx.journalFile));
  });
}

test("external replacement during installation is retained and blocks ordinary recovery", async (t) => {
  const f = await fixture(t);
  await f.write("main.tex", "first");
  const first = await f.record();
  await f.write("main.tex", "second");
  const plan = await f.plan(first.id);
  f.store.fault = async (point) => { if (point === "before-install-0") await f.write("main.tex", "external"); };
  await assert.rejects(f.restore(plan), { code: "RECOVERY_REQUIRED" });
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "external");
  assert.equal(await fs.readFile(path.join(f.root, `.tex64/history-transactions/${plan.id}/0.old`), "utf8"), "second");
  await assert.rejects(f.store.exclusive(() => f.tx.recover()), { code: "EXTERNAL_CHANGE" });
  await fs.rename(path.join(f.root, "main.tex"), path.join(f.root, "external-preserved.tex"));
  f.store.fault = async () => {};
  await f.store.exclusive(() => f.tx.recover());
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "second");
  assert.equal(await fs.readFile(path.join(f.root, "external-preserved.tex"), "utf8"), "external");
});

for (const point of ["journal-prepared", "after-backup-0", "after-install-0", "before-restore-commit", "after-restore-commit"]) {
  test(`process death at ${point} recovers on reopen without duplicate restore`, async (t) => {
    const f = await fixture(t);
    await f.write("main.tex", "first");
    const first = await f.record();
    await f.write("main.tex", "second");
    const childCode = `
      const {HistoryStore}=require(${JSON.stringify(require.resolve("../electron/services/history-store.cjs"))});
      const {HistoryTransaction}=require(${JSON.stringify(require.resolve("../electron/services/history-transaction.cjs"))});
      const s=new HistoryStore({root:${JSON.stringify(f.root)},directory:${JSON.stringify(path.join(f.directory, "history"))},fault:async p=>{if(p===${JSON.stringify(point)})process.exit(71)}});
      s.exclusive(async()=>{const tx=new HistoryTransaction(s);await tx.restore(await tx.plan(${JSON.stringify(first.id)},'main.tex'));}).catch(e=>{console.error(e);process.exit(2)});
    `;
    const child = spawnSync(process.execPath, ["-e", childCode], { encoding: "utf8" });
    assert.equal(child.status, 71, child.stderr);
    const reopened = new HistoryStore({ root: f.root, directory: path.join(f.directory, "history") });
    await reopened.exclusive(() => new HistoryTransaction(reopened).recover());
    assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), point === "after-restore-commit" ? "first" : "second");
    assert.equal((await reopened.list()).filter((r) => r.kind === "restore").length, point === "after-restore-commit" ? 1 : 0);
    assert.deepEqual(await reopened.exclusive(() => new HistoryTransaction(reopened).recover()), { recovered: false });
  });
}

test("capacity choice persists after reopening history", async (t) => {
  const f = await fixture(t);
  await f.store.setLimit(4);
  const reopened = new HistoryStore({ root: f.root, directory: path.join(f.directory, "history") });
  await reopened.initialize();
  assert.equal(reopened.maxBytes, 4 * 1024 ** 3);
  await assert.rejects(reopened.setLimit(0), { code: "INVALID_LIMIT" });
  await reopened.initialize();
  assert.equal(reopened.maxBytes, 4 * 1024 ** 3);
});

test("process death before lock publication does not leave an ownerless live lock", async (t) => {
  const f = await fixture(t);
  await f.write("main.tex", "retained");
  const child = spawnSync(process.execPath, ["-e", `
    const { HistoryStore } = require(${JSON.stringify(require.resolve("../electron/services/history-store.cjs"))});
    const store = new HistoryStore({ root: process.argv[1], directory: process.argv[2], fault: async point => { if (point === 'lock-before-publish') process.exit(71); } });
    store.exclusive(async () => store.publish(await store.capture({ rootFile: 'main.tex' })));
  `, f.root, path.join(f.directory, "history")]);
  assert.equal(child.status, 71);
  const version = await f.record();
  assert.equal((await f.store.list()).length, 1);
  assert.equal((await f.store.tree(version.treeId)).entries[0].blob, hash("retained"));
});
