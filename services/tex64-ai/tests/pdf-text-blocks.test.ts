import { describe, expect, it } from "vitest";

import {
  findTextBlockRects,
  type TextItemLike,
} from "@/components/pdf-text-blocks";

/**
 * A line of text at `top`, 10pt tall, from x=100 to x=100+width.
 * transform[5] is the baseline, which sits 0.78 of the height below the top.
 */
function line(top: number, width: number, str = "text"): TextItemLike {
  return { transform: [10, 0, 0, 10, 100, top + 10 * 0.78], width, height: 10, str };
}

/** A first line, indented the way LaTeX indents a new paragraph. */
function indented(top: number, width: number): TextItemLike {
  return { transform: [10, 0, 0, 10, 115, top + 10 * 0.78], width, height: 10, str: "text" };
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

  it("separates paragraphs by their indent, with no gap between them", () => {
    // LaTeX leaves no extra vertical space between paragraphs; the indent of
    // the first line is the only signal.
    const items = [
      indented(0, 300),
      line(12, 300),
      indented(24, 300),
      line(36, 200),
    ];
    expect(
      findTextBlockRects(items, { x: 150, y: 5 }).map((rect) => rect.top),
    ).toEqual([0, 12]);
    expect(
      findTextBlockRects(items, { x: 150, y: 29 }).map((rect) => rect.top),
    ).toEqual([24, 36]);
  });

  it("does not reach past a heading into the body below it", () => {
    const items = [
      { transform: [10, 0, 0, 10, 260, 10], width: 80, height: 10, str: "Abstract" },
      indented(24, 300),
      line(36, 300),
    ];
    expect(
      findTextBlockRects(items, { x: 150, y: 29 }).map((rect) => rect.top),
    ).toEqual([24, 36]);
  });

  it("measures the indent inside an inset block, not against the page", () => {
    // An abstract is inset as a whole: every one of its lines sits right of
    // the page margin the body below it uses.
    const body = (top: number, left: number, width: number): TextItemLike => ({
      transform: [10, 0, 0, 10, left, top + 10 * 0.78],
      width,
      height: 10,
      str: "text",
    });
    const items = [
      // Inset block: first line indented within it, then two continuations.
      body(0, 110, 280),
      body(12, 98, 300),
      body(24, 98, 300),
      // Page body far below, at the page margin.
      body(200, 86, 300),
      body(212, 86, 300),
    ];
    expect(
      findTextBlockRects(items, { x: 150, y: 17 }).map((rect) => rect.top),
    ).toEqual([0, 12, 24]);
  });

  it("returns nothing when the click misses the text", () => {
    expect(findTextBlockRects([line(0, 300)], { x: 150, y: 400 })).toEqual([]);
  });

  it("ignores entries that carry no geometry", () => {
    // pdf.js mixes marked-content markers into the same list.
    const items = [line(0, 300), { str: "" } as TextItemLike];
    expect(findTextBlockRects(items, { x: 150, y: 5 })).toHaveLength(1);
  });

  it("ignores blank items", () => {
    const items = [line(0, 300), { ...line(12, 300, "   ") }];
    expect(findTextBlockRects(items, { x: 150, y: 5 })).toHaveLength(1);
  });
});
