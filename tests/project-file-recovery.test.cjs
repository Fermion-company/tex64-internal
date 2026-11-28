"use strict";

// Interrupted and contested in-place saves, staging names, lock owners that
// the OS cannot identify, and exclusive creation without hard links.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, fork } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const {
  writeProjectFile, isStagingName, ownerGone,
} = require("../electron/services/project-file-writes.cjs");

const mac = process.platform === "darwin";
const uuid = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

if (process.argv[2] === "crash-child") {
  // Saves one file and kills itself (SIGKILL: no cleanup runs) at the chosen
  // file-system step: before it, after it, or halfway through a write.
  const { file, content, locks, step, name, mode } = JSON.parse(process.argv[3]);
  (async () => {
    const probe = await fsp.open(file, "r");
    const handle = Object.getPrototypeOf(probe);
    await probe.close();
    let count = 0;
    const crash = () => {
      process.kill(process.pid, "SIGKILL");
      return new Promise(() => {});
    };
    const at = async (op, run, half) => {
      count += 1;
      if (!(name ? op === name : count === step)) return run();
      if (mode === "after") await run();
      else if (mode === "partial" && half) await half();
      return crash();
    };
    for (const op of ["write", "writeFile", "truncate", "sync", "chmod", "close"]) {
      const original = handle[op];
      handle[op] = function (...args) {
        const half = op === "write" ? () => original.call(this, args[0], args[1], Math.max(1, Math.floor(args[2] / 2)), args[3])
          : op === "writeFile" ? () => original.call(this, Buffer.from(args[0]).subarray(0, Math.max(1, Math.floor(args[0].length / 2))))
            : null;
        return at(op, () => original.apply(this, args), half);
      };
    }
    for (const op of ["unlink", "rename", "link"]) {
      const original = fsp[op];
      fsp[op] = (...args) => at(op, () => original.apply(fsp, args));
    }
    await writeProjectFile(file, content, { directory: () => locks });
    process.send({ done: true, count });
    process.disconnect();
  })();
} else {
  const { processStartTimeAsync, pidAlive: pidAliveReal } = require("../electron/services/workspace-window-lock.cjs");
  const { WorkspaceManager, WorkspaceError } = require("../electron/services/workspace.cjs");
  const { WorkspaceFileWatcher } = require("../electron/services/workspace-file-watcher.cjs");
  const { protectedReason } = require("../electron/services/history-files.cjs");
  const { HistoryStore } = require("../electron/services/history-store.cjs");
  const { createWorkspaceContext } = require("../electron/handlers/workspace/context.cjs");
  const { createWorkspaceFileHandlers } = require("../electron/handlers/workspace/file-handlers.cjs");

  const sandbox = async (t) => {
    const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-recovery-")));
    t.after(() => fsp.rm(base, { recursive: true, force: true }));
    const root = path.join(base, "project");
    const locks = path.join(base, "locks");
    await fsp.mkdir(root);
    const workspace = new WorkspaceManager({ fileLockDirectory: () => locks });
    workspace.setRootPath(root);
    return { base, root, locks, workspace };
  };

  const interrupt = async (options) => {
    const child = fork(__filename, ["crash-child", JSON.stringify(options)], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const messages = [];
    child.on("message", (message) => messages.push(message));
    await once(child, "exit");
    return messages.find((message) => message.done) ?? null;
  };

  const leftovers = async (directory) => (await fsp.readdir(directory)).filter(isStagingName);

  for (const [label, before, after] of [
    ["a shrinking", "old stale tail\n".repeat(300), "NEW\n"],
    ["a growing", "short\n", "a much longer replacement\n".repeat(300)],
  ]) {
    test(`${label} in-place save interrupted at any step reopens as the complete old or new file`, { timeout: 180_000 }, async (t) => {
      const f = await sandbox(t);
      const doc = path.join(f.root, "doc.tex");
      const alias = path.join(f.base, "alias.tex");
      let torn = 0;
      for (const mode of ["before", "partial", "after"]) {
        for (let step = 1; ; step++) {
          await fsp.rm(doc, { force: true });
          await fsp.rm(alias, { force: true });
          // Each killed save leaves its lock behind; dead-owner takeover is
          // covered elsewhere and would only lengthen the step count here.
          await fsp.rm(f.locks, { recursive: true, force: true });
          await fsp.writeFile(doc, before);
          await fsp.chmod(doc, 0o640);
          // A second link keeps the save in place on every platform.
          await fsp.link(doc, alias);
          const inode = (await fsp.stat(doc)).ino;
          const done = await interrupt({ file: doc, content: after, locks: f.locks, step, mode });
          const where = `${mode} step ${step}`;
          assert.ok(step < 200, "the save never completed");
          if (done) {
            assert.equal(await fsp.readFile(doc, "utf8"), after, where);
            assert.deepEqual(await leftovers(f.root), [], where);
            t.diagnostic(`${mode}: interrupted at each of ${step - 1} steps`);
            break;
          }
          const raw = await fsp.readFile(doc, "utf8");
          if (raw !== before && raw !== after) {
            torn += 1;
            assert.ok((await leftovers(f.root)).some((name) => name.startsWith(".tex64-recovery.")), `${where}: torn without a recovery file`);
          }
          const opened = await f.workspace.readFile("doc.tex");
          assert.ok(opened === before || opened === after, `${where}: reopened ${JSON.stringify(opened.slice(0, 40))}`);
          if (raw !== before && raw !== after) assert.equal(opened, before, `${where}: an unacknowledged save is undone`);
          assert.equal(await fsp.readFile(alias, "utf8"), opened, where);
          const stat = await fsp.stat(doc);
          assert.equal(stat.ino, inode, where);
          assert.equal(stat.mode & 0o777, 0o640, where);
          assert.deepEqual(await leftovers(f.root), [], where);
        }
      }
      assert.ok(torn >= 1, "the interruptions must reach a torn file");
      t.diagnostic(`${torn} torn states, each restored to the old version`);
    });
  }

  test("reopening settles each of two interrupted documents from its own recovery file, keeping links, tags and ACLs", { timeout: 30_000 }, async (t) => {
    const f = await sandbox(t);
    const docs = ["a.tex", "b.tex"].map((name) => ({
      name, file: path.join(f.root, name), alias: path.join(f.base, `alias-${name}`),
      old: `${name} old version with a long tail\n`.repeat(50), next: `${name} new\n`,
    }));
    const tag = "com.apple.metadata:_kMDItemUserTags";
    const listing = (file) => execFileSync("/bin/ls", ["-lde@", file], { encoding: "utf8" }).split("\n").slice(1);
    for (const doc of docs) {
      await fsp.writeFile(doc.file, doc.old);
      await fsp.link(doc.file, doc.alias);
      if (mac) {
        execFileSync("/usr/bin/xattr", ["-w", tag, `${doc.name} tag`, doc.file]);
        execFileSync("/bin/chmod", ["+a", "everyone deny execute", doc.file]);
      }
      doc.inode = (await fsp.stat(doc.file)).ino;
      doc.metadata = mac ? listing(doc.file) : null;
      // Killed after writing the new prefix, before cutting off the old tail.
      assert.equal(await interrupt({ file: doc.file, content: doc.next, locks: f.locks, name: "truncate", mode: "before" }), null);
      assert.ok((await fsp.readFile(doc.file, "utf8")).startsWith(doc.next));
      assert.notEqual(await fsp.readFile(doc.file, "utf8"), doc.next);
    }
    const recoveries = async () => (await fsp.readdir(f.root)).filter((name) => name.startsWith(".tex64-recovery."));
    assert.equal((await recoveries()).length, 2);
    assert.equal(await f.workspace.readFile("a.tex"), docs[0].old);
    assert.equal((await recoveries()).length, 1, "only a.tex's recovery file is used");
    assert.notEqual(await fsp.readFile(docs[1].file, "utf8"), docs[1].old);
    assert.equal(await f.workspace.readFile("b.tex"), docs[1].old);
    assert.deepEqual(await recoveries(), []);
    for (const doc of docs) {
      assert.equal(await fsp.readFile(doc.alias, "utf8"), doc.old);
      assert.equal((await fsp.stat(doc.file)).ino, doc.inode);
      if (mac) assert.deepEqual(listing(doc.file), doc.metadata);
    }
  });

  test("a recovery file is never used against a file someone else changed after the interruption", { timeout: 30_000 }, async (t) => {
    const f = await sandbox(t);
    const doc = path.join(f.root, "doc.tex");
    await fsp.writeFile(doc, "old version with a long tail\n".repeat(20));
    await fsp.link(doc, path.join(f.base, "alias.tex"));
    assert.equal(await interrupt({ file: doc, content: "new\n", locks: f.locks, name: "truncate", mode: "before" }), null);
    // Another editor rewrites the torn file in place before TeX64 opens it.
    await fsp.writeFile(doc, "written by another editor\n");
    assert.equal(await f.workspace.readFile("doc.tex"), "written by another editor\n");
    assert.equal((await leftovers(f.root)).length, 1, "both versions stay available");
  });

  const fileHandlers = (workspace, replies) => {
    const ctx = createWorkspaceContext({
      fs, fsp, path, workspace, WorkspaceError, state: {}, sendIssues: () => {},
      sendToRenderer: (type, payload) => replies.push({ type, ...payload }),
    });
    ctx.updateWorkspaceIfNeeded = async () => {};
    ctx.requestIndex = () => {};
    return createWorkspaceFileHandlers(ctx);
  };

  test("an outside program replacing the file during an in-place save gets no success reply and keeps its bytes", async (t) => {
    const f = await sandbox(t);
    const doc = path.join(f.root, "doc.tex");
    const alias = path.join(f.base, "alias.tex");
    await fsp.writeFile(doc, "old text\n");
    await fsp.link(doc, alias);
    const open = fsp.open;
    let replaced = false;
    t.mock.method(fsp, "open", async (filename, flags, ...args) => {
      const handle = await open(filename, flags, ...args);
      if (filename !== doc || typeof flags !== "number" || !(flags & fs.constants.O_WRONLY) || replaced) return handle;
      const write = handle.write.bind(handle);
      handle.write = async (...writeArgs) => {
        if (!replaced) {
          // Between TeX64's last check and its first byte: write and rename.
          replaced = true;
          await fsp.writeFile(path.join(f.root, ".doc.outside"), "OUTSIDE\n");
          await fsp.rename(path.join(f.root, ".doc.outside"), doc);
        }
        return write(...writeArgs);
      };
      return handle;
    });
    t.mock.method(console, "warn", () => {});
    const replies = [];
    await fileHandlers(f.workspace, replies).handleSaveFile("doc.tex", "editor text\n", { expectedContent: "old text\n" });
    assert.equal(replaced, true);
    assert.deepEqual(replies.map(({ type, ok }) => [type, ok]), [["saveResult", false]]);
    assert.match(replies[0].error, /changed on disk/);
    assert.equal(await fsp.readFile(doc, "utf8"), "OUTSIDE\n");
    assert.equal(await fsp.readFile(alias, "utf8"), "old text\n", "the moved-away inode is put back");
    const [kept] = await leftovers(f.root);
    assert.ok(kept?.startsWith(".tex64-recovery."));
    assert.ok((await fsp.readFile(path.join(f.root, kept), "utf8")).endsWith("editor text\n"));
    t.mock.restoreAll();
    assert.equal(await f.workspace.readFile("doc.tex"), "OUTSIDE\n", "the outside version is never overwritten");
    // The editor merges the outside version and saves again: superseded.
    await fileHandlers(f.workspace, replies).handleSaveFile("doc.tex", "OUTSIDE\neditor text\n", { expectedContent: "OUTSIDE\n" });
    assert.equal(replies.at(-1).ok, true);
    assert.equal(await fsp.readFile(doc, "utf8"), "OUTSIDE\neditor text\n");
    assert.deepEqual(await leftovers(f.root), []);
  });

  test("staging names are matched by basename, new and legacy, and nothing else", () => {
    for (const name of [
      `.tex64-write.tmp-123-${uuid}`, `chapters/.tex64-recovery.tmp-9-${uuid}`, `chapters\\._.tex64-write.tmp-1-${uuid}`,
      ".main.tex.tmp-4242-1764200000000", "a/b/.refs.bib.tmp-1-2", ".tex64-write.tmp-1-2",
    ]) assert.equal(isStagingName(name), true, name);
    for (const name of [
      "main.tex", "chapter.tmp-1-2", `notes.tex64-write.tmp-1-${uuid}`, `.tex64-write.tmp-x-${uuid}`,
      ".tex64-write.tmp-1-", `.tex64-write.tmp-1-${uuid}/child.tex`, ".tmp-1-2",
    ]) assert.equal(isStagingName(name), false, name);
  });

  test("the watcher ignores staging events but still sees new project files", async (t) => {
    const f = await sandbox(t);
    let listener;
    t.mock.method(fs, "watch", (_root, _options, callback) => {
      listener = callback;
      return { on() {}, close() {} };
    });
    const watcher = new WorkspaceFileWatcher({ resolvePath: (file) => path.join(f.root, file), onChange() {}, onTree() {} });
    t.after(() => watcher.stop());
    watcher.start(f.root, 1);
    for (const name of [`.tex64-write.tmp-1-${uuid}`, `sub${path.sep}.tex64-recovery.tmp-1-${uuid}`,
      `._.tex64-write.tmp-1-${uuid}`, ".main.tex.tmp-1-1764200000000"]) {
      listener("rename", name);
      assert.ok(!watcher.treeDirty, name);
    }
    listener("rename", "figure.png");
    assert.equal(watcher.treeDirty, true);
  });

  test("moving a folder succeeds when a save's staging file disappears between the two scans", async (t) => {
    const f = await sandbox(t);
    const folder = path.join(f.root, "chapters");
    await fsp.mkdir(folder);
    await fsp.writeFile(path.join(folder, "one.tex"), "one");
    const stage = path.join(folder, `.tex64-recovery.tmp-${process.pid}-${uuid}`);
    await fsp.writeFile(stage, "staged");
    await fsp.writeFile(path.join(folder, ".two.tex.tmp-1-1764200000000"), "v0.1.32 leftover");
    const readdir = fsp.readdir;
    let scans = 0;
    t.mock.method(fsp, "readdir", async (...args) => {
      const result = await readdir.apply(fsp, args);
      if (args[0] === folder && args[1]?.recursive && ++scans === 1) await fsp.unlink(stage);
      return result;
    });
    assert.equal(await f.workspace.renameItem("chapters", "parts"), "parts");
    assert.equal(scans, 2);
    assert.deepEqual((await fsp.readdir(path.join(f.root, "parts"))).sort(), [".two.tex.tmp-1-1764200000000", "one.tex"]);
  });

  test("history leaves staging files out of a capture", async (t) => {
    const f = await sandbox(t);
    await fsp.writeFile(path.join(f.root, "main.tex"), "\\documentclass{article}");
    await fsp.mkdir(path.join(f.root, "chapters"));
    const staged = [`.tex64-write.tmp-1-${uuid}`, `chapters/.tex64-recovery.tmp-2-${uuid}`, ".main.tex.tmp-3-1764200000000"];
    for (const name of staged) await fsp.writeFile(path.join(f.root, name), "staged");
    for (const name of staged) assert.equal(protectedReason(name), "generated", name);
    assert.equal(protectedReason("chapters/one.tex"), null);
    const store = await new HistoryStore({ root: f.root, directory: path.join(f.base, "history") }).initialize();
    const capture = await store.capture({ persist: false });
    assert.deepEqual(capture.entries.map((entry) => entry.path), ["main.tex"]);
    assert.deepEqual(capture.excluded.filter((entry) => entry.reason === "generated").map((entry) => entry.path).sort(),
      [...staged].sort());
  });

  test("a version recorded with staging files stays readable, publishable and restorable without them", async (t) => {
    const { HistoryTransaction } = require("../electron/services/history-transaction.cjs");
    const { hash } = require("../electron/services/history-files.cjs");
    const f = await sandbox(t);
    const main = path.join(f.root, "main.tex");
    await fsp.writeFile(main, "first version");
    const store = await new HistoryStore({ root: f.root, directory: path.join(f.base, "history") }).initialize();
    const captured = await store.capture();
    // What a build that did not recognise staging names could have recorded.
    const old = JSON.parse(await fsp.readFile(store.file("trees", captured.id), "utf8"));
    const staged = Buffer.from("staged bytes");
    const blob = await store.putBlob(staged);
    const stages = [`.tex64-write.tmp-11-${uuid}`, `chapters/.tex64-recovery.tmp-12-${uuid}`, ".main.tex.tmp-13-1764200000000"];
    old.entries.push(...stages.map((name) => ({ path: name, blob, size: staged.length, mode: 0o644 })));
    const oldId = hash(JSON.stringify(old));
    await fsp.writeFile(store.file("trees", oldId), JSON.stringify(old));
    const version = await store.publish({ id: oldId, ...old }, { label: "older build" });
    assert.deepEqual((await store.tree(oldId)).entries.map((entry) => entry.path), ["main.tex"]);
    await fsp.writeFile(main, "second version");
    const next = await store.publish(await store.capture(), { label: "now" });
    assert.equal(next.summary.changed, 1);
    assert.equal(next.summary.deleted, 0);
    const history = new HistoryTransaction(store);
    await history.restore(await history.plan(version.id));
    assert.equal(await fsp.readFile(main, "utf8"), "first version");
    assert.deepEqual((await fsp.readdir(f.root, { recursive: true })).filter(isStagingName), [], "no staging file is restored");
  });

  test("the build's project inventory ignores staging files, new and legacy", async (t) => {
    const { projectLookupInventory } = require("../electron/services/build/recorder-ownership.cjs");
    const f = await sandbox(t);
    await fsp.writeFile(path.join(f.root, "main.tex"), "\\documentclass{article}");
    const before = await projectLookupInventory(f.root);
    assert.ok(before);
    for (const name of [`.tex64-write.tmp-1-${uuid}`, `.tex64-recovery.tmp-2-${uuid}`, ".main.tex.tmp-3-1764200000000"]) {
      await fsp.writeFile(path.join(f.root, name), "staged");
    }
    assert.equal(await projectLookupInventory(f.root), before);
    await fsp.writeFile(path.join(f.root, "chapter.tex"), "");
    assert.notEqual(await projectLookupInventory(f.root), before);
  });

  // Folder claims (one TeX64 window per folder).
  const quietClaim = async (lockDir, root, gen, owner) => {
    const { WorkspaceWindowLock, canonicalRoot } = require("../electron/services/workspace-window-lock.cjs");
    const file = path.join(lockDir, `${new WorkspaceWindowLock({ directory: () => lockDir }).baseFor(canonicalRoot(root))}.${gen}.json`);
    await fsp.mkdir(lockDir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(owner));
    const old = new Date(Date.now() - 120_000);
    await fsp.utimes(file, old, old);
    return file;
  };

  test("a folder switch learns a quiet owner's start time off the event loop", { timeout: 10_000 }, async (t) => {
    const { WorkspaceWindowLock } = require("../electron/services/workspace-window-lock.cjs");
    const { createFolderSwitchClaim } = require("../electron/services/folder-switch-claim.cjs");
    const f = await sandbox(t);
    const lockDir = path.join(f.base, "open-workspaces");
    const reused = path.join(f.base, "reused");
    const suspended = path.join(f.base, "suspended");
    await fsp.mkdir(reused);
    await fsp.mkdir(suspended);
    const startedAt = Date.now() - 3_600_000;
    await quietClaim(lockDir, reused, 1, { pid: 4_100_001, token: "earlier", startedAt });
    await quietClaim(lockDir, suspended, 1, { pid: 4_100_002, token: "sleeping", startedAt });
    let asked = 0;
    const lock = new WorkspaceWindowLock({
      directory: () => lockDir,
      isAlive: (pid) => pid > 4_100_000 || pidAliveReal(pid),
      startTimeOf: () => { throw new Error("no synchronous lookup on this path"); },
      startTimeAsync: async (pid) => {
        asked += 1;
        await delay(150);
        return pid === 4_100_001 ? startedAt + 3_600_000 : startedAt;
      },
    });
    t.after(() => lock.releaseAll());
    let root = null;
    const claim = createFolderSwitchClaim({ lock, currentRoot: () => root, takenError: () => new Error("taken") });
    let gap = 0;
    let last = performance.now();
    const ticker = setInterval(() => { gap = Math.max(gap, performance.now() - last); last = performance.now(); }, 2);
    try {
      await claim.reserve(reused, async () => {});
      root = reused;
      await assert.rejects(claim.reserve(suspended, async () => {}), /taken/);
    } finally {
      clearInterval(ticker);
    }
    assert.ok(gap < 100, `event loop stalled for ${gap} ms`);
    assert.equal(asked, 2);
    assert.equal(lock.owns(reused), true);
    assert.equal(lock.owns(suspended), false);
  });

  test("an owner's later check never waits for the OS: undecided until the answer arrives", { timeout: 10_000 }, async (t) => {
    const { WorkspaceWindowLock } = require("../electron/services/workspace-window-lock.cjs");
    const f = await sandbox(t);
    const lockDir = path.join(f.base, "open-workspaces");
    const root = path.join(f.base, "book");
    await fsp.mkdir(root);
    let answer;
    let lost = 0;
    const lock = new WorkspaceWindowLock({
      directory: () => lockDir,
      isAlive: (pid) => pid === 4_100_003 || pidAliveReal(pid),
      startTimeOf: () => { throw new Error("no synchronous lookup on this path"); },
      startTimeAsync: () => new Promise((resolve) => { answer = resolve; }),
      onLost: () => { lost += 1; },
    });
    t.after(() => lock.releaseAll());
    assert.equal(await lock.claimAsync(root), true);
    // Another process judged this one gone and took a newer generation, then went quiet.
    const startedAt = Date.now() - 3_600_000;
    await quietClaim(lockDir, root, 2, { pid: 4_100_003, token: "newer", startedAt });
    assert.equal(lock.owns(root), false);
    assert.equal(lock.permitsWrites(root), false);
    assert.equal(lost, 0, "an unanswered lookup does not give the folder up");
    await delay(0);
    answer(startedAt + 3_600_000);
    await delay(20);
    assert.equal(lock.owns(root), true, "the newer claim's pid belongs to another program now");
    assert.equal(lost, 0);
  });

  test("a folder claim on a volume without hard links uses exclusive creation (EISDIR from Windows)", async (t) => {
    const { WorkspaceWindowLock } = require("../electron/services/workspace-window-lock.cjs");
    const f = await sandbox(t);
    const lockDir = path.join(f.base, "open-workspaces");
    const root = path.join(f.base, "book");
    await fsp.mkdir(root);
    t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("Incorrect function."), { code: "EISDIR" }); });
    const first = new WorkspaceWindowLock({ directory: () => lockDir });
    // Another window: a different process.
    const second = new WorkspaceWindowLock({ directory: () => lockDir, pid: 4_100_009 });
    t.after(() => { first.releaseAll(); second.releaseAll(); });
    assert.equal(await first.claimAsync(root), true);
    assert.equal(first.owns(root), true);
    assert.equal(await second.claimAsync(root), false);
  });

  // Lock owners. The OS lookup is injected: Windows cannot be run here.
  const quietOwner = (pid, startedAt = 1_000_000) => ({ pid, startedAt, token: `owner-${pid}`, acquiredAt: 0 });

  test("a lock owner is judged without a lookup when its pid is gone, it is fresh, or it is this process", async () => {
    let lookups = 0;
    const ownership = { isAlive: (pid) => pid !== 11, startTimeOf: () => { lookups++; return null; }, now: () => 5_000_000 };
    assert.equal(await ownerGone(quietOwner(11), { file: "dead" }, ownership), true);
    assert.equal(await ownerGone(quietOwner(12), { file: "fresh", mtimeMs: 5_000_000 - 1_000 }, ownership), false);
    const self = Date.now() - process.uptime() * 1000;
    assert.equal(await ownerGone(quietOwner(process.pid, self), { file: "self" }, ownership), false);
    assert.equal(await ownerGone(quietOwner(process.pid, self - 3_600_000), { file: "earlier" }, ownership), true);
    assert.equal(await ownerGone({ pid: 13, token: "x" }, { file: "malformed" }, ownership), false);
    assert.equal(lookups, 0);
  });

  test("a quiet owner is checked against its start time, and an unknown one passes only after a bounded wait", async () => {
    let clock = 0;
    let answer = 1_000_000;
    const ownership = { isAlive: () => true, startTimeOf: async () => answer, now: () => 5_000_000, clock: () => clock };
    assert.equal(await ownerGone(quietOwner(21), { file: "same" }, ownership, 100), false, "the same process, suspended");
    answer = 2_000_000;
    assert.equal(await ownerGone(quietOwner(21), { file: "reused" }, ownership, 100), true, "the pid was reused");
    answer = null;
    const record = { file: "unknown", mtimeMs: 10 };
    assert.equal(await ownerGone(quietOwner(22), record, ownership, 100), false);
    clock += 29_000;
    assert.equal(await ownerGone(quietOwner(22), record, ownership, 100), false);
    // A heartbeat restarts the wait.
    assert.equal(await ownerGone(quietOwner(22), { ...record, mtimeMs: 20 }, ownership, 100), false);
    clock += 29_000;
    assert.equal(await ownerGone(quietOwner(22), { ...record, mtimeMs: 20 }, ownership, 100), false);
    clock += 1_000;
    assert.equal(await ownerGone(quietOwner(22), { ...record, mtimeMs: 20 }, ownership, 100), true);
  });

  test("a slow lookup never holds up the caller past its budget", async () => {
    let gap = 0;
    let last = performance.now();
    const ticker = setInterval(() => { gap = Math.max(gap, performance.now() - last); last = performance.now(); }, 2);
    try {
      const ownership = { isAlive: () => true, startTimeOf: () => new Promise(() => {}), now: () => 5_000_000 };
      const start = performance.now();
      assert.equal(await ownerGone(quietOwner(31), { file: "slow" }, ownership, 60), false);
      assert.ok(performance.now() - start < 500);
    } finally {
      clearInterval(ticker);
    }
    assert.ok(gap < 100, `event loop stalled for ${gap} ms`);
  });

  test("start-time lookups run asynchronously, once per pid, and read each platform's answer", async () => {
    const cache = new Map();
    let now = 0;
    const calls = [];
    const run = (file, args, options, callback) => {
      calls.push({ file, args, options });
      setTimeout(() => callback(null, "1764200000123\r\n"), 20);
    };
    const ask = () => processStartTimeAsync(41, { platform: "win32", run, cache, now: () => now });
    const [first, second] = await Promise.all([ask(), ask()]);
    assert.deepEqual([first, second], [1764200000123, 1764200000123]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, "powershell.exe");
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.timeout, 10_000);
    now += 1_000;
    await ask();
    assert.equal(calls.length, 1, "a fresh answer is reused");
    now += 5_000;
    await ask();
    assert.equal(calls.length, 2);
    const refused = (_file, _args, _options, callback) => callback(Object.assign(new Error("denied"), { code: "EPERM" }));
    assert.equal(await processStartTimeAsync(42, { platform: "win32", run: refused, cache }), null);
    assert.equal(await processStartTimeAsync(43, { platform: "darwin", cache,
      run: (_file, _args, _options, callback) => callback(null, "Thu Nov 27 10:00:00 2026\n") }), Date.parse("Thu Nov 27 10:00:00 2026"));
    const proc = { "/proc/44/stat": `44 (a b) S ${Array(18).fill(0).join(" ")} 500 0`, "/proc/stat": "cpu 0\nbtime 1700000000\n" };
    assert.equal(await processStartTimeAsync(44, { platform: "linux", cache, read: (file) => proc[file] }), 1700000000 * 1000 + 5000);
    const real = await processStartTimeAsync(process.pid, { cache });
    if (real !== null) assert.ok(Math.abs(real - (Date.now() - process.uptime() * 1000)) < 5_000);
  });

  const lockFor = async (f, file) => {
    const key = process.platform === "win32" ? fs.realpathSync.native(file).toLowerCase() : fs.realpathSync.native(file);
    await fsp.mkdir(f.locks, { recursive: true });
    return path.join(f.locks, `${createHash("sha256").update(key).digest("hex")}.0.lock`);
  };

  test("saves wait out a genuinely live owner and take over a reused pid once its slow lookup answers", { timeout: 20_000 }, async (t) => {
    const f = await sandbox(t);
    const doc = path.join(f.root, "doc.tex");
    await fsp.writeFile(doc, "before");
    const lock = await lockFor(f, doc);
    const startedAt = Date.now() - 3_600_000;
    await fsp.writeFile(lock, JSON.stringify({ pid: 4_000_001, startedAt, token: "other", acquiredAt: startedAt }));
    const cache = new Map();
    let lookups = 0;
    let started = startedAt;
    const run = (_file, _args, _options, callback) => { lookups++; setTimeout(() => callback(null, String(started)), 1_200); };
    const ownership = {
      isAlive: (pid) => pid === 4_000_001,
      startTimeOf: (pid) => processStartTimeAsync(pid, { platform: "win32", run, cache }),
    };
    const write = (text) => writeProjectFile(doc, text, { directory: () => f.locks, ownership });
    // Fresh heartbeat: a live owner, no lookup.
    await assert.rejects(write("first"), { code: "FILE_WRITE_BUSY" });
    assert.equal(lookups, 0);
    // Quiet for an hour, and the lookup says the pid now belongs to another process.
    const old = new Date(Date.now() - 3_600_000);
    await fsp.utimes(lock, old, old);
    started = Date.now();
    const begin = performance.now();
    await assert.rejects(write("second"), { code: "FILE_WRITE_BUSY" });
    assert.ok(performance.now() - begin < 1_100, "the save does not wait for PowerShell");
    await delay(1_300);
    await write("third");
    assert.equal(await fsp.readFile(doc, "utf8"), "third");
    assert.equal(lookups, 1, "the pending lookup is shared");
  });

  test("a quiet owner the OS confirms keeps its lock; one the OS cannot identify is taken over after the bounded wait", { timeout: 20_000 }, async (t) => {
    const f = await sandbox(t);
    const doc = path.join(f.root, "doc.tex");
    await fsp.writeFile(doc, "before");
    const lock = await lockFor(f, doc);
    const startedAt = Date.now() - 3_600_000;
    await fsp.writeFile(lock, JSON.stringify({ pid: 4_000_002, startedAt, token: "other", acquiredAt: startedAt }));
    const old = new Date(startedAt);
    await fsp.utimes(lock, old, old);
    let answer = startedAt;
    let clock = 0;
    const ownership = { isAlive: (pid) => pid === 4_000_002, startTimeOf: async () => answer, clock: () => clock };
    const write = (text) => writeProjectFile(doc, text, { directory: () => f.locks, ownership });
    await assert.rejects(write("suspended owner"), { code: "FILE_WRITE_BUSY" });
    answer = null;
    await assert.rejects(write("unknown owner"), { code: "FILE_WRITE_BUSY" });
    clock += 30_000;
    await write("after the wait");
    assert.equal(await fsp.readFile(doc, "utf8"), "after the wait");
  });

  // Exclusive creation on volumes without hard links (exFAT, some shares).
  for (const code of ["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV", "ENOSYS", "EISDIR"]) {
    test(`a new exclusive file is created without a hard link (${code})`, async (t) => {
      const f = await sandbox(t);
      const target = path.join(f.root, "figure.png");
      const link = fsp.link;
      t.mock.method(fsp, "link", (from, to) => to === target
        ? Promise.reject(Object.assign(new Error("no hard links here"), { code }))
        : link.call(fsp, from, to));
      await writeProjectFile(target, Buffer.from("PNG bytes"), { exclusive: true, directory: () => f.locks });
      assert.equal(await fsp.readFile(target, "utf8"), "PNG bytes");
      assert.deepEqual(await leftovers(f.root), []);
      await assert.rejects(writeProjectFile(target, "again", { exclusive: true, directory: () => f.locks }), { code: "EEXIST" });
      assert.equal(await fsp.readFile(target, "utf8"), "PNG bytes");
    });
  }

  test("without hard links an exclusive create keeps a concurrent creator's file and removes only its own partial file", async (t) => {
    const f = await sandbox(t);
    const target = path.join(f.root, "figure.png");
    const link = fsp.link;
    let racer = true;
    t.mock.method(fsp, "link", async (from, to) => {
      if (to !== target) return link.call(fsp, from, to);
      if (racer) await fsp.writeFile(target, "another creator");
      throw Object.assign(new Error("no hard links here"), { code: "ENOTSUP" });
    });
    await assert.rejects(writeProjectFile(target, "ours", { exclusive: true, directory: () => f.locks }), { code: "EEXIST" });
    assert.equal(await fsp.readFile(target, "utf8"), "another creator");
    await fsp.unlink(target);
    racer = false;
    const open = fsp.open;
    let failWrite = true;
    t.mock.method(fsp, "open", async (filename, flags, ...args) => {
      const handle = await open(filename, flags, ...args);
      if (filename === target && flags === "wx" && failWrite) {
        failWrite = false;
        const writeFile = handle.writeFile.bind(handle);
        handle.writeFile = async (bytes) => {
          await writeFile(Buffer.from(bytes).subarray(0, 2));
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        };
      }
      return handle;
    });
    await assert.rejects(writeProjectFile(target, "complete image", { exclusive: true, directory: () => f.locks }), { code: "ENOSPC" });
    await assert.rejects(fsp.stat(target), { code: "ENOENT" });
    assert.deepEqual(await leftovers(f.root), []);
    await writeProjectFile(target, "complete image", { exclusive: true, directory: () => f.locks });
    assert.equal(await fsp.readFile(target, "utf8"), "complete image");
  });

  test("a pasted image is saved into a project on a volume without hard links", async (t) => {
    const f = await sandbox(t);
    const link = fsp.link;
    t.mock.method(fsp, "link", (from, to) => to.startsWith(f.root + path.sep)
      ? Promise.reject(Object.assign(new Error("no hard links here"), { code: "ENOTSUP" }))
      : link.call(fsp, from, to));
    const replies = [];
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await fileHandlers(f.workspace, replies).handleImportAttachment("paste", { name: "figure.png", data: bytes.toString("base64") });
    const result = replies.find(({ type }) => type === "file:importAttachmentResult");
    assert.equal(result?.ok, true, JSON.stringify(result));
    assert.deepEqual(await fsp.readFile(path.join(f.root, result.path)), bytes);
    assert.deepEqual(await leftovers(path.join(f.root, path.dirname(result.path))), []);
  });
}
