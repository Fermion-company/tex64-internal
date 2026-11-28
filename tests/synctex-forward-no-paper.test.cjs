"use strict";
// Jump with no paper to answer from (real-app verification 2026-11-25, D9,
// D10, D5): through the real Build handlers (handlers/build/index.cjs) on a
// project on disk.
//   D9  no PDF at all: the reader's Jump builds once and jumps on its PDF
//       (NEEDS_BUILD), from a preamble line, a body line or a child file.
//   D10 the Build profile turns SyncTeX off: no Build (it could never give
//       positions), the notice without its Build action (SYNCTEX_DISABLED).
//   D5  SyncTeX gone while the current source does not compile (Live's pass
//       failed): the notice, not a Build that fails the same way.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBuildHandlers } = require("../electron/handlers/build/index.cjs");
const { BuildService } = require("../electron/services/build/service.cjs");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");
const { SynctexService } = require("../electron/services/synctex/service.cjs");

const project = (t, { pdf = false, synctex = false, profileArgs = null } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-no-paper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "main.tex"),
    "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nHello.\n\\input{ch}\n\\end{document}\n");
  fs.writeFileSync(path.join(dir, "ch.tex"), "Chapter text.\n");
  if (pdf) fs.writeFileSync(path.join(dir, "main.pdf"), "%PDF-1.5\n");
  if (synctex) fs.writeFileSync(path.join(dir, "main.synctex"), "SyncTeX Version:1\n");
  const workspace = new WorkspaceManager();
  workspace.setRootPath(dir);
  if (profileArgs !== null) {
    workspace.loadSettings = async () => ({
      buildProfileId: "p", buildProfiles: [{ id: "p", engine: "lualatex", extraArgs: profileArgs }],
    });
  }
  return { dir, workspace };
};

const harness = ({ dir, workspace }, { live = undefined, lastBuildPdfPath = null } = {}) => {
  const sent = [];
  const handlers = createBuildHandlers({
    fs, path, workspace, buildService: new BuildService(), synctexService: new SynctexService({}),
    state: { lastBuildPdfPath }, delay: async () => {},
    ensureWorkspace: () => workspace.getRootPath(), updateWorkspaceIfNeeded: async () => {},
    sendBuildState: () => {}, sendIssues: () => {}, sendBuildLog: () => {}, handleOpenFile: async () => {},
    sendToRenderer: (type, payload) => { if (type === "synctex:forwardResult") sent.push(payload); },
    pdfWindowManager: { show() {}, queueSync() {} },
    ...(live === undefined ? {} : { getLiveEngine: () => ({ jumpToSource: async () => live }) }),
  });
  const jump = async (file, line, extra = {}) => {
    sent.length = 0;
    await handlers.handleSynctexForward({ type: "synctex:forward", requestId: "r", source: "manual", path: file, line,
      column: 1, fallbackToTop: true, pdfViewerMode: "tab", livePaper: live !== undefined, ...extra });
    return [...sent];
  };
  return { jump };
};

test("D9: no PDF at all — the reader's Jump builds the document once, from any line or a child file", async (t) => {
  const files = project(t);
  const { jump } = harness(files);
  for (const [file, line] of [["main.tex", 2], ["main.tex", 4], ["ch.tex", 1]]) {
    assert.deepEqual(await jump(file, line), [{ ok: false, code: "NEEDS_BUILD", targetFile: "main.tex", requestId: "r" }],
      `${file}:${line}`);
  }
  // Live up but behind (or down): the same
  const behind = harness(files, { live: { status: "pending", rootPath: path.join(files.dir, "main.tex") } });
  assert.equal((await behind.jump("main.tex", 4))[0].code, "NEEDS_BUILD");
});

test("D10: a profile that turns SyncTeX off — no Build, the notice without its Build action", async (t) => {
  const off = project(t, { pdf: true, profileArgs: "-synctex=0" });
  assert.deepEqual(await harness(off).jump("main.tex", 4),
    [{ ok: false, code: "SYNCTEX_DISABLED", error: "SyncTeX data was not found.", requestId: "r" }]);
  // the last Build's PDF read directly (the document not told): the same
  assert.equal((await harness(off, { lastBuildPdfPath: path.join(off.dir, "main.pdf") })
    .jump("main.tex", 4, { pdfPath: "main.pdf" }))[0].code, "SYNCTEX_DISABLED");
  // a profile that writes SyncTeX, the file merely missing: one Build, then the Jump
  const missing = project(t, { pdf: true, profileArgs: "-shell-escape" });
  assert.equal((await harness(missing).jump("main.tex", 4))[0].code, "NEEDS_BUILD");
  assert.equal((await harness(project(t, { pdf: true })).jump("main.tex", 4))[0].code, "NEEDS_BUILD");
});

test("D5: SyncTeX gone while the current source does not compile — the notice, not a Build that fails again", async (t) => {
  const files = project(t, { pdf: true });
  const failed = harness(files, { live: { status: "failed", rootPath: path.join(files.dir, "main.tex") } });
  assert.deepEqual(await failed.jump("main.tex", 4), [{ ok: false, error: "SyncTeX data was not found.", requestId: "r" }]);
  // red only because Live is behind: one Build, then the Jump
  const behind = harness(files, { live: { status: "pending", rootPath: path.join(files.dir, "main.tex") } });
  assert.equal((await behind.jump("main.tex", 4))[0].code, "NEEDS_BUILD");
  // no PDF either, source not compiling: "no PDF yet" notice (its Build action shows the error)
  const nothing = project(t);
  assert.deepEqual(await harness(nothing, { live: { status: "failed", rootPath: path.join(nothing.dir, "main.tex") } })
    .jump("main.tex", 4), [{ ok: false, error: "PDF has not been generated yet.", requestId: "r" }]);
});
