"use strict";

// The internet route for a session: the host and every guest dial out to the
// collab relay (services/collab-relay), which pairs them up by room and moves
// bytes. The relay is trusted to stay up, not with the content.
//
// Each guest connection is its own channel to the host (Noise NK in shape):
// the invite link carries the host's static X25519 public key; the guest
// sends a fresh ephemeral key, the host answers with one of its own, and both
// derive this connection's two traffic keys from DH(eₘ, eₕ) and DH(eₘ, S).
// Only the host can derive them, so the relay — or a link holder working with
// it — can neither read a guest's hello (its token) nor speak for the host.
// Frames travel in sealed pieces (AES-256-GCM, the nonce is a per-direction
// counter): a replayed, dropped or reordered piece fails to open and the
// channel is closed, so the guest reconnects and resyncs. The receiver
// acknowledges what it consumed (cumulatively, every quarter window) and the
// sender keeps at most WINDOW_BYTES unacknowledged, so neither the relay nor
// the host buffers a 50 MB figure per guest. See docs/collab-relay.md.
//
// The two transports keep the interface of HostTransport / GuestTransport, so
// the hub does not know which route a session uses.

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { decodeFrame, encodeControl, FRAME_CONTROL, MAX_FRAME_BYTES, MAX_CLIENTS } = require("./transport-ws.cjs");

// Relay envelopes; services/collab-relay/room.mjs has the other side.
const SEND = 0x01;
const CLOSE_PEER = 0x03;
const PEER_OPEN = 0x11;
const PEER_DATA = 0x12;
const PEER_CLOSE = 0x13;
const REFUSED_HOST = 0x14;
const HOST_READY = 0x15;
const HOST_DATA = 0x21;
const HOST_OPEN = 0x22;
const HOST_GONE = 0x23;
const REFUSED = 0x24;

// Channel messages between a guest and the host, opaque to the relay.
const HANDSHAKE_GUEST = 0x01; // · guest ephemeral public key (32)
const HANDSHAKE_HOST = 0x02; // · host ephemeral public key (32)
const PIECE = 0x03; // · index u16 · count u16 · sealed piece (the 5-byte head is the AAD)
const ACK = 0x04; // · plaintext bytes consumed so far (u64)
const KEEPALIVE = 0x05;

const PIECE_BYTES = 512 * 1024;
const WINDOW_BYTES = 4 * 1024 * 1024;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
// A peer that lets this much pile up for it counts as stuck: its connection
// is closed and it resyncs when it comes back.
const MAX_QUEUED_BYTES = 512 * 1024 * 1024;
// Partial frames the host holds for all guests together.
const HOST_REASSEMBLY_BUDGET = 256 * 1024 * 1024;
// Largest frame before the hello checks out, and from a view-only guest
// (it may only send state requests, presence and file requests).
const PRE_HELLO_FRAME_BYTES = 64 * 1024;
const VIEWER_FRAME_BYTES = 1024 * 1024;
// The host's one relay socket carries every guest's channel.
const SOCKET_HIGH_WATER = 16 * 1024 * 1024;

// Tests shorten these.
const TIMING = {
  tickMs: 5000,
  keepaliveMs: 25000, // send something at least this often (relay ping, channel keepalive)
  socketSilenceMs: 60000, // nothing from the relay for this long: the socket is dead
  silenceMs: 75000, // nothing from the other end of a channel for this long: it is gone
  handshakeMs: 15000, // from PEER_OPEN / HOST_OPEN to an authenticated channel
  stallMs: 60000, // a partial frame with no new piece for this long
};

const CODE = {
  HELLO_TIMEOUT: 4001,
  BAD_FRAME: 4003,
  UNAUTHORIZED: 4004,
  FULL: 4005,
  OVERLOAD: 4008,
  SILENT: 4012,
  // The relay holds as many rooms for this address as it allows.
  BUSY: 4029,
};

const toBuffer = (data) => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));

const rawPublicKey = (keyObject) => Buffer.from(keyObject.export({ format: "jwk" }).x, "base64url");
const publicKeyFromRaw = (raw) => crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
const newKeyPair = () => crypto.generateKeyPairSync("x25519");
// Throws for a low-order public key (the shared secret would be all zeros).
const dh = (privateKey, publicRaw) => crypto.diffieHellman({ privateKey, publicKey: publicKeyFromRaw(publicRaw) });

const deriveKeys = ({ ee, es, hostStatic, guestEphemeral, hostEphemeral }) => {
  const okm = Buffer.from(crypto.hkdfSync(
    "sha256",
    Buffer.concat([ee, es]),
    Buffer.from("tex64-collab-relay-v2"),
    Buffer.concat([hostStatic, guestEphemeral, hostEphemeral]),
    2 * KEY_BYTES,
  ));
  return { toHost: okm.subarray(0, KEY_BYTES), toGuest: okm.subarray(KEY_BYTES) };
};

const counterNonce = (counter) => {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
};

const ackMessage = (consumed) => {
  const out = Buffer.alloc(9);
  out[0] = ACK;
  out.writeBigUInt64BE(BigInt(consumed), 1);
  return out;
};

const createBudget = (limit) => ({
  used: 0,
  take(bytes) {
    if (this.used + bytes > limit) return false;
    this.used += bytes;
    return true;
  },
  give(bytes) {
    this.used = Math.max(0, this.used - bytes);
  },
});

// One direction pair of an authenticated channel: queues frames, cuts and
// seals them within the peer's window, and opens and joins what arrives.
class Channel {
  constructor({ sendKey, recvKey, write, onFrame, onFail, canWrite = () => true, maxFrameBytes = MAX_FRAME_BYTES, budget = null, timing = TIMING }) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.write = write;
    this.onFrame = onFrame;
    this.onFail = onFail;
    this.canWrite = canWrite;
    this.maxFrameBytes = maxFrameBytes;
    this.budget = budget;
    this.timing = timing;
    this.failed = false;
    this.queue = [];
    this.queuedBytes = 0;
    this.nextIndex = 0;
    this.sendCounter = 0;
    this.sentBytes = 0;
    this.ackedBytes = 0;
    this.retryTimer = null;
    this.recvCounter = 0;
    this.parts = [];
    this.partBytes = 0;
    this.partCount = 0;
    this.consumed = 0;
    this.ackedConsumed = 0;
    this.lastPiece = 0;
    this.lastSent = Date.now();
    this.lastHeard = Date.now();
  }

  enqueue(frame) {
    if (this.failed) return false;
    const bytes = Buffer.isBuffer(frame) ? frame : Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    if (this.queuedBytes + bytes.length > MAX_QUEUED_BYTES) {
      this.fail(CODE.OVERLOAD);
      return false;
    }
    this.queue.push(bytes);
    this.queuedBytes += bytes.length;
    this.pump();
    return true;
  }

  pump() {
    while (!this.failed && this.queue.length) {
      const frame = this.queue[0];
      const count = Math.max(1, Math.ceil(frame.length / PIECE_BYTES));
      const index = this.nextIndex;
      const piece = frame.subarray(index * PIECE_BYTES, (index + 1) * PIECE_BYTES);
      const inFlight = this.sentBytes - this.ackedBytes;
      if (inFlight > 0 && inFlight + piece.length > WINDOW_BYTES) return;
      if (!this.canWrite()) {
        this.retryLater();
        return;
      }
      const head = Buffer.alloc(5);
      head[0] = PIECE;
      head.writeUInt16BE(index, 1);
      head.writeUInt16BE(count, 3);
      const cipher = crypto.createCipheriv("aes-256-gcm", this.sendKey, counterNonce(this.sendCounter));
      this.sendCounter += 1;
      cipher.setAAD(head);
      this.write(Buffer.concat([head, cipher.update(piece), cipher.final(), cipher.getAuthTag()]));
      this.lastSent = Date.now();
      this.sentBytes += piece.length;
      if (index + 1 < count) {
        this.nextIndex = index + 1;
      } else {
        this.queue.shift();
        this.queuedBytes -= frame.length;
        this.nextIndex = 0;
      }
    }
  }

  retryLater() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pump();
      this.acknowledge();
    }, 20);
    this.retryTimer.unref?.();
  }

  keepalive() {
    if (this.failed || !this.canWrite()) return;
    this.write(Buffer.from([KEEPALIVE]));
    this.lastSent = Date.now();
  }

  // Acknowledgements are cumulative: one is written per quarter window
  // consumed, and only when the socket has room, so a stream of tiny frames
  // cannot pile them up. The sender stops at a full window, well past the
  // quarter, so it always gets one.
  acknowledge() {
    if (this.failed || this.consumed - this.ackedConsumed < WINDOW_BYTES / 4) return;
    if (!this.canWrite()) {
      this.retryLater();
      return;
    }
    this.ackedConsumed = this.consumed;
    this.write(ackMessage(this.consumed));
  }

  receive(bytes) {
    if (this.failed || !bytes.length) return;
    this.lastHeard = Date.now();
    const type = bytes[0];
    if (type === KEEPALIVE) return;
    if (type === ACK) {
      if (bytes.length !== 9) {
        this.fail(CODE.BAD_FRAME);
        return;
      }
      const consumed = Number(bytes.readBigUInt64BE(1));
      if (consumed >= this.ackedBytes && consumed <= this.sentBytes) {
        this.ackedBytes = consumed;
        this.pump();
      }
      return;
    }
    if (type !== PIECE || bytes.length < 5 + TAG_BYTES) {
      this.fail(CODE.BAD_FRAME);
      return;
    }
    const index = bytes.readUInt16BE(1);
    const count = bytes.readUInt16BE(3);
    const maxPieces = Math.max(1, Math.ceil(this.maxFrameBytes / PIECE_BYTES));
    if (count === 0 || count > maxPieces || index !== this.parts.length || (index > 0 && count !== this.partCount)) {
      this.fail(CODE.BAD_FRAME);
      return;
    }
    let plain;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.recvKey, counterNonce(this.recvCounter));
      decipher.setAAD(bytes.subarray(0, 5));
      decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
      plain = Buffer.concat([decipher.update(bytes.subarray(5, bytes.length - TAG_BYTES)), decipher.final()]);
    } catch {
      this.fail(CODE.BAD_FRAME);
      return;
    }
    this.recvCounter += 1;
    if (this.partBytes + plain.length > this.maxFrameBytes) {
      this.fail(CODE.BAD_FRAME);
      return;
    }
    if (this.budget && !this.budget.take(plain.length)) {
      this.fail(CODE.OVERLOAD);
      return;
    }
    this.parts.push(plain);
    this.partBytes += plain.length;
    this.partCount = count;
    this.lastPiece = Date.now();
    this.consumed += plain.length;
    let frame = null;
    if (this.parts.length === count) {
      frame = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
      this.releaseParts();
    }
    this.acknowledge();
    if (frame) this.onFrame(frame);
  }

  // Returns a close code when the channel is overdue, else null.
  overdue(now) {
    if (this.failed) return null;
    if (this.parts.length && now - this.lastPiece >= this.timing.stallMs) return CODE.OVERLOAD;
    if (now - this.lastHeard >= this.timing.silenceMs) return CODE.SILENT;
    return null;
  }

  releaseParts() {
    this.budget?.give(this.partBytes);
    this.parts = [];
    this.partBytes = 0;
    this.partCount = 0;
  }

  close() {
    this.failed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.releaseParts();
    this.queue = [];
    this.queuedBytes = 0;
  }

  fail(code) {
    if (this.failed) return;
    this.close();
    this.onFail(code);
  }
}

const envelope = (kind, id, body = Buffer.alloc(0)) => {
  const idBytes = Buffer.from(id, "utf8");
  const head = Buffer.alloc(3);
  head[0] = kind;
  head.writeUInt16BE(idBytes.length, 1);
  return Buffer.concat([head, idBytes, body]);
};

const readEnvelope = (bytes) => {
  if (bytes.length < 3) return null;
  const length = bytes.readUInt16BE(1);
  if (bytes.length < 3 + length) return null;
  return { kind: bytes[0], id: bytes.subarray(3, 3 + length).toString("utf8"), body: bytes.subarray(3 + length) };
};

const roomUrl = (server, roomId, params) => {
  const url = new URL(`/rooms/${roomId}`, server);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
};

// The socket's own limit: one piece plus its envelope, with room to spare.
const SOCKET_MAX_PAYLOAD = 2 * PIECE_BYTES;

const safeSend = (socket, data) => {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(data, { binary: typeof data !== "string" });
    return true;
  } catch {
    return false;
  }
};

const backoff = (attempt) => Math.min(5000, 500 * 2 ** Math.min(attempt, 4));

class RelayHostTransport extends EventEmitter {
  constructor({ server, roomId, secret, privateKey, token, viewToken = null, maxClients = MAX_CLIENTS }) {
    super();
    this.server = server;
    this.roomId = roomId;
    this.secret = secret;
    this.staticPrivate = privateKey;
    this.staticPublic = rawPublicKey(crypto.createPublicKey(privateKey));
    this.token = token;
    this.viewToken = viewToken;
    this.maxClients = maxClients;
    this.timing = { ...TIMING };
    this.socket = null;
    this.connected = false;
    this.closed = false;
    this.attempt = 0;
    this.timer = null;
    this.ticker = null;
    this.firstConnect = null;
    this.lastSocketHeard = 0;
    this.lastPing = 0;
    this.socketOpenedAt = 0;
    this.budget = createBudget(HOST_REASSEMBLY_BUDGET);
    // Relay connection id → conn, from PEER_OPEN until PEER_CLOSE; a conn
    // joins `connections` once its hello checks out.
    this.peers = new Map();
    this.connections = new Set();
  }

  // Resolves once the relay gave this host the room (HOST_READY). Later drops
  // reconnect on their own; every guest then makes a new channel.
  start() {
    this.ticker = setInterval(() => this.tick(), this.timing.tickMs);
    this.ticker.unref?.();
    return new Promise((resolve, reject) => {
      this.firstConnect = { resolve, reject };
      this.connect();
    });
  }

  connect() {
    if (this.closed) return;
    const WebSocket = require("ws");
    const socket = new WebSocket(roomUrl(this.server, this.roomId, { role: "host", secret: this.secret }), {
      maxPayload: SOCKET_MAX_PAYLOAD,
      perMessageDeflate: false,
      handshakeTimeout: 10000,
    });
    this.socket = socket;
    socket.on("open", () => {
      this.socketOpenedAt = Date.now();
      this.lastSocketHeard = Date.now();
      this.lastPing = Date.now();
    });
    socket.on("message", (data, isBinary) => {
      this.lastSocketHeard = Date.now();
      if (isBinary) this.onRelay(socket, toBuffer(data));
    });
    const onDown = (code, reasonBuffer) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connected = false;
      this.dropPeers();
      if (this.firstConnect) {
        this.firstConnect.reject(code === CODE.BUSY
          ? Object.assign(new Error("The collaboration relay holds too many sessions for this network."), { code: "COLLAB_RELAY_BUSY" })
          : Object.assign(new Error("Could not reach the collaboration relay."), { code: "COLLAB_RELAY_UNREACHABLE" }));
        this.firstConnect = null;
        this.close();
        return;
      }
      if (this.closed) return;
      this.emit("relay", { connected: false });
      // 4004: the relay no longer takes our secret; 4009: another host took
      // the seat. Neither gets better by retrying.
      if (code === 4004 || code === 4009) {
        this.emit("error", new Error(`collab relay refused the host (${code} ${reasonBuffer ? reasonBuffer.toString() : ""})`));
        return;
      }
      // 4029: this address holds too many rooms; ask again in a minute.
      this.schedule(code === CODE.BUSY ? 60000 : 0);
    };
    // The relay says why before it closes; act on that at once (its own
    // close can take seconds to finish).
    socket.refused = (code) => {
      onDown(code, Buffer.from("refused by the relay"));
      socket.terminate();
    };
    socket.on("close", onDown);
    socket.on("error", () => {
      if (!this.connected) onDown(1006, Buffer.from("connect failed"));
    });
  }

  schedule(minDelay = 0) {
    if (this.closed || this.timer) return;
    const delay = Math.max(minDelay, backoff(this.attempt));
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }

  tick(now = Date.now()) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    // A link that went silent (sleep, lost NAT mapping), or a relay that
    // never seats us, is dropped and redialled.
    if (now - this.lastSocketHeard >= this.timing.socketSilenceMs || (!this.connected && now - this.socketOpenedAt >= this.timing.handshakeMs)) {
      socket.terminate();
      return;
    }
    if (now - this.lastPing >= this.timing.keepaliveMs) {
      safeSend(socket, "ping");
      this.lastPing = now;
    }
    if (!this.connected) return;
    for (const conn of [...this.peers.values()]) {
      if (!conn.hello && now - conn.openedAt >= this.timing.handshakeMs) {
        this.closePeer(conn, CODE.HELLO_TIMEOUT);
        continue;
      }
      if (!conn.channel) continue;
      const overdue = conn.channel.overdue(now);
      if (overdue) {
        this.closePeer(conn, overdue);
        continue;
      }
      if (now - conn.channel.lastSent >= this.timing.keepaliveMs) conn.channel.keepalive();
    }
  }

  onRelay(socket, bytes) {
    const message = readEnvelope(bytes);
    if (!message) return;
    if (message.kind === REFUSED_HOST) {
      if (message.body.length >= 2) socket.refused(message.body.readUInt16BE(0));
      return;
    }
    if (message.kind === HOST_READY) {
      if (this.connected) return;
      this.connected = true;
      this.attempt = 0;
      if (this.firstConnect) {
        this.firstConnect.resolve(0);
        this.firstConnect = null;
      } else {
        this.emit("relay", { connected: true });
      }
      return;
    }
    if (message.kind === PEER_OPEN) {
      this.forgetPeer(message.id);
      this.peers.set(message.id, { id: null, peer: message.id, socket, hello: null, access: null, address: "relay", channel: null, openedAt: Date.now() });
      return;
    }
    const conn = this.peers.get(message.id);
    if (!conn) return;
    if (message.kind === PEER_CLOSE) {
      this.forgetPeer(message.id);
      return;
    }
    if (message.kind !== PEER_DATA) return;
    if (conn.channel) {
      conn.channel.receive(message.body);
      return;
    }
    this.handshake(conn, message.body);
  }

  handshake(conn, body) {
    if (body.length !== 1 + KEY_BYTES || body[0] !== HANDSHAKE_GUEST) {
      this.closePeer(conn, CODE.UNAUTHORIZED);
      return;
    }
    let keys;
    let hostEphemeral;
    try {
      const guestEphemeral = Buffer.from(body.subarray(1));
      const ephemeral = newKeyPair();
      hostEphemeral = rawPublicKey(ephemeral.publicKey);
      keys = deriveKeys({
        ee: dh(ephemeral.privateKey, guestEphemeral),
        es: dh(this.staticPrivate, guestEphemeral),
        hostStatic: this.staticPublic,
        guestEphemeral,
        hostEphemeral,
      });
    } catch {
      this.closePeer(conn, CODE.UNAUTHORIZED);
      return;
    }
    conn.channel = new Channel({
      sendKey: keys.toGuest,
      recvKey: keys.toHost,
      write: (bytes) => safeSend(this.socket, envelope(SEND, conn.peer, bytes)),
      canWrite: () => (this.socket?.bufferedAmount ?? 0) < SOCKET_HIGH_WATER,
      onFrame: (plain) => this.onChannelFrame(conn, plain),
      // Before the hello, any failure is a wrong link: 4004 makes the guest
      // give up instead of retrying.
      onFail: (code) => this.closePeer(conn, conn.hello ? code : CODE.UNAUTHORIZED),
      maxFrameBytes: PRE_HELLO_FRAME_BYTES,
      budget: this.budget,
      timing: this.timing,
    });
    safeSend(this.socket, envelope(SEND, conn.peer, Buffer.concat([Buffer.from([HANDSHAKE_HOST]), hostEphemeral])));
  }

  onChannelFrame(conn, plain) {
    const frame = decodeFrame(plain);
    if (conn.hello) {
      if (frame) this.emit("message", conn, frame);
      else this.closePeer(conn, CODE.BAD_FRAME);
      return;
    }
    const token = frame && frame.kind === FRAME_CONTROL && frame.message.type === "hello" ? frame.message.token : null;
    const access = typeof token === "string" && token === this.token ? "edit" : typeof token === "string" && this.viewToken && token === this.viewToken ? "view" : null;
    const clientId = access ? String(frame.message.clientId || "").slice(0, 64) : "";
    if (!access || !clientId) {
      this.closePeer(conn, CODE.UNAUTHORIZED);
      return;
    }
    if (this.connections.size >= this.maxClients) {
      this.closePeer(conn, CODE.FULL);
      return;
    }
    conn.hello = frame.message;
    conn.access = access;
    conn.id = clientId;
    conn.channel.maxFrameBytes = access === "view" ? VIEWER_FRAME_BYTES : MAX_FRAME_BYTES;
    this.connections.add(conn);
    this.emit("open", conn);
  }

  forgetPeer(peerId) {
    const conn = this.peers.get(peerId);
    if (!conn) return;
    this.peers.delete(peerId);
    conn.channel?.close();
    if (this.connections.delete(conn)) this.emit("close", conn);
  }

  closePeer(conn, code) {
    if (this.peers.get(conn.peer) !== conn) return;
    const reason = Buffer.alloc(2);
    reason.writeUInt16BE(code, 0);
    safeSend(this.socket, envelope(CLOSE_PEER, conn.peer, reason));
    this.forgetPeer(conn.peer);
  }

  // The relay link dropped: every guest is gone until it makes a new channel.
  dropPeers() {
    for (const peerId of [...this.peers.keys()]) this.forgetPeer(peerId);
  }

  send(conn, data) {
    if (!this.connections.has(conn)) return false;
    return conn.channel.enqueue(data);
  }

  broadcast(data, except = null) {
    for (const conn of [...this.connections]) {
      if (conn !== except) conn.channel.enqueue(data);
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.ticker);
    this.timer = null;
    this.ticker = null;
    const socket = this.socket;
    // 1000 tells each guest the session ended, as the LAN route does.
    for (const conn of [...this.peers.values()]) {
      const reason = Buffer.alloc(2);
      reason.writeUInt16BE(1000, 0);
      safeSend(socket, envelope(CLOSE_PEER, conn.peer, reason));
      conn.channel?.close();
    }
    this.peers.clear();
    this.connections.clear();
    this.socket = null;
    this.connected = false;
    if (socket) {
      try {
        socket.close(1000, "session ended");
      } catch {}
    }
  }
}

class RelayGuestTransport extends EventEmitter {
  constructor({ server, roomId, key, token, hello }) {
    super();
    this.url = roomUrl(server, roomId, { role: "guest" });
    this.hostStatic = Buffer.from(String(key || ""), "base64url");
    if (this.hostStatic.length !== KEY_BYTES) throw new Error("The host key must be 32 bytes.");
    this.token = token;
    this.hello = hello;
    this.timing = { ...TIMING };
    this.socket = null;
    this.closed = false;
    this.attempt = 0;
    this.timer = null;
    this.ticker = null;
    this.lastSocketHeard = 0;
    this.lastPing = 0;
    // idle → handshake (sent our key) → keyed (sent the hello) → connected
    // (the host's first frame opened: it holds the key from the link).
    this.phase = "idle";
    this.phaseSince = 0;
    this.ephemeral = null;
    this.channel = null;
    this.connected = false;
    this.conn = { id: "host", socket: null };
  }

  connect() {
    if (this.closed) return;
    if (!this.ticker) {
      this.ticker = setInterval(() => this.tick(), this.timing.tickMs);
      this.ticker.unref?.();
    }
    const WebSocket = require("ws");
    const socket = new WebSocket(this.url, { maxPayload: SOCKET_MAX_PAYLOAD, perMessageDeflate: false, handshakeTimeout: 10000 });
    this.socket = socket;
    socket.on("open", () => {
      this.attempt = 0;
      this.lastSocketHeard = Date.now();
      this.lastPing = Date.now();
    });
    socket.on("message", (data, isBinary) => {
      this.lastSocketHeard = Date.now();
      if (isBinary) this.onRelay(socket, toBuffer(data));
    });
    const onDown = (code, reasonBuffer) => {
      if (this.socket !== socket) return;
      this.socket = null;
      const reason = reasonBuffer ? reasonBuffer.toString() : "";
      this.resetChannel();
      this.hostGone(code, reason);
      // Refusals (4004 wrong link, 4005 full) and the host's 1000 are final.
      if (this.closed || code === 4004 || code === 4005 || code === 1000) {
        if (!this.closed) this.emit("gaveUp", { code, reason });
        return;
      }
      // 4010: no host in the room yet; ask again less often.
      this.schedule(code === 4010 ? 15000 : 0);
    };
    socket.refused = (code) => {
      onDown(code, Buffer.from("refused by the relay"));
      socket.terminate();
    };
    socket.on("close", onDown);
    socket.on("error", () => {
      if (socket.readyState !== 1) onDown(1006, Buffer.from("connect failed"));
    });
  }

  onRelay(socket, bytes) {
    if (!bytes.length) return;
    if (bytes[0] === REFUSED) {
      if (bytes.length >= 3) socket.refused(bytes.readUInt16BE(1));
      return;
    }
    if (bytes[0] === HOST_OPEN) {
      // A host that (re)joined the room knows nothing of us yet.
      this.hostGone(1006, "host reconnected");
      this.resetChannel();
      this.ephemeral = newKeyPair();
      this.phase = "handshake";
      this.phaseSince = Date.now();
      safeSend(socket, Buffer.concat([Buffer.from([HANDSHAKE_GUEST]), rawPublicKey(this.ephemeral.publicKey)]));
      return;
    }
    if (bytes[0] === HOST_GONE) {
      this.resetChannel();
      if (this.hostGone(1006, "host away")) this.emit("reconnecting", { attempt: 0, delay: 0 });
      return;
    }
    if (bytes[0] !== HOST_DATA) return;
    const body = bytes.subarray(1);
    if (this.phase === "keyed") {
      this.channel.receive(body);
      return;
    }
    if (this.phase !== "handshake") return;
    if (body.length !== 1 + KEY_BYTES || body[0] !== HANDSHAKE_HOST) {
      this.drop();
      return;
    }
    let keys;
    try {
      const guestEphemeral = rawPublicKey(this.ephemeral.publicKey);
      const hostEphemeral = Buffer.from(body.subarray(1));
      keys = deriveKeys({
        ee: dh(this.ephemeral.privateKey, hostEphemeral),
        es: dh(this.ephemeral.privateKey, this.hostStatic),
        hostStatic: this.hostStatic,
        guestEphemeral,
        hostEphemeral,
      });
    } catch {
      this.drop();
      return;
    }
    this.ephemeral = null;
    this.channel = new Channel({
      sendKey: keys.toHost,
      recvKey: keys.toGuest,
      write: (out) => safeSend(socket, out),
      canWrite: () => socket.bufferedAmount < SOCKET_HIGH_WATER,
      onFrame: (plain) => this.onChannelFrame(plain),
      onFail: () => this.drop(),
      timing: this.timing,
    });
    this.phase = "keyed";
    this.channel.enqueue(encodeControl({ type: "hello", token: this.token, ...this.hello }));
  }

  onChannelFrame(plain) {
    const frame = decodeFrame(plain);
    if (!frame) {
      this.drop();
      return;
    }
    if (!this.connected) {
      this.connected = true;
      this.conn.socket = this.socket;
      this.emit("open", this.conn);
    }
    this.emit("message", this.conn, frame);
  }

  tick(now = Date.now()) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    if (now - this.lastSocketHeard >= this.timing.socketSilenceMs) {
      socket.terminate();
      return;
    }
    if (now - this.lastPing >= this.timing.keepaliveMs) {
      safeSend(socket, "ping");
      this.lastPing = now;
    }
    if (this.phase !== "idle" && !this.connected && now - this.phaseSince >= this.timing.handshakeMs) {
      this.drop();
      return;
    }
    if (!this.channel) return;
    if (this.channel.overdue(now)) {
      this.drop();
      return;
    }
    if (now - this.channel.lastSent >= this.timing.keepaliveMs) this.channel.keepalive();
  }

  // Something on this connection cannot be trusted or is stuck: start over
  // with a new socket (and so a new channel and a resync).
  drop() {
    this.resetChannel();
    this.socket?.terminate();
  }

  resetChannel() {
    this.channel?.close();
    this.channel = null;
    this.ephemeral = null;
    this.phase = "idle";
  }

  // Returns true when this ended a live connection to the host.
  hostGone(code, reason) {
    if (!this.connected) return false;
    this.connected = false;
    this.emit("close", this.conn, { code, reason });
    return true;
  }

  schedule(minDelay = 0) {
    if (this.closed || this.timer) return;
    const delay = Math.max(minDelay, backoff(this.attempt));
    this.attempt += 1;
    this.emit("reconnecting", { attempt: this.attempt, delay });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }

  send(_conn, data) {
    if (!this.connected || !this.channel) return false;
    return this.channel.enqueue(data);
  }

  broadcast(data) {
    this.send(this.conn, data);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.ticker);
    this.timer = null;
    this.ticker = null;
    this.resetChannel();
    this.connected = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, "left");
      } catch {}
    }
  }
}

module.exports = {
  PIECE_BYTES,
  WINDOW_BYTES,
  TIMING,
  CODE,
  Channel,
  createBudget,
  deriveKeys,
  rawPublicKey,
  RelayHostTransport,
  RelayGuestTransport,
};
