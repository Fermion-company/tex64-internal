// Cloudflare Worker: wss://<host>/rooms/<roomId>?role=host&secret=…  or  ?role=guest
// One Durable Object per room runs the Room (room.mjs). Its sockets use the
// hibernation API, so an idle room costs nothing: TeX64's "ping" is answered
// without waking the object, and the Room is rebuilt from the sockets'
// attachments when a message wakes it. A second Durable Object per client
// address counts the rooms that address hosts.

import { Room, ROOM_ID, MAX_HOST_ROOMS_PER_ADDRESS, hostSecretMatches, refuse } from "./room.mjs";

const roomOf = (url) => url.pathname.match(/^\/rooms\/([^/]+)$/)?.[1] || "";
// A lease outlives any real session's link; a count that a lost close left
// behind (a deploy resets objects without close events) frees itself.
const ROOM_LEASE_MS = 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const roomId = roomOf(url);
    if (!ROOM_ID.test(roomId)) return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const address = request.headers.get("CF-Connecting-IP") || "unknown";
    // A bounded number of connection attempts per address and minute.
    if (env.CONNECT_LIMIT) {
      const { success } = await env.CONNECT_LIMIT.limit({ key: address });
      if (!success) return new Response("too many connections", { status: 429 });
    }
    const forwarded = new Request(request);
    forwarded.headers.set("X-Relay-Address", address);
    return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(forwarded);
  },
};

// Rooms hosted from one client address: { roomId: lease end }.
export class AddressQuota {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const roomId = url.searchParams.get("room") || "";
    const now = Date.now();
    const rooms = (await this.ctx.storage.get("rooms")) || {};
    for (const [id, until] of Object.entries(rooms)) if (until <= now) delete rooms[id];
    let granted = true;
    if (url.pathname === "/acquire") {
      if (!(roomId in rooms) && Object.keys(rooms).length >= MAX_HOST_ROOMS_PER_ADDRESS) granted = false;
      else rooms[roomId] = now + ROOM_LEASE_MS;
    } else if (url.pathname === "/release") {
      delete rooms[roomId];
    }
    if (Object.keys(rooms).length) await this.ctx.storage.put("rooms", rooms);
    else await this.ctx.storage.deleteAll();
    return new Response(granted ? "ok" : "full", { status: granted ? 200 : 429 });
  }
}

export class CollabRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.wrapped = new WeakMap();
    this.handled = new WeakSet();
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

  quota(address, action, roomId) {
    if (!this.env?.QUOTAS) return Promise.resolve(true);
    const stub = this.env.QUOTAS.get(this.env.QUOTAS.idFromName(address));
    return stub.fetch(`https://quota/${action}?room=${roomId}`).then((response) => response.ok, () => action !== "acquire");
  }

  // The Room lives in memory; after hibernation it is rebuilt from the
  // sockets that are still open and the stored time the host left.
  async roomFor(roomId) {
    if (this.room) return this.room;
    const room = new Room({ roomId });
    room.hostLeftAt = (await this.ctx.storage.get("hostLeftAt")) ?? null;
    for (const ws of this.ctx.getWebSockets()) {
      const tag = ws.deserializeAttachment();
      if (!tag) continue;
      // Ids of closing sockets count too, so a new guest never takes one.
      if (tag.role === "guest") room.nextGuest = Math.max(room.nextGuest, Number(tag.id.slice(1)) + 1);
      if (ws.readyState !== 1) continue;
      if (tag.role === "host") room.host = this.wrap(ws);
      else room.guests.set(tag.id, this.wrap(ws));
    }
    this.room ??= room;
    return this.room;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const roomId = roomOf(url);
    const role = url.searchParams.get("role") === "host" ? "host" : "guest";
    const address = request.headers.get("X-Relay-Address") || "unknown";
    // The secret and the address's room count are checked before the socket
    // is accepted, so no message can arrive ahead of the decision.
    const allowed = role === "guest" || (await hostSecretMatches(roomId, url.searchParams.get("secret") || ""));
    const granted = role === "guest" || !allowed || (await this.quota(address, "acquire", roomId));
    const room = await this.roomFor(roomId);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const socket = this.wrap(server);
    if (!allowed) {
      refuse(socket, "host", 4004, "unauthorized");
    } else if (!granted) {
      refuse(socket, "host", 4029, "too many rooms");
    } else if (role === "host") {
      server.serializeAttachment({ roomId, role, address });
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
    if (this.handled.has(ws)) return;
    this.handled.add(ws);
    const tag = ws.deserializeAttachment();
    if (!tag) return;
    const room = await this.roomFor(tag.roomId);
    const socket = this.wrap(ws);
    // A close that woke the object comes for a socket already left out of
    // the rebuilt room: its attachment says who left.
    const left = room.detach(socket) || room.departed(tag, socket);
    if (left !== "host") return;
    await this.ctx.storage.put("hostLeftAt", room.hostLeftAt);
    await this.ctx.storage.setAlarm(room.hostLeftAt + room.graceMs);
    await this.quota(tag.address || "unknown", "release", tag.roomId);
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
