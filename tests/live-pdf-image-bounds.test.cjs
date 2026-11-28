"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { resolveImageBounds } = require("../electron/services/live-pdf-image-bounds.cjs");

test("upLaTeX keeps dimensions per image and page and remeasures a replaced figure", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-bounds-test-"));
  const savedPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = savedPath;
    await fs.rm(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, "project"), cwd = path.join(temp, "stage");
  await fs.mkdir(root);
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(temp, process.platform === "win32" ? "extractbb.exe" : "extractbb"), "", { mode: 0o755 });
  process.env.PATH = temp + path.delimiter + savedPath;
  const name = "図 A.pdf", figure = path.join(root, name), recorder = path.join(cwd, "main.fls");
  await fs.writeFile(figure, "first revision");
  await fs.writeFile(recorder, "INPUT " + figure + "\n");
  const manifest = "K " + "A".repeat(32) + "\nF " + name + "\nP 1\nB cropbox\n" +
    "K " + "B".repeat(32) + "\nF " + name + "\nP 2\nB mediabox\n";
  await fs.writeFile(path.join(cwd, "tex64-preview-bounds.req"), manifest);
  const bounds = { dir: cwd, files: new Map(), lookup: "kpsewhich", texTree: cwd };
  const calls = [];
  const measure = () => resolveImageBounds({
    bounds, root, temp, cwd, recorder, searchDirs: [cwd, root], current: () => true,
    run: async (_tool, args) => {
      calls.push(args);
      return { status: 0, output: "%%Title: ignored\n%%BoundingBox: 0 0 100 72\n" };
    },
  });
  assert.equal((await measure()).ready, false);
  const realFigure = await fs.realpath(figure);
  assert.deepEqual(calls, [["-p", "1", "-B", "cropbox", "-O", realFigure], ["-p", "2", "-B", "mediabox", "-O", realFigure]]);
  assert.equal((await measure()).ready, true);
  assert.equal(calls.length, 2);
  await fs.appendFile(figure, " new contents");
  assert.equal((await measure()).ready, false);
  assert.equal(calls.length, 4);
  await fs.writeFile(path.join(cwd, "tex64-preview-bounds.req"), "");
  assert.equal((await measure()).ready, true);
  assert.equal(bounds.files.size, 0);
});
