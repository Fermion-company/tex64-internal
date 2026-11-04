// Cloudflare Worker: wss://<host>/rooms/<roomId>?role=host&secret=…  or  ?role=guest
// One Durable Object per room runs the Room (room.mjs). Its sockets use the
// hibernation API, so an idle room costs nothing: TeX64's "ping" is answered
// without waking the object, and the Room is rebuilt from the sockets'
// attachments when a message wakes it.

import { Room, ROOM_ID, hostSecretMatches, refuse } from "./room.mjs";

const roomOf = (url) => url.pathname.match(/^\/rooms\/([^/]+)$/)?.[1] || "";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const roomId = roomOf(url);
    if (!ROOM_ID.test(roomId)) return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    // A bounded number of connection attempts per address and minute.
    if (env.CONNECT_LIMIT) {
      const { success } = await env.CONNECT_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
      if (!success) return new Response("too many connections", { status: 429 });
    }
    return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(request);
  },
};

export class CollabRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.room = null;
    this.wrapped = new WeakMap();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  wrap(ws) {
    let socket = this.wrapped.get(ws);
    if (!socket) {
      socket = {
        get closed() {
          return ws.readyState >= 2;
        },
        send: (bytes) => {
          try {
            ws.send(bytes);
          } catch {}
        },
        close: (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {}
        },
      };
      this.wrapped.set(ws, socket);
    }
    return socket;
  }

  // The Room lives in memory; after hibernation it is rebuilt from the
  // sockets that are still open and the stored time the host left.
  async roomFor(roomId) {
    if (this.room) return this.room;
    const room = new Room({ roomId });
    room.hostLeftAt = (await this.ctx.storage.get("hostLeftAt")) ?? null;
    for (const ws of this.ctx.getWebSockets()) {
      const tag = ws.deserializeAttachment();
      if (!tag || ws.readyState !== 1) continue;
      if (tag.role === "host") room.host = this.wrap(ws);
      else {
        room.guests.set(tag.id, this.wrap(ws));
        room.nextGuest = Math.max(room.nextGuest, Number(tag.id.slice(1)) + 1);
      }
    }
    this.room ??= room;
    return this.room;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const roomId = roomOf(url);
    const role = url.searchParams.get("role") === "host" ? "host" : "guest";
    // The secret is checked before the socket is accepted, so no message can
    // arrive ahead of the decision.
    const allowed = role === "guest" || (await hostSecretMatches(roomId, url.searchParams.get("secret") || ""));
    const room = await this.roomFor(roomId);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const socket = this.wrap(server);
    if (!allowed) {
      refuse(socket, "host", 4004, "unauthorized");
    } else if (role === "host") {
      server.serializeAttachment({ roomId, role });
      room.attachHost(socket);
      await this.ctx.storage.delete("hostLeftAt");
      await this.ctx.storage.deleteAlarm();
    } else {
      const id = room.attachGuest(socket);
      if (id) server.serializeAttachment({ roomId, role, id });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message === "string") return;
    const tag = ws.deserializeAttachment();
    if (!tag) return;
    const room = await this.roomFor(tag.roomId);
    room.onMessage(this.wrap(ws), new Uint8Array(message));
  }

  async webSocketClose(ws, code, reason) {
    await this.gone(ws);
    try {
      ws.close(code, reason);
    } catch {}
  }

  async webSocketError(ws) {
    await this.gone(ws);
  }

  async gone(ws) {
    const tag = ws.deserializeAttachment();
    if (!tag) return;
    const room = await this.roomFor(tag.roomId);
    if (room.detach(this.wrap(ws)) === "host" && room.hostLeftAt !== null) {
      await this.ctx.storage.put("hostLeftAt", room.hostLeftAt);
      await this.ctx.storage.setAlarm(room.hostLeftAt + room.graceMs);
    }
  }

  async alarm() {
    const tags = this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment()).filter(Boolean);
    if (!tags.length) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const room = await this.roomFor(tags[0].roomId);
    if (room.sweep()) await this.ctx.storage.delete("hostLeftAt");
  }
}
