/**
 * agent-tools-safety.cjs
 *
 * Shared safety layer for file-writing tools.
 *
 * Goals (addressing the E2E test findings):
 *
 *  1. **Destructive shrink detection**: a write that removes more than
 *     SAFE_SHRINK_THRESHOLD of existing content without explicit
 *     `allowFullRewrite: true` is rejected. This is the primary guard
 *     against the "Step 8 catastrophic file wipeout" observed during testing,
 *     where the LLM tried to overwrite a 60-line file with a single line.
 *
 *  2. **Expected-SHA precondition**: edit/replace tools can pass
 *     `expectedSha` of what the LLM *thinks* the current file looks like.
 *     If it mismatches, we reject with a clear "file has changed, re-read it"
 *     error so the LLM is forced back into a read-verify-modify loop.
 *
 *  3. **Post-write verification**: after applying a proposal, re-read the
 *     file from disk and confirm the new content is actually there. If the
 *     on-disk content does not match what we intended to write, we surface
 *     a clear error instead of letting the LLM hallucinate success.
 *
 *  4. **Structured result**: every safe write returns a concrete summary
 *     `{ path, linesBefore, linesAfter, linesAdded, linesRemoved, sha }`.
 *     The LLM sees real numbers, which reduces hallucinated success reports.
 */

"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");

const DEFAULT_SAFE_SHRINK_THRESHOLD = 0.5; // reject if new < 50% of old lines
const DEFAULT_SAFE_SHRINK_MIN_LINES = 10;  // shrinks below 10 lines are OK even if > threshold

const hashContent = (content) => {
  if (typeof content !== "string") return null;
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
};

const shortSha = (sha) =>
  typeof sha === "string" && sha.length >= 8 ? sha.slice(0, 8) : sha;

const countLines = (content) => {
  if (typeof content !== "string" || content.length === 0) return 0;
  // Lines = number of newlines + 1 if last line has no trailing newline
  let n = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 0x0a) n += 1;
  }
  if (content.charCodeAt(content.length - 1) !== 0x0a) n += 1;
  return n;
};

const describeChange = (oldContent, newContent) => {
  const oldLines = countLines(oldContent);
  const newLines = countLines(newContent);
  const linesDelta = newLines - oldLines;
  return {
    linesBefore: oldLines,
    linesAfter: newLines,
    linesAdded: linesDelta > 0 ? linesDelta : 0,
    linesRemoved: linesDelta < 0 ? -linesDelta : 0,
    linesDelta,
    shaBefore: hashContent(oldContent),
    shaAfter: hashContent(newContent),
  };
};

/**
 * Determine whether a proposed write is a destructive shrink that should
 * require explicit `allowFullRewrite: true` acknowledgement.
 *
 * Rules:
 *   - If the old file was less than SAFE_SHRINK_MIN_LINES, shrinking is fine.
 *   - If the new content retains at least SAFE_SHRINK_THRESHOLD (50%)
 *     of the old line count, it's fine.
 *   - Otherwise, it's destructive and must be acknowledged.
 */
const isDestructiveShrink = (oldContent, newContent, options = {}) => {
  const threshold = options.threshold ?? DEFAULT_SAFE_SHRINK_THRESHOLD;
  const minLines = options.minLines ?? DEFAULT_SAFE_SHRINK_MIN_LINES;
  const oldLines = countLines(oldContent);
  const newLines = countLines(newContent);
  if (oldLines < minLines) return false;
  return newLines < Math.floor(oldLines * threshold);
};

/**
 * Check the optional expectedSha against the actual current content hash.
 * Returns { ok, error? }.
 */
const verifyExpectedSha = (expectedSha, actualContent) => {
  if (!expectedSha || typeof expectedSha !== "string") {
    return { ok: true };
  }
  const actualSha = hashContent(actualContent);
  if (!actualSha || actualSha !== expectedSha) {
    return {
      ok: false,
      error:
        "File content has changed since you last read it. Expected SHA " +
        shortSha(expectedSha) +
        " but the file is now " +
        shortSha(actualSha) +
        ". You MUST read_file again before editing.",
      actualSha,
    };
  }
  return { ok: true, actualSha };
};

/**
 * Post-write verification. Re-read the file from disk and confirm the
 * content matches what we wrote. Returns { ok, error?, actualSha }.
 *
 * This catches silent failures where the proposal system thinks it wrote
 * but the LLM's context snapshot or the editor state drifted.
 */
const verifyPostWrite = async (resolvedPath, expectedContent) => {
  try {
    const actual = await fsp.readFile(resolvedPath, "utf8");
    const expectedSha = hashContent(expectedContent);
    const actualSha = hashContent(actual);
    if (expectedSha !== actualSha) {
      return {
        ok: false,
        error:
          "Post-write verification failed: on-disk content does not match " +
          "what was written (expected " +
          shortSha(expectedSha) +
          ", got " +
          shortSha(actualSha) +
          "). The write may have been dropped or the editor has unsaved changes.",
        actualSha,
      };
    }
    return { ok: true, actualSha };
  } catch (err) {
    return {
      ok: false,
      error:
        "Post-write verification could not re-read the file: " +
        (err?.message || String(err)),
    };
  }
};

/**
 * Critical structural elements that must be preserved across edits.
 *
 * The idea: if a .tex file originally had \begin{document}, \end{document},
 * and \title{}, then ANY edit that removes these is almost certainly a
 * mistake (the LLM lost track of what it was doing). We treat these as
 * an invariant: once present, they must remain present.
 *
 * Each invariant is checked by calling a simple `detect(content)` function
 * that returns true if the element is present. After an edit, if an
 * invariant that was true before becomes false, the edit is rejected
 * unless `allowFullRewrite: true` is passed.
 */
const LATEX_STRUCTURAL_INVARIANTS = [
  {
    name: "\\documentclass",
    detect: (c) => /\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/.test(c),
  },
  {
    name: "\\begin{document}",
    detect: (c) => /\\begin\{document\}/.test(c),
  },
  {
    name: "\\end{document}",
    detect: (c) => /\\end\{document\}/.test(c),
  },
  {
    name: "\\title",
    detect: (c) => /\\title\{/.test(c),
  },
  {
    name: "\\author",
    detect: (c) => /\\author\{/.test(c),
  },
  {
    name: "\\maketitle",
    detect: (c) => /\\maketitle\b/.test(c),
  },
  {
    name: "\\begin{abstract}",
    detect: (c) => /\\begin\{abstract\}/.test(c),
  },
  {
    name: "\\end{abstract}",
    detect: (c) => /\\end\{abstract\}/.test(c),
  },
];

/**
 * Check which LaTeX structural invariants would be broken by a proposed edit.
 *
 * Returns an array of names of elements that were present in `oldContent`
 * but are missing in `newContent`. An empty array means all invariants hold.
 *
 * Only applies to .tex files.
 */
const checkLatexInvariants = (path, oldContent, newContent) => {
  if (!path || typeof path !== "string" || !path.toLowerCase().endsWith(".tex")) {
    return [];
  }
  const broken = [];
  for (const inv of LATEX_STRUCTURAL_INVARIANTS) {
    if (inv.detect(oldContent) && !inv.detect(newContent)) {
      broken.push(inv.name);
    }
  }
  return broken;
};

/**
 * Format a compact change summary string for returning to the LLM.
 *
 * Example: "main.tex: 60 → 62 lines (+3 -1) [sha abc12345]"
 */
const formatChangeSummary = (path, change) => {
  if (!change) return path;
  const parts = [];
  parts.push(
    `${path}: ${change.linesBefore} → ${change.linesAfter} lines`
  );
  const addRem = [];
  if (change.linesAdded > 0) addRem.push(`+${change.linesAdded}`);
  if (change.linesRemoved > 0) addRem.push(`-${change.linesRemoved}`);
  if (addRem.length > 0) parts.push(`(${addRem.join(" ")})`);
  if (change.shaAfter) parts.push(`[sha ${shortSha(change.shaAfter)}]`);
  return parts.join(" ");
};

module.exports = {
  DEFAULT_SAFE_SHRINK_THRESHOLD,
  DEFAULT_SAFE_SHRINK_MIN_LINES,
  LATEX_STRUCTURAL_INVARIANTS,
  hashContent,
  shortSha,
  countLines,
  describeChange,
  isDestructiveShrink,
  verifyExpectedSha,
  verifyPostWrite,
  checkLatexInvariants,
  formatChangeSummary,
};
