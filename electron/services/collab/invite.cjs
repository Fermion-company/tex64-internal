"use strict";

const crypto = require("node:crypto");
const os = require("node:os");

const INVITE_PROTOCOL = "tex64:";
const INVITE_HOST = "collab";
const INVITE_PATH = "/join";

const createToken = () => crypto.randomBytes(32).toString("base64url");
const createSessionId = () => crypto.randomUUID().replace(/-/g, "");

// The first non-internal IPv4 address; this is what LAN / VPN peers can reach.
const localHostAddress = () => {
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
  return candidates[0]?.address || "127.0.0.1";
};

const buildInviteLink = ({ host, port, token, name }) => {
  const params = new URLSearchParams();
  params.set("h", host);
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
  const host = url.searchParams.get("h") || "";
  const port = Number.parseInt(url.searchParams.get("p") || "", 10);
  const token = url.searchParams.get("t") || "";
  const name = url.searchParams.get("n") || "";
  if (!host || !/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  return { host, port, token, name: name.slice(0, 80) };
};

const isInviteLink = (value) => parseInviteLink(value) !== null;

module.exports = { createToken, createSessionId, localHostAddress, buildInviteLink, parseInviteLink, isInviteLink };
