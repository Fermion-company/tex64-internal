const { diffChars } = require("diff/lib/diff/character.js");
const { diffLines } = require("diff/lib/diff/line.js");

const CHAR_DIFF_MAX_RANGE_LENGTH = 4096;
const CHAR_DIFF_MAX_EDIT_LENGTH = 256;
const CHAR_DIFF_TIMEOUT_MS = 20;
const CHAR_DIFF_TOTAL_BUDGET_MS = 100;
const LARGE_LINE_REPLACEMENT = 512;

// Both line and character diffs use baseline UTF-16 coordinates, as Y.Text
// does. diffChars keeps Unicode characters intact; offsets use value.length.
const partsToHunks = (parts, start = 0) => {
  const hunks = [];
  let offset = start;
  let pending = null;
  const flush = () => {
    if (pending) hunks.push(pending);
    pending = null;
  };
  for (const part of parts) {
    if (!part.added && !part.removed) {
      flush();
      offset += part.value.length;
      continue;
    }
    if (!pending) pending = { start: offset, end: offset, text: "" };
    if (part.removed) {
      pending.end += part.value.length;
      offset += part.value.length;
    } else {
      pending.text += part.value;
    }
  }
  flush();
  return hunks;
};

// Replacing a whole chapter leaves no common lines inside its changed range.
// Myers' search is quadratic in this case. Keep the unchanged framing lines
// and use the single replacement directly when no interior line can match.
const wholeLineReplacement = (from, to) => {
  if (Math.min(from.length, to.length) <= CHAR_DIFF_MAX_RANGE_LENGTH) return null;
  const before = from.split(/(?<=\n)/);
  const after = to.split(/(?<=\n)/);
  if (Math.min(before.length, after.length) < LARGE_LINE_REPLACEMENT) return null;
  let first = 0;
  let start = 0;
  while (first < before.length && before[first] === after[first]) {
    start += before[first].length;
    first += 1;
  }
  let left = before.length;
  let right = after.length;
  let suffixLength = 0;
  while (left > first && right > first && before[left - 1] === after[right - 1]) {
    left -= 1;
    right -= 1;
    suffixLength += before[left].length;
  }
  if (Math.min(left - first, right - first) < LARGE_LINE_REPLACEMENT) return null;
  const oldLines = new Set(before.slice(first, left));
  for (let i = first; i < right; i++) {
    if (oldLines.has(after[i])) return null;
  }
  return { start, end: from.length - suffixLength, text: to.slice(start, to.length - suffixLength) };
};

// Diff lines first so unchanged lines never enter character refinement.
// Large or expensive ranges stay coarse and use the same conflict/relocation
// rules as fine hunks. The shared budget also bounds many separate ranges.
const textHunks = (from, to) => {
  const replacement = wholeLineReplacement(from, to);
  const ranges = replacement ? [replacement] : partsToHunks(diffLines(from, to));
  const deadline = performance.now() + CHAR_DIFF_TOTAL_BUDGET_MS;
  const hunks = [];
  for (const range of ranges) {
    const remaining = deadline - performance.now();
    if (range.end - range.start > CHAR_DIFF_MAX_RANGE_LENGTH || range.text.length > CHAR_DIFF_MAX_RANGE_LENGTH || remaining <= 0) {
      hunks.push(range);
      continue;
    }
    // diff 9 returns undefined when either budget is exhausted.
    const parts = diffChars(from.slice(range.start, range.end), range.text, {
      maxEditLength: CHAR_DIFF_MAX_EDIT_LENGTH,
      timeout: Math.min(CHAR_DIFF_TIMEOUT_MS, remaining),
    });
    if (parts) hunks.push(...partsToHunks(parts, range.start));
    else hunks.push(range);
  }
  return hunks;
};

// Apply from the end so an earlier edit cannot move a later one's position.
const applyHunks = (ytext, hunks, origin) => {
  if (!hunks.length) return;
  ytext.doc.transact(() => {
    for (let i = hunks.length - 1; i >= 0; i--) {
      const { start, end, text } = hunks[i];
      if (end > start) ytext.delete(start, end - start);
      if (text) ytext.insert(start, text);
    }
  }, origin);
};

// Keep unchanged characters (and their CRDT identities) within the diff budget.
const applyTextDelta = (ytext, from, to, origin) => {
  if (from === to) return;
  applyHunks(ytext, textHunks(from, to), origin);
};

module.exports = { textHunks, applyHunks, applyTextDelta };
