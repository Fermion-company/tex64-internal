"use strict";
// The text each file had when the last Build of a PDF read it, for Jump.
//
// A Build's SyncTeX numbers a file's lines as they were when TeX read them;
// the caret is on a line of the buffer as it is now. Every line inserted or
// removed above it since that Build moved the Jump by as many lines (the
// "a few lines off" of a Jump answered from the Build: while the status mark
// is red nothing on the Live side corrects it, and while it is green the
// correction is a second movement). mapSourceLine carries the caret's line
// into the Build's numbering.

const fs = require("fs");
const path = require("path");

const IGNORED_DIRECTORIES = new Set([".git", ".tex64", "node_modules", ".swiftpm", ".next", "DerivedData"]);
const SOURCE_RE = /\.(?:tex|ltx)$/i;

const splitLines = (text) => String(text).split(/\r?\n/);

/**
 * The line of `builtLines` that holds what line `line` of `currentLines`
 * holds. `exact` only when that line is unchanged and in a run both texts
 * share; a line written since (or a block too large to compare) maps to its
 * place among the unchanged lines around it.
 */
const mapSourceLine = (currentLines, builtLines, line, { maxCells = 4_000_000 } = {}) => {
  const n = currentLines.length;
  const m = builtLines.length;
  const target = Math.max(1, Math.min(Math.floor(line) || 1, Math.max(1, n)));
  let prefix = 0;
  while (prefix < n && prefix < m && currentLines[prefix] === builtLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix &&
      currentLines[n - 1 - suffix] === builtLines[m - 1 - suffix]) suffix += 1;
  if (target <= prefix) return { line: target, exact: true };
  if (target > n - suffix) return { line: Math.max(1, target - (n - m)), exact: true };
  // The changed middle: [prefix, n - suffix) of the buffer against
  // [prefix, m - suffix) of the Build's text.
  const a = currentLines.slice(prefix, n - suffix);
  const b = builtLines.slice(prefix, m - suffix);
  const at = target - 1 - prefix;
  const clamp = (value) => Math.max(1, Math.min(Math.max(1, m), value));
  if (b.length === 0) return { line: clamp(prefix + 1), exact: false };
  if (a.length * b.length > maxCells) {
    return { line: clamp(prefix + 1 + Math.floor(at * b.length / Math.max(1, a.length))), exact: false };
  }
  // Longest common subsequence of the middle: which buffer line is which
  // Build line.
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const pairs = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i += 1;
    else j += 1;
  }
  const same = pairs.find(([i]) => i === at);
  if (same) return { line: prefix + 1 + same[1], exact: true };
  // Written since the Build: it stands where the Build had the line after
  // the last unchanged one above it.
  let before = -1;
  for (const [i, j] of pairs) if (i < at) before = j;
  return { line: clamp(prefix + 1 + before + 1), exact: false };
};

const createBuildSourceTracker = ({ fileSystem = fs, now = () => Date.now(), maxFiles = 400, maxBytes = 16 * 1024 * 1024 } = {}) => {
  // the Build running now: { rootPath, at, pdfPath (absolute, or null while not known) }
  let started = null;
  let settleWaiters = [];
  // absolute PDF path -> { synctexMtimeMs, files: Map(abs -> text), changed: Set(abs) }
  const builds = new Map();
  let capture = Promise.resolve();

  const statOrNull = (file) => {
    try { return fileSystem.statSync(file); } catch { return null; }
  };
  const synctexOf = (pdfPath) => [".synctex.gz", ".synctex"]
    .map((suffix) => pdfPath.replace(/\.pdf$/i, suffix))
    .find((candidate) => statOrNull(candidate)?.isFile?.());

  const listSources = async (rootPath) => {
    const found = [];
    const pending = [rootPath];
    let directories = 0;
    while (pending.length && found.length < maxFiles && directories < 2000) {
      const directory = pending.pop();
      directories += 1;
      let entries = [];
      try { entries = await fileSystem.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) pending.push(path.join(directory, entry.name));
        } else if (entry.isFile() && SOURCE_RE.test(entry.name)) {
          found.push(path.join(directory, entry.name));
          if (found.length >= maxFiles) break;
        }
      }
    }
    return found;
  };

  // The sources as the Build read them: a file not written since the Build
  // started holds what TeX read. One written meanwhile is not known.
  const captureBuild = async ({ rootPath, pdfPath, startedAt }) => {
    const synctexPath = synctexOf(pdfPath);
    const synctexMtimeMs = synctexPath ? statOrNull(synctexPath)?.mtimeMs : null;
    if (!Number.isFinite(synctexMtimeMs)) {
      builds.delete(pdfPath);
      return;
    }
    const files = new Map();
    const changed = new Set();
    let bytes = 0;
    for (const file of await listSources(rootPath)) {
      const before = statOrNull(file);
      if (!before || before.mtimeMs > startedAt) { changed.add(file); continue; }
      if (bytes + before.size > maxBytes) { changed.add(file); continue; }
      let text = null;
      try { text = await fileSystem.promises.readFile(file, "utf8"); } catch { text = null; }
      const after = statOrNull(file);
      if (text === null || !after || after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
        changed.add(file);
        continue;
      }
      bytes += before.size;
      files.set(file, text);
    }
    builds.delete(pdfPath);
    builds.set(pdfPath, { synctexMtimeMs, files, changed });
    while (builds.size > 4) builds.delete(builds.keys().next().value);
  };

  /** Build progress as main reports it (build-core sendBuildState). */
  const observe = (state, extra, rootPath) => {
    if (state === "building") {
      const pdfPath = typeof extra?.pdfPath === "string" && extra.pdfPath && rootPath
        ? path.resolve(rootPath, extra.pdfPath) : null;
      if (!started && rootPath) started = { rootPath, at: now(), pdfPath };
      else if (started && !started.pdfPath && pdfPath) started.pdfPath = pdfPath;
      return;
    }
    const run = started;
    started = null;
    if (state === "success" && run && typeof extra?.pdfPath === "string" && extra.pdfPath) {
      const pdfPath = path.resolve(run.rootPath, extra.pdfPath);
      capture = capture.then(() => captureBuild({ rootPath: run.rootPath, pdfPath, startedAt: run.at }))
        .catch(() => builds.delete(pdfPath));
    }
    // (after the success has gone out to the viewers: build-core sends it
    // once the new PDF is in place and opened)
    const waiters = settleWaiters;
    settleWaiters = [];
    for (const resolve of waiters) resolve(true);
  };

  /** Whether a Build is running that writes `pdfPath` (or one not yet known to). */
  const running = (pdfPath = null) => Boolean(started) &&
    (!pdfPath || !started.pdfPath || path.resolve(pdfPath) === started.pdfPath);

  /** Resolves once the running Build has ended (true), or after `timeoutMs` (false). */
  const whenSettled = ({ timeoutMs = 15_000 } = {}) => {
    if (!started) return capture.then(() => true, () => true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        settleWaiters = settleWaiters.filter((waiter) => waiter !== done);
        resolve(false);
      }, timeoutMs);
      const done = (value) => { clearTimeout(timer); capture.then(() => resolve(value), () => resolve(value)); };
      settleWaiters.push(done);
    });
  };

  /**
   * The text `sourcePath` had when the Build behind `pdfPath`'s SyncTeX read
   * it, or null when that is not known.
   */
  const sourceFor = async ({ pdfPath, sourcePath }) => {
    await capture;
    if (!pdfPath || !sourcePath) return null;
    const pdf = path.resolve(pdfPath);
    const source = path.resolve(sourcePath);
    const synctexPath = synctexOf(pdf);
    const synctexMtimeMs = synctexPath ? statOrNull(synctexPath)?.mtimeMs : null;
    if (!Number.isFinite(synctexMtimeMs)) return null;
    const build = builds.get(pdf);
    if (build && build.synctexMtimeMs === synctexMtimeMs) {
      if (build.files.has(source)) return build.files.get(source);
      if (build.changed.has(source)) return null;
    }
    // A Build of another session: a file not written since its SyncTeX was
    // is what that Build read.
    const stats = statOrNull(source);
    if (!stats || stats.mtimeMs > synctexMtimeMs) return null;
    try { return fileSystem.readFileSync(source, "utf8"); } catch { return null; }
  };

  /** Whether the paper at `pdfPath` is the one the last Build of it seen here made. */
  const isLastBuildPaper = async (pdfPath) => {
    await capture.catch(() => {});
    const build = builds.get(path.resolve(pdfPath));
    const synctexPath = synctexOf(path.resolve(pdfPath));
    const synctexMtimeMs = synctexPath ? statOrNull(synctexPath)?.mtimeMs : null;
    return Boolean(build) && Number.isFinite(synctexMtimeMs) && build.synctexMtimeMs === synctexMtimeMs;
  };

  return { observe, sourceFor, running, whenSettled, isLastBuildPaper };
};

module.exports = { createBuildSourceTracker, mapSourceLine, splitLines };
