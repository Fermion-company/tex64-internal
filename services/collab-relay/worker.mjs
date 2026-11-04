// Cloudflare Worker: wss://<host>/rooms/<roomId>?role=host&secret=…  or  ?role=guest
// One Durable Object per room runs the Room (room.mjs). It keeps nothing in
// storage, and without hibernation it lives only while sockets are open.

import { Room, ROOM_ID } from "./room.mjs";

const roomOf = (url) => url.pathname.match(/^\/rooms\/([^/]+)$/)?.[1] || "";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const roomId = roomOf(url);
    if (!ROOM_ID.test(roomId)) return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(request);
  },
};

export class CollabRoom {
  async fetch(request) {
    const url = new URL(request.url);
    this.room ??= new Room({ roomId: roomOf(url) });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    // Newer compatibility dates hand binary messages over as Blob by default.
    server.binaryType = "arraybuffer";
    let closed = false;
    const socket = {
      get closed() {
        return closed;
      },
      send: (bytes) => {
        try {
          server.send(bytes);
        } catch {}
      },
      close: (code, reason) => {
        try {
          server.close(code, reason);
        } catch {}
      },
    };
    // One chain per socket: messages wait for the host check and keep their
    // order (also if a runtime still hands over a Blob to read first).
    let queue = url.searchParams.get("role") === "host"
      ? this.room.attachHost(socket, url.searchParams.get("secret") || "")
      : Promise.resolve(this.room.attachGuest(socket) !== null);
    server.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data === "string") return;
      queue = queue.then(async (ok) => {
        if (!ok) return false;
        try {
          this.room.onMessage(socket, new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data));
        } catch {}
        return true;
      });
    });
    const gone = () => {
      closed = true;
      this.room.detach(socket);
    };
    server.addEventListener("close", gone);
    server.addEventListener("error", gone);
    return new Response(null, { status: 101, webSocket: client });
  }
}
