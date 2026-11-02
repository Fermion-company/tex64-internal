#!/usr/bin/env node
// Bundles the renderer side of the collaboration layer (yjs, y-monaco,
// y-protocols, lib0) into one IIFE: Resources/web/vendor/collab.js, exposed as
// window.TeX64Collab. y-monaco imports monaco-editor as an ES module; this app
// loads Monaco as an AMD global, so that import is aliased to a shim whose
// exports are live getters on window.monaco (resolved on use, not on load).
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const esbuild = path.join(projectRoot, "web-src", "math", "fork", "node_modules", ".bin", "esbuild");
const outFile = path.join(projectRoot, "Resources", "web", "vendor", "collab.js");
const workDir = path.join(projectRoot, "node_modules", ".cache", "tex64-collab-vendor");
fs.mkdirSync(workDir, { recursive: true });

const shimPath = path.join(workDir, "monaco-shim.cjs");
fs.writeFileSync(shimPath, `
const live = new Proxy({}, { get: (_t, key) => (globalThis.monaco || {})[key] });
const shim = Object.create(live);
for (const key of ["Range", "Selection", "SelectionDirection", "Position", "editor", "Uri", "KeyMod", "KeyCode"]) {
  Object.defineProperty(shim, key, { enumerable: true, get: () => (globalThis.monaco || {})[key] });
}
module.exports = shim;
`);

const entryPath = path.join(workDir, "entry.js");
fs.writeFileSync(entryPath, `
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
export { Y, MonacoBinding, awarenessProtocol, syncProtocol, encoding, decoding };
`);

if (!fs.existsSync(esbuild)) {
  console.error(`[collab:vendor] esbuild not found at ${esbuild}. Run npm run mathlive:build once.`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
execFileSync(esbuild, [
  entryPath,
  "--bundle",
  "--format=iife",
  "--global-name=TeX64Collab",
  "--platform=browser",
  "--target=es2019",
  "--legal-comments=none",
  `--alias:monaco-editor/esm/vs/editor/editor.api.js=${shimPath}`,
  `--alias:monaco-editor=${shimPath}`,
  `--outfile=${outFile}`,
], { cwd: projectRoot, stdio: "inherit" });
const size = fs.statSync(outFile).size;
console.log(`[collab:vendor] wrote ${path.relative(projectRoot, outFile)} (${(size / 1024).toFixed(0)} KB)`);
