"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");
const { registerZoteroHandlers } = require("../electron/handlers/zotero.cjs");
const { registerArxivHandlers } = require("../electron/handlers/arxiv.cjs");
const { parseBibEntries } = require("../electron/services/bib-append.cjs");

const gate = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const doc = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

const makeRoot = async (t, files) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-zotero-handlers-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content, "utf8");
  }
  return root;
};

// The workspace mutation lease as context.cjs implements it: one FIFO queue.
const createLease = () => {
  let tail = Promise.resolve();
  return async (operation) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
};

const harness = (workspace, client) => {
  const handlers = {};
  const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; } };
  const webContents = { mainFrame: {} };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const state = { mainWindow: { webContents }, workspaceGeneration: 1 };
  const withWorkspaceMutation = createLease();
  const settings = { getZoteroSettings: async () => ({ library: "bbt:1", libraryName: "My Library", libraryKind: "user" }), updateZoteroSettings: async () => {} };
  registerZoteroHandlers({
    ipcMain, workspace, state, safeStorage: null, ensureUserSettings: () => settings,
    afterBibWrite: async () => {}, withWorkspaceMutation, createClient: () => client,
  });
  return {
    state,
    withWorkspaceMutation,
    ipcMain,
    zotero: (action, payload) => handlers["tex64:zotero"](event, action, payload),
    registerArxiv: (service) => {
      registerArxivHandlers({ ipcMain, workspace, state, withWorkspaceMutation, isOwner: () => true, service });
      return (action, payload) => handlers["tex64:arxiv"](event, action, payload);
    },
  };
};

const fakeClient = (overrides = {}) => ({
  probe: async () => ({ transport: "bbt", bbt: { ok: true }, local: { ok: false }, web: { ok: false } }),
  libraries: async () => ({ ok: true, libraries: [{ id: "bbt:1", kind: "user", name: "My Library" }] }),
  search: async () => ({ ok: true, transport: "bbt", items: [] }),
  bibtexFor: async () => ({ ok: false, code: "not-found" }),
  refresh: async () => ({ ok: true, transport: "bbt", found: [], notFound: 0 }),
  ...overrides,
});

const item = { transport: "bbt", key: "ITEMNEW1", citekey: "new2026", title: "New", library: "bbt:1" };
const SAME_FILES = (label) => ({
  "main.tex": doc("\\bibliography{refs}"),
  "refs.bib": `% zotero: bbt:1/ITEMOLD1\n@article{old2020,\n  title={${label}}\n}\n`,
});

for (const boundary of ["A to B", "A to B to A"]) {
  test(`a Zotero citation answered after a project switch (${boundary}) writes nothing`, async (t) => {
    const rootA = await makeRoot(t, SAME_FILES("Project A"));
    const rootB = await makeRoot(t, SAME_FILES("Project B"));
    const workspace = new WorkspaceManager();
    workspace.setRootPath(rootA);
    const asked = gate();
    const answer = gate();
    const h = harness(workspace, fakeClient({ bibtexFor: async () => { asked.resolve(); return answer.promise; } }));
    const pending = h.zotero("cite", { item, activeFilePath: "main.tex" });
    await asked.promise;
    workspace.setRootPath(rootB);
    h.state.workspaceGeneration += 1;
    if (boundary === "A to B to A") {
      workspace.setRootPath(rootA);
      h.state.workspaceGeneration += 1;
    }
    answer.resolve({ ok: true, bibtex: "@article{new2026,\n  title={New}\n}", key: "new2026", zoteroRef: "bbt:1/ITEMNEW1" });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, "STALE_WORKSPACE");
    assert.equal(await fs.readFile(path.join(rootA, "refs.bib"), "utf8"), SAME_FILES("Project A")["refs.bib"]);
    assert.equal(await fs.readFile(path.join(rootB, "refs.bib"), "utf8"), SAME_FILES("Project B")["refs.bib"]);
  });
}

test("a Zotero refresh answered after a project switch leaves the next project's .bib alone", async (t) => {
  const rootA = await makeRoot(t, SAME_FILES("Project A"));
  const rootB = await makeRoot(t, SAME_FILES("Project B"));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(rootA);
  const asked = gate();
  const answer = gate();
  const h = harness(workspace, fakeClient({ refresh: async () => { asked.resolve(); return answer.promise; } }));
  const pending = h.zotero("sync", { activeFilePath: "main.tex" });
  await asked.promise;
  workspace.setRootPath(rootB);
  h.state.workspaceGeneration += 1;
  answer.resolve({ ok: true, transport: "bbt", found: [{ key: "old2020", bibtex: "@article{old2020,\n  title={Refreshed from A}\n}" }], notFound: 0 });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "STALE_WORKSPACE");
  assert.equal(await fs.readFile(path.join(rootB, "refs.bib"), "utf8"), SAME_FILES("Project B")["refs.bib"]);
});

test("Zotero cites into the active document's .bib and returns the key actually written", async (t) => {
  const root = await makeRoot(t, {
    "main.tex": doc("\\bibliography{main-refs}"),
    "notes.tex": doc("\\bibliography{notes-refs}"),
    "main-refs.bib": "",
    "notes-refs.bib": "% zotero: bbt:1/OTHER001\n@article{new2026,\n  title={Another paper}\n}\n",
  });
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  await workspace.setRootFile("main.tex");
  const h = harness(workspace, fakeClient({
    bibtexFor: async () => ({ ok: true, bibtex: "@article{new2026,\n  title={New}\n}", key: "new2026", zoteroRef: "bbt:1/ITEMNEW1" }),
  }));
  const result = await h.zotero("cite", { item, activeFilePath: "notes.tex" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.bibPath, "notes-refs.bib");
  assert.equal(result.key, "new2026a");
  assert.equal(await workspace.readFile("main-refs.bib"), "");
  const chosen = await h.zotero("cite", { item, activeFilePath: "notes.tex", documentMainFile: "main.tex" });
  assert.equal(chosen.bibPath, "main-refs.bib");
  assert.equal(chosen.key, "new2026");
});

test("an arXiv citation during a Zotero refresh keeps both changes", async (t) => {
  const root = await makeRoot(t, SAME_FILES("Old title"));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  const asked = gate();
  const answer = gate();
  const h = harness(workspace, fakeClient({ refresh: async () => { asked.resolve(); return answer.promise; } }));
  const arxiv = h.registerArxiv({
    fetchArxivEntry: async (arxivId) => ({ arxivId, title: "Preprint", authors: ["Ada Smith"], year: "2023" }),
  });
  const syncing = h.zotero("sync", { activeFilePath: "main.tex" });
  await asked.promise;
  const cited = await arxiv("cite", { arxivId: "2301.04567", activeFilePath: "main.tex" });
  assert.equal(cited.ok, true, cited.error);
  answer.resolve({ ok: true, transport: "bbt", found: [{ key: "old2020", bibtex: "@article{old2020,\n  title={New title}\n}" }], notFound: 0 });
  const synced = await syncing;
  assert.equal(synced.ok, true, synced.error);
  assert.equal(synced.updated, 1);
  const entries = parseBibEntries(await workspace.readFile("refs.bib"));
  assert.deepEqual(entries.map((entry) => entry.key), ["old2020", "smith20234567"]);
  assert.match(entries[0].body, /New title/);
  assert.equal(entries[0].zoteroRef, "bbt:1/ITEMOLD1");
});

test("simultaneous Zotero and arXiv citations both land in the .bib", async (t) => {
  const root = await makeRoot(t, { "main.tex": doc("\\bibliography{refs}"), "refs.bib": "" });
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  const both = gate();
  const h = harness(workspace, fakeClient({
    bibtexFor: async () => { await both.promise; return { ok: true, bibtex: "@article{new2026,\n  title={New}\n}", key: "new2026", zoteroRef: "bbt:1/ITEMNEW1" }; },
  }));
  const arxiv = h.registerArxiv({
    fetchArxivEntry: async (arxivId) => { await both.promise; return { arxivId, title: "Preprint", authors: ["Ada Smith"], year: "2023" }; },
  });
  const pending = Promise.all([
    h.zotero("cite", { item, activeFilePath: "main.tex" }),
    arxiv("cite", { arxivId: "2301.04567", activeFilePath: "main.tex" }),
    arxiv("cite", { arxivId: "2301.07654", activeFilePath: "main.tex" }),
  ]);
  both.resolve();
  const results = await pending;
  assert.deepEqual(results.map((result) => result.ok), [true, true, true]);
  const keys = parseBibEntries(await workspace.readFile("refs.bib")).map((entry) => entry.key).sort();
  assert.deepEqual(keys, ["new2026", "smith20234567", "smith20237654"]);
});
