"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

const source = fs.readFileSync(require.resolve("../web-src/app/file-tree-utils.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;
const exportsUnderTest = {};
new Function("require", "exports", compiled)((name) => {
  assert.equal(name, "./i18n.js");
  return { getUiLocale: () => "ja" };
}, exportsUnderTest);
const { buildFileTree } = exportsUnderTest;
const names = (nodes) => nodes.map((node) => node.name);

test("the renderer sorts folders first and names naturally in every directory", () => {
  const files = ["ch10.tex", "ch2.tex", "Ch1.tex", "第10章/第10節.tex", "第10章/第2節.tex"];
  const folders = ["第10章", "第2章", "appendix"];
  const tree = buildFileTree(files, folders);
  assert.deepEqual(names(tree), ["appendix", "第2章", "第10章", "Ch1.tex", "ch2.tex", "ch10.tex"]);
  assert.deepEqual(names(tree[2].children), ["第2節.tex", "第10節.tex"]);
});

test("refreshed snapshots give equivalent names a deterministic order after create, rename and delete", () => {
  const tree = (files) => names(buildFileTree(files, []));
  const files = ["ch2.tex", "CH2.tex", "ch02.tex", "ch10.tex"];
  const original = ["CH2.tex", "ch02.tex", "ch2.tex", "ch10.tex"];
  assert.deepEqual(tree(files), original);
  assert.deepEqual(tree(files.slice().reverse()), original);
  assert.deepEqual(tree(["ch3.tex", ...files]), ["CH2.tex", "ch02.tex", "ch2.tex", "ch3.tex", "ch10.tex"]);
  assert.deepEqual(tree(["ch20.tex", "ch2.tex", "ch3.tex", "CH2.tex"]), ["CH2.tex", "ch2.tex", "ch3.tex", "ch20.tex"]);
});
