"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { rewriteFileCitations } = require("../electron/services/codex/axiom-adapter.cjs");

const ROOT = "/private/tmp/tex64-project";

test("turns a workspace file citation into a relative, openable link", () => {
  const text = `Done. :codex-file-citation{path="${ROOT}/main.tex" purpose="edit"}`;
  assert.equal(rewriteFileCitations(text, ROOT), "Done. [main.tex](tex64-file:main.tex)");
});

test("keeps nested paths relative to the workspace root", () => {
  const text = `:codex-file-citation{path="${ROOT}/chapters/intro.tex"}`;
  assert.equal(
    rewriteFileCitations(text, ROOT),
    "[chapters/intro.tex](tex64-file:chapters/intro.tex)",
  );
});

test("never leaks an absolute path from outside the workspace", () => {
  const text = ':codex-file-citation{path="/Users/someone/secret/notes.tex" purpose="output"}';
  const rewritten = rewriteFileCitations(text, ROOT);
  assert.equal(rewritten, "notes.tex");
  assert.ok(!rewritten.includes("/Users/someone"));
});

test("handles the bracketed directive form and unquoted attributes", () => {
  const text = `:codex-file-citation[codex-file-citation]{path=${ROOT}/main.pdf purpose=output}`;
  assert.equal(rewriteFileCitations(text, ROOT), "[main.pdf](tex64-file:main.pdf)");
});

test("rewrites every citation in a message", () => {
  const text = [
    `Wrote :codex-file-citation{path="${ROOT}/main.tex"}`,
    `and built :codex-file-citation{path="${ROOT}/main.pdf" purpose="output"}.`,
  ].join(" ");
  assert.equal(
    rewriteFileCitations(text, ROOT),
    "Wrote [main.tex](tex64-file:main.tex) and built [main.pdf](tex64-file:main.pdf).",
  );
});

test("escapes characters that would break the link target", () => {
  const text = `:codex-file-citation{path="${ROOT}/my paper.tex"}`;
  assert.equal(
    rewriteFileCitations(text, ROOT),
    "[my paper.tex](tex64-file:my%20paper.tex)",
  );
});

test("leaves ordinary text untouched", () => {
  const text = "No citations here — just prose with a colon: like this.";
  assert.equal(rewriteFileCitations(text, ROOT), text);
});

test("neutralises brackets and parentheses in file names", () => {
  const text = `:codex-file-citation{path="${ROOT}/draft (v2) [final].tex"}`;
  const rewritten = rewriteFileCitations(text, ROOT);
  assert.equal(
    rewritten,
    "[draft (v2) \\[final\\].tex](tex64-file:draft%20%28v2%29%20%5Bfinal%5D.tex)",
  );
});
