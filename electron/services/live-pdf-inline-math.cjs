"use strict";

// SyncTeX encloses an inline formula with two dollar records in the
// containing hbox. Math converted inside a fraction or script has its own
// nested boxes. Pair markers only within their original horizontal list.
function horizontalRows(sheet, sourceTags, line) {
  const scale = 72 / 72.27 / 65536, stack = [], rows = [];
  for (const record of sheet.lines) {
    if (/^[<>f]/.test(record)) return null;
    if (record === ")" || record === "]") {
      if (stack.pop()?.kind !== (record === ")" ? "(" : "[")) return null;
      continue;
    }
    const node = /^([[(xg$hk])([0-9]+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/.exec(record);
    if (!node) continue;
    const [, kind, tag, srcLine, h, v, width, height, depth] = node;
    const x = (Number(h) + sheet.originX) * scale, y = (Number(v) + sheet.originY) * scale;
    if (kind === "(" || kind === "[") {
      const row = { kind, parent: stack.at(-1), sourceTag: Number(tag), sourceLine: sourceTags.has(Number(tag)) ? Number(srcLine) : 0,
        pairs: [], start: null, author: false, tagged: sourceTags.has(Number(tag)) && Number(srcLine) === line,
        y, box: { left: x, right: x + Number(width) * scale, top: y - Number(height) * scale, bottom: y + Number(depth) * scale } };
      stack.push(row);
      if (kind === "(") rows.push(row);
    } else {
      const row = stack.at(-1);
      if (!row) continue;
      if ((kind === "x" || kind === "g") && sourceTags.has(Number(tag)) && Number(srcLine) === line) row.author = true;
      if (kind !== "$" || y !== row.y) continue;
      if (row.start === null) row.start = x;
      else { row.pairs.push([row.start, x]); row.start = null; }
    }
  }
  return stack.length ? null : rows;
}

function contains(box, point) {
  return point.x >= box.left - 1 && point.x <= box.right + 1 && point.y >= box.top - 1 && point.y <= box.bottom + 1;
}

// SyncTeX normally assigns the outer line boxes of a typeset paragraph to
// its terminating source line. The dollar records may instead name the end
// of the document. Match complete sibling rows in their original TeX order.
const boundary = text => /^\s*(?:\\(?:begin|end)\s*\{document\}|\\par)?\s*$/.test(text);
const heading = text => /^\s*\\(?:part|chapter|(?:sub){0,2}section)\*?\s*(?:\[[^\]{}\\]*\]\s*)?\{[^{}\\]*\}\s*(?:%.*)?$/.test(text);
const paragraphEnd = /\\par\s*(?:%[^\n]*)?$/;

function literalParagraph(sourceText, regions, lineStart, lineEnd, lineNumber) {
  if (boundary(sourceText.slice(lineStart, lineEnd)) && lineStart > 0) {
    lineEnd = lineStart - 1;
    lineStart = sourceText.lastIndexOf("\n", lineEnd - 1) + 1;
    lineNumber--;
  }
  if (boundary(sourceText.slice(lineStart, lineEnd)) || heading(sourceText.slice(lineStart, lineEnd))) return null;
  let first = lineStart, last = lineEnd, firstLine = lineNumber, lastLine = lineNumber;
  while (first > 0) {
    const start = sourceText.lastIndexOf("\n", first - 2) + 1;
    const previous = sourceText.slice(start, first - 1);
    if (boundary(previous) || heading(previous) || paragraphEnd.test(previous)) break;
    first = start;
    firstLine--;
  }
  let currentLine = sourceText.slice(lineStart, lineEnd);
  while (last < sourceText.length && !paragraphEnd.test(currentLine)) {
    const end = sourceText.indexOf("\n", last + 1);
    const next = end < 0 ? sourceText.length : end;
    const nextLine = sourceText.slice(last + 1, next);
    if (boundary(nextLine) || heading(nextLine)) break;
    currentLine = nextLine;
    last = next;
    lastLine++;
  }
  const terminator = paragraphEnd.exec(currentLine);
  if (terminator) last -= terminator[0].length;
  const candidates = regions.filter(r => r.kind === "math" && r.end > first && r.start <= last);
  if (!candidates.length) return null;
  let cursor = first;
  for (const part of candidates) {
    if (part.display || part.start < cursor || part.end > last ||
        /[\\{}%$#&^_~]/.test(sourceText.slice(cursor, part.start))) return null;
    cursor = part.end;
  }
  if (/[\\{}%$#&^_~]/.test(sourceText.slice(cursor, last))) return null;
  return { candidates, firstLine, lastLine: terminator ? lastLine : lastLine + 1 };
}

// Only outer text lines in a vertical list establish the paragraph order.
// Dollar pairs within the contents of a fraction cannot select another formula.
function paragraphRow(row, { firstLine, lastLine }) {
  if (row.parent?.kind !== "[" || row.sourceLine < firstLine || row.sourceLine > lastLine) return false;
  // A formula can contain a vertical list with its own nested math (for
  // example, a fraction containing a text box). Only the outer pair counts.
  for (let parent = row.parent; parent; parent = parent.parent) {
    if (parent.pairs.length || parent.start !== null) return false;
  }
  return true;
}

function paragraphPairs(rows, bounds, tag) {
  const pairs = [];
  for (const row of rows) {
    if (row.sourceTag !== tag || !paragraphRow(row, bounds)) continue;
    if (row.start !== null) return null;
    for (const [left, right] of row.pairs) pairs.push({ row, left, right });
  }
  return pairs;
}

const lastParagraphPages = new WeakMap();
async function paragraphPageCounts(map, tag, bounds, currentPage, pairs, sourceInputs, visitSheets) {
  const { firstLine, lastLine } = bounds;
  const cached = lastParagraphPages.get(map);
  if (cached?.tag === tag && cached.firstLine === firstLine && cached.lastLine === lastLine) return cached.counts;
  const counts = new Map();
  let usable = true;
  const valid = await visitSheets((page, lines) => {
    if (!usable) return;
    if (page === currentPage) { counts.set(page, pairs.length); return; }
    if (!lines.some(line => line[0] === "$")) return;
    const fromParagraph = lines.some(line => {
      const node = /^\((\d+),(\d+)[:,]/.exec(line);
      return node && Number(node[1]) === tag &&
        Number(node[2]) >= firstLine && Number(node[2]) <= lastLine;
    });
    if (!fromParagraph) return;
    const rows = horizontalRows({ lines, originX: 0, originY: 0 }, sourceInputs, firstLine);
    const other = rows && paragraphPairs(rows, bounds, tag);
    if (!other) usable = false;
    else if (other.length) counts.set(page, other.length);
  });
  const result = valid && usable ? counts : null;
  lastParagraphPages.set(map, { tag, firstLine, lastLine, counts: result });
  return result;
}

async function paragraphMath(map, bounds, allRows, point, sourceInputs, visitSheets) {
  const { candidates } = bounds;
  const clicked = allRows.filter(row => contains(row.box, point) && paragraphRow(row, bounds) &&
    row.pairs.some(([left, right]) => point.x >= left && point.x <= right));
  if (clicked.length !== 1) return null;
  // TeX assigns each inclusion of the same file its own input tag. A page
  // can end one inclusion and begin the next with identical printed math.
  const tag = clicked[0].sourceTag;
  const pairs = paragraphPairs(allRows, bounds, tag);
  if (!pairs || pairs.length > candidates.length) return null;
  const hits = pairs.filter(({ row, left, right }) => row === clicked[0] && point.x >= left && point.x <= right);
  if (hits.length !== 1) return null;
  let index = pairs.indexOf(hits[0]);
  if (pairs.length < candidates.length) {
    const counts = await paragraphPageCounts(map, tag, bounds, point.page, pairs, sourceInputs, visitSheets);
    if (!counts) return null;
    let total = 0;
    for (const [page, count] of counts) {
      if (page < point.page) index += count;
      total += count;
    }
    if (total !== candidates.length) return null;
  }
  const { row, left, right } = hits[0];
  return { region: candidates[index], box: { left, right, top: row.box.top, bottom: row.box.bottom } };
}

module.exports = { horizontalRows, contains, literalParagraph, paragraphMath };
