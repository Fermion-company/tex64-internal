const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  checkLatexInvariants,
  stripLatexComments,
} = require("../electron/services/agent-tools-safety.cjs");
const {
  handleDeleteLines,
  handleProposePatch,
  handleProposeWrite,
} = require("../electron/services/agent-tools-file.cjs");
const { buildAgentPolicy } = require("../electron/services/agent-policy.cjs");
const { buildTools } = require("../electron/services/openprism/tools.cjs");

const BOOK = [
  "\\documentclass{book}",
  "\\usepackage[backend=biber]{biblatex}",
  "\\addbibresource{references.bib}",
  "\\title{A Book}",
  "\\author{Author}",
  "\\begin{document}",
  "\\frontmatter",
  "\\maketitle",
  "\\tableofcontents",
  "\\mainmatter",
  "\\chapter{First}",
  "Body.",
  "\\backmatter",
  "\\printbibliography",
  "\\end{document}",
  "",
].join("\n");

const makeHarness = async (t, content = BOOK) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-structure-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "main.tex");
  await fsp.writeFile(filePath, content, "utf8");
  const proposals = new Map();
  const resolvePath = (relativePath) => {
    const resolved = path.resolve(root, relativePath);
    assert.ok(resolved.startsWith(`${root}${path.sep}`));
    return resolved;
  };
  const service = {
    proposals,
    workspace: {
      getRootPath: () => root,
      resolvePath,
    },
    getContextSnapshot: () => null,
    sendToRenderer: () => {},
    applyProposal: async (proposalId) => {
      const proposal = proposals.get(proposalId);
      await fsp.writeFile(resolvePath(proposal.path), proposal.content, "utf8");
      return { ok: true, proposalId };
    },
  };
  return {
    filePath,
    policy: buildAgentPolicy(),
    service,
  };
};

test("protects document navigation and bibliography structure", () => {
  const removals = new Map([
    ["\\tableofcontents", "\\tableofcontents"],
    ["\\frontmatter", "\\frontmatter"],
    ["\\mainmatter", "\\mainmatter"],
    ["\\backmatter", "\\backmatter"],
    ["\\addbibresource{references.bib}", "\\addbibresource"],
    ["\\printbibliography", "\\printbibliography"],
  ]);

  for (const [source, invariant] of removals) {
    assert.deepEqual(
      checkLatexInvariants("main.tex", BOOK, BOOK.replace(`${source}\n`, "")),
      [invariant],
    );
  }
});

test("protects BibTeX and inline thebibliography variants", () => {
  const bibtex = "\\begin{document}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}";
  assert.deepEqual(
    checkLatexInvariants("paper.tex", bibtex, bibtex.replace("\\bibliography{refs}\n", "")),
    ["\\bibliography"],
  );

  const inline = [
    "\\begin{document}",
    "\\begin{thebibliography}{9}",
    "\\bibitem{x} X",
    "\\end{thebibliography}",
    "\\end{document}",
  ].join("\n");
  assert.deepEqual(
    checkLatexInvariants(
      "paper.tex",
      inline,
      inline.replace("\\begin{thebibliography}{9}\n", ""),
    ),
    ["\\begin{thebibliography}"],
  );
});

test("ignores commented commands but treats commenting out a live command as removal", () => {
  assert.equal(
    stripLatexComments("100\\% complete \\tableofcontents % trailing"),
    "100\\% complete \\tableofcontents ",
  );
  assert.deepEqual(
    checkLatexInvariants(
      "main.tex",
      "% \\tableofcontents\n\\begin{document}\n\\end{document}",
      "\\begin{document}\n\\end{document}",
    ),
    [],
  );
  assert.deepEqual(
    checkLatexInvariants("main.tex", BOOK, BOOK.replace("\\tableofcontents", "% \\tableofcontents")),
    ["\\tableofcontents"],
  );
});

test("allowFullRewrite does not permit dropping tableofcontents", async (t) => {
  const { filePath, policy, service } = await makeHarness(t);
  const rewritten = BOOK.replace("\\tableofcontents\n", "").replace("Body.", "Rewritten body.");
  const result = await handleProposeWrite(
    service,
    {
      path: "main.tex",
      content: rewritten,
      mode: "overwrite",
      allowFullRewrite: true,
    },
    policy,
    "conversation",
  );

  assert.equal(result.conflict, true);
  assert.deepEqual(result.brokenInvariants, ["\\tableofcontents"]);
  assert.match(result.error, /cannot be removed by Axiom editing tools/);
  assert.equal(await fsp.readFile(filePath, "utf8"), BOOK);
});

test("a full rewrite that preserves structure remains valid", async (t) => {
  const { filePath, policy, service } = await makeHarness(t);
  const rewritten = BOOK.replace("Body.", "A substantially rewritten body.");
  const result = await handleProposeWrite(
    service,
    {
      path: "main.tex",
      content: rewritten,
      mode: "overwrite",
      allowFullRewrite: true,
    },
    policy,
    "conversation",
  );

  assert.equal(result.status, "applied");
  assert.equal(await fsp.readFile(filePath, "utf8"), rewritten);
});

test("trusted internal structural removal uses a separate acknowledgement", async (t) => {
  const { filePath, policy, service } = await makeHarness(t);
  const rewritten = BOOK.replace("\\tableofcontents\n", "");
  const result = await handleProposeWrite(
    service,
    {
      path: "main.tex",
      content: rewritten,
      mode: "overwrite",
      allowFullRewrite: true,
      allowStructuralRemoval: true,
    },
    policy,
    "conversation",
  );

  assert.equal(result.status, "applied");
  assert.equal(await fsp.readFile(filePath, "utf8"), rewritten);
});

test("targeted deletion cannot borrow allowFullRewrite to remove structure", async (t) => {
  const { filePath, policy, service } = await makeHarness(t);
  const tocLine = BOOK.split("\n").indexOf("\\tableofcontents") + 1;
  const rejected = await handleDeleteLines(
    service,
    {
      path: "main.tex",
      startLine: tocLine,
      endLine: tocLine,
      allowFullRewrite: true,
    },
    policy,
    "conversation",
  );
  assert.equal(rejected.conflict, true);
  assert.deepEqual(rejected.brokenInvariants, ["\\tableofcontents"]);
  assert.equal(await fsp.readFile(filePath, "utf8"), BOOK);

  const accepted = await handleDeleteLines(
    service,
    {
      path: "main.tex",
      startLine: tocLine,
      endLine: tocLine,
      allowFullRewrite: true,
      allowStructuralRemoval: true,
    },
    policy,
    "conversation",
  );
  assert.equal(accepted.status, "applied");
  assert.doesNotMatch(await fsp.readFile(filePath, "utf8"), /\\tableofcontents/);
});

test("legacy search-and-replace proposals use the same structural guard", async (t) => {
  const { filePath, policy, service } = await makeHarness(t);
  const rejected = await handleProposePatch(
    service,
    { path: "main.tex", search: "\\tableofcontents\n", replace: "" },
    policy,
    "conversation",
  );
  assert.equal(rejected.conflict, true);
  assert.deepEqual(rejected.brokenInvariants, ["\\tableofcontents"]);
  assert.equal(await fsp.readFile(filePath, "utf8"), BOOK);

  const accepted = await handleProposePatch(
    service,
    {
      path: "main.tex",
      search: "\\tableofcontents\n",
      replace: "",
      allowStructuralRemoval: true,
    },
    policy,
    "conversation",
  );
  assert.equal(accepted.status, "applied");
  assert.doesNotMatch(await fsp.readFile(filePath, "utf8"), /\\tableofcontents/);
});

test("Axiom tool schemas and execution cannot expose the internal escape hatch", async (t) => {
  const { filePath, policy, service } = await makeHarness(t);
  const root = service.workspace.getRootPath();
  const tools = buildTools(
    service,
    "conversation",
    policy,
    { rootPath: root },
  );

  for (const name of ["write_file", "replace_lines", "delete_lines", "replace_section", "apply_patch"]) {
    const tool = tools.find((candidate) => candidate.function.name === name);
    assert.equal(tool.function.parameters.properties.allowStructuralRemoval, undefined);
  }

  // JSON schema should already prevent this extra argument. The execution
  // boundary also overwrites it so a non-conforming model/client cannot bypass
  // the invariant by inventing a hidden property.
  const writeFile = tools.find((candidate) => candidate.function.name === "write_file");
  const result = JSON.parse(
    await writeFile.execute({
      path: "main.tex",
      content: BOOK.replace("\\tableofcontents\n", ""),
      mode: "overwrite",
      allowFullRewrite: true,
      allowStructuralRemoval: true,
    }),
  );
  assert.equal(result.conflict, true);
  assert.deepEqual(result.brokenInvariants, ["\\tableofcontents"]);
  assert.equal(await fsp.readFile(filePath, "utf8"), BOOK);
});
