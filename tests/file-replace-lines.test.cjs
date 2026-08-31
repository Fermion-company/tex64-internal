const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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

// The AI mode's direct paragraph edit writes back through file:replaceLines,
// a compare-and-swap on the exact lines the guest read. These tests pin the
// guard: replace only what was read, refuse anything stale, echo requestId.

const makeHarness = (initialContent, state = {}) => {
  const sent = [];
  const files = new Map([["main.tex", initialContent]]);
  const handlers = createWorkspaceFileHandlers({
    sendToRenderer: (type, payload) => sent.push({ type, payload }),
    ensureWorkspace: () => "/workspace",
    resolveWorkspacePath: (p) => `/workspace/${p}`,
    state,
    updateWorkspaceIfNeeded: async () => {},
    requestIndex: () => sent.push({ type: "indexRequested" }),
    isTextFilePath: (p) => p.endsWith(".tex"),
    isExtendedTextFilePath: () => false,
    workspace: {
      readFile: async (p) => {
        if (!files.has(p)) throw new Error("missing");
        return files.get(p);
      },
      writeFile: async (p, content) => {
        files.set(p, content);
      },
      isIndexTarget: (p) => p.endsWith(".tex"),
    },
  });
  return { handlers, sent, files };
};

const lastReply = (sent) =>
  sent.filter((entry) => entry.type === "file:replaceLinesResult").at(-1)?.payload;

test("replaces exactly the lines that were read", async () => {
  const { handlers, sent, files } = makeHarness("one\ntwo\nthree\nfour");
  const outcome = await handlers.handleReplaceLines("req-1", "main.tex", {
    startLine: 2,
    endLine: 3,
    expectedText: "two\nthree",
    replacementText: "TWO\nTHREE lines now",
  });
  assert.equal(lastReply(sent).requestId, "req-1");
  assert.equal(lastReply(sent).path, "main.tex");
  assert.equal(lastReply(sent).ok, true);
  // The dispatcher chains the rebuild off this return value.
  assert.equal(outcome.ok, true);
  assert.equal(files.get("main.tex"), "one\nTWO\nTHREE lines now\nfour");
  assert.ok(sent.some((entry) => entry.type === "indexRequested"));
});

test("uses a whole-file hash CAS and exposes internal undo content only to main", async () => {
  const original = "one\ntwo\nthree";
  const { handlers, sent, files } = makeHarness(original, {
    workspaceGeneration: 4,
    workspaceId: "ws-a",
  });
  const expectedContentHash = crypto.createHash("sha256").update(original).digest("hex");
  const outcome = await handlers.handleReplaceLines("req-cas", "main.tex", {
    startLine: 2,
    endLine: 2,
    expectedText: "two",
    replacementText: "TWO",
    expectedContentHash,
    documentMainFile: "book/main.tex",
    conversationId: "tex64-ai-mode:ws-a:book",
    workspaceGeneration: 4,
    workspaceId: "ws-a",
  });

  assert.equal(files.get("main.tex"), "one\nTWO\nthree");
  assert.equal(outcome.previousContent, original);
  assert.equal(outcome.content, "one\nTWO\nthree");
  assert.equal(outcome.documentMainFile, "book/main.tex");
  assert.equal(lastReply(sent).previousContent, undefined);
  assert.equal(lastReply(sent).workspaceGeneration, 4);
  const sync = sent.find((entry) => entry.type === "agent:applyContent")?.payload;
  assert.equal(sync.content, "one\nTWO\nthree");
  assert.equal(sync.source, "ai-direct-edit");
  assert.equal(sync.documentMainFile, "book/main.tex");
});

test("rejects a matching paragraph when another part of the file changed", async () => {
  const before = "one\ntwo\nthree";
  const after = "ONE edited elsewhere\ntwo\nthree";
  const { handlers, sent, files } = makeHarness(after);
  await handlers.handleReplaceLines("req-whole-file-cas", "main.tex", {
    startLine: 2,
    endLine: 2,
    expectedText: "two",
    replacementText: "TWO",
    expectedContentHash: crypto.createHash("sha256").update(before).digest("hex"),
  });
  assert.equal(lastReply(sent).stale, true);
  assert.equal(files.get("main.tex"), after);
});

test("rejects an edit from an older workspace generation", async () => {
  const { handlers, sent, files } = makeHarness("one\ntwo", {
    workspaceGeneration: 9,
    workspaceId: "ws-b",
  });
  await handlers.handleReplaceLines("req-old-root", "main.tex", {
    startLine: 2,
    endLine: 2,
    expectedText: "two",
    replacementText: "TWO",
    workspaceGeneration: 8,
    workspaceId: "ws-a",
  });
  assert.equal(lastReply(sent).stale, true);
  assert.equal(files.get("main.tex"), "one\ntwo");
});

test("serializes concurrent direct edits so only one whole-file CAS can win", async () => {
  const original = "one\ntwo\nthree";
  const expectedContentHash = crypto.createHash("sha256").update(original).digest("hex");
  const { handlers, sent, files } = makeHarness(original);
  const [first, second] = await Promise.all([
    handlers.handleReplaceLines("req-race-a", "main.tex", {
      startLine: 1,
      endLine: 1,
      expectedText: "one",
      replacementText: "ONE",
      expectedContentHash,
    }),
    handlers.handleReplaceLines("req-race-b", "main.tex", {
      startLine: 3,
      endLine: 3,
      expectedText: "three",
      replacementText: "THREE",
      expectedContentHash,
    }),
  ]);
  assert.equal([first.ok, second.ok].filter(Boolean).length, 1);
  assert.equal([first.stale, second.stale].filter(Boolean).length, 1);
  assert.ok(files.get("main.tex") === "ONE\ntwo\nthree" || files.get("main.tex") === "one\ntwo\nTHREE");
  assert.equal(
    sent.filter((entry) => entry.type === "agent:applyContent").length,
    1,
  );
});

test("refuses when the lines changed since they were read", async () => {
  const { handlers, sent, files } = makeHarness("one\ntwo edited elsewhere\nthree");
  const outcome = await handlers.handleReplaceLines("req-2", "main.tex", {
    startLine: 2,
    endLine: 2,
    expectedText: "two",
    replacementText: "TWO",
  });
  const reply = lastReply(sent);
  assert.equal(reply.ok, false);
  assert.equal(reply.stale, true);
  assert.equal(outcome.ok, false);
  assert.equal(files.get("main.tex"), "one\ntwo edited elsewhere\nthree");
});

test("refuses when the file got shorter than the request", async () => {
  const { handlers, sent } = makeHarness("only\ntwo lines");
  await handlers.handleReplaceLines("req-3", "main.tex", {
    startLine: 2,
    endLine: 5,
    expectedText: "whatever",
    replacementText: "x",
  });
  const reply = lastReply(sent);
  assert.equal(reply.ok, false);
  assert.equal(reply.stale, true);
});

test("preserves CRLF files", async () => {
  const { handlers, files } = makeHarness("one\r\ntwo\r\nthree");
  await handlers.handleReplaceLines("req-4", "main.tex", {
    startLine: 2,
    endLine: 2,
    expectedText: "two",
    replacementText: "TWO",
  });
  assert.equal(files.get("main.tex"), "one\r\nTWO\r\nthree");
});

test("rejects malformed requests and non-text formats", async () => {
  const { handlers, sent } = makeHarness("one");
  await handlers.handleReplaceLines("req-5", "main.tex", {
    startLine: 0,
    endLine: 1,
    expectedText: "one",
    replacementText: "x",
  });
  assert.equal(lastReply(sent).ok, false);
  await handlers.handleReplaceLines("req-6", "figure.png", {
    startLine: 1,
    endLine: 1,
    expectedText: "one",
    replacementText: "x",
  });
  assert.equal(lastReply(sent).ok, false);
  // Without a requestId there is nobody waiting; nothing should be sent.
  const before = sent.length;
  await handlers.handleReplaceLines(undefined, "main.tex", {
    startLine: 1,
    endLine: 1,
    expectedText: "one",
    replacementText: "x",
  });
  assert.equal(sent.length, before);
});

test("a root switch while direct edit is reading cannot write into the new root", async () => {
  const gate = deferred();
  const writes = [];
  const sent = [];
  const session = {
    rootPath: "/old",
    workspaceGeneration: 2,
    workspaceId: "old-id",
  };
  const handlers = createWorkspaceFileHandlers({
    sendToRenderer: (type, payload) => sent.push({ type, payload }),
    ensureWorkspace: () => session.rootPath,
    resolveWorkspacePath: (value) => `${session.rootPath}/${value}`,
    state: session,
    updateWorkspaceIfNeeded: async () => {},
    requestIndex: () => {},
    isTextFilePath: (value) => value.endsWith(".tex"),
    isExtendedTextFilePath: () => false,
    workspace: {
      readFile: async () => {
        await gate.promise;
        return "old text";
      },
      writeFile: async (value, content) => writes.push([session.rootPath, value, content]),
      isIndexTarget: () => false,
    },
  });
  const editing = handlers.handleReplaceLines("switch-edit", "main.tex", {
    startLine: 1,
    endLine: 1,
    expectedText: "old text",
    replacementText: "replacement",
    workspaceGeneration: 2,
    workspaceId: "old-id",
  });
  session.rootPath = "/new";
  session.workspaceGeneration = 3;
  session.workspaceId = "new-id";
  gate.resolve();
  const outcome = await editing;

  assert.equal(outcome.ok, false);
  assert.equal(outcome.stale, true);
  assert.deepEqual(writes, []);
});

test("a formatted Code save rechecks the captured root immediately before writing", async () => {
  const gate = deferred();
  const writes = [];
  const sent = [];
  const session = { rootPath: "/old", formatWarningShown: false };
  const handlers = createWorkspaceFileHandlers({
    sendToRenderer: (type, payload) => sent.push({ type, payload }),
    sendIssues: () => {},
    ensureWorkspace: () => session.rootPath,
    state: session,
    updateWorkspaceIfNeeded: async () => {},
    requestIndex: () => {},
    formatterService: {
      formatContent: async () => {
        await gate.promise;
        return { ok: true, content: "formatted" };
      },
    },
    workspace: {
      writeFile: async (value, content) => writes.push([session.rootPath, value, content]),
      isIndexTarget: () => false,
    },
  });
  const saving = handlers.handleSaveFile("main.tex", "original", { format: true });
  session.rootPath = "/new";
  gate.resolve();
  await saving;

  const result = sent.find((entry) => entry.type === "saveResult")?.payload;
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.deepEqual(writes, []);
});

test("a save blocked by an active external writer keeps the buffer retryable", async () => {
  const sent = [];
  const busyError = new Error("Axiom is updating this workspace.");
  busyError.code = "AGENT_WORKSPACE_BUSY";
  const handlers = createWorkspaceFileHandlers({
    sendToRenderer: (type, payload) => sent.push({ type, payload }),
    ensureWorkspace: () => "/workspace",
    state: {},
    updateWorkspaceIfNeeded: async () => {},
    requestIndex: () => {},
    isTextFilePath: () => true,
    isExtendedTextFilePath: () => false,
    withWorkspaceMutation: async () => {
      throw busyError;
    },
    workspace: {
      readFile: async () => "before",
      writeFile: async () => assert.fail("a blocked save must not write"),
      isIndexTarget: () => false,
      getRootPath: () => "/workspace",
    },
  });

  await handlers.handleSaveFile("main.tex", "after", {
    expectedContent: "before",
  });

  const result = sent.find((entry) => entry.type === "saveResult")?.payload;
  assert.equal(result.ok, false);
  assert.equal(result.busy, true);
});
