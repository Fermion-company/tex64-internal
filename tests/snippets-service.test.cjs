/**
 * Snippet storage (issue #38: "somewhere to manage the macros I reuse").
 * Two scopes on disk as plain JSON, so a project can commit its own snippets;
 * the built-ins are always present so the panel is never empty.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  SnippetsService,
  normalizePrefix,
  BUILTIN_SNIPPETS,
} = require("../electron/services/snippets.cjs");

const makeService = () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-snip-user-"));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-snip-ws-"));
  return {
    userDataPath,
    workspacePath,
    service: new SnippetsService({ userDataPath, getRootPath: () => workspacePath }),
  };
};

test("built-ins are always offered", async () => {
  const { service } = makeService();
  const result = await service.list();
  assert.equal(result.ok, true);
  assert.equal(result.snippets.length, BUILTIN_SNIPPETS.length);
  assert.ok(result.snippets.every((snippet) => snippet.scope === "builtin"));
});

test("a prefix is reduced to one completion word", () => {
  assert.equal(normalizePrefix("  fig  "), "fig");
  assert.equal(normalizePrefix("\\\\begin"), "begin");
  assert.equal(normalizePrefix("two words"), "twowords");
});

test("a snippet without a prefix or a body is refused", async () => {
  const { service } = makeService();
  assert.equal((await service.save({ prefix: "", body: "x" })).ok, false);
  assert.equal((await service.save({ prefix: "x", body: "" })).ok, false);
});

test("a global snippet survives and is listed after the built-ins", async () => {
  const { service, userDataPath } = makeService();
  const saved = await service.save({
    name: "My Lemma",
    prefix: "mylem",
    body: "\\begin{lemma}${1:body}\\end{lemma}",
    scope: "global",
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.snippet.scope, "global");
  assert.ok(fs.existsSync(path.join(userDataPath, "snippets.json")));

  const listed = await service.list();
  const mine = listed.snippets.filter((snippet) => snippet.scope === "global");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].prefix, "mylem");
});

test("a workspace snippet is written inside the project", async () => {
  const { service, workspacePath } = makeService();
  const saved = await service.save({ prefix: "wsonly", body: "x", scope: "workspace" });
  assert.equal(saved.ok, true);
  assert.ok(fs.existsSync(path.join(workspacePath, ".tex64", "snippets.json")));
  const listed = await service.list();
  assert.ok(listed.snippets.some((snippet) => snippet.scope === "workspace" && snippet.prefix === "wsonly"));
});

test("saving over an existing id updates it rather than duplicating", async () => {
  const { service } = makeService();
  const first = await service.save({ prefix: "dup", body: "one", scope: "global" });
  await service.save({ id: first.snippet.id, prefix: "dup", body: "two", scope: "global" });
  const listed = await service.list();
  const mine = listed.snippets.filter((snippet) => snippet.scope === "global");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].body, "two");
});

test("removing a snippet takes it out of the list", async () => {
  const { service } = makeService();
  const saved = await service.save({ prefix: "gone", body: "x", scope: "global" });
  assert.equal((await service.remove(saved.snippet.id, "global")).ok, true);
  const listed = await service.list();
  assert.equal(listed.snippets.filter((snippet) => snippet.scope === "global").length, 0);
  assert.equal((await service.remove(saved.snippet.id, "global")).ok, false);
});

test("a corrupt snippets file degrades to the built-ins instead of throwing", async () => {
  const { service, userDataPath } = makeService();
  fs.writeFileSync(path.join(userDataPath, "snippets.json"), "{ not json", "utf8");
  const listed = await service.list();
  assert.equal(listed.ok, true);
  assert.equal(listed.snippets.length, BUILTIN_SNIPPETS.length);
});

test("a workspace snippet is refused when no workspace is open", async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-snip-nows-"));
  const service = new SnippetsService({ userDataPath, getRootPath: () => null });
  const result = await service.save({ prefix: "x", body: "y", scope: "workspace" });
  assert.equal(result.ok, false);
});
