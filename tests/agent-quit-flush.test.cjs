"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  flushAgentSessionsForQuit,
} = require("../electron/services/agent-quit-flush.cjs");

test("quit flush aborts, waits for the turn, then persists dirty sessions", async () => {
  const order = [];
  const result = await flushAgentSessionsForQuit(
    {
      abort: () => order.push("abort"),
      waitForIdle: async () => {
        order.push("idle");
        return true;
      },
      flushPendingSessions: async () => {
        order.push("flush");
      },
    },
    { timeoutMs: 200, idleTimeoutMs: 50 },
  );

  assert.equal(result, true);
  assert.deepEqual(order, ["abort", "idle", "flush"]);
});

test("quit flush has a hard deadline when persistence never settles", async () => {
  let aborted = false;
  const startedAt = Date.now();
  const result = await flushAgentSessionsForQuit(
    {
      abort: () => {
        aborted = true;
      },
      waitForIdle: async () => true,
      flushPendingSessions: () => new Promise(() => {}),
    },
    { timeoutMs: 20, idleTimeoutMs: 5 },
  );

  assert.equal(aborted, true);
  assert.equal(result, false);
  assert.ok(Date.now() - startedAt < 250);
});
