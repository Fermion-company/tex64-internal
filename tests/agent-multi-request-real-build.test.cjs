"use strict";

const assert = require("node:assert/strict");
const { execFile, spawnSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");

const { createPatch } = require("diff");
const { AgentService } = require("../electron/services/agent.cjs");
const { buildAgentPolicy } = require("../electron/services/agent-policy.cjs");
const { BuildService } = require("../electron/services/build/service.cjs");
const { buildTools } = require("../electron/services/openprism/tools.cjs");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");

const execFileAsync = promisify(execFile);

const INITIAL_DOCUMENT = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{Baseline}
The original paragraph says alpha.
\begin{equation}
E = mc^3
\end{equation}
The equation is intentionally unlabelled.
\end{document}
`;

const findExecutable = (name) => {
  const candidates = [name, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
  return (
    candidates.find((candidate) => {
      const probe = spawnSync(candidate, ["-v"], {
        encoding: "utf8",
        stdio: "pipe",
      });
      return !probe.error;
    }) ?? null
  );
};

const normalizePdfText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

test("distinct local Axiom edit requests reach the real PDF in sequence", async (t) => {
  const buildService = new BuildService();
  if (!buildService.findLatexmk()) {
    t.skip("latexmk is not installed in this test environment");
    return;
  }
  const pdftotext = findExecutable("pdftotext");
  if (!pdftotext) {
    t.skip("pdftotext is not installed in this test environment");
    return;
  }

  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-agent-multi-request-"));
  t.after(() => fsp.rm(rootPath, { recursive: true, force: true }));
  const mainPath = path.join(rootPath, "main.tex");
  await fsp.writeFile(mainPath, INITIAL_DOCUMENT, "utf8");

  const conversationId = "tex64-ai-mode:multi-request:main.tex";
  const workspace = new WorkspaceManager();
  workspace.setRootPath(rootPath);
  const toolEvents = [];
  const service = new AgentService({
    workspace,
    buildService,
    sendToRenderer: (channel, payload) => toolEvents.push({ channel, payload }),
    updateWorkspaceIfNeeded: async () => {},
    requestIndex: () => {},
    sendBuildState: () => {},
    sendBuildLog: () => {},
    sendIssues: () => {},
  });
  const context = { activeFilePath: "main.tex" };
  service.contextByConversation.set(conversationId, context);
  service.workspaceRootByConversation.set(conversationId, rootPath);

  const tools = new Map(
    buildTools(service, conversationId, buildAgentPolicy(), {
      rootPath,
      context,
    }).map((entry) => [entry.function.name, entry]),
  );
  const invoke = async (name, args) => {
    const tool = tools.get(name);
    assert.ok(tool, `${name} must be available to local Axiom`);
    const result = JSON.parse(await tool.execute(args));
    assert.equal(result.error, undefined, `${name}: ${result.error ?? "unexpected error"}`);
    return result;
  };
  const readSourceThroughAxiom = async () => {
    const result = await invoke("read_file", { path: "main.tex" });
    assert.equal(result.truncated, false);
    return result.content;
  };
  const compileAndExtract = async () => {
    const result = await invoke("compile_document", { engine: "pdflatex" });
    assert.equal(
      result.status,
      "success",
      `${result.summary ?? "Build failed"}\n${result.logExcerpt ?? ""}`,
    );
    assert.equal(result.targetFile, "main.tex");
    assert.equal(path.resolve(result.pdfPath), path.join(rootPath, "main.pdf"));
    const stat = await fsp.stat(result.pdfPath);
    assert.equal(stat.isFile(), true);
    assert.ok(stat.size > 0, "the real BuildService must produce a non-empty PDF");
    const { stdout } = await execFileAsync(pdftotext, [result.pdfPath, "-"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return { result, text: normalizePdfText(stdout) };
  };

  // Request 1: add a wholly new section without replacing existing content.
  let source = await readSourceThroughAxiom();
  let endDocumentLine = source.split("\n").findIndex((line) => line === "\\end{document}") + 1;
  let edit = await invoke("insert_lines", {
    path: "main.tex",
    afterLine: endDocumentLine - 1,
    content: [
      "\\section{Fourier Methods}",
      "The spectral construction is now present.",
    ].join("\n"),
    summary: "Add the requested Fourier section",
  });
  assert.equal(edit.status, "applied");
  let compiled = await compileAndExtract();
  assert.match(compiled.text, /Fourier Methods/);
  assert.match(compiled.text, /spectral construction is now present/);

  // Request 2: make surgical corrections to an existing paragraph and formula.
  source = await readSourceThroughAxiom();
  let lines = source.split("\n");
  let targetLine = lines.findIndex((line) => line === "The original paragraph says alpha.") + 1;
  edit = await invoke("replace_lines", {
    path: "main.tex",
    startLine: targetLine,
    endLine: targetLine,
    content: "The corrected paragraph says beta.",
    summary: "Correct the existing paragraph",
  });
  assert.equal(edit.status, "applied");

  source = await readSourceThroughAxiom();
  lines = source.split("\n");
  targetLine = lines.findIndex((line) => line === "E = mc^3") + 1;
  edit = await invoke("replace_lines", {
    path: "main.tex",
    startLine: targetLine,
    endLine: targetLine,
    content: "E = mc^2 \\qquad \\text{corrected energy law}",
    summary: "Correct the existing energy equation",
  });
  assert.equal(edit.status, "applied");
  compiled = await compileAndExtract();
  assert.doesNotMatch(compiled.text, /original paragraph says alpha/);
  assert.match(compiled.text, /corrected paragraph says beta/);
  assert.match(compiled.text, /corrected energy law/);

  // Request 3: add a label and an in-document reference with a precise patch.
  source = await readSourceThroughAxiom();
  const labelledSource = source
    .replace("\\begin{equation}\n", "\\begin{equation}\n\\label{eq:energy}\n")
    .replace(
      "The equation is intentionally unlabelled.",
      "Equation~\\ref{eq:energy} is referenced here by the label marker.",
    );
  assert.notEqual(labelledSource, source);
  edit = await invoke("apply_patch", {
    path: "main.tex",
    patch: createPatch("main.tex", source, labelledSource),
  });
  assert.equal(edit.status, "applied");
  compiled = await compileAndExtract();
  assert.match(compiled.text, /Equation 1 is referenced here by the label marker/);

  // Request 4: append a numbered end-of-chapter problem set.
  source = await readSourceThroughAxiom();
  endDocumentLine = source.split("\n").findIndex((line) => line === "\\end{document}") + 1;
  edit = await invoke("insert_lines", {
    path: "main.tex",
    afterLine: endDocumentLine - 1,
    content: [
      "\\section{End-of-Chapter Problems}",
      "\\begin{enumerate}",
      "\\item Derive the corrected energy law.",
      "\\item Verify the numbered equation reference.",
      "\\item Analyze the spectral construction.",
      "\\item Compare the alpha and beta statements.",
      "\\item Summarize the Fourier section.",
      "\\end{enumerate}",
    ].join("\n"),
    summary: "Add five end-of-chapter problems",
  });
  assert.equal(edit.status, "applied");
  compiled = await compileAndExtract();
  assert.match(compiled.text, /End-of-Chapter Problems/);
  for (const phrase of [
    "Derive the corrected energy law",
    "Verify the numbered equation reference",
    "Analyze the spectral construction",
    "Compare the alpha and beta statements",
    "Summarize the Fourier section",
  ]) {
    assert.match(compiled.text, new RegExp(phrase));
  }

  const finalSource = await fsp.readFile(mainPath, "utf8");
  assert.match(finalSource, /\\section\{Fourier Methods\}/);
  assert.match(finalSource, /The corrected paragraph says beta\./);
  assert.match(finalSource, /E = mc\^2 \\qquad \\text\{corrected energy law\}/);
  assert.match(finalSource, /\\label\{eq:energy\}/);
  assert.match(finalSource, /Equation~\\ref\{eq:energy\}/);
  assert.match(finalSource, /\\section\{End-of-Chapter Problems\}/);
  assert.equal((finalSource.match(/\\item /g) ?? []).length, 5);

  const startedTools = toolEvents
    .filter((event) => event.channel === "agent:tool" && event.payload?.summary === "running")
    .map((event) => event.payload.name);
  assert.equal(startedTools.filter((name) => name === "compile_document").length, 4);
  for (const name of ["read_file", "insert_lines", "replace_lines", "apply_patch"]) {
    assert.ok(startedTools.includes(name), `${name} must run through the Axiom tool boundary`);
  }
});
