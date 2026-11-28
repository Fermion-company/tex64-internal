"use strict";
// A refused folder switch gives back the folder it reserved: another window
// (a separate process sharing the lock directory) can open it at once, while
// the folder open here stays owned.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { WorkspaceWindowLock } = require("../electron/services/workspace-window-lock.cjs");
const { createFolderSwitchClaim } = require("../electron/services/folder-switch-claim.cjs");

const LOCK_MODULE = path.join(__dirname, "../electron/services/workspace-window-lock.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-switch-"));
const lockDir = path.join(tmp, "open-workspaces");
fs.mkdirSync(lockDir, { recursive: true });
const childScript = path.join(tmp, "window.cjs");
fs.writeFileSync(childScript, `"use strict";
const { WorkspaceWindowLock } = require(${JSON.stringify(LOCK_MODULE)});
const lock = new WorkspaceWindowLock({ directory: () => process.argv[2] });
process.on("message", (m) => process.send({ id: m.id, value: m.cmd === "claim" ? lock.claim(m.root) : lock.keepOnly(m.root) ?? null }));
process.send({ ready: true });
`);
const children = new Set();
test.after(() => {
  for (const proc of children) try { proc.kill("SIGKILL"); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});
const otherWindow = () => new Promise((resolve, reject) => {
  const proc = fork(childScript, [lockDir], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  children.add(proc);
  proc.once("error", reject);
  let nextId = 0;
  proc.once("message", () => resolve((cmd, root) => new Promise((done) => {
    const id = ++nextId;
    const listener = (m) => { if (m.id === id) { proc.off("message", listener); done(m.value); } };
    proc.on("message", listener);
    proc.send({ id, cmd, root });
  })));
});
const folder = (name) => {
  const dir = path.join(tmp, "projects", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// This window has A open; `switchTo` runs main's beforeChange and the writer
// leases project-handlers.cjs takes right after it, then the root change.
const thisWindow = () => {
  const lock = new WorkspaceWindowLock({ directory: () => lockDir });
  const state = { root: null };
  const claim = createFolderSwitchClaim({
    lock, currentRoot: () => state.root, takenError: () => new Error("This folder is already open in another TeX64 window."),
  });
  const setRoot = (root) => { state.root = root; lock.keepOnly(root); };
  const switchTo = async (to, { refuseChecks = false, refuseLease = null } = {}) => {
    await claim.reserve(to, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (refuseChecks) throw new Error("Some shared files could not be saved, so the session stays open. Try again.");
    });
    const releases = [];
    for (const root of new Set([state.root, to])) {
      if (!root) continue;
      releases.push(claim.leased(root, () => {
        if (root === refuseLease) throw Object.assign(new Error("Axiom is writing."), { code: "AGENT_WORKSPACE_BUSY" });
        return () => {};
      }));
    }
    setRoot(to);
    releases.forEach((release) => release());
  };
  return { lock, state, claim, setRoot, switchTo };
};

test("a switch refused in its checks or at its writer lease leaves the target free and A owned", async () => {
  const [a, b, c] = ["A", "B", "C"].map(folder);
  const here = thisWindow();
  assert.equal(here.lock.claim(a), true);
  here.setRoot(a);
  const other = await otherWindow();

  // Refused by a check (collab leave, quiescing, an Axiom conflict).
  await assert.rejects(here.switchTo(b, { refuseChecks: true }), /session stays open/);
  assert.equal(here.state.root, a);
  assert.equal(await other("claim", b), true, "another window opens B at once");
  assert.equal(here.lock.owns(a), true);
  assert.equal(await other("claim", a), false);

  // Refused when the writer lease of either folder is taken.
  for (const refused of [a, c]) {
    await assert.rejects(here.switchTo(c, { refuseLease: refused }), { code: "AGENT_WORKSPACE_BUSY" });
    assert.equal(here.state.root, a);
    assert.equal(here.lock.owns(a), true);
    assert.equal(await other("claim", c), true, "C is free after a refused lease");
    await other("keepOnly", b);
  }

  // A folder another window has open is refused before anything else.
  await assert.rejects(here.switchTo(b), /already open in another TeX64 window/);
  assert.equal(here.lock.owns(a), true);

  // A switch that goes ahead keeps only the new folder.
  await other("keepOnly", null);
  await here.switchTo(c);
  assert.equal(here.state.root, c);
  assert.equal(await other("claim", c), false);
  assert.equal(await other("claim", a), true);

  // The same folder again: a refusal keeps it owned.
  await assert.rejects(here.switchTo(c, { refuseChecks: true }));
  assert.equal(here.lock.owns(c), true);
  assert.equal(await other("claim", c), false);
});

test("leases taken outside a switch never release its reservation", async () => {
  const [a, d] = ["A2", "D"].map(folder);
  const here = thisWindow();
  here.lock.claim(a);
  here.setRoot(a);
  const other = await otherWindow();
  // A renderer save refused while the switch is still checking.
  let finishChecks;
  const switching = here.claim.reserve(d, () => new Promise((resolve) => { finishChecks = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.throws(() => here.claim.leased(a, () => { throw Object.assign(new Error("busy"), { code: "HISTORY_BUSY" }); }));
  assert.equal(await other("claim", d), false, "D stays reserved for the switch");
  finishChecks();
  await switching;
  here.claim.leased(a, () => () => {});
  here.claim.leased(d, () => () => {});
  here.setRoot(d);
  assert.equal(here.lock.owns(d), true);
  assert.equal(await other("claim", d), false);
});
