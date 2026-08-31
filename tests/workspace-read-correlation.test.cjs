const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createWorkspaceFileHandlers,
} = require("../electron/handlers/workspace/file-handlers.cjs");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const makeHarness = ({ readFile, readBinaryFile, formatContent }) => {
  const sent = [];
  const session = {
    rootPath: "/workspace-a",
    workspaceGeneration: 12,
    workspaceId: "workspace-a",
    formatWarningShown: false,
  };
  const handlers = createWorkspaceFileHandlers({
    fs: {},
    workspace: {
      readFile,
      readBinaryFile,
    },
    formatterService: { formatContent },
    sendToRenderer: (type, payload) => sent.push({ type, payload }),
    sendIssues: () => {},
    state: session,
    ensureWorkspace: () => session.rootPath,
    updateWorkspaceIfNeeded: async () => true,
    isPdfFilePath: (value) => value.endsWith(".pdf"),
    isImageFilePath: (value) => value.endsWith(".png"),
    isTextFilePath: (value) => value.endsWith(".tex"),
    isExtendedTextFilePath: () => false,
    getFileExtension: (value) => value.split(".").at(-1),
    IMAGE_MIME_TYPES: new Map([["png", "image/png"]]),
  });
  const switchWorkspace = () => {
    session.rootPath = "/workspace-b";
    session.workspaceGeneration = 13;
    session.workspaceId = "workspace-b";
  };
  return { handlers, sent, switchWorkspace };
};

test("an old openFile read cannot populate the same relative path in a new workspace", async () => {
  const started = deferred();
  const gate = deferred();
  const { handlers, sent, switchWorkspace } = makeHarness({
    readFile: async () => {
      started.resolve();
      await gate.promise;
      return "old workspace source";
    },
  });

  const opening = handlers.handleOpenFile("main.tex");
  await started.promise;
  switchWorkspace();
  gate.resolve();
  await opening;

  assert.deepEqual(
    sent.filter((entry) => entry.type === "openFileResult"),
    [],
  );
});

test("an old preview read settles stale without exposing its bytes", async () => {
  const started = deferred();
  const gate = deferred();
  const { handlers, sent, switchWorkspace } = makeHarness({
    readBinaryFile: async () => {
      started.resolve();
      await gate.promise;
      return Buffer.from("old-image");
    },
  });

  const previewing = handlers.handleFilePreview("preview-old", "figure.png");
  await started.promise;
  switchWorkspace();
  gate.resolve();
  await previewing;

  const result = sent.find((entry) => entry.type === "file:previewResult")?.payload;
  assert.equal(result.requestId, "preview-old");
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.equal(result.data, undefined);
});

test("an old formatter result cannot apply to the same path in a new workspace", async () => {
  const started = deferred();
  const gate = deferred();
  const { handlers, sent, switchWorkspace } = makeHarness({
    formatContent: async () => {
      started.resolve();
      await gate.promise;
      return { ok: true, content: "old formatted source" };
    },
  });

  const formatting = handlers.handleFormatFile(
    "main.tex",
    "old source",
    "manual",
    {},
  );
  await started.promise;
  switchWorkspace();
  gate.resolve();
  await formatting;

  const result = sent.find((entry) => entry.type === "formatResult")?.payload;
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.equal(result.content, undefined);
  assert.equal(result.path, "main.tex");
});
