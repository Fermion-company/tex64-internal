"use strict";

const { horizontalRows, contains, literalParagraph, paragraphMath } = require("./live-pdf-inline-math.cjs");
const { withoutComments } = require("../../Resources/tdom-engine/web/math-macro-projection.cjs");
const { matchProse } = require("./live-pdf-prose.cjs");
const fs = require("node:fs/promises");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { reverseOnSheet } = require("./synctex/forward-index.cjs");
const { recordedProjectPath } = require("./live-pdf-paths.cjs");
const { INLINE_EDIT_BYTES } = require("./live-pdf-edit-sources.cjs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { readFileUpTo } = require("./bounded-file-read.cjs");

const resourceRoot = path.join(__dirname, "../../Resources/tdom-engine/engine").replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
const load = (name) => import(pathToFileURL(path.join(resourceRoot, name)).href);

function position(text, offset) {
  let line = 1, start = 0;
  for (let next = text.indexOf("\n"); next >= 0 && next < offset; next = text.indexOf("\n", start)) {
    start = next + 1;
    line++;
  }
  return { line, column: offset - start + 1 };
}

async function emptyBodyInsertion(sourceText, file, bodyLine) {
  if (typeof sourceText !== "string") return null;
  let lineStart = 0;
  for (let line = 1; line < bodyLine; line++) {
    const end = sourceText.indexOf("\n", lineStart);
    if (end < 0) return null;
    lineStart = end + 1;
  }
  const tail = sourceText.slice(lineStart);
  const { documentBounds } = await load("segmenter.js");
  const { hasBegin, body } = documentBounds(tail);
  if (!hasBegin || position(tail, body.start).line !== 1) return null;
  const content = tail.slice(body.start, body.end);
  // A visually empty body can still input other files or execute macros.
  // Only claim an insertion point among literal whitespace and comments.
  if (content.split(/\r?\n/).some(line => !/^[ \t]*(?:%.*)?$/.test(line))) return null;
  const newline = content.indexOf("\n", content.trimEnd().length);
  const offset = newline < 0 ? body.end : body.start + newline + 1;
  const eol = sourceText.includes("\r\n") ? "\r\n" : "\n";
  const at = position(tail, offset);
  at.line += bodyLine - 1;
  return { file, kind: "text", sourceText, start: at, end: at, baseValue: "", visibleValue: "", offsets: [0],
    insertion: { prefix: newline < 0 ? eol : "", suffix: /^[ \t]*\r?\n/.test(tail.slice(offset)) ? "" : eol } };
}

// Find a literal math opener in the last part of the body. Verify it with
// the same region parser used for paper clicks before trying a preview copy.
async function unfinishedFormula(source, file, changedFormula, chapter = false) {
  let body = changedFormula;
  if (!body || /\\(?:begin|end)\s*\{document\}/.test(source.slice(body.start, body.end))) {
    const { documentBounds } = await load("segmenter.js");
    const bounds = documentBounds(source);
    if (!bounds.hasBegin && !chapter) return null;
    body = bounds.body;
  }
  const { discoverEditRegions, inlineLiteral } = await load("edit-regions.js");
  const text = source.slice(body.start, body.end);
  const tokens = /%[^\r\n]*|\\(?:[A-Za-z@]+|[\s\S])|[$]{1,2}|[^\s\\%$]+/g;
  const envName = /\s*\{(math|displaymath|equation\*?|align\*?|gather\*?|multline\*?|flalign\*?|alignat\*?|eqnarray\*?)\}/y;
  let opener, closer, at = 0;
  for (let token; (token = tokens.exec(text));) {
    const value = token[0];
    if (value[0] === "%") continue;
    if (value === "\\begin" || value === "\\end") {
      envName.lastIndex = tokens.lastIndex;
      const env = envName.exec(text);
      if (env) {
        tokens.lastIndex = envName.lastIndex;
        opener = token.index;
        closer = value === "\\begin" ? "\\end{" + env[1] + "}" : null;
      }
    } else if (value === "\\(" || value === "\\[" || value[0] === "$") {
      opener = token.index;
      closer = value === "\\(" ? "\\)" : value === "\\[" ? "\\]" : value;
    } else if (value === "\\)" || value === "\\]") {
      closer = null;
    } else if (value[0] === "\\") {
      const literal = inlineLiteral(text, { name: value.slice(1), end: tokens.lastIndex }, text.length);
      if (literal) tokens.lastIndex = literal.after;
    }
    at = tokens.lastIndex;
  }
  if (!closer) return null;
  const projected = text.slice(0, at) + closer;
  const region = discoverEditRegions(projected).at(-1);
  if (region?.kind !== "math" || region.start !== opener || region.contentEnd !== at || region.end !== projected.length) return null;
  return { file, closer, region: { ...region, start: body.start + opener, end: body.start + at,
    contentStart: body.start + region.contentStart, contentEnd: body.start + at } };
}

async function compiledSource(map, file) {
  const overlay = map.files.get(path.relative(map.root, file));
  if (typeof overlay === "string") return overlay;
  if (overlay?.unavailable) return null;
  if (overlay?.snapshot) {
    if (isMainThread) throw Object.assign(new Error("Inspect staged source in worker"), { code: "LARGE_EDIT_SOURCE" });
    return fs.readFile(overlay.snapshot, "utf8");
  }
  // A clean include is eligible only while its bytes still belong to this
  // compilation. Check both ends of the read, including the path after rename.
  const stable = stat => stat?.isFile() && Math.max(stat.ctimeMs, stat.mtimeMs) < map.started;
  const before = await fs.stat(file).catch(() => null);
  if (!stable(before)) return null;
  if (before.size > INLINE_EDIT_BYTES && isMainThread) {
    throw Object.assign(new Error("Inspect large include in worker"), { code: "LARGE_EDIT_SOURCE" });
  }
  const bytes = await readFileUpTo(file, before.size).catch(() => null);
  const after = await fs.stat(file).catch(() => null);
  return bytes && stable(after) && before.dev === after.dev && before.ino === after.ino &&
    before.ctimeMs === after.ctimeMs && before.size === after.size ? bytes.toString("utf8") : null;
}

function inlineMathOnLine(rows, point, regions) {
  const hits = [];
  for (const row of rows) {
    if (!row.author || row.start !== null || row.pairs.length !== regions.length) continue;
    for (const [i, [left, right]] of row.pairs.entries()) {
      if (point.x >= left && point.x <= right) hits.push({ region: regions[i], box: { left, right, top: row.box.top, bottom: row.box.bottom } });
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

const inspected = new WeakMap();
const lastPage = new WeakMap();
async function inspectedSource(map, file) {
  const cached = inspected.get(map);
  if (cached?.file === file) return cached;
  const sourceText = await compiledSource(map, file);
  if (!sourceText) return null;
  const { discoverEditRegions } = await load("edit-regions.js");
  let regions = discoverEditRegions(sourceText);
  if (map.unfinished?.file === file) {
    const pending = map.unfinished.region;
    regions = [...regions.filter(r => r.end <= pending.start), pending,
      ...regions.filter(r => r.start >= pending.end && r.start > pending.start)];
  }
  const source = { file, sourceText, regions };
  inspected.set(map, source);
  return source;
}

function proseTarget(source, match, printed) {
  if (!match || match.needsOccurrences) return match;
  const { file, sourceText } = source;
  return { file, kind: "text", sourceText, baseValue: sourceText.slice(match.a, match.b), visibleValue: printed,
    offsets: match.offsets, start: position(sourceText, match.a), end: position(sourceText, match.b) };
}

async function sheetAt(map, syncFile, page, signal) {
  const { readSyncTeXSourcePage } = await load("checkpoint/pdf-source-boxes.js");
  let cached = lastPage.get(map);
  if (cached?.page !== page) {
    const sheet = await readSyncTeXSourcePage(syncFile, page, { dvi: map.engine === "uplatex", cwd: map.cwd, signal });
    if (!sheet) return null;
    cached = { page, sheet };
    // Keep one modest page from the displayed compile. A second click on
    // that paper, including occurrence disambiguation, avoids a full gunzip.
    if (sheet.bytes <= 2 * 1024 * 1024) lastPage.set(map, cached);
    else lastPage.delete(map);
  }
  return cached.sheet;
}

async function editTargetAt(map, file, hit, point, syncFile, projectPath, printed, occurrences, signal, selectedSheet) {
  const source = await inspectedSource(map, file);
  if (!source) return null;
  const { sourceText, regions } = source;
  // Resolve the line once. Applying a position scan to every formula in a
  // book would make an otherwise local click quadratic.
  let lineStart = 0;
  for (let line = 1; line < hit.line; line++) {
    const newline = sourceText.indexOf("\n", lineStart);
    if (newline < 0) return null;
    lineStart = newline + 1;
  }
  const newline = sourceText.indexOf("\n", lineStart);
  const lineEnd = newline < 0 ? sourceText.length : newline;
  const candidates = regions.filter(r => r.kind === "math" &&
    r.end > lineStart && r.start <= lineEnd);
  // TeX can attach every dollar marker in a paragraph to the next
  // blank line or closing environment, including the letters inside math.
  const nextLineTag = /^\s*(?:$|\\(?:begin|end)\s*\{|\\par\b)/.test(sourceText.slice(lineStart, lineEnd));
  const previousStart = lineStart > 0 && nextLineTag ? sourceText.lastIndexOf("\n", lineStart - 2) + 1 : lineStart;
  const previousInline = previousStart < lineStart ? regions.filter(r => r.kind === "math" && !r.display &&
    r.start >= previousStart && r.end < lineStart) : [];
  if (!candidates.length && !previousInline.length && !printed) return null;
  const { sourceBoxesOnPage, visitSyncTeXSheets } = await load("checkpoint/pdf-source-boxes.js");
  const sheet = selectedSheet ?? await sheetAt(map, syncFile, point.page, signal);
  if (!sheet) return null;
  const sourceInputs = new Map();
  for (const [tag, name] of sheet.inputs) {
    if (projectPath(name) === file) sourceInputs.set(tag, { file });
  }
  const query = { page: point.page, sourceInputs };
  const allRows = horizontalRows(sheet, sourceInputs, hit.line);
  if (!allRows) return null;
  const rows = allRows.filter(row => contains(row.box, point));
  const boxesFor = (startLine, endLine) => sourceBoxesOnPage(sheet, { ...query, startLine, endLine });
  const sheetRowsBefore = async (startLine, endLine, total) => {
    const key = JSON.stringify([file, startLine, endLine, total]);
    if (sheet.alignmentPages?.key === key) return sheet.alignmentPages.before;
    let count = 0, before = 0;
    const ok = await visitSyncTeXSheets(syncFile, (page, lines) => {
      if (count > total || !lines.some(line => {
        const node = /^[(h](\d+),(\d+)[:,]/.exec(line);
        return node && sourceInputs.has(Number(node[1])) && Number(node[2]) >= startLine && Number(node[2]) <= endLine;
      })) return;
      const boxes = sourceBoxesOnPage({ ...sheet, lines }, { ...query, page, startLine, endLine });
      const bands = boxes && alignmentBands(boxes);
      if (!bands) { count = total + 1; return; }
      if (page < point.page) before += bands.length;
      count += bands.length;
    }, { dvi: map.engine === "uplatex", cwd: map.cwd, signal });
    const offset = ok && count === total ? before : null;
    // At most one display per cached sheet, including failed matches.
    sheet.alignmentPages = { key, before: offset };
    return offset;
  };
  const onInlineInk = rows.some(row => row.pairs.some(([left, right]) => point.x >= left && point.x <= right));
  const paragraph = onInlineInk && literalParagraph(sourceText, regions, lineStart, lineEnd, hit.line);
  if (paragraph) {
    const match = await paragraphMath(map, paragraph, allRows, point, sourceInputs,
      visit => visitSyncTeXSheets(syncFile, visit, { dvi: map.engine === "uplatex", cwd: map.cwd, signal }));
    if (match) return mathTarget(file, sourceText, match.region, match.box);
  }
  if (!paragraph && candidates.length) {
    const math = await matchMath(file, sourceText, candidates, lineStart, lineEnd, point, rows, boxesFor, printed, sheetRowsBefore);
    if (math) return math;
  }
  if (!paragraph && previousInline.length) {
    const math = await matchMath(file, sourceText, previousInline, previousStart, lineStart - 1, point, rows, boxesFor, printed, sheetRowsBefore);
    if (math) return math;
  }
  if (!printed || printed.length > 8192) return null;
  // A glyph can identify its source line even if TeX assigns its parent
  // hbox to the end of a multi-line paragraph.
  if (!rows.some(row => row.author || row.tagged)) return null;
  const boxes = allRows.filter(row => row.author || row.tagged);
  const match = matchProse(sourceText, regions, lineStart, lineEnd, printed,
    () => rows.every(row => row.start === null &&
      !row.pairs.some(([left, right]) => point.x >= left - 1 && point.x <= right + 1)), boxes, occurrences);
  if (match) return proseTarget(source, match, printed);
  // With \input, TeX may ship the child's final paragraph only after
  // returning to the next blank line in the parent. All of its glyph
  // records then name the parent, even though its prose is in the child.
  let inputStart = lineStart, inputEnd = lineEnd;
  if (!sourceText.slice(lineStart, lineEnd).trim() && lineStart > 0) {
    inputStart = sourceText.lastIndexOf("\n", lineStart - 2) + 1;
    inputEnd = lineStart - 1;
  }
  const input = /^\s*\\input\s*\{([^{}\\%]+)\}\s*(?:%[^\n]*)?$/.exec(sourceText.slice(inputStart, inputEnd));
  if (!input || (inputStart > 0 && sourceText.slice(sourceText.lastIndexOf("\n", inputStart - 2) + 1, inputStart - 1).trim())) return null;
  if (inputStart === lineStart) {
    const next = sourceText.indexOf("\n", lineEnd + 1);
    const afterInput = sourceText.slice(lineEnd + 1, next < 0 ? undefined : next).trim();
    if (afterInput && !/^\\(?:par\b|end\s*\{document\})/.test(afterInput)) return null;
  }
  const rel = input[1].trim();
  const name = /\.[^/\\.]+$/.test(rel) ? rel : rel + ".tex";
  if (!/\.(?:tex|ltx)$/i.test(name)) return null;
  const possible = new Set([path.resolve(path.dirname(file), name), path.resolve(map.root, name)]);
  const recorded = new Set([...sheet.inputs.values()].map(projectPath).filter(p => p && possible.has(p)));
  if (recorded.size !== 1) return null;
  const child = await inspectedSource(map, recorded.values().next().value);
  if (!child || /(?:\r?\n[ \t]*\r?\n|\\par)\s*$/.test(child.sourceText)) return null;
  const tail = child.sourceText.trimEnd().length;
  const last = child.sourceText.lastIndexOf("\n", tail - 1) + 1;
  return proseTarget(child, matchProse(child.sourceText, child.regions, last, tail, printed, () => false, boxes, occurrences), printed);
}

function matchMath(file, sourceText, candidates, lineStart, lineEnd, point, rows, boxesFor, printed, sheetRowsBefore) {
  let region, box, displayBoxes, rowsBefore;
  if (candidates.length === 1 && candidates[0].display) {
    region = candidates[0];
    const before = sourceText.slice(sourceText.lastIndexOf("\n", region.start - 1) + 1, region.start);
    const next = sourceText.indexOf("\n", region.end);
    const after = sourceText.slice(region.end, next < 0 ? sourceText.length : next);
    if (before.trim() || !/^\s*(?:%.*)?$/.test(after)) {
      // A paragraph and a display can share the same source line. Paragraph
      // hboxes fill the measure, while an ordinary display is a narrower,
      // centered sibling in the enclosing vertical list.
      if (/[\\{}%$#&^_~]/.test(before + after.replace(/%.*$/, ""))) return null;
      const displays = rows.filter(row => {
        if (!row.tagged || row.parent?.kind !== "[") return false;
        const leftInset = row.box.left - row.parent.box.left;
        const rightInset = row.parent.box.right - row.box.right;
        return leftInset > 1 && rightInset > 1 && Math.abs(leftInset - rightInset) < 1;
      });
      return displays.length === 1 ? mathTarget(file, sourceText, region, displays[0].box) : null;
    }
    // TeX assigns the preceding paragraph to the line that opens a display.
    // Its hbox is not part of a formula that starts on a subsequent line.
    const firstContent = region.contentStart + (region.sourceValue.match(/^\s*/)?.[0].length ?? 0);
    const startLine = position(sourceText, firstContent).line, endLine = position(sourceText, region.end).line;
    displayBoxes = boxesFor(startLine, endLine);
    rowsBefore = total => sheetRowsBefore(startLine, endLine, total);
    const hits = displayBoxes?.map(item => item.box).filter(bounds => point.x >= bounds.left - 1 && point.x <= bounds.right + 1 &&
      point.y >= bounds.top - 1 && point.y <= bounds.bottom + 1);
    if (!hits?.length) return null;
    const area = rect => (rect.right - rect.left) * (rect.bottom - rect.top);
    box = hits.reduce((best, item) => area(item) > area(best) ? item : best);
  } else {
    // Unexpanded prose and literal formulas have the same order in the line
    // of source and the shipped hbox. A macro might duplicate or reorder them.
    let cursor = lineStart;
    for (const part of candidates) {
      if (part.display || part.start < cursor || part.end > lineEnd ||
          /[\\{}%$#&^_~]/.test(sourceText.slice(cursor, part.start))) return null;
      cursor = part.end;
    }
    if (/[\\{}%$#&^_~]/.test(sourceText.slice(cursor, lineEnd))) return null;
    const match = inlineMathOnLine(rows, point, candidates);
    if (!match) return null;
    ({ region, box } = match);
  }
  return mathTarget(file, sourceText, region, box, printed, displayBoxes, point, rowsBefore);
}

// Split only at a row break belonging to this display. Breaks in a grouped
// expression or an inner matrix belong to that expression.
function alignmentRows(value) {
  const rows = [];
  const tokens = /\\(?:begin|end)\s*\{[^{}]*\}|\\(?:[a-zA-Z@]+|[\s\S])|%[^\r\n]*|[{}]/g;
  let start = 0, depth = 0;
  for (const token of value.matchAll(tokens)) {
    const command = token[0];
    if (token.index < start) continue;
    if (command === "{" || /^\\begin\s*\{/.test(command)) depth++;
    else if (command === "}" || /^\\end\s*\{/.test(command)) depth--;
    else if (/^\\(?:verb|intertext|shortintertext|cr|crcr|noalign)$/.test(command)) return null;
    else if (!depth && command === "\\\\") {
      rows.push({ offset: start, text: value.slice(start, token.index) });
      start = token.index + 2;
      const spacing = /^\*?(?:[ \t]*\[[^\]{}\\%]*\])?/.exec(value.slice(start))[0];
      start += spacing.length;
    }
    if (depth < 0) return null;
  }
  if (depth) return null;
  const last = value.slice(start);
  if (withoutComments(last).trim()) rows.push({ offset: start, text: last });
  return rows;
}

// An amsmath alignment ships one sibling hbox per row. Its nonzero-width
// direct children are cells. Equation tags hang from zero-width children.
function alignmentBands(boxes) {
  const byId = new Map(boxes.map(b => [b.id, b]));
  const parents = new Set();
  for (const cell of boxes) {
    const row = byId.get(cell.parentId);
    // TeX can ship the page header and footer on the display's closing
    // source line. A real alignment row has inset, nonempty cell material.
    if (row && !cell.empty && cell.box.right > cell.box.left &&
        (cell.box.left > row.box.left + 1 || cell.box.right < row.box.right - 1)) parents.add(row.id);
  }
  const rows = boxes.filter(b => b.parentKind === "vbox" && parents.has(b.id) && !b.ancestors.some(id => byId.has(id)));
  if (rows.some((r, i) => r.parentId !== rows[0].parentId || (i && r.y <= rows[i - 1].y))) return null;
  return rows;
}

async function alignmentInk(boxes, count, point, rowsBefore) {
  if (!boxes || !count) return null;
  const rows = alignmentBands(boxes);
  if (!rows?.length || rows.length > count) return null;
  const hits = rows.filter(r => contains(r.box, point));
  if (hits.length !== 1) return null;
  const row = hits[0];
  const cells = boxes.filter(b => b.parentId === row.id && b.box.right - b.box.left > 1);
  if (!cells.length) return null;
  const hitsInRow = cells.filter(cell => contains(cell.box, point));
  if (!hitsInRow.length) return { outside: true };
  const cell = hitsInRow.length === 1 ? { index: cells.indexOf(hitsInRow[0]), count: cells.length, box: hitsInRow[0].box } : null;
  const before = rows.length === count ? 0 : await rowsBefore(count);
  if (before === null) return null;
  return { index: before + rows.indexOf(row), count, cell, box: { left: Math.min(...cells.map(b => b.box.left)), right: Math.max(...cells.map(b => b.box.right)),
    top: row.box.top, bottom: row.box.bottom } };
}

function editableRow(row) {
  const tokens = /\\(?:label\s*\{[^{}%\\]*\}|tag\*?\s*\{[^{}%\\]*\}|[a-zA-Z@]+|[\s\S])|%[^\r\n]*/g;
  let cursor = 0, part = null;
  for (;;) {
    const token = tokens.exec(row.text);
    if (token) {
      const command = token[0];
      if (command === "\\verb") return null;
      if (command[0] !== "%" && !/^\\(?:label\s*\{|tag\*?\s*\{|notag$|nonumber$)/.test(command)) continue;
    }
    const text = row.text.slice(cursor, token?.index ?? row.text.length);
    const value = text.trim();
    if (value) {
      // A comment or numbering command inside the expression would split
      // its source into two ranges. Keep both sides intact.
      if (part || /\\(?:label|tag|notag|nonumber)\b/.test(value)) return null;
      part = { value, offset: row.offset + cursor + text.length - text.trimStart().length };
    }
    if (!token) return part;
    cursor = token.index + token[0].length;
  }
}

function labeledRow(rows, printed, ink) {
  if (ink) return editableRow(rows[ink.index]);
  // A display can span pages. Without the full row geometry, a unique
  // printed literal can still identify a source row.
  if (typeof printed !== "string" || !/^[A-Za-z]+$/.test(printed)) return null;
  let match;
  for (const row of rows) {
    if (/\\tag\b/.test(row.text)) return null;
    const part = editableRow(row);
    if (!part || !/^[\sA-Za-z0-9=+*/().,&^_{}-]*$/.test(part.value)) return null;
    if (part.value.replace(/[\s&{}_^]/g, "").includes(printed)) {
      if (match) return null;
      match = part;
    }
  }
  return match;
}

async function mathTarget(file, sourceText, region, box, printed, boxes, point, rowsBefore) {
  const commented = region.value !== region.sourceValue;
  if (commented && region.value !== withoutComments(region.sourceValue)) return null;
  // Labels at either end belong to the document. Exclude them from the edit
  // range altogether, including their original whitespace.
  const prefix = /^(?:\s*\\label\s*\{[^{}%]*\})*\s*/.exec(region.sourceValue)[0];
  let trimmed = region.sourceValue.slice(prefix.length).replace(/(?:\s*\\label\s*\{[^{}%]*\})*\s*$/, "");
  if (!trimmed) return null;
  const environments = (commented ? region.value : trimmed).matchAll(/\\(?:begin|end)\s*\{([^}]+)\}/g);
  for (const [, name] of environments) {
    if (!/^(?:[pbBvV]?matrix|cases|aligned|gathered)$/.test(name)) return null;
  }
  const delimiter = sourceText.slice(region.start, region.contentStart);
  if (/\\begin\s*\{(?:alignat|xalignat|xxalignat)\*?\}/.test(delimiter)) return null;
  const wrap = /\\begin\s*\{(?:align|gather|multline|flalign)\*?\}/.test(delimiter)
    ? (/gather|multline/.test(delimiter) ? "gathered" : "aligned") : null;
  let start = region.contentStart + prefix.length;
  const rows = wrap && alignmentRows(trimmed);
  const ink = rows && await alignmentInk(boxes, rows.length, point, rowsBefore);
  if (ink?.outside) return null;
  let alignment = ink;
  if (commented || /\\(?:label|tag|notag|nonumber)\b/.test(trimmed)) {
    const row = rows ? labeledRow(rows, printed, ink) : (!wrap && commented && editableRow({ text: trimmed, offset: 0 }));
    if (!row) return null;
    start += row.offset;
    trimmed = row.value;
    if (ink) alignment = { ...ink, index: 0, count: 1 };
  }
  return { file, start: position(sourceText, start), end: position(sourceText, start + trimmed.length),
    sourceText, baseValue: trimmed, kind: "math", box, wrap, alignment };
}

async function resolveTarget(map, file, hit, point, syncFile, printed, occurrences, signal, jumpOnly) {
  const projectPath = name => recordedProjectPath(map, name);
  let sheet;
  if (!hit) {
    sheet = await sheetAt(map, syncFile, point.page, signal);
    if (!sheet || sheet.lines.some(line => /^[<>f]/.test(line))) return null;
    hit = reverseOnSheet(sheet, point);
    file = hit && projectPath(hit.path);
    if (!file) return null;
    if (jumpOnly) return { ok: true, path: file, line: hit.line, column: hit.column };
    if (!/\.(?:tex|ltx)$/i.test(file)) return null;
  }
  return editTargetAt(map, file, hit, point, syncFile, projectPath, printed, occurrences, signal, sheet);
}

async function lookupEditTarget(map, file, hit, point, syncFile, printed, occurrences, signal, jumpOnly = false) {
  if (hit && typeof map.sync !== "string") {
    try {
      return await resolveTarget(map, file, hit, point, syncFile, printed, occurrences, signal, jumpOnly);
    } catch (error) {
      if (error.code !== "LARGE_EDIT_SOURCE") throw error;
    }
  }
  if (signal.aborted) return null;
  // The SyncTeX file already exists for this click. Avoid copying its
  // compressed contents to the worker as part of the source map.
  const { sync, ...sourceMap } = map;
  const recent = lastPage.get(map);
  const cached = recent?.page === point.page ? recent : null;
  const worker = new Worker(__filename, { workerData: { map: sourceMap, file, hit, point, syncFile, printed, occurrences, cached, jumpOnly },
    resourceLimits: { maxOldGenerationSizeMb: 256 } });
  return new Promise((resolve, reject) => {
    let target = null, failure = null;
    const stop = () => { void worker.terminate(); };
    signal.addEventListener("abort", stop, { once: true });
    worker.once("message", message => {
      target = message.target;
      if (message.cached && !signal.aborted) lastPage.set(map, message.cached);
      else if (!signal.aborted && message.alignmentPages && cached === lastPage.get(map)) {
        cached.sheet.alignmentPages = message.alignmentPages;
      }
    });
    worker.once("error", error => { failure = error; });
    worker.once("exit", code => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) resolve(null);
      else if (failure || code !== 0) reject(failure ?? new Error("Source lookup worker exited: " + code));
      else resolve(target);
    });
  });
}

if (!isMainThread && workerData?.syncFile && parentPort) {
  const { map, file, hit, point, syncFile, printed, occurrences, cached, jumpOnly } = workerData;
  if (cached) lastPage.set(map, cached);
  resolveTarget(map, file, hit, point, syncFile, printed, occurrences, undefined, jumpOnly)
    .then(target => parentPort.postMessage({ target, cached: cached ? null : lastPage.get(map), alignmentPages: cached?.sheet.alignmentPages }));
}

module.exports = { editTargetAt, lookupEditTarget, emptyBodyInsertion, unfinishedFormula };
