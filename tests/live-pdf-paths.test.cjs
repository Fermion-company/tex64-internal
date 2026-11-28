"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { previewSearchPaths, originalInput } = require("../electron/services/live-pdf-paths.cjs");
const { findTexCommand } = require("../electron/services/texlive-paths.cjs");
const { BuildService } = require("../electron/services/build.cjs");

test("TeX finds the correct sibling file when both the workspace and the temporary path contain search syntax", async t => {
  const kpsewhich = findTexCommand("kpsewhich");
  if (!kpsewhich) return t.skip("requires a TeX installation");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-paths-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "修士 論文;提出用"), nested = "本文 {最終,控え}";
  const sandbox = path.join(base, "一時;保存"), stage = path.join(sandbox, "stage");
  const cwd = path.join(stage, nested), sourceDir = path.join(root, nested);
  const rootFile = path.join(sourceDir, "学位 論文.tex");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(sourceDir, { recursive: true });
  const file = "texpreview-local.tex";
  for (const dir of [root, sourceDir, stage]) await fs.writeFile(path.join(dir, file), dir);
  const { entries, aliases } = await previewSearchPaths(sandbox, stage, cwd, root, rootFile);
  const find = async () => {
    const { stdout } = await promisify(execFile)(kpsewhich, [file], {
      cwd, env: { ...process.env, TEXINPUTS: [...entries, ""].join(path.delimiter) },
    });
    return path.resolve(cwd, stdout.trim());
  };
  const local = await find();
  assert.equal(originalInput(aliases, local), path.join(sourceDir, file));
  assert.equal(await fs.readFile(local, "utf8"), sourceDir);
  await fs.writeFile(path.join(cwd, file), "unsaved local edit");
  assert.equal(await fs.readFile(await find(), "utf8"), "unsaved local edit");
  await fs.rm(path.join(sourceDir, file));
  await fs.rm(path.join(cwd, file));
  assert.equal(await fs.readFile(await find(), "utf8"), stage);
});

test("Windows PowerShell launches and reaps the compiler with a Unicode cwd and arguments", {
  skip: process.platform !== "win32",
}, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-job-test-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "原稿 Ω;提出");
  await fs.mkdir(cwd);
  const filename = "学位 論文.tex";
  const program = "require('node:fs').writeFileSync(process.argv[1], process.argv[2], 'utf8')";
  const build = new BuildService();
  const result = await build.runProcess(process.execPath, ["-e", program, filename, "校正 ✓"], cwd, process.env);
  assert.equal(result.status, 0, result.output);
  assert.equal(result.cleanupFailed, false);
  assert.equal(await fs.readFile(path.join(cwd, filename), "utf8"), "校正 ✓");
});
