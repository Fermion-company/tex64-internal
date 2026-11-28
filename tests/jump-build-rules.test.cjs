"use strict";
// Jump and a running Build: the renderer's decisions (web-src/app/jump-build-rules.ts).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const code = fs.readFileSync(require.resolve("../web-src/app/jump-build-rules.ts"), "utf8");
const exported = {};
new Function("exports", ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText)(exported);
const { jumpButtonEnabled, autoJumpAfterBuild, needsBuildAction } = exported;

const idle = { hasTarget: true, preparingBuild: false, building: false, previousPdf: false, livePaper: false };

test("Jump stays pressable during a Build while there is a paper to answer for", () => {
  assert.equal(jumpButtonEnabled(idle), true);
  // the Live paper goes on being typeset
  assert.equal(jumpButtonEnabled({ ...idle, building: true, livePaper: true }), true);
  // the previous Build's PDF stays in place until the Build swaps in its own
  assert.equal(jumpButtonEnabled({ ...idle, building: true, previousPdf: true }), true);
  // a first Build: nothing on screen to answer for
  assert.equal(jumpButtonEnabled({ ...idle, building: true }), false);
  // saving the files before a Build, and no .tex to jump from
  assert.equal(jumpButtonEnabled({ ...idle, preparingBuild: true, livePaper: true }), false);
  assert.equal(jumpButtonEnabled({ ...idle, hasTarget: false }), false);
});

test("a Jump made during the Build is not followed by the automatic one when it ends", () => {
  assert.equal(autoJumpAfterBuild({ enabled: true, jumpedDuringBuild: false }), true);
  assert.equal(autoJumpAfterBuild({ enabled: true, jumpedDuringBuild: true }), false);
  assert.equal(autoJumpAfterBuild({ enabled: false, jumpedDuringBuild: false }), false);
});

test("no PDF yet: build it, follow the Build already running, or say so after one", () => {
  assert.equal(needsBuildAction({ afterBuild: false, building: false, targetFile: "main.tex" }), "build");
  assert.equal(needsBuildAction({ afterBuild: false, building: true, targetFile: "main.tex" }), "follow");
  assert.equal(needsBuildAction({ afterBuild: true, building: false, targetFile: "main.tex" }), "notice");
  // no document named (it could not be told before a Build): the Build resolves it (real-app D9)
  assert.equal(needsBuildAction({ afterBuild: false, building: false, targetFile: "" }), "build");
});

test("a Jump that started the Build is the one move after it: no automatic Jump on top", () => {
  assert.equal(autoJumpAfterBuild({ enabled: true, jumpedDuringBuild: false, jumpFollowsBuild: true }), false);
  assert.equal(autoJumpAfterBuild({ enabled: true, jumpedDuringBuild: false, jumpFollowsBuild: false }), true);
});

test("the re-check after a Build: not while another Build comes, not after the automatic Jump", () => {
  const { recheckAllowed } = exported;
  assert.equal(recheckAllowed({ preparingBuild: false, building: false, autoJumped: false }), true);
  assert.equal(recheckAllowed({ preparingBuild: false, building: true, autoJumped: false }), false);
  assert.equal(recheckAllowed({ preparingBuild: true, building: false, autoJumped: false }), false);
  assert.equal(recheckAllowed({ preparingBuild: false, building: false, autoJumped: true }), false);
});

test("the re-check's line is a line of the text the Jump was made in", () => {
  const { recheckText } = exported;
  const jump = { path: "main.tex", line: 8, text: "as it was" };
  assert.equal(recheckText({ jump, file: "main.tex", line: 8, current: "typed since" }), "as it was");
  assert.equal(recheckText({ jump, file: "main.tex", line: 9, current: "typed since" }), "typed since");
  assert.equal(recheckText({ jump: null, file: "ch.tex", line: 1, current: undefined }), undefined);
});
