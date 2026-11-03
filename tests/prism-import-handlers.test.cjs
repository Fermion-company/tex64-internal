"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { createPrismImportHandlers } = require("../electron/handlers/prism-import.cjs");
const { BuildService } = require("../electron/services/build/service.cjs");

// A minimal zip writer (stored entries, UTF-8 names).
const makeZip = (files) => {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const crc = typeof zlib.crc32 === "function" ? zlib.crc32(data) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 10, 4);
    record.writeUInt16LE(10, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
};

const MAIN_TEX = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n";
// Would leave SENTINEL next to itself if latexmk ever evaluated it.
const LATEXMKRC = "open(my $fh, '>', 'SENTINEL'); print $fh \"rc ran\\n\"; close($fh);\n";

const tempDir = async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prism-handlers-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return fs.realpath(dir);
};

const writeZip = async (dir, name, files) => {
  const zipPath = path.join(dir, name);
  await fs.writeFile(zipPath, makeZip(files));
  return zipPath;
};

const exists = (target) => fs.lstat(target).then(() => true, () => false);

const harness = ({ parent, realLatexmk = false, dialogHook, detectHook, onProgress, envService: extraEnv = {} }) => {
  const runs = [];
  const progress = [];
  const calls = { detect: 0 };
  const buildService = new BuildService();
  if (!realLatexmk) {
    // Everything of a Build runs except latexmk itself; its argument list is
    // what reaches the command line.
    buildService.findLatexmk = () => "/fake/latexmk";
    buildService.runProcess = async function (command, args, cwd) {
      if (this.cancelRequested) return { output: "", status: 1, cancelled: true, timedOut: false };
      runs.push({ command, args, cwd });
      return { output: "! LaTeX Error: File `missing.sty' not found.", status: 12, cancelled: false, timedOut: false };
    };
  }
  let handlers = null;
  const envService = {
    detectEnvironment: async () => {
      calls.detect += 1;
      if (detectHook) await detectHook(handlers);
      return { ready: true, hasEngine: true, distribution: { name: "Test TeX" } };
    },
    locateTexFiles: async () => ({ missing: [] }),
    ...extraEnv,
  };
  const dialog = {
    showOpenDialog: async (_window, options) => (dialogHook ? dialogHook(handlers, options) : { canceled: false, filePaths: [parent] }),
  };
  handlers = createPrismImportHandlers({
    dialog,
    state: { mainWindow: null },
    envService,
    buildService,
    sendToRenderer: (_channel, payload) => {
      progress.push(payload);
      onProgress?.(payload, handlers);
    },
  });
  return { handlers, runs, progress, calls, buildService, envService };
};

const readSettings = async (root) => JSON.parse(await fs.readFile(path.join(root, ".tex64", "settings.json"), "utf8"));

test("import builds read no latexmkrc and run without shell escape; the saved profile and the rc file are left as they were", async (t) => {
  const dir = await tempDir(t);
  const zipPath = await writeZip(dir, "export.zip", { "paper/main.tex": MAIN_TEX, "paper/.latexmkrc": LATEXMKRC });
  const { handlers, runs, progress } = harness({ parent: dir });
  const started = await handlers.request("start", { zipPath, locale: "en", sessionId: "renderer-0001" });
  assert.equal(started.sessionId, "renderer-0001");
  assert.ok(progress.length > 0 && progress.every((payload) => payload.sessionId === "renderer-0001"));
  const [project] = started.projects;
  const result = await handlers.request("build", { sessionId: started.sessionId, projectId: project.id, mainFile: "main.tex", engine: "pdflatex", bibTool: "none" });
  assert.equal(result.build.ok, false);
  assert.equal(runs.length, 1);
  const { args, cwd } = runs[0];
  assert.ok(args.includes("-norc"), args.join(" "));
  assert.ok(args.includes("-no-shell-escape"), args.join(" "));
  assert.ok(!args.includes("-shell-escape"));
  assert.ok(!args.some((arg) => arg === "-r" || arg.startsWith("-r=")));
  assert.equal(cwd, project.root);
  assert.equal(await fs.readFile(path.join(project.root, ".latexmkrc"), "utf8"), LATEXMKRC);
  const settings = await readSettings(project.root);
  assert.equal(settings.rootFile, "main.tex");
  assert.equal(settings.buildProfiles[0].extraArgs, "-bibtex-");
  assert.equal(settings.buildProfiles[0].engine, "pdflatex");
});

test("upLaTeX import builds name their commands, since the user's latexmkrc is not read either", async (t) => {
  const dir = await tempDir(t);
  const zipPath = await writeZip(dir, "export.zip", {
    "report/main.tex": "\\documentclass[uplatex,dvipdfmx]{jsarticle}\n\\begin{document}\n日本語\\cite{a}\n\\bibliographystyle{jplain}\\bibliography{refs}\n\\end{document}\n",
    "report/refs.bib": "@book{a, title={本}, author={著者}, year={2020}, publisher={出版}}\n",
  });
  const { handlers, runs } = harness({ parent: dir });
  const started = await handlers.request("start", { zipPath, locale: "ja", sessionId: "renderer-0002" });
  const [project] = started.projects;
  assert.equal(project.analysis.engine, "uplatex");
  await handlers.request("build", { sessionId: started.sessionId, projectId: project.id, mainFile: "main.tex", engine: "uplatex", bibTool: "bibtex" });
  const { args } = runs[0];
  for (const expected of ["-pdfdvi", "-norc", "-no-shell-escape", "-bibtex", "-latex=uplatex", "$bibtex=q/upbibtex %O %S/", "$dvipdf=q/dvipdfmx %O -o %D %S/", "$makeindex=q/mendex %O -o %D %S/"]) {
    assert.ok(args.includes(expected), `${expected} missing from ${JSON.stringify(args)}`);
  }
  const settings = await readSettings(project.root);
  assert.equal(settings.buildProfiles[0].extraArgs, "-bibtex");
  assert.equal(settings.buildProfiles[0].engine, "uplatex");
});

test("with the real latexmk, the project's latexmkrc and \\write18 stay inert during the import build", async (t) => {
  const latexmk = new BuildService().findLatexmk();
  if (!latexmk) { t.skip("latexmk is not installed"); return; }
  const dir = await tempDir(t);
  const files = {
    "paper/main.tex": "\\documentclass{article}\n\\begin{document}\n\\immediate\\write18{makeindex -o shell.ind x.idx}\nHello\n\\end{document}\n",
    "paper/x.idx": "",
    "paper/.latexmkrc": LATEXMKRC,
  };
  // The control run shows the fixture is armed: plain latexmk evaluates the
  // rc file, and the default restricted shell escape runs makeindex.
  const control = path.join(dir, "control");
  await fs.mkdir(control);
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(control, path.basename(name)), text);
  spawnSync(latexmk, ["-pdf", "-interaction=nonstopmode", "main.tex"], { cwd: control, encoding: "utf8", env: { ...process.env, PATH: new BuildService().extendPath(process.env.PATH) } });
  assert.equal(await exists(path.join(control, "SENTINEL")), true, "control: latexmkrc did not run");
  assert.equal(await exists(path.join(control, "shell.ind")), true, "control: shell escape did not run");

  const zipPath = await writeZip(dir, "export.zip", files);
  const { handlers } = harness({ parent: dir, realLatexmk: true });
  const started = await handlers.request("start", { zipPath, locale: "en", sessionId: "renderer-0003" });
  const [project] = started.projects;
  const result = await handlers.request("build", { sessionId: started.sessionId, projectId: project.id, mainFile: "main.tex", engine: "pdflatex", bibTool: "none" });
  assert.equal(result.build.ok, true, JSON.stringify(result.build));
  assert.equal(await exists(path.join(project.root, "main.pdf")), true);
  assert.equal(await exists(path.join(project.root, "SENTINEL")), false, "latexmkrc ran during the import build");
  assert.equal(await exists(path.join(project.root, "shell.ind")), false, "\\write18 ran during the import build");
  assert.equal(await exists(path.join(project.root, ".latexmkrc")), true);
});

test("closing during extraction ends the import: nothing unpacked is left, no environment check, no build", async (t) => {
  const dir = await tempDir(t);
  const files = { "paper/main.tex": MAIN_TEX };
  for (let index = 0; index < 200; index += 1) files[`paper/figures/f${index}.txt`] = `figure ${index}`;
  const zipPath = await writeZip(dir, "export.zip", files);
  let endedAt = null;
  const { handlers, runs, progress, calls } = harness({
    parent: dir,
    onProgress: (payload, api) => {
      if (endedAt === null && payload.step === "extract" && payload.current === 5) {
        endedAt = progress.length;
        void api.request("end", { sessionId: payload.sessionId });
      }
    },
  });
  const started = await handlers.request("start", { zipPath, locale: "en", sessionId: "renderer-0004" });
  assert.deepEqual(started, { canceled: true });
  assert.notEqual(endedAt, null);
  assert.equal(progress.length, endedAt, "progress kept arriving after the session ended");
  assert.equal(await exists(path.join(dir, "export")), false);
  assert.equal(calls.detect, 0);
  assert.equal(runs.length, 0);
  await assert.rejects(handlers.request("build", { sessionId: "renderer-0004", projectId: "x", mainFile: "main.tex" }), { code: "SESSION_ENDED" });
});

test("closing while the destination dialog is open ends the import before anything is unpacked", async (t) => {
  const dir = await tempDir(t);
  const zipPath = await writeZip(dir, "export.zip", { "paper/main.tex": MAIN_TEX });
  const { handlers, progress, calls } = harness({
    parent: dir,
    dialogHook: async (api) => {
      await api.request("end", { sessionId: "renderer-0005" });
      return { canceled: false, filePaths: [dir] };
    },
  });
  assert.deepEqual(await handlers.request("start", { zipPath, locale: "en", sessionId: "renderer-0005" }), { canceled: true });
  assert.equal(progress.length, 0);
  assert.equal(calls.detect, 0);
  assert.equal(await exists(path.join(dir, "export")), false);
});

test("closing during the environment check removes the unpacked folder", async (t) => {
  const dir = await tempDir(t);
  const zipPath = await writeZip(dir, "export.zip", { "paper/main.tex": MAIN_TEX });
  const { handlers } = harness({ parent: dir, detectHook: (api) => api.request("end", { sessionId: "renderer-0006" }) });
  assert.deepEqual(await handlers.request("start", { zipPath, locale: "en", sessionId: "renderer-0006" }), { canceled: true });
  assert.equal(await exists(path.join(dir, "export")), false);
});

test("reopening during extraction: the first import stops and leaves nothing, the second completes and builds", async (t) => {
  const dir = await tempDir(t);
  const first = { "paper/main.tex": MAIN_TEX };
  for (let index = 0; index < 200; index += 1) first[`paper/data/d${index}.txt`] = `data ${index}`;
  const firstZip = await writeZip(dir, "first.zip", first);
  const secondZip = await writeZip(dir, "second.zip", { "notes/main.tex": MAIN_TEX });
  let second = null;
  const { handlers, runs, progress } = harness({
    parent: dir,
    onProgress: (payload, api) => {
      if (!second && payload.sessionId === "first-000001" && payload.current === 5) {
        void api.request("end", { sessionId: "first-000001" });
        second = api.request("start", { zipPath: secondZip, locale: "en", sessionId: "second-00002" });
      }
    },
  });
  const firstResult = await handlers.request("start", { zipPath: firstZip, locale: "en", sessionId: "first-000001" });
  assert.deepEqual(firstResult, { canceled: true });
  const secondResult = await second;
  assert.equal(secondResult.sessionId, "second-00002");
  assert.equal(await exists(path.join(dir, "first")), false);
  assert.equal(await exists(path.join(dir, "second", "main.tex")), true);
  const firstProgress = progress.filter((payload) => payload.sessionId === "first-000001");
  assert.ok(firstProgress.every((payload) => payload.step === "extract" && (payload.current ?? 0) <= 5));
  const [project] = secondResult.projects;
  await handlers.request("build", { sessionId: "second-00002", projectId: project.id, mainFile: "main.tex", engine: "pdflatex", bibTool: "none" });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].cwd, project.root);
  await assert.rejects(handlers.request("build", { sessionId: "first-000001", projectId: project.id, mainFile: "main.tex" }), { code: "SESSION_ENDED" });
});

test("closing during the missing-package installation does not start another typeset", async (t) => {
  const dir = await tempDir(t);
  const zipPath = await writeZip(dir, "export.zip", { "paper/main.tex": MAIN_TEX });
  let api = null;
  const { handlers, runs } = harness({
    parent: dir,
    envService: {
      installMissingPackagesFromLog: async () => {
        await api.request("end", { sessionId: "renderer-0008" });
        return { success: true, packages: ["missing"] };
      },
    },
  });
  api = handlers;
  const started = await handlers.request("start", { zipPath, locale: "en", sessionId: "renderer-0008" });
  const result = await handlers.request("build", { sessionId: started.sessionId, projectId: started.projects[0].id, mainFile: "main.tex", engine: "pdflatex", bibTool: "none" });
  assert.deepEqual(result, { canceled: true });
  assert.equal(runs.length, 1);
});

test("a session id from the renderer is used only when it looks like one", async (t) => {
  const dir = await tempDir(t);
  const zipPath = await writeZip(dir, "export.zip", { "paper/main.tex": MAIN_TEX });
  const { handlers } = harness({ parent: dir });
  const started = await handlers.request("start", { zipPath, locale: "en", sessionId: "../not an id" });
  assert.notEqual(started.sessionId, "../not an id");
  assert.match(started.sessionId, /^[0-9a-f-]{36}$/);
});
