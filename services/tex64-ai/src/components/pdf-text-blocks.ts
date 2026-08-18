/**
 * Rectangles for the block of text a click landed in.
 *
 * The workspace's page has no element map — it is a PDF like any other — so
 * the shape of what the reader selected is recovered from the page's own text:
 * items are gathered into lines, and lines into the paragraph around the
 * click. Coordinates are PDF points from the page's top-left corner, the same
 * frame the overlay and SyncTeX use.
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

type Line = { top: number; bottom: number; left: number; right: number };

/** A vertical gap this much larger than the line height starts a new block. */
const BLOCK_GAP_RATIO = 0.6;
/** A first line indented at least this far (points) starts a paragraph. */
const INDENT_THRESHOLD = 4;
/** Items whose baselines differ by less than this share a line. */
const SAME_LINE_TOLERANCE = 2;

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
  return { left: e, top: f - height, width, height };
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
      continue;
    }
    lines.push({
      top: rect.top,
      bottom: rect.top + rect.height,
      left: rect.left,
      right: rect.left + rect.width,
    });
  }
  return lines.sort((left, right) => left.top - right.top);
}

/**
 * The left edge most lines share within one block — its margin. Measured per
 * block, not per page: an abstract or a quotation is indented as a whole, and
 * against the page's margin every one of its lines would look like the start
 * of a new paragraph.
 */
function marginLeft(lines: readonly Line[]): number {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.left);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = lines[0]?.left ?? 0;
  let bestCount = 0;
  for (const [left, count] of counts) {
    if (count > bestCount || (count === bestCount && left < best)) {
      best = left;
      bestCount = count;
    }
  }
  return best;
}

export function findTextBlockRects(
  items: readonly TextItemLike[],
  point: { x: number; y: number },
): TextRect[] {
  const lines = toLines(items);
  if (lines.length === 0) return [];

  const hitIndex = lines.findIndex(
    (line) =>
      point.y >= line.top - 2 &&
      point.y <= line.bottom + 2 &&
      point.x >= line.left - 8 &&
      point.x <= line.right + 8,
  );
  if (hitIndex === -1) return [];

  // The visual block first: everything the click's line runs together with,
  // separated only by vertical space.
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
  while (
    blockLast < lines.length - 1 &&
    touches(lines[blockLast]!, lines[blockLast + 1]!)
  ) {
    blockLast += 1;
  }

  // Then the paragraph inside it, by the indent its first line carries.
  const margin = marginLeft(lines.slice(blockFirst, blockLast + 1));
  const startsParagraph = (line: Line) => line.left > margin + INDENT_THRESHOLD;

  let first = hitIndex;
  while (first > blockFirst && !startsParagraph(lines[first]!)) first -= 1;
  let last = hitIndex;
  while (last < blockLast && !startsParagraph(lines[last + 1]!)) last += 1;

  return lines.slice(first, last + 1).map((line) => ({
    left: line.left,
    top: line.top,
    width: line.right - line.left,
    height: line.bottom - line.top,
  }));
}
