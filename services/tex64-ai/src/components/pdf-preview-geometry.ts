/**
 * Pure geometry helpers for the PDF preview.
 *
 * Coordinates: region rects arrive in bp (PostScript points) with a top-left
 * origin, matching `page.getViewport({ scale: 1 })` from pdfjs. Rendered pixels
 * are simply bp multiplied by the current CSS scale (zoom percent / 100);
 * devicePixelRatio only affects the canvas backing store, never the overlay.
 *
 * Everything in this module is DOM-free so it can be unit-tested in a plain
 * node environment.
 */

export interface PdfRegionRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfElementRegion {
  id: string;
  label: string;
  rects: PdfRegionRect[];
}

export interface PxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const MIN_ZOOM_PERCENT = 50;
export const MAX_ZOOM_PERCENT = 300;
export const ZOOM_STEP_PERCENT = 10;
/** Chromium trackpad pinch events arrive as ctrl+wheel pixel deltas. */
export const PINCH_ZOOM_SENSITIVITY = 0.0085;

/**
 * Fraction of the viewport height used as the "reading line" when deciding
 * which page the scroll position is on.
 */
export const CURRENT_PAGE_ANCHOR_RATIO = 0.35;

/** Scale a bp rect (top-left origin) to rendered CSS pixels. */
export function bpRectToPx(rect: PdfRegionRect, scale: number): PxRect {
  return {
    left: rect.x * scale,
    top: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/** Clamp a zoom percentage into the supported 50–300% range (rounded). */
export function clampZoomPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, Math.round(percent)));
}

/** Continuous exponential zoom for a trackpad pinch (negative delta = zoom in). */
export function pinchZoomPercent(currentPercent: number, deltaPixels: number): number {
  const current = Number.isFinite(currentPercent) ? currentPercent : 100;
  if (!Number.isFinite(deltaPixels)) {
    return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, current));
  }
  return Math.min(
    MAX_ZOOM_PERCENT,
    Math.max(
      MIN_ZOOM_PERCENT,
      current * Math.exp(-deltaPixels * PINCH_ZOOM_SENSITIVITY),
    ),
  );
}

/** Preserve a viewport point when content changes by `scaleFactor`. */
export function anchoredScrollOffset(
  scrollOffset: number,
  viewportPoint: number,
  scaleFactor: number,
): number {
  if (
    !Number.isFinite(scrollOffset) ||
    !Number.isFinite(viewportPoint) ||
    !Number.isFinite(scaleFactor) ||
    scaleFactor <= 0
  ) {
    return Math.max(0, Number.isFinite(scrollOffset) ? scrollOffset : 0);
  }
  return Math.max(0, (scrollOffset + viewportPoint) * scaleFactor - viewportPoint);
}

/**
 * Zoom percentage that fits a page of `pageWidthBp` into `availableWidth`
 * CSS pixels, clamped into the supported range. Falls back to 100% while the
 * container has not been measured yet.
 */
export function fitToWidthPercent(availableWidth: number, pageWidthBp: number): number {
  if (availableWidth <= 0 || pageWidthBp <= 0) return 100;
  return clampZoomPercent((availableWidth / pageWidthBp) * 100);
}

export interface PageRegionRect {
  regionId: string;
  label: string;
  rect: PdfRegionRect;
  /** Stable render key: `${regionId}:${index within the region}`. */
  rectKey: string;
  /**
   * True for the first rect of a region on a given page — the anchor for the
   * hover label chip so a multi-rect region shows exactly one chip per page.
   */
  isPrimary: boolean;
}

/** Group every region rect by its 1-based page number, in stable order. */
export function groupRectsByPage(
  regions: readonly PdfElementRegion[],
): Map<number, PageRegionRect[]> {
  const byPage = new Map<number, PageRegionRect[]>();
  for (const region of regions) {
    const pagesSeen = new Set<number>();
    region.rects.forEach((rect, index) => {
      let list = byPage.get(rect.page);
      if (!list) {
        list = [];
        byPage.set(rect.page, list);
      }
      list.push({
        regionId: region.id,
        label: region.label,
        rect,
        rectKey: `${region.id}:${index}`,
        isPrimary: !pagesSeen.has(rect.page),
      });
      pagesSeen.add(rect.page);
    });
  }
  return byPage;
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Scroll offset that preserves the previous scroll *ratio* after the document
 * (and therefore the scrollable height) changed. Not scrollable before or
 * after → top.
 */
export function preservedScrollTop(
  previous: ScrollMetrics,
  next: { scrollHeight: number; clientHeight: number },
): number {
  const previousMax = previous.scrollHeight - previous.clientHeight;
  const nextMax = Math.max(0, next.scrollHeight - next.clientHeight);
  if (previousMax <= 0 || nextMax <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, previous.scrollTop / previousMax));
  return ratio * nextMax;
}

/**
 * Top offset of each page inside the scroller, given rendered page heights,
 * the gap between pages, and the top padding of the page stack.
 */
export function computePageOffsets(
  pageHeights: readonly number[],
  gap: number,
  paddingTop: number,
): number[] {
  const offsets: number[] = [];
  let cursor = paddingTop;
  for (const height of pageHeights) {
    offsets.push(cursor);
    cursor += height + gap;
  }
  return offsets;
}

/**
 * 1-based page number for the current scroll offset: the last page whose top
 * sits above the reading line (35% down the viewport). Gaps between pages
 * attribute to the page above them.
 */
export function currentPageFromScroll(
  scrollTop: number,
  clientHeight: number,
  pageOffsets: readonly number[],
): number {
  if (pageOffsets.length === 0) return 1;
  const anchor = scrollTop + clientHeight * CURRENT_PAGE_ANCHOR_RATIO;
  let current = 1;
  for (let index = 0; index < pageOffsets.length; index += 1) {
    if ((pageOffsets[index] ?? 0) <= anchor) current = index + 1;
    else break;
  }
  return current;
}
