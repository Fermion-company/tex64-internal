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
  /** [a, b, c, d, e, f] in the page's view space, top-left origin. */
  transform: number[];
  width: number;
  height: number;
  str: string;
};

type Line = { top: number; bottom: number; left: number; right: number };

/** Lines closer than this fraction of their own height belong together. */
const PARAGRAPH_GAP_RATIO = 0.9;
/** Items whose baselines differ by less than this share a line. */
const SAME_LINE_TOLERANCE = 2;

function itemRect(item: TextItemLike): TextRect | null {
  const d = item.transform[3] ?? 0;
  const e = item.transform[4] ?? Number.NaN;
  const f = item.transform[5] ?? Number.NaN;
  const height = Math.abs(item.height || d || 0);
  if (!Number.isFinite(e) || !Number.isFinite(f) || height <= 0) return null;
  if (!item.str.trim()) return null;
  return { left: e, top: f - height, width: item.width, height };
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
 * The lines of the paragraph containing `point`, as rectangles. Empty when the
 * click landed away from any text.
 */
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

  const belongs = (above: Line, below: Line) => {
    const gap = below.top - above.bottom;
    const height = Math.max(above.bottom - above.top, below.bottom - below.top);
    return gap <= height * PARAGRAPH_GAP_RATIO;
  };

  let first = hitIndex;
  while (first > 0 && belongs(lines[first - 1]!, lines[first]!)) first -= 1;
  let last = hitIndex;
  while (last < lines.length - 1 && belongs(lines[last]!, lines[last + 1]!)) {
    last += 1;
  }

  return lines.slice(first, last + 1).map((line) => ({
    left: line.left,
    top: line.top,
    width: line.right - line.left,
    height: line.bottom - line.top,
  }));
}
