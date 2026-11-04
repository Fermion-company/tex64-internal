"use strict";

// The internet route for a session: the host and every guest dial out to the
// collab relay (services/collab-relay), which pairs them up by room and moves
// bytes. Each frame is sealed end to end with the room key from the invite
// link (AES-256-GCM, a fresh nonce per message), so the relay sees only who is
// connected and how long each message is. Sealed messages larger than one
// relay message are cut into pieces:  msgId(u32) · index(u16) · count(u16) · piece.
// The two classes keep the interface of HostTransport / GuestTransport, so the
// hub does not know which route a session uses. See docs/collab-relay.md.

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { decodeFrame, encodeControl, FRAME_CONTROL, MAX_FRAME_BYTES, MAX_CLIENTS } = require("./transport-ws.cjs");

// Relay envelopes; services/collab-relay/room.mjs has the other side.
const SEND = 0x01;
const CLOSE_PEER = 0x03;
const PEER_OPEN = 0x11;
const PEER_DATA = 0x12;
const PEER_CLOSE = 0x13;
const HOST_DATA = 0x21;
const HOST_OPEN = 0x22;
const HOST_GONE = 0x23;

const PIECE_BYTES = 512 * 1024;
const PIECE_HEADER = 8;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_SEALED_BYTES = MAX_FRAME_BYTES + NONCE_BYTES + TAG_BYTES;
// Each direction has its own associated data, so the relay cannot reflect a
// host's message back to it as if a guest had sent it.
const AAD_TO_GUEST = Buffer.from("tex64-collab-relay-v1 host>guest");
const AAD_TO_HOST = Buffer.from("tex64-collab-relay-v1 guest>host");

const toBuffer = (data) => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));

const seal = (key, aad, plain) => {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
};

// Returns the plaintext, or null when the message was not sealed with this key.
const unseal = (key, aad, sealed) => {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, sealed.subarray(0, NONCE_BYTES));
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
};

class Sealer {
  constructor(key, aad) {
    this.key = key;
    this.aad = aad;
    this.msgId = 0;
  }

  // One frame → the relay messages that carry it, in order.
  pieces(frame) {
    const sealed = seal(this.key, this.aad, frame);
    this.msgId = (this.msgId + 1) >>> 0;
    const count = Math.max(1, Math.ceil(sealed.length / PIECE_BYTES));
    const out = [];
    for (let index = 0; index < count; index += 1) {
      const head = Buffer.alloc(PIECE_HEADER);
      head.writeUInt32BE(this.msgId, 0);
      head.writeUInt16BE(index, 4);
      head.writeUInt16BE(count, 6);
      out.push(Buffer.concat([head, sealed.subarray(index * PIECE_BYTES, (index + 1) * PIECE_BYTES)]));
    }
    return out;
  }
}

// A sender's pieces arrive in order and never interleave, so one partial
// message per sender is enough; anything out of order drops it.
class Reassembler {
  constructor() {
    this.reset();
  }

  reset() {
    this.msgId = -1;
    this.count = 0;
    this.parts = [];
    this.size = 0;
  }

  // Returns the whole sealed message once its last piece is in, else null.
  push(bytes) {
    if (bytes.length < PIECE_HEADER) return null;
    const msgId = bytes.readUInt32BE(0);
    const index = bytes.readUInt16BE(4);
    const count = bytes.readUInt16BE(6);
    if (count === 0 || index >= count) {
      this.reset();
      return null;
    }
    if (index === 0) {
      this.reset();
      this.msgId = msgId;
      this.count = count;
    } else if (msgId !== this.msgId || count !== this.count || index !== this.parts.length) {
      this.reset();
      return null;
    }
    const piece = bytes.subarray(PIECE_HEADER);
    this.size += piece.length;
    if (this.size > MAX_SEALED_BYTES) {
      this.reset();
      return null;
    }
    this.parts.push(piece);
    if (this.parts.length < this.count) return null;
    const whole = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
    this.reset();
    return whole;
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

const keyBytes = (key) => {
  const bytes = Buffer.isBuffer(key) ? key : Buffer.from(String(key || ""), "base64url");
  if (bytes.length !== 32) throw new Error("The room key must be 32 bytes.");
  return bytes;
};

// The socket's own limit: one piece plus its envelope, with room to spare.
const SOCKET_MAX_PAYLOAD = 2 * PIECE_BYTES;

const safeSend = (socket, data) => {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(data, { binary: true });
    return true;
  } catch {
    return false;
  }
};

const backoff = (attempt) => Math.min(5000, 500 * 2 ** Math.min(attempt, 4));

class RelayHostTransport extends EventEmitter {
  constructor({ server, roomId, key, secret, token, viewToken = null, maxClients = MAX_CLIENTS }) {
    super();
    this.server = server;
    this.roomId = roomId;
    this.key = keyBytes(key);
    this.secret = secret;
    this.token = token;
    this.viewToken = viewToken;
    this.maxClients = maxClients;
    this.socket = null;
    this.connected = false;
    this.closed = false;
    this.attempt = 0;
    this.timer = null;
    this.firstConnect = null;
    // Relay connection id → conn, from PEER_OPEN until PEER_CLOSE; a conn
    // joins `connections` once its hello checks out.
    this.peers = new Map();
    this.connections = new Set();
    this.sealer = new Sealer(this.key, AAD_TO_GUEST);
  }

  // Resolves once the relay gave this host the room. Later drops reconnect on
  // their own; every guest then says hello again.
  start() {
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
      this.attempt = 0;
      this.connected = true;
      if (this.firstConnect) {
        this.firstConnect.resolve(0);
        this.firstConnect = null;
      } else {
        this.emit("relay", { connected: true });
      }
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) this.onRelay(socket, toBuffer(data));
    });
    const onDown = (code, reasonBuffer) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connected = false;
      this.dropPeers();
      if (this.firstConnect) {
        this.firstConnect.reject(Object.assign(new Error("Could not reach the collaboration relay."), { code: "COLLAB_RELAY_UNREACHABLE" }));
        this.firstConnect = null;
        this.closed = true;
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
      this.schedule();
    };
    socket.on("close", onDown);
    socket.on("error", () => {
      if (!this.connected) onDown(1006, Buffer.from("connect failed"));
    });
  }

  schedule() {
    if (this.closed || this.timer) return;
    const delay = backoff(this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }

  onRelay(socket, bytes) {
    const message = readEnvelope(bytes);
    if (!message) return;
    if (message.kind === PEER_OPEN) {
      this.forgetPeer(message.id);
      const conn = { id: null, peer: message.id, socket, hello: null, access: null, address: "relay", reassembler: new Reassembler(), helloTimer: null };
      conn.helloTimer = setTimeout(() => {
        if (!conn.hello) this.closePeer(conn, 4001);
      }, 10000);
      conn.helloTimer.unref?.();
      this.peers.set(message.id, conn);
      return;
    }
    const conn = this.peers.get(message.id);
    if (!conn) return;
    if (message.kind === PEER_CLOSE) {
      this.forgetPeer(message.id);
      return;
    }
    if (message.kind !== PEER_DATA) return;
    const sealed = conn.reassembler.push(message.body);
    if (!sealed) return;
    const plain = unseal(this.key, AAD_TO_HOST, sealed);
    const frame = plain ? decodeFrame(plain) : null;
    if (!conn.hello) {
      // A hello that does not open with the room key is a wrong link, not a
      // network fault: 4004 makes the guest give up instead of retrying.
      clearTimeout(conn.helloTimer);
      const token = frame && frame.kind === FRAME_CONTROL && frame.message.type === "hello" ? frame.message.token : null;
      const access = typeof token === "string" && token === this.token ? "edit" : typeof token === "string" && this.viewToken && token === this.viewToken ? "view" : null;
      const clientId = access ? String(frame.message.clientId || "").slice(0, 64) : "";
      if (!access || !clientId) {
        this.closePeer(conn, 4004);
        return;
      }
      if (this.connections.size >= this.maxClients) {
        this.closePeer(conn, 4005);
        return;
      }
      conn.hello = frame.message;
      conn.access = access;
      conn.id = clientId;
      this.connections.add(conn);
      this.emit("open", conn);
      return;
    }
    if (!frame) {
      this.closePeer(conn, 4003);
      return;
    }
    this.emit("message", conn, frame);
  }

  forgetPeer(peerId) {
    const conn = this.peers.get(peerId);
    if (!conn) return;
    this.peers.delete(peerId);
    clearTimeout(conn.helloTimer);
    if (this.connections.delete(conn)) this.emit("close", conn);
  }

  closePeer(conn, code) {
    const reason = Buffer.alloc(2);
    reason.writeUInt16BE(code, 0);
    safeSend(this.socket, envelope(CLOSE_PEER, conn.peer, reason));
    this.forgetPeer(conn.peer);
  }

  // The relay link dropped: every guest is gone until it says hello again.
  dropPeers() {
    for (const peerId of [...this.peers.keys()]) this.forgetPeer(peerId);
  }

  sendPieces(conn, pieces) {
    let ok = true;
    for (const piece of pieces) ok = safeSend(this.socket, envelope(SEND, conn.peer, piece)) && ok;
    return ok;
  }

  send(conn, data) {
    if (!this.connections.has(conn)) return false;
    return this.sendPieces(conn, this.sealer.pieces(data));
  }

  broadcast(data, except = null) {
    if (!this.connections.size) return;
    const pieces = this.sealer.pieces(data);
    for (const conn of this.connections) {
      if (conn !== except) this.sendPieces(conn, pieces);
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    // 1000 tells each guest the session ended, as the LAN route does.
    for (const conn of [...this.peers.values()]) {
      const reason = Buffer.alloc(2);
      reason.writeUInt16BE(1000, 0);
      safeSend(socket, envelope(CLOSE_PEER, conn.peer, reason));
      clearTimeout(conn.helloTimer);
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
    this.key = keyBytes(key);
    this.token = token;
    this.hello = hello;
    this.socket = null;
    this.closed = false;
    this.attempt = 0;
    this.timer = null;
    // Connected means the host is there, not just the relay.
    this.connected = false;
    this.conn = { id: "host", socket: null };
    this.sealer = new Sealer(this.key, AAD_TO_HOST);
    this.reassembler = new Reassembler();
  }

  connect() {
    if (this.closed) return;
    const WebSocket = require("ws");
    const socket = new WebSocket(this.url, { maxPayload: SOCKET_MAX_PAYLOAD, perMessageDeflate: false, handshakeTimeout: 10000 });
    this.socket = socket;
    socket.on("open", () => {
      this.attempt = 0;
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) this.onRelay(socket, toBuffer(data));
    });
    const onDown = (code, reasonBuffer) => {
      if (this.socket !== socket) return;
      this.socket = null;
      const reason = reasonBuffer ? reasonBuffer.toString() : "";
      this.hostGone(code, reason);
      // Refusals (4004 wrong link, 4005 full) and the host's 1000 are final.
      if (this.closed || code === 4004 || code === 4005 || code === 1000) {
        if (!this.closed) this.emit("gaveUp", { code, reason });
        return;
      }
      this.schedule();
    };
    socket.on("close", onDown);
    socket.on("error", () => {
      if (socket.readyState !== 1) onDown(1006, Buffer.from("connect failed"));
    });
  }

  onRelay(socket, bytes) {
    if (!bytes.length) return;
    if (bytes[0] === HOST_OPEN) {
      // A host that (re)joined the room knows nothing of us yet.
      this.hostGone(1006, "host reconnected");
      this.reassembler.reset();
      this.conn.socket = socket;
      for (const piece of this.sealer.pieces(this.helloFrame())) safeSend(socket, piece);
      this.connected = true;
      this.emit("open", this.conn);
      return;
    }
    if (bytes[0] === HOST_GONE) {
      if (this.hostGone(1006, "host away")) this.emit("reconnecting", { attempt: 0, delay: 0 });
      return;
    }
    if (bytes[0] !== HOST_DATA || !this.connected) return;
    const sealed = this.reassembler.push(bytes.subarray(1));
    if (!sealed) return;
    const plain = unseal(this.key, AAD_TO_GUEST, sealed);
    const frame = plain ? decodeFrame(plain) : null;
    if (frame) this.emit("message", this.conn, frame);
  }

  helloFrame() {
    return encodeControl({ type: "hello", token: this.token, ...this.hello });
  }

  // Returns true when this ended a live connection to the host.
  hostGone(code, reason) {
    if (!this.connected) return false;
    this.connected = false;
    this.emit("close", this.conn, { code, reason });
    return true;
  }

  schedule() {
    if (this.closed || this.timer) return;
    const delay = backoff(this.attempt);
    this.attempt += 1;
    this.emit("reconnecting", { attempt: this.attempt, delay });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }

  send(_conn, data) {
    if (!this.connected) return false;
    let ok = true;
    for (const piece of this.sealer.pieces(data)) ok = safeSend(this.socket, piece) && ok;
    return ok;
  }

  broadcast(data) {
    this.send(this.conn, data);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
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
  seal,
  unseal,
  Sealer,
  Reassembler,
  RelayHostTransport,
  RelayGuestTransport,
};
