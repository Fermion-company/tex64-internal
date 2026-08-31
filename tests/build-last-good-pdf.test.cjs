"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { BuildService } = require("../electron/services/build.cjs");
const { findTexCommand } = require("../electron/services/texlive-paths.cjs");

const makeWorkspace = (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-last-good-pdf-"));
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(rootPath, "main.tex"),
    "\\documentclass{article}\\begin{document}ok\\end{document}\n"
  );
  return rootPath;
};

const stagePath = (rootPath, options, fileName) =>
  path.join(path.resolve(rootPath, options.outDir), fileName);

test("a failed rebuild keeps the previous PDF visible and removes staged output", async (t) => {
  const rootPath = makeWorkspace(t);
  const pdfPath = path.join(rootPath, "main.pdf");
  const synctexPath = path.join(rootPath, "main.synctex.gz");
  fs.writeFileSync(pdfPath, "%PDF-1.7\nlast-good\n");
  fs.writeFileSync(synctexPath, "last-good-sync\n");

  const service = new BuildService();
  service.runLatexmk = async (_root, _main, _engine, options) => {
    assert.match(options.outDir, /^\.tex64-build-/);
    assert.equal(fs.readFileSync(pdfPath, "utf8"), "%PDF-1.7\nlast-good\n");
    const backupDir = path.join(path.dirname(path.resolve(rootPath, options.outDir)), "backup");
    const pdfBackupPath = fs
      .readdirSync(backupDir)
      .map((name) => path.join(backupDir, name))
      .find((candidate) => fs.readFileSync(candidate, "utf8").startsWith("%PDF"));
    assert.ok(pdfBackupPath);
    const backupStats = fs.statSync(pdfBackupPath);
    const originalStats = fs.statSync(pdfPath);
    if (Number(backupStats.ino) > 0 && Number(originalStats.ino) > 0) {
      assert.notEqual(backupStats.ino, originalStats.ino);
    }
    // Real latexmk can remove cwd/main.pdf even though its requested outDir is
    // the staging directory. Model that destructive side effect explicitly.
    fs.unlinkSync(pdfPath);
    fs.unlinkSync(synctexPath);
    fs.writeFileSync(stagePath(rootPath, options, "main.pdf"), "%PDF-1.7\npartial\n");
    return {
      status: 1,
      output: "./main.tex:1: Undefined control sequence.\nLatexmk: Errors, so I did not complete making targets\n",
    };
  };

  const result = await service.runBuild(rootPath, "main.tex", "lualatex", null);

  assert.equal(result.kind, "failure");
  assert.equal(fs.readFileSync(pdfPath, "utf8"), "%PDF-1.7\nlast-good\n");
  assert.equal(fs.readFileSync(synctexPath, "utf8"), "last-good-sync\n");
  assert.equal(
    fs.readdirSync(rootPath).some((name) => name.startsWith(".tex64-build-")),
    false
  );
});

test("a successful rebuild atomically promotes the staged PDF and SyncTeX", async (t) => {
  const rootPath = makeWorkspace(t);
  const pdfPath = path.join(rootPath, "main.pdf");
  const synctexPath = path.join(rootPath, "main.synctex.gz");
  fs.writeFileSync(pdfPath, "%PDF-1.7\nlast-good\n");
  fs.writeFileSync(synctexPath, "old-sync");

  const service = new BuildService();
  service.runLatexmk = async (_root, _main, _engine, options) => {
    assert.match(options.outDir, /^\.tex64-build-/);
    assert.equal(fs.readFileSync(pdfPath, "utf8"), "%PDF-1.7\nlast-good\n");
    const stagedPdfPath = stagePath(rootPath, options, "main.pdf");
    fs.unlinkSync(pdfPath);
    fs.unlinkSync(synctexPath);
    fs.writeFileSync(stagedPdfPath, "%PDF-1.7\nnew-paper\n");
    fs.writeFileSync(stagedPdfPath.replace(/\.pdf$/, ".synctex.gz"), "new-sync");
    return { status: 0, output: "Output written on main.pdf\n" };
  };

  const result = await service.runBuild(rootPath, "main.tex", "lualatex", null);

  assert.equal(result.kind, "success");
  assert.equal(result.pdfPath, pdfPath);
  assert.equal(fs.readFileSync(pdfPath, "utf8"), "%PDF-1.7\nnew-paper\n");
  assert.equal(fs.readFileSync(synctexPath, "utf8"), "new-sync");
  assert.equal(
    fs.readdirSync(rootPath).some((name) => name.startsWith(".tex64-build-")),
    false
  );
});

test("a cancelled rebuild also leaves the last-good PDF untouched", async (t) => {
  const rootPath = makeWorkspace(t);
  const pdfPath = path.join(rootPath, "main.pdf");
  fs.writeFileSync(pdfPath, "%PDF-1.7\nlast-good\n");

  const service = new BuildService();
  service.runLatexmk = async (_root, _main, _engine, options) => {
    fs.unlinkSync(pdfPath);
    fs.writeFileSync(stagePath(rootPath, options, "main.pdf"), "%PDF-1.7\npartial\n");
    return { status: 1, cancelled: true, output: "cancelled" };
  };

  const result = await service.runBuild(rootPath, "main.tex", "lualatex", null);

  assert.equal(result.kind, "cancelled");
  assert.equal(fs.readFileSync(pdfPath, "utf8"), "%PDF-1.7\nlast-good\n");
  assert.equal(
    fs.readdirSync(rootPath).some((name) => name.startsWith(".tex64-build-")),
    false
  );
});

test("rollback does not depend on latexmk leaving the staging directory intact", async (t) => {
  const rootPath = makeWorkspace(t);
  const pdfPath = path.join(rootPath, "main.pdf");
  fs.writeFileSync(pdfPath, "%PDF-1.7\nlast-good\n");

  const service = new BuildService();
  service.runLatexmk = async (_root, _main, _engine, options) => {
    fs.unlinkSync(pdfPath);
    fs.rmSync(path.resolve(rootPath, options.outDir), { recursive: true, force: true });
    return {
      status: 1,
      output: "./main.tex:1: Undefined control sequence.\n",
    };
  };

  const result = await service.runBuild(rootPath, "main.tex", "lualatex", null);

  assert.equal(result.kind, "failure");
  assert.equal(fs.readFileSync(pdfPath, "utf8"), "%PDF-1.7\nlast-good\n");
  assert.equal(
    fs.readdirSync(rootPath).some((name) => name.startsWith(".tex64-build-")),
    false,
  );
});

test("a promotion error restores outputs that latexmk removed before committing", async (t) => {
  const rootPath = makeWorkspace(t);
  const pdfPath = path.join(rootPath, "main.pdf");
  const synctexPath = path.join(rootPath, "main.synctex.gz");
  fs.writeFileSync(pdfPath, "%PDF-1.7\nlast-good\n");
  fs.writeFileSync(synctexPath, "last-good-sync\n");

  const service = new BuildService();
  service.runLatexmk = async (_root, _main, _engine, options) => {
    fs.unlinkSync(pdfPath);
    fs.unlinkSync(synctexPath);
    const stagedPdfPath = stagePath(rootPath, options, "main.pdf");
    fs.writeFileSync(stagedPdfPath, "%PDF-1.7\nnew-paper\n");
    fs.symlinkSync(
      path.join(rootPath, "missing-synctex-target"),
      stagedPdfPath.replace(/\.pdf$/, ".synctex.gz"),
    );
    return { status: 0, output: "Output written on main.pdf\n" };
  };

  const result = await service.runBuild(rootPath, "main.tex", "lualatex", null);

  assert.equal(result.kind, "failure");
  assert.match(result.summary, /previous PDF was kept/);
  assert.equal(fs.readFileSync(pdfPath, "utf8"), "%PDF-1.7\nlast-good\n");
  assert.equal(fs.readFileSync(synctexPath, "utf8"), "last-good-sync\n");
  assert.equal(
    fs.readdirSync(rootPath).some((name) => name.startsWith(".tex64-build-")),
    false,
  );
});

test("an exact nested jobname build stages beside and promotes to its own PDF only", async (t) => {
  const rootPath = makeWorkspace(t);
  const docsPath = path.join(rootPath, "docs");
  fs.mkdirSync(docsPath);
  fs.writeFileSync(
    path.join(docsPath, "main.tex"),
    "\\documentclass{article}\\begin{document}nested\\end{document}\n"
  );
  const pdfPath = path.join(docsPath, "paper.pdf");
  const unrelatedPdfPath = path.join(rootPath, "main.pdf");
  fs.writeFileSync(pdfPath, "%PDF-1.7\nnested-old\n");
  fs.writeFileSync(unrelatedPdfPath, "%PDF-1.7\nroot-untouched\n");

  const service = new BuildService();
  service.runLatexmk = async (_root, mainFile, _engine, options) => {
    assert.equal(mainFile, "docs/main.tex");
    assert.match(options.outDir, /^docs[/\\]\.tex64-build-/);
    assert.deepEqual(options.extraArgs, ["-jobname=paper"]);
    assert.equal(options.hasExplicitOutDirArg, false);
    fs.writeFileSync(stagePath(rootPath, options, "paper.pdf"), "%PDF-1.7\nnested-new\n");
    return { status: 0, output: "Output written on paper.pdf\n" };
  };

  const result = await service.runBuild(rootPath, "docs/main.tex", "lualatex", {
    extraArgs: "-outdir docs -jobname=paper",
  });

  assert.equal(result.kind, "success");
  assert.equal(result.pdfPath, pdfPath);
  assert.equal(fs.readFileSync(pdfPath, "utf8"), "%PDF-1.7\nnested-new\n");
  assert.equal(fs.readFileSync(unrelatedPdfPath, "utf8"), "%PDF-1.7\nroot-untouched\n");
});

test("staging recreates nested aux directories recorded by the last good build", async (t) => {
  const rootPath = makeWorkspace(t);
  const docsPath = path.join(rootPath, "docs");
  fs.mkdirSync(path.join(docsPath, "chapters"), { recursive: true });
  fs.writeFileSync(
    path.join(docsPath, "main.tex"),
    "\\documentclass{book}\\begin{document}ok\\end{document}\n"
  );
  fs.writeFileSync(path.join(docsPath, "main.pdf"), "%PDF-1.7\nlast-good\n");
  fs.writeFileSync(
    path.join(docsPath, "main.fls"),
    `PWD ${fs.realpathSync(rootPath)}\nOUTPUT docs/main.pdf\nOUTPUT docs/chapters/one.aux\n`
  );

  const service = new BuildService();
  service.runLatexmk = async (_root, _main, _engine, options) => {
    const stagedChaptersPath = stagePath(rootPath, options, "chapters");
    assert.equal(fs.statSync(stagedChaptersPath).isDirectory(), true);
    fs.writeFileSync(stagePath(rootPath, options, "main.pdf"), "%PDF-1.7\nnew\n");
    return { status: 0, output: "Output written on main.pdf\n" };
  };

  const result = await service.runBuild(rootPath, "docs/main.tex", "lualatex", null);

  assert.equal(result.kind, "success");
  assert.equal(fs.readFileSync(path.join(docsPath, "main.pdf"), "utf8"), "%PDF-1.7\nnew\n");
});

test("staging mirrors a newly added source directory before it appears in the fls", async (t) => {
  const rootPath = makeWorkspace(t);
  fs.mkdirSync(path.join(rootPath, "new-chapter"));
  fs.writeFileSync(path.join(rootPath, "new-chapter", "one.tex"), "New chapter.\n");
  fs.writeFileSync(path.join(rootPath, "main.pdf"), "%PDF-1.7\nlast-good\n");

  const service = new BuildService();
  service.runLatexmk = async (_root, _main, _engine, options) => {
    assert.equal(fs.statSync(stagePath(rootPath, options, "new-chapter")).isDirectory(), true);
    fs.writeFileSync(stagePath(rootPath, options, "main.pdf"), "%PDF-1.7\nnew\n");
    return { status: 0, output: "Output written on main.pdf\n" };
  };

  const result = await service.runBuild(rootPath, "main.tex", "lualatex", null);

  assert.equal(result.kind, "success");
});

test("a symlinked prior PDF outside the workspace is never staged or replaced", async (t) => {
  const rootPath = makeWorkspace(t);
  const outsidePath = path.join(os.tmpdir(), `tex64-outside-${process.pid}-${Date.now()}.pdf`);
  t.after(() => fs.rmSync(outsidePath, { force: true }));
  fs.writeFileSync(outsidePath, "%PDF-1.7\noutside\n");
  fs.symlinkSync(outsidePath, path.join(rootPath, "main.pdf"));

  const service = new BuildService();
  let invoked = false;
  service.runLatexmk = async () => {
    invoked = true;
    return { status: 0, output: "" };
  };

  const result = await service.runBuild(rootPath, "main.tex", "lualatex", null);

  assert.equal(result.kind, "failure");
  assert.match(result.summary, /not a regular workspace file/);
  assert.equal(invoked, false);
  assert.equal(fs.readFileSync(outsidePath, "utf8"), "%PDF-1.7\noutside\n");
});

test("a broken PDF symlink is rejected before latexmk can follow it", async (t) => {
  const rootPath = makeWorkspace(t);
  const missingOutsidePath = path.join(
    os.tmpdir(),
    `tex64-missing-outside-${process.pid}-${Date.now()}.pdf`
  );
  fs.symlinkSync(missingOutsidePath, path.join(rootPath, "main.pdf"));

  const service = new BuildService();
  let invoked = false;
  service.runLatexmk = async () => {
    invoked = true;
    return { status: 0, output: "" };
  };

  const result = await service.runBuild(rootPath, "main.tex", "lualatex", null);

  assert.equal(result.kind, "failure");
  assert.match(result.summary, /not a regular workspace file/);
  assert.equal(invoked, false);
});

test("a first build rejects an outDir symlink that resolves outside the workspace", async (t) => {
  const rootPath = makeWorkspace(t);
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-outdir-outside-"));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outsidePath, "sentinel.txt"), "untouched\n");
  fs.symlinkSync(outsidePath, path.join(rootPath, "output"), "dir");

  const service = new BuildService();
  let invoked = false;
  service.runLatexmk = async () => {
    invoked = true;
    return { status: 0, output: "" };
  };

  const result = await service.runBuild(rootPath, "main.tex", "lualatex", {
    outDir: "output",
  });

  assert.equal(result.kind, "failure");
  assert.match(result.summary, /outDir is invalid/);
  assert.equal(invoked, false);
  assert.equal(fs.readFileSync(path.join(outsidePath, "sentinel.txt"), "utf8"), "untouched\n");
  assert.equal(fs.existsSync(path.join(outsidePath, "main.pdf")), false);
});

test("clean rejects an outDir whose existing parent symlink resolves outside", async (t) => {
  const rootPath = makeWorkspace(t);
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-clean-outside-"));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outsidePath, "main.aux"), "must survive\n");
  fs.symlinkSync(outsidePath, path.join(rootPath, "linked-output"), "dir");

  const service = new BuildService();
  let invoked = false;
  service.runLatexmkClean = async () => {
    invoked = true;
    return { status: 0, output: "" };
  };

  const result = await service.runClean(
    rootPath,
    "main.tex",
    { deep: true },
    { outDir: "linked-output/not-created" },
  );

  assert.equal(result.kind, "failure");
  assert.match(result.summary, /outDir is invalid/);
  assert.equal(invoked, false);
  assert.equal(fs.readFileSync(path.join(outsidePath, "main.aux"), "utf8"), "must survive\n");
  assert.equal(fs.existsSync(path.join(outsidePath, "not-created")), false);
});

test("the latexmk output-directory alias is subject to the same boundary check", async (t) => {
  const rootPath = makeWorkspace(t);
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-output-alias-"));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  fs.symlinkSync(outsidePath, path.join(rootPath, "aliased-output"), "dir");

  const service = new BuildService();
  let invoked = false;
  service.runLatexmk = async () => {
    invoked = true;
    return { status: 0, output: "" };
  };

  const result = await service.runBuild(rootPath, "main.tex", "lualatex", {
    extraArgs: "-output-directory=aliased-output",
  });

  assert.equal(result.kind, "failure");
  assert.match(result.summary, /outDir is invalid/);
  assert.equal(invoked, false);
  assert.equal(fs.existsSync(path.join(outsidePath, "main.pdf")), false);
});

test("latexmk aux-directory cannot write build artifacts through an external symlink", async (t) => {
  const rootPath = makeWorkspace(t);
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-aux-alias-"));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outsidePath, "main.aux"), "untouched aux\n");
  fs.symlinkSync(outsidePath, path.join(rootPath, "aliased-aux"), "dir");

  const service = new BuildService();
  let invoked = false;
  service.runLatexmkClean = async () => {
    invoked = true;
    return { status: 0, output: "" };
  };

  const result = await service.runClean(rootPath, "main.tex", {}, {
    extraArgs: "-aux-directory aliased-aux",
  });

  assert.equal(result.kind, "failure");
  assert.match(result.summary, /auxDir is invalid/);
  assert.equal(invoked, false);
  assert.equal(fs.readFileSync(path.join(outsidePath, "main.aux"), "utf8"), "untouched aux\n");
});

test("a real failed rebuild preserves the last successful PDF byte-for-byte", async (t) => {
  const service = new BuildService();
  if (!service.findLatexmk() || !findTexCommand("lualatex")) {
    t.skip("latexmk/lualatex is not installed in this test environment");
    return;
  }

  const rootPath = makeWorkspace(t);
  const mainPath = path.join(rootPath, "main.tex");
  const pdfPath = path.join(rootPath, "main.pdf");
  const sha256 = (filePath) =>
    crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

  const successful = await service.build(rootPath, "main.tex", "lualatex", null);
  assert.equal(successful.kind, "success", successful.summary);
  assert.equal(successful.pdfPath, pdfPath);
  assert.equal(fs.statSync(pdfPath).isFile(), true);
  const lastGoodSha = sha256(pdfPath);

  fs.writeFileSync(
    mainPath,
    "\\documentclass{article}\\begin{document}\\texSixtyFourIntentionalUndefinedCommand\\end{document}\n"
  );

  const failed = await service.build(rootPath, "main.tex", "lualatex", null);
  assert.equal(failed.kind, "failure", failed.summary);
  assert.equal(fs.statSync(pdfPath).isFile(), true);
  assert.equal(sha256(pdfPath), lastGoodSha);
  assert.equal(
    fs.readdirSync(rootPath).some((name) => name.startsWith(".tex64-build-")),
    false
  );
});
