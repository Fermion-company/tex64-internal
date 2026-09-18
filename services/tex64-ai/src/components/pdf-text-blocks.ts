/**
 * Rectangles for the block of text a click landed in.
 *
 * The workspace's page has no element map — it is a PDF like any other — so
 * the shape of what the reader selected is recovered from the page's own text:
 * items are gathered into lines. The clicked line is passed to source
 * resolution rather than its visual neighbours: ordinary TeX paragraphs and
 * tabular rows often sit at the same leading, but they must not be treated as
 * one editable source range. The nearby visual block still determines where
 * the editor card starts, so it does not cover a following table or paragraph.
 * Coordinates are PDF points from the page's top-left corner, the same frame
 * the overlay and SyncTeX use.
 */
export type TextRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type TextItemLike = {
  /**
   * [a, b, c, d, e, f] in the page's view space, top-left origin. Absent on
   * the marked-content entries pdf.js mixes into the same list.
   */
  transform?: number[];
  width?: number;
  height?: number;
  str?: string;
};

type Line = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  pieces: Array<{ left: number; right: number; text: string }>;
};

export type TextBlock = { rects: TextRect[]; text: string; focusedText: string };

export const hasSelectableText = (block: TextBlock): boolean =>
  block.rects.length > 0 && block.text.trim().length > 0;

/**
 * How much of the text size sits above the baseline. transform[5] is the
 * baseline, not the top: subtracting the full height hung every box a
 * descent too high, with its bottom edge cutting through the glyphs.
 */
const ASCENT_RATIO = 0.78;
/** Items whose baselines differ by less than this share a line. */
const SAME_LINE_TOLERANCE = 2;
/** A larger gap is a separate visual cell, not a word within the same value. */
const FOCUS_GROUP_GAP = 10;

function itemRect(item: TextItemLike): TextRect | null {
  // pdf.js mixes marked-content markers into the same list; they carry no
  // geometry, and reading one as if it did used to throw away the whole page.
  if (!Array.isArray(item.transform)) return null;
  if (typeof item.str !== "string" || !item.str.trim()) return null;
  const d = item.transform[3] ?? 0;
  const e = item.transform[4] ?? Number.NaN;
  const f = item.transform[5] ?? Number.NaN;
  const width = typeof item.width === "number" ? item.width : 0;
  const height = Math.abs(item.height || d || 0);
  if (!Number.isFinite(e) || !Number.isFinite(f) || height <= 0) return null;
  if (width <= 0) return null;
  return { left: e, top: f - height * ASCENT_RATIO, width, height };
}

function toLines(items: readonly TextItemLike[]): Line[] {
  const lines: Line[] = [];
  for (const item of items) {
    const rect = itemRect(item);
    if (!rect) continue;
    const existing = lines.find(
      (line) => Math.abs(line.top - rect.top) <= SAME_LINE_TOLERANCE,
    );
    if (existing) {
      existing.top = Math.min(existing.top, rect.top);
      existing.bottom = Math.max(existing.bottom, rect.top + rect.height);
      existing.left = Math.min(existing.left, rect.left);
      existing.right = Math.max(existing.right, rect.left + rect.width);
      existing.pieces.push({ left: rect.left, right: rect.left + rect.width, text: item.str ?? "" });
      continue;
    }
    lines.push({
      top: rect.top,
      bottom: rect.top + rect.height,
      left: rect.left,
      right: rect.left + rect.width,
      pieces: [{ left: rect.left, right: rect.left + rect.width, text: item.str ?? "" }],
    });
  }
  return lines.sort((left, right) => left.top - right.top);
}

export function findTextBlock(
  items: readonly TextItemLike[],
  point: { x: number; y: number },
): TextBlock {
  const lines = toLines(items);
  if (lines.length === 0) return { rects: [], text: "", focusedText: "" };

  const hitIndex = lines.findIndex(
    (line) =>
      point.y >= line.top - 2 &&
      point.y <= line.bottom + 2 &&
      point.x >= line.left - 8 &&
      point.x <= line.right + 8,
  );
  if (hitIndex === -1) return { rects: [], text: "", focusedText: "" };

  const selectedLine = lines[hitIndex]!;
  const touches = (above: Line, below: Line) => {
    const gap = below.top - above.bottom;
    const height = Math.max(above.bottom - above.top, below.bottom - below.top);
    return gap <= height * BLOCK_GAP_RATIO;
  };
  let blockFirst = hitIndex;
  while (blockFirst > 0 && touches(lines[blockFirst - 1]!, lines[blockFirst]!)) {
    blockFirst -= 1;
  }
  let blockLast = hitIndex;
  while (blockLast < lines.length - 1 && touches(lines[blockLast]!, lines[blockLast + 1]!)) {
    blockLast += 1;
  }
  const blockLines = lines.slice(blockFirst, blockLast + 1);
  const orderedPieces = [...selectedLine.pieces].sort((left, right) => left.left - right.left);
  const focusedIndex = orderedPieces
    .map((piece, index) => ({
      index,
      distance: point.x < piece.left ? piece.left - point.x : point.x > piece.right ? point.x - piece.right : 0,
    }))
    .sort((left, right) => {
      return left.distance - right.distance;
    })[0]?.index;
  let focusFirst = focusedIndex ?? 0;
  let focusLast = focusedIndex ?? -1;
  while (focusFirst > 0 && orderedPieces[focusFirst]!.left - orderedPieces[focusFirst - 1]!.right <= FOCUS_GROUP_GAP) focusFirst -= 1;
  while (focusLast >= 0 && focusLast < orderedPieces.length - 1 && orderedPieces[focusLast + 1]!.left - orderedPieces[focusLast]!.right <= FOCUS_GROUP_GAP) focusLast += 1;
  const focusedText = orderedPieces.slice(focusFirst, focusLast + 1).map((piece) => piece.text).join("").trim();
  return {
    rects: blockLines.map((line) => ({
      left: line.left,
      top: line.top,
      width: line.right - line.left,
      height: line.bottom - line.top,
    })),
    text: selectedLine.pieces
      .sort((left, right) => left.left - right.left)
      .map((piece) => piece.text)
      .join("")
      .trim(),
    focusedText,
  };
}

export function findTextBlockRects(
  items: readonly TextItemLike[],
  point: { x: number; y: number },
): TextRect[] {
  return findTextBlock(items, point).rects;
}
/** A vertical gap this much larger than the line height starts a new block. */
const BLOCK_GAP_RATIO = 0.6;
