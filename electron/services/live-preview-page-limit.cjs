"use strict";

/**
 * Realtime preview is offered up to a realistic document length.
 *
 * Measured on the packaged app (16 GB Mac): 49–72 pages put a keystroke on
 * the paper in 81–149 ms; a 389-page book needs 213–270 ms, about 15 minutes
 * to settle after its first open, and its preamble alone holds 1.5 GB per
 * checkpoint. Past the limit the document keeps its Build paper, exactly as
 * with the realtime setting off; editing the source (alone or with others)
 * is not limited.
 *
 * The length is known from two places:
 *  - the paper of the last Build (beside the root, or the copy the project's
 *    Build cache keeps when the output goes to another directory), before
 *    the engine is started at all;
 *  - the engine itself, for a document that has no Build yet or that grew
 *    past the limit while Live was running.
 * An engine reading stays in force until a newer Build says otherwise.
 */

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const LIVE_PREVIEW_PAGE_LIMIT = 200;
const MAX_PDF_BYTES = 100 * 1024 * 1024;

const countPdfPages = async (pdfPath) => {
  const pdfjsPath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const { getDocument } = await import(pathToFileURL(pdfjsPath).href);
  const loading = getDocument({
    data: new Uint8Array(await fs.promises.readFile(pdfPath)),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  try {
    return (await loading.promise).numPages;
  } finally {
    await loading.destroy();
  }
};

class LivePreviewPageLimit {
  constructor({ limit = LIVE_PREVIEW_PAGE_LIMIT, countPages = countPdfPages, stat = fs.promises.stat } = {}) {
    this.limit = limit;
    this.countPages = countPages;
    this.stat = stat;
    this.builds = new Map(); // pdfPath -> { mtimeMs, size, pages }
    this.observed = new Map(); // rootPath -> { pages, atMs }
  }

  /** Pages of the newest Build paper known for `rootPath`, or null. */
  async buildPages(rootPath, cachedPaper = null) {
    const papers = [/\.tex$/i.test(rootPath) ? rootPath.replace(/\.tex$/i, ".pdf") : null, cachedPaper]
      .filter((pdfPath) => typeof pdfPath === "string" && pdfPath);
    let newest = null;
    for (const pdfPath of papers) {
      const entry = await this.paperPages(pdfPath);
      if (entry && (!newest || entry.mtimeMs > newest.mtimeMs)) newest = entry;
    }
    return newest;
  }

  async paperPages(pdfPath) {
    let stats;
    try { stats = await this.stat(pdfPath); } catch { this.builds.delete(pdfPath); return null; }
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_PDF_BYTES) return null;
    const known = this.builds.get(pdfPath);
    if (known && known.mtimeMs === stats.mtimeMs && known.size === stats.size) return known;
    let pages = null;
    try { pages = await this.countPages(pdfPath); } catch { pages = null; }
    if (!Number.isInteger(pages) || pages <= 0) return null;
    const entry = { mtimeMs: stats.mtimeMs, size: stats.size, pages };
    this.builds.set(pdfPath, entry);
    return entry;
  }

  /** The engine reports `pages` for `rootPath`; true when that is past the limit. */
  observe(rootPath, pages, atMs = Date.now()) {
    if (!rootPath || !Number.isInteger(pages) || pages <= this.limit) return false;
    this.observed.set(path.resolve(rootPath), { pages, atMs });
    return true;
  }

  async check(rootPath, cachedPaper = null) {
    if (!rootPath) return { limited: false, pages: null };
    const key = path.resolve(rootPath);
    const build = await this.buildPages(key, cachedPaper);
    const observed = this.observed.get(key);
    if (observed && build && build.mtimeMs > observed.atMs) this.observed.delete(key);
    else if (observed) return { limited: true, pages: observed.pages };
    if (build && build.pages > this.limit) return { limited: true, pages: build.pages };
    return { limited: false, pages: build?.pages ?? null };
  }
}

module.exports = { LivePreviewPageLimit, LIVE_PREVIEW_PAGE_LIMIT, countPdfPages };
