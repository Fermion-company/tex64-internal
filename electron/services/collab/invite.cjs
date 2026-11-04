"use strict";

const crypto = require("node:crypto");
const os = require("node:os");

const INVITE_PROTOCOL = "tex64:";
const INVITE_HOST = "collab";
const INVITE_PATH = "/join";

const createToken = () => crypto.randomBytes(32).toString("base64url");
const createSessionId = () => crypto.randomUUID().replace(/-/g, "");

// A room on the relay: the secret stays with the host, the room ID is derived
// from it (services/collab-relay/room.mjs checks the same), and the key that
// seals every frame travels only in the invite link.
const relayRoomIdFor = (secret) => crypto.createHash("sha256").update(secret).digest().subarray(0, 16).toString("base64url");
const createRelayRoom = () => {
  const secret = crypto.randomBytes(32).toString("base64url");
  return { secret, roomId: relayRoomIdFor(secret), key: crypto.randomBytes(32).toString("base64url") };
};

// The relay a setting names, as ws(s)://host[:port], or null.
const relayServerOrigin = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || !url.hostname) return null;
  if (url.pathname.replace(/\/+$/, "") || url.search || url.hash) return null;
  return url.origin;
};

// Every non-internal IPv4 address, best first, then loopback: a guest tries
// them in order, so a link survives a network change on the host (tethering
// → Wi-Fi) and two TeX64 on one Mac always meet over 127.0.0.1.
const localHostAddresses = () => {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      // Prefer ordinary interfaces over container / VPN bridges.
      const privateLan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address);
      const weight = (privateLan ? 0 : 2) + (/^(en|eth|wlan|wi)/i.test(name) ? 0 : 1);
      candidates.push({ weight, address: entry.address });
    }
  }
  candidates.sort((a, b) => a.weight - b.weight);
  const addresses = [];
  for (const { address } of candidates) if (!addresses.includes(address)) addresses.push(address);
  if (!addresses.includes("127.0.0.1")) addresses.push("127.0.0.1");
  return addresses;
};
const localHostAddress = () => localHostAddresses()[0];

const HOST_PATTERN = /^[A-Za-z0-9.\-:\[\]]+$/;

const buildInviteLink = ({ host, hosts, port, token, name, relay }) => {
  const params = new URLSearchParams();
  if (relay) {
    params.set("s", relay.server);
    params.set("r", relay.roomId);
    params.set("k", relay.key);
    params.set("t", token);
    if (name) params.set("n", name);
    return `${INVITE_PROTOCOL}//${INVITE_HOST}${INVITE_PATH}?${params.toString()}`;
  }
  const all = Array.isArray(hosts) && hosts.length ? hosts : [host];
  params.set("h", all[0]);
  if (all.length > 1) params.set("a", all.slice(1).join(","));
  params.set("p", String(port));
  params.set("t", token);
  if (name) params.set("n", name);
  return `${INVITE_PROTOCOL}//${INVITE_HOST}${INVITE_PATH}?${params.toString()}`;
};

// Returns null for anything that is not a well-formed invite link.
const parseInviteLink = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(`${INVITE_PROTOCOL}//${INVITE_HOST}`)) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== INVITE_PROTOCOL || url.host !== INVITE_HOST) return null;
  if (url.pathname.replace(/\/+$/, "") !== INVITE_PATH) return null;
  const token = url.searchParams.get("t") || "";
  const name = url.searchParams.get("n") || "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  if (url.searchParams.has("s")) {
    const server = relayServerOrigin(url.searchParams.get("s") || "");
    const roomId = url.searchParams.get("r") || "";
    const key = url.searchParams.get("k") || "";
    if (!server || !/^[A-Za-z0-9_-]{22}$/.test(roomId) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
    return { relay: { server, roomId, key }, token, name: name.slice(0, 80) };
  }
  const host = url.searchParams.get("h") || "";
  const port = Number.parseInt(url.searchParams.get("p") || "", 10);
  if (!host || !HOST_PATTERN.test(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const hosts = [host];
  for (const alternate of (url.searchParams.get("a") || "").split(",")) {
    const trimmed = alternate.trim();
    if (trimmed && HOST_PATTERN.test(trimmed) && !hosts.includes(trimmed) && hosts.length < 16) hosts.push(trimmed);
  }
  return { host, hosts, port, token, name: name.slice(0, 80) };
};

const isInviteLink = (value) => parseInviteLink(value) !== null;

module.exports = {
  createToken,
  createSessionId,
  createRelayRoom,
  relayRoomIdFor,
  relayServerOrigin,
  localHostAddress,
  localHostAddresses,
  buildInviteLink,
  parseInviteLink,
  isInviteLink,
};
