import { describe, expect, it } from "vitest";
import {
  diffDocumentPatch,
  mergePendingPatch,
  rebasePatchAfterConflict,
} from "@/lib/client/document-save";
import type { DocumentDetail, ParagraphBlock } from "@/lib/client/types";

function paragraph(id: string, text: string): ParagraphBlock {
  return { id, type: "paragraph", text };
}

function detail(
  revision: number,
  blocks: ParagraphBlock[],
  title = "題名",
): DocumentDetail {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    title,
    kind: "paper",
    status: "working",
    updatedAt: `2026-08-07T00:00:0${revision}.000Z`,
    preview: "preview",
    revision,
    blocks,
    elements: [],
    versions: [],
    messages: [],
  };
}

describe("document save coordination", () => {
  it("keeps a pending field change without resending unrelated fields", () => {
    const baseline = detail(4, [paragraph("a", "A")]);
    const titlePatch = mergePendingPatch(baseline, null, { title: "新しい題名" });
    const combined = mergePendingPatch(baseline, titlePatch, { author: "著者" });

    expect(combined).toEqual({
      baseRevision: 4,
      title: "新しい題名",
      author: "著者",
    });
  });

  it("rebases local block edits without discarding unrelated remote edits", () => {
    const baseline = detail(1, [
      paragraph("a", "A"),
      paragraph("b", "B"),
      paragraph("c", "C"),
    ]);
    const desired = detail(1, [
      paragraph("a", "A"),
      paragraph("b", "B local"),
      paragraph("d", "D local"),
    ]);
    const remote = detail(2, [
      paragraph("a", "A remote"),
      paragraph("b", "B"),
      paragraph("c", "C remote"),
      paragraph("e", "E remote"),
    ]);

    const rebased = rebasePatchAfterConflict({
      baseline,
      desired,
      remote,
      patch: { baseRevision: 1, blocks: desired.blocks },
    });

    expect(rebased.desired.blocks).toEqual([
      paragraph("a", "A remote"),
      paragraph("b", "B local"),
      paragraph("d", "D local"),
      paragraph("e", "E remote"),
    ]);
    expect(rebased.patch?.baseRevision).toBe(2);
  });

  it("retains only edits that remain after an earlier save completes", () => {
    const persisted = detail(2, [paragraph("a", "A")], "保存済み");
    const local = { ...persisted, author: "著者" };

    expect(diffDocumentPatch(persisted, local)).toEqual({
      baseRevision: 2,
      author: "著者",
    });
  });

  it("keeps a remote scalar edit when the local field returned to its baseline", () => {
    const baseline = detail(1, [paragraph("a", "A")], "A");
    const desired = detail(1, [paragraph("a", "A")], "A");
    const remote = detail(2, [paragraph("a", "A")], "C remote");

    const rebased = rebasePatchAfterConflict({
      baseline,
      desired,
      remote,
      patch: { baseRevision: 1, title: "A" },
    });

    expect(rebased.desired.title).toBe("C remote");
    expect(rebased.patch).toBeNull();
  });
});
