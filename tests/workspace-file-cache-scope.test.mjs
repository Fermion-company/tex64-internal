import test from "node:test";
import assert from "node:assert/strict";

import { createFileExcerptBroker } from "../Resources/web/app/file-excerpt.js";
import { createFilePreviewBroker } from "../Resources/web/app/file-preview.js";

const browserWindow = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
};

test("preview cache and in-flight requests are isolated by workspace generation", async () => {
  globalThis.window = browserWindow;
  const requests = [];
  const broker = createFilePreviewBroker((payload) => {
    requests.push(payload);
    return true;
  });
  broker.setWorkspaceScope({
    workspaceId: "workspace-a",
    rootPath: "/workspace-a",
    workspaceGeneration: 3,
  });

  const firstPromise = broker.requestPreview("same.png");
  const firstRequest = requests.at(-1);
  broker.handlePreviewResult({
    requestId: firstRequest.requestId,
    ok: true,
    path: "same.png",
    mimeType: "image/png",
    data: Buffer.from("old").toString("base64"),
  });
  assert.match((await firstPromise).dataUrl, /b2xk$/);

  const cached = await broker.requestPreview("same.png");
  assert.match(cached.dataUrl, /b2xk$/);
  assert.equal(requests.length, 1);

  const oldPending = broker.requestPreview("pending.png");
  const staleRequest = requests.at(-1);
  broker.setWorkspaceScope({
    workspaceId: "workspace-b",
    rootPath: "/workspace-b",
    workspaceGeneration: 4,
  });
  assert.deepEqual(await oldPending, { ok: false, error: "Workspace changed." });

  const secondPromise = broker.requestPreview("same.png");
  const secondRequest = requests.at(-1);
  assert.notEqual(secondRequest.requestId, firstRequest.requestId);
  broker.handlePreviewResult({
    requestId: staleRequest.requestId,
    ok: true,
    path: "pending.png",
    mimeType: "image/png",
    data: Buffer.from("stale").toString("base64"),
  });
  broker.handlePreviewResult({
    requestId: secondRequest.requestId,
    ok: true,
    path: "same.png",
    mimeType: "image/png",
    data: Buffer.from("new").toString("base64"),
  });
  assert.match((await secondPromise).dataUrl, /bmV3$/);
});

test("excerpt cache cannot return an old root's same relative source", async () => {
  globalThis.window = browserWindow;
  const requests = [];
  const broker = createFileExcerptBroker((payload) => {
    requests.push(payload);
    return true;
  });
  broker.setWorkspaceScope({
    workspaceId: "workspace-a",
    rootPath: "/workspace-a",
    workspaceGeneration: 5,
  });

  const firstPromise = broker.requestExcerpt("main.tex", 10, { radius: 0, maxLines: 1 });
  const firstRequest = requests.at(-1);
  broker.handleExcerptResult({
    requestId: firstRequest.requestId,
    ok: true,
    path: "main.tex",
    startLine: 10,
    lines: ["old workspace"],
  });
  assert.deepEqual((await firstPromise).lines, ["old workspace"]);
  assert.deepEqual(
    (await broker.requestExcerpt("main.tex", 10, { radius: 0, maxLines: 1 })).lines,
    ["old workspace"],
  );
  assert.equal(requests.length, 1);

  broker.setWorkspaceScope({
    workspaceId: "workspace-b",
    rootPath: "/workspace-b",
    workspaceGeneration: 6,
  });
  const secondPromise = broker.requestExcerpt("main.tex", 10, { radius: 0, maxLines: 1 });
  const secondRequest = requests.at(-1);
  assert.notEqual(secondRequest.requestId, firstRequest.requestId);
  broker.handleExcerptResult({
    requestId: secondRequest.requestId,
    ok: true,
    path: "main.tex",
    startLine: 10,
    lines: ["new workspace"],
  });
  assert.deepEqual((await secondPromise).lines, ["new workspace"]);
});
