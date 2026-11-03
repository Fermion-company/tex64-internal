"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createZoteroClient } = require("../electron/services/zotero-client.cjs");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");
const { registerZoteroHandlers } = require("../electron/handlers/zotero.cjs");

// Better BibTeX's JSON-RPC on a fake fetch; the local API answers 404 and
// there is no web key, so Better BibTeX is the door. A method that throws
// answers as a JSON-RPC error, as Better BibTeX does for an unknown citekey.
const bbtFetch = (methods, calls = []) => async (url, init = {}) => {
  if (!String(url).endsWith("/better-bibtex/json-rpc")) return new Response("", { status: 404 });
  const request = JSON.parse(init.body);
  calls.push({ method: request.method, params: request.params });
  const handler = methods[request.method];
  let payload;
  try {
    if (!handler) throw new Error(`method not found: ${request.method}`);
    payload = { jsonrpc: "2.0", id: request.id, result: await handler(...request.params) };
  } catch (error) {
    payload = { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: error.message } };
  }
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
};

const library = (entries) => ({
  "user.groups": () => [{ id: 7, name: "Lab Group" }],
  "item.export": (citekeys, _translator, libraryId) => {
    const found = entries[`${libraryId ?? 1}:${citekeys[0]}`];
    if (!found) throw new Error(`no item with citekey ${citekeys[0]}`);
    return found;
  },
});

test("Better BibTeX refresh follows a noted item whose citekey was renamed", async () => {
  const calls = [];
  const client = createZoteroClient({
    getApiKey: () => "",
    fetchImpl: bbtFetch({
      ...library({ "1:smith2020deep": "@article{smith2020deep,\n  title={Renamed and refreshed}\n}\n" }),
      "item.citationkey": (keys) => Object.fromEntries(keys.map((key) => [key, key === "1:ITEMAAAA" ? "smith2020deep" : null])),
    }, calls),
  });
  const result = await client.refresh([{ key: "smith2020a", zoteroRef: "bbt:1/ITEMAAAA" }], "bbt:1");
  assert.equal(result.ok, true);
  assert.equal(result.notFound, 0);
  assert.deepEqual(result.found.map((found) => found.key), ["smith2020a"]);
  assert.match(result.found[0].bibtex, /Renamed and refreshed/);
  assert.ok(!calls.some((call) => call.method === "item.export" && call.params[0][0] === "smith2020a"));
});

test("a noted item that is gone counts as not found, even when its old key now names another item", async () => {
  const client = createZoteroClient({
    getApiKey: () => "",
    fetchImpl: bbtFetch({
      ...library({ "1:smith2020a": "@article{smith2020a,\n  title={A different paper}\n}\n" }),
      "item.citationkey": (keys) => Object.fromEntries(keys.map((key) => [key, null])),
    }),
  });
  const result = await client.refresh([{ key: "smith2020a", zoteroRef: "bbt:1/GONEGONE" }], "bbt:1");
  assert.deepEqual([result.found.length, result.notFound], [0, 1]);
});

test("a group note written through the Zotero API is found among Better BibTeX's groups", async () => {
  const client = createZoteroClient({
    getApiKey: () => "",
    fetchImpl: bbtFetch({
      ...library({ "7:hinton2006fast": "@article{hinton2006fast,\n  title={Fast}\n}\n" }),
      "item.citationkey": (keys) => Object.fromEntries(keys.map((key) => [key, key === "7:HINTON20" ? "hinton2006fast" : null])),
    }),
  });
  const result = await client.refresh([{ key: "hinton2006fast", zoteroRef: "groups:4242/HINTON20" }], "bbt:1");
  assert.deepEqual([result.found.length, result.notFound], [1, 0]);
});

test("a Better BibTeX without item.citationkey still refreshes by the document's key", async () => {
  const client = createZoteroClient({
    getApiKey: () => "",
    fetchImpl: bbtFetch(library({ "1:turing1950": "@article{turing1950,\n  title={Computing}\n}\n" })),
  });
  const result = await client.refresh([
    { key: "turing1950", zoteroRef: "bbt:1/TURING50" },
    { key: "handwritten", zoteroRef: null },
  ], "bbt:1");
  assert.equal(result.ok, true);
  assert.deepEqual(result.found.map((found) => found.key), ["turing1950"]);
  assert.equal(result.notFound, 0);
});

test("sync keeps the document's key and note when Better BibTeX renamed the citekey", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-zotero-client-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\bibliography{refs}\n\\end{document}\n");
  await fs.writeFile(path.join(root, "refs.bib"), "% zotero: bbt:1/ITEMAAAA\n@article{smith2020a,\n  title={Old}\n}\n");
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  const fetchImpl = bbtFetch({
    ...library({ "1:smith2020deep": "@article{smith2020deep,\n  title={New}\n}\n" }),
    "item.citationkey": (keys) => Object.fromEntries(keys.map((key) => [key, key === "1:ITEMAAAA" ? "smith2020deep" : null])),
  });
  const handlers = {};
  const webContents = { mainFrame: {} };
  registerZoteroHandlers({
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    workspace,
    state: { mainWindow: { webContents }, workspaceGeneration: 1 },
    safeStorage: null,
    ensureUserSettings: () => ({ getZoteroSettings: async () => ({ library: "bbt:1" }), updateZoteroSettings: async () => {} }),
    createClient: (options) => createZoteroClient({ ...options, fetchImpl }),
  });
  const result = await handlers["tex64:zotero"]({ sender: webContents, senderFrame: webContents.mainFrame }, "sync", { activeFilePath: "main.tex" });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual([result.updated, result.notFound], [1, 0]);
  assert.equal(await workspace.readFile("refs.bib"), "% zotero: bbt:1/ITEMAAAA\n@article{smith2020a,\n  title={New}\n}\n");
});
