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

const makeHarness = (readBinaryFile, extra = {}) => {
  const sent = [];
  const session = {
    rootPath: "/workspace-a",
    workspaceGeneration: 5,
    workspaceId: "workspace-a",
  };
  const handlers = createWorkspaceFileHandlers({
    sendToRenderer: (type, payload) => sent.push({ type, payload }),
    ensureWorkspace: () => session.rootPath,
    state: session,
    workspace: { readBinaryFile },
    getFileExtension: (value) => value.split(".").at(-1).toLowerCase(),
    IMAGE_MIME_TYPES: new Map([
      ["png", "image/png"],
      ["jpg", "image/jpeg"],
      ["jpeg", "image/jpeg"],
    ]),
    ...extra,
  });
  return { handlers, sent, session };
};

const lastReply = (sent) =>
  sent.filter((entry) => entry.type === "file:bytesResult").at(-1)?.payload;

test("workspace bytes echo identity and viewer metadata", async () => {
  const bytes = Buffer.from("%PDF-1.4\n", "utf8");
  const { handlers, sent } = makeHarness(async () => bytes);
  await handlers.handleFileBytes("bytes-1", "out/book.pdf", {
    workspaceGeneration: 5,
    workspaceId: "workspace-a",
    documentMainFile: "book/main.tex",
  });

  assert.deepEqual(lastReply(sent), {
    requestId: "bytes-1",
    path: "out/book.pdf",
    workspaceGeneration: 5,
    workspaceId: "workspace-a",
    documentMainFile: "book/main.tex",
    ok: true,
    byteSize: bytes.byteLength,
    mimeType: "application/pdf",
    base64: bytes.toString("base64"),
  });
});

test("workspace bytes discard a read completed after the root changes", async () => {
  const gate = deferred();
  const { handlers, sent, session } = makeHarness(async () => {
    await gate.promise;
    return Buffer.from("old workspace", "utf8");
  });
  const reading = handlers.handleFileBytes("bytes-stale", "out/book.pdf", {
    workspaceGeneration: 5,
    workspaceId: "workspace-a",
  });
  session.rootPath = "/workspace-b";
  session.workspaceGeneration = 6;
  session.workspaceId = "workspace-b";
  gate.resolve();
  await reading;

  assert.equal(lastReply(sent).ok, false);
  assert.equal(lastReply(sent).stale, true);
  assert.equal(lastReply(sent).base64, undefined);
  assert.equal(lastReply(sent).workspaceGeneration, 5);
});

test("workspace bytes reject payloads above 32 MiB", async () => {
  const { handlers, sent } = makeHarness(
    async () => Buffer.alloc(32 * 1024 * 1024 + 1),
  );
  await handlers.handleFileBytes("bytes-large", "out/book.pdf", {
    workspaceGeneration: 5,
    workspaceId: "workspace-a",
  });

  assert.equal(lastReply(sent).ok, false);
  assert.match(lastReply(sent).error, /too large/i);
  assert.equal(lastReply(sent).base64, undefined);
});

test("workspace bytes reject a symlink resolved outside the selected root", async () => {
  let readCount = 0;
  const { handlers, sent } = makeHarness(
    async () => {
      readCount += 1;
      return Buffer.from("outside");
    },
    {
      resolveWorkspacePath: (value) => `/workspace-a/${value}`,
      fs: {
        realpathSync: (value) =>
          value === "/workspace-a" ? value : "/outside/private.pdf",
        statSync: () => ({ isFile: () => true, size: 7 }),
        promises: {
          readFile: async () => {
            readCount += 1;
            return Buffer.from("outside");
          },
        },
      },
    },
  );

  await handlers.handleFileBytes("bytes-symlink", "linked.pdf", {
    workspaceGeneration: 5,
    workspaceId: "workspace-a",
  });

  assert.equal(lastReply(sent).ok, false);
  assert.match(lastReply(sent).error, /outside the workspace/i);
  assert.equal(lastReply(sent).base64, undefined);
  assert.equal(readCount, 0);
});

test("workspace bytes enforce the size cap before loading the file", async () => {
  let readCount = 0;
  const { handlers, sent } = makeHarness(
    async () => {
      readCount += 1;
      return Buffer.alloc(0);
    },
    {
      resolveWorkspacePath: (value) => `/workspace-a/${value}`,
      fs: {
        realpathSync: (value) => value,
        statSync: () => ({ isFile: () => true, size: 32 * 1024 * 1024 + 1 }),
        promises: {
          readFile: async () => {
            readCount += 1;
            return Buffer.alloc(0);
          },
        },
      },
    },
  );

  await handlers.handleFileBytes("bytes-stat-large", "large.pdf", {
    workspaceGeneration: 5,
    workspaceId: "workspace-a",
  });

  assert.equal(lastReply(sent).ok, false);
  assert.match(lastReply(sent).error, /too large/i);
  assert.equal(readCount, 0);
});
