"use strict";

/**
 * Realtime preview of one chapter of a long document.
 *
 * Past the length Live is offered for (live-preview-page-limit.cjs) a
 * document whose body reads its chapters from files keeps Live for the file
 * being edited: the engine is given the real root with every other chapter
 * file replaced by an empty one, so it typesets a document of chapter size.
 * The file before the chapter carries the state the chapter starts from in
 * the whole document: every LaTeX counter, and the page number its first
 * page has in the last Build.
 *
 * That state is read from one extra run of the whole document (the probe):
 * LuaLaTeX in draft mode, with the Build's auxiliary files so that it breaks
 * pages as the Build did, and a hook that writes the counters down whenever
 * a file is read. It is kept per Build paper under the project's .tex64.
 *
 * Measured on a 389-page book (16 GB Mac): the chapter alone compiles in
 * 25 s against 100 s and more for the book, and its pages break exactly as
 * in the Build.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PROBE_RECORD_EXT = ".t64w";
const PROBE_TIMEOUT_MS = 30 * 60_000;
const UNIT_RE = /^\s*\\(subfile|include|input)\s*\{([^{}]+)\}\s*$/;
const NESTED_RE = /\\(?:subfile|include|input)\s*\{([^{}]+)\}/g;
// What a Build leaves that only a viewer or a build tool reads.
const NOT_AUXILIARY_RE = /\.(?:pdf|synctex(?:\.gz)?|log|fls|fdb_latexmk|tex|sty|cls|xdv|dvi)$/i;

// Written when a file is read after \begin{document}:
//   F{path}{file}{counter}{value}{counter}{value}…   every counter, at that point
//   P{path}{file}{page}{sheet}   where the first paragraph after it was shipped:
//                                the page counter and the sheet's place in the paper
//   E{sheets}                    the length of the paper
// One line, no `%` and no space that could reach the page: the same code is
// read from a file by the probe and from the command line by a Build
// (buildRecordArgs). Nothing is opened or named before \begin{document}, so
// the job keeps the name of the document.
//
// No quote of any kind either: latexmk hands the command line to a shell
// inside double quotes (Lua strings are written [[…]]).
//
// It must not change what is typeset. A \write at the start of a paragraph
// did (LuaTeX-ja spaces a paragraph's first character by what stands before
// it; a 389-page book came out with other line breaks). So the first
// paragraph after a file is read only sets a LuaTeX attribute, which puts
// nothing in any list, and each shipout looks for that attribute in its
// page.
const PROBE_LUA = "texsfwindow={names={},pending={}}" +
  "function texsfwindow.scan(h,a,f)for n in node.traverse(h)do local v=node.has_attribute(n,a)" +
  "if v and texsfwindow.pending[v]then f[v]=true end " +
  "if n.id==node.id([[hlist]])or n.id==node.id([[vlist]])then texsfwindow.scan(n.head,a,f)end end end " +
  "function texsfwindow.ship(b)if next(texsfwindow.pending)==nil then return end " +
  "local f={}texsfwindow.scan(tex.box[b].head,luatexbase.attributes.texsfwindowattr,f)" +
  "for v in pairs(f)do texsfwindow.pending[v]=nil " +
  String.raw`tex.sprint([[\string\texsfwindowpage{]])tex.sprint(-2,texsfwindow.names[v][1])tex.sprint([[}{]])` +
  "tex.sprint(-2,texsfwindow.names[v][2])tex.sprint([[}]])end end";
const PROBE_TEX = String.raw`\makeatletter\@ifundefined{AddToHookNext}{}{\@ifundefined{ReadonlyShipoutCounter}{}{\@ifundefined{directlua}{}{` +
  String.raw`\directlua{${PROBE_LUA}}` +
  String.raw`\def\texsfwindow@elt#1{{#1}{\the\csname c@#1\endcsname}}` +
  // (no `#` inside \AtBeginDocument: hook code keeps it for its own arguments)
  String.raw`\def\texsfwindowpage#1#2{\immediate\write\texsfwindow{P{#1}{#2}{\the\c@page}{\the\numexpr\ReadonlyShipoutCounter+1\relax}}}` +
  String.raw`\AtBeginDocument{\newwrite\texsfwindow\newattribute\texsfwindowattr\newcount\texsfwindowcount` +
  String.raw`\immediate\openout\texsfwindow=\jobname${PROBE_RECORD_EXT}\relax` +
  String.raw`\AddToHook{file/before}{\begingroup\let\@elt\texsfwindow@elt` +
  String.raw`\immediate\write\texsfwindow{F{\detokenize\expandafter{\CurrentFilePath}}{\detokenize\expandafter{\CurrentFile}}\cl@@ckpt}\endgroup` +
  String.raw`\global\advance\texsfwindowcount1\relax` +
  String.raw`\directlua{texsfwindow.names[\the\texsfwindowcount]={[==[\detokenize\expandafter{\CurrentFilePath}]==],[==[\detokenize\expandafter{\CurrentFile}]==]}}` +
  String.raw`\edef\texsfwindow@next{\noexpand\AddToHookNext{para/begin}{\global\texsfwindowattr=\the\texsfwindowcount\relax` +
  String.raw`\noexpand\directlua{texsfwindow.pending[\the\texsfwindowcount]=true}}}\texsfwindow@next}` +
  String.raw`\AddToHook{shipout/before}{\directlua{texsfwindow.ship(\number\ShipoutBox)}}` +
  String.raw`\AddToHook{enddocument/afterlastpage}{\immediate\write\texsfwindow{E{\the\ReadonlyShipoutCounter}}}}}}}\makeatother`;

// The index the root prints at its end would hold the chapter's entries
// alone, on pages the Build paper already has. The engine reads the command
// from the root's text, so it is blanked there, letter for letter: every
// line and offset of the root stays where it is.
const windowRootText = (rootText) => rootText.replace(/\\printindex(?![A-Za-z@]|\s*\[)/g, "\\relax     ");

const stripComment = (line) => {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "%") continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) slashes++;
    if (slashes % 2 === 0) return line.slice(0, i);
  }
  return line;
};

const withTexExtension = (name) => (/\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.tex`);

/** The chapter files a root reads on lines of their own, in order. */
const rootUnits = (rootPath, rootText) => {
  const begin = rootText.search(/^[^%\n]*\\begin\s*\{document\}/m);
  if (begin < 0) return [];
  const units = [];
  const seen = new Set();
  for (const line of rootText.slice(begin).split("\n").slice(1)) {
    const visible = stripComment(line);
    if (/\\end\s*\{document\}/.test(visible)) break;
    const match = UNIT_RE.exec(visible);
    if (!match) continue;
    const filePath = path.resolve(path.dirname(rootPath), withTexExtension(match[2].trim()));
    // a file read twice has no single place in the document
    if (seen.has(filePath)) return [];
    seen.add(filePath);
    units.push({ command: match[1], name: match[2].trim(), filePath });
  }
  return units.length >= 2 ? units : [];
};

/** A chapter file with nothing in it but `inner`, read the way its command reads it. */
const hollowUnit = (unit, text, inner = "") => {
  if (unit.command !== "subfile" || typeof text !== "string") return inner ? `${inner}\n` : "";
  const begin = /^[^%\n]*\\begin\s*\{document\}/m.exec(text);
  if (!begin) return inner ? `${inner}\n` : "";
  return `${text.slice(0, begin.index + begin[0].length)}\n${inner ? `${inner}\n` : ""}\\end{document}\n`;
};

/** The \newlabel lines of a Build's .aux, with those of the .aux files it reads (one per \include). */
const buildLabels = (auxPath, readText = readTextOrNull) => {
  const lines = [];
  const collect = (file, depth) => {
    const text = readText(file);
    if (typeof text !== "string") return;
    for (const line of text.split("\n")) {
      if (/^\\newlabel\{/.test(line) && bracesBalanced(line)) lines.push(line);
      const read = depth < 2 ? /^\\@input\{([^{}]+\.aux)\}\s*$/.exec(line) : null;
      if (read) collect(path.resolve(path.dirname(auxPath), read[1]), depth + 1);
    }
  };
  collect(auxPath, 0);
  return lines;
};

const bracesBalanced = (line) => {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") { i++; continue; }
    if (line[i] === "{") depth++;
    else if (line[i] === "}" && --depth < 0) return false;
  }
  return depth === 0;
};

// The file of labels defines only those the document does not have yet. The
// definition sits in the file, not in the chapter's text: no `#` reaches the
// engine's blocks.
const LABELS_HEAD = String.raw`\makeatletter
\def\newlabel#1#2{\@ifundefined{r@#1}{\global\@namedef{r@#1}{#2}}{}}`;

// A path LaTeX can read inside \input{…} as it stands.
const texReadablePath = (filePath) => !/[%#{}\\~^&$"]/.test(filePath);

/**
 * The state a chapter starts from, as one line of LaTeX. `labelsPath` is a
 * file of the Build's \newlabel lines: the numbers and pages of every other
 * chapter, as of that Build. A label the document has defined itself (from
 * its own run) keeps its own value.
 */
const seedText = (seed, labelsPath = null) => {
  const labels = labelsPath && texReadablePath(labelsPath)
    ? `\\begingroup\\input{${labelsPath}}\\endgroup`
    : "";
  const counters = seed.counters.filter(([name]) => name !== "page" && /^[A-Za-z0-9@:._*-]+$/.test(name))
    .map(([name, value]) => `\\ifcsname c@${name}\\endcsname\\setcounter{${name}}{${value}}\\fi`);
  return `${labels}\\clearpage\\setcounter{page}{${seed.page}}${counters.join("")}`;
};

const braceGroups = (line, from) => {
  const groups = [];
  let depth = 0;
  let start = -1;
  for (let i = from; i < line.length; i++) {
    if (line[i] === "{") { if (depth === 0) start = i + 1; depth++; }
    else if (line[i] === "}") { depth--; if (depth === 0) groups.push(line.slice(start, i)); if (depth < 0) break; }
  }
  return groups;
};

/** The probe's record: for each file, the counters it was read with and where its first paragraph went. */
const parseProbeRecord = (text, rootDir) => {
  const files = new Map();
  let sheets = null;
  const keyOf = (dir, file) => path.resolve(rootDir, dir.trim(), withTexExtension(file.trim()));
  for (const line of String(text ?? "").split("\n")) {
    const groups = braceGroups(line, 1);
    if (line[0] === "E") sheets = Number(groups[0]);
    if (line[0] !== "F" && line[0] !== "P") continue;
    if (groups.length < 2 || !groups[1].trim()) continue;
    const key = keyOf(groups[0], groups[1]);
    if (line[0] === "F") {
      // the first read of a file is its place in the document
      if (files.has(key)) continue;
      const counters = [];
      for (let i = 2; i + 1 < groups.length; i += 2) {
        const value = Number(groups[i + 1]);
        if (Number.isInteger(value)) counters.push([groups[i], value]);
      }
      files.set(key, { counters, page: null, sheet: null });
    } else {
      const entry = files.get(key);
      const page = Number(groups[2]);
      const sheet = Number(groups[3]);
      if (entry && entry.page === null && Number.isInteger(page) && Number.isInteger(sheet)) {
        entry.page = page;
        entry.sheet = sheet;
      }
    }
  }
  return { files, sheets: Number.isInteger(sheets) ? sheets : null };
};

/**
 * The overlays that leave only `units[index]` in the document.
 * `seeds` maps a unit's file to { counters, page }; the first unit needs none.
 */
const windowOverlays = ({ units, index, seeds, readText, labelsPath = null }) => {
  const overlays = new Map();
  const seed = index > 0 ? seeds.get(units[index].filePath) : null;
  if (index > 0 && !seed) return null;
  units.forEach((unit, at) => {
    if (at === index) return;
    overlays.set(unit.filePath, hollowUnit(unit, readText(unit.filePath), at === index - 1 ? seedText(seed, labelsPath) : ""));
  });
  return overlays;
};

/**
 * The sheets of the Build paper that stand before and after `units[index]`:
 * 1…before, and afterFrom…pages. The chapter itself (with whatever the root
 * prints before the first chapter) is what the engine typesets.
 */
const outerSheets = ({ units, index, seeds, paper, rootPath }) => {
  const before = index > 0 ? (seeds.get(units[index].filePath)?.sheet ?? 0) - 1 : 0;
  const next = units.slice(index + 1).map((unit) => seeds.get(unit.filePath)?.sheet).find(Number.isInteger);
  const afterFrom = next ?? paper.pages + 1;
  if (before < 0 || afterFrom <= before || afterFrom > paper.pages + 1) return null;
  return { pdfPath: rootPath.replace(/\.tex$/i, ".pdf"), pages: paper.pages, before, afterFrom };
};

const readTextOrNull = (filePath) => {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return null; }
};

/** The unit `filePath` belongs to: the unit itself, or a file the unit reads. */
const unitIndexOf = (filePath, units, readText = readTextOrNull, rootDir = null) => {
  const direct = units.findIndex((unit) => unit.filePath === filePath);
  if (direct >= 0) return direct;
  for (let index = 0; index < units.length; index++) {
    const seen = new Set();
    const reads = (file, depth) => {
      if (depth > 4 || seen.has(file)) return false;
      seen.add(file);
      const text = readText(file);
      if (typeof text !== "string") return false;
      for (const match of text.matchAll(NESTED_RE)) {
        const name = withTexExtension(match[1].trim());
        // \input resolves against the root's folder, \subfile against the file's own
        for (const base of new Set([rootDir ?? path.dirname(units[index].filePath), path.dirname(file)])) {
          const child = path.resolve(base, name);
          if (child === filePath || reads(child, depth + 1)) return true;
        }
      }
      return false;
    };
    if (reads(units[index].filePath, 0)) return index;
  }
  return -1;
};

// ---- the record from the Build itself -------------------------------------
// A Build of such a book is a whole-document run already. With these latexmk
// arguments it writes the probe's record as it goes, and no probe is needed:
// the code is put in front of the document on LuaLaTeX's own command line
// (latexmk's %P), whatever that command is in the project's latexmkrc.
const buildRecordArgs = () => [
  "-e", `$pre_tex_code = q{${PROBE_TEX}}; $lualatex =~ s/%S/%P/ unless $lualatex =~ /%P/;`,
];

const OWN_PRETEX_RE = /pre_?tex|%P/;

/**
 * Whether a Build of `rootPath` should carry the record: a LuaLaTeX book in
 * chapters whose last paper is past the Live length, and whose project does
 * not use latexmk's pretex for something of its own.
 */
const wantsBuildRecord = async ({ projectRoot, rootPath, engine, extraArgs = [], limit, countPages, readText = readTextOrNull }) => {
  if (engine !== "lualatex" || !/\.tex$/i.test(rootPath)) return false;
  if (extraArgs.some((arg) => OWN_PRETEX_RE.test(String(arg)))) return false;
  for (const dir of new Set([projectRoot, path.dirname(rootPath)])) {
    for (const name of [".latexmkrc", "latexmkrc"]) {
      const rc = readText(path.join(dir, name));
      if (typeof rc === "string" && OWN_PRETEX_RE.test(rc)) return false;
    }
  }
  const rootText = readText(rootPath);
  if (typeof rootText !== "string" || !rootUnits(rootPath, rootText).length) return false;
  try {
    const pages = await countPages(rootPath.replace(/\.tex$/i, ".pdf"));
    return Number.isInteger(pages) && pages > limit;
  } catch { return false; }
};

const buildRecordFile = (projectRoot, rootPath) => {
  const id = crypto.createHash("sha256").update(path.relative(projectRoot, rootPath)).digest("hex").slice(0, 16);
  return path.join(projectRoot, ".tex64", "live-window", `${id}.build.json`);
};

/** Keeps what a Build wrote down, with the paper it belongs to. */
const saveBuildRecord = ({ projectRoot, rootPath, pdfPath, recordPath }) => {
  try {
    const record = fs.readFileSync(recordPath, "utf8");
    const stats = fs.statSync(pdfPath);
    const file = buildRecordFile(projectRoot, rootPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ paper: { mtimeMs: stats.mtimeMs, size: stats.size }, record }));
    return true;
  } catch { return false; }
};

const loadBuildRecord = (projectRoot, rootPath, paper) => {
  try {
    const saved = JSON.parse(fs.readFileSync(buildRecordFile(projectRoot, rootPath), "utf8"));
    return saved?.paper?.mtimeMs === paper.mtimeMs && saved.paper.size === paper.size && typeof saved.record === "string"
      ? saved.record : null;
  } catch { return null; }
};

/** The chapters' starting states in a record, if the run it came from broke pages as the paper did. */
const seedsFromRecord = (record, units, paper, rootDir) => {
  const parsed = parseProbeRecord(record, rootDir);
  const seeds = new Map();
  if (parsed.sheets === paper.pages) {
    for (const unit of units) {
      const entry = parsed.files.get(unit.filePath);
      if (entry && entry.page !== null) seeds.set(unit.filePath, entry);
    }
  }
  return { seeds, sheets: parsed.sheets };
};

const defaultRunProbe = ({ rootPath, workDir, env, signal }) => new Promise((resolve, reject) => {
  const rootDir = path.dirname(rootPath);
  const jobName = path.basename(rootPath).replace(/\.tex$/i, "");
  // The code goes on the command line, as in a Build: a file read before
  // the document is one more file in the run, and a document can tell.
  const child = spawn("lualatex", [
    "-draftmode", "-interaction=nonstopmode", `-output-directory=${workDir}`, `-jobname=${jobName}`,
    `${PROBE_TEX}\\input{${path.basename(rootPath)}}`,
  ], {
    cwd: rootDir,
    env,
    stdio: "ignore",
    signal,
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("exit", () => {
    clearTimeout(timer);
    // LaTeX errors do not matter here; what the run wrote down does
    try { resolve(fs.readFileSync(path.join(workDir, `${jobName}${PROBE_RECORD_EXT}`), "utf8")); }
    catch (error) { reject(error); }
  });
});

class LivePreviewWindow {
  constructor({ runProbe = defaultRunProbe, readText = readTextOrNull, stat = fs.promises.stat, env = () => process.env } = {}) {
    this.runProbe = runProbe;
    this.readText = readText;
    this.stat = stat;
    this.env = env;
    this.generation = 0;
    this.states = new Map(); // rootPath -> { paperKey, seeds, sheets, probing, abort, unitPath }
  }

  cacheFile(projectRoot, rootPath) {
    const id = crypto.createHash("sha256").update(path.relative(projectRoot, rootPath)).digest("hex").slice(0, 16);
    return path.join(projectRoot, ".tex64", "live-window", `${id}.json`);
  }

  loadCached(projectRoot, rootPath, paperKey) {
    try {
      const saved = JSON.parse(fs.readFileSync(this.cacheFile(projectRoot, rootPath), "utf8"));
      if (saved?.paperKey !== paperKey || !Array.isArray(saved.seeds)) return null;
      return { seeds: new Map(saved.seeds), sheets: saved.sheets ?? null };
    } catch { return null; }
  }

  // The Build's labels beside the saved state, written once per Build paper.
  labelsFile(projectRoot, rootPath, state) {
    if (state.labelsFor === state.paperKey) return state.labelsPath;
    state.labelsFor = state.paperKey;
    state.labelsPath = null;
    try {
      const lines = buildLabels(rootPath.replace(/\.tex$/i, ".aux"), this.readText);
      if (lines.length) {
        const file = this.cacheFile(projectRoot, rootPath).replace(/\.json$/, ".labels.tex");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${LABELS_HEAD}\n${lines.join("\n")}\n`);
        state.labelsPath = file;
      }
    } catch { /* the chapter's references to other chapters stay unresolved */ }
    return state.labelsPath;
  }

  saveCached(projectRoot, rootPath, paperKey, result) {
    try {
      const file = this.cacheFile(projectRoot, rootPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ paperKey, sheets: result.sheets, seeds: [...result.seeds] }));
    } catch { /* the next session probes again */ }
  }

  // The Build's auxiliary files make the probe break pages as the Build did.
  prepareWorkDir(rootPath, units) {
    const rootDir = path.dirname(rootPath);
    const jobName = path.basename(rootPath).replace(/\.tex$/i, "");
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-live-window-"));
    for (const name of fs.readdirSync(rootDir)) {
      if (!name.startsWith(`${jobName}.`) || NOT_AUXILIARY_RE.test(name)) continue;
      try { fs.copyFileSync(path.join(rootDir, name), path.join(workDir, name)); } catch { /* not a file */ }
    }
    for (const unit of units) {
      const relative = path.relative(rootDir, unit.filePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      fs.mkdirSync(path.join(workDir, path.dirname(relative)), { recursive: true });
      if (unit.command !== "include") continue;
      const aux = relative.replace(/\.tex$/i, ".aux");
      try { fs.copyFileSync(path.join(rootDir, aux), path.join(workDir, aux)); } catch { /* never built */ }
    }
    return workDir;
  }

  startProbe({ rootPath, projectRoot, units, paper, paperKey, state }) {
    const abort = new AbortController();
    state.abort = abort;
    state.probing = (async () => {
      let workDir = null;
      try {
        workDir = this.prepareWorkDir(rootPath, units);
        const record = await this.runProbe({ rootPath, workDir, env: this.env(), signal: abort.signal });
        // Only a probe that broke pages as the Build did knows the Build's page numbers.
        const result = seedsFromRecord(record, units, paper, path.dirname(rootPath));
        if (this.states.get(rootPath) === state && !abort.signal.aborted) {
          state.paperKey = paperKey;
          state.seeds = result.seeds;
          state.sheets = result.sheets;
          this.saveCached(projectRoot, rootPath, paperKey, result);
        }
      } catch (error) {
        if (!abort.signal.aborted) console.warn("[live-window] probe failed:", error?.message ?? error);
        if (this.states.get(rootPath) === state && !abort.signal.aborted) {
          state.paperKey = paperKey;
          state.seeds ??= new Map();
        }
      } finally {
        state.probing = null;
        state.abort = null;
        if (workDir) fs.rm(workDir, { recursive: true, force: true }, () => {});
      }
    })();
  }

  /**
   * How to keep Live for a document past the limit.
   * @returns null when it cannot be windowed, { pending: true } while its
   * state is being read, or { overlays, unitPath } for the engine.
   */
  async plan({ rootPath, rootText, projectRoot, activePath = null, paper, mayProbe = true }) {
    if (!rootPath || !projectRoot || typeof rootText !== "string" || !paper?.pages) return null;
    const units = rootUnits(rootPath, rootText);
    if (!units.length) return null;
    const generation = this.generation;
    let auxStat;
    try { auxStat = await this.stat(rootPath.replace(/\.tex$/i, ".aux")); } catch { return null; }
    if (generation !== this.generation) return null;
    const paperKey = `${paper.mtimeMs}:${paper.size}:${paper.pages}:${auxStat.mtimeMs}`;
    let state = this.states.get(rootPath);
    if (!state) {
      state = { paperKey: null, seeds: null, sheets: null, probing: null, abort: null, unitPath: null };
      this.states.set(rootPath, state);
    }
    if (state.paperKey !== paperKey && !state.probing) {
      const cached = this.loadCached(projectRoot, rootPath, paperKey);
      // what the Build itself wrote down, when it carried the record
      const record = cached ? null : loadBuildRecord(projectRoot, rootPath, paper);
      const built = record ? seedsFromRecord(record, units, paper, path.dirname(rootPath)) : null;
      if (cached) Object.assign(state, { paperKey, ...cached });
      else if (built?.seeds.size) {
        Object.assign(state, { paperKey, ...built });
        this.saveCached(projectRoot, rootPath, paperKey, built);
      } else if (mayProbe) this.startProbe({ rootPath, projectRoot, units, paper, paperKey, state });
    }
    // A newer Build's state is still being read: the chapter keeps the
    // numbers of the Build before it until then.
    if (!state.seeds) return state.probing || state.paperKey !== paperKey ? { pending: true } : null;
    let index = activePath ? unitIndexOf(path.resolve(activePath), units, this.readText, path.dirname(rootPath)) : -1;
    if (index < 0) index = units.findIndex((unit) => unit.filePath === state.unitPath);
    if (index < 0) index = 0;
    // Asked on every keystroke: the same chapter of the same root with the
    // same state is the same set of files.
    const made = state.made;
    const overlays = made && made.rootText === rootText && made.index === index && made.seeds === state.seeds
      ? made.overlays
      : windowOverlays({ units, index, seeds: state.seeds, readText: this.readText,
        labelsPath: this.labelsFile(projectRoot, rootPath, state) });
    if (!overlays) return state.probing ? { pending: true } : null;
    state.made = { rootText, index, seeds: state.seeds, overlays };
    state.unitPath = units[index].filePath;
    return { overlays, rootText: windowRootText(rootText), unitPath: state.unitPath, pending: Boolean(state.probing),
      // the Build paper's sheets around the chapter, while the state in hand is that paper's
      outer: state.paperKey === paperKey ? outerSheets({ units, index, seeds: state.seeds, paper, rootPath }) : null };
  }

  stop() {
    this.generation += 1;
    for (const state of this.states.values()) state.abort?.abort();
    this.states.clear();
  }
}

module.exports = {
  LivePreviewWindow, rootUnits, hollowUnit, seedText, parseProbeRecord, windowOverlays, unitIndexOf, windowRootText, outerSheets, buildLabels, PROBE_TEX,
  buildRecordArgs, wantsBuildRecord, saveBuildRecord, loadBuildRecord, PROBE_RECORD_EXT,
};
