import { describe, expect, it } from "vitest";
import {
  evaluateRenderedPageTarget,
  parsePageTarget,
} from "@/server/compiler/page-target";

describe("rendered PDF page targets", () => {
  it.each([
    ["10ページ", { minimum: 10, maximum: 10, approximate: false }],
    ["8〜12頁", { minimum: 8, maximum: 12, approximate: false }],
    ["5ページ以上", { minimum: 5, approximate: false }],
    ["6 pages or less", { minimum: 1, maximum: 6, approximate: false }],
    ["約20ページ", { minimum: 18, maximum: 22, approximate: true }],
  ])("parses %s", (value, expected) => {
    expect(parsePageTarget(value)).toEqual(expected);
  });

  it.each(["4000文字", "1000 words", "ページはあとで決める", "0ページ"])(
    "rejects an unsupported page target: %s",
    (value) => {
      expect(parsePageTarget(value)).toBeNull();
    },
  );

  it("evaluates only page-based targets after rendering", () => {
    expect(evaluateRenderedPageTarget("4000文字", 4)).toEqual({
      status: "not_applicable",
    });
    expect(evaluateRenderedPageTarget("3〜5ページ", 4)).toMatchObject({
      status: "passed",
      observed: 4,
    });
    expect(evaluateRenderedPageTarget("3〜5ページ", 7)).toMatchObject({
      status: "failed",
      observed: 7,
    });
    expect(evaluateRenderedPageTarget("ページはあとで決める", 4)).toEqual({
      status: "unsupported",
    });
  });

  it("keeps page targets within the full visual-review contract", () => {
    expect(parsePageTarget("500ページ")).toEqual({
      minimum: 500,
      maximum: 500,
      approximate: false,
    });
    expect(parsePageTarget("501ページ")).toBeNull();
  });
});
