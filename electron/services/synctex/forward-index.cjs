const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { isUtf8 } = require("node:buffer");

// SyncTeX stores positions in scaled points; `synctex view` reports them in
// PDF points. 65536 sp per TeX point times 72.27 / 72 gives this factor.
const SP_PER_BP = 65781.76;
const MAX_CACHED_INDEXES = 4;
const MAX_SYNCTEX_TEXT_BYTES = 512 * 1024 * 1024;
const MAX_NEAREST_LINE_DISTANCE = 80;

// `(tag,line:h,v:W,H,D` — box openers, glyphs, kerns, glue, math, rules,
// void boxes and forms all share this shape; only the leading letter differs.
const RECORD_PATTERN = /^([[(xkg$vhrf])(\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+)(?:,(-?\d+))?)?)?/;

// Lower is better: a glyph sitting in a line box marks the text itself,
// math and rules come next, glue and kerns only mark the neighbourhood, and
// a box opener the whole block.
const RANK_GLYPH = 0;
const RANK_INK = 1;
const RANK_SPACING = 2;
const RANK_BOX = 3;

const realPathOrNull = (value) => {
  try {
    return fs.realpathSync(value);
  } catch (_error) {
    return null;
  }
};

const readSynctexText = (synctexPath) => {
  const raw = fs.readFileSync(synctexPath);
  const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  const buffer = isGzip ? zlib.gunzipSync(raw, { maxOutputLength: MAX_SYNCTEX_TEXT_BYTES }) : raw;
  return buffer.toString(isUtf8(buffer) ? "utf8" : "latin1");
};

const isBetterCandidate = (next, current) => {
  if (!current) return true;
  if (next.rank !== current.rank) return next.rank < current.rank;
  // Vertical writing reads its columns from the right, each from the top.
  if (next.tate && current.tate) {
    if (next.h !== current.h) return next.h > current.h;
    return next.v < current.v;
  }
  if (next.v !== current.v) return next.v < current.v;
  return next.h < current.h;
};

// Vertical writing (LuaTeX-ja tate). SyncTeX records what a tate box holds
// in the box's own, unrotated frame: h runs along the column, v across the
// columns, and LuaTeX-ja turns the box a quarter at shipout (PDF `0 -1 1 0
// cm`, with its translation). The frame shows in the SyncTeX itself: a vbox
// (T) inside a vbox (Y) at the same h, with width and height + depth swapped.
// Y is where T stands on the page. A point (h, v) of T's frame is, on the page,
//   x = Y.h + Y.w + T.v - v,   y = Y.v - T.h + h
// (scaled points, page frame; exact against the PDF's glyphs for ltjtarticle
// and jlreq tate). Only records nested in T are turned: a yoko page with one
// tate box keeps its other records as they are. Classes are never guessed.
const SWAP_TOLERANCE_SP = 16;
const tateFrameOf = (parent, box) => {
  if (!parent || parent.kind !== box.kind || !parent.dims || !box.dims) return null;
  const outer = parent.dims;
  const inner = box.dims;
  if (!(inner.w > 0 && inner.ht > 0)) return null;
  const close = (a, b) => Math.abs(a - b) <= SWAP_TOLERANCE_SP;
  if (!close(outer.w, inner.ht + inner.dp) || !close(outer.ht + outer.dp, inner.w)) return null;
  // Same size both ways (a square box) proves nothing.
  if (close(inner.w, outer.w)) return null;
  if (box.kind === "[") {
    if (!close(outer.h, inner.h)) return null;
    const outerFrame = parent.toPage;
    // A vlist inside a turned list uses the same swap for zero-depth
    // wrappers. A depth-bearing wrapper may instead be upright tate-chu-yoko.
    if (outerFrame && (outer.dp || inner.dp)) return null;
    // The vlist's baseline in the record is its top, including when a
    // parbox or minipage wrapper splits its vertical extent around a baseline.
    const local = (h, v) => [outer.h + outer.w + inner.v - v, outer.v + h - inner.h];
    return outerFrame ? (h, v) => outerFrame(...local(h, v)) : local;
  }
  if (parent.toPage || !close(inner.h, outer.h - outer.ht) || !close(inner.v, outer.v - inner.dp)) return null;
  return (h, v) => [outer.h + inner.ht + inner.v - v, outer.v - outer.ht + h - inner.h];
};

// The page a line really appears on is where most of its glyphs are. When a
// line triggers a page break, the finished page's footer and leftover math
// get stamped with that line too; those artifacts are few and come earlier,
// so ties go to the later page.
const isBetterPage = (next, current) => {
  if (!current) return true;
  if (next.glyphs !== current.glyphs) return next.glyphs > current.glyphs;
  if (next.records !== current.records) return next.records > current.records;
  return next.page > current.page;
};

/**
 * Reads a whole .synctex(.gz) once and keeps, for every source line, the
 * topmost place on the page where that line put ink. Later lookups are
 * memory reads: no process, no re-parse.
 */
const parseForwardIndex = (text, baseDir) => {
  const inputs = new Map();
  const byTag = new Map();
  // Per page, every leaf record and every line box with its size, so a
  // point on the page can be turned back into a source line without a
  // process: the innermost box under the point, then the nearest glyph.
  const pages = new Map();
  const pageRecords = (number) => {
    let entry = pages.get(number);
    if (!entry) {
      // lines: the typeset lines of the page, i.e. every hbox that sits
      // directly in a vertical list (paragraph lines, display rows, split
      // rows, footnote lines) — what a Jump marker should cover.
      entry = { glyphs: [], boxes: [], lines: [] };
      pages.set(number, entry);
    }
    return entry;
  };
  let magnification = 1000;
  let unit = 1;
  let xOffset = 0;
  let yOffset = 0;
  let inContent = false;
  let page = 0;
  let pageCount = 0;
  let boxId = 0;
  // Open boxes on the current page; the innermost hbox owns the glyphs.
  const openBoxes = [];
  const enclosingLineIndex = () => {
    for (let index = openBoxes.length - 1; index >= 0; index -= 1) {
      if (Number.isInteger(openBoxes[index].lineIndex)) return openBoxes[index].lineIndex;
    }
    return null;
  };

  const remember = (tag, line, candidate) => {
    let lines = byTag.get(tag);
    if (!lines) {
      lines = new Map();
      byTag.set(tag, lines);
    }
    let pages = lines.get(line);
    if (!pages) {
      pages = new Map();
      lines.set(line, pages);
    }
    let entry = pages.get(candidate.page);
    if (!entry) {
      entry = { page: candidate.page, glyphs: 0, records: 0, best: null, hmin: null, hmax: null, vmin: null, vmax: null, lineHits: new Map() };
      pages.set(candidate.page, entry);
    }
    entry.records += 1;
    if (Number.isInteger(candidate.lineIndex)) {
      entry.lineHits.set(candidate.lineIndex, (entry.lineHits.get(candidate.lineIndex) ?? 0) + 1);
    }
    if (candidate.rank === RANK_GLYPH) entry.glyphs += 1;
    if (candidate.rank !== RANK_BOX) {
      // The extent of the line's ink on this page, for the way back from a point.
      if (entry.hmin === null || candidate.h < entry.hmin) entry.hmin = candidate.h;
      if (entry.hmax === null || candidate.h > entry.hmax) entry.hmax = candidate.h;
      if (entry.vmin === null || candidate.v < entry.vmin) entry.vmin = candidate.v;
      if (entry.vmax === null || candidate.v > entry.vmax) entry.vmax = candidate.v;
    }
    if (isBetterCandidate(candidate, entry.best)) {
      entry.best = { rank: candidate.rank, h: candidate.h, v: candidate.v, ...(candidate.tate ? { tate: true } : {}) };
    }
  };

  // Files first read after a page has shipped (a chapter \input mid-document)
  // are declared inside the content, not in the preamble.
  const readInput = (record) => {
    const separator = record.indexOf(":", 6);
    if (separator <= 6) return;
    const tag = Number.parseInt(record.slice(6, separator), 10);
    const inputPath = record.slice(separator + 1).trim();
    if (Number.isFinite(tag) && inputPath) {
      inputs.set(
        tag,
        path.normalize(path.isAbsolute(inputPath) ? inputPath : path.resolve(baseDir, inputPath)),
      );
    }
  };

  let start = 0;
  const length = text.length;
  while (start < length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = length;
    const record = text.charCodeAt(end - 1) === 13 ? text.slice(start, end - 1) : text.slice(start, end);
    start = end + 1;
    if (!record) continue;

    if (!inContent) {
      if (record.startsWith("Input:")) {
        readInput(record);
      } else if (record.startsWith("Magnification:")) {
        const value = Number.parseFloat(record.slice(14));
        if (Number.isFinite(value) && value > 0) magnification = value;
      } else if (record.startsWith("Unit:")) {
        const value = Number.parseFloat(record.slice(5));
        if (Number.isFinite(value) && value > 0) unit = value;
      } else if (record.startsWith("X Offset:")) {
        const value = Number.parseFloat(record.slice(9));
        if (Number.isFinite(value)) xOffset = value;
      } else if (record.startsWith("Y Offset:")) {
        const value = Number.parseFloat(record.slice(9));
        if (Number.isFinite(value)) yOffset = value;
      } else if (record.startsWith("Content:")) {
        inContent = true;
      }
      continue;
    }

    const first = record.charCodeAt(0);
    if (first === 73 && record.startsWith("Input:")) {
      readInput(record);
      continue;
    }
    if (first === 123) {
      // "{n" opens a page.
      const value = Number.parseInt(record.slice(1), 10);
      page = Number.isFinite(value) ? value : page + 1;
      pageCount = Math.max(pageCount, page);
      openBoxes.length = 0;
      continue;
    }
    if (first === 125 || first === 33) {
      // "}n" closes a page, "!n" is a byte offset marker.
      continue;
    }
    if (first === 41 || first === 93) {
      // ")" and "]" close the innermost box.
      openBoxes.pop();
      continue;
    }
    const match = RECORD_PATTERN.exec(record);
    if (!match) continue;
    const kind = match[1];
    const tag = Number.parseInt(match[2], 10);
    const line = Number.parseInt(match[3], 10);
    const h = Number.parseInt(match[4], 10);
    const v = Number.parseInt(match[5], 10);
    if (!Number.isFinite(tag) || !Number.isFinite(line) || !Number.isFinite(h) || !Number.isFinite(v)) {
      continue;
    }
    if (kind === "(" || kind === "[") {
      const parent = openBoxes.length ? openBoxes[openBoxes.length - 1] : null;
      // The page frame of the tate box this record sits in, if any.
      const toPage = parent?.toPage ?? null;
      const box = { id: ++boxId, kind, tag, line, h, v, page, rawV: v, toPage };
      const width = Number.parseInt(match[6], 10);
      const height = Number.parseInt(match[7], 10);
      const depth = Number.parseInt(match[8], 10);
      const hasDimensions = Number.isFinite(width) && Number.isFinite(height);
      const dp = Number.isFinite(depth) ? depth : 0;
      if (hasDimensions) box.dims = { h, v, w: width, ht: height, dp };
      const frame = tateFrameOf(parent, box);
      if (frame) {
        box.toPage = frame;
        pageRecords(page).tate = true;
      }
      // (the box's own point, on the page)
      const [pageH, pageV] = toPage ? toPage(h, v) : [h, v];
      let lineIndex = null;
      if (kind === "(") {
        if (hasDimensions) {
          let dims = { tag, line, h, v, w: width, ht: height, dp };
          if (box.toPage) {
            // All four corners through the frame: on the page a tate line
            // is a column, its extent along the line now vertical.
            const corners = [[h, v - height], [h + width, v - height], [h, v + dp], [h + width, v + dp]]
              .map(([ch, cv]) => box.toPage(ch, cv));
            const left = Math.min(...corners.map((c) => c[0]));
            const right = Math.max(...corners.map((c) => c[0]));
            const upper = Math.min(...corners.map((c) => c[1]));
            const lower = Math.max(...corners.map((c) => c[1]));
            dims = { tag, line, h: left, v: lower, w: right - left, ht: lower - upper, dp: 0, direction: "tate" };
          }
          pageRecords(page).boxes.push(dims);
          if (parent?.kind === "[" || frame) {
            // level: how many typeset lines enclose this one (0 for a line of
            // the page; a split row inside its equation line is 1, the
            // numerator of a fraction inside an align row is 1 as well).
            const enclosing = enclosingLineIndex();
            const pageLines = pageRecords(page).lines;
            dims.level = enclosing === null ? 0 : (pageLines[enclosing]?.level ?? 0) + 1;
            dims.enclosing = enclosing;
            dims.list = parent.id;
            dims.rawH = h;
            dims.rawV = v;
            lineIndex = pageLines.push(dims) - 1;
            box.lineIndex = lineIndex;
          } else if (width === 0 && parent?.h === h && parent?.v === v) {
            const owner = pageRecords(page).lines[enclosingLineIndex()];
            if (owner?.tag === tag && line < owner.line) owner.labelLine ??= line;
          }
        }
      }
      // An inner box (a \text, a fraction) belongs to the typeset line it sits in.
      const ancestorLine = lineIndex ?? enclosingLineIndex();
      openBoxes.push(box);
      remember(tag, line, { rank: RANK_BOX, page, h: pageH, v: pageV, tate: Boolean(toPage),
        lineIndex: kind === "(" && lineIndex === null ? ancestorLine : null });
      continue;
    }
    // A leaf record: find the line box it sits in so the anchor lands on the
    // typeset line rather than on the glue between paragraphs.
    let lineBox = null;
    for (let index = openBoxes.length - 1; index >= 0; index -= 1) {
      if (openBoxes[index].kind === "(") {
        lineBox = openBoxes[index];
        break;
      }
    }
    const rank =
      kind === "x" ? RANK_GLYPH : kind === "g" || kind === "k" ? RANK_SPACING : RANK_INK;
    const leafLine = enclosingLineIndex();
    // (on its typeset line's baseline; in a tate box, turned onto the page)
    const frame = openBoxes.length ? openBoxes[openBoxes.length - 1].toPage : null;
    const [leafH, leafV] = frame ? frame(h, lineBox ? lineBox.rawV : v) : [h, lineBox ? lineBox.v : v];
    remember(tag, line, {
      rank,
      page,
      h: leafH,
      v: leafV,
      tate: Boolean(frame),
      lineIndex: leafLine,
    });
    if (leafLine !== null) {
      // Which source lines a typeset line holds, and whose record ends it:
      // the marker follows a source line onto a typeset line whose only
      // record LuaTeX tagged with the paragraph's end (marker-box.cjs).
      const target = pageRecords(page).lines[leafLine];
      if (target) {
        if (kind === "h" && h === target.rawH && v === target.rawV &&
            Number(match[6]) > 0 && Number(match[7]) === 0 && Number(match[8]) === 0 &&
            target.tag === tag && line < target.line) {
          target.paragraphStart ??= line;
        }
        const key = `${tag}:${line}`;
        target.sources ??= new Map();
        target.sources.set(key, (target.sources.get(key) ?? 0) + 1);
        if (rank === RANK_GLYPH) {
          target.glyphSources ??= new Map();
          target.glyphSources.set(key, (target.glyphSources.get(key) ?? 0) + 1);
          if (target.direction === "tate") {
            target.glyphTop = Math.min(target.glyphTop ?? leafV, leafV);
            target.glyphBottom = Math.max(target.glyphBottom ?? leafV, leafV);
          }
        }
        target.lastLeaf = { tag, line };
        target.spans ??= new Map();
        const span = target.spans.get(key);
        if (!span) target.spans.set(key, [h, h]);
        else { if (h < span[0]) span[0] = h; if (h > span[1]) span[1] = h; }
      }
    }
    if (rank !== RANK_SPACING) {
      pageRecords(page).glyphs.push(frame
        ? { tag, line, h: leafH, v: leafV, rank, direction: "tate" }
        : { tag, line, h, v: lineBox ? lineBox.v : v, rank });
    }
  }

  const scale = (magnification / 1000) * unit;
  return {
    inputs,
    byTag,
    pages,
    pageCount,
    toPoints(value, offset) {
      return ((value + offset) * scale) / SP_PER_BP;
    },
    toUnits(points, offset) {
      return (points * SP_PER_BP) / scale - offset;
    },
    xOffset,
    yOffset,
  };
};

/**
 * A point on a page back to its source line, from the index alone: the
 * innermost line box under the point names the line; failing that, the
 * nearest glyph on the page does. `distance` is in PDF points.
 */
// Glyphs can carry the tag of the class or package that typeset them (a
// Japanese font setup, a bibliography style); a click wants the author's
// own source line, so those tags rank below a .tex tag.
const GENERATED_INPUT_PATTERN = /\.(?:cls|sty|def|cfg|fd|clo|ldf|tex\/[^/]*texmf|bbl|aux|toc|lof|lot|out)$/i;
const isAuthorInput = (index, tag) => {
  const inputPath = index.inputs.get(tag);
  if (!inputPath) return false;
  if (/texmf/i.test(inputPath)) return false;
  return !GENERATED_INPUT_PATTERN.test(inputPath);
};

// Words as they appear in both the PDF text layer and the source: letters and
// digits only, case-folded. TeX commands and their braces drop out of the
// source side; ligatures and dashes are not in the comparison.
const normalizeWord = (value) => {
  const text = String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return text.length ? text.slice(0, 64) : "";
};
const sourceWords = (line) => String(line ?? "")
  .replace(/(^|[^\\])%.*$/, "$1")
  .replace(/\\[A-Za-z@]+\*?/g, " ")
  .split(/[\s{}[\]()~]+/)
  .map(normalizeWord)
  .filter(Boolean);

const reverseOnIndex = (index, { page, x, y }) => {
  const records = index.pages.get(page);
  if (!records) return null;
  const h = index.toUnits(x, index.xOffset);
  const v = index.toUnits(y, index.yOffset);
  const scaleToPoints = (units) => index.toPoints(units, 0);
  const authorTag = new Map();
  const preferAuthor = (tag) => {
    if (!authorTag.has(tag)) authorTag.set(tag, isAuthorInput(index, tag));
    return authorTag.get(tag);
  };
  let box = null;
  for (const candidate of records.boxes) {
    const left = candidate.h;
    const right = candidate.h + candidate.w;
    const top = candidate.v - candidate.ht;
    const bottom = candidate.v + candidate.dp;
    if (h < left || h > right || v < top || v > bottom) continue;
    const area = Math.max(1, candidate.w) * Math.max(1, candidate.ht + candidate.dp);
    if (!box || area < box.area) box = { ...candidate, area };
  }
  if (box) {
    // Within the box the glyph nearest horizontally decides the line, since
    // one typeset line can gather several source lines. The author's own
    // files come first; a class or style tag only when nothing else is there.
    let best = null;
    let fallback = null;
    // A tate line is a column: its glyphs stand down it, nearest vertically.
    const tate = box.direction === "tate";
    for (const glyph of records.glyphs) {
      if (tate) {
        if (glyph.direction !== "tate" || glyph.h < box.h - 1 || glyph.h > box.h + box.w + 1 ||
            glyph.v < box.v - box.ht - 1 || glyph.v > box.v + box.dp + 1) continue;
      } else {
        if (glyph.v !== box.v) continue;
        if (glyph.h < box.h - 1 || glyph.h > box.h + box.w + 1) continue;
      }
      const distance = tate ? Math.abs(glyph.v - v) : Math.abs(glyph.h - h);
      const candidate = { tag: glyph.tag, line: glyph.line, distance, rank: glyph.rank };
      if (preferAuthor(glyph.tag)) {
        if (!best || distance < best.distance || (distance === best.distance && glyph.rank < best.rank)) best = candidate;
      } else if (!fallback || distance < fallback.distance) {
        fallback = candidate;
      }
    }
    let hit = best ?? (preferAuthor(box.tag) ? { tag: box.tag, line: box.line, distance: 0 } : fallback ?? { tag: box.tag, line: box.line, distance: 0 });
    // LuaTeX-ja files the glyphs of a vertical line under the source line TeX
    // was reading when the page shipped (often \end{document}); the box
    // around them keeps the paragraph's own.
    if (tate && preferAuthor(box.tag) && hit.tag === box.tag && hit.line > box.line) {
      hit = { tag: box.tag, line: box.line, distance: 0 };
    }
    return { tag: hit.tag, line: hit.line, distance: scaleToPoints(hit.distance), exact: true };
  }
  let nearest = null;
  let nearestAny = null;
  for (const glyph of records.glyphs) {
    const dv = Math.abs(glyph.v - v);
    const dh = Math.abs(glyph.h - h);
    // (across the lines costs more: down the page in yoko, across columns in tate)
    const distance = glyph.direction === "tate" ? dh * 4 + dv : dv * 4 + dh;
    const candidate = { tag: glyph.tag, line: glyph.line, distance };
    if (preferAuthor(glyph.tag)) {
      if (!nearest || distance < nearest.distance) nearest = candidate;
    } else if (!nearestAny || distance < nearestAny.distance) {
      nearestAny = candidate;
    }
  }
  const chosen = nearest ?? nearestAny;
  if (!chosen) return null;
  return { tag: chosen.tag, line: chosen.line, distance: scaleToPoints(chosen.distance), exact: false };
};

module.exports = (SynctexService) => {
  SynctexService.prototype.debugReverseOnIndex = function (pdfPath, point) {
    const index = this.loadForwardIndex(this.findSynctexOutputPath(pdfPath));
    return index ? reverseOnIndex(index, point) : null;
  };
  /**
   * Page → source line from the cached index. Returns null when the PDF has
   * no usable SyncTeX data; the caller then falls back to the synctex
   * process.
   */
  SynctexService.prototype.reverseQuick = function ({ pdfPath, page, x, y }) {
    if (typeof pdfPath !== "string" || !fs.existsSync(pdfPath)) return null;
    const synctexPath = this.findSynctexOutputPath(pdfPath);
    if (!synctexPath) return null;
    const index = this.loadForwardIndex(synctexPath);
    if (!index) return null;
    const owner = this.reverseBoxOwner(index, { page: Math.floor(page), x, y });
    if (owner) return owner;
    const hit = reverseOnIndex(index, { page: Math.floor(page), x, y });
    if (!hit) return null;
    const sourcePath = index.inputs.get(hit.tag);
    if (!sourcePath) return null;
    // A blank or comment line under the point is where a paragraph ended:
    // the text it belongs to is above it, so look upward first.
    let line = hit.line;
    const sourceLine = this.getSourceLine?.(sourcePath, line);
    if (typeof sourceLine === "string" && /^\s*(?:%.*)?$/.test(sourceLine)) {
      const order = [];
      for (let delta = 1; delta <= 3; delta += 1) order.push(line - delta);
      for (let delta = 1; delta <= 3; delta += 1) order.push(line + delta);
      const found = order.find(
        (candidate) => candidate >= 1 && this.getReverseLinePenalty({ sourcePath, line: candidate }) === 0,
      );
      if (found) line = found;
    }
    return { path: sourcePath, line, column: 1, distance: hit.distance, exact: hit.exact };
  };

  /**
   * Re-pick a reverse result by the words under the click. SyncTeX records
   * glue and boxes, not characters: the first word of a source line sits
   * right after the previous line's end-of-line space, and a paragraph's
   * first word inside the line box that TeX tags with the paragraph's last
   * line, so a click there returns the line above, the paragraph's end, or
   * (via a page/column box) another file. The clicked word and its
   * neighbours on the typeset line name the source line far more reliably.
   * Candidates: lines near the result, and every source line that has
   * records on the clicked typeset line. Returns null to keep the result.
   */
  SynctexService.prototype.refineReverseByText = function ({ pdfPath, page, x, y, result, context }) {
    const word = normalizeWord(context?.word);
    if (!word || !result?.path || !Number.isFinite(result.line)) return null;
    const prev = normalizeWord(context?.prev);
    const next = normalizeWord(context?.next);
    const candidates = new Map(); // `${path}\0${line}` -> { path, line, near }
    const add = (path, line, near) => {
      if (!path || !Number.isFinite(line) || line < 1) return;
      const key = `${path}\0${line}`;
      const existing = candidates.get(key);
      if (!existing || near < existing.near) candidates.set(key, { path, line, near });
    };
    for (let delta = -15; delta <= 3; delta += 1) add(result.path, result.line + delta, Math.abs(delta));
    const synctexPath = this.findSynctexOutputPath(pdfPath);
    const index = synctexPath ? this.loadForwardIndex(synctexPath) : null;
    const records = index?.pages.get(Math.floor(page));
    if (records && Number.isFinite(y)) {
      const v = index.toUnits(y, index.yOffset);
      const h = Number.isFinite(x) ? index.toUnits(x, index.xOffset) : null;
      const tolerance = index.toUnits(8, 0);
      const seen = new Set();
      for (const record of [...records.glyphs, ...records.boxes]) {
        // the clicked typeset line: its row, or in tate its column
        if (record.direction === "tate") {
          if (h === null || h < record.h - tolerance || h > record.h + (record.w ?? 0) + tolerance) continue;
        } else if (Math.abs(record.v - v) > tolerance) continue;
        const key = `${record.tag}:${record.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sourcePath = index.inputs.get(record.tag);
        if (!sourcePath || !/\.(?:tex|ltx)$/i.test(sourcePath)) continue;
        for (let delta = -2; delta <= 2; delta += 1) add(sourcePath, record.line + delta, 20 + Math.abs(delta));
      }
    }
    const score = (text) => {
      const words = sourceWords(text);
      if (!words.includes(word)) return 0;
      let best = 1;
      for (let i = 0; i < words.length; i += 1) {
        if (words[i] !== word) continue;
        if (prev && words[i - 1] === prev) best = Math.max(best, 2);
        if (next && words[i + 1] === next) best = Math.max(best, 2);
        if (prev && next && words[i - 1] === prev && words[i + 1] === next) best = 3;
      }
      return best;
    };
    let best = null;
    for (const candidate of candidates.values()) {
      const text = this.getSourceLine?.(candidate.path, candidate.line);
      if (typeof text !== "string") continue;
      const value = score(text);
      if (!value) continue;
      if (!best || value > best.value || (value === best.value && candidate.near < best.near)) {
        best = { ...candidate, value };
      }
    }
    if (!best) return null;
    // A short common word alone proves little; keep SyncTeX's answer then.
    if (best.value === 1 && word.length < 4) return null;
    const current = this.getSourceLine?.(result.path, result.line);
    if (typeof current === "string" && score(current) >= best.value) return null;
    return { path: best.path, line: best.line };
  };

  SynctexService.prototype.findSynctexOutputPath = function (pdfPath) {
    if (typeof pdfPath !== "string" || !pdfPath) return null;
    const base = pdfPath.replace(/\.pdf$/i, "");
    for (const suffix of [".synctex.gz", ".synctex"]) {
      const candidate = `${base}${suffix}`;
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  };

  SynctexService.prototype.loadForwardIndex = function (synctexPath) {
    let stats;
    try {
      stats = fs.statSync(synctexPath);
    } catch (_error) {
      return null;
    }
    if (!this.forwardIndexCache) this.forwardIndexCache = new Map();
    const cached = this.forwardIndexCache.get(synctexPath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      // Refresh recency so the busiest documents stay resident.
      this.forwardIndexCache.delete(synctexPath);
      this.forwardIndexCache.set(synctexPath, cached);
      return cached.index;
    }
    let index;
    try {
      index = parseForwardIndex(readSynctexText(synctexPath), path.dirname(synctexPath));
    } catch (_error) {
      return null;
    }
    this.forwardIndexCache.set(synctexPath, { mtimeMs: stats.mtimeMs, size: stats.size, index });
    while (this.forwardIndexCache.size > MAX_CACHED_INDEXES) {
      const oldest = this.forwardIndexCache.keys().next().value;
      this.forwardIndexCache.delete(oldest);
    }
    return index;
  };

  SynctexService.prototype.findForwardTags = function (index, sourcePath) {
    const sourceReal = realPathOrNull(sourcePath) || path.normalize(sourcePath);
    const sourceNormalized = path.normalize(sourcePath);
    const exact = [];
    const byName = [];
    for (const [tag, inputPath] of index.inputs) {
      if (inputPath === sourceNormalized || inputPath === sourceReal) {
        exact.push(tag);
        continue;
      }
      const inputReal = realPathOrNull(inputPath);
      if (inputReal && inputReal === sourceReal) {
        exact.push(tag);
        continue;
      }
      if (path.basename(inputPath) === path.basename(sourcePath)) {
        byName.push(tag);
      }
    }
    return exact.length > 0 ? exact : byName;
  };

  /**
   * Where the index begins: the first page the generated index file (.ind)
   * fills, in PDF points. \printindex prints nothing of its own, and the
   * nearest inked line of the main file is somewhere else entirely (page 334
   * for an index that starts on 371). The page shipped just before the index
   * is stamped with the index file's first line too, so the first page with
   * at least half the glyphs of the fullest one is taken.
   */
  SynctexService.prototype.forwardIndexStart = function ({ pdfPath }) {
    if (!fs.existsSync(pdfPath)) return null;
    const synctexPath = this.findSynctexOutputPath(pdfPath);
    const index = synctexPath ? this.loadForwardIndex(synctexPath) : null;
    if (!index) return null;
    const perPage = new Map();
    for (const [tag, inputPath] of index.inputs) {
      if (!/\.ind$/i.test(String(inputPath))) continue;
      for (const pages of index.byTag.get(tag)?.values() ?? []) {
        for (const entry of pages.values()) {
          if (!entry.best || !entry.glyphs) continue;
          const seen = perPage.get(entry.page) ?? { glyphs: 0, top: null };
          seen.glyphs += entry.glyphs;
          if (!seen.top || entry.best.v < seen.top.v) seen.top = entry.best;
          perPage.set(entry.page, seen);
        }
      }
    }
    if (!perPage.size) return null;
    const fullest = Math.max(...[...perPage.values()].map((seen) => seen.glyphs));
    const page = Math.min(...[...perPage].filter(([, seen]) => seen.glyphs >= fullest / 2).map(([number]) => number));
    const top = perPage.get(page).top;
    return { page, x: index.toPoints(top.h, index.xOffset), y: index.toPoints(top.v, index.yOffset) };
  };

  /**
   * Resolves many source lines of one file against one PDF in a single pass
   * over the cached index. Each hit is the topmost typeset spot of that line
   * (or of the nearest line that left ink), in PDF points from the page's
   * top-left corner — the same frame `synctex view` reports.
   */
  SynctexService.prototype.forwardLinesQuick = function ({
    sourcePath,
    pdfPath,
    lines,
    preferAbove = false,
    firstSubstantialPage = false,
    lastSubstantialPage = false,
  }) {
    if (!fs.existsSync(pdfPath)) {
      return { ok: false, error: "PDF not found." };
    }
    const synctexPath = this.findSynctexOutputPath(pdfPath);
    if (!synctexPath) {
      return { ok: false, error: "SyncTeX data was not found." };
    }
    const index = this.loadForwardIndex(synctexPath);
    if (!index) {
      return { ok: false, error: "SyncTeX parsing failed." };
    }
    const tags = this.findForwardTags(index, sourcePath);
    if (tags.length === 0) {
      return { ok: false, error: "The file is not part of this PDF." };
    }
    const lookup = (line) => {
      const entries = [];
      for (const tag of tags) {
        const pages = index.byTag.get(tag)?.get(line);
        if (!pages) continue;
        for (const entry of pages.values()) {
          if (entry.best) entries.push(entry);
        }
      }
      let chosen = null;
      if ((firstSubstantialPage || lastSubstantialPage) && entries.length > 0) {
        // What a page break stamps with the line being read (the running
        // head at the top, the folio at the foot) is a few glyphs spread
        // over the whole page height. A line with nothing else, like
        // \chapter whose \clearpage ships the previous page, has no output
        // of its own here: its heading is filed under the next line, so the
        // search moves on to that.
        const most = Math.max(...entries.map((entry) => entry.glyphs));
        const enough = Math.max(3, Math.min(20, most * 0.3));
        // Along a line and across the lines: across the page in yoko, down it
        // in vertical writing (a tate column reaches the foot of the page by
        // itself; a stamp there is what spreads across the columns).
        const tate = (entry) => entry.best?.tate === true;
        const extentH = (entry) => (entry.hmin === null || entry.hmax === null ? 0 : entry.hmax - entry.hmin);
        const extentV = (entry) => (entry.vmin === null || entry.vmax === null ? 0 : entry.vmax - entry.vmin);
        const width = (entry) => (tate(entry) ? extentV(entry) : extentH(entry));
        const height = (entry) => (tate(entry) ? extentH(entry) : extentV(entry));
        const lowestV = Math.max(...entries.map((entry) => entry.vmax ?? 0));
        const reachH = Math.max(...entries.map((entry) => entry.hmax ?? 0));
        const lowest = (entry) => (tate(entry) ? reachH : lowestV);
        // A page that draws its boxes while it ships (frames, a thumb index,
        // code-box overlays) stamps far more than a head and a folio: the
        // last page of a chapter carried 121 records of the \part line that
        // shipped it, and the Jump from that line landed there, one page
        // before the part's own. Such a stamp is still spread over the page
        // height while being a small share of that page's glyphs, and the
        // line has output on a later page too.
        const pageGlyphs = (entry) => index.pages?.get(entry.page)?.glyphs.length ?? 0;
        const minority = (entry) => pageGlyphs(entry) > 0 && entry.glyphs < pageGlyphs(entry) * 0.25 &&
          entries.some((other) => other.page > entry.page);
        const stamp = (entry) => height(entry) > lowest(entry) * 0.5 && (entry.glyphs < enough || (firstSubstantialPage && minority(entry)));
        const own = entries.filter((entry) => !stamp(entry));
        if (own.length === 0) return null;
        // A paragraph's first line at the foot of a page has few glyphs but
        // spans the text width; its last line at the top of the next page
        // may be short.
        const widest = Math.max(...own.map(width));
        const lineLike = (entry) =>
          entry.glyphs >= 3 && (lastSubstantialPage || (widest > 0 && width(entry) >= widest * 0.5));
        const real = (entry) => entry.glyphs >= enough || lineLike(entry);
        // First page for where the output begins, last for where it ends.
        for (const entry of own) {
          if (!real(entry)) continue;
          if (!chosen || (lastSubstantialPage ? entry.page > chosen.page : entry.page < chosen.page)) chosen = entry;
        }
        if (!chosen) {
          for (const entry of own) {
            if (isBetterPage(entry, chosen)) chosen = entry;
          }
        }
      }
      if (!chosen) {
        for (const entry of entries) {
          if (isBetterPage(entry, chosen)) chosen = entry;
        }
      }
      return chosen ? { page: chosen.page, h: chosen.best.h, v: chosen.best.v, tate: chosen.best.tate === true } : null;
    };
    const results = [];
    const hasTate = [...index.pages.values()].some((page) => page.tate);
    for (const requested of lines) {
      const marker = hasTate ? this.forwardOwnedMarker?.({
        sourcePath, pdfPath, line: requested, toEnd: lastSubstantialPage,
      }) : null;
      if (marker?.direction === "tate") {
        const rect = lastSubstantialPage ? marker.rects.at(-1) : marker.rects[0];
        results.push({ line: requested, found: true, matchedLine: requested, page: marker.page,
          x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, direction: "tate" });
        continue;
      }
      let hit = null;
      let matchedLine = requested;
      for (let distance = 0; distance <= MAX_NEAREST_LINE_DISTANCE && !hit; distance += 1) {
        // Look below first: a step that names a heading line wants the text
        // that follows it, not the paragraph that ended above. A blank or
        // closing line belongs to what precedes it, so callers can flip that.
        const candidates = distance === 0
          ? [requested]
          : preferAbove
            ? [requested - distance, requested + distance]
            : [requested + distance, requested - distance];
        for (const candidate of candidates) {
          if (candidate < 1) continue;
          hit = lookup(candidate);
          if (hit) {
            matchedLine = candidate;
            break;
          }
        }
      }
      if (!hit) {
        results.push({ line: requested, found: false });
        continue;
      }
      results.push({
        line: requested,
        found: true,
        matchedLine,
        page: hit.page,
        x: index.toPoints(hit.h, index.xOffset),
        y: index.toPoints(hit.v, index.yOffset),
        // (in a tate box: a column; the synctex process answers in the box's unturned frame)
        ...(hit.tate ? { direction: "tate" } : {}),
      });
    }
    // Input 1 is the file the engine was run on.
    const rootTag = Math.min(...index.inputs.keys());
    return { ok: true, results, pageCount: index.pageCount, isRootFile: tags.includes(rootTag) };
  };
};
