const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSynctexReverseHandler,
} = require("../electron/handlers/build/synctex-reverse.cjs");

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const makeHarness = (reverse) => {
  const sent = [];
  const calls = [];
  const session = {
    rootPath: "/workspace-a",
    workspaceGeneration: 8,
    workspaceId: "workspace-a",
    lastBuildPdfPath: "/workspace-a/old.pdf",
  };
  const handlers = createSynctexReverseHandler(
    {
      synctexService: {
        reverse: async (options) => {
          calls.push(options);
          return reverse(options);
        },
      },
      sendToRenderer: (type, payload) => sent.push({ type, payload }),
      ensureWorkspace: () => session.rootPath,
      state: session,
    },
    {
      resolveWorkspacePathFromRoot: (rootPath, value) =>
        typeof value === "string" && value ? `${rootPath}/${value}` : null,
      resolveWorkspaceRelativePath: (rootPath, value) =>
        typeof value === "string" && value.startsWith(`${rootPath}/`)
          ? value.slice(rootPath.length + 1)
          : null,
      resolveSynctexWorkspacePath: (rootPath, value) =>
        typeof value === "string" && value.startsWith(`${rootPath}/`) ? value : null,
    },
  );
  return { handlers, sent, calls, session };
};

const lastReply = (sent) =>
  sent.filter((entry) => entry.type === "synctex:reverseResult").at(-1)?.payload;

test("reverse SyncTeX echoes the exact workspace, document, request, and PDF", async () => {
  const { handlers, sent, calls } = makeHarness(async () => ({
    ok: true,
    path: "/workspace-a/book/main.tex",
    line: 19,
    column: 4,
    confidence: true,
  }));
  await handlers.handleSynctexReverse({
    requestId: "reverse-1",
    workspaceGeneration: 8,
    workspaceId: "workspace-a",
    documentMainFile: "book/main.tex",
    pdfPath: "book/main.pdf",
    page: 2,
    x: 30,
    y: 40,
    preferExact: true,
  });

  assert.equal(calls[0].pdfPath, "/workspace-a/book/main.pdf");
  assert.equal(calls[0].preferExact, true);
  assert.deepEqual(lastReply(sent), {
    ok: true,
    path: "book/main.tex",
    line: 19,
    column: 4,
    confidence: true,
    scoreGap: null,
    distance: null,
    hinted: false,
    hintCandidateCount: null,
    hintPreview: null,
    pdfPath: "book/main.pdf",
    requestId: "reverse-1",
    workspaceGeneration: 8,
    workspaceId: "workspace-a",
    documentMainFile: "book/main.tex",
  });
});

test("an exact hit outside the workspace falls back to the broader scorer", async () => {
  const { handlers, sent, calls } = makeHarness(async (options) =>
    options.preferExact
      ? {
          ok: true,
          path: "/texlive/article.cls",
          line: 100,
          column: 1,
          fastPath: true,
        }
      : {
          ok: true,
          path: "/workspace-a/book/main.tex",
          line: 27,
          column: 3,
          confidence: true,
        },
  );
  await handlers.handleSynctexReverse({
    requestId: "reverse-external-fallback",
    workspaceGeneration: 8,
    workspaceId: "workspace-a",
    documentMainFile: "book/main.tex",
    pdfPath: "book/main.pdf",
    page: 1,
    x: 20,
    y: 30,
    preferExact: true,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].preferExact, true);
  assert.equal(calls[1].preferExact, false);
  assert.equal(lastReply(sent).ok, true);
  assert.equal(lastReply(sent).path, "book/main.tex");
  assert.equal(lastReply(sent).line, 27);
});

test("reverse SyncTeX discards a result completed after a workspace switch", async () => {
  const gate = deferred();
  const { handlers, sent, session } = makeHarness(() => gate.promise);
  const locating = handlers.handleSynctexReverse({
    requestId: "reverse-stale",
    workspaceGeneration: 8,
    workspaceId: "workspace-a",
    documentMainFile: "book/main.tex",
    pdfPath: "book/main.pdf",
    page: 1,
    x: 10,
    y: 20,
  });
  session.rootPath = "/workspace-b";
  session.workspaceGeneration = 9;
  session.workspaceId = "workspace-b";
  gate.resolve({
    ok: true,
    path: "/workspace-a/book/main.tex",
    line: 5,
  });
  await locating;

  assert.equal(lastReply(sent).ok, false);
  assert.equal(lastReply(sent).stale, true);
  assert.equal(lastReply(sent).requestId, "reverse-stale");
  assert.equal(lastReply(sent).workspaceGeneration, 8);
  assert.equal(lastReply(sent).path, undefined);
});

test("a reverse SyncTeX failure after a workspace switch is stale, not a current error", async () => {
  const gate = deferred();
  const { handlers, sent, session } = makeHarness(() => gate.promise);
  const locating = handlers.handleSynctexReverse({
    requestId: "reverse-reject-stale",
    workspaceGeneration: 8,
    workspaceId: "workspace-a",
    pdfPath: "book/main.pdf",
    page: 1,
    x: 10,
    y: 20,
  });
  session.rootPath = "/workspace-b";
  session.workspaceGeneration = 9;
  session.workspaceId = "workspace-b";
  gate.reject(new Error("old parse failed"));
  await locating;

  assert.equal(lastReply(sent).ok, false);
  assert.equal(lastReply(sent).stale, true);
  assert.equal(lastReply(sent).error, "The workspace changed.");
});
