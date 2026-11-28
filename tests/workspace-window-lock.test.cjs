"use strict";
// One folder per TeX64 process, checked with real separate processes: each
// child runs electron/services/workspace-window-lock.cjs against one shared
// lock directory, as File > New Window processes share userData.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork, spawn } = require("node:child_process");
const { WorkspaceWindowLock, canonicalRoot, processStartTime } = require("../electron/services/workspace-window-lock.cjs");

const LOCK_MODULE = path.join(__dirname, "../electron/services/workspace-window-lock.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-lock-"));
const lockDir = path.join(tmp, "open-workspaces");
const child = path.join(tmp, "lock-child.cjs");
fs.writeFileSync(
  child,
  `"use strict";
const { WorkspaceWindowLock } = require(${JSON.stringify(LOCK_MODULE)});
const fs = require("node:fs");
const [dir, heartbeatMs, unsupportedLinks] = process.argv.slice(2);
const write = fs.writeFileSync;
if (unsupportedLinks) {
  fs.linkSync = () => { throw Object.assign(new Error("no hard links"), { code: "ENOTSUP" }); };
  fs.writeFileSync = (file, bytes, options) => {
    if (unsupportedLinks === "exclusive-denied" && options?.flag === "wx") {
      throw Object.assign(new Error("exclusive create denied"), { code: "EACCES" });
    }
    write(file, bytes, options);
  };
}
let lost = 0;
const lock = new WorkspaceWindowLock({ directory: () => dir, heartbeatMs: Number(heartbeatMs), onLost: () => { lost += 1; } });
process.on("message", (m) => {
  if (m.at) while (Date.now() < m.at) {} // all children claim in the same millisecond
  const value =
    m.cmd === "claim" ? lock.claim(m.root)
    : m.cmd === "writes" ? (lock.permitsWrites?.(m.root) ?? lock.owns(m.root))
    : m.cmd === "owns" ? lock.owns(m.root)
    : m.cmd === "lost" ? lost
    : m.cmd === "files" ? [...lock.held.values()].map((c) => c.file)
    : null;
  process.send({ id: m.id, value });
});
process.send({ ready: true });
`
);
fs.mkdirSync(lockDir, { recursive: true });

const children = new Set();
test.after(() => {
  for (const proc of children) {
    try { proc.kill("SIGCONT"); } catch {}
    try { proc.kill("SIGKILL"); } catch {}
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

let nextId = 0;
const start = (heartbeatMs = 10_000, directory = lockDir, storageMode = "") =>
  new Promise((resolve, reject) => {
    const proc = fork(child, [directory, String(heartbeatMs), storageMode], {
      env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    children.add(proc);
    proc.once("error", reject);
    proc.once("message", () => {
      const ask = (cmd, extra = {}) =>
        new Promise((done) => {
          const id = ++nextId;
          const onMessage = (m) => {
            if (m.id !== id) return;
            proc.off("message", onMessage);
            done(m.value);
          };
          proc.on("message", onMessage);
          proc.send({ id, cmd, ...extra });
        });
      resolve({ proc, pid: proc.pid, ask });
    });
  });
const stop = (proc) =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    proc.kill("SIGKILL");
  });
const folder = (name) => {
  const dir = path.join(tmp, "projects", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const age = (files, seconds) => {
  const time = (Date.now() - seconds * 1000) / 1000;
  for (const file of files) fs.utimesSync(file, time, time);
};
const recordFile = (root, gen) =>
  path.join(lockDir, `${new WorkspaceWindowLock({ directory: () => lockDir }).baseFor(canonicalRoot(root))}.${gen}.json`);

test("an owner whose heartbeat went quiet (suspended 120 s) keeps the folder", async () => {
  const root = folder("suspended");
  const first = await start(200);
  assert.equal(await first.ask("claim", { root }), true);
  const files = await first.ask("files");
  const suspend = process.platform !== "win32";
  if (suspend) first.proc.kill("SIGSTOP");
  try {
    age(files, 120);
    const second = await start();
    assert.equal(await second.ask("claim", { root }), false);
    await stop(second.proc);
  } finally {
    if (suspend) first.proc.kill("SIGCONT");
  }
  // Resumed, it still owns the folder and renews its claim.
  assert.equal(await first.ask("owns", { root }), true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(Date.now() - fs.statSync(files[0]).mtimeMs < 5_000);
  assert.equal(await first.ask("lost"), 0);
  await stop(first.proc);
});

test("the audit's case: heartbeat aged 91 s, a second process is refused and the first still owns", async () => {
  const root = folder("aged91");
  const first = await start();
  assert.equal(await first.ask("claim", { root }), true);
  age(await first.ask("files"), 91);
  const second = await start();
  assert.equal(await second.ask("claim", { root }), false);
  assert.equal(await first.ask("owns", { root }), true);
  await stop(second.proc);
  await stop(first.proc);
});

test("a killed owner releases the folder at once", async () => {
  const root = folder("killed");
  const first = await start();
  assert.equal(await first.ask("claim", { root }), true);
  await stop(first.proc);
  const second = await start();
  assert.equal(await second.ask("claim", { root }), true);
  await stop(second.proc);
});

test("a claim whose pid now belongs to another program is free; the same process keeps it", async () => {
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.add(other);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const actualStart = processStartTime(other.pid);
  assert.ok(Number.isFinite(actualStart), "the OS reports a start time");
  const write = (root, startedAt) => {
    const file = recordFile(root, 1);
    fs.writeFileSync(file, JSON.stringify({ pid: other.pid, token: "earlier-owner", startedAt }));
    age([file], 120);
  };
  // The pid is alive but started an hour after the owner did: reused.
  const reused = folder("pid-reuse");
  write(reused, actualStart - 3_600_000);
  const claimant = await start();
  assert.equal(await claimant.ask("claim", { root: reused }), true);
  // Same pid, same start: the owner itself, only quiet.
  const quiet = folder("pid-same");
  write(quiet, actualStart);
  assert.equal(await claimant.ask("claim", { root: quiet }), false);
  await stop(claimant.proc);
  await stop(other);
});

test("processes claiming one folder at the same moment: exactly one wins, also when replacing a dead owner", async () => {
  const racers = await Promise.all(Array.from({ length: 6 }, () => start()));
  const dead = await start();
  const deadPid = dead.pid;
  await stop(dead.proc);
  for (let round = 0; round < 6; round++) {
    const root = folder(`race-${round}`);
    if (round % 2 === 1) {
      // Crash recovery: the newest claim is from a process that is gone.
      fs.writeFileSync(recordFile(root, 3), JSON.stringify({ pid: deadPid, token: "crashed", startedAt: 1 }));
    }
    const at = Date.now() + 150;
    const results = await Promise.all(racers.map((racer) => racer.ask("claim", { root, at })));
    assert.equal(results.filter(Boolean).length, 1, `round ${round}: ${results}`);
    // One claim file is left for the folder, and it names the winner.
    const base = path.basename(recordFile(root, 0)).replace(/\.0\.json$/, "");
    const claims = fs.readdirSync(lockDir).filter((name) => name.startsWith(`${base}.`));
    assert.equal(claims.length, 1, `round ${round}: ${claims}`);
    const winner = racers[results.indexOf(true)];
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir, claims[0]), "utf8")).pid, winner.pid);
    assert.equal(await winner.ask("owns", { root }), true);
  }
  await Promise.all(racers.map((racer) => stop(racer.proc)));
});

test("nested folders stay as they are: a parent and a subfolder open in two processes", async () => {
  const parent = folder("nest");
  const sub = folder(path.join("nest", "chapter"));
  const first = await start();
  const second = await start();
  assert.equal(await first.ask("claim", { root: parent }), true);
  assert.equal(await second.ask("claim", { root: sub }), true);
  await stop(first.proc);
  await stop(second.proc);
});

test("an owner checks its claim before use: removed from outside it claims again, taken by a live process it is lost", async () => {
  const root = folder("verify");
  const first = await start(100);
  assert.equal(await first.ask("claim", { root }), true);
  // The claim file disappears (userData cleaned), nobody else wants it.
  for (const file of fs.readdirSync(lockDir)) fs.rmSync(path.join(lockDir, file), { force: true });
  assert.equal(await first.ask("owns", { root }), true);
  assert.equal(fs.readdirSync(lockDir).length, 1);
  // Removed again and claimed by another live process before the owner looks.
  for (const file of fs.readdirSync(lockDir)) fs.rmSync(path.join(lockDir, file), { force: true });
  const second = await start();
  assert.equal(await second.ask("claim", { root }), true);
  assert.equal(await first.ask("owns", { root }), false);
  await new Promise((resolve) => setTimeout(resolve, 400)); // heartbeats do not take it back
  assert.equal(await first.ask("owns", { root }), false);
  assert.equal(await first.ask("lost"), 1);
  assert.equal(await second.ask("owns", { root }), true);
  await stop(first.proc);
  await stop(second.proc);
});

test("read-only app data uses a shared fallback and keeps that owner visible after recovery", {
  skip: process.platform === "win32" || process.getuid() === 0,
}, async () => {
  const root = folder("unavailable");
  const readOnly = path.join(tmp, "read-only-locks");
  fs.mkdirSync(readOnly, { mode: 0o500 });
  const first = await start(10_000, readOnly);
  const contender = await start(10_000, readOnly);
  try {
    assert.equal(await first.ask("claim", { root }), true);
    assert.equal(await first.ask("writes", { root }), true);
    assert.equal(await contender.ask("claim", { root }), false);
    fs.chmodSync(readOnly, 0o700);
    assert.equal(await contender.ask("claim", { root }), false);
    assert.equal(await contender.ask("writes", { root }), false);
  } finally {
    fs.chmodSync(readOnly, 0o700);
    await Promise.all([stop(first.proc), stop(contender.proc)]);
  }
});

test("when neither folder lock can be created, opening and existing History requests remain available", async () => {
  const root = folder("fallback-unavailable");
  const child = await start(10_000, lockDir, "exclusive-denied");
  try {
    assert.equal(await child.ask("claim", { root }), true);
    assert.equal(await child.ask("writes", { root }), true);
    assert.equal(await child.ask("owns", { root }), false);
  } finally {
    await stop(child.proc);
  }
});

test("a folder keeps a verified claim when its primary directory is removed at runtime", async () => {
  const root = folder("verification-unavailable");
  const dir = path.join(tmp, "temporarily-unavailable");
  const moved = `${dir}-moved`;
  const owner = await start(10_000, dir);
  try {
    assert.equal(await owner.ask("claim", { root }), true);
    fs.renameSync(dir, moved);
    assert.equal(await owner.ask("owns", { root }), true);
    assert.ok(fs.statSync(dir).isDirectory());
    assert.equal(await owner.ask("writes", { root }), true);
    assert.equal(await owner.ask("owns", { root }), true);
    assert.equal(await owner.ask("lost"), 0);
  } finally {
    await stop(owner.proc);
  }
});

test("an incomplete exclusive-create claim is indeterminate until the owner record is complete", async () => {
  const root = folder("exclusive-create");
  const first = await start(10_000, lockDir, "no-hard-links");
  const contender = await start(10_000, lockDir, "no-hard-links");
  try {
    assert.equal(await first.ask("claim", { root }), true);
    const [claim] = await first.ask("files");
    const record = fs.readFileSync(claim);
    fs.writeFileSync(claim, "");
    try {
      assert.equal(await first.ask("owns", { root }), false);
      assert.equal(await contender.ask("claim", { root }), true);
      assert.equal(await contender.ask("owns", { root }), false);
      assert.deepEqual(await contender.ask("files"), []);
    } finally {
      fs.writeFileSync(claim, record);
    }
    assert.equal(await first.ask("owns", { root }), true);
    assert.equal(await contender.ask("claim", { root }), false);
  } finally {
    await Promise.all([stop(first.proc), stop(contender.proc)]);
  }
});

test("a second process cannot claim a folder through a symlink or case alias", async () => {
  const root = folder("canonical-name");
  const link = path.join(path.dirname(root), "linked-name");
  fs.symlinkSync(root, link, "dir");
  const first = await start();
  const second = await start();
  try {
    assert.equal(await first.ask("claim", { root }), true);
    assert.equal(await second.ask("claim", { root: link }), false);
    const caseAlias = path.join(path.dirname(root), "Canonical-Name");
    if (fs.existsSync(caseAlias)) assert.equal(await second.ask("claim", { root: caseAlias }), false);
  } finally {
    await Promise.all([stop(first.proc), stop(second.proc)]);
  }
});
