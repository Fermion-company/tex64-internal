"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  resolveTexizeWorkspaceAssets,
  rewriteTexizeAssetPaths,
} = require("../electron/handlers/texize.cjs");

test("texize workspace assets use the workspace boundary resolver", () => {
  const calls = [];
  const root = path.join(path.sep, "workspace");
  const workspace = {
    getRootPath: () => root,
    resolvePath: (relativePath) => {
      calls.push(relativePath);
      return path.join(root, relativePath);
    },
  };

  assert.deepEqual(resolveTexizeWorkspaceAssets(workspace), {
    absoluteDir: path.join(root, "assets/texize"),
    relativeDir: "assets/texize",
  });
  assert.deepEqual(calls, ["assets/texize"]);
  assert.equal(resolveTexizeWorkspaceAssets({ getRootPath: () => null }), null);
});

test("texize includegraphics paths become workspace-relative and stay idempotent", () => {
  const tex = [
    "\\includegraphics{p001_b04.png}",
    "\\includegraphics[width=0.8\\linewidth]{nested/plot.png}",
    "\\includegraphics{texize/p001_b04.png}",
    "\\includegraphics{assets/texize/already.png}",
    "\\includegraphics{../outside.png}",
  ].join("\n");
  const rewritten = rewriteTexizeAssetPaths(tex, "assets/texize");

  assert.equal(rewritten, [
    "\\includegraphics{assets/texize/p001_b04.png}",
    "\\includegraphics[width=0.8\\linewidth]{assets/texize/nested/plot.png}",
    "\\includegraphics{assets/texize/p001_b04.png}",
    "\\includegraphics{assets/texize/already.png}",
    "\\includegraphics{../outside.png}",
  ].join("\n"));
  assert.equal(rewriteTexizeAssetPaths(rewritten, "assets/texize"), rewritten);
});
