// One collaboration room on the relay: a host and up to MAX_GUESTS guests.
// The relay only moves bytes. Everything TeX64 sends through it is sealed end
// to end; the relay sees who is connected and how long each message is.
// See docs/collab-relay.md.
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
  // relay → guest: kind · body
  HOST_DATA: 0x21,
  HOST_OPEN: 0x22,
  HOST_GONE: 0x23,
});

export const MAX_GUESTS = 10;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;

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

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// A room's ID is the first 128 bits of SHA-256(host secret): only the holder
// of the secret can take the host seat, and the relay keeps no state.
export const roomIdFor = async (secret) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(secret)))).subarray(0, 16));

export class Room {
  constructor({ roomId, maxGuests = MAX_GUESTS }) {
    this.roomId = roomId;
    this.maxGuests = maxGuests;
    this.host = null;
    this.guests = new Map();
    this.nextGuest = 1;
  }

  async attachHost(socket, secret) {
    if (typeof secret !== "string" || secret.length < 32 || (await roomIdFor(secret)) !== this.roomId) {
      socket.close(4004, "unauthorized");
      return false;
    }
    if (socket.closed) return false;
    if (this.host && this.host !== socket) {
      try {
        this.host.close(4009, "replaced");
      } catch {}
    }
    this.host = socket;
    // Guests that waited for the host meet it now; each says hello again.
    for (const [id, guest] of this.guests) {
      socket.send(encodeEnvelope(KIND.PEER_OPEN, id));
      guest.send(toGuest(KIND.HOST_OPEN));
    }
    return true;
  }

  attachGuest(socket) {
    if (this.guests.size >= this.maxGuests) {
      socket.close(4005, "session full");
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

  detach(socket) {
    if (socket === this.host) {
      this.host = null;
      for (const guest of this.guests.values()) guest.send(toGuest(KIND.HOST_GONE));
      return;
    }
    for (const [id, guest] of this.guests) {
      if (guest !== socket) continue;
      this.guests.delete(id);
      this.host?.send(encodeEnvelope(KIND.PEER_CLOSE, id));
      return;
    }
  }

  guestIdOf(socket) {
    for (const [id, guest] of this.guests) if (guest === socket) return id;
    return null;
  }

  onMessage(socket, bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_MESSAGE_BYTES) {
      socket.close(4003, "bad frame");
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
        try {
          guest.close(code >= 4000 && code < 5000 ? code : 1000, "closed by host");
        } catch {}
      }
      return;
    }
    const id = this.guestIdOf(socket);
    // With no host the message is dropped: guests only talk after HOST_OPEN,
    // and a guest resyncs from its state vectors once the host is back.
    if (id && this.host) this.host.send(encodeEnvelope(KIND.PEER_DATA, id, bytes));
  }
}
