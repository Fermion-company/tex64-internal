// One collaboration room on the relay: a host and up to MAX_GUESTS guests.
// The relay only moves bytes. Everything TeX64 sends through it is sealed end
// to end per guest connection; the relay sees who is connected and how long
// each message is. See docs/collab-relay.md.
//
// A socket here is anything with send(Uint8Array), close(code, reason) and a
// `closed` flag; the Worker and the local server wrap their WebSockets so.

export const KIND = Object.freeze({
  // host → relay: kind · id · body
  SEND: 0x01,
  CLOSE_PEER: 0x03,
  // relay → host: kind · id · body
  PEER_OPEN: 0x11,
  PEER_DATA: 0x12,
  PEER_CLOSE: 0x13,
  REFUSED_HOST: 0x14, // empty id · close code (u16)
  HOST_READY: 0x15, // empty id: the host has the seat
  // relay → guest: kind · body
  HOST_DATA: 0x21,
  HOST_OPEN: 0x22,
  HOST_GONE: 0x23,
  REFUSED: 0x24, // close code (u16)
});

export const MAX_GUESTS = 10;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
// How long guests may wait for a host that left (a network change, a restart)
// before the room sends them away. A room whose host never came takes none.
export const HOST_GRACE_MS = 2 * 60 * 1000;
// Rooms one client address may host at once (a lab behind one NAT included).
export const MAX_HOST_ROOMS_PER_ADDRESS = 20;
// A seated host's reservation lasts ROOM_LEASE_MS and is renewed every
// LEASE_RENEW_MS while it stays, so a live room always counts and a count a
// lost close left behind frees itself.
export const ROOM_LEASE_MS = 24 * 60 * 60 * 1000;
export const LEASE_RENEW_MS = 6 * 60 * 60 * 1000;

// One client address's reservations, { roomId: { seat, until } }, changed in
// place. Each host connection has its own seat: acquiring (or renewing) puts
// it on the room, and only the same seat can release it, so the close of a
// host that was just replaced cannot free its successor's reservation.
// Returns whether the action was granted.
export const updateQuota = (rooms, { action, roomId, seat, now, max = MAX_HOST_ROOMS_PER_ADDRESS, leaseMs = ROOM_LEASE_MS }) => {
  for (const [id, entry] of Object.entries(rooms)) {
    if (!entry || typeof entry !== "object" || entry.until <= now) delete rooms[id];
  }
  if (action === "acquire") {
    if (!(roomId in rooms) && Object.keys(rooms).length >= max) return false;
    rooms[roomId] = { seat, until: now + leaseMs };
    return true;
  }
  if (action === "renew") {
    // A newer seat already holds the room: leave its reservation alone.
    const entry = rooms[roomId];
    if (entry && entry.seat !== seat) return true;
    if (!entry && Object.keys(rooms).length >= max) return false;
    rooms[roomId] = { seat, until: now + leaseMs };
    return true;
  }
  if (action === "release" && rooms[roomId]?.seat === seat) delete rooms[roomId];
  return true;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// kind(u8) · id length(u16) · id (UTF-8) · body
export const encodeEnvelope = (kind, id, body = new Uint8Array(0)) => {
  const idBytes = encoder.encode(id);
  const out = new Uint8Array(3 + idBytes.length + body.length);
  out[0] = kind;
  out[1] = idBytes.length >> 8;
  out[2] = idBytes.length & 0xff;
  out.set(idBytes, 3);
  out.set(body, 3 + idBytes.length);
  return out;
};

export const decodeEnvelope = (bytes) => {
  if (!(bytes instanceof Uint8Array) || bytes.length < 3) return null;
  const length = (bytes[1] << 8) | bytes[2];
  if (bytes.length < 3 + length) return null;
  return { kind: bytes[0], id: decoder.decode(bytes.subarray(3, 3 + length)), body: bytes.subarray(3 + length) };
};

const toGuest = (kind, body = new Uint8Array(0)) => {
  const out = new Uint8Array(1 + body.length);
  out[0] = kind;
  out.set(body, 1);
  return out;
};

// A close started by the relay can take seconds to finish in workerd (the
// client sits in CLOSING), so the relay first says why, and the client closes
// its end at once with that code.
export const refuse = (socket, role, code, reason) => {
  const body = new Uint8Array([code >> 8, code & 0xff]);
  socket.send(role === "host" ? encodeEnvelope(KIND.REFUSED_HOST, "", body) : toGuest(KIND.REFUSED, body));
  try {
    socket.close(code, reason);
  } catch {}
};

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// A room's ID is the first 128 bits of SHA-256(host secret): only the holder
// of the secret can take the host seat, and the relay keeps no secret.
export const roomIdFor = async (secret) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(secret)))).subarray(0, 16));

export const hostSecretMatches = async (roomId, secret) => typeof secret === "string" && secret.length >= 32 && (await roomIdFor(secret)) === roomId;

export class Room {
  constructor({ roomId, maxGuests = MAX_GUESTS, graceMs = HOST_GRACE_MS, now = () => Date.now() }) {
    this.roomId = roomId;
    this.maxGuests = maxGuests;
    this.graceMs = graceMs;
    this.now = now;
    this.host = null;
    // When the last host left; null while a host is here or none ever came.
    this.hostLeftAt = null;
    this.guests = new Map();
    this.nextGuest = 1;
  }

  // The caller has checked the secret (hostSecretMatches).
  attachHost(socket) {
    if (this.host && this.host !== socket) refuse(this.host, "host", 4009, "replaced");
    this.host = socket;
    this.hostLeftAt = null;
    socket.send(encodeEnvelope(KIND.HOST_READY, ""));
    // Guests that waited for the host meet it now; each makes a new channel.
    for (const [id, guest] of this.guests) {
      socket.send(encodeEnvelope(KIND.PEER_OPEN, id));
      guest.send(toGuest(KIND.HOST_OPEN));
    }
  }

  hostExpected() {
    return Boolean(this.host) || (this.hostLeftAt !== null && this.now() - this.hostLeftAt < this.graceMs);
  }

  // Returns the guest's id, or null when the room turned it away.
  attachGuest(socket) {
    if (this.guests.size >= this.maxGuests) {
      refuse(socket, "guest", 4005, "session full");
      return null;
    }
    // Rooms are made by hosts; nobody can hold one open by waiting in it.
    if (!this.hostExpected()) {
      refuse(socket, "guest", 4010, "no host");
      return null;
    }
    const id = `g${this.nextGuest++}`;
    this.guests.set(id, socket);
    if (this.host) {
      this.host.send(encodeEnvelope(KIND.PEER_OPEN, id));
      socket.send(toGuest(KIND.HOST_OPEN));
    }
    return id;
  }

  // Returns "host", "guest" or null.
  detach(socket) {
    if (socket === this.host) {
      this.host = null;
      this.hostLeftAt = this.now();
      for (const guest of this.guests.values()) guest.send(toGuest(KIND.HOST_GONE));
      return "host";
    }
    for (const [id, guest] of this.guests) {
      if (guest !== socket) continue;
      this.guests.delete(id);
      this.host?.send(encodeEnvelope(KIND.PEER_CLOSE, id));
      return "guest";
    }
    return null;
  }

  // The same as detach() for a socket the room no longer lists — in the
  // Worker, a close that wakes a hibernated room arrives for a socket that is
  // already CLOSED and so left out of the rebuilt room. `tag` is the socket's
  // attachment: { role, id }. A host that was replaced does not end the seat.
  departed(tag, socket) {
    if (tag.role === "host") {
      if (this.host && this.host !== socket && !this.host.closed) return null;
      this.host = null;
      this.hostLeftAt = this.now();
      for (const guest of this.guests.values()) guest.send(toGuest(KIND.HOST_GONE));
      return "host";
    }
    const current = this.guests.get(tag.id);
    if (current && current !== socket && !current.closed) return null;
    this.guests.delete(tag.id);
    this.host?.send(encodeEnvelope(KIND.PEER_CLOSE, tag.id));
    return "guest";
  }

  // Sends the guests away once the host has been gone for the grace period.
  // Returns true when it did.
  sweep() {
    if (this.host || this.hostLeftAt === null || this.now() - this.hostLeftAt < this.graceMs) return false;
    for (const guest of this.guests.values()) refuse(guest, "guest", 4010, "host away");
    this.guests.clear();
    this.hostLeftAt = null;
    return true;
  }

  guestIdOf(socket) {
    for (const [id, guest] of this.guests) if (guest === socket) return id;
    return null;
  }

  onMessage(socket, bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_MESSAGE_BYTES) {
      refuse(socket, socket === this.host ? "host" : "guest", 4003, "bad frame");
      return;
    }
    if (socket === this.host) {
      const envelope = decodeEnvelope(bytes);
      if (!envelope) return;
      const guest = this.guests.get(envelope.id);
      if (!guest) return;
      if (envelope.kind === KIND.SEND) guest.send(toGuest(KIND.HOST_DATA, envelope.body));
      else if (envelope.kind === KIND.CLOSE_PEER) {
        const code = envelope.body.length >= 2 ? (envelope.body[0] << 8) | envelope.body[1] : 1000;
        this.guests.delete(envelope.id);
        refuse(guest, "guest", code >= 4000 && code < 5000 ? code : 1000, "closed by host");
      }
      return;
    }
    const id = this.guestIdOf(socket);
    // With no host the message is dropped: guests only talk after HOST_OPEN,
    // and a guest resyncs over a new channel once the host is back.
    if (id && this.host) this.host.send(encodeEnvelope(KIND.PEER_DATA, id, bytes));
  }
}
