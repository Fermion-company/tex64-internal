"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LivePdfFallback } = require("../electron/services/live-pdf-fallback.cjs");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");
const { findTexCommand } = require("../electron/services/texlive-paths.cjs");

test("a completed draft with TeX errors preserves good references and a fatal partial run preserves the displayed PDF", {
  skip: !findTexCommand("pdflatex") && "requires pdflatex",
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-tex-error-"));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  const preview = new LivePdfFallback(workspace, () => {});
  t.after(async () => {
    preview.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const preamble = "\\documentclass{article}\n\\begin{document}\n";
  const source = preamble + "\\section{First}\\label{first}\n\\end{document}\n";
  await fs.writeFile(path.join(root, "main.tex"), source);
  const compile = text => preview.compile({ workspaceRoot: root, rootFile: "main.tex", engine: "pdflatex",
    buffers: [{ path: "main.tex", text }] });
  assert.equal((await compile(source)).ok, true);
  const references = preview.references;
  assert.ok(references?.files.size);
  const draft = await compile(preamble + "First page.\\newpage\nSecond \\notfinished\n\\end{document}\n");
  assert.equal(draft.ok, true);
  assert.match(draft.warning, /Undefined control sequence/);
  assert.strictEqual(preview.references, references);
  const fatal = await compile(preamble + "Partial output.\\newpage\n\\def\\unfinished{");
  assert.equal(fatal.code, "TDOM_TEX_ERROR");
  assert.equal(preview.latest.generation, draft.generation);
  assert.strictEqual(preview.references, references);
  const fixed = await compile(source + "% corrected\n");
  assert.equal(fixed.ok, true);
  assert.equal(fixed.warning, undefined);
  assert.ok(fixed.generation > draft.generation);
  assert.deepEqual(await fs.readdir(root), ["main.tex"]);
});
