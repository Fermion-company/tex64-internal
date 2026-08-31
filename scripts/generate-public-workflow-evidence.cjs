"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const { createTwoFilesPatch } = require("diff");
const { AgentService } = require("../electron/services/agent.cjs");
const { buildAgentPolicy } = require("../electron/services/agent-policy.cjs");
const { BuildService } = require("../electron/services/build/service.cjs");
const {
  buildArxivBibtex,
  extractArxivId,
  fetchArxivEntry,
} = require("../electron/services/openprism/arxiv-service.cjs");
const { buildTools } = require("../electron/services/openprism/tools.cjs");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(__dirname, "..");
const evidenceRoot = path.join(repositoryRoot, "evidence", "public-workflows");
const fixtureRoot = path.join(evidenceRoot, "fixtures");
const resultRoot = path.join(evidenceRoot, "results");
const artifactRoot = path.join(resultRoot, "artifacts");
const arxivXmlPath = path.join(fixtureRoot, "citation", "arxiv-response.xml");
const arxivMetaPath = path.join(fixtureRoot, "citation", "arxiv-response.meta.json");
const implementationCommit = "163a7ca12d0bed2f5bb7db6261057c5153fb90e8";
const arxivInput = "1706.03762";
const sourceDateEpoch = "1788105600";

// BuildService inherits the parent environment. Fix the supported TeX build
// timestamp before any production service is instantiated so repeated runs
// produce byte-identical evidence artifacts.
process.env.SOURCE_DATE_EPOCH = sourceDateEpoch;
process.env.FORCE_SOURCE_DATE = "1";
process.env.TZ = "UTC";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const readUtf8 = (target) => fsp.readFile(target, "utf8");
const writeUtf8 = async (target, value) => {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, value.endsWith("\n") ? value : `${value}\n`, "utf8");
};
const writeJson = (target, value) => writeUtf8(target, JSON.stringify(value, null, 2));
const hashFile = async (target) => sha256(await fsp.readFile(target));
const fileExists = async (target) => Boolean(await fsp.stat(target).catch(() => null));

const normalizeText = (value, temporaryRoot = null) => {
  let text = String(value ?? "");
  if (temporaryRoot) text = text.split(temporaryRoot).join("<fixture-root>");
  return text.replaceAll("\\", "/");
};

const normalizeIssue = (issue, temporaryRoot) => ({
  severity: issue?.severity ?? "error",
  ...(issue?.path ? { path: normalizeText(issue.path, temporaryRoot) } : {}),
  ...(Number.isFinite(issue?.line) ? { line: issue.line } : {}),
  message: normalizeText(issue?.message ?? "", temporaryRoot),
});

const normalizeBuild = (result, temporaryRoot) => ({
  status: result?.status ?? "unknown",
  targetFile: result?.targetFile ?? null,
  summary: normalizeText(result?.summary ?? result?.error ?? "", temporaryRoot),
  issues: Array.isArray(result?.issues)
    ? result.issues.map((issue) => normalizeIssue(issue, temporaryRoot))
    : [],
  ...(result?.logExcerpt
    ? { logExcerpt: normalizeText(result.logExcerpt, temporaryRoot).slice(-4000) }
    : {}),
});

const run = async (command, args, options = {}) => {
  const { stdout = "", stderr = "" } = await execFileAsync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      SOURCE_DATE_EPOCH: sourceDateEpoch,
      FORCE_SOURCE_DATE: "1",
      TZ: "UTC",
      ...(options.env ?? {}),
    },
  });
  return { stdout, stderr };
};

const withFixture = async (name, callback) => {
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `tex64-public-${name}-`));
  try {
    await fsp.cp(path.join(fixtureRoot, name), temporaryRoot, { recursive: true });
    return await callback(temporaryRoot);
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
};

const makeHarness = async (temporaryRoot, relativeMain, conversationId) => {
  const workspace = new WorkspaceManager();
  workspace.setRootPath(temporaryRoot);
  const events = [];
  const service = new AgentService({
    workspace,
    buildService: new BuildService(),
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
    updateWorkspaceIfNeeded: async () => true,
    requestIndex: () => {},
    sendBuildState: () => {},
    sendBuildLog: () => {},
    sendIssues: () => {},
  });
  const source = await readUtf8(path.join(temporaryRoot, relativeMain));
  const context = {
    activeFilePath: relativeMain,
    documentMainFile: relativeMain,
    activeFileContent: source,
    activeFileIsDirty: false,
    activeFileContentTruncated: false,
  };
  service.setContext(conversationId, context);
  service.workspaceRootByConversation.set(conversationId, temporaryRoot);
  const tools = new Map(
    buildTools(service, conversationId, buildAgentPolicy(), {
      rootPath: temporaryRoot,
      context,
    }).map((entry) => [entry.function.name, entry]),
  );
  const call = async (name, args = {}) => {
    const tool = tools.get(name);
    assert.ok(tool, `${name} must be exposed by the current Axiom implementation`);
    return JSON.parse(await tool.execute(args));
  };
  return { call, events, service };
};

const copyPdf = async (source, name) => {
  const target = path.join(artifactRoot, name);
  await fsp.copyFile(source, target);
  const stat = await fsp.stat(target);
  assert.ok(stat.size > 0, `${name} must not be empty`);
  return { path: `artifacts/${name}`, bytes: stat.size, sha256: await hashFile(target) };
};

const extractPdfText = async (target) => {
  const { stdout } = await run("pdftotext", [target, "-"]);
  return stdout.replace(/\s+/g, " ").trim();
};

const findLine = (source, exact) => {
  const index = source.split("\n").findIndex((line) => line === exact);
  assert.notEqual(index, -1, `fixture line not found: ${exact}`);
  return index + 1;
};

const sourceChange = (before, after, relativePath) =>
  createTwoFilesPatch(relativePath, relativePath, before, after, "before", "after", {
    context: 3,
  });

async function reviewTrace() {
  return withFixture("review", async (temporaryRoot) => {
    const relativeMain = "documents/paper/main.tex";
    const absoluteMain = path.join(temporaryRoot, relativeMain);
    const before = await readUtf8(absoluteMain);
    const harness = await makeHarness(temporaryRoot, relativeMain, "public-review-fixture");

    const initialBuild = await harness.call("compile_document", { engine: "pdflatex" });
    assert.equal(initialBuild.status, "success", initialBuild.summary);
    assert.equal(initialBuild.targetFile, relativeMain);

    const targetLine = findLine(before, "Status: baseline.");
    const write = await harness.call("replace_lines", {
      path: relativeMain,
      startLine: targetLine,
      endLine: targetLine,
      content: "Status: reviewed.",
      summary: "Change the public review fixture status",
    });
    assert.equal(write.status, "applied");
    assert.equal(write.verified, true);
    const after = await readUtf8(absoluteMain);
    const diff = sourceChange(before, after, relativeMain);
    await writeUtf8(path.join(resultRoot, "axiom-review.diff"), diff);
    await writeUtf8(path.join(resultRoot, "axiom-review.applied.tex"), after);

    const appliedEvent = harness.events.find(
      (event) => event.channel === "agent:applyContent" && event.payload?.path === relativeMain,
    );
    const proposalEvent = harness.events.find(
      (event) => event.channel === "agent:proposal" && event.payload?.proposal?.path === relativeMain,
    );
    assert.equal(appliedEvent?.payload?.updateSaved, true);
    assert.equal(proposalEvent?.payload?.proposal?.autoApplied, true);

    const doneBuild = await harness.call("compile_document", { engine: "pdflatex" });
    assert.equal(doneBuild.status, "success", doneBuild.summary);
    assert.equal(doneBuild.targetFile, relativeMain);
    const donePdf = await copyPdf(doneBuild.pdfPath, "axiom-review-done.pdf");
    const doneSourceHash = await hashFile(absoluteMain);

    const uiSourcePath = path.join(repositoryRoot, "web-src", "app", "editor-session-file-ops.ts");
    const uiSource = await readUtf8(uiSourcePath);
    assert.match(uiSource, /keepBtn\.textContent = uiText\("Done", "完了"\)/);
    assert.match(
      uiSource,
      /keepBtn\.addEventListener\("click", \(\) => \{\s*clearAiDiffDecorations\(group\);\s*\}\);/s,
    );
    assert.match(uiSource, /editorTrigger\?\.trigger\?\.\("ai-undo-bar", "undo", null\)/);
    assert.match(uiSource, /void saveCurrentFile\(\)/);
    assert.equal(await hashFile(absoluteMain), doneSourceHash);

    const undone = await harness.service.undoLastRunApply("public-review-fixture", {
      emitRenderer: false,
    });
    assert.equal(undone.ok, true);
    assert.equal(undone.build?.status, "success", undone.build?.summary);
    assert.equal(undone.build?.targetFile, relativeMain);
    assert.equal(await readUtf8(absoluteMain), before);
    const undoPdf = await copyPdf(undone.build.pdfPath, "axiom-review-undo.pdf");

    return {
      fixtureId: "axiom-review-v1",
      implementationCommit,
      selectedRoot: relativeMain,
      workspaceRootSentinel: "main.tex contains an undefined command and was not selected",
      initialBuild: normalizeBuild(initialBuild, temporaryRoot),
      write: { tool: "replace_lines", status: write.status, verified: write.verified, change: write.change },
      appliedDiff: {
        path: "axiom-review.diff",
        sha256: await hashFile(path.join(resultRoot, "axiom-review.diff")),
        rendererReceivedSavedBytes: appliedEvent?.payload?.updateSaved === true,
        rendererProposalWasAlreadyApplied: proposalEvent?.payload?.proposal?.autoApplied === true,
      },
      done: {
        effect: "dismiss applied-diff decorations; do not write or revert bytes",
        proof: "production handler source assertion",
        implementationPath: "web-src/app/editor-session-file-ops.ts",
        implementationSha256: await hashFile(uiSourcePath),
        sourceSha256AfterDone: doneSourceHash,
        build: normalizeBuild(doneBuild, temporaryRoot),
        pdf: donePdf,
      },
      undo: {
        action: "AgentService.undoLastRunApply",
        restoredSourceSha256: await hashFile(absoluteMain),
        equalsOriginal: true,
        build: normalizeBuild(undone.build, temporaryRoot),
        pdf: undoPdf,
      },
    };
  });
}

async function repairTrace() {
  return withFixture("repair", async (temporaryRoot) => {
    const relativeMain = "documents/repair/main.tex";
    const absoluteMain = path.join(temporaryRoot, relativeMain);
    const before = await readUtf8(absoluteMain);
    const harness = await makeHarness(temporaryRoot, relativeMain, "public-repair-fixture");

    const firstBuild = await harness.call("compile_document", { engine: "pdflatex" });
    assert.equal(firstBuild.status, "failure");
    assert.equal(firstBuild.targetFile, relativeMain);
    assert.ok(firstBuild.issues?.length, "the first compiler failure must expose an issue");

    const targetLine = findLine(before, "\\undefinedEvidenceCommand{first compiler error}");
    const write = await harness.call("replace_lines", {
      path: relativeMain,
      startLine: targetLine,
      endLine: targetLine,
      content: "The bounded repair replaced one unsupported command.",
      summary: "Replace the first unsupported command only",
    });
    assert.equal(write.status, "applied");
    assert.equal(write.verified, true);
    const after = await readUtf8(absoluteMain);
    const diff = sourceChange(before, after, relativeMain);
    await writeUtf8(path.join(resultRoot, "axiom-repair.diff"), diff);
    await writeUtf8(path.join(resultRoot, "axiom-repair.applied.tex"), after);

    const retry = await harness.call("compile_document", { engine: "pdflatex" });
    assert.equal(retry.status, "success", retry.summary);
    assert.equal(retry.targetFile, relativeMain);
    const pdf = await copyPdf(retry.pdfPath, "axiom-repair.pdf");

    return {
      fixtureId: "axiom-repair-v1",
      implementationCommit,
      selectedRoot: relativeMain,
      firstCompilerResult: {
        ...normalizeBuild(firstBuild, temporaryRoot),
        firstIssue: normalizeIssue(firstBuild.issues[0], temporaryRoot),
      },
      boundedAction: {
        tool: "replace_lines",
        line: targetLine,
        changedFileCount: 1,
        change: write.change,
        diffPath: "axiom-repair.diff",
        diffSha256: await hashFile(path.join(resultRoot, "axiom-repair.diff")),
      },
      retry: normalizeBuild(retry, temporaryRoot),
      output: { pdf, text: await extractPdfText(retry.pdfPath) },
    };
  });
}

async function arxivSnapshot(refresh) {
  if (refresh || !(await fileExists(arxivXmlPath)) || !(await fileExists(arxivMetaPath))) {
    const normalizedId = extractArxivId(arxivInput);
    assert.equal(normalizedId, arxivInput);
    const sourceUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(normalizedId)}`;
    const response = await fetch(sourceUrl, {
      headers: { "User-Agent": "tex64-public-evidence/1.0 (https://tex64.com/support)" },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.ok, true, `arXiv API returned ${response.status}`);
    const xml = await response.text();
    assert.match(xml, /<entry>/);
    await writeUtf8(arxivXmlPath, xml);
    await writeJson(arxivMetaPath, {
      arxivId: normalizedId,
      sourceUrl,
      retrievedAt: new Date().toISOString(),
      responseSha256: sha256(Buffer.from(xml, "utf8")),
      rights: "arXiv metadata is dedicated CC0; no paper PDF or source is included",
      rightsUrl: "https://info.arxiv.org/help/license/index.html#metadata-license",
    });
  }
  return { xml: await readUtf8(arxivXmlPath), meta: JSON.parse(await readUtf8(arxivMetaPath)) };
}

async function citationTrace(refreshArxiv) {
  const snapshot = await arxivSnapshot(refreshArxiv);
  assert.equal(sha256(Buffer.from(snapshot.xml, "utf8")), snapshot.meta.responseSha256);
  const originalFetch = global.fetch;
  let requestedUrl = null;
  global.fetch = async (url) => {
    requestedUrl = String(url);
    assert.equal(requestedUrl, snapshot.meta.sourceUrl);
    return new Response(snapshot.xml, {
      status: 200,
      headers: { "content-type": "application/atom+xml; charset=utf-8" },
    });
  };
  let entry;
  try {
    entry = await fetchArxivEntry(extractArxivId(arxivInput));
  } finally {
    global.fetch = originalFetch;
  }
  assert.ok(entry, "cached official metadata must parse through the production service");
  const bibtex = buildArxivBibtex(entry);
  assert.match(bibtex, /arxiv:1706\.03762/);

  return withFixture("citation", async (temporaryRoot) => {
    const relativeMain = "documents/citation/main.tex";
    const absoluteMain = path.join(temporaryRoot, relativeMain);
    const before = await readUtf8(absoluteMain);
    const harness = await makeHarness(temporaryRoot, relativeMain, "public-citation-fixture");
    const bibliographyPath = "documents/citation/refs.bib";
    const bibliographyWrite = await harness.call("create_file", {
      path: bibliographyPath,
      content: `${bibtex}\n`,
      summary: `Create BibTeX from exact arXiv metadata for ${arxivInput}`,
    });
    assert.equal(bibliographyWrite.status, "applied");

    const citationLine = findLine(before, "Citation pending.");
    const manuscriptWrite = await harness.call("replace_lines", {
      path: relativeMain,
      startLine: citationLine,
      endLine: citationLine,
      content: `The production metadata fixture is cited as \\cite{arxiv:${arxivInput}}.`,
      summary: "Insert the generated citation key",
    });
    assert.equal(manuscriptWrite.status, "applied");
    const after = await readUtf8(absoluteMain);
    const diff = sourceChange(before, after, relativeMain);
    await writeUtf8(path.join(resultRoot, "arxiv-citation.diff"), diff);
    await writeUtf8(path.join(resultRoot, "arxiv-citation.applied.tex"), after);
    await writeUtf8(path.join(resultRoot, "arxiv-citation.refs.bib"), `${bibtex}\n`);

    const build = await harness.call("compile_document", { engine: "pdflatex" });
    assert.equal(build.status, "success", build.summary);
    assert.equal(build.targetFile, relativeMain);
    const pdf = await copyPdf(build.pdfPath, "arxiv-citation.pdf");
    const renderedText = await extractPdfText(build.pdfPath);
    assert.match(renderedText, /Attention Is All You Need/i);

    return {
      fixtureId: "arxiv-citation-v1",
      implementationCommit,
      input: {
        supplied: arxivInput,
        normalized: extractArxivId(arxivInput),
        versionSuffixBehavior: "a trailing vN would be removed by the current extractor",
      },
      fetchedMetadata: {
        sourceUrl: requestedUrl,
        retrievedAt: snapshot.meta.retrievedAt,
        responseSha256: snapshot.meta.responseSha256,
        responsePath: "fixtures/citation/arxiv-response.xml",
        title: entry.title,
        authors: entry.authors,
        year: entry.year,
        id: entry.id,
        rights: snapshot.meta.rights,
        rightsUrl: snapshot.meta.rightsUrl,
      },
      bibtex: {
        path: "arxiv-citation.refs.bib",
        sha256: await hashFile(path.join(resultRoot, "arxiv-citation.refs.bib")),
        writeStatus: bibliographyWrite.status,
      },
      manuscriptDiff: {
        path: "arxiv-citation.diff",
        sha256: await hashFile(path.join(resultRoot, "arxiv-citation.diff")),
        writeStatus: manuscriptWrite.status,
      },
      build: normalizeBuild(build, temporaryRoot),
      output: { pdf, text: renderedText },
    };
  });
}

async function portabilityTrace() {
  return withFixture("review", async (temporaryRoot) => {
    const relativeMain = "documents/paper/main.tex";
    const absoluteMain = path.join(temporaryRoot, relativeMain);
    const before = await readUtf8(absoluteMain);
    await run("git", ["init", "-q"], { cwd: temporaryRoot });
    await run("git", ["add", "."], { cwd: temporaryRoot });
    await run(
      "git",
      ["-c", "user.name=Fermion Evidence", "-c", "user.email=evidence@invalid.example", "commit", "-q", "-m", "baseline"],
      { cwd: temporaryRoot },
    );

    const harness = await makeHarness(temporaryRoot, relativeMain, "public-portability-fixture");
    const targetLine = findLine(before, "Status: baseline.");
    const write = await harness.call("replace_lines", {
      path: relativeMain,
      startLine: targetLine,
      endLine: targetLine,
      content: "Status: reviewed.",
      summary: "Create the editor-exit Git diff",
    });
    assert.equal(write.status, "applied");
    const { stdout: gitDiff } = await run("git", ["diff", "--", relativeMain], { cwd: temporaryRoot });
    assert.match(gitDiff, /Status: reviewed\./);
    await writeUtf8(path.join(resultRoot, "editor-exit-test.diff"), gitDiff);

    const tex64Build = await harness.call("compile_document", { engine: "pdflatex" });
    assert.equal(tex64Build.status, "success", tex64Build.summary);
    const tex64Pdf = await copyPdf(tex64Build.pdfPath, "editor-exit-tex64.pdf");

    const texShopRoot = "/Applications/TeX/TeXShop.app";
    const texShopLatexmk = "/Users/wedd/Library/TeXShop/bin/tslatexmk/latexmk";
    const commonRc = "/Users/wedd/Library/TeXShop/bin/tslatexmk/latexmkrcDONTedit";
    const pdfRc = "/Users/wedd/Library/TeXShop/bin/tslatexmk/pdflatexmkrc";
    const enginePath = path.join(texShopRoot, "Contents/Resources/TeXShop/Engines/pdflatexmk.engine");
    for (const target of [texShopRoot, texShopLatexmk, commonRc, pdfRc, enginePath]) {
      assert.equal(await fileExists(target), true, `second-editor component missing: ${target}`);
    }
    for (const extension of ["aux", "fdb_latexmk", "fls", "log", "pdf", "synctex.gz"]) {
      await fsp.rm(absoluteMain.replace(/\.tex$/, `.${extension}`), { force: true });
    }
    const texShopRun = await run(
      texShopLatexmk,
      ["-pdf", "-r", commonRc, "-r", pdfRc, relativeMain],
      { cwd: temporaryRoot },
    );
    // TeXShop's bundled latexmk engine writes the target beside its working
    // directory even when the selected source is nested. This mirrors the
    // command used by the engine instead of moving or rewriting the fixture.
    const texShopPdfPath = path.join(temporaryRoot, "main.pdf");
    assert.equal(await fileExists(texShopPdfPath), true, texShopRun.stderr || texShopRun.stdout);
    const texShopPdf = await copyPdf(texShopPdfPath, "editor-exit-texshop.pdf");
    const { stdout: texShopVersion } = await run(
      "/usr/bin/plutil",
      ["-extract", "CFBundleShortVersionString", "raw", path.join(texShopRoot, "Contents/Info.plist")],
    );

    return {
      fixtureId: "standard-tex-editor-exit-v1",
      implementationCommit,
      standardFiles: ["main.tex", relativeMain],
      editedFile: relativeMain,
      gitDiff: {
        command: `git diff -- ${relativeMain}`,
        path: "editor-exit-test.diff",
        sha256: await hashFile(path.join(resultRoot, "editor-exit-test.diff")),
      },
      firstEditor: { name: "TeX64 BuildService", build: normalizeBuild(tex64Build, temporaryRoot), pdf: tex64Pdf },
      secondEditor: {
        name: "TeXShop",
        version: texShopVersion.trim(),
        engine: "pdflatexmk.engine",
        engineSha256: await hashFile(enginePath),
        command: "TeXShop pdflatexmk engine: latexmk -pdf -r latexmkrcDONTedit -r pdflatexmkrc documents/paper/main.tex",
        exitCode: 0,
        pdf: texShopPdf,
      },
      pdfHashesMatch: tex64Pdf.sha256 === texShopPdf.sha256,
      dataFlow: [
        ["source and assets", "ordinary workspace files", "both editors read the same paths"],
        ["meaningful edit", "Git diff", "independent of either editor UI"],
        ["build root", relativeMain, "recorded explicitly in both build results"],
        ["generated PDF", "local workspace", "hash recorded separately for each editor"],
      ],
      boundary: "A successful second-editor build establishes portability of this fixture, not identical output across every TeX version, font, or operating system.",
    };
  });
}

async function benchmarkTrace() {
  const testPath = path.join(repositoryRoot, "tests", "math-suggest-command-names.test.mjs");
  const testRun = await run(process.execPath, ["--test", testPath]);
  assert.match(testRun.stdout, /(?:#|ℹ)\s*fail 0/);
  const { stdout: historicalCommit } = await run("git", ["show", "-s", "--format=%H%n%s%n%B", "34f1510"]);
  assert.match(historicalCommit, /85 files/);
  assert.match(historicalCommit, /11,386/);
  return {
    fixtureId: "math-suggest-regression-v1",
    implementationCommit,
    command: "node --test tests/math-suggest-command-names.test.mjs",
    currentRegressionTest: {
      status: "pass",
      path: "tests/math-suggest-command-names.test.mjs",
      sha256: await hashFile(testPath),
      assertions: "exact command names, dots variants, environments, non-empty candidates, shared prefixes",
    },
    historicalAggregate: {
      sourceCommit: historicalCommit.split("\n")[0],
      reportedCorpusFiles: 85,
      reportedMathCommandOccurrences: 11386,
      reportedWeightedTop1Before: 0.973,
      reportedWeightedTop1After: 0.999,
      corpusManifest: null,
      releaseStatus: "blocked",
      blockers: [
        "the 85 source identifiers and retrieval dates were not preserved",
        "per-version source licenses and permitted reuse were not preserved",
        "the extraction harness and aggregate table were not committed",
      ],
      rightsReason: "arXiv says its default license grants arXiv distribution rights but does not grant third parties the right to redistribute articles; a source corpus cannot be published without per-item rights review",
      rightsUrl: "https://info.arxiv.org/help/bulk_data_s3.html",
    },
  };
}

async function environmentRecord() {
  const [{ stdout: latexmk }, { stdout: pdflatex }, { stdout: gitVersion }] = await Promise.all([
    run("latexmk", ["-v"]),
    run("pdflatex", ["--version"]),
    run("git", ["--version"]),
  ]);
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    sourceDateEpoch,
    latexmk: latexmk.split("\n").find((line) => line.includes("Version"))?.trim() ?? latexmk.split("\n")[0],
    pdfTeX: pdflatex.split("\n")[0],
    git: gitVersion.trim(),
  };
}

async function walkFiles(root, prefix = "") {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(absolute, relative)));
    else if (relative !== "results/manifest.json") files.push({ relative, absolute });
  }
  return files;
}

async function writeManifest(environment) {
  const files = await walkFiles(evidenceRoot);
  const entries = [];
  for (const file of files) {
    const stat = await fsp.stat(file.absolute);
    entries.push({ path: file.relative, bytes: stat.size, sha256: await hashFile(file.absolute) });
  }
  const manifest = {
    schemaVersion: 1,
    fixtureFamily: "tex64-public-workflows-v1",
    implementationCommit,
    generatedBy: "scripts/generate-public-workflow-evidence.cjs",
    environment,
    rights: {
      authoredFixtures: "Copyright Fermion Inc.; published for verification with this evidence package",
      arxivMetadata: "CC0 metadata only; no article PDF or source is included",
      thirdPartyCorpus: "not included",
    },
    files: entries,
  };
  await writeJson(path.join(resultRoot, "manifest.json"), manifest);
  return manifest;
}

async function main() {
  const refreshArxiv = process.argv.includes("--refresh-arxiv");
  await fsp.rm(resultRoot, { recursive: true, force: true });
  await fsp.mkdir(artifactRoot, { recursive: true });
  const environment = await environmentRecord();
  const review = await reviewTrace();
  const repair = await repairTrace();
  const citation = await citationTrace(refreshArxiv);
  const portability = await portabilityTrace();
  const benchmark = await benchmarkTrace();
  await Promise.all([
    writeJson(path.join(resultRoot, "axiom-review.json"), review),
    writeJson(path.join(resultRoot, "axiom-repair.json"), repair),
    writeJson(path.join(resultRoot, "arxiv-citation.json"), citation),
    writeJson(path.join(resultRoot, "editor-exit-test.json"), portability),
    writeJson(path.join(resultRoot, "math-suggest-regression.json"), benchmark),
  ]);
  const manifest = await writeManifest(environment);
  const publicJson = JSON.stringify({ review, repair, citation, portability, benchmark, manifest });
  assert.doesNotMatch(publicJson, /\/Users\/|\/var\/folders\//);
  assert.doesNotMatch(publicJson, /Bearer\s|api[_-]?key|password/i);
  process.stdout.write(`generated ${manifest.files.length} evidence files at evidence/public-workflows/results\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
