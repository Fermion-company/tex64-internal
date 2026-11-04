"use strict";

// The relay on this machine, for tests and for trying the relay route without
// a deployment: the same Room as the Worker, behind a plain `ws` server.
//   node services/collab-relay/local-server.cjs [port]
// Then start TeX64 with TEX64_COLLAB_RELAY_URL=ws://127.0.0.1:<port>

const http = require("node:http");
const { WebSocketServer } = require("ws");
const { Room, ROOM_ID } = require("./room.mjs");

// onTraffic({ role, direction, bytes }) sees every message, for tests that
// check what the relay can read.
const createLocalRelay = async ({ port = 0, onTraffic = null } = {}) => {
  const rooms = new Map();
  const server = http.createServer((request, response) => {
    response.statusCode = request.url === "/health" ? 200 : 404;
    response.end(request.url === "/health" ? "ok" : "");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://relay.local");
    const roomId = url.pathname.match(/^\/rooms\/([^/]+)$/)?.[1] || "";
    if (!ROOM_ID.test(roomId)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (!rooms.has(roomId)) rooms.set(roomId, new Room({ roomId }));
      const room = rooms.get(roomId);
      const role = url.searchParams.get("role") === "host" ? "host" : "guest";
      const wrapped = {
        get closed() {
          return ws.readyState >= 2;
        },
        send: (bytes) => {
          if (ws.readyState !== 1) return;
          onTraffic?.({ role, direction: "out", bytes });
          ws.send(bytes, { binary: true });
        },
        close: (code, reason) => ws.close(code, reason),
      };
      const ready = role === "host"
        ? room.attachHost(wrapped, url.searchParams.get("secret") || "")
        : Promise.resolve(room.attachGuest(wrapped) !== null);
      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const bytes = new Uint8Array(data);
        onTraffic?.({ role, direction: "in", bytes });
        void ready.then((ok) => {
          if (ok) room.onMessage(wrapped, bytes);
        });
      });
      ws.on("close", () => room.detach(wrapped));
      ws.on("error", () => {});
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    rooms,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      server.close(() => resolve());
    }),
  };
};

if (require.main === module) {
  createLocalRelay({ port: Number(process.argv[2]) || 8787 }).then((relay) => console.log(`collab relay at ${relay.url}`));
}

module.exports = { createLocalRelay };
