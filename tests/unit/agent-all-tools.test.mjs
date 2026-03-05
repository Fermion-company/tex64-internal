/**
 * Comprehensive feature coverage tests for all 21 agent tools.
 *
 * Each test exercises one or more tools via executeToolCall() and documents
 * whether it PASSES or reveals a BUG / limitation.  See the summary at the
 * bottom of each group for a quick reference.
 *
 * Run: node --test tests/unit/agent-all-tools.test.mjs
 *
 * Groups:
 *  A. Read tools          — list_files, read_file, read_files, get_project_structure
 *  B. Index / search      — get_index, search_files, search_web
 *  C. Scratchpad          — write_scratchpad, read_scratchpad (replace/append/clear)
 *  D. Write tools         — write_file / propose_write, auto-build count per call
 *  E. Patch tools         — patch_file / propose_patch, batch edits, auto-build count
 *  F. Delete / rename     — delete_file, rename_file, create_directory, auto-build count
 *  G. Terminal tools      — open_terminal_session, execute_bash_command,
 *                           send_terminal_input, read_terminal_output, kill_terminal
 *  H. Build / command     — run_build, run_command
 *  I. App settings        — get_app_settings, set_app_settings
 *  J. LaTeX symbol rename — rename_latex_symbol across files
 *  K. Routing             — deriveTurnRouting mode classification
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { AgentService } = require("../../electron/services/agent.cjs");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const createWorkspace = (rootPath, overrides = {}) => ({
  getRootPath: () => rootPath,
  resolvePath: (rel) => path.join(rootPath, rel),
  writeFile: async (rel, content) => {
    const abs = path.join(rootPath, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, "utf8");
  },
  listFiles: async () => {
    const walk = async (dir, base = "") => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      const result = [];
      for (const e of entries) {
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) result.push(...(await walk(path.join(dir, e.name), rel)));
        else result.push(rel);
      }
      return result;
    };
    return walk(rootPath);
  },
  rootInfo: async () => ({ path: "main.tex" }),
  resolveTexRootFromMagic: async (rel) => rel,
  loadSettings: async () => ({ buildProfileId: "", buildProfiles: [] }),
  ...overrides,
});

const createBuildService = (kind = "success") => {
  const calls = [];
  const svc = {
    calls,
    build: async (...args) => {
      calls.push(args);
      return { kind, summary: kind === "success" ? "ok" : "error", issues: [], pdfPath: null, log: "" };
    },
  };
  return svc;
};

const createService = (rootPath, overrides = {}) => {
  const buildService = overrides.buildService ?? null;
  return new AgentService({
    workspace: createWorkspace(rootPath, overrides.workspaceOverrides ?? {}),
    searchService: overrides.searchService ?? null,
    ensureUserSettings: () => ({
      getAgentSettings: async () => ({
        stream: false,
        autoApply: true,
        autoBuild: buildService !== null,
        allowRunCommand: true,
        maxIterations: 12,
      }),
      updateAgentSettings: async () => ({}),
    }),
    sendToRenderer: overrides.sendToRenderer ?? (() => {}),
    updateWorkspaceIfNeeded: async () => {},
    requestIndex: () => {},
    buildService,
    sendBuildState: overrides.sendBuildState ?? (() => {}),
    sendBuildLog: overrides.sendBuildLog ?? (() => {}),
    sendIssues: overrides.sendIssues ?? (() => {}),
    indexerService: overrides.indexerService ?? null,
    apiUsageService: null,
    auditService: { append: async () => {} },
    sessionsService: null,
    requestAiChat: overrides.requestAiChat ?? null,
  });
};

// ============================================================================
// GROUP A — Read tools
// ============================================================================

test("A1: list_files returns workspace entries", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-a1-"));
  try {
    await fsp.writeFile(path.join(rootPath, "main.tex"), "\\documentclass{article}", "utf8");
    await fsp.mkdir(path.join(rootPath, "chapters"), { recursive: true });
    await fsp.writeFile(path.join(rootPath, "chapters", "ch1.tex"), "Chapter 1", "utf8");
    const svc = createService(rootPath);
    const res = await svc.executeToolCall({ name: "list_files", args: {} }, "c1");
    assert.ok(Array.isArray(res.files), "should return files array");
    const names = res.files.map((f) => (typeof f === "string" ? f : f.name ?? f.path ?? ""));
    assert.ok(names.some((n) => n.includes("main.tex")), "main.tex in listing");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("A2: read_file reads existing file content", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-a2-"));
  try {
    await fsp.writeFile(path.join(rootPath, "main.tex"), "Hello World\n", "utf8");
    const svc = createService(rootPath);
    const res = await svc.executeToolCall({ name: "read_file", args: { path: "main.tex" } }, "c2");
    assert.equal(res.content, "Hello World\n");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("A3: read_file returns error for missing file", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-a3-"));
  try {
    const svc = createService(rootPath);
    const res = await svc.executeToolCall({ name: "read_file", args: { path: "missing.tex" } }, "c3");
    assert.ok(res.error, "should return error for missing file");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("A4: read_files reads multiple files at once", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-a4-"));
  try {
    await fsp.writeFile(path.join(rootPath, "a.tex"), "AAA", "utf8");
    await fsp.writeFile(path.join(rootPath, "b.tex"), "BBB", "utf8");
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      { name: "read_files", args: { paths: ["a.tex", "b.tex"] } },
      "c4"
    );
    assert.ok(res.files, "should return files map");
    assert.equal(res.files["a.tex"].content, "AAA");
    assert.equal(res.files["b.tex"].content, "BBB");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("A5: get_project_structure returns nested tree", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-a5-"));
  try {
    await fsp.mkdir(path.join(rootPath, "sections"), { recursive: true });
    await fsp.writeFile(path.join(rootPath, "main.tex"), "root", "utf8");
    await fsp.writeFile(path.join(rootPath, "sections", "intro.tex"), "intro", "utf8");
    const svc = createService(rootPath);
    const res = await svc.executeToolCall({ name: "get_project_structure", args: {} }, "c5");
    assert.ok(Array.isArray(res.structure), "should return structure array");
    const rootNames = res.structure.map((e) => e.name);
    assert.ok(rootNames.includes("main.tex"), "main.tex in root");
    assert.ok(rootNames.includes("sections"), "sections dir in root");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ============================================================================
// GROUP B — Index / search tools
// ============================================================================

test("B1: get_index returns error when indexerService is null [LIMITATION]", async () => {
  // indexerService=null means the feature is unavailable without the full Electron stack.
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-b1-"));
  try {
    const svc = createService(rootPath); // no indexerService
    const res = await svc.executeToolCall({ name: "get_index", args: {} }, "c-b1");
    assert.ok(res.error, "should return error when indexerService missing");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("B2: get_index works when indexerService is mocked", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-b2-"));
  try {
    const mockIndex = {
      labels: [{ key: "fig:example", file: "main.tex", line: 5 }],
      references: [],
      citations: [{ key: "Smith2020", file: "refs.bib", line: 1 }],
      sections: [{ title: "Introduction", file: "main.tex", line: 3 }],
      figures: [],
      tables: [],
      todos: [],
    };
    const svc = createService(rootPath, {
      indexerService: { buildIndex: async () => mockIndex },
    });
    const res = await svc.executeToolCall({ name: "get_index", args: {} }, "c-b2");
    assert.ok(res.index, "should return index");
    assert.equal(res.index.labels[0].key, "fig:example");
    assert.equal(res.index.citations[0].key, "Smith2020");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("B3: get_index filters by kinds", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-b3-"));
  try {
    const mockIndex = {
      labels: [{ key: "eq:1" }],
      references: [{ key: "eq:1" }],
      citations: [{ key: "Doe2021" }],
      sections: [{ title: "Methods" }],
      figures: [],
      tables: [],
      todos: [],
    };
    const svc = createService(rootPath, {
      indexerService: { buildIndex: async () => mockIndex },
    });
    const res = await svc.executeToolCall(
      { name: "get_index", args: { kinds: ["sections", "citations"] } },
      "c-b3"
    );
    assert.ok(res.index.sections, "sections present");
    assert.ok(res.index.citations, "citations present");
    assert.equal(res.index.labels, undefined, "labels filtered out");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("B4: search_files is self-contained filesystem grep (no external service needed)", async () => {
  // search_files does its own filesystem walk — it does NOT use searchService.
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-b4-"));
  try {
    await fsp.writeFile(
      path.join(rootPath, "main.tex"),
      "\\begin{theorem}\nThis is a theorem.\n\\end{theorem}\n",
      "utf8"
    );
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      { name: "search_files", args: { query: "theorem" } },
      "c-b4"
    );
    assert.ok(!res.error, `should not error: ${res.error}`);
    assert.ok(Array.isArray(res.results), "should return results array");
    assert.ok(res.results.length > 0, "should find the theorem in main.tex");
    assert.ok(
      res.results.some((r) => r.path === "main.tex"),
      "result should point to main.tex"
    );
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("B5: search_files returns empty array for no matches", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-b5-"));
  try {
    await fsp.writeFile(path.join(rootPath, "main.tex"), "Hello World\n", "utf8");
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      { name: "search_files", args: { query: "nonexistent_xyz_999" } },
      "c-b5"
    );
    assert.ok(!res.error, "should not error");
    assert.deepEqual(res.results, [], "should return empty array for no matches");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("B6: search_web makes real HTTP requests to DuckDuckGo (no external service needed)", async () => {
  // search_web uses node-fetch to call DuckDuckGo directly — no searchService dependency.
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-b6-"));
  try {
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      { name: "search_web", args: { query: "LaTeX tikz examples", timeoutMs: 10000 } },
      "c-b6"
    );
    // Returns results or a graceful error (network failure), never crashes
    assert.ok(
      res.results !== undefined || res.error !== undefined,
      "should return either results or error"
    );
    if (!res.error) {
      assert.equal(res.query, "LaTeX tikz examples", "should echo the query");
      assert.ok(Array.isArray(res.results), "results should be an array");
    }
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ============================================================================
// GROUP C — Scratchpad tools
// ============================================================================

test("C1: write_scratchpad replace mode stores content", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-c1-"));
  try {
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      { name: "write_scratchpad", args: { mode: "replace", content: "Plan: write intro" } },
      "c-c1"
    );
    assert.equal(res.status, "ok");
    assert.equal(res.mode, "replace");
    assert.equal(res.content, "Plan: write intro");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("C2: write_scratchpad append adds to existing content", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-c2-"));
  try {
    const svc = createService(rootPath);
    await svc.executeToolCall(
      { name: "write_scratchpad", args: { mode: "replace", content: "step 1" } },
      "c-c2"
    );
    await svc.executeToolCall(
      { name: "write_scratchpad", args: { mode: "append", content: "step 2" } },
      "c-c2"
    );
    const read = await svc.executeToolCall({ name: "read_scratchpad", args: {} }, "c-c2");
    assert.match(read.content, /step 1/);
    assert.match(read.content, /step 2/);
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("C3: write_scratchpad clear mode empties content", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-c3-"));
  try {
    const svc = createService(rootPath);
    await svc.executeToolCall(
      { name: "write_scratchpad", args: { mode: "replace", content: "old content" } },
      "c-c3"
    );
    await svc.executeToolCall(
      { name: "write_scratchpad", args: { mode: "clear" } },
      "c-c3"
    );
    const read = await svc.executeToolCall({ name: "read_scratchpad", args: {} }, "c-c3");
    assert.equal(read.content, "");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("C4: scratchpad is isolated per conversationId", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-c4-"));
  try {
    const svc = createService(rootPath);
    await svc.executeToolCall(
      { name: "write_scratchpad", args: { mode: "replace", content: "conv-A" } },
      "conv-A"
    );
    await svc.executeToolCall(
      { name: "write_scratchpad", args: { mode: "replace", content: "conv-B" } },
      "conv-B"
    );
    const readA = await svc.executeToolCall({ name: "read_scratchpad", args: {} }, "conv-A");
    const readB = await svc.executeToolCall({ name: "read_scratchpad", args: {} }, "conv-B");
    assert.equal(readA.content, "conv-A");
    assert.equal(readB.content, "conv-B");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ============================================================================
// GROUP D — Write tools  (write_file / propose_write)
// ============================================================================

test("D1: write_file creates new file and applies immediately", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-d1-"));
  try {
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      {
        name: "write_file",
        args: { path: "new.tex", content: "\\documentclass{article}\n", summary: "new file" },
      },
      "c-d1"
    );
    assert.equal(res.status, "applied");
    const on_disk = await fsp.readFile(path.join(rootPath, "new.tex"), "utf8");
    assert.equal(on_disk, "\\documentclass{article}\n");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("D2: write_file does NOT auto-build per .tex file (fixed)", async () => {
  // Fixed: handleProposeWrite now passes skipAutoBuild:true to autoApplyProposal.
  // Writing 3 .tex files should trigger 0 implicit builds.
  // The agent (or run-loop auto-build) decides when to build.
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-d2-"));
  try {
    const bs = createBuildService("success");
    const svc = createService(rootPath, { buildService: bs });

    for (let i = 1; i <= 3; i++) {
      await svc.executeToolCall(
        { name: "write_file", args: { path: `ch${i}.tex`, content: `chapter ${i}\n` } },
        "c-d2"
      );
    }

    assert.equal(bs.calls.length, 0, "no implicit builds when writing 3 .tex files");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("D3: write_file does NOT auto-build for non-LaTeX files", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-d3-"));
  try {
    const bs = createBuildService("success");
    const svc = createService(rootPath, { buildService: bs });
    await svc.executeToolCall(
      { name: "write_file", args: { path: "README.md", content: "# readme\n" } },
      "c-d3"
    );
    assert.equal(bs.calls.length, 0, "no build for non-LaTeX file");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("D4: write_file supports undo via undoLastApply", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-d4-"));
  const mainFile = path.join(rootPath, "main.tex");
  await fsp.writeFile(mainFile, "before\n", "utf8");
  try {
    const svc = createService(rootPath);
    await svc.executeToolCall(
      { name: "write_file", args: { path: "main.tex", content: "after\n" } },
      "c-d4"
    );
    assert.equal(await fsp.readFile(mainFile, "utf8"), "after\n");
    const undo = await svc.undoLastApply("c-d4");
    assert.equal(undo.ok, true);
    assert.equal(await fsp.readFile(mainFile, "utf8"), "before\n");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("D5: propose_write is an alias for write_file (same handler)", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-d5-"));
  try {
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      { name: "propose_write", args: { path: "out.tex", content: "content\n" } },
      "c-d5"
    );
    assert.equal(res.status, "applied");
    const on_disk = await fsp.readFile(path.join(rootPath, "out.tex"), "utf8");
    assert.equal(on_disk, "content\n");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ============================================================================
// GROUP E — Patch tools  (patch_file / propose_patch)
// ============================================================================

test("E1: propose_patch applies single search/replace", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-e1-"));
  const file = path.join(rootPath, "main.tex");
  await fsp.writeFile(file, "Hello World\n", "utf8");
  try {
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      {
        name: "propose_patch",
        args: { path: "main.tex", search: "World", replace: "LaTeX" },
      },
      "c-e1"
    );
    assert.equal(res.status, "applied");
    assert.equal(await fsp.readFile(file, "utf8"), "Hello LaTeX\n");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("E2: propose_patch returns error when search not found", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-e2-"));
  await fsp.writeFile(path.join(rootPath, "main.tex"), "Hello\n", "utf8");
  try {
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      {
        name: "propose_patch",
        args: { path: "main.tex", search: "NOT_HERE", replace: "replaced" },
      },
      "c-e2"
    );
    assert.ok(res.error, "should error when search not found");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("E3: propose_patch supports batch edits across multiple files", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-e3-"));
  try {
    await fsp.writeFile(path.join(rootPath, "a.tex"), "old_a\n", "utf8");
    await fsp.writeFile(path.join(rootPath, "b.tex"), "old_b\n", "utf8");
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      {
        name: "propose_patch",
        args: {
          edits: [
            { path: "a.tex", search: "old_a", replace: "new_a" },
            { path: "b.tex", search: "old_b", replace: "new_b" },
          ],
        },
      },
      "c-e3"
    );
    assert.equal(res.status, "applied");
    assert.equal(await fsp.readFile(path.join(rootPath, "a.tex"), "utf8"), "new_a\n");
    assert.equal(await fsp.readFile(path.join(rootPath, "b.tex"), "utf8"), "new_b\n");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("E4: propose_patch does NOT auto-build after applying (fixed)", async () => {
  // Fixed: handleProposePatch no longer fires run_build after patching.
  // The agent decides when to build via explicit run_build calls.
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-e4-"));
  await fsp.writeFile(path.join(rootPath, "main.tex"), "old content\n", "utf8");
  try {
    const bs = createBuildService("success");
    const svc = createService(rootPath, { buildService: bs });
    await svc.executeToolCall(
      { name: "propose_patch", args: { path: "main.tex", search: "old", replace: "new" } },
      "c-e4"
    );
    assert.equal(bs.calls.length, 0, "no implicit build after propose_patch");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("E5: patch_file is an alias for propose_patch (same handler)", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-e5-"));
  await fsp.writeFile(path.join(rootPath, "x.tex"), "aaa\n", "utf8");
  try {
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      { name: "patch_file", args: { path: "x.tex", search: "aaa", replace: "bbb" } },
      "c-e5"
    );
    assert.equal(res.status, "applied");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ============================================================================
// GROUP F — Delete / rename / create_directory
// ============================================================================

test("F1: delete_file removes the file and is undoable", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-f1-"));
  const file = path.join(rootPath, "todel.tex");
  await fsp.writeFile(file, "to be deleted\n", "utf8");
  try {
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      { name: "delete_file", args: { path: "todel.tex" } },
      "c-f1"
    );
    assert.equal(res.status, "applied");
    const exists = await fsp.stat(file).then(() => true).catch(() => false);
    assert.equal(exists, false, "file should be deleted");
    const undo = await svc.undoLastApply("c-f1");
    assert.equal(undo.ok, true, "undo should succeed");
    const restored = await fsp.stat(file).then(() => true).catch(() => false);
    assert.equal(restored, true, "file should be restored after undo");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("F2: delete_file does NOT auto-build for .tex files (fixed)", async () => {
  // Fixed: handleProposeDelete now passes skipAutoBuild:true to autoApplyProposal.
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-f2-"));
  await fsp.writeFile(path.join(rootPath, "old.tex"), "content\n", "utf8");
  try {
    const bs = createBuildService("success");
    const svc = createService(rootPath, { buildService: bs });
    await svc.executeToolCall(
      { name: "delete_file", args: { path: "old.tex" } },
      "c-f2"
    );
    assert.equal(bs.calls.length, 0, "no implicit build after delete_file");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("F3: rename_file moves the file and is undoable", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-f3-"));
  const oldFile = path.join(rootPath, "old.tex");
  const newFile = path.join(rootPath, "new.tex");
  await fsp.writeFile(oldFile, "content\n", "utf8");
  try {
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      { name: "rename_file", args: { oldPath: "old.tex", newPath: "new.tex" } },
      "c-f3"
    );
    assert.equal(res.status, "applied");
    assert.ok(await fsp.stat(newFile).then(() => true).catch(() => false), "new file exists");
    assert.ok(!(await fsp.stat(oldFile).then(() => true).catch(() => false)), "old file gone");
    const undo = await svc.undoLastApply("c-f3");
    assert.equal(undo.ok, true, "undo succeeds");
    assert.ok(await fsp.stat(oldFile).then(() => true).catch(() => false), "old file restored");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("F4: rename_file does NOT auto-build for .tex files (fixed)", async () => {
  // Fixed: handleProposeRename now passes skipAutoBuild:true to autoApplyProposal.
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-f4-"));
  await fsp.writeFile(path.join(rootPath, "a.tex"), "content\n", "utf8");
  try {
    const bs = createBuildService("success");
    const svc = createService(rootPath, { buildService: bs });
    await svc.executeToolCall(
      { name: "rename_file", args: { oldPath: "a.tex", newPath: "b.tex" } },
      "c-f4"
    );
    assert.equal(bs.calls.length, 0, "no implicit build after rename_file");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("F5: create_directory creates a new directory (no auto-build)", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-f5-"));
  try {
    const bs = createBuildService("success");
    const svc = createService(rootPath, { buildService: bs });
    const res = await svc.executeToolCall(
      { name: "create_directory", args: { path: "chapters/appendix" } },
      "c-f5"
    );
    assert.equal(res.status, "applied");
    const stat = await fsp.stat(path.join(rootPath, "chapters", "appendix"));
    assert.ok(stat.isDirectory(), "directory was created");
    assert.equal(bs.calls.length, 0, "no auto-build for directory creation");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ============================================================================
// GROUP G — Terminal tools
// ============================================================================

test("G1: open_terminal_session returns ready session", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-g1-"));
  try {
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      { name: "open_terminal_session", args: {} },
      "c-g1"
    );
    assert.equal(res.status, "ready");
    assert.ok(typeof res.sessionId === "string" && res.sessionId.length > 0, "has sessionId");
    // cleanup
    await svc.executeToolCall({ name: "kill_terminal", args: { sessionId: res.sessionId } }, "c-g1");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("G2: execute_bash_command runs a command in a session", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-g2-"));
  try {
    const svc = createService(rootPath);
    const session = await svc.executeToolCall(
      { name: "open_terminal_session", args: {} },
      "c-g2"
    );
    const res = await svc.executeToolCall(
      {
        name: "execute_bash_command",
        args: { sessionId: session.sessionId, command: "echo hello_terminal" },
      },
      "c-g2"
    );
    assert.equal(res.status, "success");
    assert.match(res.stdout, /hello_terminal/);
    await svc.executeToolCall({ name: "kill_terminal", args: { sessionId: session.sessionId } }, "c-g2");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("G3: execute_bash_command creates new session when sessionId omitted", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-g3-"));
  try {
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      { name: "execute_bash_command", args: { command: "echo auto_session" } },
      "c-g3"
    );
    assert.equal(res.status, "success");
    assert.match(res.stdout, /auto_session/);
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("G4: send_terminal_input and read_terminal_output work", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-g4-"));
  try {
    const svc = createService(rootPath);
    const session = await svc.executeToolCall(
      { name: "open_terminal_session", args: {} },
      "c-g4"
    );
    const sid = session.sessionId;

    // Send input and read output
    const send = await svc.executeToolCall(
      { name: "send_terminal_input", args: { sessionId: sid, chars: "echo g4test\n" } },
      "c-g4"
    );
    assert.ok(!send.error, `send_terminal_input error: ${send.error}`);

    // Wait briefly for output then read it
    await new Promise((res) => setTimeout(res, 300));
    const read = await svc.executeToolCall(
      { name: "read_terminal_output", args: { sessionId: sid } },
      "c-g4"
    );
    assert.ok(!read.error, `read_terminal_output error: ${read.error}`);
    // Output should contain the echoed text
    assert.match(read.output ?? read.stdout ?? "", /g4test/);

    await svc.executeToolCall({ name: "kill_terminal", args: { sessionId: sid } }, "c-g4");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("G5: kill_terminal terminates session", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-g5-"));
  try {
    const svc = createService(rootPath);
    const session = await svc.executeToolCall(
      { name: "open_terminal_session", args: {} },
      "c-g5"
    );
    const killed = await svc.executeToolCall(
      { name: "kill_terminal", args: { sessionId: session.sessionId } },
      "c-g5"
    );
    assert.equal(killed.status, "killed");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ============================================================================
// GROUP H — Build and run_command
// ============================================================================

test("H1: run_build returns error when buildService is null [LIMITATION]", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-h1-"));
  try {
    const svc = createService(rootPath); // no buildService
    const res = await svc.executeToolCall({ name: "run_build", args: {} }, "c-h1");
    assert.ok(res.error, "should error when buildService missing");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("H2: run_build returns success result from buildService", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-h2-"));
  await fsp.writeFile(path.join(rootPath, "main.tex"), "\\documentclass{article}\n", "utf8");
  try {
    const bs = createBuildService("success");
    const svc = createService(rootPath, { buildService: bs });
    const res = await svc.executeToolCall({ name: "run_build", args: {} }, "c-h2");
    assert.equal(res.status, "success");
    assert.equal(bs.calls.length, 1, "exactly 1 build call");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("H3: run_build returns failure from buildService", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-h3-"));
  await fsp.writeFile(path.join(rootPath, "main.tex"), "broken\n", "utf8");
  try {
    const bs = createBuildService("failure");
    const svc = createService(rootPath, { buildService: bs });
    const res = await svc.executeToolCall({ name: "run_build", args: {} }, "c-h3");
    assert.equal(res.status, "failure");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("H4: run_command executes shell command in workspace", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-h4-"));
  try {
    const svc = createService(rootPath);
    const res = await svc.executeToolCall(
      { name: "run_command", args: { command: "echo run_command_test" } },
      "c-h4"
    );
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /run_command_test/);
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ============================================================================
// GROUP I — App settings
// ============================================================================

test("I1: get_app_settings times out when renderer does not respond [LIMITATION]", async () => {
  // get_app_settings requires the Electron renderer process to respond.
  // Without it, the request times out after 3 seconds with an error.
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-i1-"));
  try {
    const svc = createService(rootPath); // no renderer response
    const start = Date.now();
    const res = await svc.executeToolCall(
      { name: "get_app_settings", args: {} },
      "c-i1"
    );
    const elapsed = Date.now() - start;
    assert.ok(res.error, "should return error on timeout");
    assert.ok(elapsed >= 2900, `should wait ~3s for timeout (got ${elapsed}ms)`);
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("I2: get_app_settings works when renderer responds synchronously", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-i2-"));
  try {
    let pendingRequestId = null;
    const svc = createService(rootPath, {
      sendToRenderer: (channel, payload) => {
        if (channel === "settings:request") {
          pendingRequestId = payload.requestId;
          // Simulate renderer responding with settings
          setTimeout(() => {
            svc.handleSettingsResponse({
              requestId: pendingRequestId,
              settings: { compileEngine: "lualatex", ghostCompletionEnabled: true },
            });
          }, 10);
        }
      },
    });
    const res = await svc.executeToolCall(
      { name: "get_app_settings", args: { keys: ["compileEngine"] } },
      "c-i2"
    );
    assert.ok(!res.error, `should not error: ${res.error}`);
    assert.ok(res.settings, "should return settings");
    assert.equal(res.settings.compileEngine, "lualatex");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("I3: set_app_settings works when renderer responds", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-i3-"));
  try {
    const svc = createService(rootPath, {
      sendToRenderer: (channel, payload) => {
        if (channel === "settings:request") {
          setTimeout(() => {
            svc.handleSettingsResponse({
              requestId: payload.requestId,
              settings: { ...payload.settings, compileEngine: "xelatex" },
            });
          }, 10);
        }
      },
    });
    const res = await svc.executeToolCall(
      { name: "set_app_settings", args: { settings: { compileEngine: "xelatex" } } },
      "c-i3"
    );
    assert.ok(!res.error, `should not error: ${res.error}`);
    assert.equal(res.settings.compileEngine, "xelatex");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ============================================================================
// GROUP J — rename_latex_symbol
// ============================================================================

test("J1: rename_latex_symbol renames label+ref across .tex files", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-j1-"));
  try {
    await fsp.writeFile(
      path.join(rootPath, "main.tex"),
      "\\label{sec:old} See \\ref{sec:old}.\n",
      "utf8"
    );
    const svc = createService(rootPath, {
      workspaceOverrides: { listFiles: async () => ["main.tex"] },
    });
    const res = await svc.executeToolCall(
      { name: "rename_latex_symbol", args: { from: "sec:old", to: "sec:new" } },
      "c-j1"
    );
    assert.equal(res.status, "applied");
    const content = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8");
    assert.match(content, /sec:new/);
    assert.doesNotMatch(content, /sec:old/);
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("J2: rename_latex_symbol renames citation key in .bib file", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-j2-"));
  try {
    await fsp.writeFile(
      path.join(rootPath, "refs.bib"),
      "@article{OldKey2020, author={Smith}}\n",
      "utf8"
    );
    await fsp.writeFile(
      path.join(rootPath, "main.tex"),
      "\\cite{OldKey2020}\n",
      "utf8"
    );
    const svc = createService(rootPath, {
      workspaceOverrides: { listFiles: async () => ["refs.bib", "main.tex"] },
    });
    const res = await svc.executeToolCall(
      { name: "rename_latex_symbol", args: { from: "OldKey2020", to: "Smith2020" } },
      "c-j2"
    );
    assert.equal(res.status, "applied");
    const bib = await fsp.readFile(path.join(rootPath, "refs.bib"), "utf8");
    const tex = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8");
    assert.match(bib, /Smith2020/);
    assert.match(tex, /Smith2020/);
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("J3: rename_latex_symbol triggers exactly ONE build after renaming [correct]", async () => {
  // rename_latex_symbol uses skipAutoBuild:true per file but one explicit build at end.
  // This is the correct behavior — unlike write_file/delete_file/rename_file.
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-j3-"));
  try {
    await fsp.writeFile(
      path.join(rootPath, "a.tex"),
      "\\label{fig:old} See \\ref{fig:old}.\n",
      "utf8"
    );
    await fsp.writeFile(
      path.join(rootPath, "b.tex"),
      "Also \\ref{fig:old} here.\n",
      "utf8"
    );
    const bs = createBuildService("success");
    const svc = createService(rootPath, {
      buildService: bs,
      workspaceOverrides: { listFiles: async () => ["a.tex", "b.tex"] },
    });
    await svc.executeToolCall(
      { name: "rename_latex_symbol", args: { from: "fig:old", to: "fig:new" } },
      "c-j3"
    );
    // rename_latex_symbol does ONE build at the end for all files — correct!
    assert.equal(bs.calls.length, 1, "exactly 1 build after renaming across 2 files");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ============================================================================
// GROUP K — Routing (deriveTurnRouting via service.run mock)
// ============================================================================

const createRunService = (rootPath, responses) => {
  let callIdx = 0;
  const buildCalls = [];
  const rendererEvents = [];
  const svc = createService(rootPath, {
    buildService: {
      calls: buildCalls,
      build: async (...args) => {
        buildCalls.push(args);
        return { kind: "success", summary: "ok", issues: [], pdfPath: null, log: "" };
      },
    },
    sendToRenderer: (ch, payload) => {
      rendererEvents.push({ ch, payload });
    },
    requestAiChat: async () => {
      const r = responses[callIdx] ?? responses[responses.length - 1];
      callIdx++;
      return r;
    },
  });
  svc._buildCalls = buildCalls;
  svc._rendererEvents = rendererEvents;
  return svc;
};

const textResponse = (text) => ({
  candidates: [{ content: { role: "model", parts: [{ text }] } }],
});

const toolCallResponse = (name, args) => ({
  candidates: [
    { content: { role: "model", parts: [{ functionCall: { name, args } }] } },
  ],
});

test("K1: greeting message → smalltalk mode, only 1 AI call, no tools used", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-k1-"));
  await fsp.writeFile(path.join(rootPath, "main.tex"), "content\n", "utf8");
  try {
    let aiCalls = 0;
    const svc = createService(rootPath, {
      requestAiChat: async () => {
        aiCalls++;
        return textResponse("Hello! How can I help?");
      },
    });
    await svc.run({ message: "こんにちは", conversationId: "k1" });
    assert.equal(aiCalls, 1, "only 1 AI call for greeting");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("K2: LaTeX edit request (main.texを修正) → workspace mode, tools available", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-k2-"));
  await fsp.writeFile(path.join(rootPath, "main.tex"), "\\title{Old}\n", "utf8");
  try {
    let toolCallSeen = false;
    const svc = createService(rootPath, {
      requestAiChat: async (payload) => {
        const hasTools = Array.isArray(payload?.tools) && payload.tools.length > 0;
        if (hasTools && !toolCallSeen) {
          toolCallSeen = true;
          return toolCallResponse("propose_patch", {
            path: "main.tex",
            search: "Old",
            replace: "New",
          });
        }
        return textResponse("Done.");
      },
    });
    await svc.run({ message: "main.texのタイトルを修正して", conversationId: "k2" });
    assert.ok(toolCallSeen, "tools should be offered in workspace mode");
    const content = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8");
    assert.match(content, /New/);
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("K3: '執筆してください' → workspace mode, tools available (fixed)", async () => {
  // Fixed: "執筆する" added to EDIT_REQUEST_PATTERN, "セクション" added to DOCUMENT_TOPIC_HINT_PATTERN.
  // "はじめにと手法のセクションを執筆してください" now routes to workspace mode.
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-k3-"));
  await fsp.writeFile(path.join(rootPath, "main.tex"), "\\section{Introduction}\n% TODO\n", "utf8");
  try {
    let toolsOffered = false;
    const svc = createService(rootPath, {
      requestAiChat: async (payload) => {
        toolsOffered = Array.isArray(payload?.tools) && payload.tools.length > 0;
        return textResponse("Here is the introduction section.");
      },
    });
    await svc.run({
      message: "はじめにと手法のセクションを執筆してください",
      conversationId: "k3",
    });
    assert.ok(toolsOffered, "tools should be offered for paper-writing message");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("K4: '書いて' / '書く' edit request → workspace mode (fixed)", async () => {
  // Fixed: "書いて" and "書く" added to EDIT_REQUEST_PATTERN.
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-k4-"));
  await fsp.writeFile(path.join(rootPath, "main.tex"), "content\n", "utf8");
  try {
    let toolsOffered = false;
    const svc = createService(rootPath, {
      requestAiChat: async (payload) => {
        toolsOffered = Array.isArray(payload?.tools) && payload.tools.length > 0;
        return textResponse("Done.");
      },
    });
    await svc.run({
      message: "main.texに概要節を書き加えて",
      conversationId: "k4",
    });
    assert.ok(toolsOffered, "'書き加えて' should trigger workspace mode");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("K5: compile request → workspace mode with build tool forced", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-k5-"));
  await fsp.writeFile(path.join(rootPath, "main.tex"), "content\n", "utf8");
  try {
    let toolsOffered = false;
    const svc = createService(rootPath, {
      requestAiChat: async (payload) => {
        toolsOffered = Array.isArray(payload?.tools) && payload.tools.length > 0;
        return textResponse("Build triggered.");
      },
    });
    await svc.run({ message: "コンパイルして", conversationId: "k5" });
    assert.ok(toolsOffered, "compile request should trigger workspace mode");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("K6: generic question with no LaTeX terms → standalone, tools NOT offered", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-all-k6-"));
  await fsp.writeFile(path.join(rootPath, "main.tex"), "content\n", "utf8");
  try {
    let toolsOffered = false;
    const svc = createService(rootPath, {
      requestAiChat: async (payload) => {
        toolsOffered = Array.isArray(payload?.tools) && payload.tools.length > 0;
        return textResponse("The sky is blue.");
      },
    });
    await svc.run({ message: "空はなぜ青いのですか？", conversationId: "k6" });
    assert.equal(toolsOffered, false, "general question should not offer tools");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});
