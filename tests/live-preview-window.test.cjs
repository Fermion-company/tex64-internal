"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  LivePreviewWindow, rootUnits, hollowUnit, seedText, parseProbeRecord, windowOverlays, unitIndexOf,
} = require("../electron/services/live-preview-window.cjs");

const ROOT = String.raw`\documentclass{book}
\usepackage{subfiles}
% \include{not/a/unit}
\begin{document}
\frontmatter
\subfile{tex/one}
\include{tex/two}  % the second
  \input{three.tex}
Some text with \input{inline} in it.
\end{document}
\subfile{tex/after-the-end}
`;

test("the chapters of a root are the files it reads on lines of their own", () => {
  const units = rootUnits("/p/book.tex", ROOT);
  assert.deepEqual(units.map((unit) => [unit.command, unit.filePath]), [
    ["subfile", "/p/tex/one.tex"], ["include", "/p/tex/two.tex"], ["input", "/p/three.tex"],
  ]);
  assert.deepEqual(rootUnits("/p/a.tex", "\\begin{document}\n\\input{only}\n\\end{document}\n"), [], "one chapter is no book");
  assert.deepEqual(rootUnits("/p/a.tex", "\\begin{document}\n\\input{x}\n\\input{y}\n\\input{x}\n\\end{document}\n"), [],
    "a file read twice has no single place");
  assert.deepEqual(rootUnits("/p/a.tex", "\\input{x}\n\\input{y}\n"), [], "no document body");
});

test("an emptied chapter keeps what its command needs to read it", () => {
  const sub = "\\documentclass[../book]{subfiles}\n% note\n\\begin{document}\n\\chapter{One}\nText.\n\\end{document}\n";
  assert.equal(hollowUnit({ command: "subfile" }, sub),
    "\\documentclass[../book]{subfiles}\n% note\n\\begin{document}\n\\end{document}\n");
  assert.equal(hollowUnit({ command: "subfile" }, sub, "\\seed"),
    "\\documentclass[../book]{subfiles}\n% note\n\\begin{document}\n\\seed\n\\end{document}\n");
  assert.equal(hollowUnit({ command: "include" }, "\\chapter{Two}\n"), "");
  assert.equal(hollowUnit({ command: "input" }, "\\chapter{Three}\n", "\\seed"), "\\seed\n");
  assert.equal(hollowUnit({ command: "subfile" }, null, "\\seed"), "\\seed\n");
});

test("the probe's record gives each file its counters and the page of its first paragraph", () => {
  const record = [
    "F{}{book.toc}{page}{3}{chapter}{0}",
    "F{tex}{one.tex}{page}{5}{chapter}{0}{caption@flags}{0}{__jlreq_x}{2}",
    "P{tex}{one.tex}{7}{9}",
    "F{tex}{two.tex}{page}{20}{chapter}{1}{section}{4}",
    "F{tex}{two.tex}{page}{99}{chapter}{9}",
    "P{tex}{two.tex}{21}{23}",
    "P{tex}{two.tex}{50}{52}",
    "F{}{three}{page}{30}{chapter}{2}",
    "E{40}",
    "",
  ].join("\n");
  const parsed = parseProbeRecord(record, "/p");
  assert.equal(parsed.sheets, 40);
  assert.deepEqual(parsed.files.get("/p/tex/one.tex"),
    { counters: [["page", 5], ["chapter", 0], ["caption@flags", 0], ["__jlreq_x", 2]], page: 7, sheet: 9 });
  assert.deepEqual(parsed.files.get("/p/tex/two.tex"),
    { counters: [["page", 20], ["chapter", 1], ["section", 4]], page: 21, sheet: 23 }, "the first read and its first paragraph");
  assert.equal(parsed.files.get("/p/three.tex").page, null, "no paragraph seen: no page");
});

test("the seed sets the page and every other counter that exists", () => {
  assert.equal(seedText({ page: 39, counters: [["page", 34], ["chapter", 1], ["caption@flags", 0], ["bad name}", 3]] }),
    "\\clearpage\\setcounter{page}{39}" +
    "\\ifcsname c@chapter\\endcsname\\setcounter{chapter}{1}\\fi" +
    "\\ifcsname c@caption@flags\\endcsname\\setcounter{caption@flags}{0}\\fi");
});

test("a window empties every other chapter and seeds the one before it", () => {
  const units = rootUnits("/p/book.tex", ROOT);
  const texts = new Map([
    ["/p/tex/one.tex", "\\documentclass[../book]{subfiles}\n\\begin{document}\nOne.\n\\end{document}\n"],
    ["/p/tex/two.tex", "Two.\n"], ["/p/three.tex", "Three.\n"],
  ]);
  const seeds = new Map([["/p/tex/two.tex", { page: 21, counters: [["chapter", 1]] }]]);
  const readText = (file) => texts.get(file) ?? null;
  const second = windowOverlays({ units, index: 1, seeds, readText });
  assert.deepEqual([...second.keys()], ["/p/tex/one.tex", "/p/three.tex"]);
  assert.match(second.get("/p/tex/one.tex"), /\\begin\{document\}\n\\clearpage\\setcounter\{page\}\{21\}.*\\setcounter\{chapter\}\{1\}\\fi\n\\end\{document\}\n$/);
  assert.equal(second.get("/p/three.tex"), "");
  const first = windowOverlays({ units, index: 0, seeds, readText });
  assert.deepEqual([...first.entries()], [["/p/tex/two.tex", ""], ["/p/three.tex", ""]], "the first chapter starts from nothing");
  assert.equal(windowOverlays({ units, index: 2, seeds, readText }), null, "no state known for the third");
});

test("the root's index is blanked without moving a character", () => {
  const { windowRootText } = require("../electron/services/live-preview-window.cjs");
  const root = "\\begin{document}\n\\input{a}\n\\ifx\\a\\b\\else\\printindex\\fi\n\\printindex[names]\n\\printindexes\n\\end{document}\n";
  const blanked = windowRootText(root);
  assert.equal(blanked.length, root.length);
  assert.equal(blanked, root.replace("\\else\\printindex\\fi", "\\else\\relax     \\fi"));
});

test("a file read by a chapter belongs to that chapter", () => {
  const units = rootUnits("/p/book.tex", ROOT);
  const texts = new Map([
    ["/p/tex/one.tex", "\\input{tex/sections/a}\n"], ["/p/tex/sections/a.tex", "\\input{deep}\n"],
    ["/p/tex/sections/deep.tex", "x"], ["/p/tex/two.tex", "\\subfile{parts/b}\n"], ["/p/tex/parts/b.tex", "y"],
  ]);
  const readText = (file) => texts.get(file) ?? null;
  assert.equal(unitIndexOf("/p/tex/two.tex", units, readText, "/p"), 1);
  assert.equal(unitIndexOf("/p/tex/sections/a.tex", units, readText, "/p"), 0);
  assert.equal(unitIndexOf("/p/tex/sections/deep.tex", units, readText, "/p"), 0);
  assert.equal(unitIndexOf("/p/tex/parts/b.tex", units, readText, "/p"), 1);
  assert.equal(unitIndexOf("/p/styles/x.sty", units, readText, "/p"), -1);
});

const project = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-window-test-"));
  fs.mkdirSync(path.join(dir, "tex"));
  fs.writeFileSync(path.join(dir, "book.tex"), "\\documentclass{book}\n\\begin{document}\n\\input{tex/one}\n\\input{tex/two}\n\\input{tex/three}\n\\end{document}\n");
  for (const name of ["one", "two", "three"]) fs.writeFileSync(path.join(dir, "tex", `${name}.tex`), `\\chapter{${name}}\n`);
  fs.writeFileSync(path.join(dir, "book.aux"), "\\relax\n");
  return dir;
};
const RECORD = "F{tex}{one.tex}{page}{1}{chapter}{0}\nP{tex}{one.tex}{1}{1}\nF{tex}{two.tex}{page}{90}{chapter}{1}\nP{tex}{two.tex}{91}{91}\n" +
  "F{tex}{three.tex}{page}{180}{chapter}{2}\nP{tex}{three.tex}{181}{181}\nE{250}\n";

test("a long book is probed once per Build paper, then windows follow the file being edited", async () => {
  const dir = project();
  try {
    let probes = 0;
    let finish;
    const window = new LivePreviewWindow({
      runProbe: () => { probes += 1; return new Promise((resolve) => { finish = () => resolve(RECORD); }); },
    });
    const rootPath = path.join(dir, "book.tex");
    const ask = (activePath, paper = { pages: 250, mtimeMs: 1, size: 10 }) => window.plan({
      rootPath, rootText: fs.readFileSync(rootPath, "utf8"), projectRoot: dir, activePath, paper });
    assert.deepEqual(await ask(path.join(dir, "tex", "two.tex")), { pending: true });
    assert.deepEqual(await ask(path.join(dir, "tex", "two.tex")), { pending: true });
    assert.equal(probes, 1);
    const running = window.states.get(rootPath).probing;
    finish();
    await running;
    const second = await ask(path.join(dir, "tex", "two.tex"));
    assert.equal(second.unitPath, path.join(dir, "tex", "two.tex"));
    assert.equal(second.pending, false);
    assert.match(second.overlays.get(path.join(dir, "tex", "one.tex")), /\\setcounter\{page\}\{91\}.*\\setcounter\{chapter\}\{1\}/);
    assert.equal(second.overlays.get(path.join(dir, "tex", "three.tex")), "");
    // a file that is no chapter keeps the chapter in hand
    assert.equal((await ask(path.join(dir, "book.tex"))).unitPath, path.join(dir, "tex", "two.tex"));
    const third = await ask(path.join(dir, "tex", "three.tex"));
    assert.match(third.overlays.get(path.join(dir, "tex", "two.tex")), /\\setcounter\{page\}\{181\}/);
    assert.equal(probes, 1);
    // another session reads what this one saved
    const later = new LivePreviewWindow({ runProbe: () => { throw new Error("not probed again"); } });
    const reopened = await later.plan({ rootPath, rootText: fs.readFileSync(rootPath, "utf8"), projectRoot: dir,
      activePath: path.join(dir, "tex", "three.tex"), paper: { pages: 250, mtimeMs: 1, size: 10 } });
    assert.equal(reopened.unitPath, path.join(dir, "tex", "three.tex"));
    // a newer Build is probed again; the chapter keeps the earlier numbers meanwhile
    const stale = await ask(path.join(dir, "tex", "three.tex"), { pages: 250, mtimeMs: 2, size: 11 });
    assert.equal(stale.pending, true);
    assert.match(stale.overlays.get(path.join(dir, "tex", "two.tex")), /\\setcounter\{page\}\{181\}/);
    assert.equal(probes, 2);
    window.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a probe that broke pages differently from the Build gives no window", async () => {
  const dir = project();
  try {
    const window = new LivePreviewWindow({ runProbe: async () => RECORD });
    const rootPath = path.join(dir, "book.tex");
    const ask = () => window.plan({ rootPath, rootText: fs.readFileSync(rootPath, "utf8"), projectRoot: dir,
      activePath: path.join(dir, "tex", "two.tex"), paper: { pages: 251, mtimeMs: 1, size: 10 } });
    assert.deepEqual(await ask(), { pending: true });
    await window.states.get(rootPath).probing;
    assert.equal(await ask(), null);
    // a document that is one file, or has no Build beside it, is not windowed at all
    assert.equal(await window.plan({ rootPath: path.join(dir, "tex", "one.tex"), rootText: "\\begin{document}x\\end{document}",
      projectRoot: dir, paper: { pages: 300, mtimeMs: 1, size: 1 } }), null);
    fs.rmSync(path.join(dir, "book.aux"));
    assert.equal(await new LivePreviewWindow({ runProbe: async () => RECORD }).plan({ rootPath,
      rootText: fs.readFileSync(rootPath, "utf8"), projectRoot: dir, paper: { pages: 250, mtimeMs: 1, size: 10 } }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const { TdomEngineService } = require("../electron/services/tdom-engine.cjs");
const { LivePreviewPageLimit } = require("../electron/services/live-preview-page-limit.cjs");

const windowedService = (dir, { pages = 250, plan }) => {
  const asked = [];
  const service = new TdomEngineService({
    pageLimit: new LivePreviewPageLimit({ countPages: async () => pages }),
    loadBuildCache: async () => ({ hit: false }),
    liveWindow: { plan: async (request) => { asked.push(request); return plan(request); }, stop() {} },
    pageWatchIntervalMs: 0,
  });
  const opened = [];
  const edits = [];
  service.start = async () => { Object.assign(service, { state: "ready", proc: { exitCode: null, killed: false, kill() {} }, port: 1 }); };
  service.openAfterBuildLease = async (snapshot) => { opened.push(snapshot); return { fulfilled: false, srcRev: opened.length }; };
  service.loadPersistedCanonicalBuild = async () => { throw new Error("a windowed document takes no Build"); };
  return { service, asked, opened, edits };
};

test("past the limit the engine is given the chapter in front, and keeps it while the user types", async () => {
  const dir = project();
  try {
    fs.writeFileSync(path.join(dir, "book.pdf"), "%PDF-1.5 stand-in");
    const hollow = (request) => ({
      unitPath: request.activePath, rootText: request.rootText.endsWith("% windowed") ? request.rootText : `${request.rootText}% windowed`,
      overlays: new Map([[path.join(dir, "tex", "one.tex"), "\\seed\n"], [path.join(dir, "tex", "three.tex"), ""]]),
    });
    const { service, asked, opened } = windowedService(dir, { plan: hollow });
    const push = (extra = {}) => service.push({ workspaceRoot: dir, rootFile: "book.tex", activePath: "tex/two.tex",
      buffers: [{ path: "tex/two.tex", text: "\\chapter{two} edited\n" }, { path: "tex/three.tex", text: "unsaved elsewhere\n" }], ...extra });
    const answer = await push({ fresh: true });
    assert.deepEqual([answer.ok, answer.limited, answer.srcRev], [true, undefined, 1]);
    assert.equal(service.getStatus().pageLimited, false);
    assert.equal(asked[0].activePath, path.join(dir, "tex", "two.tex"));
    assert.equal(asked[0].paper.pages, 250);
    assert.equal(opened[0].source, `${fs.readFileSync(path.join(dir, "book.tex"), "utf8")}% windowed`);
    assert.deepEqual([...opened[0].overlays].sort(), [
      [path.join(dir, "tex", "one.tex"), "\\seed\n"],
      [path.join(dir, "tex", "three.tex"), ""],
      [path.join(dir, "tex", "two.tex"), "\\chapter{two} edited\n"],
    ]);
    // the next keystroke is no open: the window is still applied to it
    service.rememberOpenedSnapshot(opened[0], 1);
    await push();
    assert.equal(asked.length, 2);
    assert.equal(opened.length, 1, "same chapter, same buffers: nothing to send");
    service.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a long document that cannot be windowed, or is not ready yet, stays on its Build paper", async () => {
  const dir = project();
  try {
    fs.writeFileSync(path.join(dir, "book.pdf"), "%PDF-1.5 stand-in");
    let answerWith = null;
    const { service, opened } = windowedService(dir, { plan: () => answerWith });
    const push = () => service.push({ workspaceRoot: dir, rootFile: "book.tex", activePath: "tex/two.tex", buffers: [], fresh: true });
    assert.deepEqual(await push(), { ok: true, limited: true, pages: 250 });
    answerWith = { pending: true };
    assert.deepEqual(await push(), { ok: true, limited: true, pages: 250, pending: true });
    assert.equal(service.getStatus().pageLimited, true);
    assert.equal(opened.length, 0);
    // under the limit nothing is asked of the window at all
    const short = windowedService(dir, { pages: 120, plan: () => { throw new Error("not asked"); } });
    short.service.loadPersistedCanonicalBuild = async () => null;
    assert.equal((await short.service.push({ workspaceRoot: dir, rootFile: "book.tex", buffers: [], fresh: true })).limited, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the Build paper's sheets around the chapter: before its first sheet, from the next chapter's on", () => {
  const { outerSheets } = require("../electron/services/live-preview-window.cjs");
  const units = ["a", "b", "c", "d"].map((name) => ({ command: "input", filePath: `/p/${name}.tex` }));
  const seeds = new Map([["/p/a.tex", { sheet: 3 }], ["/p/b.tex", { sheet: 39 }], ["/p/d.tex", { sheet: 80 }]]);
  const paper = { pages: 100 };
  const ask = (index) => outerSheets({ units, index, seeds, paper, rootPath: "/p/book.tex" });
  assert.deepEqual(ask(1), { pdfPath: "/p/book.pdf", pages: 100, before: 38, afterFrom: 80 }, "a chapter without a state of its own is skipped over");
  assert.deepEqual(ask(0), { pdfPath: "/p/book.pdf", pages: 100, before: 0, afterFrom: 39 }, "what the root prints before the first chapter is live with it");
  assert.deepEqual(ask(3), { pdfPath: "/p/book.pdf", pages: 100, before: 79, afterFrom: 101 }, "nothing follows the last chapter");
});

test("the engine is told of the outer sheets once, and again when the chapter changes", async () => {
  const dir = project();
  const http = require("node:http");
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { posts.push([req.url, JSON.parse(body)]); res.setHeader("Content-Type", "application/json"); res.end("{\"ok\":true}"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    fs.writeFileSync(path.join(dir, "book.pdf"), "%PDF-1.5 stand-in");
    let before = 90;
    const { service, opened } = windowedService(dir, { plan: (request) => ({
      unitPath: request.activePath, overlays: new Map([[path.join(dir, "tex", "one.tex"), `\\seed${before}\n`]]),
      outer: { pdfPath: path.join(dir, "book.pdf"), pages: 250, before, afterFrom: before + 90 },
    }) });
    service.start = async () => { Object.assign(service, { state: "ready", proc: { exitCode: null, killed: false, kill() {} }, port: server.address().port }); };
    service.openAfterBuildLease = async (snapshot) => { opened.push(snapshot); service.rememberOpenedSnapshot(snapshot, 1); return { fulfilled: true, srcRev: 1 }; };
    const push = (extra = {}) => service.push({ workspaceRoot: dir, rootFile: "book.tex", activePath: "tex/two.tex", buffers: [], ...extra });
    await push({ fresh: true });
    assert.deepEqual(posts, [["/outer", { pdfPath: path.join(dir, "book.pdf"), pages: 250, before: 90, afterFrom: 180 }]]);
    await push();
    assert.equal(posts.length, 1, "the same sheets are not sent again");
    before = 180;
    await push().catch(() => {});
    assert.deepEqual(posts.filter(([url]) => url === "/outer").at(-1)[1].before, 180);
    service.stop();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the Build's labels reach the chapter through a file, and only where the path is one LaTeX can read", () => {
  const { buildLabels } = require("../electron/services/live-preview-window.cjs");
  const files = new Map([
    ["/p/book.aux", "\\relax\n\\newlabel{a}{{1}{2}}\n\\newlabel{open}{{1}{2}\n\\@input{tex/two.aux}\n\\bibcite{x}{1}\n\\@writefile{toc}{x}\n"],
    ["/p/tex/two.aux", "\\newlabel{b}{{3}{4}{title}{section.3}{}}\n\\@setckpt{tex/two}{\\setcounter{page}{9}}\n"],
  ]);
  assert.deepEqual(buildLabels("/p/book.aux", (file) => files.get(file) ?? null),
    ["\\newlabel{a}{{1}{2}}", "\\newlabel{b}{{3}{4}{title}{section.3}{}}"]);
  const seed = { page: 7, counters: [] };
  assert.equal(seedText(seed, "/p/.tex64/live-window/x.labels.tex"),
    "\\begingroup\\input{/p/.tex64/live-window/x.labels.tex}\\endgroup\\clearpage\\setcounter{page}{7}");
  assert.equal(seedText(seed, "/p/100%/x.labels.tex"), "\\clearpage\\setcounter{page}{7}");
  assert.equal(seedText(seed, null), "\\clearpage\\setcounter{page}{7}");
});
