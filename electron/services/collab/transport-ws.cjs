"use strict";

// Wire transport for a session. The host runs a plain `ws` server (LAN / VPN
// reach, no TLS yet); guests connect with a reconnecting client. Every frame
// is binary:  kind(u8) · docId(varString) · payload   for sync/awareness,
//             kind(u8) · json(varString)              for control,
//             kind(u8) · path · hash · bytes          for blobs.
// The first frame on a connection must be a `hello` control frame carrying
// the session token; anything else closes the socket.

const { EventEmitter } = require("node:events");
const net = require("node:net");
const encoding = require("lib0/encoding");
const decoding = require("lib0/decoding");

const FRAME_SYNC = 0;
const FRAME_AWARENESS = 1;
const FRAME_CONTROL = 2;
const FRAME_BLOB = 3;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_CLIENTS = 10;

const encodeDocFrame = (kind, docId, payload) => {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, kind);
  encoding.writeVarString(encoder, docId);
  encoding.writeUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
};

const encodeControl = (message) => {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, FRAME_CONTROL);
  encoding.writeVarString(encoder, JSON.stringify(message));
  return encoding.toUint8Array(encoder);
};

const encodeBlob = (relativePath, hash, bytes) => {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, FRAME_BLOB);
  encoding.writeVarString(encoder, relativePath);
  encoding.writeVarString(encoder, hash);
  encoding.writeVarUint8Array(encoder, bytes);
  return encoding.toUint8Array(encoder);
};

// Returns { kind, docId?, payload?, message?, path?, hash?, bytes? } or null.
const decodeFrame = (data) => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) return null;
  try {
    const decoder = decoding.createDecoder(bytes);
    const kind = decoding.readUint8(decoder);
    if (kind === FRAME_SYNC || kind === FRAME_AWARENESS) {
      const docId = decoding.readVarString(decoder);
      const payload = bytes.subarray(decoder.pos);
      return { kind, docId, payload };
    }
    if (kind === FRAME_CONTROL) {
      const text = decoding.readVarString(decoder);
      const message = JSON.parse(text);
      if (!message || typeof message !== "object" || typeof message.type !== "string") return null;
      return { kind, message };
    }
    if (kind === FRAME_BLOB) {
      const relativePath = decoding.readVarString(decoder);
      const hash = decoding.readVarString(decoder);
      const blob = decoding.readVarUint8Array(decoder);
      return { kind, path: relativePath, hash, bytes: blob };
    }
  } catch {
    return null;
  }
  return null;
};

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "0.0.0.0", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const safeSend = (socket, data) => {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(data, { binary: true });
    return true;
  } catch {
    return false;
  }
};

class HostTransport extends EventEmitter {
  constructor({ token, maxClients = MAX_CLIENTS }) {
    super();
    this.token = token;
    this.maxClients = maxClients;
    this.server = null;
    this.port = 0;
    this.connections = new Set();
  }

  async start() {
    const { WebSocketServer } = require("ws");
    const port = await findFreePort();
    this.server = new WebSocketServer({ host: "0.0.0.0", port, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      this.server.once("listening", resolve);
      this.server.once("error", reject);
    });
    this.port = port;
    this.server.on("connection", (socket, request) => this.accept(socket, request));
    this.server.on("error", (error) => this.emit("error", error));
    return port;
  }

  accept(socket, request) {
    const conn = { id: null, socket, hello: null, address: request?.socket?.remoteAddress || "" };
    const helloTimer = setTimeout(() => {
      if (!conn.hello) socket.close(4001, "hello timeout");
    }, 5000);
    helloTimer.unref?.();
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        socket.close(4002, "binary frames only");
        return;
      }
      const frame = decodeFrame(data);
      if (!frame) {
        socket.close(4003, "bad frame");
        return;
      }
      if (!conn.hello) {
        clearTimeout(helloTimer);
        if (frame.kind !== FRAME_CONTROL || frame.message.type !== "hello" || frame.message.token !== this.token) {
          socket.close(4004, "unauthorized");
          return;
        }
        if (this.connections.size >= this.maxClients) {
          socket.close(4005, "session full");
          return;
        }
        conn.hello = frame.message;
        conn.id = String(frame.message.clientId || "").slice(0, 64) || null;
        if (!conn.id) {
          socket.close(4004, "unauthorized");
          return;
        }
        this.connections.add(conn);
        this.emit("open", conn);
        return;
      }
      this.emit("message", conn, frame);
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (this.connections.delete(conn)) this.emit("close", conn);
    });
    socket.on("error", () => {});
  }

  send(conn, data) {
    return safeSend(conn.socket, data);
  }

  broadcast(data, except = null) {
    for (const conn of this.connections) {
      if (conn !== except) safeSend(conn.socket, data);
    }
  }

  close() {
    for (const conn of this.connections) {
      try {
        conn.socket.close(1000, "session ended");
      } catch {}
    }
    this.connections.clear();
    const server = this.server;
    this.server = null;
    if (server) server.close(() => {});
  }
}

class GuestTransport extends EventEmitter {
  constructor({ host, port, token, hello }) {
    super();
    this.url = `ws://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
    this.token = token;
    this.hello = hello;
    this.socket = null;
    this.closed = false;
    this.attempt = 0;
    this.timer = null;
    this.connected = false;
    this.conn = { id: "host", socket: null };
  }

  connect() {
    if (this.closed) return;
    const WebSocket = require("ws");
    const socket = new WebSocket(this.url, { maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, handshakeTimeout: 8000 });
    this.socket = socket;
    this.conn.socket = socket;
    socket.on("open", () => {
      this.attempt = 0;
      safeSend(socket, encodeControl({ type: "hello", token: this.token, ...this.hello }));
      this.connected = true;
      this.emit("open", this.conn);
    });
    socket.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const frame = decodeFrame(data);
      if (frame) this.emit("message", this.conn, frame);
    });
    const onDown = (code, reasonBuffer) => {
      if (this.socket !== socket) return;
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      const reason = reasonBuffer ? reasonBuffer.toString() : "";
      if (wasConnected) this.emit("close", this.conn, { code, reason });
      // Deliberate refusals are final; everything else retries with backoff.
      if (this.closed || code === 4004 || code === 4005 || code === 1000) {
        if (!this.closed) this.emit("gaveUp", { code, reason });
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
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt, 5));
    this.attempt += 1;
    this.emit("reconnecting", { attempt: this.attempt, delay });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }

  send(_conn, data) {
    return safeSend(this.socket, data);
  }

  broadcast(data) {
    safeSend(this.socket, data);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
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
  FRAME_SYNC,
  FRAME_AWARENESS,
  FRAME_CONTROL,
  FRAME_BLOB,
  MAX_FRAME_BYTES,
  MAX_CLIENTS,
  encodeDocFrame,
  encodeControl,
  encodeBlob,
  decodeFrame,
  HostTransport,
  GuestTransport,
};
