import { describe, expect, it, vi } from "vitest";

const generateTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: generateTextMock };
});

import {
  PdfVisualReviewDimensionSchema,
  PdfVisualReviewDraftSchema,
  blockingPdfVisualFindings,
  reviewPdfVisualQuality,
} from "@/server/compiler/visual-review";

function review(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "passed" as const,
    reviewedPages: [1, 2],
    dimensions: PdfVisualReviewDimensionSchema.options.map((dimension) => ({
      dimension,
      status: "passed" as const,
      summary: `${dimension} is readable`,
    })),
    findings: [],
    ...overrides,
  };
}

describe("independent PDF visual review", () => {
  it("requires unique ascending page evidence", () => {
    expect(PdfVisualReviewDraftSchema.safeParse(review()).success).toBe(true);
    expect(
      PdfVisualReviewDraftSchema.safeParse(
        review({ reviewedPages: [1, 1] }),
      ).success,
    ).toBe(false);
  });

  it("fails closed unless every actual PDF page is covered", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: review({ reviewedPages: [1] }),
    });
    await expect(
      reviewPdfVisualQuality({
        pdf: new TextEncoder().encode("%PDF-1.7\n%%EOF\n"),
        pageCount: 2,
        runtime: { provider: "ai_gateway", model: "openai/gpt-5.6-sol" },
      }),
    ).rejects.toThrow("every rendered page");
  });

  it("returns only blocker and major observations to the repair gate", () => {
    const parsed = PdfVisualReviewDraftSchema.parse(
      review({
        verdict: "repair_required",
        dimensions: PdfVisualReviewDimensionSchema.options.map((dimension) => ({
          dimension,
          status: dimension === "clipping" ? "failed" : "passed",
          summary: `${dimension} reviewed`,
        })),
        findings: [
          {
            severity: "major",
            category: "clipping",
            page: 2,
            detail: "The right edge of the table is cut off.",
          },
          {
            severity: "minor",
            category: "typography",
            page: 1,
            detail: "One heading is slightly loose.",
          },
        ],
      }),
    );
    expect(blockingPdfVisualFindings(parsed)).toEqual([
      expect.objectContaining({ severity: "major", page: 2 }),
    ]);
  });
});
