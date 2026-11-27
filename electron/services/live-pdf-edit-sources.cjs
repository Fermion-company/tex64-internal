"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { readFileUpTo } = require("./bounded-file-read.cjs");

const INLINE_EDIT_BYTES = 4 * 1024 * 1024;
const SOURCE_CACHE_BYTES = 16 * 1024 * 1024;
const INLINE_SYNC_BYTES = 8 * 1024 * 1024;

async function captureEditSources(files, stage, syncFile) {
  const sources = new Map();
  let directory = null, remaining = SOURCE_CACHE_BYTES;
  const retain = async (from, name) => {
    directory ??= await fs.mkdtemp(path.join(os.tmpdir(), "tex64-live-sources-"));
    const to = path.join(directory, name);
    // Both paths are on the same volume. A reader may temporarily prevent
    // renaming on Windows while still allowing a copy of the exact bytes.
    try { await fs.rename(from, to); }
    catch { await fs.copyFile(from, to); }
    return to;
  };
  try {
    const stat = await fs.lstat(syncFile);
    if (!stat.isFile() || !stat.size) return null;
    const sync = stat.size > INLINE_SYNC_BYTES ? await retain(syncFile, "paper.synctex.gz") :
      await readFileUpTo(syncFile, INLINE_SYNC_BYTES);
    if (!sync) return null;
    for (const [name, text] of files) {
      if (!/\.(?:tex|ltx)$/i.test(name)) continue;
      const staged = path.join(stage, name);
      const size = text === null ? (await fs.stat(staged).catch(() => null))?.size : Buffer.byteLength(text);
      if (size === undefined) continue;
      if (size <= INLINE_EDIT_BYTES && size <= remaining) {
        // Use the staged root as well. Typing can change the project file
        // before the first click on the still-displayed revision.
        const snapshot = text ?? (await readFileUpTo(staged, size).catch(() => null))?.toString("utf8");
        if (snapshot !== undefined) {
          sources.set(name, snapshot);
          remaining -= size;
        }
        continue;
      }
      // Source lookup is optional for viewing a successfully typeset PDF.
      // Never substitute the on-disk original for an unavailable dirty overlay.
      try { sources.set(name, { snapshot: await retain(staged, String(sources.size)) }); }
      catch { if (text !== null) sources.set(name, { unavailable: true }); }
    }
    return { files: sources, sync, directory };
  } catch (error) {
    if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
      .catch(failure => console.warn("[live-preview] Removing source snapshots:", failure.message));
    if (error.code !== "ENOENT") console.warn("[live-preview] Preparing source lookup:", error.message);
    return null;
  }
}

function releaseSources(paper) {
  if (!paper.sourcesDirectory || paper.readers) return;
  const directory = paper.sourcesDirectory;
  paper.sourcesDirectory = null;
  void fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
    .catch(error => console.warn("[live-preview] Removing source snapshots:", error.message));
}

module.exports = { captureEditSources, releaseSources, INLINE_EDIT_BYTES };
