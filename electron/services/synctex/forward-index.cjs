const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

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
  return buffer.toString("latin1");
};

const isBetterCandidate = (next, current) => {
  if (!current) return true;
  if (next.rank !== current.rank) return next.rank < current.rank;
  if (next.v !== current.v) return next.v < current.v;
  return next.h < current.h;
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
      entry = { glyphs: [], boxes: [] };
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
  // Open boxes on the current page; the innermost hbox owns the glyphs.
  const openBoxes = [];

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
      entry = { page: candidate.page, glyphs: 0, records: 0, best: null, hmin: null, hmax: null, vmin: null, vmax: null };
      pages.set(candidate.page, entry);
    }
    entry.records += 1;
    if (candidate.rank === RANK_GLYPH) entry.glyphs += 1;
    if (candidate.rank !== RANK_BOX) {
      // The extent of the line's ink on this page, for the way back from a point.
      if (entry.hmin === null || candidate.h < entry.hmin) entry.hmin = candidate.h;
      if (entry.hmax === null || candidate.h > entry.hmax) entry.hmax = candidate.h;
      if (entry.vmin === null || candidate.v < entry.vmin) entry.vmin = candidate.v;
      if (entry.vmax === null || candidate.v > entry.vmax) entry.vmax = candidate.v;
    }
    if (isBetterCandidate(candidate, entry.best)) {
      entry.best = { rank: candidate.rank, h: candidate.h, v: candidate.v };
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
      const box = { kind, tag, line, h, v, page };
      openBoxes.push(box);
      remember(tag, line, { rank: RANK_BOX, page, h, v });
      if (kind === "(") {
        const width = Number.parseInt(match[6], 10);
        const height = Number.parseInt(match[7], 10);
        const depth = Number.parseInt(match[8], 10);
        if (Number.isFinite(width) && Number.isFinite(height)) {
          pageRecords(page).boxes.push({ tag, line, h, v, w: width, ht: height, dp: Number.isFinite(depth) ? depth : 0 });
        }
      }
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
    remember(tag, line, {
      rank,
      page,
      h,
      v: lineBox ? lineBox.v : v,
    });
    if (rank !== RANK_SPACING) {
      pageRecords(page).glyphs.push({ tag, line, h, v: lineBox ? lineBox.v : v, rank });
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
    for (const glyph of records.glyphs) {
      if (glyph.v !== box.v) continue;
      if (glyph.h < box.h - 1 || glyph.h > box.h + box.w + 1) continue;
      const distance = Math.abs(glyph.h - h);
      const candidate = { tag: glyph.tag, line: glyph.line, distance, rank: glyph.rank };
      if (preferAuthor(glyph.tag)) {
        if (!best || distance < best.distance || (distance === best.distance && glyph.rank < best.rank)) best = candidate;
      } else if (!fallback || distance < fallback.distance) {
        fallback = candidate;
      }
    }
    const hit = best ?? (preferAuthor(box.tag) ? { tag: box.tag, line: box.line, distance: 0 } : fallback ?? { tag: box.tag, line: box.line, distance: 0 });
    return { tag: hit.tag, line: hit.line, distance: scaleToPoints(hit.distance), exact: true };
  }
  let nearest = null;
  let nearestAny = null;
  for (const glyph of records.glyphs) {
    const dv = Math.abs(glyph.v - v);
    const dh = Math.abs(glyph.h - h);
    const distance = dv * 4 + dh;
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
        const width = (entry) => (entry.hmin === null || entry.hmax === null ? 0 : entry.hmax - entry.hmin);
        const height = (entry) => (entry.vmin === null || entry.vmax === null ? 0 : entry.vmax - entry.vmin);
        const lowest = Math.max(...entries.map((entry) => entry.vmax ?? 0));
        const stamp = (entry) => entry.glyphs < enough && height(entry) > lowest * 0.5;
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
      return chosen ? { page: chosen.page, h: chosen.best.h, v: chosen.best.v } : null;
    };
    const results = [];
    for (const requested of lines) {
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
      });
    }
    // Input 1 is the file the engine was run on.
    const rootTag = Math.min(...index.inputs.keys());
    return { ok: true, results, pageCount: index.pageCount, isRootFile: tags.includes(rootTag) };
  };
};
