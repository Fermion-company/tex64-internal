import { gunzipSync } from "node:zlib";
import { z } from "zod";

export interface RegionRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NodeRegions {
  id: string;
  rects: RegionRect[];
}

export interface RegionMap {
  schemaVersion: 1;
  nodes: NodeRegions[];
}

export interface NodeLineRange {
  id: string;
  start: number;
  end: number;
}

const MAX_NODES = 10_000;
const MAX_RECTS_PER_NODE = 200;
const SP_PER_TEX_POINT = 65_536;
const BP_PER_TEX_POINT = 72 / 72.27;
const GZIP_MAGIC_FIRST = 0x1f;
const GZIP_MAGIC_SECOND = 0x8b;

const coordinateSchema = z.number().finite().min(0);

const regionRectSchema = z.object({
  page: z.number().int().min(1),
  x: coordinateSchema,
  y: coordinateSchema,
  width: coordinateSchema,
  height: coordinateSchema,
});

export const RegionMapSchema: z.ZodType<RegionMap> = z.object({
  schemaVersion: z.literal(1),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        rects: z.array(regionRectSchema).max(MAX_RECTS_PER_NODE),
      }),
    )
    .max(MAX_NODES),
});

type SynctexHeader = {
  unit: number;
  magnification: number;
  xOffset: number;
  yOffset: number;
};

/** Raw strip in synctex coordinate units; node is an index into the ranges array. */
type Strip = {
  node: number;
  page: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type HboxFrame = {
  kind: "hbox";
  isLineBox: boolean;
  h: number;
  v: number;
  width: number;
  height: number;
  depth: number;
  votes: Map<number, number>;
};

type Frame = { kind: "vbox" } | HboxFrame;

export function buildRegionMap(input: {
  synctex: Uint8Array;
  ranges: readonly NodeLineRange[];
  mainFileName?: string;
  /**
   * The compiled .tex source. TeX attributes a paragraph's records to the
   * line where \par fired — usually the BLANK line after the paragraph, which
   * sits outside every node range (or inside an ancestor's). With the source
   * available, each blank line is aliased back to the nearest preceding
   * content line (skipping marker/blank lines), so those votes reach the node
   * that actually produced the text. Essential for LuaTeX-ja documents, where
   * nearly every glyph vote lands on the \par line.
   */
  sourceText?: string;
}): RegionMap | null {
  try {
    if (input.ranges.length > MAX_NODES) return null;
    const text = decodeSynctex(input.synctex);
    if (text === null) return null;
    const aliases =
      input.sourceText === undefined ? null : blankLineAliases(input.sourceText);
    const parsed = collectStrips(
      text,
      input.ranges,
      basename(input.mainFileName ?? "main.tex"),
      aliases,
      // Without aliases, \par votes land on blank lines and read as
      // out-of-range, so the stray-box guard would kill legitimate boxes.
      aliases !== null,
    );
    if (parsed === null) return null;
    return assembleRegionMap(parsed.strips, parsed.header, input.ranges);
  } catch {
    return null;
  }
}

const MAX_SYNCTEX_TEXT_BYTES = 64 * 1024 * 1024;

function decodeSynctex(bytes: Uint8Array): string | null {
  if (bytes.length < 2) return null;
  const buffer =
    bytes[0] === GZIP_MAGIC_FIRST && bytes[1] === GZIP_MAGIC_SECOND
      ? gunzipSync(bytes, { maxOutputLength: MAX_SYNCTEX_TEXT_BYTES })
      : Buffer.from(bytes);
  return buffer.toString("utf8");
}

/**
 * Maps each blank source line (1-based) to the nearest preceding content
 * line, walking back over region-marker lines and other blank lines.
 */
function blankLineAliases(sourceText: string): Map<number, number> {
  const lines = sourceText.split("\n");
  const aliases = new Map<number, number>();
  let lastContentLine: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      if (lastContentLine !== null) aliases.set(index + 1, lastContentLine);
    } else if (!line.startsWith("%%T64B:") && !line.startsWith("%%T64E:")) {
      lastContentLine = index + 1;
    }
  }
  return aliases;
}

function collectStrips(
  text: string,
  ranges: readonly NodeLineRange[],
  mainBaseName: string,
  aliases: ReadonlyMap<number, number> | null,
  guardStrayBoxes: boolean,
): { strips: Strip[]; header: SynctexHeader } | null {
  const lines = text.split(/\r?\n/);
  if (!(lines[0] ?? "").startsWith("SyncTeX Version:")) return null;

  const header: SynctexHeader = { unit: 1, magnification: 1000, xOffset: 0, yOffset: 0 };
  const mainTags = new Set<number>();
  const resolveNode = createNodeResolver(ranges, aliases);
  const strips: Strip[] = [];
  const stack: Frame[] = [];
  let page: number | null = null;
  let inContent = false;
  let inPostamble = false;

  for (const line of lines) {
    if (line === "") continue;
    // Input records legitimately appear mid-file (e.g. after a sheet closes).
    if (line.startsWith("Input:")) {
      const tag = readInputTag(line, mainBaseName);
      if (tag !== null) mainTags.add(tag);
      continue;
    }
    if (inPostamble) continue;
    if (line.startsWith("Postamble:")) {
      if (page !== null || stack.length > 0) return null;
      inPostamble = true;
      continue;
    }
    if (!inContent) {
      if (line === "Content:") inContent = true;
      else if (line.startsWith("Magnification:")) header.magnification = readHeaderNumber(line) ?? header.magnification;
      else if (line.startsWith("Unit:")) header.unit = readHeaderNumber(line) ?? header.unit;
      else if (line.startsWith("X Offset:")) header.xOffset = readHeaderNumber(line) ?? header.xOffset;
      else if (line.startsWith("Y Offset:")) header.yOffset = readHeaderNumber(line) ?? header.yOffset;
      continue;
    }
    switch (line[0]) {
      case "{": {
        if (page !== null || stack.length > 0) return null;
        const opened = parseIntStrict(line.slice(1));
        if (opened === null || opened < 1) return null;
        page = opened;
        break;
      }
      case "}": {
        if (page === null || stack.length > 0) return null;
        if (parseIntStrict(line.slice(1)) !== page) return null;
        page = null;
        break;
      }
      case "[": {
        if (page === null || parseBoxRecord(line.slice(1)) === null) return null;
        stack.push({ kind: "vbox" });
        break;
      }
      case "]": {
        const frame = stack.pop();
        if (line !== "]" || frame === undefined || frame.kind !== "vbox") return null;
        break;
      }
      case "(": {
        if (page === null) return null;
        const box = parseBoxRecord(line.slice(1));
        if (box === null) return null;
        // A "line box" is an hbox sitting directly in vertical material; its
        // geometry is trusted, while its opening line number is not.
        const parent = stack[stack.length - 1];
        stack.push({
          kind: "hbox",
          isLineBox: parent === undefined || parent.kind === "vbox",
          ...box,
          votes: new Map(),
        });
        break;
      }
      case ")": {
        const frame = stack.pop();
        if (line !== ")" || frame === undefined || frame.kind !== "hbox") return null;
        if (frame.isLineBox && page !== null) {
          const strip = closeLineBox(
            frame,
            page,
            resolveNode,
            ranges,
            guardStrayBoxes,
          );
          if (strip !== null) strips.push(strip);
        }
        break;
      }
      case "x":
      case "k":
      case "g":
      case "$":
      case "h":
      case "r": {
        const link = parseLink(line.slice(1));
        if (link === null || !mainTags.has(link.tag)) break;
        const lineBox = nearestLineBox(stack);
        if (lineBox !== null) lineBox.votes.set(link.line, (lineBox.votes.get(link.line) ?? 0) + 1);
        break;
      }
      default:
        break; // v/f/! records, Output:, Count:, Post scriptum:, ...
    }
  }

  if (!inContent || page !== null || stack.length > 0) return null;
  return { strips, header };
}

const STRAY_BOX_MIN_OUT_OF_RANGE_VOTES = 4;

function closeLineBox(
  frame: HboxFrame,
  page: number,
  resolveNode: (line: number) => number | null,
  ranges: readonly NodeLineRange[],
  guardStrayBoxes: boolean,
): Strip | null {
  const votesByNode = new Map<number, number>();
  let totalVotes = 0;
  let inRangeVotes = 0;
  for (const [sourceLine, count] of frame.votes) {
    totalVotes += count;
    const node = resolveNode(sourceLine);
    if (node === null) continue;
    inRangeVotes += count;
    votesByNode.set(node, (votesByNode.get(node) ?? 0) + count);
  }
  // Output-routine and float-interior boxes (title block, page footers) carry
  // whatever source line was current at shipout: a couple of stray in-range
  // votes must not claim a box whose vote mass is out-of-range. The absolute
  // floor keeps sparsely-voted but genuine boxes (short lines with a stray
  // Lua-callback vote or two) alive.
  const outOfRangeVotes = totalVotes - inRangeVotes;
  if (
    guardStrayBoxes &&
    inRangeVotes * 2 <= totalVotes &&
    outOfRangeVotes >= STRAY_BOX_MIN_OUT_OF_RANGE_VOTES
  ) {
    return null;
  }
  const winner = pickMajorityNode(votesByNode, ranges);
  if (winner === null) return null;
  const height = Math.max(frame.height, 0);
  const depth = Math.max(frame.depth, 0);
  if (height + depth <= 0 || frame.width <= 0) return null;
  return {
    node: winner,
    page,
    left: frame.h,
    top: frame.v - height,
    right: frame.h + frame.width,
    bottom: frame.v + depth,
  };
}

function pickMajorityNode(
  votesByNode: ReadonlyMap<number, number>,
  ranges: readonly NodeLineRange[],
): number | null {
  let winner: number | null = null;
  let winnerVotes = 0;
  for (const [node, votes] of votesByNode) {
    if (winner === null || votes > winnerVotes || (votes === winnerVotes && prefersNode(node, winner, ranges))) {
      winner = node;
      winnerVotes = votes;
    }
  }
  return winner;
}

/** Tie-break: narrower range first, then earlier position in the input. */
function prefersNode(candidate: number, incumbent: number, ranges: readonly NodeLineRange[]): boolean {
  const a = ranges[candidate];
  const b = ranges[incumbent];
  if (a === undefined || b === undefined) return false;
  const spanA = a.end - a.start;
  const spanB = b.end - b.start;
  if (spanA !== spanB) return spanA < spanB;
  return candidate < incumbent;
}

function createNodeResolver(
  ranges: readonly NodeLineRange[],
  aliases: ReadonlyMap<number, number> | null,
): (line: number) => number | null {
  const cache = new Map<number, number | null>();
  return (line: number): number | null => {
    const cached = cache.get(line);
    if (cached !== undefined) return cached;
    const effective = aliases?.get(line) ?? line;
    let best: number | null = null;
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index];
      if (range === undefined || range.start > range.end) continue;
      if (effective < range.start || effective > range.end) continue;
      if (best === null || prefersNode(index, best, ranges)) best = index;
    }
    cache.set(line, best);
    return best;
  };
}

function nearestLineBox(stack: readonly Frame[]): HboxFrame | null {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const frame = stack[index];
    if (frame !== undefined && frame.kind === "hbox" && frame.isLineBox) return frame;
  }
  return null;
}

function assembleRegionMap(
  strips: readonly Strip[],
  header: SynctexHeader,
  ranges: readonly NodeLineRange[],
): RegionMap {
  const scale = (header.unit / SP_PER_TEX_POINT) * BP_PER_TEX_POINT * (header.magnification / 1000);
  const offsetScale = (1 / SP_PER_TEX_POINT) * BP_PER_TEX_POINT * (header.magnification / 1000);
  const xShift = header.xOffset * offsetScale;
  const yShift = header.yOffset * offsetScale;

  const rectsByNode = new Map<number, RegionRect[]>();
  for (const [node, pages] of groupStripsByNodeAndPage(strips)) {
    const rects = rectsByNode.get(node) ?? [];
    for (const [page, pageStrips] of pages) {
      for (const box of mergeStrips(pageStrips)) {
        rects.push({
          page,
          x: round2(Math.max(0, box.left * scale + xShift)),
          y: round2(Math.max(0, box.top * scale + yShift)),
          width: round2(Math.max(0, (box.right - box.left) * scale)),
          height: round2(Math.max(0, (box.bottom - box.top) * scale)),
        });
      }
    }
    rectsByNode.set(node, rects);
  }

  const rectsById = new Map<string, RegionRect[]>();
  const idOrder: string[] = [];
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const rects = rectsByNode.get(index);
    if (range === undefined || rects === undefined) continue;
    const existing = rectsById.get(range.id);
    if (existing === undefined) {
      idOrder.push(range.id);
      rectsById.set(range.id, [...rects]);
    } else {
      existing.push(...rects);
    }
  }

  const nodes: NodeRegions[] = idOrder.map((id) => {
    const rects = rectsById.get(id) ?? [];
    rects.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
    return { id, rects: rects.slice(0, MAX_RECTS_PER_NODE) };
  });
  return { schemaVersion: 1, nodes };
}

function groupStripsByNodeAndPage(strips: readonly Strip[]): Map<number, Map<number, Strip[]>> {
  const groups = new Map<number, Map<number, Strip[]>>();
  for (const strip of strips) {
    const pages = groups.get(strip.node) ?? new Map<number, Strip[]>();
    const group = pages.get(strip.page) ?? [];
    group.push(strip);
    pages.set(strip.page, group);
    groups.set(strip.node, pages);
  }
  return groups;
}

type MergedBox = { left: number; top: number; right: number; bottom: number };

/**
 * Merge vertically-adjacent line strips that overlap horizontally. The gap
 * tolerance is one strip height (consecutive baselines sit closer than that),
 * so distinct columns — whose x-extents never overlap — stay separate.
 */
function mergeStrips(strips: Strip[]): MergedBox[] {
  strips.sort((a, b) => a.top - b.top || a.left - b.left);
  const boxes: MergedBox[] = [];
  for (const strip of strips) {
    const target = boxes.find(
      (box) =>
        strip.left < box.right &&
        box.left < strip.right &&
        strip.top - box.bottom <= Math.max(box.bottom - box.top, strip.bottom - strip.top),
    );
    if (target === undefined) {
      boxes.push({ left: strip.left, top: strip.top, right: strip.right, bottom: strip.bottom });
    } else {
      target.left = Math.min(target.left, strip.left);
      target.top = Math.min(target.top, strip.top);
      target.right = Math.max(target.right, strip.right);
      target.bottom = Math.max(target.bottom, strip.bottom);
    }
  }
  return boxes;
}

function readInputTag(line: string, mainBaseName: string): number | null {
  const rest = line.slice("Input:".length);
  const separator = rest.indexOf(":");
  if (separator < 0) return null;
  const tag = parseIntStrict(rest.slice(0, separator));
  if (tag === null) return null;
  return basename(rest.slice(separator + 1)) === mainBaseName ? tag : null;
}

function basename(filePath: string): string {
  const separator = filePath.lastIndexOf("/");
  return separator < 0 ? filePath : filePath.slice(separator + 1);
}

function readHeaderNumber(line: string): number | null {
  const separator = line.indexOf(":");
  return separator < 0 ? null : parseIntStrict(line.slice(separator + 1));
}

/** Box open payload: "tag,line:h,v:width,height,depth" (all integers). */
function parseBoxRecord(
  payload: string,
): { h: number; v: number; width: number; height: number; depth: number } | null {
  const match = /^(\d+),(\d+):(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)$/.exec(payload);
  if (match === null) return null;
  const [, , , h, v, width, height, depth] = match;
  if (h === undefined || v === undefined || width === undefined || height === undefined || depth === undefined) {
    return null;
  }
  return { h: Number(h), v: Number(v), width: Number(width), height: Number(height), depth: Number(depth) };
}

/** Fine-record payload starts with "tag,line:" — only the link matters for voting. */
function parseLink(payload: string): { tag: number; line: number } | null {
  const match = /^(\d+),(\d+):/.exec(payload);
  if (match === null) return null;
  const [, tag, line] = match;
  if (tag === undefined || line === undefined) return null;
  return { tag: Number(tag), line: Number(line) };
}

function parseIntStrict(value: string): number | null {
  return /^-?\d+$/.test(value) ? Number(value) : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
