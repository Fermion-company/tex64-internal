"use strict";

// The caret and all offsets use DOM/Monaco UTF-16 units. Keep the raw
// source of each unchanged character, including escaped symbols and hard wraps.
const escapes = { "\\": "\\textbackslash{}", "^": "\\textasciicircum{}", "~": "\\textasciitilde{}", "\n": "\n\n" };
function updatePrintedText(state, value) {
  const { raw, visible, offsets } = state;
  if (value === visible) return state;
  let start = 0, oldEnd = visible.length, end = value.length;
  while (start < oldEnd && start < end && visible[start] === value[start]) start++;
  while (oldEnd > start && end > start && visible[oldEnd - 1] === value[end - 1]) { oldEnd--; end--; }
  const next = offsets.slice(0, start + 1);
  let inserted = "";
  for (let i = start; i < end; i++) {
    const char = value[i];
    inserted += escapes[char] ?? (/[{}$&#_%]/.test(char) ? "\\" + char : char);
    next.push(offsets[start] + inserted.length);
  }
  const shift = next.at(-1) - offsets[oldEnd];
  for (let i = oldEnd + 1; i < offsets.length; i++) next.push(offsets[i] + shift);
  return { visible: value, raw: raw.slice(0, offsets[start]) + inserted + raw.slice(offsets[oldEnd]), offsets: next };
}

// A shipped paragraph often carries the source line of its terminating blank
// line or environment. Only admit literal text from that paragraph. An
// opaque macro can print the same words again, in a different position.
function matchProse(sourceText, regions, lineStart, lineEnd, printed, outsideMath, boxes, occurrences) {
  const boundary = /^\s*(?:$|\\(?:begin|end)\s*\{|\\par\b|\\(?:sub)*section\*?\s*\{|\\chapter\*?\s*\{)/;
  const terminator = /^\s*(?:$|\\(?:end|begin)\s*\{|\\par\b)/;
  const line = sourceText.slice(lineStart, lineEnd);
  let start = lineStart, end = lineEnd;
  if (terminator.test(line)) end = lineStart;
  while (start > 0) {
    const previous = sourceText.lastIndexOf("\n", start - 2) + 1;
    if (previous >= start) break;
    const value = sourceText.slice(previous, start - 1);
    if (boundary.test(value) || (start !== end && value.trimEnd().endsWith("\\par"))) break;
    start = previous;
  }
  if (!boundary.test(line) && !line.trimEnd().endsWith("\\par")) {
    while (end < sourceText.length) {
      const next = sourceText.indexOf("\n", end + 1);
      const stop = next === -1 ? sourceText.length : next;
      const following = sourceText.slice(end + 1, stop);
      if (boundary.test(following)) break;
      end = stop;
      if (following.trimEnd().endsWith("\\par")) break;
    }
  }
  if (end <= start) return null;
  // Accents and ligatures may print a different character. Match literal
  // Unicode and TeX whitespace only, leaving unfamiliar output untouched.
  const inline = regions.filter(r => r.kind === "math" && r.start < end && r.end > start);
  if (inline.length && (inline.some(r => r.display || r.start < start || r.end > end) || !outsideMath(inline))) return null;
  let original = "", cursor = start;
  for (const r of inline) {
    original += sourceText.slice(cursor, r.start) + " ";
    cursor = r.end;
  }
  original += sourceText.slice(cursor, end);
  const plain = original.replace(/\\(?:textbf|textit|emph|textrm|textsf|section|subsection|subsubsection|chapter|part|paragraph)\*?\s*(?=\{)/g, "")
    .replace(/\\par\s*$/, "").replace(/\\[%#_$&{}]/g, "");
  if (/[\\%#$&_^~]/.test(plain)) return null;
  const needle = printed.trim();
  if (!needle || needle !== printed) return null;
  const hits = [];
  const pattern = needle.split(/\s+/u).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const search = new RegExp(pattern, "gu");
  // Consecutive literal regions can be separated by an escaped TeX character.
  // Map only such contiguous pieces, never across a formatting command.
  let run = null;
  function matchRun() {
    if (!run) return;
    for (const match of run.text.matchAll(search)) {
      const a = run.offsets[match.index], b = run.offsets[match.index + match[0].length];
      if (a === undefined || b === undefined) continue;
      const offsets = [0];
      let i = match.index;
      for (const char of needle.split("")) {
        if (/\s/u.test(char)) while (i < match.index + match[0].length && /\s/u.test(run.text[i])) i++;
        else i++;
        offsets.push(run.offsets[i] - a);
      }
      hits.push({ a, b, offsets });
      if (hits.length > 256) return;
    }
  }
  for (const r of regions) {
    if (hits.length > 256) return null;
    if (r.end <= start) continue;
    if (r.start >= end) break;
    if (r.kind !== "text") continue;
    const from = Math.max(r.contentStart, start), to = Math.min(r.contentEnd, end);
    if (from >= to) continue;
    const escaped = r.value !== r.sourceValue;
    if (escaped && !/^\\[%#_$&{}]$/.test(r.sourceValue)) continue;
    if (!run || !/^\s*$/u.test(sourceText.slice(run.end, from))) {
      matchRun();
      run = { text: "", offsets: [from], end: from };
    }
    for (let at = run.end; at < (escaped ? from : to); at++) {
      run.text += sourceText[at]; run.offsets.push(at + 1);
    }
    if (escaped) { run.text += r.value; run.offsets.push(to); }
    run.end = to;
  }
  matchRun();
  if (!hits.length || hits.length > 256) return null;
  let index = 0;
  if (hits.length > 1) {
    if (!occurrences) return { needsOccurrences: true };
    if (!Array.isArray(occurrences) || occurrences.length > 256) return null;
    const points = occurrences.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
      boxes.some(({ box }) => p.x >= box.left && p.x <= box.right && p.y >= box.top - 1 && p.y <= box.bottom + 1));
    if (points.length !== hits.length || points.filter(p => p.selected === true).length !== 1) return null;
    // Text in one horizontal line proceeds left to right. Never assign
    // source order to a visually reordered line, reused form or second column.
    for (let i = 1; i < points.length; i++) {
      const here = points[i], previous = points[i - 1];
      if (here.y < previous.y - 1 || (Math.abs(here.y - previous.y) <= 1 && here.x <= previous.x)) return null;
    }
    index = points.findIndex(p => p.selected === true);
  }
  return hits[index];
}

module.exports = { matchProse, updatePrintedText };
