"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { BuildService } = require("../electron/services/build/service.cjs");

test("build Stop is latched before a subprocess is spawned", async () => {
  const service = new BuildService();
  service.isBuilding = true;
  assert.equal(service.cancelCurrentRun(), true);
  assert.equal(service.cancelRequested, true);
  const result = await service.runProcess(
    "this-command-must-never-be-spawned",
    [],
    process.cwd(),
    process.env,
  );
  assert.deepEqual(result, {
    output: "",
    status: 1,
    cancelled: true,
    timedOut: false,
  });
  assert.equal(service.activeProcess, null);
});

test(
  "build timeout releases the lease when a detached descendant holds stdout",
  { skip: process.platform === "win32" },
  async () => {
    const service = new BuildService({
      processTimeoutMs: 100,
      processForceCompletionMs: 150,
    });
    service.isBuilding = true;
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], {",
      "  detached: true,",
      "  stdio: ['ignore', 'inherit', 'inherit'],",
      "});",
      "process.stdout.write(String(child.pid) + '\\n');",
      "child.unref();",
    ].join("\n");
    const startedAt = Date.now();
    let descendantPid = null;
    try {
      const result = await service.runProcess(
        process.execPath,
        ["-e", parentScript],
        process.cwd(),
        process.env,
      );
      const elapsedMs = Date.now() - startedAt;
      descendantPid = Number.parseInt(result.output, 10);
      assert.equal(result.timedOut, true);
      assert.equal(result.cancelled, true);
      assert.ok(elapsedMs < 700, `expected forced completion, took ${elapsedMs}ms`);
      assert.equal(service.activeProcess, null);
    } finally {
      if (Number.isInteger(descendantPid)) {
        try {
          process.kill(-descendantPid, "SIGKILL");
        } catch {
          // It may already have exited during a slow CI run.
        }
      }
      service.isBuilding = false;
    }
  },
);

test(
  "build timeout kills a same-group descendant after its parent exits",
  { skip: process.platform === "win32" },
  async () => {
    const service = new BuildService({
      processTimeoutMs: 150,
      processForceCompletionMs: 1000,
      processKillEscalationMs: 150,
    });
    service.isBuilding = true;
    const descendantScript = [
      "process.on('SIGTERM', () => {});",
      "process.send?.('ready');",
      "setInterval(() => {}, 10000);",
    ].join("\n");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], {`,
      "  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],",
      "});",
      "child.once('message', () => {",
      "  process.stdout.write(String(child.pid) + '\\n');",
      "  child.disconnect();",
      "  child.unref();",
      "  process.exit(0);",
      "});",
    ].join("\n");
    const startedAt = Date.now();
    let descendantPid = null;
    try {
      const result = await service.runProcess(
        process.execPath,
        ["-e", parentScript],
        process.cwd(),
        process.env,
      );
      descendantPid = Number.parseInt(result.output, 10);
      assert.equal(result.timedOut, true);
      assert.ok(Date.now() - startedAt < 900);
      assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
    } finally {
      if (Number.isInteger(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Expected when the process-group escalation succeeded.
        }
      }
      service.isBuilding = false;
    }
  },
);
