"use strict";
// Choosing the document that reads a chapter (tex-build-target.cjs), audit
// round 10 #11: a document whose \includeonly leaves the chapter out does not
// read it, and what a document's last Build recorded reading (its .fls, kept
// with the Build's cache) comes before what the sources declare. Build, Jump
// (resolveJumpDocument) and the Live root (main's document query) all ask
// resolveBuildTarget, so they choose alike.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { resolveBuildTarget, resolveIncludingDocuments, resolveIncludesOf } = require("../electron/services/tex-build-target.cjs");
const { createBuildCoreHandlers } = require("../electron/handlers/build/build-core.cjs");
const { createBuildPathResolvers } = require("../electron/handlers/build/path-resolvers.cjs");
const { BuildService } = require("../electron/services/build/service.cjs");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");
const { savePreviewCacheGeneration, loadRecordedReads } = require("../electron/services/build/preview-cache.cjs");
const { projectLookupInventory, readOwnershipRecorder } = require("../electron/services/build/recorder-ownership.cjs");

async function recorderFixture(root, main, reads, recordedPath, omitted = []) {
  const fls = recordedPath ?? path.join(root, main.replace(/\.tex$/, ".fls"));
  if (!recordedPath) fs.writeFileSync(fls, [`PWD ${fs.realpathSync(root)}`, ...reads.map(file => `INPUT ${file}`)].join("\n"));
  const { external, recorder } = await readOwnershipRecorder(fls, fs.realpathSync(root));
  const inputs = reads.filter(file => !omitted.includes(file)).map(file => {
    const bytes = fs.readFileSync(path.join(root, file));
    return { role: "project", path: file, sha256: hash(bytes), bytes: bytes.length };
  });
  return { fls, inputs, ownership: { inventory: await projectLookupInventory(root), external, recorder } };
}

const fakeWorkspace = (files, recent = []) => ({
  getRootPath: () => "/ws",
  resolvePath: (file) => path.posix.join("/ws", file),
  readFile: async (file) => { if (file in files) return files[file]; throw new Error("ENOENT"); },
  listFiles: async () => Object.keys(files),
  getRecentBuildTargets: () => recent,
  rootInfo: async () => null,
  resolveTexRootFromMagic: async () => null,
});
const doc = (preamble, body) => `\\documentclass{book}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
// The auditor's two editions (audit/scratch/r10/owner-proof): the short one
// declares the chapter but selects only the summary.
const editions = (shortPreamble = "\\includeonly{summary}", extra = {}) => ({
  "full.tex": doc("", "\\include{chapter}"),
  "short.tex": doc(shortPreamble, "\\include{summary}\n\\include{chapter}"),
  "chapter.tex": "The selected chapter.",
  "summary.tex": "Short version.",
  ...extra,
});
const none = () => null;
const asksForEdition = (error) => {
  assert.equal(error.code, "BUILD_TARGET_CHOICE");
  assert.deepEqual(error.candidates, ["full.tex", "short.tex"]);
  assert.equal(error.requested, "chapter.tex");
  return true;
};

for (const [edition, preamble] of [
  ["etoolbox settoggle", String.raw`\usepackage{etoolbox}\newtoggle{teacher}\settoggle{teacher}{true}
\iftoggle{teacher}{\includeonly{summary}}{\includeonly{chapter}}`],
  ["ifthen generated setter", String.raw`\usepackage{ifthen}\newboolean{teacher}\teachertrue
\ifthenelse{\boolean{teacher}}{\includeonly{summary}}{\includeonly{chapter}}`],
  ["etoolbox newbool", String.raw`\usepackage{etoolbox}\newbool{teacher}\booltrue{teacher}
\ifbool{teacher}{\includeonly{summary}}{\includeonly{chapter}}`],
  ["providecommand with an existing meaning", String.raw`\newcommand{\preset}{\includeonly{summary}}
\providecommand{\preset}{\includeonly{chapter}}\preset`],
  ["copied includeonly meaning", String.raw`\let\preset\includeonly\preset{summary}`],
  ["constructed control sequence", String.raw`\csname includeonly\endcsname{summary}`],
  ["class options", String.raw`\includeonly{summary}`],
  ["begindocument hook", String.raw`\AddToHook{begindocument/before}{\includeonly{summary}}`],
  ["unresolved preamble input", String.raw`\includeonly{summary}\input{publisher-settings}`],
]) {
  test(`Build asks for an edition when the preamble contains ${edition}`, async () => {
    const files = editions(String.raw`\input{edition}`, { "edition.tex": preamble });
    if (edition === "class options") files["short.tex"] = files["short.tex"].replace("{book}", "[twoside]{book}");
    const ws = fakeWorkspace(files, ["short.tex", "full.tex"]);
    await assert.rejects(resolveBuildTarget(ws, "chapter.tex", { recordedReads: none }), asksForEdition);
    assert.deepEqual(await resolveIncludingDocuments(ws, "chapter.tex"), ["full.tex", "short.tex"]);
  });
}

test("LuaLaTeX's fresh recorder selects the only edition that actually read the chapter", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-recorder-edition-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = editions(String.raw`\input{edition}`, {
    "edition.tex": String.raw`\usepackage{etoolbox}\newtoggle{teacher}\settoggle{teacher}{true}
\iftoggle{teacher}{\includeonly{chapter}}{\includeonly{summary}}`,
    "full.tex": doc("", String.raw`\include{summary}`),
  });
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  execFileSync("lualatex", ["-interaction=batchmode", "-halt-on-error", "-recorder", "short.tex"], { cwd: dir });
  const reads = [...new Set([...fs.readFileSync(path.join(dir, "short.fls"), "utf8")
    .matchAll(/^INPUT \.\/(.+\.tex)$/gm)].map((match) => match[1]))];
  assert.deepEqual(reads.sort(), ["chapter.tex", "edition.tex", "short.tex"]);
  const { fls, inputs, ownership } = await recorderFixture(dir, "short.tex", reads, path.join(dir, "short.fls"));
  const saved = await savePreviewCacheGeneration({
    rootPath: dir, mainFileName: "short.tex",
    descriptor: {
      profileSignature: "p", engineSignature: "e",
      provenance: { inputProof: "build-fls", dynamicInputs: false, unknownInputs: [], systemInputsStable: true, ownership },
      inputs,
      artifacts: { pdf: path.join(dir, "short.pdf"), fls, aux: [] },
    },
  });
  assert.equal(saved.saved, true, JSON.stringify(saved));
  const ws = new WorkspaceManager();
  ws.setRootPath(dir);
  assert.equal(await ws.resolveBuildTarget("chapter.tex"), "short.tex");
});

test("Build keeps the chooser while the explicit include graph honours literal includeonly", async () => {
  const ws = fakeWorkspace(editions(), ["short.tex"]);
  await assert.rejects(resolveBuildTarget(ws, "chapter.tex", { recordedReads: none }), asksForEdition);
  assert.deepEqual(await resolveBuildTarget(ws, "chapter.tex", { includingDocuments: true, recordedReads: none }), ["full.tex"]);
  // the summary it does select stays the short edition's
  assert.equal(await resolveBuildTarget(ws, "summary.tex", { recordedReads: none }), "short.tex");
  // Jump from the short edition's \include lines: only the selected one reads a file
  const edges = await resolveIncludesOf(ws, "short.tex", "short.tex");
  assert.deepEqual(edges.map((edge) => edge.target), ["summary.tex"]);
});

test("a commented-out \\includeonly selects nothing away", async () => {
  const ws = fakeWorkspace(editions("% \\includeonly{summary}"), ["short.tex"]);
  await assert.rejects(resolveBuildTarget(ws, "chapter.tex", { recordedReads: none }), asksForEdition);
});

test("\\includeonly with several names, spaces and line breaks", async () => {
  const listed = fakeWorkspace(editions("\\includeonly{summary,\n   chapter }"), ["short.tex"]);
  await assert.rejects(resolveBuildTarget(listed, "chapter.tex", { recordedReads: none }), asksForEdition);
  // LaTeX drops every space from the list
  const spaced = fakeWorkspace(editions("\\includeonly{ sum mary , chap\n ter}"), ["short.tex"]);
  await assert.rejects(resolveBuildTarget(spaced, "chapter.tex", { recordedReads: none }), asksForEdition);
  // the last \includeonly counts; an empty one selects nothing
  const last = fakeWorkspace(editions("\\includeonly{chapter}\n\\includeonly{summary}"), ["short.tex"]);
  assert.deepEqual(await resolveIncludingDocuments(last, "chapter.tex"), ["full.tex"]);
  const empty = fakeWorkspace(editions("\\includeonly{}"), ["short.tex"]);
  assert.deepEqual((await resolveIncludesOf(empty, "short.tex", "short.tex")).map((edge) => edge.target), []);
  assert.deepEqual(await resolveIncludingDocuments(empty, "summary.tex"), []);
});

test("\\input files are read whatever \\includeonly says", async () => {
  const files = editions("\\includeonly{summary}", {
    "short.tex": doc("\\includeonly{summary}", "\\include{summary}\n\\include{chapter}\n\\input{appendix}"),
    "appendix.tex": "Appendix.",
  });
  const ws = fakeWorkspace(files, ["short.tex"]);
  assert.equal(await resolveBuildTarget(ws, "appendix.tex", { recordedReads: none }), "short.tex");
  // an \input inside a left-out \include file is not reached either
  const nested = fakeWorkspace({ ...files, "chapter.tex": "\\input{figure}", "figure.tex": "Figure." }, ["short.tex"]);
  assert.deepEqual(await resolveIncludingDocuments(nested, "figure.tex"), ["full.tex"]);
});

test("what the last Build recorded reading comes before what the sources declare", async () => {
  // no \includeonly anywhere: both declare the chapter, the short edition was built last
  const files = editions("");
  const ws = fakeWorkspace(files, ["short.tex"]);
  await assert.rejects(resolveBuildTarget(ws, "chapter.tex", { recordedReads: none }), asksForEdition);
  const recorded = { "full.tex": ["full.tex", "chapter.tex"], "short.tex": ["short.tex", "summary.tex"] };
  const recordedReads = async ({ rootPath, mainFileName }) => {
    assert.equal(rootPath, "/ws");
    return recorded[mainFileName] ? new Set(recorded[mainFileName]) : null;
  };
  assert.equal(await resolveBuildTarget(ws, "chapter.tex", { recordedReads }), "full.tex");
  // a record for one of them only: the recorded reader wins
  const onlyShort = async ({ mainFileName }) => (mainFileName === "short.tex" ? new Set(["short.tex", "chapter.tex"]) : null);
  assert.equal(await resolveBuildTarget(fakeWorkspace(files, ["full.tex"]), "chapter.tex", { recordedReads: onlyShort }), "short.tex");
  // a reader that throws is no evidence
  await assert.rejects(resolveBuildTarget(ws, "chapter.tex", { recordedReads: async () => { throw new Error("x"); } }), asksForEdition);
});

test("the Build's cache gives the recorded reads; Jump resolves the same document", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-includeonly-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = editions("");
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  // what each edition's last Build read, as a Build stores it
  const staged = path.join(dir, "staged");
  fs.mkdirSync(staged);
  for (const [main, reads] of [["full.tex", ["full.tex", "chapter.tex"]], ["short.tex", ["short.tex", "summary.tex"]]]) {
    const pdf = path.join(staged, main.replace(/\.tex$/, ".pdf"));
    fs.writeFileSync(pdf, "%PDF-1.5\n");
    const { fls, inputs, ownership } = await recorderFixture(dir, main, reads);
    const saved = await savePreviewCacheGeneration({
      rootPath: dir, mainFileName: main,
      descriptor: {
        profileSignature: "p", engineSignature: "e",
        provenance: { inputProof: "build-fls", dynamicInputs: false, unknownInputs: [], systemInputsStable: true, ownership },
        inputs,
        artifacts: { pdf, fls, aux: [] },
      },
    });
    assert.equal(saved.saved, true, JSON.stringify(saved));
  }
  assert.deepEqual([...await loadRecordedReads({ rootPath: dir, mainFileName: "full.tex" })].sort(), ["chapter.tex", "full.tex"]);
  const workspace = new WorkspaceManager();
  workspace.setRootPath(dir);
  workspace.noteBuildTarget("short.tex");
  assert.equal(await workspace.resolveBuildTarget("chapter.tex"), "full.tex");
  const core = createBuildCoreHandlers({
    fs, workspace, buildService: new BuildService(), state: {},
    ensureWorkspace: () => workspace.getRootPath(), updateWorkspaceIfNeeded: async () => {},
    sendBuildState: () => {}, sendIssues: () => {}, sendBuildLog: () => {}, handleOpenFile: async () => {},
    pdfWindowManager: {},
  }, createBuildPathResolvers({ fs, path }));
  assert.equal((await core.resolveJumpDocument("chapter.tex")).targetFile, "full.tex");
});

test("a literal selection in a preamble input filters Build and Jump in execution order", async () => {
  const files = editions(String.raw`\includeonly{chapter}
\input edition`, {
    "edition.tex": String.raw`\input{selection}`,
    "selection.tex": String.raw`\includeonly{summary}`,
  });
  const ws = fakeWorkspace(files, ["short.tex"]);
  await assert.rejects(resolveBuildTarget(ws, "chapter.tex", { recordedReads: none }), asksForEdition);
  assert.deepEqual((await resolveIncludesOf(ws, "short.tex", "short.tex")).map((edge) => edge.target),
    ["edition.tex", "summary.tex"]);
  files["short.tex"] = doc(String.raw`\input{edition}\includeonly{chapter}`, String.raw`\include{chapter}`);
  await assert.rejects(resolveBuildTarget(ws, "chapter.tex", { recordedReads: none }), asksForEdition);
});

for (const [scenario, preamble, extra = {}] of [
  ["local package options", String.raw`\usepackage[answerkey]{edition}`, {
    "edition.sty": String.raw`\includeonly{summary}`,
  }],
  ["a project-local class", "", { "book.cls": String.raw`\includeonly{chapter}` }],
  ["a shadowed standard class size file", "", { "styles/bk10.clo": "" }],
  ["a project compiler setup", "", { ".latexmkrc": "$pre_tex_code = '…';" }],
  ["an unbraced conditional", String.raw`\iffalse\includeonly{chapter}\fi`],
  ["a literal file-existence check", String.raw`\IfFileExists{teacher.tex}{\includeonly{chapter}}{}`],
  ["a macro declared but never called", String.raw`\def\unused{\includeonly{chapter}}`],
  ["a grouped literal selection", String.raw`{\includeonly{chapter}}`],
  ["a parameterised preset", String.raw`\newcommand{\preset}[1]{\includeonly{#1}}\preset{chapter}`],
  ["a copied conditional with a setter", String.raw`\newif\ifteacher\let\ifkey=\ifteacher\teachertrue
\ifkey\includeonly{chapter}\else\includeonly{summary}\fi`],
  ["a global setter inside a group", String.raw`\newif\ifteacher{\global\teachertrue}
\ifteacher\includeonly{summary}\else\includeonly{chapter}\fi`],
  ["a preamble cycle", String.raw`\input{edition}`, {
    "edition.tex": String.raw`\input{nested}`, "nested.tex": String.raw`\input{edition}`,
  }],
  ["an input beyond the proof depth limit", String.raw`\input{preamble-0}`,
    Object.fromEntries(Array.from({ length: 40 }, (_, i) =>
      [`preamble-${i}.tex`, i === 39 ? "" : `\\input{preamble-${i + 1}}`]))],
  ["a macro-built input", String.raw`\input{\edition}`],
  ["a local input with executable material", String.raw`\input{edition}`, {
    "edition.tex": String.raw`\def\unused{\includeonly{chapter}}\endinput`,
  }],
  ["an ambiguous local input", String.raw`\input{edition}`, {
    "one/edition.tex": String.raw`\includeonly{summary}`,
    "two/edition.tex": String.raw`\includeonly{chapter}`,
  }],
]) {
  test(`a literal selection is unproved with ${scenario} elsewhere in the preamble`, async () => {
    const ws = fakeWorkspace(editions(String.raw`\includeonly{summary}` + "\n" + preamble, extra), ["short.tex"]);
    await assert.rejects(resolveBuildTarget(ws, "chapter.tex", { recordedReads: none }), asksForEdition);
    assert.ok((await resolveIncludesOf(ws, "short.tex", "short.tex")).some(({ target }) => target === "chapter.tex"));
    assert.equal(await resolveBuildTarget(ws, "chapter.tex", {
      recordedReads: ({ mainFileName }) => mainFileName === "full.tex" ? new Set(["full.tex", "chapter.tex"]) : null,
    }), "full.tex");
  });
}

test("Build keeps the release chooser when all literal editions exclude the fragment", async () => {
  const files = editions(String.raw`\includeonly{summary}`, {
    "full.tex": doc("", String.raw`\include{unrelated}`),
    "nested/last.tex": doc(String.raw`\includeonly{summary}`, String.raw`\include{chapter}`),
  });
  for (const ws of [fakeWorkspace(files), fakeWorkspace(files, ["nested/last.tex"])]) {
    await assert.rejects(resolveBuildTarget(ws, "chapter.tex", { recordedReads: none }),
      { code: "BUILD_TARGET_CHOICE", candidates: ["short.tex", "nested/last.tex"] });
    assert.deepEqual(await resolveIncludingDocuments(ws, "chapter.tex"), []);
  }
});


const hash = (text) => require("node:crypto").createHash("sha256").update(text).digest("hex");

for (const [scenario, update, omit = []] of [
  ["the current preamble excludes a nested child", (files) => {
    files["mode.sty"] = String.raw`\includeonly{summary}`;
    files["chapter.tex"] = String.raw`\input{section}`;
  }],
  ["the root changed but still includes the child", (files) => { files["short.tex"] += "% edited"; }],
  ["the transitive local style changed but kept its selection", (files) => { files["mode.sty"] += "% edited"; }],
  ["the child changed at the same byte length", (files) => { files["section.tex"] = "bbb"; }],
  ["a literal preamble input has no recorded hash", () => {}, ["edition.tex"]],
  ["the recorder has no hash for the root", () => {}, ["short.tex"]],
  ["a previously recorded local package was removed", (files) => { delete files["mode.sty"]; }],
  ["a project-local class in the preamble changed", (files) => { files["classes/local-book.cls"] += "% edited"; }],
]) {
  test(`production Build cache loses its authority when ${scenario}`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-edition-freshness-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const files = editions(String.raw`\input{edition}`, {
      "edition.tex": String.raw`\usepackage{mode}`,
      "mode.sty": String.raw`\includeonly{chapter}`,
      "classes/local-book.cls": String.raw`\LoadClass{book}`,
      "chapter.tex": String.raw`\input{section}`,
      "section.tex": "aaa",
    });
    if (scenario.includes("literal preamble")) files["edition.tex"] = String.raw`\includeonly{chapter}`;
    if (scenario.includes("project-local class")) {
      files["short.tex"] = files["short.tex"].replace("{book}", "{local-book}");
    } else {
      delete files["classes/local-book.cls"];
    }
    fs.mkdirSync(path.join(dir, "classes"));
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, file), content);
    }
    const pdf = path.join(dir, "build.pdf");
    fs.writeFileSync(pdf, "%PDF-1.5\n");
    const reads = ["short.tex", "edition.tex", "mode.sty", "chapter.tex", "section.tex", "classes/local-book.cls"]
      .filter(file => file in files);
    const { fls, inputs, ownership } = await recorderFixture(dir, "short.tex", reads, null, omit);
    const saved = await savePreviewCacheGeneration({
      rootPath: dir, mainFileName: "short.tex",
      descriptor: {
        profileSignature: "p", engineSignature: "e",
        provenance: { inputProof: "build-fls", dynamicInputs: false, unknownInputs: [], systemInputsStable: true, ownership },
        inputs,
        artifacts: { pdf, fls, aux: [] },
      },
    });
    assert.equal(saved.saved, true, JSON.stringify(saved));
    const ws = new WorkspaceManager();
    ws.setRootPath(dir);
    ws.noteBuildTarget("full.tex");
    if (!omit.length) assert.equal(await resolveBuildTarget(ws, "section.tex"), "short.tex");
    update(files);
    if (!("mode.sty" in files)) fs.unlinkSync(path.join(dir, "mode.sty"));
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
    if (scenario === "the current preamble excludes a nested child") ws.noteBuildTarget("short.tex");
    await assert.rejects(resolveBuildTarget(ws, "section.tex"), (error) => {
      assert.equal(error.code, "BUILD_TARGET_CHOICE");
      assert.deepEqual(error.candidates, ["full.tex", "short.tex"]);
      return true;
    });
  });
}

test("a literal exclusion cannot veto a fresh recorder read", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-excluded-owner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = editions();
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  const pdf = path.join(dir, "build.pdf");
  fs.writeFileSync(pdf, "%PDF-1.5\n");
  const { fls, inputs, ownership } = await recorderFixture(dir, "short.tex", ["short.tex", "chapter.tex"]);
  const saved = await savePreviewCacheGeneration({
    rootPath: dir, mainFileName: "short.tex",
    descriptor: {
      profileSignature: "p", engineSignature: "e",
      provenance: { inputProof: "build-fls", dynamicInputs: false, unknownInputs: [], systemInputsStable: true, ownership },
      inputs,
      artifacts: { pdf, fls, aux: [] },
    },
  });
  assert.equal(saved.saved, true, JSON.stringify(saved));
  const ws = new WorkspaceManager();
  ws.setRootPath(dir);
  ws.noteBuildTarget("short.tex");
  assert.equal(await resolveBuildTarget(ws, "chapter.tex"), "short.tex");
  assert.deepEqual(await resolveBuildTarget(ws, "chapter.tex", { includingDocuments: true }), ["full.tex", "short.tex"]);
});

test("two fresh recorder readers leave the release chooser intact", async () => {
  const files = editions("");
  const ws = fakeWorkspace(files, ["short.tex"]);
  await assert.rejects(resolveBuildTarget(ws, "chapter.tex", {
    recordedReads: ({ mainFileName }) => new Set([mainFileName, "chapter.tex"]),
  }), asksForEdition);
});
