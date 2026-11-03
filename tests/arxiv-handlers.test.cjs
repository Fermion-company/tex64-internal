"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");
const { registerArxivHandlers } = require("../electron/handlers/arxiv.cjs");

const gate = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const doc = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const FILES = { "main.tex": doc("\\bibliography{refs}"), "refs.bib": "@misc{keep, title={Keep}}\n" };

const makeRoot = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-arxiv-handlers-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(FILES)) await fs.writeFile(path.join(root, file), content, "utf8");
  return root;
};

const register = (workspace, service, state = { workspaceGeneration: 1 }) => {
  const handlers = {};
  const leased = [];
  registerArxivHandlers({
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    workspace,
    state,
    isOwner: () => true,
    withWorkspaceMutation: async (operation) => { leased.push(workspace.getRootPath()); return operation(); },
    service,
  });
  return { state, leased, call: (action, payload) => handlers["tex64:arxiv"]({}, action, payload) };
};

for (const boundary of ["A to B", "A to B to A"]) {
  test(`an arXiv citation answered after a project switch (${boundary}) writes nothing`, async (t) => {
    const rootA = await makeRoot(t);
    const rootB = await makeRoot(t);
    const workspace = new WorkspaceManager();
    workspace.setRootPath(rootA);
    const asked = gate();
    const answer = gate();
    const h = register(workspace, { fetchArxivEntry: async () => { asked.resolve(); return answer.promise; } });
    const pending = h.call("cite", { arxivId: "2301.04567", activeFilePath: "main.tex" });
    await asked.promise;
    workspace.setRootPath(rootB);
    h.state.workspaceGeneration += 1;
    if (boundary === "A to B to A") {
      workspace.setRootPath(rootA);
      h.state.workspaceGeneration += 1;
    }
    answer.resolve({ arxivId: "2301.04567", title: "Late", authors: ["Ada Smith"], year: "2023" });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, "STALE_WORKSPACE");
    assert.equal(await fs.readFile(path.join(rootA, "refs.bib"), "utf8"), FILES["refs.bib"]);
    assert.equal(await fs.readFile(path.join(rootB, "refs.bib"), "utf8"), FILES["refs.bib"]);
  });
}

test("an arXiv citation writes under the workspace lease and answers with the key written", async (t) => {
  const root = await makeRoot(t);
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  await workspace.writeFile("refs.bib", "@article{smith20234567,\n  title={Other},\n  eprint={2311.04567}\n}\n");
  const h = register(workspace, {
    fetchArxivEntry: async (arxivId) => ({ arxivId, title: "Mine", authors: ["Ada Smith"], year: "2023" }),
  });
  const result = await h.call("cite", { arxivId: "2301.04567", activeFilePath: "main.tex" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.key, "smith20234567a");
  assert.match(result.bibtex, /^@article\{smith20234567a,/);
  assert.deepEqual(h.leased, [root]);
});

test("a fragment of two documents with different bibliographies is refused before arXiv is asked", async (t) => {
  const root = await makeRoot(t);
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  await workspace.writeFile("a.tex", doc("\\input{part}\n\\bibliography{a-refs}"));
  await workspace.writeFile("b.tex", doc("\\input{part}\n\\bibliography{b-refs}"));
  await workspace.writeFile("part.tex", "Part.");
  let asked = 0;
  const h = register(workspace, {
    fetchArxivEntry: async (arxivId) => { asked += 1; return { arxivId, title: "T", authors: ["Ada Smith"], year: "2023" }; },
  });
  const refused = await h.call("cite", { arxivId: "2301.04567", activeFilePath: "part.tex" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "BUILD_TARGET_CHOICE");
  assert.equal(asked, 0);
  const chosen = await h.call("cite", { arxivId: "2301.04567", activeFilePath: "part.tex", documentMainFile: "b.tex" });
  assert.equal(chosen.ok, true, chosen.error);
  assert.equal(chosen.bibPath, "b-refs.bib");
});
