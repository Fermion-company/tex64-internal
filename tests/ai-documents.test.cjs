const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createWorkspaceAiDocumentHandlers,
} = require("../electron/handlers/workspace/ai-documents.cjs");

// The AI mode's 新規: a folder per document, named from the title, with a
// scaffold main.tex the first 組版 can already show. These tests pin the
// name sanitizing, the deduplication, and the listing order.

const makeHarness = ({ existing = [], mains = {} } = {}) => {
  const sent = [];
  const created = { folders: [], files: {} };
  const handlers = createWorkspaceAiDocumentHandlers({
    fs: {
      existsSync: (target) =>
        existing.includes(target) || created.folders.some((f) => target.endsWith(`/${f}`)),
      readdirSync: () =>
        Object.keys(mains).map((name) => ({
          name,
          isDirectory: () => true,
        })),
      statSync: (target) => ({ mtimeMs: mains[target.split("/").at(-2)] ?? 0 }),
    },
    workspace: {
      createFolder: async (folder) => created.folders.push(folder),
      writeFile: async (file, content) => {
        created.files[file] = content;
      },
      isIndexTarget: () => true,
    },
    sendToRenderer: (type, payload) => sent.push({ type, payload }),
    sendWorkspace: async () => {},
    ensureWorkspace: () => "/ws",
    updateWorkspaceIfNeeded: async () => {},
    requestIndex: () => {},
  });
  return { handlers, sent, created };
};

const lastReply = (sent, type) =>
  sent.filter((entry) => entry.type === type).at(-1)?.payload;

test("creates a folder named after the title, with a scaffold main.tex", async () => {
  const { handlers, sent, created } = makeHarness();
  await handlers.handleDocumentCreate("req-1", "学部量子力学の教科書");
  const reply = lastReply(sent, "document:createResult");
  assert.equal(reply.ok, true);
  assert.equal(reply.folder, "学部量子力学の教科書");
  assert.equal(reply.mainFile, "学部量子力学の教科書/main.tex");
  const scaffold = created.files[reply.mainFile];
  assert.match(scaffold, /\\documentclass\{ltjsarticle\}/);
  assert.match(scaffold, /\\title\{学部量子力学の教科書\}/);
  assert.match(scaffold, /\\maketitle/);
});

test("sanitizes what a folder name cannot hold, and escapes the title", async () => {
  const { handlers, sent, created } = makeHarness();
  await handlers.handleDocumentCreate("req-2", "  A/B: 50%の話…? \u0007 ");
  const reply = lastReply(sent, "document:createResult");
  assert.equal(reply.ok, true);
  assert.equal(reply.folder, "A B 50%の話…");
  assert.match(created.files[reply.mainFile], /\\title\{A B 50\\%の話…\}/);
});

test("an empty or dot-only title still becomes a usable folder", async () => {
  const { handlers, sent } = makeHarness();
  await handlers.handleDocumentCreate("req-3", " ... ");
  const reply = lastReply(sent, "document:createResult");
  assert.equal(reply.ok, true);
  assert.equal(reply.folder, "新しい文書");
});

test("a taken name gets a numbered sibling", async () => {
  const { handlers, sent } = makeHarness({ existing: ["/ws/レポート", "/ws/レポート 2"] });
  await handlers.handleDocumentCreate("req-4", "レポート");
  const reply = lastReply(sent, "document:createResult");
  assert.equal(reply.ok, true);
  assert.equal(reply.folder, "レポート 3");
});

test("lists documents newest first, root main.tex included", async () => {
  const { handlers, sent } = makeHarness({
    existing: ["/ws/main.tex", "/ws/古い/main.tex", "/ws/新しい/main.tex"],
    mains: { 古い: 100, 新しい: 300, ".hidden": 999 },
  });
  await handlers.handleDocumentList("req-5");
  const reply = lastReply(sent, "document:listResult");
  assert.equal(reply.ok, true);
  // Hidden folders never appear; the root document is named after the folder.
  assert.deepEqual(
    reply.documents.map((entry) => entry.name),
    ["新しい", "古い", "ws"],
  );
  assert.deepEqual(reply.documents[0], {
    name: "新しい",
    folder: "新しい",
    mainFile: "新しい/main.tex",
    updatedAt: 300,
  });
  const root = reply.documents.find((entry) => entry.folder === "");
  assert.equal(root.mainFile, "main.tex");
});
