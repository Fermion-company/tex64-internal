const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BuildService } = require("../electron/services/build.cjs");

const MISSING_LOG = [
  "This is LuaHBTeX, Version 1.18.0 (TeX Live 2026)",
  "! LaTeX Error: File `tikz.sty' not found.",
  "",
  "Type X to quit or <RETURN> to proceed,",
].join("\n");

const withProject = async (fn) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-build-repair-"));
  fs.writeFileSync(path.join(root, "main.tex"), "\\documentclass{article}\\begin{document}x\\end{document}\n");
  try {
    return await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

// The light install is only defensible if a build that hits a missing package
// fixes itself; these cover that loop without touching a real TeX Live.
test("a build that failed on a missing package installs it and rebuilds", async () => {
  await withProject(async (root) => {
    const service = new BuildService();
    const calls = [];
    let installerLog = null;
    service.runLatexmk = async (rootPath, mainFileName) => {
      calls.push(mainFileName);
      if (calls.length === 1) {
        return { output: MISSING_LOG, status: 1, cancelled: false };
      }
      fs.writeFileSync(path.join(rootPath, "main.pdf"), "%PDF-1.5\n");
      return { output: "Output written on main.pdf (1 page).", status: 0, cancelled: false };
    };
    service.setPackageInstaller(async (log) => {
      installerLog = log;
      return { installed: ["pgf"], files: ["tikz.sty"] };
    });

    const result = await service.build(root, "main.tex", "lualatex");

    assert.equal(calls.length, 2, "the build should be retried exactly once");
    assert.match(installerLog, /tikz\.sty/);
    assert.equal(result.kind, "success");
    assert.match(result.log, /Installed missing package\(s\): pgf/);
  });
});

test("a dependency chain is followed across rounds until the build passes", async () => {
  await withProject(async (root) => {
    // mdframed -> zref-abspage -> needspace is a real chain: each run only names
    // the file LaTeX stopped on, so one repair round is never enough.
    const chain = [
      { missing: "mdframed.sty", pkg: "mdframed" },
      { missing: "zref-abspage.sty", pkg: "zref" },
      { missing: "needspace.sty", pkg: "needspace" },
    ];
    const installed = new Set();
    const service = new BuildService();
    let runs = 0;
    service.runLatexmk = async (rootPath) => {
      runs += 1;
      const next = chain.find((step) => !installed.has(step.pkg));
      if (next) {
        return {
          output: `! LaTeX Error: File \`${next.missing}' not found.`,
          status: 1,
          cancelled: false,
        };
      }
      fs.writeFileSync(path.join(rootPath, "main.pdf"), "%PDF-1.5\n");
      return { output: "Output written on main.pdf (1 page).", status: 0, cancelled: false };
    };
    service.setPackageInstaller(async (log) => {
      const step = chain.find((entry) => log.includes(entry.missing));
      if (!step) {
        return { installed: [] };
      }
      installed.add(step.pkg);
      return { installed: [step.pkg] };
    });

    const result = await service.build(root, "main.tex", "lualatex");

    assert.equal(result.kind, "success");
    assert.equal(runs, 4, "three repairs plus the run that finally succeeds");
    for (const step of chain) {
      assert.match(result.log, new RegExp(`Installed missing package\\(s\\): ${step.pkg}`));
    }
  });
});

test("the repair loop is bounded even when installs never help", async () => {
  await withProject(async (root) => {
    const service = new BuildService();
    let runs = 0;
    let counter = 0;
    service.runLatexmk = async () => {
      runs += 1;
      return { output: MISSING_LOG, status: 1, cancelled: false };
    };
    // A pathological installer that always reports something new installed.
    service.setPackageInstaller(async () => {
      counter += 1;
      return { installed: [`pkg${counter}`] };
    });

    const result = await service.build(root, "main.tex", "lualatex");

    assert.equal(result.kind, "failure");
    assert.ok(runs <= 6, `expected the loop to stop, saw ${runs} runs`);
  });
});

test("a package that does not fix anything is not retried forever", async () => {
  await withProject(async (root) => {
    const service = new BuildService();
    let runs = 0;
    service.runLatexmk = async () => {
      runs += 1;
      return { output: MISSING_LOG, status: 1, cancelled: false };
    };
    // Same package every round: the second round has nothing new to try.
    service.setPackageInstaller(async () => ({ installed: ["pgf"] }));

    await service.build(root, "main.tex", "lualatex");

    assert.equal(runs, 2, "one repair attempt, then stop");
  });
});

test("nothing installed means no retry", async () => {
  await withProject(async (root) => {
    const service = new BuildService();
    let runs = 0;
    service.runLatexmk = async () => {
      runs += 1;
      return { output: MISSING_LOG, status: 1, cancelled: false };
    };
    service.setPackageInstaller(async () => ({ installed: [], reason: "no-managed-tlmgr" }));

    const result = await service.build(root, "main.tex", "lualatex");

    assert.equal(runs, 1);
    assert.equal(result.kind, "failure");
  });
});

test("an installer that throws leaves the original failure intact", async () => {
  await withProject(async (root) => {
    const service = new BuildService();
    let runs = 0;
    service.runLatexmk = async () => {
      runs += 1;
      return { output: MISSING_LOG, status: 1, cancelled: false };
    };
    service.setPackageInstaller(async () => {
      throw new Error("tlmgr exploded");
    });

    const result = await service.build(root, "main.tex", "lualatex");

    assert.equal(runs, 1);
    assert.equal(result.kind, "failure");
    assert.match(result.log, /tikz\.sty/);
  });
});

test("with no installer wired the build behaves exactly as before", async () => {
  await withProject(async (root) => {
    const service = new BuildService();
    let runs = 0;
    service.runLatexmk = async () => {
      runs += 1;
      return { output: MISSING_LOG, status: 1, cancelled: false };
    };

    const result = await service.build(root, "main.tex", "lualatex");

    assert.equal(runs, 1);
    assert.equal(result.kind, "failure");
  });
});

test("a successful build never consults the package installer", async () => {
  await withProject(async (root) => {
    const service = new BuildService();
    let installerCalls = 0;
    service.runLatexmk = async (rootPath) => {
      fs.writeFileSync(path.join(rootPath, "main.pdf"), "%PDF-1.5\n");
      return { output: "Output written on main.pdf (1 page).", status: 0, cancelled: false };
    };
    service.setPackageInstaller(async () => {
      installerCalls += 1;
      return { installed: ["pgf"] };
    });

    const result = await service.build(root, "main.tex", "lualatex");

    assert.equal(result.kind, "success");
    assert.equal(installerCalls, 0);
  });
});
