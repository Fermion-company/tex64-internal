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
// channel is closed, so the guest reconnects and resyncs.
//
// A channel has two lanes. File bytes (blob frames) go in the bulk lane;
// everything else — edits, presence, control — in the urgent lane, which is
// served first, so typing is not stuck behind a 50 MB figure. Each lane keeps
// to its own window of unacknowledged bytes (the receiver acknowledges every
// ACK_EVERY bytes it consumed), and the bulk window is small, so the relay
// never holds much file data in front of an edit. The socket is kept short
// too (SOCKET_HIGH_WATER): on a 1 MB/s uplink nothing waits long in it. The
// host sends one piece per guest in turn. See docs/collab-relay.md.
//
// The two transports keep the interface of HostTransport / GuestTransport, so
// the hub does not know which route a session uses.

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { decodeFrame, encodeControl, FRAME_BLOB, FRAME_CONTROL, MAX_FRAME_BYTES, MAX_CLIENTS } = require("./transport-ws.cjs");

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
const PIECE = 0x03; // · lane u8 · index u16 · count u16 · sealed piece (the 6-byte head is the AAD)
const ACK = 0x04; // · plaintext bytes consumed so far per lane (urgent u64 · bulk u64)
const KEEPALIVE = 0x05;

const URGENT = 0;
const BULK = 1;
const PIECE_HEAD = 6;
const PIECE_BYTES = 256 * 1024;
// TLS and the WebSocket upgrade took ~7 s on a slow network; 10 s left no margin.
const HANDSHAKE_TIMEOUT_MS = 20000;
// Unacknowledged bytes per lane: room for edits, and little file data in flight.
const WINDOW_BYTES = [4 * 1024 * 1024, 1024 * 1024];
const ACK_EVERY = 256 * 1024;
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
// The host's one relay socket carries every guest's channel; a short queue
// keeps a ping or an edit from waiting behind seconds of file data.
const SOCKET_HIGH_WATER = 1024 * 1024;

// Tests shorten these.
const TIMING = {
  tickMs: 5000,
  keepaliveMs: 25000, // send something at least this often (relay ping, channel keepalive)
  socketSilenceMs: 60000, // nothing from the relay for this long: the socket is dead
  silenceMs: 75000, // nothing from the other end of a channel for this long: it is gone
  handshakeMs: 15000, // from PEER_OPEN / HOST_OPEN to an authenticated channel
  stallMs: 60000, // a partial frame with no new piece for this long
  bulkTurnMs: 1000, // file data gets a send turn at least this often, however busy the urgent lane
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
  const out = Buffer.alloc(17);
  out[0] = ACK;
  out.writeBigUInt64BE(BigInt(consumed[URGENT]), 1);
  out.writeBigUInt64BE(BigInt(consumed[BULK]), 9);
  return out;
};

const laneOf = (frame) => (frame[0] === FRAME_BLOB ? BULK : URGENT);

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

// One direction pair of an authenticated channel: queues frames in two lanes,
// cuts and seals them within each lane's window, and opens and joins what
// arrives. `wake` asks for a send turn (the host's transport runs turns for
// all its guests); on its own the channel sends as much as it may.
class Channel {
  constructor({ sendKey, recvKey, write, onFrame, onFail, canWrite = () => true, wake = null, maxFrameBytes = MAX_FRAME_BYTES, budget = null, timing = TIMING, clock = Date.now }) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.write = write;
    this.onFrame = onFrame;
    this.onFail = onFail;
    this.canWrite = canWrite;
    this.wake = wake || (() => this.pump());
    this.maxFrameBytes = maxFrameBytes;
    this.budget = budget;
    this.timing = timing;
    this.clock = clock;
    this.failed = false;
    this.queues = [[], []];
    this.lastBulkTurn = clock();
    this.queuedBytes = 0;
    this.nextIndex = [0, 0];
    this.sendCounter = 0;
    this.sent = [0, 0];
    this.acked = [0, 0];
    this.retryTimer = null;
    this.recvCounter = 0;
    this.incoming = [this.emptyIncoming(), this.emptyIncoming()];
    this.consumed = [0, 0];
    this.ackedConsumed = [0, 0];
    this.ackPending = false;
    this.lastSent = Date.now();
    this.lastHeard = Date.now();
  }

  emptyIncoming() {
    return { parts: [], bytes: 0, count: 0, lastPiece: 0 };
  }

  // `slot` names what the frame carries (a file) and `version` which state
  // of it (its hash): when the last frame queued for the slot — still waiting
  // or on its way — is the same version, another is not added. A newer
  // version, or going back to an older one, is always queued behind it.
  enqueue(frame, slot = null, version = null) {
    if (this.failed) return false;
    if (slot && this.lastQueued(slot)?.version === version) return true;
    const bytes = Buffer.isBuffer(frame) ? frame : Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    if (this.queuedBytes + bytes.length > MAX_QUEUED_BYTES) {
      this.fail(CODE.OVERLOAD);
      return false;
    }
    this.queues[laneOf(bytes)].push({ bytes, slot, version });
    this.queuedBytes += bytes.length;
    this.wake();
    return true;
  }

  lastQueued(slot) {
    for (const queue of this.queues) {
      for (let index = queue.length - 1; index >= 0; index -= 1) if (queue[index].slot === slot) return queue[index];
    }
    return null;
  }

  // Writes one piece if a lane's window and the socket allow. The urgent lane
  // goes first, except that file data gets a turn every bulkTurnMs, so a long
  // run of edits cannot stall a half-sent figure. Returns whether it wrote.
  sendOne() {
    if (this.failed || !this.canWrite()) return false;
    const now = this.clock();
    const order = now - this.lastBulkTurn >= this.timing.bulkTurnMs ? [BULK, URGENT] : [URGENT, BULK];
    for (const lane of order) {
      const queue = this.queues[lane];
      if (!queue.length) continue;
      const frame = queue[0].bytes;
      const count = Math.max(1, Math.ceil(frame.length / PIECE_BYTES));
      const index = this.nextIndex[lane];
      const piece = frame.subarray(index * PIECE_BYTES, (index + 1) * PIECE_BYTES);
      const inFlight = this.sent[lane] - this.acked[lane];
      if (inFlight > 0 && inFlight + piece.length > WINDOW_BYTES[lane]) continue;
      const head = Buffer.alloc(PIECE_HEAD);
      head[0] = PIECE;
      head[1] = lane;
      head.writeUInt16BE(index, 2);
      head.writeUInt16BE(count, 4);
      const cipher = crypto.createCipheriv("aes-256-gcm", this.sendKey, counterNonce(this.sendCounter));
      this.sendCounter += 1;
      cipher.setAAD(head);
      this.write(Buffer.concat([head, cipher.update(piece), cipher.final(), cipher.getAuthTag()]));
      this.lastSent = Date.now();
      if (lane === BULK) this.lastBulkTurn = now;
      this.sent[lane] += piece.length;
      if (index + 1 < count) {
        this.nextIndex[lane] = index + 1;
      } else {
        queue.shift();
        this.queuedBytes -= frame.length;
        this.nextIndex[lane] = 0;
      }
      return true;
    }
    return false;
  }

  // Whether a piece could go out once the socket has room.
  hasWork() {
    if (this.failed) return false;
    if (this.ackPending) return true;
    return [URGENT, BULK].some((lane) => {
      if (!this.queues[lane].length) return false;
      const inFlight = this.sent[lane] - this.acked[lane];
      return inFlight === 0 || inFlight + Math.min(PIECE_BYTES, this.queues[lane][0].bytes.length) <= WINDOW_BYTES[lane];
    });
  }

  pump() {
    this.flushAck();
    while (this.sendOne());
    if (this.hasWork() && !this.canWrite()) this.retryLater();
  }

  retryLater() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, 20);
    this.retryTimer.unref?.();
  }

  keepalive() {
    if (this.failed || !this.canWrite()) return;
    this.write(Buffer.from([KEEPALIVE]));
    this.lastSent = Date.now();
  }

  // Acknowledgements are cumulative: one is due per ACK_EVERY bytes consumed
  // in a lane, and it is written only when the socket has room, so a stream
  // of tiny frames cannot pile them up. Each lane's sender stops at a full
  // window, past ACK_EVERY, so it always gets one.
  acknowledge() {
    if (this.failed) return;
    if (this.consumed.some((consumed, lane) => consumed - this.ackedConsumed[lane] >= ACK_EVERY)) this.ackPending = true;
    if (!this.ackPending) return;
    if (!this.flushAck()) this.wake();
  }

  flushAck() {
    if (this.failed || !this.ackPending || !this.canWrite()) return false;
    this.ackPending = false;
    this.ackedConsumed = [...this.consumed];
    this.write(ackMessage(this.consumed));
    return true;
  }

  receive(bytes) {
    if (this.failed || !bytes.length) return;
    this.lastHeard = Date.now();
    const type = bytes[0];
    if (type === KEEPALIVE) return;
    if (type === ACK) {
      if (bytes.length !== 17) {
        this.fail(CODE.BAD_FRAME);
        return;
      }
      [URGENT, BULK].forEach((lane) => {
        const consumed = Number(bytes.readBigUInt64BE(1 + 8 * lane));
        if (consumed >= this.acked[lane] && consumed <= this.sent[lane]) this.acked[lane] = consumed;
      });
      this.wake();
      return;
    }
    if (type !== PIECE || bytes.length < PIECE_HEAD + TAG_BYTES || bytes[1] > BULK) {
      this.fail(CODE.BAD_FRAME);
      return;
    }
    const lane = bytes[1];
    const incoming = this.incoming[lane];
    const index = bytes.readUInt16BE(2);
    const count = bytes.readUInt16BE(4);
    const maxPieces = Math.max(1, Math.ceil(this.maxFrameBytes / PIECE_BYTES));
    if (count === 0 || count > maxPieces || index !== incoming.parts.length || (index > 0 && count !== incoming.count)) {
      this.fail(CODE.BAD_FRAME);
      return;
    }
    let plain;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.recvKey, counterNonce(this.recvCounter));
      decipher.setAAD(bytes.subarray(0, PIECE_HEAD));
      decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
      plain = Buffer.concat([decipher.update(bytes.subarray(PIECE_HEAD, bytes.length - TAG_BYTES)), decipher.final()]);
    } catch {
      this.fail(CODE.BAD_FRAME);
      return;
    }
    this.recvCounter += 1;
    if (incoming.bytes + plain.length > this.maxFrameBytes) {
      this.fail(CODE.BAD_FRAME);
      return;
    }
    if (this.budget && !this.budget.take(plain.length)) {
      this.fail(CODE.OVERLOAD);
      return;
    }
    incoming.parts.push(plain);
    incoming.bytes += plain.length;
    incoming.count = count;
    incoming.lastPiece = Date.now();
    this.consumed[lane] += plain.length;
    let frame = null;
    if (incoming.parts.length === count) {
      frame = incoming.parts.length === 1 ? incoming.parts[0] : Buffer.concat(incoming.parts);
      this.releaseParts(lane);
    }
    this.acknowledge();
    if (frame) this.onFrame(frame);
  }

  // Returns a close code when the channel is overdue, else null.
  overdue(now) {
    if (this.failed) return null;
    if (this.incoming.some((incoming) => incoming.parts.length && now - incoming.lastPiece >= this.timing.stallMs)) return CODE.OVERLOAD;
    if (now - this.lastHeard >= this.timing.silenceMs) return CODE.SILENT;
    return null;
  }

  releaseParts(lane) {
    this.budget?.give(this.incoming[lane].bytes);
    this.incoming[lane] = this.emptyIncoming();
  }

  close() {
    this.failed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.releaseParts(URGENT);
    this.releaseParts(BULK);
    this.queues = [[], []];
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
    this.turn = 0;
    this.flushTimer = null;
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
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
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
      canWrite: () => this.canWrite(),
      wake: () => this.flush(),
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

  canWrite() {
    return Boolean(this.socket) && this.socket.readyState === 1 && this.socket.bufferedAmount < SOCKET_HIGH_WATER;
  }

  // Send turns for every guest's channel: one piece each, in rotation, while
  // the socket has room, so one guest's figure does not crowd out the rest.
  flush() {
    const channels = [...this.peers.values()].map((conn) => conn.channel).filter((channel) => channel && !channel.failed);
    if (!channels.length) return;
    let wrote = true;
    while (wrote) {
      wrote = false;
      for (let offset = 0; offset < channels.length; offset += 1) {
        if (!this.canWrite()) {
          this.turn = (this.turn + offset) % channels.length;
          if (channels.some((channel) => channel.hasWork())) this.flushLater();
          return;
        }
        const channel = channels[(this.turn + offset) % channels.length];
        const acknowledged = channel.flushAck();
        const sent = channel.sendOne();
        if (acknowledged || sent) wrote = true;
      }
      this.turn = (this.turn + 1) % channels.length;
    }
  }

  flushLater() {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 20);
    this.flushTimer.unref?.();
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

  // options.slot / options.version: see Channel.enqueue (the LAN route ignores them).
  send(conn, data, options = {}) {
    if (!this.connections.has(conn)) return false;
    return conn.channel.enqueue(data, options.slot, options.version);
  }

  broadcast(data, except = null, options = {}) {
    for (const conn of [...this.connections]) {
      if (conn !== except) conn.channel.enqueue(data, options.slot, options.version);
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.ticker);
    clearTimeout(this.flushTimer);
    this.timer = null;
    this.ticker = null;
    this.flushTimer = null;
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
    const socket = new WebSocket(this.url, { maxPayload: SOCKET_MAX_PAYLOAD, perMessageDeflate: false, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
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

  send(_conn, data, options = {}) {
    if (!this.connected || !this.channel) return false;
    return this.channel.enqueue(data, options.slot, options.version);
  }

  broadcast(data, _except = null, options = {}) {
    this.send(this.conn, data, options);
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
  ACK_EVERY,
  URGENT,
  BULK,
  TIMING,
  CODE,
  Channel,
  createBudget,
  deriveKeys,
  rawPublicKey,
  RelayHostTransport,
  RelayGuestTransport,
};
