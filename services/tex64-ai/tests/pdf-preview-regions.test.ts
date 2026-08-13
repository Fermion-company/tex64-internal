import { describe, expect, it } from "vitest";
import {
  CURRENT_PAGE_ANCHOR_RATIO,
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  bpRectToPx,
  clampZoomPercent,
  computePageOffsets,
  currentPageFromScroll,
  fitToWidthPercent,
  groupRectsByPage,
  preservedScrollTop,
  type PdfElementRegion,
} from "@/components/pdf-preview-geometry";

describe("bpRectToPx", () => {
  it("scales every edge of a bp rect by the viewport scale", () => {
    const rect = { page: 1, x: 72, y: 144, width: 200, height: 50 };
    expect(bpRectToPx(rect, 2)).toEqual({ left: 144, top: 288, width: 400, height: 100 });
  });

  it("is the identity at scale 1", () => {
    const rect = { page: 3, x: 10.5, y: 20.25, width: 30, height: 40 };
    expect(bpRectToPx(rect, 1)).toEqual({ left: 10.5, top: 20.25, width: 30, height: 40 });
  });

  it("handles fractional zoom scales", () => {
    const rect = { page: 1, x: 100, y: 200, width: 40, height: 80 };
    const px = bpRectToPx(rect, 0.75);
    expect(px.left).toBeCloseTo(75);
    expect(px.top).toBeCloseTo(150);
    expect(px.width).toBeCloseTo(30);
    expect(px.height).toBeCloseTo(60);
  });
});

describe("groupRectsByPage", () => {
  const regions: PdfElementRegion[] = [
    {
      id: "eq-1",
      label: "式 (1)",
      rects: [
        { page: 1, x: 0, y: 0, width: 10, height: 10 },
        { page: 1, x: 0, y: 20, width: 10, height: 10 },
        { page: 2, x: 0, y: 0, width: 10, height: 10 },
      ],
    },
    {
      id: "fig-1",
      label: "図 1",
      rects: [{ page: 2, x: 5, y: 5, width: 20, height: 20 }],
    },
  ];

  it("groups rects under their 1-based page numbers", () => {
    const byPage = groupRectsByPage(regions);
    expect([...byPage.keys()].sort()).toEqual([1, 2]);
    expect(byPage.get(1)).toHaveLength(2);
    expect(byPage.get(2)).toHaveLength(2);
    expect(byPage.get(2)?.map((entry) => entry.regionId)).toEqual(["eq-1", "fig-1"]);
  });

  it("marks exactly one primary rect per region per page (label chip anchor)", () => {
    const byPage = groupRectsByPage(regions);
    const page1 = byPage.get(1) ?? [];
    expect(page1.map((entry) => entry.isPrimary)).toEqual([true, false]);
    const page2 = byPage.get(2) ?? [];
    expect(page2.filter((entry) => entry.regionId === "eq-1").map((e) => e.isPrimary)).toEqual([
      true,
    ]);
    expect(page2.filter((entry) => entry.regionId === "fig-1").map((e) => e.isPrimary)).toEqual([
      true,
    ]);
  });

  it("carries the region label and a unique stable rect key", () => {
    const byPage = groupRectsByPage(regions);
    const keys = [...byPage.values()].flat().map((entry) => entry.rectKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(byPage.get(1)?.[0]?.label).toBe("式 (1)");
    expect(byPage.get(1)?.[0]?.rectKey).toBe("eq-1:0");
    expect(byPage.get(1)?.[1]?.rectKey).toBe("eq-1:1");
  });

  it("returns an empty map for no regions", () => {
    expect(groupRectsByPage([]).size).toBe(0);
  });
});

describe("preservedScrollTop", () => {
  it("keeps the scroll ratio when the document height changes", () => {
    // Previously halfway down; new document is twice as tall.
    const next = { scrollHeight: 4600, clientHeight: 600 };
    const previous = { scrollTop: 700, scrollHeight: 2000, clientHeight: 600 };
    // ratio = 700 / 1400 = 0.5 → 0.5 * (4600 - 600) = 2000
    expect(preservedScrollTop(previous, next)).toBe(2000);
  });

  it("keeps top at top and bottom at bottom", () => {
    const previous = { scrollTop: 0, scrollHeight: 2000, clientHeight: 600 };
    expect(preservedScrollTop(previous, { scrollHeight: 999, clientHeight: 600 })).toBe(0);
    const atBottom = { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 };
    expect(preservedScrollTop(atBottom, { scrollHeight: 1000, clientHeight: 600 })).toBe(400);
  });

  it("returns 0 when either layout cannot scroll", () => {
    const shortDoc = { scrollTop: 0, scrollHeight: 500, clientHeight: 600 };
    expect(preservedScrollTop(shortDoc, { scrollHeight: 5000, clientHeight: 600 })).toBe(0);
    const previous = { scrollTop: 700, scrollHeight: 2000, clientHeight: 600 };
    expect(preservedScrollTop(previous, { scrollHeight: 400, clientHeight: 600 })).toBe(0);
  });

  it("clamps a stale scrollTop that exceeds the previous maximum", () => {
    const previous = { scrollTop: 9999, scrollHeight: 2000, clientHeight: 600 };
    expect(preservedScrollTop(previous, { scrollHeight: 1600, clientHeight: 600 })).toBe(1000);
  });
});

describe("computePageOffsets", () => {
  it("accumulates heights, gaps, and the top padding", () => {
    expect(computePageOffsets([800, 800, 400], 16, 24)).toEqual([24, 840, 1656]);
  });

  it("returns an empty list for no pages", () => {
    expect(computePageOffsets([], 16, 24)).toEqual([]);
  });
});

describe("currentPageFromScroll", () => {
  // Three 800px pages, 16px gap, 24px padding → offsets [24, 840, 1656].
  const offsets = computePageOffsets([800, 800, 800], 16, 24);
  const clientHeight = 600;
  const anchorOffset = clientHeight * CURRENT_PAGE_ANCHOR_RATIO;

  it("reports page 1 at the top", () => {
    expect(currentPageFromScroll(0, clientHeight, offsets)).toBe(1);
  });

  it("advances once the reading line crosses the next page top", () => {
    // Anchor sits at scrollTop + 35% of the viewport.
    const justBefore = 840 - anchorOffset - 1;
    const justAfter = 840 - anchorOffset + 1;
    expect(currentPageFromScroll(justBefore, clientHeight, offsets)).toBe(1);
    expect(currentPageFromScroll(justAfter, clientHeight, offsets)).toBe(2);
  });

  it("attributes the gap between pages to the page above it", () => {
    // Anchor inside the 16px gap right before page 2's top.
    const anchorInGap = 840 - anchorOffset - 8;
    expect(currentPageFromScroll(anchorInGap, clientHeight, offsets)).toBe(1);
  });

  it("clamps to the last page for very large offsets", () => {
    expect(currentPageFromScroll(99999, clientHeight, offsets)).toBe(3);
  });

  it("falls back to page 1 when there are no pages", () => {
    expect(currentPageFromScroll(500, clientHeight, [])).toBe(1);
  });
});

describe("zoom helpers", () => {
  it("clamps zoom to the 50–300% range and rounds", () => {
    expect(clampZoomPercent(49)).toBe(MIN_ZOOM_PERCENT);
    expect(clampZoomPercent(50)).toBe(50);
    expect(clampZoomPercent(123.4)).toBe(123);
    expect(clampZoomPercent(300)).toBe(300);
    expect(clampZoomPercent(301)).toBe(MAX_ZOOM_PERCENT);
    expect(clampZoomPercent(Number.NaN)).toBe(100);
  });

  it("computes a fit-to-width percentage from bp page width", () => {
    // 612bp US Letter page in a 918px-wide slot → 150%.
    expect(fitToWidthPercent(918, 612)).toBe(150);
  });

  it("clamps fit-to-width into the zoom range", () => {
    expect(fitToWidthPercent(100, 612)).toBe(MIN_ZOOM_PERCENT);
    expect(fitToWidthPercent(10000, 612)).toBe(MAX_ZOOM_PERCENT);
  });

  it("falls back to 100% before the container is measured", () => {
    expect(fitToWidthPercent(0, 612)).toBe(100);
    expect(fitToWidthPercent(-10, 612)).toBe(100);
    expect(fitToWidthPercent(800, 0)).toBe(100);
  });
});
