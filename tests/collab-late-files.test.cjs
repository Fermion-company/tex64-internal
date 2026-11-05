"use strict";
// A guest opens the project as soon as the text is in; files (figures) keep
// arriving afterwards. Two hubs in one process, joined over a real ws socket;
// the host's file sending is held back to make "afterwards" deterministic.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CollabHub } = require("../electron/services/collab/hub.cjs");

const waitFor = async (predicate, timeoutMs = 8000, label = "condition") => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Holds the host's file sending until release().
const holdFiles = (host) => {
  const send = host.sendBlob.bind(host);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  host.sendBlob = async (...args) => {
    await gate;
    return send(...args);
  };
  return () => {
    host.sendBlob = send;
    release();
  };
};

const setup = (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-late-"));
  const hostRoot = path.join(base, "paper");
  fs.mkdirSync(hostRoot);
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  const hubs = [];
  t.after(async () => {
    await Promise.allSettled(hubs.map((hub) => hub.leave()));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const hub = (name, rootRef, messages) => {
    const created = makeHub(rootRef, { collabRoot: path.join(base, `${name}-collab`), name, messages });
    hubs.push(created);
    return created;
  };
  return { hostRoot, hub };
};

test("a guest opens on the text; the figure arrives afterwards and is counted until then", async (t) => {
  const { hostRoot, hub } = setup(t);
  const figure = crypto.randomBytes(1024 * 1024);
  fs.writeFileSync(path.join(hostRoot, "fig.png"), figure);
  const host = hub("Host", { path: hostRoot });
  const guestRoot = { path: null };
  const guest = hub("Guest", guestRoot);
  const started = await host.start({ name: "Host" });
  const release = holdFiles(host);

  const joined = await guest.join({ link: started.inviteLink, name: "Guest" });
  assert.equal(joined.active, true, "the join completes with the figure still on its way");
  assert.equal(fs.readFileSync(path.join(guestRoot.path, "main.tex"), "utf8"), "Hello\n");
  assert.equal(fs.existsSync(path.join(guestRoot.path, "fig.png")), false);
  assert.deepEqual(guest.status().incoming, { files: 1, bytes: figure.length });

  release();
  await waitFor(() => fs.existsSync(path.join(guestRoot.path, "fig.png")) && fs.readFileSync(path.join(guestRoot.path, "fig.png")).equals(figure), 8000, "late figure");
  await waitFor(() => guest.status().incoming.files === 0, 4000, "nothing left to receive");
});

test("a rejoin keeps an old figure edited after leaving, and does not send it to the host while the host's arrives", async (t) => {
  const { hostRoot, hub } = setup(t);
  const hostFigure = path.join(hostRoot, "fig.png");
  fs.writeFileSync(hostFigure, Buffer.from("version one"));
  const host = hub("Host", { path: hostRoot });
  const guestMessages = [];
  const guestRoot = { path: null };
  const guest = hub("Guest", guestRoot, guestMessages);
  const started = await host.start({ name: "Host" });

  await guest.join({ link: started.inviteLink, name: "Guest" });
  const mirrorFigure = path.join(guestRoot.path, "fig.png");
  await waitFor(() => fs.existsSync(mirrorFigure) && fs.readFileSync(mirrorFigure, "utf8") === "version one", 8000, "first figure");
  await guest.leave();

  // Meanwhile: the guest scribbles on its copy, the host makes version two.
  // File sending is held from here on, so the host's own broadcast of
  // version two cannot reach the guest before the hold either.
  const release = holdFiles(host);
  fs.writeFileSync(mirrorFigure, Buffer.from("edited here after leaving"));
  fs.writeFileSync(hostFigure, Buffer.from("version two"));
  await host.rescan();

  await guest.join({ link: started.inviteLink, name: "Guest" });
  assert.equal(fs.readFileSync(mirrorFigure, "utf8"), "edited here after leaving", "the old copy stays until the host's arrives");
  assert.equal(guest.status().incoming.files, 1);
  // The guest edits the old copy again while the host's is on its way; the
  // scan sees a changed file, but it is the old copy of one still coming.
  fs.writeFileSync(mirrorFigure, Buffer.from("edited again while waiting"));
  await guest.rescan();
  await sleep(300);
  assert.equal(fs.readFileSync(hostFigure, "utf8"), "version two", "the old copy did not reach the host");

  release();
  await waitFor(() => fs.readFileSync(mirrorFigure, "utf8") === "version two", 8000, "host's figure");
  const kept = fs.readdirSync(path.dirname(mirrorFigure)).filter((name) => /^fig\.local-.*\.png$/.test(name));
  assert.equal(kept.length, 1, "the edited copy is kept beside it");
  assert.equal(fs.readFileSync(path.join(path.dirname(mirrorFigure), kept[0]), "utf8"), "edited again while waiting");
  assert.ok(guestMessages.some((m) => m.type === "collab:notice" && /kept as/.test(m.message)), "the guest is told");
  await sleep(300);
  assert.equal(fs.readFileSync(hostFigure, "utf8"), "version two");
});
