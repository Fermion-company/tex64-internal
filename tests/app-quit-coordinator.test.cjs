"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PREPARE_FAILED_CODE,
  PREPARE_TIMEOUT_CODE,
  createQuitCoordinator,
} = require("../electron/services/quit-coordinator.cjs");

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const drainMicrotasks = async () => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

const createScheduler = () => {
  let nextId = 1;
  const timers = new Map();
  const immediates = [];
  return {
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    scheduleImmediate(callback) {
      immediates.push(callback);
    },
    fireTimerWithDelay(delay) {
      const match = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(match, `expected an active ${delay}ms timer`);
      const [id, timer] = match;
      timers.delete(id);
      timer.callback();
    },
    fireAllTimers() {
      const active = [...timers.values()];
      timers.clear();
      active.forEach((timer) => timer.callback());
    },
    runImmediate() {
      const callback = immediates.shift();
      assert.ok(callback, "expected a scheduled immediate callback");
      callback();
    },
    get immediateCount() {
      return immediates.length;
    },
    get timerCount() {
      return timers.size;
    },
  };
};

const quitEvent = () => {
  let prevented = 0;
  return {
    event: { preventDefault: () => { prevented += 1; } },
    get prevented() { return prevented; },
  };
};

test("first quit drains once and a synchronous final before-quit re-entry is allowed", async () => {
  const scheduler = createScheduler();
  const preparation = deferred();
  const order = [];
  const first = quitEvent();
  const repeated = quitEvent();
  let finalEvent = null;
  let coordinator;
  coordinator = createQuitCoordinator({
    prepareRenderer: () => {
      order.push("prepare");
      return preparation.promise;
    },
    flushAgent: async () => order.push("flush"),
    teardown: () => order.push("teardown"),
    requestQuit: () => {
      order.push("quit");
      finalEvent = quitEvent();
      coordinator.handleBeforeQuit(finalEvent.event);
    },
    forceExit: () => order.push("force"),
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    scheduleImmediate: scheduler.scheduleImmediate,
    prepareTimeoutMs: 20,
    forceExitTimeoutMs: 50,
  });

  const attempt = coordinator.handleBeforeQuit(first.event);
  const sameAttempt = coordinator.handleBeforeQuit(repeated.event);
  await Promise.resolve();
  assert.equal(first.prevented, 1);
  assert.equal(repeated.prevented, 1);
  assert.equal(sameAttempt, attempt);
  assert.equal(coordinator.getPhase(), "flushing");
  assert.deepEqual(order, ["prepare"]);

  preparation.resolve(true);
  assert.deepEqual(await attempt, { ok: true });
  assert.equal(coordinator.getPhase(), "relaunching");
  assert.deepEqual(order, ["prepare", "flush", "teardown"]);
  assert.equal(scheduler.immediateCount, 1);

  scheduler.runImmediate();
  assert.equal(finalEvent.prevented, 0);
  assert.equal(coordinator.getPhase(), "exiting");
  assert.deepEqual(order, ["prepare", "flush", "teardown", "quit"]);

  coordinator.handleWillQuit();
  scheduler.fireAllTimers();
  assert.equal(order.includes("force"), false);
});

test("renderer preparation must finish before agent flush and the watchdog", async () => {
  const scheduler = createScheduler();
  const preparation = deferred();
  const agentFlush = deferred();
  const order = [];
  const coordinator = createQuitCoordinator({
    prepareRenderer: () => {
      order.push("prepare");
      return preparation.promise;
    },
    flushAgent: () => {
      order.push("flush");
      return agentFlush.promise;
    },
    teardown: () => order.push("teardown"),
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    scheduleImmediate: scheduler.scheduleImmediate,
    prepareTimeoutMs: 20,
    forceExitTimeoutMs: 50,
  });

  const attempt = coordinator.handleBeforeQuit(quitEvent().event);
  await Promise.resolve();
  assert.deepEqual(order, ["prepare"]);
  assert.equal(scheduler.timerCount, 1);
  assert.equal(scheduler.immediateCount, 0);

  preparation.resolve({ ok: true });
  await drainMicrotasks();
  assert.deepEqual(order, ["prepare", "flush"]);
  assert.equal(scheduler.immediateCount, 0);
  assert.equal(scheduler.timerCount, 0);

  agentFlush.resolve(true);
  await attempt;
  assert.deepEqual(order, ["prepare", "flush", "teardown"]);
  assert.equal(scheduler.immediateCount, 1);
  assert.equal(scheduler.timerCount, 1);
});

test("explicit renderer save failure blocks quit and permits a later retry", async () => {
  const scheduler = createScheduler();
  const errors = [];
  let prepareCalls = 0;
  let flushCalls = 0;
  let quitCalls = 0;
  const coordinator = createQuitCoordinator({
    prepareRenderer: async () => {
      prepareCalls += 1;
      return prepareCalls === 1 ? { ok: false } : true;
    },
    flushAgent: async () => { flushCalls += 1; },
    requestQuit: () => { quitCalls += 1; },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    scheduleImmediate: scheduler.scheduleImmediate,
    onError: (error, stage) => errors.push({ error, stage }),
  });

  const first = quitEvent();
  assert.deepEqual(await coordinator.handleBeforeQuit(first.event), {
    ok: false,
    stage: "prepare-renderer",
  });
  assert.equal(first.prevented, 1);
  assert.equal(coordinator.getPhase(), "idle");
  assert.equal(flushCalls, 0);
  assert.equal(scheduler.timerCount, 0);
  assert.equal(scheduler.immediateCount, 0);
  assert.equal(errors[0].error.code, PREPARE_FAILED_CODE);

  await coordinator.handleBeforeQuit(quitEvent().event);
  scheduler.runImmediate();
  assert.equal(prepareCalls, 2);
  assert.equal(flushCalls, 1);
  assert.equal(quitCalls, 1);
});

test("renderer preparation timeout fails closed and ignores a late completion", async () => {
  const scheduler = createScheduler();
  const preparation = deferred();
  const errors = [];
  let flushCalls = 0;
  let quitCalls = 0;
  const coordinator = createQuitCoordinator({
    prepareRenderer: () => preparation.promise,
    flushAgent: async () => { flushCalls += 1; },
    requestQuit: () => { quitCalls += 1; },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    scheduleImmediate: scheduler.scheduleImmediate,
    prepareTimeoutMs: 25,
    onError: (error, stage) => errors.push({ error, stage }),
  });

  const attempt = coordinator.handleBeforeQuit(quitEvent().event);
  scheduler.fireTimerWithDelay(25);
  assert.deepEqual(await attempt, { ok: false, stage: "prepare-renderer" });
  assert.equal(coordinator.getPhase(), "idle");
  assert.equal(errors[0].error.code, PREPARE_TIMEOUT_CODE);
  assert.equal(flushCalls, 0);
  assert.equal(quitCalls, 0);
  assert.equal(scheduler.timerCount, 0);

  preparation.resolve(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(flushCalls, 0);
  assert.equal(quitCalls, 0);
});

test("renderer preparation deadline can be disabled for acknowledged batch saves", async () => {
  const scheduler = createScheduler();
  const preparation = deferred();
  const coordinator = createQuitCoordinator({
    prepareRenderer: () => preparation.promise,
    flushAgent: async () => true,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    scheduleImmediate: scheduler.scheduleImmediate,
    prepareTimeoutMs: null,
    forceExitTimeoutMs: 50,
  });

  const attempt = coordinator.handleBeforeQuit(quitEvent().event);
  await drainMicrotasks();
  assert.equal(scheduler.timerCount, 0);
  assert.equal(coordinator.getPhase(), "flushing");

  preparation.resolve({ ok: true });
  await attempt;
  assert.equal(scheduler.timerCount, 1);
  assert.equal(scheduler.immediateCount, 1);
});

test("agent flush rejection is reported but cannot trap final quit", async () => {
  const scheduler = createScheduler();
  const errors = [];
  let quitCalls = 0;
  const coordinator = createQuitCoordinator({
    prepareRenderer: async () => true,
    flushAgent: async () => { throw new Error("disk unavailable"); },
    requestQuit: () => { quitCalls += 1; },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    scheduleImmediate: scheduler.scheduleImmediate,
    onError: (error, stage) => errors.push({ error, stage }),
  });

  assert.deepEqual(await coordinator.handleBeforeQuit(quitEvent().event), { ok: true });
  scheduler.runImmediate();
  assert.equal(quitCalls, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].stage, "flush-agent");
});

test("requestQuit failure reaches forceExit exactly once", async () => {
  const scheduler = createScheduler();
  const errors = [];
  let teardownCalls = 0;
  let forceCalls = 0;
  const coordinator = createQuitCoordinator({
    prepareRenderer: async () => true,
    flushAgent: async () => true,
    teardown: () => { teardownCalls += 1; },
    requestQuit: () => { throw new Error("native quit failed"); },
    forceExit: (code) => {
      assert.equal(code, 0);
      forceCalls += 1;
    },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    scheduleImmediate: scheduler.scheduleImmediate,
    forceExitTimeoutMs: 40,
    onError: (error, stage) => errors.push({ error, stage }),
  });

  await coordinator.handleBeforeQuit(quitEvent().event);
  scheduler.runImmediate();
  assert.equal(errors[0].stage, "request-quit");
  scheduler.fireTimerWithDelay(40);
  scheduler.fireAllTimers();
  assert.equal(coordinator.getPhase(), "forced");
  assert.equal(teardownCalls, 1);
  assert.equal(forceCalls, 1);

  coordinator.handleBeforeQuit(quitEvent().event);
  assert.equal(teardownCalls, 1);
  assert.equal(forceCalls, 1);
});

test("will-quit and quit cancel the force-exit watchdog", async (t) => {
  for (const terminalEvent of ["handleWillQuit", "handleQuit"]) {
    await t.test(terminalEvent, async () => {
      const scheduler = createScheduler();
      let forceCalls = 0;
      const coordinator = createQuitCoordinator({
        prepareRenderer: async () => true,
        flushAgent: async () => true,
        setTimer: scheduler.setTimer,
        clearTimer: scheduler.clearTimer,
        scheduleImmediate: scheduler.scheduleImmediate,
        forceExit: () => { forceCalls += 1; },
      });

      await coordinator.handleBeforeQuit(quitEvent().event);
      assert.equal(scheduler.timerCount, 1);
      coordinator[terminalEvent]();
      assert.equal(coordinator.getPhase(), "exiting");
      assert.equal(scheduler.timerCount, 0);
      scheduler.fireAllTimers();
      assert.equal(forceCalls, 0);
    });
  }
});

test("teardown failure is isolated and final quit remains live", async () => {
  const scheduler = createScheduler();
  const errors = [];
  let teardownCalls = 0;
  let quitCalls = 0;
  const coordinator = createQuitCoordinator({
    prepareRenderer: async () => true,
    flushAgent: async () => true,
    teardown: () => {
      teardownCalls += 1;
      throw new Error("one service failed");
    },
    requestQuit: () => { quitCalls += 1; },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    scheduleImmediate: scheduler.scheduleImmediate,
    onError: (error, stage) => errors.push({ error, stage }),
  });

  await coordinator.handleBeforeQuit(quitEvent().event);
  coordinator.handleBeforeQuit(quitEvent().event);
  scheduler.runImmediate();
  coordinator.handleBeforeQuit(quitEvent().event);
  assert.equal(teardownCalls, 1);
  assert.equal(quitCalls, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].stage, "teardown");
});
