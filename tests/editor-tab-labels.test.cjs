"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const source = fs.readFileSync(require.resolve("../web-src/app/editor-tab-labels.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
const exported = {};
new Function("exports", compiled)(exported);
const { editorTabLabels } = exported;
const details = (paths) => editorTabLabels(paths).map((label) => label.detail);

test("unique names show the name alone", () => {
  assert.deepEqual(editorTabLabels(["main.tex", "chapters/intro.tex", "refs.bib"]), [
    { name: "main.tex", detail: "" },
    { name: "intro.tex", detail: "" },
    { name: "refs.bib", detail: "" },
  ]);
});

test("a root file and a folder file of the same name: only the folder one adds its folder", () => {
  assert.deepEqual(editorTabLabels(["main.tex", "appendix/main.tex", "intro.tex"]), [
    { name: "main.tex", detail: "" },
    { name: "main.tex", detail: "appendix" },
    { name: "intro.tex", detail: "" },
  ]);
});

test("colliding parents extend to the shortest distinguishing tail", () => {
  assert.deepEqual(details(["a/x/main.tex", "b/x/main.tex"]), ["a/x", "b/x"]);
  assert.deepEqual(details(["p/a/x/main.tex", "q/b/x/main.tex"]), ["a/x", "b/x"]);
  assert.deepEqual(details(["chapter1/main.tex", "chapter2/main.tex", "main.tex"]), ["chapter1", "chapter2", ""]);
});

test("a folder that is the tail of another keeps its whole path", () => {
  assert.deepEqual(details(["x/main.tex", "a/x/main.tex"]), ["x", "a/x"]);
});

test("each tab is compared only with tabs of the same name", () => {
  assert.deepEqual(details(["a/x/main.tex", "b/x/main.tex", "a/x/intro.tex"]), ["a/x", "b/x", ""]);
});

test("empty strip", () => {
  assert.deepEqual(editorTabLabels([]), []);
});
