"use strict";
// View-only links: two hubs in one process, joined over a real ws socket.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Y = require("yjs");
const syncProtocol = require("y-protocols/sync");
const encoding = require("lib0/encoding");
const { CollabHub, SESSION_DOC } = require("../electron/services/collab/hub.cjs");
const transport = require("../electron/services/collab/transport-ws.cjs");

const waitFor = async (predicate, timeoutMs = 8000, label = "condition") => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const makeHub = (rootRef, { collabRoot, name, messages }) => new CollabHub({
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

const updateFrame = (docId, update) => {
  const encoder = encoding.createEncoder();
  syncProtocol.writeUpdate(encoder, update);
  return transport.encodeDocFrame(transport.FRAME_SYNC, docId, encoding.toUint8Array(encoder));
};

test("a view link reads along: the host drops its text, comment and file changes", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-view-"));
  const hostRoot = path.join(base, "paper");
  fs.mkdirSync(hostRoot);
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  fs.writeFileSync(path.join(hostRoot, "fig.png"), Buffer.from([1, 2, 3, 4]));
  const hostMessages = [];
  const viewerMessages = [];
  const editorMessages = [];
  const host = makeHub({ path: hostRoot }, { collabRoot: path.join(base, "host-collab"), name: "Host", messages: hostMessages });
  const viewerRoot = { path: null };
  const viewer = makeHub(viewerRoot, { collabRoot: path.join(base, "viewer-collab"), name: "Viewer", messages: viewerMessages });
  const editorRoot = { path: null };
  const editor = makeHub(editorRoot, { collabRoot: path.join(base, "editor-collab"), name: "Editor", messages: editorMessages });
  t.after(async () => {
    await Promise.allSettled([viewer.leave(), editor.leave(), host.leave()]);
    fs.rmSync(base, { recursive: true, force: true });
  });

  const started = await host.start({ name: "Host" });
  assert.ok(started.inviteLink && started.viewInviteLink);
  assert.notEqual(started.inviteLink, started.viewInviteLink);

  const joined = await viewer.join({ link: started.viewInviteLink, name: "Viewer" });
  assert.equal(joined.access, "view");
  assert.equal(viewer.isViewer(), true);
  const mirror = path.join(viewerRoot.path, "main.tex");
  await waitFor(() => fs.existsSync(mirror) && fs.readFileSync(mirror, "utf8") === "Hello\n", 8000, "viewer mirror");
  await waitFor(() => host.status().participants.some((p) => p.name === "Viewer" && p.viewer === true), 4000, "host sees a viewer");

  const hostText = () => host.session.docs.get("main.tex").ytext.toString();

  // 1. A text update straight from the viewer's socket is dropped.
  const rogue = new Y.Doc();
  Y.applyUpdate(rogue, Y.encodeStateAsUpdate(viewer.session.docs.get("main.tex").ydoc));
  const before = Y.encodeStateVector(rogue);
  rogue.getText("content").insert(0, "EVIL ");
  viewer.session.transport.broadcast(updateFrame("main.tex", Y.encodeStateAsUpdate(rogue, before)));
  // 2. So is a new doc, a comment on the session doc, and file bytes.
  const rogueSession = new Y.Doc();
  rogueSession.getMap("comments").set("c1", new Y.Map());
  viewer.session.transport.broadcast(updateFrame(SESSION_DOC, Y.encodeStateAsUpdate(rogueSession)));
  const newDoc = new Y.Doc();
  newDoc.getText("content").insert(0, "planted");
  viewer.session.transport.broadcast(updateFrame("planted.tex", Y.encodeStateAsUpdate(newDoc)));
  const bytes = Buffer.from("not a png");
  viewer.session.transport.broadcast(transport.encodeBlob("fig.png", require("../electron/services/collab/manifest.cjs").hashBuffer(bytes), new Uint8Array(bytes)));
  // 3. The viewer's own app never sends a local change either.
  viewer.session.docs.get("main.tex").ytext.insert(0, "LOCAL ");
  await sleep(800);
  assert.equal(hostText(), "Hello\n");
  assert.equal(host.session.sessionDoc.getMap("comments").size, 0);
  assert.equal(host.session.docs.has("planted.tex"), false);
  assert.deepEqual([...fs.readFileSync(path.join(hostRoot, "fig.png"))], [1, 2, 3, 4]);
  assert.equal(fs.readFileSync(path.join(hostRoot, "main.tex"), "utf8"), "Hello\n");

  // 4. The host's edits still reach the viewer.
  host.session.docs.get("main.tex").ytext.insert(5, " world");
  await waitFor(() => viewer.session.docs.get("main.tex").ytext.toString().includes("Hello world"), 4000, "host edit at viewer");

  // 5. A change on the viewer's disk is written over with the shared text.
  const shared = viewer.session.docs.get("main.tex").ytext.toString();
  fs.writeFileSync(mirror, "edited in the mirror\n");
  viewer.ingestDisk("main.tex");
  await waitFor(() => fs.readFileSync(mirror, "utf8") === shared, 4000, "mirror put back");
  assert.ok(viewerMessages.some((m) => m.type === "collab:notice" && /host's content was put back/.test(m.message)));
  assert.equal(viewer.session.docs.get("main.tex").ytext.toString(), shared);

  // 6. So is a changed or deleted file: the host's bytes come back.
  const mirrorFigure = path.join(viewerRoot.path, "fig.png");
  await waitFor(() => fs.existsSync(mirrorFigure), 4000, "mirror figure");
  fs.writeFileSync(mirrorFigure, "scribbled");
  await viewer.rescan();
  await waitFor(() => fs.readFileSync(mirrorFigure).equals(Buffer.from([1, 2, 3, 4])), 4000, "figure put back");
  fs.rmSync(mirror);
  await viewer.rescan();
  await waitFor(() => fs.existsSync(mirror) && fs.readFileSync(mirror, "utf8") === shared, 4000, "deleted text put back");
  assert.equal(host.session.sessionDoc.getMap("files").get("main.tex")?.deleted, undefined);

  // 7. The edit link still edits.
  await editor.join({ link: started.inviteLink, name: "Editor" });
  assert.equal(editor.status().access, "edit");
  await waitFor(() => editor.session.docs.get("main.tex")?.ytext.toString() === hostText(), 8000, "editor synced");
  editor.session.docs.get("main.tex").ytext.insert(0, "% ok\n");
  await waitFor(() => hostText().startsWith("% ok\n"), 4000, "editor edit at host");
  await waitFor(() => viewer.session.docs.get("main.tex").ytext.toString().includes("% ok\n"), 4000, "editor edit at viewer");
});

test("a wrong token is still refused; the view token is not the edit token", async () => {
  const host = new transport.HostTransport({ token: "e".repeat(32), viewToken: "v".repeat(32) });
  const port = await host.start();
  const accessOf = (token) => new Promise((resolve) => {
    const guest = new transport.GuestTransport({ host: "127.0.0.1", port, token, hello: { clientId: `c-${token[0]}`, name: "x" } });
    host.once("open", (conn) => { resolve(conn.access); guest.close(); });
    guest.once("gaveUp", () => { resolve("refused"); guest.close(); });
    guest.connect();
  });
  assert.equal(await accessOf("e".repeat(32)), "edit");
  assert.equal(await accessOf("v".repeat(32)), "view");
  assert.equal(await accessOf("x".repeat(32)), "refused");
  host.close();
});
