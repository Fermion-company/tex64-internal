"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { WorkspaceManager, WorkspaceError } = require("../electron/services/workspace.cjs");
const { createWorkspaceFileHandlers } = require("../electron/handlers/workspace/file-handlers.cjs");
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

for (const boundary of ["restore", "workspace A-B-A"]) test(`queued save rejects old generation after ${boundary} even when content CAS would pass`, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-delayed-save-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceManager(); workspace.setRootPath(root);
  await workspace.writeFile("main.tex", "same bytes before and after");
  const state = { workspaceId: "project-A", workspaceGeneration: 1 };
  const replies = [];
  const reachedLease = gate();
  const handlers = createWorkspaceFileHandlers({
    fs, workspace, WorkspaceError, state,
    ensureWorkspace: () => workspace.getRootPath(), updateWorkspaceIfNeeded: async () => {},
    sendToRenderer: (type, payload) => replies.push({ type, ...payload }), requestIndex: () => {},
    withWorkspaceMutation: async (fn) => { reachedLease.resolve(); return fn(); },
  });
  // Occupy the real per-file queue used by the real save handler.
  const entered = gate(); const release = gate();
  const blocker = workspace.withFileMutation("main.tex", async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const pending = handlers.handleSaveFile("main.tex", "obsolete editor content", {
    ...state, expectedContent: "same bytes before and after",
  });
  await reachedLease.promise;
  if (boundary === "workspace A-B-A") {
    workspace.setRootPath(path.join(root, "other")); state.workspaceId = "project-B"; state.workspaceGeneration++;
    workspace.setRootPath(root); state.workspaceId = "project-A";
  }
  state.workspaceGeneration++;
  release.resolve(); await blocker; await pending;
  assert.equal(await workspace.readFile("main.tex"), "same bytes before and after");
  assert.equal(replies.at(-1).ok, false); assert.equal(replies.at(-1).stale, true);
  // New-generation saves still follow the ordinary byte-comparison guard.
  await handlers.handleSaveFile("main.tex", "new editor content", { ...state, expectedContent: "same bytes before and after" });
  assert.equal(replies.at(-1).ok, true);
  await handlers.handleSaveFile("main.tex", "must not overwrite", { ...state, expectedContent: "same bytes before and after" });
  assert.equal(replies.at(-1).ok, false);
  assert.equal(await workspace.readFile("main.tex"), "new editor content");
});
