import { describe, expect, it } from "vitest";

import {
  findTextBlockRects,
  type TextItemLike,
} from "@/components/pdf-text-blocks";

/** A line of text at `top`, 10pt tall, from x=100 to x=100+width. */
function line(top: number, width: number, str = "text"): TextItemLike {
  return { transform: [10, 0, 0, 10, 100, top + 10], width, height: 10, str };
}

describe("text block from a click", () => {
  it("returns the whole paragraph the click landed in", () => {
    const items = [line(0, 300), line(12, 300), line(24, 200)];
    const rects = findTextBlockRects(items, { x: 150, y: 15 });
    expect(rects).toHaveLength(3);
    expect(rects[0]?.top).toBe(0);
    expect(rects[2]?.top).toBe(24);
  });

  it("stops at a paragraph break", () => {
    const items = [line(0, 300), line(12, 300), line(60, 300), line(72, 300)];
    const rects = findTextBlockRects(items, { x: 150, y: 65 });
    expect(rects.map((rect) => rect.top)).toEqual([60, 72]);
  });

  it("returns nothing when the click misses the text", () => {
    expect(findTextBlockRects([line(0, 300)], { x: 150, y: 400 })).toEqual([]);
  });

  it("ignores blank items", () => {
    const items = [line(0, 300), { ...line(12, 300, "   ") }];
    expect(findTextBlockRects(items, { x: 150, y: 5 })).toHaveLength(1);
  });
});
