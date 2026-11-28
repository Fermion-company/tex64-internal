// Edits that did not come from the keyboard (another program rewriting the
// file, Axiom writing it) are applied to an open buffer as the few ranges that
// actually changed, so Monaco keeps the caret, selection, undo history and
// decorations on the text they belonged to. When the buffer also has unsaved
// typing, the disk change is rebased onto it if the two touch different text
// (the same rule as collaboration's disk sync: touching or overlapping edits
// are a conflict, never a guess).

/** Replace `from.slice(start, end)` with `text`. Offsets are UTF-16. */
export type TextHunk = { start: number; end: number; text: string };

// Diff work is bounded: past this many changed lines the caller falls back to
// its old behaviour (whole-buffer replacement, or a conflict).
const MAX_EDIT_LINES = 400;

// Line tokens keep their terminator, so a hunk never ends inside "\r\n".
const lineTokens = (text: string): string[] =>
  text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// Common prefix/suffix of two strings, never splitting "\r\n" or a surrogate
// pair (Monaco positions cannot address the inside of a line break).
const commonEnds = (a: string, b: string) => {
  const limit = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < limit && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix += 1;
  if (prefix > 0 && ((a[prefix - 1] === "\r" && (a[prefix] === "\n" || b[prefix] === "\n")) ||
    isHigh(a.charCodeAt(prefix - 1)))) prefix -= 1;
  let suffix = 0;
  while (suffix < limit - prefix &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix += 1;
  if (suffix > 0 && ((a[a.length - suffix] === "\n" &&
    (a[a.length - suffix - 1] === "\r" || b[b.length - suffix - 1] === "\r")) ||
    isLow(a.charCodeAt(a.length - suffix)))) suffix -= 1;
  return { prefix, suffix };
};

// Myers' O((N+M)D) diff over line tokens. Returns which tokens of each side
// are kept, or null when more than `maxD` tokens changed.
const keptTokens = (a: string[], b: string[], maxD: number) => {
  const n = a.length;
  const m = b.length;
  const trace: Int32Array[] = [];
  let previous = new Int32Array(1);
  let finalD = -1;
  for (let d = 0; d <= maxD && finalD < 0; d += 1) {
    const v = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && previous[k - 1 + d - 1] < previous[k + 1 + d - 1])) x = previous[k + 1 + d - 1];
      else x = previous[k - 1 + d - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[k + d] = x;
      if (x >= n && y >= m) { finalD = d; break; }
    }
    trace.push(v);
    previous = v;
  }
  if (finalD < 0) return null;
  const keepA = new Uint8Array(n);
  const keepB = new Uint8Array(m);
  let x = n;
  let y = m;
  for (let d = finalD; d > 0; d -= 1) {
    const before = trace[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && before[k - 1 + d - 1] < before[k + 1 + d - 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = before[prevK + d - 1];
    const prevY = prevX - prevK;
    const startX = down ? prevX : prevX + 1;
    while (x > startX) { x -= 1; y -= 1; keepA[x] = 1; keepB[y] = 1; }
    x = prevX;
    y = prevY;
  }
  while (x > 0) { x -= 1; y -= 1; keepA[x] = 1; keepB[y] = 1; }
  return { keepA, keepB };
};

const isLineStart = (text: string, at: number) =>
  at === 0 || text[at - 1] === "\n" || (text[at - 1] === "\r" && text[at] !== "\n");

// `removed` → `added` at `offset`, narrowed to the characters that differ.
const narrowed = (offset: number, removed: string, added: string): TextHunk | null => {
  if (removed === added) return null;
  const ends = commonEnds(removed, added);
  return {
    start: offset + ends.prefix,
    end: offset + removed.length - ends.suffix,
    text: added.slice(ends.prefix, added.length - ends.suffix),
  };
};

/**
 * The ranges of `from` to replace to obtain `to`, in ascending order and not
 * overlapping. Null when the change is too large to diff cheaply.
 */
export const textHunks = (from: string, to: string, maxEditLines = MAX_EDIT_LINES): TextHunk[] | null => {
  if (from === to) return [];
  // Diff whole lines: a deleted line is then that line, not a slice that
  // runs into the next one (where a caret would be swallowed).
  let { prefix, suffix } = commonEnds(from, to);
  while (prefix > 0 && !isLineStart(from, prefix)) prefix -= 1;
  let tail = from.length - suffix;
  while (tail < from.length && !isLineStart(from, tail)) tail += 1;
  suffix = from.length - tail;
  const fromMid = from.slice(prefix, from.length - suffix);
  const toMid = to.slice(prefix, to.length - suffix);
  if (!fromMid || !toMid) return [{ start: prefix, end: from.length - suffix, text: toMid }];
  const a = lineTokens(fromMid);
  const b = lineTokens(toMid);
  const kept = keptTokens(a, b, maxEditLines);
  if (!kept) return null;
  const hunks: TextHunk[] = [];
  let i = 0;
  let j = 0;
  let offset = prefix;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && kept.keepA[i] && kept.keepB[j]) {
      offset += a[i].length;
      i += 1;
      j += 1;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (i < a.length && !kept.keepA[i]) removed.push(a[i++]);
    while (j < b.length && !kept.keepB[j]) added.push(b[j++]);
    if (removed.length === added.length) {
      // As many lines out as in: each line was edited in place.
      removed.forEach((line, index) => {
        const hunk = narrowed(offset, line, added[index]);
        if (hunk) hunks.push(hunk);
        offset += line.length;
      });
    } else {
      const removedText = removed.join("");
      const hunk = narrowed(offset, removedText, added.join(""));
      if (hunk) hunks.push(hunk);
      offset += removedText.length;
    }
  }
  return hunks;
};

/** Apply ascending, non-overlapping hunks of `text`. */
export const applyHunks = (text: string, hunks: TextHunk[]) => {
  let result = "";
  let at = 0;
  for (const hunk of hunks) {
    result += text.slice(at, hunk.start) + hunk.text;
    at = hunk.end;
  }
  return result + text.slice(at);
};

/**
 * The edits, in `mine` coordinates, that carry `base → theirs` over to
 * `mine` (which is `base` plus unsaved typing). Null when a change touches or
 * overlaps the typing, or is too large to diff: the caller then keeps
 * asking the person, as before.
 */
export const rebaseHunks = (base: string, mine: string, theirs: string): TextHunk[] | null => {
  if (mine === theirs || base === theirs) return [];
  if (mine === base) return textHunks(mine, theirs);
  const ours = textHunks(base, mine);
  const others = textHunks(base, theirs);
  if (!ours || !others) return null;
  const edits: TextHunk[] = [];
  for (const hunk of others) {
    // Both sides made exactly this change; it is already in `mine`.
    if (ours.some((own) => own.start === hunk.start && own.end === hunk.end && own.text === hunk.text)) continue;
    if (ours.some((own) => own.start <= hunk.end && hunk.start <= own.end)) return null;
    let shift = 0;
    for (const own of ours) {
      if (own.end < hunk.start) shift += own.text.length - (own.end - own.start);
    }
    edits.push({ start: hunk.start + shift, end: hunk.end + shift, text: hunk.text });
  }
  return edits;
};
