"use strict";
// The internet route: two hubs in one process, joined through the local relay
// (services/collab-relay/local-server.cjs, the same Room as the Worker).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CollabHub } = require("../electron/services/collab/hub.cjs");
const invite = require("../electron/services/collab/invite.cjs");
const relay = require("../electron/services/collab/relay-transport.cjs");
const { createLocalRelay } = require("../services/collab-relay/local-server.cjs");
const { Room, KIND, encodeEnvelope } = require("../services/collab-relay/room.mjs");

const waitFor = async (predicate, timeoutMs = 8000, label = "condition") => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const makeHub = (rootRef, { collabRoot, name, relayUrl = "" }) => new CollabHub({
  workspace: {
    getRootPath: () => rootRef.path,
    rootInfo: async () => ({ path: "main.tex" }),
    withFileMutation: (_relative, operation) => operation(),
  },
  state: {},
  sendCollab: () => {},
  withWorkspaceMutation: (operation) => operation(),
  trackSaved: () => {},
  openWorkspacePath: async (root) => { rootRef.path = root; },
  refreshTree: () => {},
  recordVersion: async () => {},
  locale: () => "en",
  userName: () => name,
  collabRoot: () => collabRoot,
  relayUrl: () => relayUrl,
});

const fakeSocket = () => {
  const socket = { sent: [], closedWith: null, closed: false };
  socket.send = (bytes) => socket.sent.push(Buffer.from(bytes));
  socket.close = (code) => {
    socket.closedWith = code;
    socket.closed = true;
  };
  return socket;
};

test("sealed frames round-trip in pieces and open only with the right key and direction", () => {
  const key = crypto.randomBytes(32);
  const frame = crypto.randomBytes(3 * 1024 * 1024 + 17);
  const sealer = new relay.Sealer(key, Buffer.from("tex64-collab-relay-v1 host>guest"));
  const pieces = sealer.pieces(frame);
  assert.ok(pieces.length >= 7, "a 3 MiB frame is cut into 512 KiB pieces");
  for (const piece of pieces) assert.ok(piece.length <= relay.PIECE_BYTES + 8);
  const reassembler = new relay.Reassembler();
  let whole = null;
  for (const piece of pieces) whole = reassembler.push(piece) || whole;
  assert.ok(whole);
  assert.deepEqual(relay.unseal(key, Buffer.from("tex64-collab-relay-v1 host>guest"), whole), frame);
  assert.equal(relay.unseal(key, Buffer.from("tex64-collab-relay-v1 guest>host"), whole), null, "reflected to the host, it does not open");
  assert.equal(relay.unseal(crypto.randomBytes(32), Buffer.from("tex64-collab-relay-v1 host>guest"), whole), null);
  // A missing piece drops the message instead of stitching two together.
  const gap = new relay.Reassembler();
  const results = [pieces[0], pieces[2], ...pieces.slice(3)].map((piece) => gap.push(piece));
  assert.ok(results.every((result) => result === null));
});

test("the relay room keeps the host seat for the secret's holder and holds guests until it comes", async () => {
  const room = invite.createRelayRoom();
  const subject = new Room({ roomId: room.roomId });
  const guest = fakeSocket();
  assert.equal(subject.attachGuest(guest), "g1");
  assert.equal(guest.sent.length, 0, "no host yet");
  const impostor = fakeSocket();
  assert.equal(await subject.attachHost(impostor, invite.createRelayRoom().secret), false);
  assert.equal(impostor.closedWith, 4004);
  const host = fakeSocket();
  assert.equal(await subject.attachHost(host, room.secret), true);
  assert.equal(host.sent[0][0], KIND.PEER_OPEN);
  assert.deepEqual([...guest.sent[0]], [KIND.HOST_OPEN]);
  subject.onMessage(guest, new Uint8Array([9, 9, 9]));
  assert.equal(host.sent[1][0], KIND.PEER_DATA);
  subject.onMessage(host, encodeEnvelope(KIND.SEND, "g1", new Uint8Array([7])));
  assert.deepEqual([...guest.sent[1]], [KIND.HOST_DATA, 7]);
  subject.detach(host);
  assert.deepEqual([...guest.sent[2]], [KIND.HOST_GONE]);
  const back = fakeSocket();
  await subject.attachHost(back, room.secret);
  subject.onMessage(back, encodeEnvelope(KIND.CLOSE_PEER, "g1", new Uint8Array([0x0f, 0xa4])));
  assert.equal(guest.closedWith, 4004);
  assert.equal(subject.guests.size, 0);
});

test("two hubs meet through the relay, which never sees the text, the files or the tokens", async (t) => {
  const traffic = [];
  const server = await createLocalRelay({ onTraffic: ({ bytes }) => traffic.push(Buffer.from(bytes)) });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-relay-"));
  const hostRoot = path.join(base, "paper");
  fs.mkdirSync(hostRoot);
  const marker = "PLAINTEXT-MARKER-4f1c9a";
  fs.writeFileSync(path.join(hostRoot, "main.tex"), `Hello ${marker}\n`);
  const figure = crypto.randomBytes(3 * 1024 * 1024);
  fs.writeFileSync(path.join(hostRoot, "fig.png"), figure);
  const host = makeHub({ path: hostRoot }, { collabRoot: path.join(base, "host-collab"), name: "Host", relayUrl: server.url });
  const guestRoot = { path: null };
  const guest = makeHub(guestRoot, { collabRoot: path.join(base, "guest-collab"), name: "Guest" });
  const viewerRoot = { path: null };
  const viewer = makeHub(viewerRoot, { collabRoot: path.join(base, "viewer-collab"), name: "Viewer" });
  t.after(async () => {
    await Promise.allSettled([guest.leave(), viewer.leave(), host.leave()]);
    await server.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  assert.equal(host.status().route, "relay");
  const started = await host.start({ name: "Host" });
  assert.equal(started.route, "relay");
  const parsed = invite.parseInviteLink(started.inviteLink);
  assert.equal(parsed.relay.server, server.url);
  assert.equal(parsed.host, undefined, "a relay link carries no address of the host");

  const joined = await guest.join({ link: started.inviteLink, name: "Guest" });
  assert.equal(joined.route, "relay");
  assert.equal(joined.access, "edit");
  const mirror = path.join(guestRoot.path, "main.tex");
  await waitFor(() => fs.existsSync(mirror) && fs.readFileSync(mirror, "utf8") === `Hello ${marker}\n`, 8000, "guest mirror");
  const mirrorFigure = path.join(guestRoot.path, "fig.png");
  await waitFor(() => fs.existsSync(mirrorFigure) && fs.statSync(mirrorFigure).size === figure.length, 15000, "3 MiB figure");
  assert.ok(fs.readFileSync(mirrorFigure).equals(figure));

  guest.session.docs.get("main.tex").ytext.insert(0, "% guest\n");
  await waitFor(() => host.session.docs.get("main.tex").ytext.toString().startsWith("% guest\n"), 8000, "guest edit at host");

  const viewed = await viewer.join({ link: started.viewInviteLink, name: "Viewer" });
  assert.equal(viewed.access, "view");
  await waitFor(() => host.status().participants.some((p) => p.name === "Viewer" && p.viewer === true), 4000, "host sees the viewer");

  const seen = Buffer.concat(traffic);
  assert.ok(seen.length > figure.length * 2, "the figure went through the relay (in and out)");
  for (const secret of [marker, "% guest", parsed.token, invite.parseInviteLink(started.viewInviteLink).token, parsed.relay.key]) {
    assert.equal(seen.indexOf(Buffer.from(secret)), -1, `relay saw ${secret}`);
  }
  assert.equal(seen.indexOf(figure.subarray(1000, 1064)), -1, "relay saw figure bytes");

  // The host's link to the relay drops: guests wait, then say hello again.
  host.session.transport.socket.terminate();
  await waitFor(() => guest.status().connected === false, 4000, "guest notices the host is away");
  await waitFor(() => host.status().connected === true && guest.status().connected === true, 10000, "both back");
  host.session.docs.get("main.tex").ytext.insert(0, "% host\n");
  await waitFor(() => guest.session.docs.get("main.tex").ytext.toString().startsWith("% host\n% guest\n"), 8000, "host edit after reconnect");
  await waitFor(() => host.status().participants.filter((p) => !p.host && p.connected).length === 2, 4000, "both guests reconnected");
});

test("a link with the wrong room key is refused at once; an unreachable relay stops the start", async (t) => {
  const server = await createLocalRelay();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-relay-"));
  const hostRoot = path.join(base, "paper");
  fs.mkdirSync(hostRoot);
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  const host = makeHub({ path: hostRoot }, { collabRoot: path.join(base, "host-collab"), name: "Host", relayUrl: server.url });
  const guest = makeHub({ path: null }, { collabRoot: path.join(base, "guest-collab"), name: "Guest" });
  t.after(async () => {
    await Promise.allSettled([guest.leave(), host.leave()]);
    await server.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const started = await host.start({ name: "Host" });
  const forged = started.inviteLink.replace(/k=[^&]+/, `k=${crypto.randomBytes(32).toString("base64url")}`);
  const begun = Date.now();
  await assert.rejects(guest.join({ link: forged, name: "Guest" }), { code: "COLLAB_REFUSED" });
  assert.ok(Date.now() - begun < 5000, "refused without waiting for the timeout");
  assert.equal(host.status().participants.length, 1);

  const offline = makeHub({ path: hostRoot }, { collabRoot: path.join(base, "offline-collab"), name: "Offline", relayUrl: "ws://127.0.0.1:9" });
  await assert.rejects(offline.start({ name: "Offline" }), { code: "COLLAB_RELAY_UNREACHABLE" });
  assert.equal(offline.status().active, false);
  assert.equal(offline.session, null);
});
