"use strict";
// Audit fixes for collaboration: what a peer may name, merging disk edits,
// leaving while a project switch holds the lease, and offline edits on rejoin.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Y = require("yjs");
const { CollabHub } = require("../electron/services/collab/hub.cjs");
const transport = require("../electron/services/collab/transport-ws.cjs");
const invite = require("../electron/services/collab/invite.cjs");
const { safeRelativePath } = require("../electron/services/collab/manifest.cjs");
const { mergeThreeWay, DiskSync } = require("../electron/services/collab/disk-sync.cjs");
const { createCollabHandlers } = require("../electron/handlers/collab.cjs");

const waitFor = async (predicate, timeoutMs = 8000, label = "condition") => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const makeHub = (rootRef, { collabRoot, name, messages = [], lease } = {}) => new CollabHub({
  workspace: {
    getRootPath: () => rootRef.path,
    rootInfo: async () => ({ path: "main.tex" }),
    withFileMutation: (_relative, operation) => operation(),
  },
  state: {},
  sendCollab: (message) => messages.push(message),
  withWorkspaceMutation: (operation) => (lease ? lease(operation) : operation()),
  trackSaved: () => {},
  openWorkspacePath: async (root) => { rootRef.path = root; },
  refreshTree: () => {},
  recordVersion: async () => {},
  locale: () => "en",
  userName: () => name,
  collabRoot: () => collabRoot,
});

const tempBase = (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-collab-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
};

test("excluded folders are excluded in any letter case", () => {
  for (const name of [".GIT/config", ".Git/HEAD", "a/.TeX64/settings.json", "NODE_MODULES/x.js", "DerivedData/y"]) {
    assert.equal(safeRelativePath(name), null, name);
  }
  assert.equal(safeRelativePath("sections/Intro.tex"), "sections/Intro.tex");
});

test("disk edits next to unsaved edits merge; an append at the end merges", () => {
  const merge = (baseline, current, disk) => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, current);
    const dropped = mergeThreeWay(text, baseline, current, disk, "disk");
    return { text: text.toString(), dropped };
  };
  assert.deepEqual(merge("a\nb\nc", "A\nb\nc", "a\nB\nc"), { text: "A\nB\nc", dropped: 0 });
  assert.deepEqual(merge("a\nb\nc", "A\nb\nc", "a\nb\nc\nd"), { text: "A\nb\nc\nd", dropped: 0 });
  assert.deepEqual(merge("a\nb\n", "A\nb\n", "a\nb\nc\n"), { text: "A\nb\nc\n", dropped: 0 });
  assert.deepEqual(merge("a\nb\nc", "a\nB\nc", "a\nnew\nb\nc"), { text: "a\nnew\nB\nc", dropped: 0 });
  // Real conflicts still keep the shared side.
  assert.deepEqual(merge("a\nb\nc", "A\nb\nc", "X\nb\nc"), { text: "A\nb\nc", dropped: 1 });
  assert.deepEqual(merge("a\nb", "a\nmine\nb", "a\ntheirs\nb"), { text: "a\nmine\nb", dropped: 1 });
});

test("a welcome whose session id would leave the collab folder is refused", async (t) => {
  const base = tempBase(t);
  const token = invite.createToken();
  const host = new transport.HostTransport({ token });
  const port = await host.start();
  t.after(() => host.close());
  host.on("open", (conn) => {
    host.send(conn, transport.encodeControl({ type: "welcome", sessionId: "/../../", name: "x", epoch: 1, peers: [] }));
  });
  const guest = makeHub({ path: null }, { collabRoot: path.join(base, "collab"), name: "Guest" });
  const link = invite.buildInviteLink({ hosts: ["127.0.0.1"], port, token, name: "paper" });
  await assert.rejects(guest.join({ link, name: "Guest" }), (error) => error.code === "COLLAB_REFUSED");
  assert.deepEqual(fs.readdirSync(base).filter((name) => name !== "collab"), []);
  assert.equal(guest.session, null);
});

test("a guest gets only the binaries the session shares, never .GIT or unshared files", async (t) => {
  const base = tempBase(t);
  const hostRoot = path.join(base, "paper");
  fs.mkdirSync(path.join(hostRoot, ".git"), { recursive: true });
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  fs.writeFileSync(path.join(hostRoot, ".git", "config"), "[core] secret\n");
  fs.writeFileSync(path.join(hostRoot, "fig.png"), Buffer.from([9, 9, 9]));
  const host = makeHub({ path: hostRoot }, { collabRoot: path.join(base, "host-collab"), name: "Host" });
  const viewerRoot = { path: null };
  const viewer = makeHub(viewerRoot, { collabRoot: path.join(base, "viewer-collab"), name: "Viewer" });
  t.after(async () => { await Promise.allSettled([viewer.leave(), host.leave()]); });
  const started = await host.start({ name: "Host" });
  await viewer.join({ link: started.viewInviteLink, name: "Viewer" });
  const received = [];
  viewer.session.transport.on("message", (_conn, frame) => { if (frame.kind === transport.FRAME_BLOB) received.push(frame.path); });
  viewer.session.transport.broadcast(transport.encodeControl({ type: "need-blob", paths: [".GIT/config", ".git/config", "main.tex", "fig.png"] }));
  await sleep(600);
  assert.deepEqual(received, ["fig.png"]);
});

test("leaving while a project switch holds the lease writes the shared edits without waiting", async (t) => {
  const base = tempBase(t);
  const hostRoot = path.join(base, "paper");
  fs.mkdirSync(hostRoot);
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  let leaseHeld = false;
  // The lease never frees while "held": a write that waits for it hangs.
  const lease = (operation) => (leaseHeld ? new Promise(() => {}) : operation());
  const host = makeHub({ path: hostRoot }, { collabRoot: path.join(base, "c"), name: "Host", lease });
  await host.start({ name: "Host" });
  host.session.docs.get("main.tex").ytext.insert(5, " world");
  leaseHeld = true;
  const started = Date.now();
  await host.leave({ leaseHeld: true });
  assert.ok(Date.now() - started < 5000, "did not wait for the lease");
  assert.equal(fs.readFileSync(path.join(hostRoot, "main.tex"), "utf8"), "Hello world\n");
  assert.equal(host.session, null);
});

test("when the shared files cannot be written, leaving fails and the session stays", async (t) => {
  const base = tempBase(t);
  const hostRoot = path.join(base, "paper");
  fs.mkdirSync(hostRoot);
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  const host = makeHub({ path: hostRoot }, { collabRoot: path.join(base, "c"), name: "Host" });
  await host.start({ name: "Host" });
  t.after(async () => { host.session.diskSync.flush = async () => true; await host.leave(); });
  host.session.diskSync.flush = async () => false;
  await assert.rejects(host.leave(), (error) => error.code === "COLLAB_FLUSH_FAILED");
  assert.equal(host.isActive(), true);
});

test("a file edited offline and deleted by the host meanwhile is kept aside on rejoin", async (t) => {
  const base = tempBase(t);
  const hostRoot = path.join(base, "paper");
  fs.mkdirSync(hostRoot);
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  fs.writeFileSync(path.join(hostRoot, "notes.tex"), "notes\n");
  const host = makeHub({ path: hostRoot }, { collabRoot: path.join(base, "host-collab"), name: "Host" });
  const guestRoot = { path: null };
  const guestCollab = path.join(base, "guest-collab");
  let guest = makeHub(guestRoot, { collabRoot: guestCollab, name: "Guest" });
  t.after(async () => { await Promise.allSettled([guest.leave(), host.leave()]); });
  const started = await host.start({ name: "Host" });
  await guest.join({ link: started.inviteLink, name: "Guest" });
  const mirrorNotes = path.join(guestRoot.path, "notes.tex");
  await waitFor(() => fs.existsSync(mirrorNotes), 8000, "mirror notes");
  await guest.leave();
  // Offline: the guest edits notes.tex; the host deletes it.
  fs.writeFileSync(mirrorNotes, "notes edited offline\n");
  fs.rmSync(path.join(hostRoot, "notes.tex"));
  await host.rescan();
  guest = makeHub(guestRoot, { collabRoot: guestCollab, name: "Guest" });
  await guest.join({ link: started.inviteLink, name: "Guest" });
  await waitFor(() => !fs.existsSync(mirrorNotes), 8000, "tombstone applied");
  const kept = fs.readdirSync(guestRoot.path).filter((name) => /^notes\.local-.*\.tex$/.test(name));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(guestRoot.path, kept[0]), "utf8"), "notes edited offline\n");
});

test("a comment save is written to the project it was made in, even after a switch", async (t) => {
  const base = tempBase(t);
  const a = path.join(base, "a");
  const b = path.join(base, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  let root = a;
  let handler = null;
  const ipcMain = { handle: (_name, fn) => { handler = fn; }, on: () => {} };
  const state = { mainWindow: { webContents: {} } };
  state.mainWindow.webContents.mainFrame = {};
  createCollabHandlers({ ipcMain, hub: { isActive: () => false, session: null }, state, workspace: { getRootPath: () => root }, sendCollab: () => {}, getLocale: () => "en" });
  const event = { sender: state.mainWindow.webContents, senderFrame: state.mainWindow.webContents.mainFrame };
  assert.equal((await handler(event, "comments:load", {})).ok, true);
  root = b;
  const comment = { id: "c1", filePath: "main.tex", range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: "made in A" };
  assert.equal((await handler(event, "comments:save", { root: a, comments: [comment] })).ok, true);
  assert.match(fs.readFileSync(path.join(a, ".tex64", "comments.json"), "utf8"), /made in A/);
  assert.equal(fs.existsSync(path.join(b, ".tex64", "comments.json")), false);
  // A folder this app never loaded comments from is refused.
  const refused = await handler(event, "comments:save", { root: path.join(base, "other"), comments: [] });
  assert.equal(refused.code, "WORKSPACE_CHANGED");
});

test("leaving during a project switch writes even when a write is already queued behind the held lease", async (t) => {
  const base = tempBase(t);
  const hostRoot = path.join(base, "paper");
  fs.mkdirSync(hostRoot);
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  let leaseHeld = false;
  const lease = (operation) => (leaseHeld ? new Promise(() => {}) : operation());
  const host = makeHub({ path: hostRoot }, { collabRoot: path.join(base, "c"), name: "Host", lease });
  await host.start({ name: "Host" });
  leaseHeld = true;
  host.session.docs.get("main.tex").ytext.insert(5, " world");
  // The debounced write fires and waits for the lease the switch holds.
  await sleep(800);
  const started = Date.now();
  await host.leave({ leaseHeld: true });
  assert.ok(Date.now() - started < 5000, "did not wait for the queued write");
  assert.equal(fs.readFileSync(path.join(hostRoot, "main.tex"), "utf8"), "Hello world\n");
});

test("a shared path through a symlinked folder is never written, on either write path", async (t) => {
  const base = tempBase(t);
  const root = path.join(base, "paper");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "linked"));
  for (const held of [false, true]) {
    const sync = new DiskSync({
      rootPath: () => root,
      withWorkspaceMutation: (operation) => operation(),
      // A file guard that checks nothing: the disk layer must refuse by itself.
      withFileMutation: (_relative, operation) => operation(),
    });
    sync.coordinated = true;
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "planted\n");
    sync.attach("linked/outside.tex", text, null);
    if (held) await sync.flushHeld();
    else await sync.flush(3000);
    sync.stop();
    assert.equal(fs.existsSync(path.join(outside, "outside.tex")), false, held ? "flushHeld" : "flush");
  }
});

test("an offline-edited file that cannot be read is kept, not deleted, when the host removed it", async (t) => {
  const base = tempBase(t);
  const root = path.join(base, "mirror");
  fs.mkdirSync(root);
  const file = path.join(root, "notes.tex");
  fs.writeFileSync(file, "offline edit\n");
  fs.chmodSync(file, 0o000);
  t.after(() => { try { fs.chmodSync(file, 0o644); } catch {} });
  const hub = makeHub({ path: root }, { collabRoot: path.join(base, "c"), name: "Guest" });
  const session = { joining: true, rootPath: root, mirrorHashes: null, preserved: [] };
  assert.equal(await hub.preserveLocal(session, "notes.tex", null), false);
  assert.equal(await hub.preserveLocal(session, "missing.tex", null), true);
});

test("with the real workspace guard, a symlinked shared path is let go and leaving still succeeds", async (t) => {
  const { WorkspaceManager } = require("../electron/services/workspace.cjs");
  const base = tempBase(t);
  const root = path.join(base, "paper");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "linked"));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  for (const held of [false, true]) {
    const sync = new DiskSync({
      rootPath: () => root,
      withWorkspaceMutation: (operation) => operation(),
      withFileMutation: (relative, operation) => workspace.withFileMutation(relative, operation),
    });
    sync.coordinated = true;
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "planted\n");
    sync.attach("linked/outside.tex", text, null);
    const started = Date.now();
    const flushed = held ? await sync.flushHeld() : await sync.flush(3000);
    assert.equal(flushed, true, held ? "flushHeld" : "flush");
    assert.ok(Date.now() - started < 2500, "did not wait for the timeout");
    assert.equal(sync.has("linked/outside.tex"), false);
    assert.equal(fs.existsSync(path.join(outside, "outside.tex")), false);
    sync.stop();
  }
});
