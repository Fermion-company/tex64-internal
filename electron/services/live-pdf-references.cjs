"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { isPathWithinRoot } = require("./build/utils.cjs");
const { readFileUpTo } = require("./bounded-file-read.cjs");

const REFERENCE_FILE = /\.(?:aux|toc|lof|lot|loa|lol|out|nav|snm|thm)$/i;
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_REFERENCE_FILES = 512;

async function readReferenceFiles(temp, cwd, recorder, previous) {
  const stat = await fs.lstat(recorder).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_REFERENCE_BYTES) return null;
  const entries = await readFileUpTo(recorder, stat.size).catch(() => null);
  if (!entries) return null;
  const names = new Set();
  for (const line of entries.toString("utf8").split(/\r?\n/)) {
    const record = /^(INPUT|OUTPUT) (.+)$/.exec(line);
    if (!record || !REFERENCE_FILE.test(record[2])) continue;
    const absolute = path.resolve(cwd, record[2]);
    if (!isPathWithinRoot(temp, absolute)) continue;
    const relative = path.relative(temp, absolute);
    // An excluded chapter can still supply labels via its previously written .aux.
    if (record[1] === "OUTPUT" || previous?.has(relative)) names.add(relative);
    if (names.size > MAX_REFERENCE_FILES) return null;
  }

  let bytes = 0;
  const files = new Map();
  for (const name of names) {
    const file = path.join(temp, name);
    const info = await fs.lstat(file).catch(() => null);
    if (!info?.isFile()) continue;
    bytes += info.size;
    if (bytes > MAX_REFERENCE_BYTES) return null;
    const contents = await readFileUpTo(file, info.size).catch(() => null);
    if (!contents) return null;
    files.set(name, contents);
  }
  return files;
}

function referencesChanged(before, after, transcript) {
  if (!after) return /Rerun to get|rerunfilecheck Warning: File|No file .+\.(?:toc|lof|lot)\./i.test(transcript);
  if (before && before.size !== after.size) return true;
  for (const [name, contents] of after) {
    if (before?.get(name)?.equals(contents)) continue;
    // Even an unnumbered one-page letter produces an .aux. Its boilerplate
    // alone does not justify a second pass on first opening.
    if (!before && /\.aux$/i.test(name) && transcript.includes(`No file ${path.basename(name)}.`) &&
        /^\s*\\relax\s*(?:\\gdef\s*\\@abspage@last\s*\{\d+\})?\s*$/.test(contents.toString("utf8")) &&
        !/undefined references/i.test(transcript)) continue;
    return true;
  }
  return false;
}

module.exports = { readReferenceFiles, referencesChanged };
