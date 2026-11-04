"use strict";

// The relay on this machine, for tests and for trying the relay route without
// a deployment: the same Room as the Worker, behind a plain `ws` server.
//   node services/collab-relay/local-server.cjs [port]
// Then start TeX64 with TEX64_COLLAB_RELAY_URL=ws://127.0.0.1:<port>

const crypto = require("node:crypto");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const { Room, ROOM_ID, HOST_GRACE_MS, MAX_HOST_ROOMS_PER_ADDRESS, hostSecretMatches, refuse, updateQuota } = require("./room.mjs");

// For tests, which play a relay that misbehaves:
//   onTraffic({ role, direction, bytes }) sees every binary message;
//   filter({ role, direction, bytes, text }) returning false drops a message
//   (binary or the "ping"/"pong" text) as a black hole would.
const createLocalRelay = async ({ port = 0, onTraffic = null, filter = null, graceMs = HOST_GRACE_MS, maxHostRooms = MAX_HOST_ROOMS_PER_ADDRESS } = {}) => {
  const rooms = new Map();
  const sweeps = new Map();
  // Client address → its reservations, as the Worker's AddressQuota keeps
  // them (no lease renewal here: a test relay does not live for a day).
  const hosted = new Map();
  const quota = (address, action, roomId, seat) => {
    if (!hosted.has(address)) hosted.set(address, {});
    return updateQuota(hosted.get(address), { action, roomId, seat, now: Date.now(), max: maxHostRooms });
  };
  const server = http.createServer((request, response) => {
    response.statusCode = request.url === "/health" ? 200 : 404;
    response.end(request.url === "/health" ? "ok" : "");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  server.on("upgrade", async (request, socket, head) => {
    const url = new URL(request.url, "http://relay.local");
    const roomId = url.pathname.match(/^\/rooms\/([^/]+)$/)?.[1] || "";
    if (!ROOM_ID.test(roomId)) {
      socket.destroy();
      return;
    }
    const role = url.searchParams.get("role") === "host" ? "host" : "guest";
    // A test may name the client address (the Worker reads CF-Connecting-IP).
    const address = request.headers["x-test-address"] || request.socket.remoteAddress || "unknown";
    const seat = crypto.randomUUID();
    const allowed = role === "guest" || (await hostSecretMatches(roomId, url.searchParams.get("secret") || ""));
    const granted = role === "guest" || !allowed || quota(address, "acquire", roomId, seat);
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (!rooms.has(roomId)) rooms.set(roomId, new Room({ roomId, graceMs }));
      const room = rooms.get(roomId);
      const passes = (direction, bytes, text = null) => !filter || filter({ role, direction, bytes, text, ws }) !== false;
      const wrapped = {
        ws,
        address,
        seat,
        get closed() {
          return ws.readyState >= 2;
        },
        send: (bytes) => {
          if (ws.readyState !== 1 || !passes("out", bytes)) return;
          onTraffic?.({ role, direction: "out", bytes });
          ws.send(bytes, { binary: true });
        },
        close: (code, reason) => ws.close(code, reason),
      };
      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          // The Worker answers "ping" without waking the room; so does this.
          if (String(data) === "ping" && passes("in", null, "ping") && passes("out", null, "pong")) ws.send("pong");
          return;
        }
        const bytes = new Uint8Array(data);
        if (!passes("in", bytes)) return;
        onTraffic?.({ role, direction: "in", bytes });
        room.onMessage(wrapped, bytes);
      });
      ws.on("close", () => {
        if (room.detach(wrapped) !== "host") return;
        quota(address, "release", roomId, seat);
        clearTimeout(sweeps.get(roomId));
        const timer = setTimeout(() => room.sweep(), graceMs + 10);
        timer.unref?.();
        sweeps.set(roomId, timer);
      });
      ws.on("error", () => {});
      if (!allowed) refuse(wrapped, "host", 4004, "unauthorized");
      else if (!granted) refuse(wrapped, "host", 4029, "too many rooms");
      else if (role === "host") {
        const previous = room.host;
        room.attachHost(wrapped);
        // The host it replaced gives its reservation back now.
        if (previous && previous.seat !== seat) quota(previous.address, "release", roomId, previous.seat);
      }
      else room.attachGuest(wrapped);
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    rooms,
    hosted,
    close: () => new Promise((resolve) => {
      for (const timer of sweeps.values()) clearTimeout(timer);
      for (const client of wss.clients) client.terminate();
      server.close(() => resolve());
    }),
  };
};

if (require.main === module) {
  createLocalRelay({ port: Number(process.argv[2]) || 8787 }).then((relay) => console.log(`collab relay at ${relay.url}`));
}

module.exports = { createLocalRelay };
