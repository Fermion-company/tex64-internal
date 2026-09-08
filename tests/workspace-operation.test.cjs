"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { WorkspaceOperationCoordinator } = require("../electron/services/workspace-operation.cjs");

test("history and Git share admission without sharing journals or release rights", async () => {
  const coordinator = new WorkspaceOperationCoordinator();
  const history = { id: "history-token", phase: "saving" };
  coordinator.claim("history", history);
  assert.throws(() => coordinator.claim("git", { id: "git-token", phase: "saving" }), { code: "HISTORY_BUSY" });
  assert.throws(() => coordinator.assertWriterAllowed(), { code: "HISTORY_BUSY" });
  assert.throws(() => coordinator.release("git", history.id), { code: "HISTORY_BUSY" });
  await coordinator.run(history.id, async () => {
    await Promise.resolve();
    coordinator.claim("history", history);
    coordinator.assertWriterAllowed();
  });
  coordinator.release("history", history.id);
  coordinator.claim("git", { id: "git-token", phase: "working" });
  assert.equal(coordinator.status().owner, "git");
  assert.throws(() => coordinator.run(history.id, () => {}), { code: "HISTORY_BUSY" });
  coordinator.run("git-token", () => coordinator.assertWriterAllowed());
  coordinator.release("git", "git-token");
  coordinator.assertWriterAllowed();
});

test("a late authorized callback cannot write under a replacement lease", async () => {
  const coordinator = new WorkspaceOperationCoordinator();
  let resume;
  const wait = new Promise(resolve => { resume = resolve; });
  coordinator.claim("history", { id: "same-token", phase: "working" });
  const pending = coordinator.run("same-token", async () => {
    await wait;
    assert.throws(() => coordinator.assertWriterAllowed(), { code: "HISTORY_BUSY" });
  });
  coordinator.release("history", "same-token");
  coordinator.claim("git", { id: "same-token", phase: "working" });
  resume();
  await pending;
});
