"use strict";
// The internet route: two hubs in one process, joined through the local relay
// (services/collab-relay/local-server.cjs, the same Room as the Worker), with
// the relay also playing the attacker: it records, replays, substitutes,
// forges and black-holes traffic.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { CollabHub } = require("../electron/services/collab/hub.cjs");
const invite = require("../electron/services/collab/invite.cjs");
const relay = require("../electron/services/collab/relay-transport.cjs");
const transportKinds = require("../electron/services/collab/transport-ws.cjs");
const { createLocalRelay } = require("../services/collab-relay/local-server.cjs");
const { Room, KIND, encodeEnvelope, hostSecretMatches, updateQuota, ROOM_LEASE_MS, LEASE_RENEW_MS } = require("../services/collab-relay/room.mjs");

const waitFor = async (predicate, timeoutMs = 8000, label = "condition") => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// A host project and hubs around a local relay; `relayOptions` go to createLocalRelay.
const setup = async (t, relayOptions = {}) => {
  const server = await createLocalRelay(relayOptions);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-relay-"));
  const hostRoot = path.join(base, "paper");
  fs.mkdirSync(hostRoot);
  const hubs = [];
  const hub = (name, rootRef, relayUrl = "") => {
    const created = makeHub(rootRef, { collabRoot: path.join(base, `${name}-collab`), name, relayUrl });
    hubs.push(created);
    return created;
  };
  t.after(async () => {
    await Promise.allSettled(hubs.map((item) => item.leave()));
    await server.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { server, base, hostRoot, hub };
};

const fakeSocket = () => {
  const socket = { sent: [], closedWith: null, closed: false };
  socket.send = (bytes) => socket.sent.push(Buffer.from(bytes));
  socket.close = (code) => {
    socket.closedWith = code;
    socket.closed = true;
  };
  return socket;
};

// Two channel ends whose writes land in inboxes the test delivers by hand.
const channelPair = ({ receiverOptions = {} } = {}) => {
  const toHost = crypto.randomBytes(32);
  const toGuest = crypto.randomBytes(32);
  const wire = { toReceiver: [], toSender: [], frames: [], failures: [] };
  const sender = new relay.Channel({ sendKey: toHost, recvKey: toGuest, write: (bytes) => wire.toReceiver.push(bytes), onFrame: () => {}, onFail: (code) => wire.failures.push(["sender", code]) });
  const receiver = new relay.Channel({ sendKey: toGuest, recvKey: toHost, write: (bytes) => wire.toSender.push(bytes), onFrame: (frame) => wire.frames.push(frame), onFail: (code) => wire.failures.push(["receiver", code]), ...receiverOptions });
  const deliver = () => {
    while (wire.toReceiver.length || wire.toSender.length) {
      while (wire.toReceiver.length) receiver.receive(wire.toReceiver.shift());
      while (wire.toSender.length) sender.receive(wire.toSender.shift());
    }
  };
  return { sender, receiver, wire, deliver };
};

// A frame of the given kind (its first byte): blob frames take the bulk lane.
const frameOf = (kind, bytes) => Buffer.concat([Buffer.from([kind]), crypto.randomBytes(bytes - 1)]);
const payload = (pieces) => pieces.reduce((sum, bytes) => sum + bytes.length - 6 - 16, 0);

test("a channel keeps to each lane's window, and a replayed, reordered or foreign piece closes it", () => {
  for (const [kind, lane] of [[transportKinds.FRAME_SYNC, relay.URGENT], [transportKinds.FRAME_BLOB, relay.BULK]]) {
    const frame = frameOf(kind, 10 * 1024 * 1024 + 5);
    const { sender, wire, deliver } = channelPair();
    sender.enqueue(frame);
    assert.equal(payload(wire.toReceiver), relay.WINDOW_BYTES[lane], "no more than the lane's window goes out before an acknowledgement");
    deliver();
    assert.equal(wire.frames.length, 1);
    assert.ok(wire.frames[0].equals(frame), "10 MiB arrives whole once the acknowledgements flow");
    assert.deepEqual(wire.failures, []);
  }

  // An edit queued behind a figure overtakes it.
  const lanes = channelPair();
  const figure = frameOf(transportKinds.FRAME_BLOB, 3 * 1024 * 1024);
  const edit = frameOf(transportKinds.FRAME_SYNC, 100);
  lanes.sender.enqueue(figure);
  lanes.sender.enqueue(edit);
  lanes.deliver();
  assert.deepEqual(lanes.wire.frames.map((frame) => frame.length), [edit.length, figure.length], "the edit arrives before the figure is complete");
  assert.ok(lanes.wire.frames[1].equals(figure));

  // The relay sends a piece again: its counter is spent, so it does not open.
  const replayed = channelPair();
  replayed.sender.enqueue(Buffer.from("first"));
  const piece = replayed.wire.toReceiver[0];
  replayed.deliver();
  replayed.receiver.receive(piece);
  assert.deepEqual(replayed.wire.failures, [["receiver", relay.CODE.BAD_FRAME]]);

  // Reordered.
  const reordered = channelPair();
  reordered.sender.enqueue(Buffer.from("one"));
  reordered.sender.enqueue(Buffer.from("two"));
  reordered.receiver.receive(reordered.wire.toReceiver[1]);
  assert.deepEqual(reordered.wire.failures, [["receiver", relay.CODE.BAD_FRAME]]);

  // Sealed under another key (a forged message).
  const foreign = channelPair();
  const stranger = channelPair();
  stranger.sender.enqueue(Buffer.from("forged"));
  foreign.receiver.receive(stranger.wire.toReceiver[0]);
  assert.deepEqual(foreign.wire.failures, [["receiver", relay.CODE.BAD_FRAME]]);

  // Before the hello, a frame larger than the hello limit is refused.
  const early = channelPair({ receiverOptions: { maxFrameBytes: 64 * 1024 } });
  early.sender.enqueue(crypto.randomBytes(100 * 1024));
  early.deliver();
  assert.deepEqual(early.wire.failures, [["receiver", relay.CODE.BAD_FRAME]]);

  // The host's budget for partial frames is shared and bounded.
  const budget = relay.createBudget(1024 * 1024);
  const greedy = channelPair({ receiverOptions: { budget } });
  greedy.sender.enqueue(crypto.randomBytes(3 * 1024 * 1024));
  greedy.deliver();
  assert.deepEqual(greedy.wire.failures, [["receiver", relay.CODE.OVERLOAD]]);
  assert.equal(budget.used, 0, "a closed channel gives its partial frame back");

  // A partial frame that stops growing is overdue.
  const stalled = channelPair();
  stalled.sender.enqueue(crypto.randomBytes(relay.PIECE_BYTES + 10));
  stalled.receiver.receive(stalled.wire.toReceiver[0]);
  assert.equal(stalled.receiver.overdue(Date.now() + relay.TIMING.stallMs + 1), relay.CODE.OVERLOAD);
});

test("acknowledgements are cumulative and wait for room on the socket", () => {
  // A stream of tiny frames (all a view-only guest may send) costs the host
  // no acknowledgement until a quarter window has been consumed.
  const tiny = channelPair();
  for (let index = 0; index < 5000; index += 1) tiny.sender.enqueue(Buffer.from("x"));
  tiny.deliver();
  assert.equal(tiny.wire.frames.length, 5000);
  assert.deepEqual(tiny.receiver.ackedConsumed, [0, 0], "no acknowledgement for 5000 bytes");

  // A full window still flows, and an acknowledgement waits while the socket is backed up.
  let roomy = false;
  const backed = channelPair({ receiverOptions: { canWrite: () => roomy } });
  backed.sender.enqueue(frameOf(transportKinds.FRAME_SYNC, 2 * relay.WINDOW_BYTES[relay.URGENT]));
  while (backed.wire.toReceiver.length) backed.receiver.receive(backed.wire.toReceiver.shift());
  assert.equal(backed.wire.toSender.length, 0, "nothing written while the socket has no room");
  roomy = true;
  backed.receiver.acknowledge();
  backed.deliver();
  assert.equal(backed.wire.frames.length, 1, "the window opened once the acknowledgement went out");
  assert.deepEqual(backed.wire.failures, []);
});

test("the relay room seats only the secret's holder and admits guests only around a host", async () => {
  let now = 1000;
  const room = invite.createRelayRoom();
  assert.equal(await hostSecretMatches(room.roomId, room.secret), true);
  assert.equal(await hostSecretMatches(room.roomId, invite.createRelayRoom().secret), false);
  const subject = new Room({ roomId: room.roomId, graceMs: 60000, now: () => now });
  const early = fakeSocket();
  assert.equal(subject.attachGuest(early), null);
  assert.equal(early.closedWith, 4010, "no host has come: nobody can wait in the room");
  const host = fakeSocket();
  subject.attachHost(host);
  assert.equal(host.sent[0][0], KIND.HOST_READY, "the host learns it has the seat");
  const guest = fakeSocket();
  assert.equal(subject.attachGuest(guest), "g1");
  assert.equal(host.sent[1][0], KIND.PEER_OPEN);
  assert.deepEqual([...guest.sent[0]], [KIND.HOST_OPEN]);
  subject.onMessage(guest, new Uint8Array([9, 9, 9]));
  assert.equal(host.sent[2][0], KIND.PEER_DATA);
  subject.onMessage(host, encodeEnvelope(KIND.SEND, "g1", new Uint8Array([7])));
  assert.deepEqual([...guest.sent[1]], [KIND.HOST_DATA, 7]);
  assert.equal(subject.detach(host), "host");
  assert.deepEqual([...guest.sent[2]], [KIND.HOST_GONE]);
  now += 30000;
  const during = fakeSocket();
  assert.equal(subject.attachGuest(during), "g2", "within the grace period guests may wait");
  assert.equal(subject.sweep(), false);
  now += 31000;
  assert.equal(subject.sweep(), true);
  assert.equal(guest.closedWith, 4010);
  assert.equal(during.closedWith, 4010);
  const late = fakeSocket();
  assert.equal(subject.attachGuest(late), null);
  const back = fakeSocket();
  subject.attachHost(back);
  const again = fakeSocket();
  subject.attachGuest(again);
  subject.onMessage(back, encodeEnvelope(KIND.CLOSE_PEER, "g3", new Uint8Array([0x0f, 0xa4])));
  assert.equal(again.closedWith, 4004);
  assert.equal(subject.guests.size, 0);

  // A close that wakes a hibernated Worker names a socket the rebuilt room
  // no longer lists; its attachment still ends the seat or the guest.
  const woke = new Room({ roomId: room.roomId, graceMs: 60000, now: () => now });
  const waiting = fakeSocket();
  woke.guests.set("g4", waiting);
  const closingHost = fakeSocket();
  closingHost.closed = true;
  assert.equal(woke.detach(closingHost), null);
  assert.equal(woke.departed({ role: "host" }, closingHost), "host");
  assert.deepEqual([...waiting.sent[0]], [KIND.HOST_GONE]);
  assert.equal(woke.hostLeftAt, now, "the grace period starts");
  const newHost = fakeSocket();
  woke.attachHost(newHost);
  assert.equal(woke.departed({ role: "host" }, fakeSocket()), null, "a replaced host's close leaves the new host seated");
  assert.equal(woke.host, newHost);
  assert.equal(woke.departed({ role: "guest", id: "g4" }, fakeSocket()), null, "a live guest under that id stays");
  waiting.closed = true;
  assert.equal(woke.departed({ role: "guest", id: "g4" }, waiting), "guest");
  assert.equal(newHost.sent.at(-1)[0], KIND.PEER_CLOSE);
});

test("two hubs meet through the relay, which never sees the text, the files or the tokens", async (t) => {
  const traffic = [];
  const { server, hostRoot, hub } = await setup(t, { onTraffic: ({ bytes }) => traffic.push(Buffer.from(bytes)) });
  const marker = "PLAINTEXT-MARKER-4f1c9a";
  fs.writeFileSync(path.join(hostRoot, "main.tex"), `Hello ${marker}\n`);
  const figure = crypto.randomBytes(3 * 1024 * 1024);
  fs.writeFileSync(path.join(hostRoot, "fig.png"), figure);
  const host = hub("Host", { path: hostRoot }, server.url);
  const guestRoot = { path: null };
  const guest = hub("Guest", guestRoot);
  const viewer = hub("Viewer", { path: null });

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
  viewer.session.docs.get("main.tex").ytext.insert(0, "VIEWER ");
  await sleep(500);
  assert.ok(!host.session.docs.get("main.tex").ytext.toString().includes("VIEWER"), "the host drops a viewer's edit");

  const seen = Buffer.concat(traffic);
  assert.ok(seen.length > figure.length * 2, "the figure went through the relay (in and out)");
  for (const secret of [marker, "% guest", parsed.token, invite.parseInviteLink(started.viewInviteLink).token]) {
    assert.equal(seen.indexOf(Buffer.from(secret)), -1, `relay saw ${secret}`);
  }
  assert.equal(seen.indexOf(figure.subarray(1000, 1064)), -1, "relay saw figure bytes");

  // The host's link to the relay drops: guests wait, then make new channels.
  host.session.transport.socket.terminate();
  await waitFor(() => guest.status().connected === false, 4000, "guest notices the host is away");
  await waitFor(() => host.status().connected === true && guest.status().connected === true, 10000, "both back");
  host.session.docs.get("main.tex").ytext.insert(0, "% host\n");
  await waitFor(() => guest.session.docs.get("main.tex").ytext.toString().startsWith("% host\n% guest\n"), 8000, "host edit after reconnect");
  await waitFor(() => host.status().participants.filter((p) => !p.host && p.connected).length === 2, 4000, "both guests reconnected");
});

test("a relay that replays, substitutes or forges changes nothing", async (t) => {
  // Everything each guest socket sends, per socket, in order.
  const sentBy = new Map();
  const { server, hostRoot, hub } = await setup(t, {
    filter: ({ role, direction, bytes, ws }) => {
      if (role === "guest" && direction === "in" && bytes) {
        if (!sentBy.has(ws)) sentBy.set(ws, []);
        sentBy.get(ws).push(Buffer.from(bytes));
      }
      return true;
    },
  });
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  const host = hub("Host", { path: hostRoot }, server.url);
  const editorRoot = { path: null };
  const editor = hub("Editor", editorRoot);
  const started = await host.start({ name: "Host" });
  await editor.join({ link: started.inviteLink, name: "Editor" });
  await waitFor(() => editorRoot.path && fs.existsSync(path.join(editorRoot.path, "main.tex")), 8000, "editor mirror");
  const [roomId] = server.rooms.keys();
  const room = server.rooms.get(roomId);
  const editorPeer = () => [...room.guests.entries()].find(([, socket]) => sentBy.has(socket.ws))?.[0];
  const firstSocket = [...sentBy.keys()][0];
  const firstConnection = [...sentBy.get(firstSocket)];

  // 1. Replay: the editor uploads fig.png as A, then B; the relay sends A's pieces again.
  const hostFigure = path.join(hostRoot, "fig.png");
  const versionA = crypto.randomBytes(700 * 1024);
  const versionB = crypto.randomBytes(700 * 1024);
  const before = sentBy.get(firstSocket).length;
  fs.writeFileSync(path.join(editorRoot.path, "fig.png"), versionA);
  await waitFor(() => fs.existsSync(hostFigure) && fs.readFileSync(hostFigure).equals(versionA), 10000, "upload A");
  const uploadA = sentBy.get(firstSocket).slice(before).filter((bytes) => bytes[0] === 0x03);
  assert.ok(uploadA.length >= 2, "A went up in pieces");
  fs.writeFileSync(path.join(editorRoot.path, "fig.png"), versionB);
  await waitFor(() => fs.readFileSync(hostFigure).equals(versionB), 10000, "upload B");
  const peer = editorPeer();
  for (const piece of uploadA) room.host.send(encodeEnvelope(KIND.PEER_DATA, peer, piece));
  await waitFor(() => !room.guests.has(peer), 4000, "the host closes the replayed channel");
  await sleep(300);
  assert.ok(fs.readFileSync(hostFigure).equals(versionB), "the replay did not bring A back");
  await waitFor(() => editor.status().connected && host.status().participants.some((p) => p.name === "Editor" && p.connected), 10000, "editor back over a new channel");

  // 2. Substitution: a new connection replays the editor's handshake and hello.
  const closed = await new Promise((resolve) => {
    const socket = new WebSocket(`${server.url}/rooms/${roomId}?role=guest`);
    let sent = false;
    socket.on("message", (data) => {
      if (sent || Buffer.from(data)[0] !== KIND.HOST_OPEN) return;
      sent = true;
      for (const bytes of firstConnection.slice(0, 4)) socket.send(bytes);
    });
    socket.on("close", (code) => resolve(code));
  });
  assert.equal(closed, 4004, "a recorded hello does not open on a new channel");
  assert.equal(host.status().participants.filter((p) => !p.host).length, 1, "no second editor appeared");

  // 3. Forgery: a piece the host never sealed reaches the editor.
  const text = () => editor.session.docs.get("main.tex").ytext.toString();
  const textBefore = text();
  const forger = channelPair();
  forger.sender.enqueue(Buffer.from("forged"));
  const target = room.guests.get(editorPeer());
  target.send(Buffer.concat([Buffer.from([KIND.HOST_DATA]), forger.wire.toReceiver[0]]));
  await waitFor(() => editor.status().connected === false, 4000, "the editor drops the forged channel");
  await waitFor(() => editor.status().connected === true, 10000, "and comes back");
  assert.equal(text(), textBefore);
});

test("a silent link is noticed on both sides and redialled", async (t) => {
  const saved = { ...relay.TIMING };
  Object.assign(relay.TIMING, { tickMs: 100, keepaliveMs: 300, socketSilenceMs: 1500, silenceMs: 2000, handshakeMs: 3000, stallMs: 3000 });
  t.after(() => Object.assign(relay.TIMING, saved));
  const holes = new Set();
  const { server, hostRoot, hub } = await setup(t, { filter: ({ ws }) => !holes.has(ws) });
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  const host = hub("Host", { path: hostRoot }, server.url);
  const guest = hub("Guest", { path: null });
  const started = await host.start({ name: "Host" });
  await guest.join({ link: started.inviteLink, name: "Guest" });
  const [roomId] = server.rooms.keys();
  const room = server.rooms.get(roomId);

  // The guest's link goes quiet without closing (a lost NAT mapping).
  holes.add([...room.guests.values()][0].ws);
  await waitFor(() => guest.status().connected === false, 6000, "guest notices the silence");
  await waitFor(() => guest.status().connected === true, 10000, "guest redialled");
  // The same for the host's link.
  holes.add(room.host.ws);
  await waitFor(() => host.status().connected === false, 6000, "host notices the silence");
  await waitFor(() => host.status().connected === true && guest.status().connected === true, 10000, "host redialled and the guest rejoined it");
  guest.session.docs.get("main.tex").ytext.insert(0, "% after\n");
  await waitFor(() => host.session.docs.get("main.tex").ytext.toString().startsWith("% after\n"), 8000, "edits flow again");
});

test("one address hosts a bounded number of rooms", async (t) => {
  const { server, hostRoot, hub } = await setup(t, { maxHostRooms: 1 });
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  const first = hub("First", { path: hostRoot }, server.url);
  const second = hub("Second", { path: hostRoot }, server.url);
  await first.start({ name: "First" });
  await assert.rejects(second.start({ name: "Second" }), { code: "COLLAB_RELAY_BUSY" });
  assert.equal(second.session, null);
  await first.leave();
  await waitFor(async () => {
    try {
      await second.start({ name: "Second" });
      return true;
    } catch {
      return false;
    }
  }, 4000, "the room freed when the first host left");
  assert.equal(second.status().active, true);
});

test("reservations: a live room stays counted, and only its own seat gives it back", () => {
  const rooms = {};
  let now = 0;
  const run = (action, roomId, seat) => updateQuota(rooms, { action, roomId, seat, now, max: 2 });
  assert.equal(run("acquire", "A", "a1"), true);
  assert.equal(run("acquire", "B", "b1"), true);
  assert.equal(run("acquire", "C", "c1"), false, "the address is full");
  // A seated host renews (acquires again) every LEASE_RENEW_MS, so its room outlives the first lease.
  for (now = LEASE_RENEW_MS; now <= 2 * ROOM_LEASE_MS; now += LEASE_RENEW_MS) {
    assert.equal(run("acquire", "A", "a1"), true);
    assert.equal(run("acquire", "B", "b1"), true);
  }
  assert.equal(run("acquire", "C", "c1"), false, "two days on, both live rooms still count");
  // A reconnect takes the seat; the replaced host's release leaves it alone.
  assert.equal(run("acquire", "A", "a2"), true);
  run("release", "A", "a1");
  assert.equal(rooms.A.seat, "a2");
  assert.equal(run("acquire", "C", "c1"), false);
  // An admission that never completed (its answer was lost) left seat a3 on A
  // while a2 stayed seated: a2's next renewal takes the room back.
  run("acquire", "A", "a3");
  assert.equal(run("acquire", "A", "a2"), true);
  assert.equal(rooms.A.seat, "a2");
  run("release", "A", "a2");
  assert.equal(run("acquire", "C", "c1"), true, "the seat's own release frees the room");
  // A room whose host stopped renewing (a lost close) frees itself after the lease.
  now += ROOM_LEASE_MS;
  assert.equal(run("acquire", "C", "c1"), true);
  assert.deepEqual(Object.keys(rooms), ["C"], "B expired");
  // Renewing a reservation that expired needs a free slot like a new one.
  const full = { X: { seat: "x", until: 10 }, Y: { seat: "y", until: 10 } };
  assert.equal(updateQuota(full, { action: "acquire", roomId: "Z", seat: "z", now: 5, max: 2 }), false);
});

test("a replaced host's close keeps its successor counted; a host that moves gives the old address back", async (t) => {
  const { server } = await setup(t, { maxHostRooms: 1 });
  const room = invite.createRelayRoom();
  const other = invite.createRelayRoom();
  const dial = (secret, roomId, address) => new Promise((resolve) => {
    const socket = new WebSocket(`${server.url}/rooms/${roomId}?role=host&secret=${secret}`, { headers: { "x-test-address": address } });
    const events = [];
    socket.on("message", (data) => events.push(Buffer.from(data)[0]));
    socket.on("close", (code) => events.push(`close:${code}`));
    socket.on("open", () => setTimeout(() => resolve({ socket, events }), 100));
  });
  const first = await dial(room.secret, room.roomId, "10.0.0.1");
  assert.equal(first.events[0], KIND.HOST_READY);
  // A reconnect from the same address replaces the first host…
  const second = await dial(room.secret, room.roomId, "10.0.0.1");
  assert.equal(second.events[0], KIND.HOST_READY);
  first.socket.terminate();
  await sleep(100);
  // …and the first host's close does not free the room: the address is still full.
  const extra = await dial(other.secret, other.roomId, "10.0.0.1");
  assert.equal(extra.events[0], KIND.REFUSED_HOST);
  extra.socket.terminate();
  // The host moves to another network: the old address gets its slot back at once.
  const moved = await dial(room.secret, room.roomId, "10.0.0.2");
  assert.equal(moved.events[0], KIND.HOST_READY);
  assert.deepEqual(Object.keys(server.hosted.get("10.0.0.1")), [], "the old address holds nothing");
  assert.deepEqual(Object.keys(server.hosted.get("10.0.0.2")), [room.roomId]);
  const again = await dial(other.secret, other.roomId, "10.0.0.1");
  assert.equal(again.events[0], KIND.HOST_READY);
  for (const item of [second, moved, again]) item.socket.terminate();
});

test("a link with the wrong host key is refused at once; no host, no room; an unreachable relay stops the start", async (t) => {
  const { server, hostRoot, hub } = await setup(t);
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  const host = hub("Host", { path: hostRoot }, server.url);
  const guest = hub("Guest", { path: null });
  const started = await host.start({ name: "Host" });
  const forged = started.inviteLink.replace(/k=[^&]+/, `k=${invite.createRelayRoom().key}`);
  const begun = Date.now();
  await assert.rejects(guest.join({ link: forged, name: "Guest" }), { code: "COLLAB_REFUSED" });
  assert.ok(Date.now() - begun < 5000, "refused without waiting for the timeout");
  assert.equal(host.status().participants.length, 1);

  const nobody = await new Promise((resolve) => {
    const socket = new WebSocket(`${server.url}/rooms/${invite.createRelayRoom().roomId}?role=guest`);
    socket.on("close", (code) => resolve(code));
  });
  assert.equal(nobody, 4010);

  const offline = hub("Offline", { path: hostRoot }, "ws://127.0.0.1:9");
  await assert.rejects(offline.start({ name: "Offline" }), { code: "COLLAB_RELAY_UNREACHABLE" });
  assert.equal(offline.status().active, false);
  assert.equal(offline.session, null);
});
