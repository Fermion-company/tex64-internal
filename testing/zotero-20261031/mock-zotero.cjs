#!/usr/bin/env node
"use strict";

// A stand-in for a running Zotero 7 on this machine. Serves the two local
// doors TeX64 knocks on, with six fake items (two in a group):
//
//   POST /better-bibtex/json-rpc     user.groups / item.search / item.export
//   GET  /api/users/0/items?q=…      (+ ?format=bibtex, /items/<key>)
//   GET  /api/users/0/groups
//   GET  /api/groups/4242/items?q=…  (+ /items/<key>)
//
// Usage:  node mock-zotero.cjs            both doors open (BBT wins)
//         MOCK_BBT=0 node mock-zotero.cjs  BBT closed → local API path
//         MOCK_LOCAL=0 MOCK_BBT=0 …        both closed → "not reachable"
//         PORT=23119 (default)
//
// PUT /mock/bump?key=<itemKey> changes an item's title (to exercise sync).

const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 23119);
const BBT_ON = process.env.MOCK_BBT !== "0";
const LOCAL_ON = process.env.MOCK_LOCAL !== "0";
const GROUP_ID = 4242;

const items = [
  { key: "KNUTH1984", lib: "user", citekey: "knuth1984texbook", type: "book", title: "The TeXbook", creators: [["Donald E.", "Knuth"]], date: "1984", publisher: "Addison-Wesley" },
  { key: "LAMPORT94", lib: "user", citekey: "lamport1994latex", type: "book", title: "LaTeX: A Document Preparation System", creators: [["Leslie", "Lamport"]], date: "1994", publisher: "Addison-Wesley" },
  { key: "SHANNON48", lib: "user", citekey: "shannon1948mathematical", type: "article", title: "A Mathematical Theory of Communication", creators: [["Claude E.", "Shannon"]], date: "1948", journal: "Bell System Technical Journal", volume: "27", pages: "379--423" },
  { key: "TURING1950", lib: "user", citekey: "turing1950computing", type: "article", title: "Computing Machinery and Intelligence", creators: [["Alan M.", "Turing"]], date: "1950", journal: "Mind", volume: "59", pages: "433--460" },
  { key: "VASWANI17", lib: "group", citekey: "vaswani2017attention", type: "inproceedings", title: "Attention Is All You Need", creators: [["Ashish", "Vaswani"], ["Noam", "Shazeer"]], date: "2017", booktitle: "Advances in Neural Information Processing Systems" },
  { key: "HINTON2006", lib: "group", citekey: "hinton2006fast", type: "article", title: "A Fast Learning Algorithm for Deep Belief Nets", creators: [["Geoffrey E.", "Hinton"], ["Simon", "Osindero"]], date: "2006", journal: "Neural Computation", volume: "18", pages: "1527--1554" },
];
const libraryIdOf = (item) => (item.lib === "group" ? GROUP_ID : 0);
const bbtLibraryIdOf = (item) => (item.lib === "group" ? 7 : 1);

const bibtex = (item, key = item.citekey) => {
  const author = item.creators.map(([first, last]) => `${last}, ${first}`).join(" and ");
  const fields = [["title", `{${item.title}}`], ["author", `{${author}}`], ["year", `{${item.date}}`]];
  for (const name of ["journal", "booktitle", "publisher", "volume", "pages"]) if (item[name]) fields.push([name, `{${item[name]}}`]);
  return `@${item.type}{${key},\n${fields.map(([name, value]) => `  ${name} = ${value}`).join(",\n")}\n}\n`;
};
const zoteroJson = (item) => ({
  key: item.key,
  version: 1,
  library: item.lib === "group" ? { type: "group", id: GROUP_ID, name: "Lab Group" } : { type: "user", id: 0, name: "My Library" },
  data: {
    key: item.key, itemType: item.type === "inproceedings" ? "conferencePaper" : item.type === "article" ? "journalArticle" : "book",
    title: item.title, date: item.date, citationKey: item.citekey,
    creators: item.creators.map(([firstName, lastName]) => ({ creatorType: "author", firstName, lastName })),
  },
});
const matches = (item, q) => {
  const needle = String(q || "").toLowerCase().trim();
  if (!needle) return true;
  const hay = `${item.title} ${item.creators.map((c) => c.join(" ")).join(" ")} ${item.date} ${item.citekey}`.toLowerCase();
  return needle.split(/\s+/).every((word) => hay.includes(word));
};

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => { let data = ""; req.on("data", (chunk) => { data += chunk; }); req.on("end", () => resolve(data)); });

const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  log(req.method, url.pathname + url.search);

  if (url.pathname === "/mock/bump" && req.method === "PUT") {
    const item = items.find((entry) => entry.key === url.searchParams.get("key"));
    if (!item) return send(res, 404, { error: "no such item" });
    item.title = `${item.title} (rev)`;
    return send(res, 200, { ok: true, title: item.title });
  }

  if (url.pathname === "/better-bibtex/json-rpc") {
    if (!BBT_ON) return send(res, 404, "Not found", "text/plain");
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    let call;
    try { call = JSON.parse(await readBody(req)); } catch { return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); }
    const reply = (result) => send(res, 200, { jsonrpc: "2.0", result, id: call.id ?? null });
    const params = Array.isArray(call.params) ? call.params : [];
    if (call.method === "user.groups") return reply([{ id: 1, name: "My Library" }, { id: 7, name: "Lab Group" }]);
    if (call.method === "item.search") {
      const [terms, libraryID] = params;
      const found = items.filter((item) => matches(item, Array.isArray(terms) ? terms.join(" ") : terms))
        .filter((item) => !libraryID || bbtLibraryIdOf(item) === Number(libraryID))
        .map((item) => ({ ...zoteroJson(item).data, libraryID: bbtLibraryIdOf(item), citationKey: item.citekey, citekey: item.citekey }));
      return reply(found);
    }
    if (call.method === "item.export") {
      const [citekeys] = params;
      const keys = Array.isArray(citekeys) ? citekeys : [citekeys];
      const found = items.filter((item) => keys.includes(item.citekey));
      if (found.length === 0) return send(res, 200, { jsonrpc: "2.0", error: { code: 1, message: `No items found for ${keys.join(", ")}` }, id: call.id ?? null });
      return reply(found.map((item) => bibtex(item)).join("\n"));
    }
    return send(res, 200, { jsonrpc: "2.0", error: { code: -32601, message: `Method not found: ${call.method}` }, id: call.id ?? null });
  }

  const api = url.pathname.match(/^\/api\/(users|groups)\/(\d+)\/(items|groups)(?:\/([A-Za-z0-9]+))?\/?$/);
  if (api) {
    if (!LOCAL_ON) return send(res, 404, "Not found", "text/plain");
    const [, scope, id, resource, key] = api;
    if (resource === "groups") return send(res, 200, [{ id: GROUP_ID, version: 1, data: { id: GROUP_ID, name: "Lab Group", type: "Private" } }]);
    const lib = scope === "groups" ? "group" : "user";
    if (scope === "groups" && Number(id) !== GROUP_ID) return send(res, 404, { error: "no such group" });
    const pool = items.filter((item) => item.lib === lib);
    const format = url.searchParams.get("format") || "json";
    if (key) {
      const item = pool.find((entry) => entry.key === key);
      if (!item) return send(res, 404, "Not found", "text/plain");
      return format === "bibtex" ? send(res, 200, bibtex(item, `${item.creators[0][1].toLowerCase()}_${item.date}`), "text/plain; charset=utf-8") : send(res, 200, zoteroJson(item));
    }
    const limit = Number(url.searchParams.get("limit") || 25);
    const found = pool.filter((item) => matches(item, url.searchParams.get("q"))).slice(0, limit);
    if (format === "bibtex") return send(res, 200, found.map((item) => bibtex(item, `${item.creators[0][1].toLowerCase()}_${item.date}`)).join("\n"), "text/plain; charset=utf-8");
    return send(res, 200, found.map(zoteroJson));
  }

  send(res, 404, "Not found", "text/plain");
});

server.listen(PORT, "127.0.0.1", () => {
  log(`mock Zotero on http://127.0.0.1:${PORT}  BBT=${BBT_ON ? "on" : "off"} localAPI=${LOCAL_ON ? "on" : "off"}`);
});
