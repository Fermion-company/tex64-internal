"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { handleReadFile, handleReadFiles } = require("../electron/services/agent-tools-file.cjs");
const { buildAgentPolicy } = require("../electron/services/agent-policy.cjs");

// Axiom's read_file prefers the editor snapshot sent with the message. That
// snapshot is cut at 10,000 characters (8,000 for other open files). A cut
// snapshot must never come back as if it were the whole file: Axiom would
// plan line numbers, or a full rewrite, from text that stops mid-document.
const fixture = async (t, snapshot) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-agent-read-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = {
    getContextSnapshot: (_conversation, target) => (target === snapshot.path ? snapshot : null),
    workspace: { resolvePath: (file) => path.join(root, file) },
  };
  return { root, service, policy: buildAgentPolicy() };
};

test("a truncated editor snapshot is not returned as the file; the complete file is read instead", async (t) => {
  const full = Array.from({ length: 800 }, (_, i) => `Paragraph ${i} of the chapter.`).join("\n") + "\n";
  const cut = full.slice(0, 10000);
  const f = await fixture(t, { path: "chapter.tex", content: cut, truncated: true, contentLength: full.length, isDirty: false });
  await fs.writeFile(path.join(f.root, "chapter.tex"), full);
  const single = await handleReadFile(f.service, { path: "chapter.tex" }, f.policy, "c1");
  assert.ok(single.content === full, `read_file returned ${single.content?.length} of ${full.length} characters`);
  assert.notEqual(single.partial, true);
  const many = await handleReadFiles(f.service, { paths: ["chapter.tex"] }, f.policy, "c1");
  const text = many.files["chapter.tex"].content;
  assert.ok(text === full, `read_files returned ${text?.length} of ${full.length} characters`);
});

test("a complete editor snapshot is still preferred (what the person sees)", async (t) => {
  const f = await fixture(t, { path: "main.tex", content: "buffer text\n", truncated: false, contentLength: 12, isDirty: true });
  await fs.writeFile(path.join(f.root, "main.tex"), "disk text\n");
  const single = await handleReadFile(f.service, { path: "main.tex" }, f.policy, "c1");
  assert.equal(single.content, "buffer text\n");
  assert.equal(single.source, "buffer");
});
