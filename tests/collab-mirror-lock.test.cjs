"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { acquireMirror, LOCK_NAME } = require("../electron/services/collab/mirror-lock.cjs");
const { WorkspaceManifest, safeRelativePath } = require("../electron/services/collab/manifest.cjs");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");

const setup = (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-mirror-"));
  const locks = [];
  const children = [];
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
    for (const lock of locks) lock.release();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return {
    base,
    preferred: path.join(base, "project-12345678"),
    acquire: (root) => {
      const lock = acquireMirror(root);
      locks.push(lock);
      return lock;
    },
    holder: async (root, quit = false) => {
      const child = spawn(process.execPath, ["-e", `
        const { acquireMirror } = require(process.argv[1]);
        const lock = acquireMirror(process.argv[2]);
        process.send({ rootPath: lock.rootPath }, () => {
          if (process.argv[3] === "quit") process.exit(0);
        });
        setInterval(() => {}, 1000);
      `, require.resolve("../electron/services/collab/mirror-lock.cjs"), root, quit ? "quit" : "hold"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      const exited = once(child, "exit");
      children.push({ child, exited });
      const [message] = await once(child, "message");
      return { child, exited, rootPath: message.rootPath };
    },
  };
};

test("a second holder uses a sibling and a released mirror can be claimed again", (t) => {
  const env = setup(t);
  const first = env.acquire(env.preferred);
  const second = env.acquire(env.preferred);
  assert.equal(first.rootPath, env.preferred);
  assert.equal(second.rootPath, `${env.preferred}-2`);
  const lockPath = path.join(first.rootPath, ".tex64", LOCK_NAME);
  const [ownerName] = fs.readdirSync(lockPath);
  const owner = JSON.parse(fs.readFileSync(path.join(lockPath, ownerName), "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.ok(owner.startedAt > 0);
  first.release();
  const replacement = env.acquire(env.preferred);
  assert.equal(replacement.rootPath, env.preferred);
  first.release();
  assert.equal(fs.existsSync(lockPath), true, "an old release cannot remove its successor");
  assert.equal(fs.existsSync(path.join(second.rootPath, ".tex64", LOCK_NAME)), true);
});

test("a live process keeps its mirror; its stale lock is reclaimed after a crash", async (t) => {
  const env = setup(t);
  const holder = await env.holder(env.preferred);
  const second = env.acquire(env.preferred);
  assert.notEqual(second.rootPath, holder.rootPath);
  holder.child.kill("SIGKILL");
  await holder.exited;
  assert.equal(fs.existsSync(path.join(holder.rootPath, ".tex64", LOCK_NAME)), true);
  const reclaimed = env.acquire(env.preferred);
  assert.equal(reclaimed.rootPath, holder.rootPath);
});

test("process exit releases mirror ownership", async (t) => {
  const env = setup(t);
  const holder = await env.holder(env.preferred, true);
  assert.deepEqual(await holder.exited, [0, null]);
  assert.equal(fs.existsSync(path.join(holder.rootPath, ".tex64", LOCK_NAME)), false);
  assert.equal(env.acquire(env.preferred).rootPath, env.preferred);
});

test("simultaneous processes reclaiming a stale mirror receive distinct folders", async (t) => {
  const env = setup(t);
  const stale = await env.holder(env.preferred);
  stale.child.kill("SIGKILL");
  await stale.exited;
  const holders = await Promise.all(Array.from({ length: 3 }, () => env.holder(env.preferred)));
  assert.equal(new Set(holders.map((holder) => holder.rootPath)).size, 3);
  assert.equal(holders.filter((holder) => holder.rootPath === env.preferred).length, 1);
});

test("lock metadata is neither shared nor listed in the project tree", async (t) => {
  const env = setup(t);
  const lock = env.acquire(env.preferred);
  fs.writeFileSync(path.join(lock.rootPath, "main.tex"), "Hello\n");
  const manifest = new WorkspaceManifest(lock.rootPath);
  await manifest.scan();
  assert.deepEqual([...manifest.entries.keys()], ["main.tex"]);
  const [ownerName] = fs.readdirSync(path.join(lock.rootPath, ".tex64", LOCK_NAME));
  assert.equal(safeRelativePath(`.tex64/${LOCK_NAME}/${ownerName}`), null);
  const workspace = new WorkspaceManager();
  workspace.setRootPath(lock.rootPath);
  const files = [];
  await workspace.walkEntries({ onFile: (relative) => files.push(relative) });
  assert.deepEqual(files, ["main.tex"]);
});

test("unreadable ownership is kept and symlinked mirrors are refused", (t) => {
  const env = setup(t);
  const directory = path.join(env.preferred, ".tex64", LOCK_NAME);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "unknown.json"), "incomplete");
  assert.notEqual(env.acquire(env.preferred).rootPath, env.preferred);
  const linked = path.join(env.base, "linked");
  fs.symlinkSync(env.preferred, linked, "dir");
  assert.throws(() => env.acquire(linked), (error) => error.code === "COLLAB_REFUSED");
});
