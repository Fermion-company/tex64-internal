const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createWorkspaceFileHandlers,
} = require("../electron/handlers/workspace/file-handlers.cjs");

// The AI mode's direct paragraph edit writes back through file:replaceLines,
// a compare-and-swap on the exact lines the guest read. These tests pin the
// guard: replace only what was read, refuse anything stale, echo requestId.

const makeHarness = (initialContent) => {
  const sent = [];
  const files = new Map([["main.tex", initialContent]]);
  const handlers = createWorkspaceFileHandlers({
    sendToRenderer: (type, payload) => sent.push({ type, payload }),
    ensureWorkspace: () => "/workspace",
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
  assert.deepEqual(lastReply(sent), { requestId: "req-1", path: "main.tex", ok: true });
  // The dispatcher chains the rebuild off this return value.
  assert.equal(outcome.ok, true);
  assert.equal(files.get("main.tex"), "one\nTWO\nTHREE lines now\nfour");
  assert.ok(sent.some((entry) => entry.type === "indexRequested"));
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
