"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { BuildService } = require("../electron/services/build/service.cjs");

// latexmk reads an argument that starts with "-" as an option: a source file
// named like one must reach it as a path, never as "-pdflatex=…".
test("an option-shaped main file name goes to latexmk as ./name", async () => {
  const service = new BuildService();
  service.findLatexmk = () => "/fake/latexmk";
  const calls = [];
  service.runProcess = async (command, args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  await service.runLatexmk("/tmp/project", "-pdflatex=echo PWNED;#.tex", "pdflatex", {});
  await service.runLatexmkClean("/tmp/project", "-pdflatex=echo PWNED;#.tex", {});
  await service.runLatexmk("/tmp/project", "main.tex", "pdflatex", {});
  for (const args of calls.slice(0, 2)) {
    assert.ok(args.includes("./-pdflatex=echo PWNED;#.tex"), JSON.stringify(args));
    assert.ok(!args.includes("-pdflatex=echo PWNED;#.tex"));
  }
  assert.equal(calls[2].at(-1), "main.tex");
});

// Jump and the realtime preview read SyncTeX: while the realtime preview runs,
// a profile's `-synctex=0` is not passed on; with it off the profile is obeyed.
test("a profile's -synctex=0 is dropped only while the realtime preview runs", async () => {
  const run = async (liveActive) => {
    const service = new BuildService({ liveActive });
    service.findLatexmk = () => "/fake/latexmk";
    let seen = null;
    service.runProcess = async (_command, args) => { seen = args; return { code: 0, stdout: "", stderr: "" }; };
    await service.runLatexmk("/tmp/project", "main.tex", "lualatex", { extraArgs: ["-synctex=0", "-shell-escape", "--synctex=0"] });
    return seen;
  };
  const live = await run(() => true);
  assert.ok(live.includes("-synctex=1") && !live.includes("-synctex=0") && !live.includes("--synctex=0"), JSON.stringify(live));
  assert.ok(live.includes("-shell-escape"));
  for (const off of [() => false, undefined, () => { throw new Error("x"); }]) {
    const args = await run(off);
    assert.ok(args.includes("-synctex=0") && args.includes("--synctex=0"), JSON.stringify(args));
  }
});
