"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveEngineDir } = require("../electron/services/engine-dir.cjs");
const { MacFileAccessService } = require("../electron/services/mac-file-access.cjs");

const homeDir = "/Users/tester";

test("env and explicit directories are unconditional and env wins", () => {
  let probes = 0;
  const common = { name: "texize", marker: "venv/bin/python", homeDir,
    existsSync: () => { probes += 1; return true; } };
  assert.deepEqual(resolveEngineDir({ ...common, envDir: "/env/texize", explicitDir: "/explicit/texize" }),
    { dir: "/env/texize", needsAccess: null });
  assert.deepEqual(resolveEngineDir({ ...common, explicitDir: "/explicit/texize" }),
    { dir: "/explicit/texize", needsAccess: null });
  assert.equal(probes, 0);
});

test("selects an existing unprotected Developer candidate", () => {
  const fileAccess = new MacFileAccessService({ platform: "darwin", homeDir });
  const marker = `${homeDir}/Developer/texize/venv/bin/python`;
  assert.deepEqual(resolveEngineDir({ name: "texize", marker: "venv/bin/python", homeDir, fileAccess,
    existsSync: (candidate) => candidate === marker }),
  { dir: `${homeDir}/Developer/texize`, needsAccess: null });
});

test("does not stat an unknown Desktop candidate and reports needed access", () => {
  const fileAccess = new MacFileAccessService({ platform: "darwin", homeDir });
  const checked = [];
  const result = resolveEngineDir({ name: "texize", marker: "venv/bin/python", homeDir, fileAccess,
    existsSync: (candidate) => { checked.push(candidate); return false; } });
  assert.deepEqual(result, { dir: `${homeDir}/Desktop/texize`, needsAccess: "desktop" });
  assert.equal(checked.some((candidate) => candidate.startsWith(`${homeDir}/Desktop/`)), false);
});
