"use strict";
// A shared file that an outside editor changed where a peer is typing is
// never parked: the outside version is kept beside it, the shared document
// keeps the name, and leave, a project switch and Quit all complete. Quit
// drains the shared documents (a peer's edit to a file never opened here
// included) before the editor freezes, holding peer edits from then on.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const { CollabHub } = require("../electron/services/collab/hub.cjs");

const waitFor = async (predicate, timeoutMs = 8000, label = "condition") => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const makeHub = (rootRef, { collabRoot, name, messages = [] }) => new CollabHub({
  workspace: {
    getRootPath: () => rootRef.path,
    rootInfo: async () => ({ path: "main.tex" }),
    withFileMutation: (_relative, operation) => operation(),
  },
  state: {},
  sendCollab: (message) => messages.push(message),
  withWorkspaceMutation: (operation) => operation(),
  trackSaved: () => {},
  openWorkspacePath: async (root) => { rootRef.path = root; },
  refreshTree: () => {},
  recordVersion: async () => {},
  locale: () => "en",
  userName: () => name,
  collabRoot: () => collabRoot,
});

const NOTES = "Line one.\nValue: 10.\n";
const OUTSIDE = "Line one. outside\nValue: 20.\n";

// Host and guest over a real socket. The guest types at the end of line one
// of notes.tex (a file the host's editor never opened); before the host
// writes that, an outside editor changes the same spot and another line.
const overlapSession = async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-overlap-"));
  const hostRoot = path.join(base, "paper");
  fs.mkdirSync(hostRoot);
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  fs.writeFileSync(path.join(hostRoot, "notes.tex"), NOTES);
  const hostMessages = [];
  const host = makeHub({ path: hostRoot }, { collabRoot: path.join(base, "host-collab"), name: "Host", messages: hostMessages });
  const guestRoot = { path: null };
  const guest = makeHub(guestRoot, { collabRoot: path.join(base, "guest-collab"), name: "Guest" });
  t.after(async () => {
    await Promise.allSettled([host.leave(), guest.leave()]);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const started = await host.start({ name: "Host" });
  await guest.join({ link: started.inviteLink, name: "Guest" });
  const hostText = () => host.session.docs.get("notes.tex").ytext.toString();
  const guestType = async (offset, typed) => {
    const before = hostText();
    guest.session.docs.get("notes.tex").ytext.insert(offset, typed);
    return before;
  };
  // The host's timed writes wait, so the outside save lands first.
  host.session.diskSync.paused = true;
  await guestType("Line one.".length, " typed");
  await waitFor(() => hostText() === "Line one. typed\nValue: 10.\n", 4000, "the guest's typing at the host");
  const file = path.join(hostRoot, "notes.tex");
  fs.writeFileSync(file, OUTSIDE);
  const kept = () => fs.readdirSync(hostRoot).filter((name) => /^notes\.local-[\d-]+T[\d-]+\.tex$/.test(name));
  return { host, guest, hostRoot, file, kept, hostText, guestType, hostMessages };
};

const assertResolved = ({ file, kept, hostRoot }) => {
  assert.equal(fs.readFileSync(file, "utf8"), "Line one. typed\nValue: 20.\n", "the document keeps the name, with the clean outside hunk");
  assert.equal(kept().length, 1);
  assert.equal(fs.readFileSync(path.join(hostRoot, kept()[0]), "utf8"), OUTSIDE, "the outside version is kept as it was");
};

test("leave completes after an overlap, keeping both versions", async (t) => {
  const session = await overlapSession(t);
  // A watcher event for the outside save first: still not parked.
  assert.equal(session.host.ingestDisk("notes.tex"), true);
  await waitFor(() => session.kept().length === 1, 4000, "the kept copy");
  // Later typing by the peer still reaches the disk.
  await session.guestType(0, "% ");
  await waitFor(() => session.hostText().startsWith("% "), 4000, "more typing");
  assert.equal(await session.host.flush(), true);
  assert.equal(fs.readFileSync(session.file, "utf8"), "% Line one. typed\nValue: 20.\n");
  assert.equal(session.kept().length, 1);
  assert.deepEqual(await session.host.leave(), { ok: true });
  assert.equal(session.host.isActive(), false);
  assert.ok(session.hostMessages.some((m) => m.type === "collab:notice" && /conflicted with an external change/.test(m.message)));
});

test("a project switch (lease held) completes after an overlap", async (t) => {
  const session = await overlapSession(t);
  assert.deepEqual(await session.host.leave({ leaseHeld: true }), { ok: true });
  assertResolved(session);
});

test("Quit drains a peer's edit to a file never opened here, and holds edits that arrive during the drain", async (t) => {
  const session = await overlapSession(t);
  const { host } = session;
  // Another peer edit lands while the drain is writing: held, not applied.
  const sync = host.session.diskSync;
  const writeDisk = sync.writeDisk.bind(sync);
  let typedDuring = false;
  sync.writeDisk = async (...args) => {
    if (!typedDuring) {
      typedDuring = true;
      await session.guestType(0, "late ");
      await waitFor(() => host.session.heldFrames?.length > 0, 4000, "a held frame");
    }
    return writeDisk(...args);
  };
  assert.equal(await host.drain(), true);
  assertResolved(session);
  assert.equal(session.hostText(), "Line one. typed\nValue: 20.\n", "nothing was applied after the last write");
  assert.equal(sync.isDirty("notes.tex"), false);

  // A quit that does not go ahead takes the held edits in, and writes them.
  host.resumeIntake();
  assert.equal(session.hostText(), "late Line one. typed\nValue: 20.\n");
  assert.equal(await host.flush(), true);
  assert.equal(fs.readFileSync(session.file, "utf8"), "late Line one. typed\nValue: 20.\n");
});

test("a drain whose copy cannot be written fails and takes peer edits again", async (t) => {
  const session = await overlapSession(t);
  const { host, hostRoot } = session;
  fs.chmodSync(hostRoot, 0o555);
  t.after(() => { try { fs.chmodSync(hostRoot, 0o755); } catch {} });
  assert.equal(await host.drain(), false);
  assert.equal(host.session.heldFrames, null);
  assert.equal(fs.readFileSync(session.file, "utf8"), OUTSIDE);
  await session.guestType(0, "% ");
  await waitFor(() => session.hostText().startsWith("% "), 4000, "typing after a failed drain");
  await assert.rejects(host.leave(), { code: "COLLAB_FLUSH_FAILED" });
  fs.chmodSync(hostRoot, 0o755);
  assert.equal(await host.drain(), true);
  assert.equal(fs.readFileSync(session.file, "utf8"), "% Line one. typed\nValue: 20.\n");
  assert.equal(session.kept().length, 1);
});

// quit-preparation.ts: the renderer's side of Quit and Close.
const { prepareRendererForQuit } = (() => {
  const source = fs.readFileSync(path.join(__dirname, "../web-src/app/quit-preparation.ts"), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  new Function("module", "exports", output)(module, module.exports);
  return module.exports;
})();

test("with no dirty buffer, the renderer drains the shared documents before it freezes; a failed drain cancels", async () => {
  const run = async ({ drains, dirtyAfterDrain = [] }) => {
    const events = [];
    let dirty = 0;
    const result = await prepareRendererForQuit({
      quiesce: async () => ({ ok: true }),
      getDirtyFileCount: () => dirty,
      saveDirtyFiles: async () => { events.push("save"); dirty = 0; return true; },
      drainShared: async () => {
        events.push("drain");
        dirty = dirtyAfterDrain.shift() ?? 0;
        return drains.shift();
      },
      freeze: () => events.push("freeze"),
    });
    return { result, events };
  };
  assert.deepEqual(await run({ drains: [true] }), { result: { ok: true }, events: ["drain", "freeze"] });
  // (no message of its own: the existing "could not save, quit was canceled")
  assert.deepEqual(await run({ drains: [false] }), { result: { ok: false, phase: "save" }, events: ["drain"] });
  // An edit typed during the drain is saved, and the drain runs again.
  assert.deepEqual(await run({ drains: [true, true], dirtyAfterDrain: [1] }),
    { result: { ok: true }, events: ["drain", "save", "drain", "freeze"] });
});
