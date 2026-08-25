const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createBuildCoreHandlers } = require("../electron/handlers/build/build-core.cjs");

test("a lightweight managed build installs a missing package and retries once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-auto-package-"));
  const pdfPath = path.join(root, "main.pdf");
  fs.writeFileSync(path.join(root, "main.tex"), "\\documentclass{article}\\begin{document}x\\end{document}");
  fs.writeFileSync(pdfPath, "%PDF-1.4\n");
  const states = [];
  const issueUpdates = [];
  let buildCalls = 0;
  const buildService = {
    build: async () => {
      buildCalls += 1;
      if (buildCalls === 1) {
        return {
          kind: "failure",
          summary: "physics.sty not found",
          issues: [{ severity: "error", message: "physics.sty not found" }],
          log: "! LaTeX Error: File `physics.sty' not found.",
        };
      }
      return {
        kind: "success",
        summary: "Build succeeded",
        issues: [],
        pdfPath,
        log: "Output written on main.pdf",
      };
    },
  };
  let recoveryOptions = null;
  const envService = {
    checkCommand: async () => true,
    installMissingPackagesFromLog: async (_log, options) => {
      recoveryOptions = options;
      options.onPackagesResolved(["physics"], ["physics.sty"]);
      return {
        attempted: true,
        success: true,
        files: ["physics.sty"],
        packages: ["physics"],
        message: "Installed physics.",
      };
    },
  };
  const workspace = {
    loadSettings: async () => null,
    rootInfo: async () => ({ path: "main.tex" }),
    resolveTexRootFromMagic: async () => null,
  };
  const handlers = createBuildCoreHandlers(
    {
      fs,
      buildService,
      envService,
      formatterService: {},
      workspace,
      pdfWindowManager: { show: () => {} },
      sendBuildState: (kind, message) => states.push({ kind, message }),
      sendIssues: (count, summary, tone) => issueUpdates.push({ count, summary, tone }),
      sendBuildLog: () => {},
      ensureWorkspace: () => root,
      updateWorkspaceIfNeeded: async () => {},
      handleOpenFile: async () => {},
      state: {},
    },
    {
      resolveWorkspaceRelativePath: (_root, filePath) => path.basename(filePath),
    }
  );

  try {
    await handlers.handleBuild("main.tex", { pdfViewerMode: "none" });
    assert.equal(buildCalls, 2);
    assert.deepEqual(recoveryOptions.excludePackages, []);
    assert.ok(
      states.some((entry) => entry.message === "Installing missing TeX packages…"),
      JSON.stringify(states)
    );
    assert.ok(states.some((entry) => entry.kind === "success"));
    assert.ok(issueUpdates.some((entry) => entry.tone === "success"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
