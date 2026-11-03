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
