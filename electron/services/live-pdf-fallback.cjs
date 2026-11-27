"use strict";

const fs = require("node:fs/promises");
const { rmSync } = require("node:fs");
const { Readable } = require("node:stream");
const { isUtf8 } = require("node:buffer");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");
const { lookupEditTarget, emptyBodyInsertion, unfinishedFormula } = require("./live-pdf-target.cjs");
const { updatePrintedText } = require("./live-pdf-prose.cjs");
const { isBuildEngine } = require("./agent-build-context.cjs");
const { BuildService } = require("./build.cjs");
const { extendTexlivePath, findTexCommand } = require("./texlive-paths.cjs");

const { captureEditSources, releaseSources, INLINE_EDIT_BYTES } = require("./live-pdf-edit-sources.cjs");
const { readReferenceFiles, referencesChanged } = require("./live-pdf-references.cjs");

const { updateBibliography } = require("./live-pdf-bibliography.cjs");
const { LivePdfInputs, recordedInputs } = require("./live-pdf-inputs.cjs");
const { prepareImageBounds, resolveImageBounds } = require("./live-pdf-image-bounds.cjs");

const { readFileUpTo } = require("./bounded-file-read.cjs");

const querySyncTeX = promisify(execFile);

const SUPERSEDED_IDLE_MS = 30_000;
const INLINE_PDF_BYTES = 16 * 1024 * 1024;
const { previewSearchPaths, recordedProjectPath, SOURCE_EXTENSION } = require("./live-pdf-paths.cjs");

// TeX reads these terminal tokens only if the root (and every included
// file) returned without ending the job. The manuscript and its SyncTeX
// offsets stay byte-for-byte intact. Only close an already-started LaTeX
// document at the outer level; leave open groups and conditionals to TeX.
function finishPreviewDocument(marker) {
  return [
    String.raw`\begingroup\def\TeXPreviewFinish{\endgroup}`,
    String.raw`\ifnum\currentiflevel=1 \ifnum\currentgrouplevel=1 `,
    String.raw`\expandafter\ifx\csname @onlypreamble\endcsname\document`,
    String.raw`\def\TeXPreviewFinish{\endgroup\immediate\write16{${marker}}\end{document}}`,
    String.raw`\fi\fi\fi\TeXPreviewFinish`,
  ].join("");
}

// The first line is TeX input: a percent sign starts a comment, a tilde
// expands, and two carets can name an entirely different file. Pass the
// actual stem through the engine's jobname option to obtain literal tokens.
// For a leading tilde, explicitly use the current staging directory for
// output. TeX can reopen ./~name.aux there without changing \jobname.
function previewRootInput(filename, beforeInput = "") {
  if (!beforeInput && !/[%~^{}\\]/.test(filename)) return [`./${filename}`];
  return [...(filename.startsWith("~") ? ["-output-directory=."] : []),
    "-jobname=" + path.parse(filename).name, beforeInput + String.raw`\input{./\jobname${path.extname(filename)}}`];
}

// Only try this after an ordinary run finished with no pages. Let the
// same class ship an empty sheet at its own size. \jobname expands to
// character tokens, including spaces or TeX metacharacters in the name.
function blankPreviewInput(filename, marker) {
  return previewRootInput(filename,
    String.raw`\ifdefined\ReadonlyShipoutCounter\ifdefined\CurrentFilePath` +
      String.raw`\AddToHook{begindocument/end}{\immediate\write16{${marker}B:\the\inputlineno:\CurrentFilePathUsed/\CurrentFileUsed}}\fi` +
      String.raw`\AddToHook{enddocument/afterlastpage}{` +
      String.raw`\ifnum\ReadonlyShipoutCounter=0 \immediate\write16{${marker}}\thispagestyle{empty}\indent\strut` +
      String.raw`\ifdefined\pdfsavepos\pdfsavepos\write16{${marker}:\the\pdflastxpos,\the\pdflastypos,\number\dimexpr\csname f@size\endcsname pt\relax}` +
      String.raw`\else\ifdefined\savepos\savepos\write16{${marker}:\the\lastxpos,\the\lastypos,\number\dimexpr\csname f@size\endcsname pt\relax}\fi\fi` +
      String.raw`\par\clearpage\fi}\fi`);
}

async function removeCompileDirectory(directory) {
  if (!directory) return;
  try {
    await fs.rm(directory, { recursive: true, force: true });
  } catch {
    // A temporary lock must not discard a successful compile or hold up the next one.
    void fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
      .catch(error => console.warn("[live-preview] Removing compile directory:", error.message));
  }
}

// Large editor buffers already arrived through IPC. Stage them incrementally
// so encoding a second full-size UTF-8 copy cannot stall the main process.
async function writeOverlay(file, text) {
  if (text.length <= 512 * 1024) return fs.writeFile(file, text, "utf8");
  const handle = await fs.open(file, "w");
  try {
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 512 * 1024, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      await handle.writeFile(text.slice(start, end), "utf8");
      start = end;
    }
  } finally {
    await handle.close();
  }
}

// All speculative bytes belong to this job. Return the original source to
// the edit snapshot on success, or restore normal path resolution on a miss.
async function stageMathProjection({ root, rootFile, temp, files, workspace, marker, current }, file, changedFormula) {
  const relative = path.relative(root, file);
  const destination = path.join(temp, relative);
  const fromDisk = !files.has(relative);
  let input = destination;
  if (fromDisk) {
    try { input = workspace.resolvePath(relative); } catch { return null; }
  }
  const bytes = await readFileUpTo(input, INLINE_EDIT_BYTES).catch(() => null);
  if (!bytes || !isUtf8(bytes) || !current()) return null;
  const source = bytes.toString("utf8");
  const formula = await unfinishedFormula(source, file, changedFormula, file !== rootFile);
  if (!formula || !current()) return null;
  const at = formula.region.contentEnd;
  // Preserve TeX's input line numbers, including those after the chapter.
  // Require the run to reach the insertion in math mode before using its PDF.
  const close = String.raw`\ifmmode\immediate\write16{${marker}}\fi` + formula.closer;
  const projected = source.slice(0, at) + close + source.slice(at);
  if (fromDisk) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // A generated file from the first pass must retain its contents.
    try { await fs.writeFile(destination, projected, { flag: "wx" }); }
    catch (error) { if (error.code === "EEXIST") return null; throw error; }
  } else await writeOverlay(destination, projected);
  return { formula, async restore(keepForEdit) {
    if (fromDisk && !keepForEdit) await fs.unlink(destination);
    else await writeOverlay(destination, source);
    if (fromDisk && keepForEdit) files.set(relative, null);
  } };
}

async function mathInputFiles({ root, rootFile, temp, cwd, aliases, recorder, issue, transcript, activePath }) {
  const map = { root, temp, aliases, realRoot: await fs.realpath(root), realTemp: await fs.realpath(temp) };
  const inputs = new Set([rootFile]);
  for (const recorded of (await recordedInputs(recorder, cwd)).reverse()) {
    if (!/\.(?:tex|ltx)$/i.test(recorded)) continue;
    const file = recordedProjectPath(map, recorded);
    if (file) inputs.add(file);
  }
  const ordered = new Set();
  const prefer = file => { if (inputs.has(file)) ordered.add(file); };
  const origin = issue?.path && recordedProjectPath(map, path.resolve(cwd, issue.path));
  // TeX diagnoses a runaway AMS body on the parent's input line after
  // returning from the child. Prefer the actual include named on that line.
  for (const match of transcript.matchAll(/^\s*l\.(\d+)\s+[^\r\n]*?\\(?:input|include)\s*\{([^{}\\%\r\n]+)\}/gm)) {
    if (Number(match[1]) !== issue?.line) continue;
    const name = path.extname(match[2]) ? match[2] : match[2] + ".tex";
    for (const dir of [origin && path.dirname(origin), path.dirname(rootFile), root]) {
      if (dir) prefer(path.resolve(dir, name));
    }
  }
  if (typeof activePath === "string") prefer(path.resolve(root, activePath));
  prefer(origin);
  for (const file of inputs) ordered.add(file);
  return ordered;
}

class LivePdfFallback {
  constructor(workspace, onInputsChanged = () => {}, onPaperEditing = () => {}) {
    this.inputs = new LivePdfInputs(onInputsChanged);
    this.onInputsChanged = onInputsChanged;
    this.workspace = workspace;
    this.editSessions = new Map();
    this.editEpoch = 0;
    this.onPaperEditing = onPaperEditing;
    this.clicks = new Map();
    this.compiler = new BuildService();
    this.running = null;
    this.generation = 0;
    this.latest = null;
    this.papers = new Map();
    this.viewerPapers = new Map();
    this.documentId = 0;
    this.references = null;
    this.imageBounds = null;
  }

  setProjectFiles(root, paths) {
    // A clean chapter is read from the project via TEXINPUTS, but \include
    // writes its .aux relative to the isolated compiler working directory.
    this.inputs.treeUpdated(root, paths ?? []);
    this.directoryRoot = root;
    this.sourceDirectories = new Set();
    for (const file of paths ?? []) {
      if (!/\.tex$/i.test(file)) continue;
      const dir = path.dirname(path.normalize(file));
      if (dir !== "." && !path.isAbsolute(dir) && !dir.split(path.sep).includes("..")) {
        this.sourceDirectories.add(dir);
      }
    }
  }

  supersede(requestId, abandon) {
    const job = this.running;
    if (!job || !requestId || job.id !== requestId) return;
    if (abandon) {
      this.generation += 1;
      this.compiler.cancelCurrentRun();
      return;
    }
    if (job.timer) return;
    // A large document may need minutes to typeset. Leave a progressing
    // run alone. A quiet, obsolete run must yield to the corrected source.
    const whenQuiet = () => {
      if (this.running !== job) return;
      const remaining = job.progressAt + SUPERSEDED_IDLE_MS - Date.now();
      if (remaining <= 0) this.compiler.cancelCurrentRun();
      else {
        job.timer = setTimeout(whenQuiet, remaining);
        job.timer.unref();
      }
    };
    whenQuiet();
  }

  // Each viewer can be reading one revision while another is still on screen.
  // Retain their SyncTeX and streamed files, without retaining old inline PDFs.
  setViewerPapers(owner, displayed, loading) {
    const revisions = [displayed, loading].filter(id => this.papers.has(id));
    if (revisions.length) this.viewerPapers.set(owner, revisions);
    else this.viewerPapers.delete(owner);
    this.prunePapers();
    return this.papers.get(displayed)?.emptyCaret ?? null;
  }

  prunePapers() {
    const keep = new Set([this.latest?.generation]);
    for (const revisions of this.viewerPapers.values()) for (const id of revisions) keep.add(id);
    for (const [generation, paper] of this.papers) {
      if (keep.has(generation)) continue;
      this.papers.delete(generation);
      releaseSources(paper);
      if (paper.streamFile) {
        try { rmSync(paper.streamFile, { force: true }); }
        catch {
          // A Windows reader or scanner may still have the superseded PDF open.
          void fs.rm(paper.streamFile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
            .catch(failure => console.warn("[live-preview] Removing superseded PDF:", failure.message));
        }
      }
    }
  }

  resetPapers() {
    this.documentId++;
    this.rebuildingMissingPaper = false;
    this.editSessions.clear();
    this.editEpoch++;
    this.latest = null;
    this.viewerPapers.clear();
    this.prunePapers();
  }

  async streamPaper(url) {
    const paper = [...this.papers.values()].find(entry => entry.url === url);
    if (!paper?.streamFile || paper.root !== this.workspace.getRootPath()) return new Response(null, { status: 404 });
    let handle;
    try {
      handle = await fs.open(paper.streamFile, "r");
    } catch (error) {
      // A cleanup may have removed the current stream. Let brief locks or
      // renames heal first, and regenerate a lost paper once per outage.
      if (error.code === "ENOENT" && this.latest?.generation === paper.generation) {
        paper.firstMissingAt ??= Date.now();
        if (!this.rebuildingMissingPaper && Date.now() - paper.firstMissingAt >= 1500) {
          this.rebuildingMissingPaper = true;
          this.onInputsChanged(paper.root, paper.rootFile);
        }
      }
      return new Response(null, { status: 503 });
    }
    if (this.papers.get(paper.generation) !== paper || paper.root !== this.workspace.getRootPath()) {
      await handle.close();
      return new Response(null, { status: 410 });
    }
    paper.firstMissingAt = null;
    if (this.latest?.generation === paper.generation) this.rebuildingMissingPaper = false;
    return new Response(Readable.toWeb(handle.createReadStream()), { headers: {
      "Content-Type": "application/pdf", "Content-Length": String(paper.size),
      "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*",
    } });
  }

  stop() {
    this.inputs.clear();
    for (const controller of this.clicks.values()) controller.abort();
    this.clicks.clear();
    this.generation += 1;
    this.resetPapers();
    this.references = null;
    this.imageBounds = null;
    if (this.compiler.isBuilding) this.compiler.cancelCurrentRun();
  }

  async reverse(service, { generation, pdfPath, page, x, y, printed, occurrences }, editOwner = null) {
    if (!Number.isSafeInteger(generation) || !Number.isInteger(page) || page <= 0 ||
        !Number.isFinite(x) || !Number.isFinite(y) || typeof pdfPath !== "string") return { ok: false };
    const paper = this.papers.get(generation);
    const map = paper?.sourceMap;
    const documentId = this.documentId;
    const matchesPaper = () => map && this.documentId === documentId &&
      paper.pdfPath === path.resolve(map.root, pdfPath) && this.workspace.getRootPath() === map.root;
    if (!matchesPaper()) return { ok: false, stale: true };
    if (paper.emptyInsertion && page === 1) {
      const target = paper.emptyInsertion;
      if (editOwner === null) return { ok: true, path: target.file, ...target.start };
      return this.beginEditSession(paper, target, editOwner);
    }
    const tool = service.findSynctex();
    this.clicks.get(editOwner)?.abort();
    const controller = new AbortController();
    this.clicks.set(editOwner, controller);
    paper.readers++;
    let dir;
    try {
      let syncFile = map.sync;
      if (typeof syncFile !== "string") {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-live-click-"));
        syncFile = path.join(dir, "paper.synctex.gz");
        await fs.writeFile(syncFile, map.sync);
      }
      if (!matchesPaper()) return { ok: false, stale: true };
      const point = { page, x, y };
      const ink = typeof printed === "string" && printed.length <= 8192 ? printed : null;
      const lookup = (file, hit) => lookupEditTarget(map, file, hit, point, syncFile, ink,
        occurrences, controller.signal, editOwner === null);
      // A long book needs only the clicked sheet. This path also works on
      // TeX installations that write SyncTeX but do not ship its CLI.
      let target = (!tool || typeof map.sync === "string") ? await lookup(null, null) : null;
      if (!target && tool && matchesPaper() && !controller.signal.aborted) {
        const result = await querySyncTeX(tool, ["edit", "-o", `${page}:${x}:${y}:paper.pdf`], {
          cwd: path.dirname(syncFile), env: { ...process.env, PATH: extendTexlivePath(process.env.PATH) },
          windowsHide: true, signal: controller.signal, timeout: 5000, maxBuffer: 512 * 1024,
        });
        if (!matchesPaper()) return { ok: false, stale: true };
        for (const hit of service.parseReverseResults(result.stdout, map.cwd)) {
          const file = recordedProjectPath(map, hit.path);
          if (!file) continue;
          if (editOwner === null) return { ok: true, path: file, line: hit.line, column: hit.column };
          if (!/\.(?:tex|ltx)$/i.test(file)) continue;
          target = await lookup(file, hit);
          if (target || controller.signal.aborted) break;
        }
      }
      if (controller.signal.aborted || !matchesPaper()) return { ok: false, stale: true };
      if (!target) return { ok: false, error: "SyncTeX could not locate this point in the preview source." };
      if (editOwner === null) return target;
      if (target.needsOccurrences) return { ok: false, needsOccurrences: true };
      return this.beginEditSession(paper, target, editOwner);
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, stale: true };
      throw error;
    } finally {
      paper.readers--;
      if (!this.papers.has(generation)) releaseSources(paper);
      if (this.clicks.get(editOwner) === controller) this.clicks.delete(editOwner);
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  }

  paperEditingState() {
    return { editEpoch: this.editEpoch, editingPaper: this.editSessions.size > 0 };
  }

  notifyPaperEditing() {
    this.editEpoch++;
    if (this.latest) this.onPaperEditing({ workspaceRoot: this.latest.root, rootFile: this.latest.rootFile, ...this.paperEditingState() });
  }

  releaseViewer(owner) {
    this.clicks.get(owner)?.abort();
    this.setViewerPapers(owner, null, null);
    const size = this.editSessions.size;
    for (const [id, session] of this.editSessions) if (session.owner === owner) this.editSessions.delete(id);
    if (size !== this.editSessions.size) this.notifyPaperEditing();
  }

  beginEditSession(paper, target, owner) {
    const sessionId = randomUUID();
    const { visibleValue, offsets, insertion, alignment, ...anchor } = target;
    const originalText = offsets ? { raw: anchor.baseValue, visible: visibleValue, offsets } : null;
    this.editSessions.set(sessionId, { target: anchor, originalText, text: originalText,
      insertion, owner, root: paper.root, pdfPath: paper.pdfPath });
    while (this.editSessions.size > 4) this.editSessions.delete(this.editSessions.keys().next().value);
    this.notifyPaperEditing();
    return { ok: true, sessionId, kind: target.kind, value: visibleValue ?? target.baseValue, box: target.box, wrap: target.wrap, alignment };
  }

  endPaperEdit(owner, sessionId) {
    if (this.editSessions.get(sessionId)?.owner !== owner) return;
    this.editSessions.delete(sessionId);
    this.notifyPaperEditing();
  }

  editPaper(owner, { sessionId, value, finish, cancel }, send) {
    const session = this.editSessions.get(sessionId);
    if (!session || session.owner !== owner) return { ok: false };
    const ending = finish || cancel;
    if (session.root !== this.workspace.getRootPath() || session.pdfPath !== this.latest?.pdfPath ||
        typeof value !== "string" || value.length > 262144) {
      if (ending) this.endPaperEdit(owner, sessionId);
      return { ok: false };
    }
    if (!session.changed && (cancel || value === (session.originalText?.visible ?? session.target.baseValue))) {
      if (ending) this.endPaperEdit(owner, sessionId);
      return { ok: true };
    }
    session.changed = true;
    if (session.text && !cancel) {
      session.text = value === session.originalText.visible ? session.originalText : updatePrintedText(session.text, value);
    }
    let replacement = session.text?.raw ?? value;
    if (session.insertion && replacement) replacement = session.insertion.prefix + replacement + session.insertion.suffix;
    send("pdf:liveEdit", { ...session.target, sessionId, replacement, finish: finish === true, cancel: cancel === true });
    // Subsequent messages use the source anchor established by the first edit.
    delete session.target.sourceText;
    if (ending) this.endPaperEdit(owner, sessionId);
    return { ok: true };
  }

  async compile(payload) {
    const root = this.workspace.getRootPath();
    if (!root || payload?.workspaceRoot !== root ||
        typeof payload.rootFile !== "string" || !/\.tex$/i.test(payload.rootFile)) {
      return { ok: false };
    }
    if (this.compiler.isBuilding) return { ok: false, code: "TDOM_PREVIEW_BUSY" };
    const rootFile = this.workspace.resolvePath(payload.rootFile);
    const engine = payload.engine ?? "lualatex";
    if (!isBuildEngine(engine)) return { ok: false };
    const tex = findTexCommand(engine);
    const converter = engine === "uplatex" ? findTexCommand("dvipdfmx") : null;
    if (!tex || (engine === "uplatex" && !converter)) {
      return { ok: false, code: "TDOM_TEX_COMMAND_MISSING", command: tex ? "dvipdfmx" : engine };
    }
    this.compiler.isBuilding = true;
    const generation = ++this.generation;
    const current = () => this.generation === generation && this.workspace.getRootPath() === root;
    const started = Date.now();
    const job = { id: payload.requestId, progressAt: started, timer: null };
    this.running = job;
    const attempt = this.inputs.begin(root, payload.rootFile);
    let sandbox, watched, editSourceSnapshot;
    try {
      this.compiler.cancelRequested = false;
      const relativeRoot = path.relative(root, rootFile);
      const files = new Map([[relativeRoot, null]]);
      for (const item of Array.isArray(payload.buffers) ? payload.buffers : []) {
        if (typeof item?.path !== "string" || !SOURCE_EXTENSION.test(item.path) || typeof item.text !== "string") continue;
        files.set(path.relative(root, this.workspace.resolvePath(item.path)), item.text);
        if (files.size > 500) return { ok: false, code: "TDOM_PREVIEW_SOURCE_LIMIT" };
      }
      sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-live-pdf-"));
      const temp = path.join(sandbox, "stage");
      if (this.directoryRoot === root) {
        for (const dir of this.sourceDirectories) {
          if (!current()) return { ok: false };
          await fs.mkdir(path.join(temp, dir), { recursive: true });
        }
      }
      for (const [relative, text] of files) {
        if (!current()) return { ok: false };
        const destination = path.join(temp, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        if (text === null) {
          const stat = await fs.stat(rootFile);
          // A saved manuscript is copied on disk and consumes no IPC buffer budget.
          if (!stat.isFile()) return { ok: false, code: "TDOM_PREVIEW_IO_ERROR" };
          await fs.copyFile(rootFile, destination);
        } else {
          await writeOverlay(destination, text);
        }
      }
      const cwd = path.dirname(path.join(temp, relativeRoot));
      const { entries, aliases } = await previewSearchPaths(sandbox, temp, cwd, root, rootFile);
      const env = { ...process.env, PATH: extendTexlivePath(process.env.PATH) };
      for (const key of ["TEXINPUTS", "LUAINPUTS", "BIBINPUTS", "BSTINPUTS", "TEXPICTS"]) {
        env[key] = [...entries, env[key] || ""].join(path.delimiter);
      }
      const held = this.references?.root === root && this.references.rootFile === rootFile && this.references.engine === engine
        ? this.references : null;
      let previous = held?.files;
      if (previous) {
        for (const [name, contents] of previous) {
          if (!current()) return { ok: false };
          const file = path.join(temp, name);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, contents);
        }
      }
      const filename = path.basename(rootFile);
      const bbl = path.join(cwd, filename.replace(/\.tex$/i, ".bbl"));
      let previousBibliography = held?.bibliography;
      if (previousBibliography?.bytes) await fs.writeFile(bbl, previousBibliography.bytes);
      let bibliography;
      const recorder = path.join(cwd, filename.replace(/\.tex$/i, ".fls"));
      watched = { recorder, aliases, cwd, stageRoot: temp, rootPath: rootFile, buffers: files, bibliographyFiles: new Set(), complete: false };
      const run = (program, args) => {
        job.progressAt = Date.now();
        const result = this.compiler.runProcess(program, args, cwd, env);
        this.compiler.activeProcess?.stdout?.on("data", () => { job.progressAt = Date.now(); });
        return result;
      };
      const priorBounds = this.imageBounds?.root === root && this.imageBounds.rootFile === rootFile ? this.imageBounds.files : null;
      const bounds = converter ? await prepareImageBounds({ root, temp, cwd, env, run, previous: priorBounds }) : null;
      let boundsPasses = 0;
      let references;
      let manuscriptError, missingDocumentEnd, emptyDocument, emptyCaret, bodyLine;
      let requestBlankSheet = false;
      const blankMarker = "tex64-blank-" + randomUUID().slice(0, 18);
      const endMarker = "tex64-preview-end-" + randomUUID();
      const previewEnd = finishPreviewDocument(endMarker);
      const printedBlankMarker = new RegExp("^" + blankMarker + "\\r?$", "m");
      const printedEndMarker = new RegExp("^" + endMarker + "\\r?$", "m");
      const mathMarker = "tex64-math-" + randomUUID();
      const printedMathMarker = new RegExp("^" + mathMarker + "\\r?$", "m");
      const inspectedMath = new Set();
      let projection, rawFailure;
      const tryMath = async (file, changedFormula) => {
        if (inspectedMath.has(file) || !current()) return false;
        inspectedMath.add(file);
        projection = await stageMathProjection({ root, rootFile, temp, files, workspace: this.workspace,
          marker: mathMarker, current }, file, changedFormula);
        return Boolean(projection);
      };
      let candidates;
      const nextMath = async () => {
        if (candidates) for (const file of candidates) {
          if (!current()) break;
          if (await tryMath(file)) return true;
        }
        return false;
      };
      // Once the user is typing an unfinished formula, avoid repeating a
      // failed ordinary run for each following edit of that same root.
      const priorPaper = this.papers.get(this.latest?.generation)?.sourceMap;
      const lastFormula = priorPaper?.unfinished;
      const buffer = files.get(relativeRoot);
      if (lastFormula?.file === rootFile && priorPaper.engine === engine && typeof buffer === "string") {
        const priorSource = priorPaper.files.get(relativeRoot);
        const { contentStart, contentEnd } = lastFormula.region;
        if (typeof priorSource === "string" && buffer.length >= contentStart + priorSource.length - contentEnd &&
            buffer.startsWith(priorSource.slice(0, contentStart)) && buffer.endsWith(priorSource.slice(contentEnd))) {
          await tryMath(rootFile, { start: lastFormula.region.start, end: buffer.length - (priorSource.length - contentEnd) });
        }
      }
      // Native TeX already stopped on the retained paper's current revision.
      if (payload.recoverIncompleteMath === true) await tryMath(rootFile);
      for (let pass = 0; pass < 3;) {
        if (!current()) return { ok: false };
        const result = await run(tex, [
          "-no-shell-escape", "-synctex=1", "-recorder", "-file-line-error", "-interaction=nonstopmode",
          ...(requestBlankSheet ? blankPreviewInput(filename, blankMarker) : previewRootInput(filename)), previewEnd,
        ]);
        if (!current()) return { ok: false };
        if (result.timedOut) return { ok: false, code: "TDOM_PREVIEW_TIMEOUT" };
        if (result.cleanupFailed) return { ok: false, code: "TDOM_PREVIEW_IO_ERROR" };
        if (result.cancelled) return { ok: false };
        if (projection && (result.status !== 0 || !printedMathMarker.test(result.output))) {
          // A literal-looking opener can also be produced by macro code.
          // Restore ordinary TeX diagnostics and any paper it could make.
          await projection.restore(false);
          projection = null;
          if (!await nextMath() && rawFailure) return rawFailure;
          previous = await readReferenceFiles(temp, cwd, recorder, previous);
          continue;
        }
        if (projection) delete watched.transcript;
        manuscriptError = null;
        missingDocumentEnd = printedEndMarker.test(result.output);
        emptyDocument = requestBlankSheet && printedBlankMarker.test(result.output);
        if (emptyDocument) {
          const at = new RegExp("^" + blankMarker + ":(-?\\d+),(-?\\d+),(\\d+)\\r?$", "m").exec(result.output);
          const begin = new RegExp("^" + blankMarker + "B:(\\d+):([^\\r\\n]+)", "m").exec(result.output);
          bodyLine = begin && path.resolve(cwd, begin[2]) === path.join(cwd, filename) ? Number(begin[1]) : null;
          const spToBp = 72 / 72.27 / 65536;
          if (at && Number(at[3]) > 0) emptyCaret = { x: Number(at[1]) * spToBp, y: Number(at[2]) * spToBp, em: Number(at[3]) * spToBp };
        }
        if (result.status !== 0) {
          // A class/package change can invalidate a formerly readable .aux
          // or .toc. Discard that seed and let TeX regenerate it once.
          const log = result.output.replace(/\r?\n/g, "");
          const badSeed = /\.(?:aux|toc|out|lof|lot|loa|lol|nav|snm|thm|bbl):\d+:/i.test(log) ||
            (previousBibliography?.bytes && /\.bbl['’]? (?:not created by biblatex|is wrong format)/i.test(log));
          if (pass === 0 && (previous?.size || previousBibliography?.bytes) && badSeed) {
            const written = await readReferenceFiles(temp, cwd, recorder, previous);
            for (const name of new Set([...(previous?.keys() ?? []), ...(written?.keys() ?? [])])) {
              await fs.rm(path.join(temp, name), { force: true });
            }
            if (previousBibliography?.bytes) await fs.rm(bbl, { force: true });
            previousBibliography = null;
            previous = null;
            continue;
          }
          watched.transcript = result.output;
          const issue = this.compiler.parseIssues(result.output, cwd).find(item => item.severity === "error");
          // In nonstop mode TeX can report a source error and still finish
          // the entire document. An emergency stop can also write a PDF,
          // but it contains only the pages before the error.
          const finished = result.status === 1 && /^Output written on /m.test(result.output) &&
            !/Emergency stop\.|Fatal error occurred|TeX capacity exceeded|That makes 100 errors/i.test(result.output);
          // TeX may discard an unterminated macro argument or conditional
          // at EOF and then execute the terminal tokens. That dropped text
          // is a fatal input error, even if other pages were written.
          const discardedInput = missingDocumentEnd && /Runaway (?:argument|definition|text)|File ended while scanning|Incomplete \\if/i.test(result.output);
          const failure = { ok: false, code: "TDOM_TEX_ERROR", error: issue?.message };
          const incomplete = /Emergency stop\.|Missing \$ inserted|File ended while scanning|ended by \\end\{document\}/i.test(log);
          if (!candidates && incomplete) {
            candidates = (await mathInputFiles({ root, rootFile, temp, cwd, aliases, recorder, issue,
              transcript: result.output, activePath: payload.activePath })).values();
            if (await nextMath()) {
              // The failed pass may have truncated a label from the good
              // seed. Compare the recovered pass to what it actually read.
              previous = await readReferenceFiles(temp, cwd, recorder, previous);
              if (!finished || discardedInput) rawFailure = failure;
              continue;
            }
          }
          if (!finished || discardedInput) return failure;
          manuscriptError = issue?.message || "TeX reported an error while typesetting this preview.";
        }
        if (/^(?:warning\s+\(pdf backend\):\s*)?no pages of output\.\s*$/im.test(result.output) && !/^Output written on /m.test(result.output)) {
          if (!requestBlankSheet && !manuscriptError) {
            requestBlankSheet = true;
            continue;
          }
          return { ok: false, code: "TDOM_PREVIEW_NO_PAGES" };
        }
        if (bounds) {
          const boxes = await resolveImageBounds({ bounds, root, temp, cwd, recorder, searchDirs: entries.map(entry => path.resolve(cwd, entry)), run, current });
          if (!current()) return { ok: false };
          if (boxes.missing) return { ok: false, code: "TDOM_TEX_COMMAND_MISSING", command: boxes.missing };
          if (boxes.error) return { ok: false, code: "TDOM_TEX_ERROR", error: boxes.error };
          if (!boxes.ready) {
            if (++boundsPasses > 3) return { ok: false, code: "TDOM_TEX_ERROR", error: "The figure dimensions changed during typesetting." };
            continue;
          }
        }
        if (manuscriptError || emptyDocument) break;
        pass++;
        references = await readReferenceFiles(temp, cwd, recorder, previous);
        if (pass === 1) {
          bibliography = await updateBibliography({ root, rootFile, temp, cwd, engine, references, buffers: files,
            previous: previousBibliography, run, current, inputs: watched.bibliographyFiles, firstPaper: !held });
          if (!current()) return { ok: false };
          if (bibliography?.pending) break;
          if (!bibliography && previousBibliography?.bytes) {
            await fs.rm(bbl, { force: true });
            previous = references;
            continue;
          }
          if (bibliography?.staged || (bibliography?.bytes &&
              (!previousBibliography?.bytes || !bibliography.bytes.equals(previousBibliography.bytes)))) {
            previous = references;
            continue;
          }
          // A failed tool can leave a partial .bbl in the staging directory.
          if (bibliography?.warning) {
            if (previousBibliography?.bytes) {
              bibliography = { ...bibliography, bytes: previousBibliography.bytes };
              await fs.writeFile(bbl, bibliography.bytes);
            } else await fs.rm(bbl, { force: true });
          }
        }
        if (!referencesChanged(previous, references, result.output)) break;
        previous = references;
      }
      const output = path.join(cwd, path.basename(rootFile).replace(/\.tex$/i, ".pdf"));
      if (converter) {
        // upLaTeX writes DVI on each pass. Convert the settled pass once.
        if (!current()) return { ok: false };
        const stem = "./" + filename.slice(0, -4);
        const result = await run(converter, ["-o", stem + ".pdf", stem + ".dvi"]);
        if (!current()) return { ok: false };
        if (result.cleanupFailed) return { ok: false, code: "TDOM_PREVIEW_IO_ERROR" };
        if (result.cancelled) return { ok: false };
        if (result.timedOut) return { ok: false, code: "TDOM_PREVIEW_TIMEOUT" };
        if (result.status !== 0) return { ok: false, code: "TDOM_TEX_ERROR", error: result.output.trim().split(/\r?\n/).find(line => /fatal|error/i.test(line)) };
      }
      const stat = await fs.lstat(output);
      if (!stat.isFile() || !stat.size) return { ok: false, code: "TDOM_PREVIEW_IO_ERROR" };
      const unfinished = projection?.formula;
      if (projection) await projection.restore(true);
      editSourceSnapshot = await captureEditSources(files, temp, output.replace(/\.pdf$/i, ".synctex.gz"));
      const sync = editSourceSnapshot?.sync;
      const emptyInsertion = emptyDocument && emptyCaret && bodyLine && editSourceSnapshot
        ? await emptyBodyInsertion(editSourceSnapshot.files.get(relativeRoot), rootFile, bodyLine) : null;
      const realTemp = sync ? await fs.realpath(temp).catch(() => temp) : null;
      const realRoot = sync ? await fs.realpath(root).catch(() => root) : null;
      if (!current()) return { ok: false };
      const streamId = stat.size > INLINE_PDF_BYTES ? randomUUID() : null;
      const streamFile = streamId ? path.join(os.tmpdir(), "tex64-live-paper-" + streamId + ".pdf") : null;
      const url = streamId ? "tex64-pdf://preview/" + streamId : null;
      let data;
      if (streamFile) {
        await fs.chmod(output, 0o600);
        await fs.rename(output, streamFile);
      } else data = await fs.readFile(output, "base64");
      if (!current()) {
        if (streamFile) await fs.rm(streamFile, { force: true });
        return { ok: false };
      }
      const pdfPath = rootFile.replace(/\.tex$/i, ".pdf");
      if (this.latest?.pdfPath !== pdfPath || this.latest.root !== root) this.resetPapers();
      const sourceMap = sync ? { engine, sync, unfinished, aliases, temp, realTemp, root, realRoot, cwd, started, files: editSourceSnapshot.files } : null;
      this.imageBounds = bounds?.files.size ? { root, rootFile, files: bounds.files } : null;
      // Keep aux files from the last clean revision for the next keystroke.
      if (!manuscriptError && !emptyDocument && !unfinished) {
        this.references = references || bibliography ? { root, rootFile, engine, files: references, bibliography } : null;
      }
      const source = url ? { url } : { data };
      this.latest = { generation, root, rootFile: payload.rootFile, pdfPath, streamFile, size: stat.size, ...source };
      this.papers.set(generation, { generation, root, rootFile: payload.rootFile, pdfPath, sourceMap, emptyInsertion, emptyCaret: emptyInsertion ? emptyCaret : null, url, streamFile, size: stat.size,
        sourcesDirectory: editSourceSnapshot?.directory, readers: 0 });
      editSourceSnapshot = null;
      this.prunePapers();
      watched.complete = !manuscriptError;
      return { ok: true, generation, ...source, ...this.paperEditingState(),
        ...(emptyDocument && { emptyDocument: true }),
        ...(missingDocumentEnd && { missingDocumentEnd: true }),
        ...(unfinished && { pendingMathCloser: unfinished.closer,
          ...(unfinished.file !== rootFile && { pendingMathFile: path.relative(root, unfinished.file) }) }),
        ...(manuscriptError && { warning: manuscriptError }),
        ...(bibliography?.warning && { warning: bibliography.warning, command: bibliography.missingCommand }),
        ...(bibliography?.pending && { pendingBibliography: true }),
      };
    } finally {
      try {
        try {
          if (watched && current()) await this.inputs.finish(attempt, watched);
        } catch (error) {
          console.warn("[live-preview] Reading preview inputs failed:", error.message);
        } finally {
          if (this.inputs.attempt === attempt) this.inputs.attempt = null;
          await Promise.all([removeCompileDirectory(editSourceSnapshot?.directory), removeCompileDirectory(sandbox)]);
        }
      } finally {
        clearTimeout(job.timer);
        this.running = null;
        this.compiler.isBuilding = false;
      }
    }
  }
}

module.exports = { LivePdfFallback };
