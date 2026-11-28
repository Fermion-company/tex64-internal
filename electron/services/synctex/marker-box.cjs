"use strict";

/**
 * The region a forward Jump marks on the page.
 *
 * SyncTeX's `view` answer is one record and one box; the marker used to be
 * that box, which covered only the first typeset line of a long source line
 * and, inside amsmath displays, not the row at all: align, gather, multline
 * and split collect their body and typeset it when \end is read, so every row
 * is recorded under the \end line, and a \begin line's only records sit on
 * the paragraph line above.
 *
 * Here the marker is the union of the typeset lines (hboxes that sit directly
 * in a vertical list) that hold the source line's records. Inside a display,
 * the rows are the typeset lines recorded under the environment's closing
 * line, and the cursor's row is picked by counting top-level \\ in the source.
 */

const DISPLAY_ENV = /^(?:equation|align|gather|multline|flalign|alignat|eqnarray|displaymath)\*?$/;
const ROW_ENV = /^(?:align|gather|multline|flalign|alignat|eqnarray|split|aligned|gathered|alignedat|multlined)\*?$/;

const stripComment = (line) => {
  let out = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\") {
      out += line.slice(i, i + 2);
      i += 1;
    } else if (ch === "%") {
      break;
    } else {
      out += ch;
    }
  }
  return out;
};

/**
 * Environments and their top-level row separators, from the source text.
 * Returns [{ name, beginLine, endLine, rows: [{ line, col, end }], tail }] with
 * 1-based lines; `tail` says whether text follows the last separator.
 */
const parseEnvironments = (lines) => {
  const done = [];
  const stack = [];
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const text = stripComment(String(lines[index] ?? ""));
    for (let col = 0; col < text.length; col += 1) {
      const rest = text.slice(col);
      let match;
      if ((match = /^\\begin\s*\{([^}]+)\}/.exec(rest))) {
        stack.push({ name: match[1].trim(), beginLine: lineNo, depth, rows: [], tail: false });
        col += match[0].length - 1;
        continue;
      }
      if ((match = /^\\end\s*\{([^}]+)\}/.exec(rest))) {
        const name = match[1].trim();
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i].name === name) {
            const [env] = stack.splice(i);
            env.endLine = lineNo;
            done.push(env);
            break;
          }
        }
        col += match[0].length - 1;
        continue;
      }
      if (rest.startsWith("\\[")) {
        stack.push({ name: "\\[", beginLine: lineNo, depth, rows: [], tail: false });
        col += 1;
        continue;
      }
      if (rest.startsWith("\\]")) {
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i].name === "\\[") {
            const [env] = stack.splice(i);
            env.endLine = lineNo;
            done.push(env);
            break;
          }
        }
        col += 1;
        continue;
      }
      if (rest.startsWith("\\\\")) {
        // The separator with its star and spacing (\\*, \\[1ex]): `end` is
        // where the next row's text starts.
        const separator = /^\\\\\*?(?:\s*\[[^\]]*\])?/.exec(rest);
        const end = col + separator[0].length;
        const top = stack[stack.length - 1];
        if (top && top.depth === depth) {
          top.rows.push({ line: lineNo, col, end });
          top.tail = false;
        }
        col = end - 1;
        continue;
      }
      const ch = text[col];
      if (ch === "\\") {
        col += 1;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      else if (!/\s/.test(ch)) {
        const top = stack[stack.length - 1];
        if (top && top.depth === depth) top.tail = true;
      }
    }
  }
  return done;
};

/**
 * Where a cursor line inside a display lands: the closing line whose records
 * hold the rows, and which rows. null outside displays.
 */
const analyzeDisplayMath = (lines, cursorLine) => {
  const envs = parseEnvironments(lines);
  const containing = envs.filter((env) => env.beginLine <= cursorLine && cursorLine <= env.endLine);
  const display = containing
    .filter((env) => env.name === "\\[" || DISPLAY_ENV.test(env.name))
    .sort((a, b) => (b.beginLine - a.beginLine) || (a.endLine - b.endLine))[0];
  if (!display) return null;
  const rowEnv = containing
    .filter((env) => ROW_ENV.test(env.name) && env.beginLine >= display.beginLine && env.endLine <= display.endLine)
    .sort((a, b) => (b.beginLine - a.beginLine) || (a.endLine - b.endLine))[0];
  if (cursorLine === display.beginLine || cursorLine === display.endLine || !rowEnv) {
    return { closingLine: display.endLine, all: true };
  }
  if (cursorLine === rowEnv.beginLine || cursorLine === rowEnv.endLine) {
    return { closingLine: rowEnv.endLine, all: true };
  }
  const before = rowEnv.rows.filter((row) => row.line < cursorLine).length;
  const onLine = rowEnv.rows.filter((row) => row.line === cursorLine);
  const text = stripComment(String(lines[cursorLine - 1] ?? ""));
  // Rows this line contributes text to: one per segment between its own
  // separators that is not blank.
  const cuts = [0, ...onLine.map((row) => row.col), text.length];
  let firstRow = null;
  let lastRow = null;
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const segment = text.slice(i === 0 ? cuts[i] : onLine[i - 1].end, cuts[i + 1]);
    if (!segment.trim()) continue;
    const row = before + i;
    if (firstRow === null) firstRow = row;
    lastRow = row;
  }
  if (firstRow === null) return { closingLine: rowEnv.endLine, all: true };
  const totalRows = rowEnv.rows.length + (rowEnv.tail ? 1 : 0);
  return { closingLine: rowEnv.endLine, all: false, firstRow, lastRow, totalRows };
};

const HEADING = /^\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/;
const ITEM = /^\\item\b/;
const STRUCTURE = /^\\(?:begin|end|label|centering|clearpage|newpage)\s*(?:\{[^}]*\}(?:\[[^\]]*\]|<[^>]*>|\{[^}]*\})*)?\s*$/;
const NOTE = /\\(?:footnote|marginpar)\s*\{/;
const ownersByIndex = new WeakMap();

// TeX's line box owns the paragraph-end tag. A leading indent or list
// label identifies where it actually began. Once that paragraph wraps, its
// later boxes keep the same end tag, including after a page/column break.
// On tate pages the glyph tags themselves are assigned during shipout.
const sourceBoxOwners = (index, tag, lines) => {
  let byText = ownersByIndex.get(index);
  if (!byText) ownersByIndex.set(index, byText = new WeakMap());
  let byTag = byText.get(lines);
  if (!byTag) byText.set(lines, byTag = new Map());
  if (byTag.has(tag)) return byTag.get(tag);
  const byLine = new Map();
  const byPage = new Map();
  const paragraphs = new Map();
  const text = (line) => stripComment(lines[line - 1] ?? "").trim();
  const hasText = (line) => Boolean(text(line)) && !STRUCTURE.test(text(line));
  const footnotes = lines.flatMap((_, i) => /\\footnote\s*\{/.test(text(i + 1)) ? [i + 1] : []);
  const displays = new Map();
  for (const { name, beginLine, endLine } of parseEnvironments(lines)) {
    if (name !== "\\[" && !DISPLAY_ENV.test(name)) continue;
    const body = lines.slice(beginLine, endLine - 1).flatMap((_, i) => {
      const line = beginLine + i + 1;
      return hasText(line) ? [line] : [];
    });
    displays.set(endLine, body.length === 1 ? body[0] : null);
  }
  for (const [page, records] of index.pages) {
    let previousColumn = 0;
    for (const box of records.lines) {
      if (box.tag !== tag || !(box.w > 0 && box.ht + box.dp > 0) || !box.glyphSources?.size) continue;
      const tate = box.direction === "tate";
      const source = box.line;
      if (displays.has(source) && !displays.get(source)) continue;
      const sourceText = text(source);
      const parent = records.lines[box.enclosing];
      const group = `${source}:${box.level}:${box.direction ?? ""}`;
      const glyphCount = [...box.glyphSources.values()].reduce((sum, count) => sum + count, 0);
      // An inline heading generated by jlreq can be tagged with the line
      // read after the heading. Its text is in a nested box with the same
      // cross-section as the heading or inside its multi-column wrapper.
      const wrapped = parent?.tag === tag && parent.line === source && parent.direction === box.direction &&
        (tate ? parent.ht >= box.ht : parent.w === box.w) && !parent.glyphSources?.size;
      const heading = wrapped && HEADING.test(text(source - 1)) && !box.paragraphStart ? source - 1
        : HEADING.test(sourceText) ? source : null;
      const label = ITEM.test(text(box.labelLine)) ? box.labelLine : null;
      const start = label ?? box.paragraphStart;
      if (start && hasText(start) && !HEADING.test(text(start))) paragraphs.set(group, { start, page, list: box.list });
      const paragraph = paragraphs.get(group);
      const beginning = paragraph && (tate || paragraph.page !== page || paragraph.list === box.list) ? paragraph.start : null;
      // Keep genuine multi-source typeset rows on the glyph-based path.
      const laterText = beginning && lines.slice(beginning, source - 1).some((_line, offset) => hasText(beginning + offset + 1));
      let owner = displays.get(source) ?? (!laterText && beginning &&
        (source === beginning || !hasText(source) || ITEM.test(sourceText)) ? beginning : null);
      if (!owner && heading && (tate || glyphCount > 1)) owner = heading;
      // An insertion at the end of a tate page can keep the tag of an
      // earlier item read while the output routine placed it. When this
      // input has a single footnote, the backward tag and repeated item
      // distinguish its delayed column from the already placed list item.
      if (!owner && tate && !start && ITEM.test(sourceText) && source < previousColumn &&
          byLine.has(source) && footnotes.length === 1 && byLine.has(footnotes[0])) owner = footnotes[0];
      if (!owner && !hasText(source) && hasText(source - 1) && (tate || glyphCount > 1)) owner = source - 1;
      if (!owner && NOTE.test(sourceText) && (box.glyphSources.get(`${tag}:${source}`) ?? 0) >= glyphCount / 2) owner = source;
      if (!owner && tate) owner = source;
      if (!owner) continue;
      if (tate && box.level === 0) previousColumn = owner;
      const owned = { page, box, line: owner };
      if (!byLine.has(owner)) byLine.set(owner, []);
      byLine.get(owner).push(owned);
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page).push(owned);
    }
  }
  const owners = { byLine, byPage };
  byTag.set(tag, owners);
  return owners;
};

const rectForBox = (index, box, tate) => {
  // A PDF extractor's rotated font box can overhang the nominal advance.
  const pad = tate ? Math.min(index.toPoints(box.w, 0) * 0.35, 7) : 0;
  const side = Math.min(pad, 4);
  const labelStart = tate ? box.spans.get(`${box.tag}:${box.labelLine}`)?.[0] : null;
  let top = box.v - box.ht;
  let bottom = box.v + box.dp;
  if (tate && Number.isFinite(box.glyphTop) && Number.isFinite(box.glyphBottom)) {
    top = Math.max(top, box.glyphTop - box.w);
    bottom = Math.min(bottom, box.glyphBottom + box.w);
  }
  if (labelStart != null) top = Math.min(top, box.v - box.ht + labelStart - box.rawH);
  return {
    x: index.toPoints(box.h, index.xOffset) - side,
    y: index.toPoints(top, index.yOffset) - pad,
    width: index.toPoints(box.w, 0) + 2 * side,
    height: index.toPoints(bottom - top, 0) + 2 * pad,
  };
};

module.exports = (SynctexService) => {
  SynctexService.prototype.reverseBoxOwner = function (index, { page, x, y }) {
    const records = index.pages.get(page);
    if (!records) return null;
    const h = index.toUnits(x, index.xOffset);
    const v = index.toUnits(y, index.yOffset);
    const contains = (box) => box.direction !== "tate" && h >= box.h && h <= box.h + box.w &&
      v >= box.v - box.ht && v <= box.v + box.dp;
    let pick = null;
    for (const tag of new Set(records.lines.filter(contains).map((box) => box.tag))) {
      const sourcePath = index.inputs.get(tag);
      if (!/\.(?:tex|ltx)$/i.test(sourcePath ?? "")) continue;
      const lines = this.getSourceLines(sourcePath);
      if (!lines) continue;
      for (const { box, line } of sourceBoxOwners(index, tag, lines).byPage.get(page) ?? []) {
        if (!contains(box)) continue;
        const area = box.w * (box.ht + box.dp);
        if (!pick || area < pick.area) pick = { path: sourcePath, line, area };
      }
    }
    return pick && { path: pick.path, line: pick.line, column: 1, distance: 0, exact: true, boxOwner: true };
  };

  SynctexService.prototype.forwardOwnedMarker = function ({ pdfPath, sourcePath, line, lines: givenLines = null, toEnd = false }) {
    const synctexPath = this.findSynctexOutputPath(pdfPath);
    const index = synctexPath ? this.loadForwardIndex(synctexPath) : null;
    if (!index) return null;
    const lines = givenLines ?? this.getSourceLines(sourcePath);
    if (!lines) return null;
    const source = stripComment(lines[line - 1] ?? "").trim();
    if (!source || STRUCTURE.test(source)) return null;
    let ink = this.findForwardTags(index, sourcePath).flatMap((tag) => sourceBoxOwners(index, tag, lines).byLine.get(line) ?? []);
    const tate = ink.some(({ box }) => box.direction === "tate");
    if (!tate && HEADING.test(source) && new Set(ink.map(({ page }) => page)).size > 1) {
      const largest = Math.max(...ink.map(({ box }) => box.ht + box.dp));
      ink = ink.filter(({ box }) => box.ht + box.dp >= largest * 0.65);
    }
    const pages = new Map();
    for (const { page, box } of ink) {
      if (tate !== (box.direction === "tate")) continue;
      if (!pages.has(page)) pages.set(page, []);
      pages.get(page).push(rectForBox(index, box, tate));
    }
    const parts = [...pages].sort(([a], [b]) => a - b).map(([page, rects]) => ({
      page,
      rects: rects.filter((rect, i) => !rects.some((other, j) => i !== j &&
        other.x <= rect.x && other.y <= rect.y && other.x + other.width >= rect.x + rect.width &&
        other.y + other.height >= rect.y + rect.height && (j < i || other.width > rect.width || other.height > rect.height))),
    }));
    const part = toEnd ? parts.at(-1) : parts[0];
    if (!part) return null;
    const { page, rects } = part;
    const left = Math.min(...rects.map((box) => box.x));
    const top = Math.min(...rects.map((box) => box.y));
    const right = Math.max(...rects.map((box) => box.x + box.width));
    const bottom = Math.max(...rects.map((box) => box.y + box.height));
    return { page, x: left, y: top, width: right - left, height: bottom - top, rects,
      ...(tate ? { direction: "tate" } : {}),
      ...(parts.length > 1 ? { pageRects: parts } : {}) };
  };

  /**
   * { page, x, y, width, height } in PDF points (y from the top) for the
   * marker of `line` in `sourcePath`, or null to keep SyncTeX's own box.
   */
  SynctexService.prototype.forwardMarkerBox = function ({ pdfPath, sourcePath, line, page, x, y, pageTrusted = false,
    lines: givenLines = null }) {
    const synctexPath = this.findSynctexOutputPath?.(pdfPath);
    const index = synctexPath ? this.loadForwardIndex(synctexPath) : null;
    if (!index || !Number.isInteger(line) || line < 1) return null;
    const tags = this.findForwardTags(index, sourcePath);
    if (!tags.length) return null;
    // the text the Build read when the caller has it (`line` is numbered so)
    const lines = Array.isArray(givenLines) ? givenLines : this.getSourceLines?.(sourcePath) ?? null;
    let math = Array.isArray(lines) ? analyzeDisplayMath(lines, line) : null;

    // page -> Map(lineIndex -> hits) for one source line.
    const collect = (sourceLine) => {
      const byPage = new Map();
      for (const tag of tags) {
        const pages = index.byTag.get(tag)?.get(sourceLine);
        if (!pages) continue;
        for (const [pageNo, entry] of pages) {
          if (!entry.lineHits?.size) continue;
          const merged = byPage.get(pageNo) ?? new Map();
          for (const [lineIndex, count] of entry.lineHits) merged.set(lineIndex, (merged.get(lineIndex) ?? 0) + count);
          byPage.set(pageNo, merged);
        }
      }
      return byPage;
    };
    // eqnarray, aligned and arrays typeset each row as it is read: a row
    // line with records of its own is marked from them. amsmath's collected
    // environments (align, gather, multline, split) leave the row lines bare
    // and are marked from their closing line.
    if (math && !math.all && collect(line).size) math = null;
    const hits = collect(math ? math.closingLine : line);
    if (!hits.size) return null;
    // the caller's page is none of this line's (an \input line stands for its file): no box of this line there
    if (pageTrusted === true && Number.isInteger(page) && !hits.has(page)) return null;
    const total = (map) => [...map.values()].reduce((sum, value) => sum + value, 0);
    let pageNo = Number.isInteger(page) && hits.has(page) ? page : null;
    let best = null;
    for (const [candidate, map] of hits) if (!best || total(map) > total(hits.get(best))) best = candidate;
    // Records an output routine left on a page (a page break while this line
    // was read) are few; the text itself is where most of them are.
    // (a page the caller already chose among this line's pages stays: the
    // page a chapter heading ships carries more of its records, drawn by the
    // output routine from top to bottom, than the heading's own page)
    const keep = pageTrusted === true && pageNo !== null;
    if (pageNo === null || (!keep && total(hits.get(pageNo)) * 3 < total(hits.get(best)))) pageNo = best;
    let pageLines = index.pages.get(pageNo)?.lines ?? [];
    // A typeset line recorded under an earlier line of the same file was
    // finished before this source line was read: its records here are what
    // the output routine stamped at a page break, not this line's text.
    const sourceLineNo = math ? math.closingLine : line;
    const genuine = (candidatePage, lineIndex) => {
      const box = index.pages.get(candidatePage)?.lines?.[lineIndex];
      return box && !(tags.includes(box.tag) && box.line < sourceLineNo);
    };
    for (const [candidate, map] of [...hits]) {
      for (const lineIndex of [...map.keys()]) if (!genuine(candidate, lineIndex)) map.delete(lineIndex);
      if (!map.size) hits.delete(candidate);
    }
    if (!hits.size) return null;
    if (!hits.has(pageNo)) {
      pageNo = null;
      for (const [candidate, map] of hits) if (pageNo === null || total(map) > total(hits.get(pageNo))) pageNo = candidate;
    } else if (!keep) {
      for (const [candidate, map] of hits) if (total(map) > total(hits.get(pageNo)) * 3) pageNo = candidate;
    }
    pageLines = index.pages.get(pageNo)?.lines ?? [];
    if (!math) {
      // LuaTeX tags the first word of every typeset line with the line that
      // ends the paragraph. A source line whose text runs to the end of a
      // typeset line continues onto the next one of the same paragraph even
      // when that one holds no record of it, as long as no later source
      // line has text there.
      const hitSet = hits.get(pageNo);
      // Vertical writing (LuaTeX-ja tate): its glyph records carry the line
      // TeX was reading when the page shipped, not their own (forward-index),
      // so glyph counts say nothing about whose text a column holds.
      const tate = [...hitSet.keys()].some((lineIndex) => pageLines[lineIndex]?.direction === "tate");
      // A typeset line where this source line left spacing but no glyph
      // (the \par of the previous item, the look-ahead after a table row's
      // \\) is not where its text is.
      const key = (tag) => `${tag}:${line}`;
      const ownGlyphs = (box) => tags.reduce((sum, tag) => sum + (box.glyphSources?.get(key(tag)) ?? 0), 0);
      // Glyphs of other source lines, leaving out the first word that
      // LuaTeX tags with the paragraph's end line.
      const otherGlyphs = (box, below = Infinity) => [...(box.glyphSources ?? new Map())]
        .filter(([source]) => source !== `${box.tag}:${box.line}`)
        .filter(([source]) => {
          const [sourceTag, sourceLine] = source.split(":").map(Number);
          return !(tags.includes(sourceTag) && sourceLine === line) && (!tags.includes(sourceTag) || sourceLine < below);
        })
        .reduce((sum, [, count]) => sum + count, 0);
      // A paragraph that this line ended (an \item, an eqnarray row): what
      // TeX and LuaTeX-ja added while finishing it is tagged with this line,
      // but its text belongs to earlier lines.
      for (const lineIndex of [...hitSet.keys()]) {
        if (tate || hitSet.size < 2) break;
        const box = pageLines[lineIndex];
        if (box && tags.includes(box.tag) && box.line === line && otherGlyphs(box, line) > 0) hitSet.delete(lineIndex);
      }
      // Reading order of typeset lines: down the page, or in vertical
      // writing right to left across the columns.
      const order = (box) => (box.direction === "tate" ? -box.h : box.v);
      // (only lines written the same way: a folio row on a tate page is no column)
      const sameWay = (other, box) => other.direction === box.direction;
      const previousLine = (box) => pageLines
        .filter((other) => other.tag === box.tag && other.line === box.line && other.level === box.level && sameWay(other, box) &&
          order(other) < order(box))
        .sort((a, b) => order(b) - order(a))[0];
      const continues = (box) => {
        const previous = previousLine(box);
        return Boolean(previous && hitSet.has(pageLines.indexOf(previous)) &&
          tags.includes(previous.lastLeaf?.tag) && previous.lastLeaf?.line === line);
      };
      // Only spacing of this line here, around other lines' text — unless
      // its text runs on from the previous typeset line.
      for (const lineIndex of [...hitSet.keys()]) {
        if (tate || hitSet.size < 2) break;
        const box = pageLines[lineIndex];
        if (box && ownGlyphs(box) === 0 && otherGlyphs(box) > 0 && !continues(box)) hitSet.delete(lineIndex);
      }
      const following = (box) => pageLines
        .filter((other) => other.tag === box.tag && other.line === box.line && other.level === box.level && sameWay(other, box) &&
          order(other) > order(box))
        .sort((a, b) => order(a) - order(b))[0];
      for (const lineIndex of [...hitSet.keys()]) {
        let box = pageLines[lineIndex];
        while (box?.lastLeaf && tags.includes(box.lastLeaf.tag) && box.lastLeaf.line === line) {
          const next = following(box);
          if (!next) break;
          const nextIndex = pageLines.indexOf(next);
          if (hitSet.has(nextIndex)) break;
          const others = [...(next.sources ?? new Map()).keys()].some((key) => {
            const [keyTag, keyLine] = key.split(":").map(Number);
            return tags.includes(keyTag) && keyLine > line && keyLine < next.line;
          });
          if (others) break;
          hitSet.set(nextIndex, 1);
          box = next;
        }
      }
      if (tate) {
        // A paragraph's columns share the tag of the line that ends it: the
        // source line runs on through the following columns of that group
        // until a later source line of the paragraph starts in one.
        for (const lineIndex of [...hitSet.keys()]) {
          let box = pageLines[lineIndex];
          if (!box || box.direction !== "tate" || (box.level ?? 0) !== 0 || !(box.line > line)) continue;
          for (let next = following(box); next; next = following(box)) {
            const others = [...(next.sources ?? new Map()).keys()].some((key) => {
              const [keyTag, keyLine] = key.split(":").map(Number);
              return tags.includes(keyTag) && keyLine > line && keyLine < next.line;
            });
            if (others) break;
            hitSet.set(pageLines.indexOf(next), 1);
            box = next;
          }
        }
        // The columns themselves: a box inside one (ruby, a fraction) is in it.
        if ([...hitSet.keys()].some((lineIndex) => (pageLines[lineIndex]?.level ?? 0) === 0)) {
          for (const lineIndex of [...hitSet.keys()]) {
            if ((pageLines[lineIndex]?.level ?? 0) > 0) hitSet.delete(lineIndex);
          }
        }
      }
    }
    let boxes = [...hits.get(pageNo).keys()]
      .map((lineIndex) => pageLines[lineIndex])
      .filter((box) => box && box.w > 0 && box.ht + box.dp > 0);
    if (!boxes.length) return null;
    const top = (box) => box.v - box.ht;
    const bottom = (box) => box.v + box.dp;

    if (math) {
      // The rows are the typeset lines at one nesting level: align rows are
      // lines of the page, split rows sit inside their equation line, and a
      // fraction's numerator sits inside its row. The level whose count
      // matches the source's rows is the one to pick from.
      if (!math.all) {
        const levels = new Map();
        for (const box of boxes) {
          const level = box.level ?? 0;
          if (!levels.has(level)) levels.set(level, []);
          levels.get(level).push(box);
        }
        for (const level of [...levels.keys()].sort((a, b) => a - b)) {
          const rows = levels.get(level).sort((a, b) => a.v - b.v);
          if (rows.length === math.totalRows && math.lastRow < rows.length) {
            boxes = rows.slice(math.firstRow, math.lastRow + 1);
            break;
          }
        }
      }
    } else {
      // One marker for one place: a footnote (or a float) typeset from the
      // same source line is a separate cluster; keep the one with the point.
      const sorted = [...boxes].sort((a, b) => a.v - b.v);
      const clusters = [];
      for (const box of sorted) {
        const last = clusters[clusters.length - 1];
        const lastBox = last?.[last.length - 1];
        const gap = lastBox ? top(box) - bottom(lastBox) : Infinity;
        if (last && gap <= Math.max(lastBox.ht + lastBox.dp, box.ht + box.dp) * 1.2) last.push(box);
        else clusters.push([box]);
      }
      if (clusters.length > 1) {
        const pointV = Number.isFinite(y) && pageNo === page ? index.toUnits(y, index.yOffset) : null;
        const pageHits = hits.get(pageNo);
        const weight = (cluster) => cluster.reduce((sum, box) => sum + (pageHits.get(pageLines.indexOf(box)) ?? 0), 0);
        const holding = pointV === null ? null
          : clusters.find((cluster) => top(cluster[0]) - index.toUnits(3, 0) <= pointV &&
            pointV <= bottom(cluster[cluster.length - 1]) + index.toUnits(3, 0));
        const heaviest = clusters.reduce((a, b) => (weight(b) > weight(a) ? b : a));
        // SyncTeX's point can sit on a stray record (an \item's leftovers on
        // the previous item's line); it wins only with real text behind it.
        boxes = holding && weight(holding) * 3 >= weight(heaviest) ? holding : heaviest;
      }
    }
    const shrinkTall = () => {
      // A line made tall by something of other source lines (a table or
      // array placed in the paragraph) is marked at an ordinary line's
      // height around its baseline, so the marker does not cover the table.
      const ordinary = pageLines.filter((box) => (box.level ?? 0) === 0 && box.w > 0 && box.ht + box.dp > 0);
      const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
      const typicalHt = median(ordinary.map((box) => box.ht));
      const typicalDp = median(ordinary.map((box) => box.dp));
      const hitIndices = new Set(hits.get(pageNo).keys());
      boxes = boxes.map((box) => {
        if (!(typicalHt + typicalDp > 0) || box.ht + box.dp <= (typicalHt + typicalDp) * 2.2) return box;
        const foreign = pageLines.filter((other, otherIndex) =>
          (other.level ?? 0) > (box.level ?? 0) && !hitIndices.has(otherIndex) &&
          other.v - other.ht >= box.v - box.ht - 1 && other.v + other.dp <= box.v + box.dp + 1 &&
          other.h >= box.h - 1 && other.h + other.w <= box.h + box.w + 1);
        if (!foreign.length) return box;
        // Beside the table on its baseline: stop the marker at the table's
        // edge on the side where this line's text is.
        const own = tags.map((tag) => box.spans?.get(`${tag}:${line}`)).filter(Boolean);
        const ownMin = Math.min(...own.map((span) => span[0]));
        const ownMax = Math.max(...own.map((span) => span[1]));
        const foreignLeft = Math.min(...foreign.map((other) => other.h));
        const foreignRight = Math.max(...foreign.map((other) => other.h + other.w));
        let h = box.h;
        let w = box.w;
        if (own.length && ownMax <= foreignLeft + 1) w = Math.max(1, foreignLeft - box.h);
        else if (own.length && ownMin >= foreignRight - 1) { h = foreignRight; w = Math.max(1, box.h + box.w - foreignRight); }
        return { ...box, h, w, ht: typicalHt, dp: typicalDp };
      });
    };
    if (!math) shrinkTall();
    const left = Math.min(...boxes.map((box) => box.h));
    const right = Math.max(...boxes.map((box) => box.h + box.w));
    const upper = Math.min(...boxes.map(top));
    const lower = Math.max(...boxes.map(bottom));
    const x0 = index.toPoints(left, index.xOffset);
    const y0 = index.toPoints(upper, index.yOffset);
    // One rectangle per run of typeset lines with the same horizontal
    // extent: an ordinary paragraph is one box, a line cut short beside a
    // table is its own.
    const rects = [];
    for (const box of [...boxes].sort((a, b) => a.v - b.v)) {
      const rect = {
        x: index.toPoints(box.h, index.xOffset),
        y: index.toPoints(top(box), index.yOffset),
        right: index.toPoints(box.h + box.w, index.xOffset),
        bottom: index.toPoints(bottom(box), index.yOffset),
      };
      const last = rects[rects.length - 1];
      if (last && Math.abs(last.x - rect.x) < 1 && Math.abs(last.right - rect.right) < 1 && rect.y - last.bottom < 6) {
        last.bottom = Math.max(last.bottom, rect.bottom);
      } else {
        rects.push(rect);
      }
    }
    return {
      page: pageNo,
      x: x0,
      y: y0,
      width: index.toPoints(right, index.xOffset) - x0,
      height: index.toPoints(lower, index.yOffset) - y0,
      rects: rects.map((rect) => ({ x: rect.x, y: rect.y, width: rect.right - rect.x, height: rect.bottom - rect.y })),
      // columns of vertical writing: one rectangle per column (forward-index.cjs)
      ...(boxes.some((box) => box.direction === "tate") ? { direction: "tate" } : {}),
    };
  };
};

module.exports.analyzeDisplayMath = analyzeDisplayMath;
module.exports.parseEnvironments = parseEnvironments;
