// Cloudflare Worker: wss://<host>/rooms/<roomId>?role=host&secret=…  or  ?role=guest
// One Durable Object per room runs the Room (room.mjs). Its sockets use the
// hibernation API, so an idle room costs nothing: TeX64's "ping" is answered
// without waking the object, and the Room is rebuilt from the sockets'
// attachments when a message wakes it. A second Durable Object per client
// address keeps that address's room reservations (room.mjs updateQuota).
//
// ROOM_LEASE_MS / LEASE_RENEW_MS may be set as vars to shorten the lease in a
// trial (`wrangler dev --var LEASE_RENEW_MS:3000 --var ROOM_LEASE_MS:6000`).

import { Room, ROOM_ID, ROOM_LEASE_MS, LEASE_RENEW_MS, hostSecretMatches, refuse, updateQuota } from "./room.mjs";

const roomOf = (url) => url.pathname.match(/^\/rooms\/([^/]+)$/)?.[1] || "";
const setting = (env, name, fallback) => Number(env?.[name]) || fallback;
// A renewal the quota object could not answer is tried again this soon.
const RENEW_RETRY_MS = 5 * 60 * 1000;

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

// One client address's reservations: /acquire, /renew or /release ?room=&seat=.
export class AddressQuota {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.leaseMs = setting(env, "ROOM_LEASE_MS", ROOM_LEASE_MS);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const rooms = (await this.ctx.storage.get("rooms")) || {};
    const granted = updateQuota(rooms, {
      action: url.pathname.slice(1),
      roomId: url.searchParams.get("room") || "",
      seat: url.searchParams.get("seat") || "",
      now: Date.now(),
      leaseMs: this.leaseMs,
    });
    if (Object.keys(rooms).length) await this.ctx.storage.put("rooms", rooms);
    else await this.ctx.storage.deleteAll();
    return new Response(granted ? "ok" : "full", { status: granted ? 200 : 429 });
  }
}

export class CollabRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.renewMs = setting(env, "LEASE_RENEW_MS", LEASE_RENEW_MS);
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
        // { roomId, role, address, seat } for a host, { roomId, role, id } for a guest.
        get tag() {
          return ws.deserializeAttachment();
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

  // true granted, false refused, null when the quota object did not answer.
  quota(address, action, roomId, seat) {
    if (!this.env?.QUOTAS) return Promise.resolve(true);
    const stub = this.env.QUOTAS.get(this.env.QUOTAS.idFromName(address || "unknown"));
    const query = new URLSearchParams({ room: roomId, seat });
    return stub.fetch(`https://quota/${action}?${query}`).then((response) => response.ok, () => null);
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
    // Each host connection is its own seat on the reservation.
    const seat = crypto.randomUUID();
    // The secret and the address's reservation are settled before the socket
    // is accepted, so no message can arrive ahead of the decision.
    const allowed = role === "guest" || (await hostSecretMatches(roomId, url.searchParams.get("secret") || ""));
    const granted = role === "guest" || !allowed ? true : await this.quota(address, "acquire", roomId, seat);
    const room = await this.roomFor(roomId);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const socket = this.wrap(server);
    if (!allowed) {
      refuse(socket, "host", 4004, "unauthorized");
    } else if (granted === false) {
      refuse(socket, "host", 4029, "too many rooms");
    } else if (granted === null) {
      // The quota object did not answer: the host tries again shortly.
      refuse(socket, "host", 4013, "try again");
    } else if (role === "host") {
      server.serializeAttachment({ roomId, role, address, seat });
      const previous = room.host?.tag || null;
      room.attachHost(socket);
      await this.ctx.storage.delete("hostLeftAt");
      await this.ctx.storage.setAlarm(Date.now() + this.renewMs);
      // The host it replaced (a reconnect, maybe from another network) gives
      // its reservation back now: its own close will not end this seat.
      if (previous && previous.seat !== seat) await this.quota(previous.address, "release", roomId, previous.seat);
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
    await this.quota(tag.address, "release", tag.roomId, tag.seat);
  }

  // While a host is seated: renew its reservation (a reservation that cannot
  // be kept ends the seat). Once it left: send waiting guests away after the
  // grace period.
  async alarm() {
    const tags = this.ctx.getWebSockets().filter((ws) => ws.readyState === 1).map((ws) => ws.deserializeAttachment()).filter(Boolean);
    if (!tags.length) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const room = await this.roomFor(tags[0].roomId);
    const host = room.host;
    if (host) {
      const tag = host.tag;
      const kept = await this.quota(tag.address, "renew", tag.roomId, tag.seat);
      if (room.host !== host) return;
      if (kept === false) {
        refuse(host, "host", 4029, "too many rooms");
        return;
      }
      // No answer: keep the seat and try again soon; the lease has hours left.
      await this.ctx.storage.setAlarm(Date.now() + (kept === null ? Math.min(RENEW_RETRY_MS, this.renewMs) : this.renewMs));
      return;
    }
    if (room.sweep()) {
      await this.ctx.storage.delete("hostLeftAt");
      return;
    }
    if (room.hostLeftAt !== null) await this.ctx.storage.setAlarm(room.hostLeftAt + room.graceMs);
  }
}
