"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const invite = require("../electron/services/collab/invite.cjs");
const { HostTransport, GuestTransport, encodeControl } = require("../electron/services/collab/transport-ws.cjs");

test("an invite carries every host address and a guest reads them in order", () => {
  const link = invite.buildInviteLink({ hosts: ["192.168.0.5", "172.20.10.3", "127.0.0.1"], port: 5000, token: "t".repeat(32), name: "paper" });
  const parsed = invite.parseInviteLink(link);
  assert.deepEqual(parsed.hosts, ["192.168.0.5", "172.20.10.3", "127.0.0.1"]);
  assert.equal(parsed.host, "192.168.0.5");
  assert.equal(parsed.port, 5000);
  // Old links without alternates still parse to a one-element list.
  const old = invite.parseInviteLink(`tex64://collab/join?h=10.0.0.2&p=5000&t=${"t".repeat(32)}`);
  assert.deepEqual(old.hosts, ["10.0.0.2"]);
  // Loopback is always a candidate for two TeX64 on one machine.
  assert.ok(invite.localHostAddresses().includes("127.0.0.1"));
});

test("a guest moves on to the next address when one cannot be reached", async () => {
  const token = "t".repeat(32);
  const host = new HostTransport({ token });
  const port = await host.start();
  const guest = new GuestTransport({ hosts: ["nope.invalid", "127.0.0.1"], port, token, hello: { clientId: "g1", name: "Guest" } });
  const opened = new Promise((resolve) => guest.once("open", resolve));
  const started = Date.now();
  guest.connect();
  await opened;
  assert.equal(guest.url, `ws://127.0.0.1:${port}`);
  assert.ok(Date.now() - started < 5000, "fell through to loopback without waiting for the backoff");
  guest.close();
  host.close();
});
