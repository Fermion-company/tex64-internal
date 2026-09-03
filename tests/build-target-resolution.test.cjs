const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");
const doc = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const fixture = (t, files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-build-target-"));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  return { workspace, root };
};
test("independent nested main builds itself; fragments build their owning document", async (t) => {
  const { workspace } = fixture(t, {
    "main.tex": doc("Root"), "sub/main.tex": doc("\\input{chapter}"),
    "sub/chapter.tex": "Chapter", "sub/magic.tex": "% !TEX root = main.tex\nChild",
  });
  assert.equal(await workspace.resolveBuildTarget("sub/main.tex"), "sub/main.tex");
  assert.equal(await workspace.resolveBuildTarget("sub/chapter.tex"), "sub/main.tex");
  assert.equal(await workspace.resolveBuildTarget("sub/magic.tex"), "sub/main.tex");
  assert.equal(await workspace.resolveBuildTarget("main.pdf"), "main.tex");
});
test("nested plain inputs remain relative to the build cwd, while import scopes change", async (t) => {
  const { workspace } = fixture(t, {
    "main.tex": doc("\\input{chapters/one}\n\\import{imported/}{part}"),
    "chapters/one.tex": "\\input{chapters/two}", "chapters/two.tex": "Nested",
    "imported/part.tex": "\\input{fragment}", "imported/fragment.tex": "Imported",
    "sub.tex": doc("Other"),
  });
  assert.equal(await workspace.resolveBuildTarget("chapters/two.tex"), "main.tex");
  assert.equal(await workspace.resolveBuildTarget("imported/fragment.tex"), "main.tex");
});
test("commented includes do not claim ownership, intermediate fragments are not roots", async (t) => {
  const { workspace } = fixture(t, {
    "main.tex": doc("% \\input{other/chapter}"),
    "other/book.tex": doc("\\input{part}"), "other/part.tex": "\\input{chapter}",
    "other/chapter.tex": "% \\documentclass{article}\nChapter",
  });
  assert.equal(await workspace.resolveBuildTarget("other/chapter.tex"), "other/book.tex");
});
test("ambiguous parents require a magic root; traversal is rejected", async (t) => {
  const { workspace } = fixture(t, { "main.tex": doc("Root"), "a.tex": doc("\\input{shared}"), "b.tex": doc("\\input{shared}"), "shared.tex": "Shared" });
  await assert.rejects(workspace.resolveBuildTarget("shared.tex"), /Multiple documents/);
  await assert.rejects(workspace.resolveBuildTarget("../outside.tex"));
});
