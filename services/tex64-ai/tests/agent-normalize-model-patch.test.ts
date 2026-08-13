import { describe, expect, it } from "vitest";

import { DocumentPatchSchema } from "@/domain/document";
import { normalizeModelDocumentPatch } from "@/server/agent/normalize-model-patch";

const DOCUMENT_ID = "720eb54b-8bec-47ed-9872-fa4778dd145a";
const SOURCE_ID = "5f55e1b7-7368-4bab-9ef3-fb37b32c2553";

function modelPatch() {
  return {
    id: "patch-1",
    documentId: DOCUMENT_ID,
    baseRevision: 2,
    createdAt: "2026-08-13T11:00:00.000Z",
    operations: [
      {
        op: "insert",
        node: {
          id: "cite-ddpm",
          type: "citation",
          sourceId: SOURCE_ID,
          authors: ["Ho, Jonathan"],
          title: "Denoising Diffusion Probabilistic Models",
          year: "2020",
        },
        position: { kind: "definitions" },
      },
      {
        op: "insert",
        node: {
          id: "sec-intro",
          type: "section",
          title: [{ type: "text", text: "序論", marks: [] }],
          children: [],
        },
        position: { kind: "root", index: 0 },
      },
      {
        op: "insert",
        node: {
          id: "para-1",
          type: "paragraph",
          content: [
            { type: "text", text: "DDPMは", marks: [] },
            { type: "citationRef", citationId: "cite-ddpm" },
          ],
        },
        position: { kind: "section", parentId: "sec-intro", index: 0 },
      },
      {
        op: "insert",
        node: {
          id: "bib-1",
          type: "bibliography",
          citationIds: ["cite-ddpm"],
        },
        position: { kind: "root", index: 1 },
      },
    ],
  };
}

describe("normalizeModelDocumentPatch", () => {
  it("rewrites slug ids into stable UUIDs and keeps references coherent", () => {
    const normalized = normalizeModelDocumentPatch(DOCUMENT_ID, modelPatch());
    const parsed = DocumentPatchSchema.parse(normalized);
    const [citation, section, paragraph, bibliography] = parsed.operations;
    if (
      citation?.op !== "insert" ||
      section?.op !== "insert" ||
      paragraph?.op !== "insert" ||
      bibliography?.op !== "insert"
    ) {
      throw new Error("unexpected operation shape");
    }
    // Verified source ids are never rewritten.
    expect(
      citation.node.type === "citation" ? citation.node.sourceId : null,
    ).toBe(SOURCE_ID);
    // The paragraph's citationRef follows the citation node's new id.
    const inline =
      paragraph.node.type === "paragraph" ? paragraph.node.content[1] : null;
    expect(inline?.type).toBe("citationRef");
    if (inline?.type === "citationRef") {
      expect(inline.citationId).toBe(citation.node.id);
    }
    // The insert position follows the section's new id.
    expect(
      paragraph.position.kind === "section" ? paragraph.position.parentId : null,
    ).toBe(section.node.id);
    expect(
      bibliography.node.type === "bibliography"
        ? bibliography.node.citationIds
        : null,
    ).toEqual([citation.node.id]);
    // Same slug, same document -> same UUID on a later patch.
    const again = DocumentPatchSchema.parse(
      normalizeModelDocumentPatch(DOCUMENT_ID, modelPatch()),
    );
    expect(again.operations[1]).toEqual(parsed.operations[1]);
  });

  it("keeps prose strings and keywords untouched", () => {
    const normalized = normalizeModelDocumentPatch(DOCUMENT_ID, {
      id: "patch-2",
      documentId: DOCUMENT_ID,
      baseRevision: 2,
      createdAt: "2026-08-13T11:00:00.000Z",
      operations: [
        {
          op: "setMetadata",
          metadata: { title: "拡散モデル", keywords: ["DDPM", "DDIM"] },
        },
      ],
    }) as { operations: [{ metadata: { title: string; keywords: string[] } }] };
    expect(normalized.operations[0].metadata.title).toBe("拡散モデル");
    expect(normalized.operations[0].metadata.keywords).toEqual(["DDPM", "DDIM"]);
  });
});

describe("scripted text runs", () => {
  it("splits Unicode sub/superscripts into marked segments", () => {
    const normalized = normalizeModelDocumentPatch(DOCUMENT_ID, {
      id: "patch-3",
      documentId: DOCUMENT_ID,
      baseRevision: 2,
      createdAt: "2026-08-13T11:00:00.000Z",
      operations: [
        {
          op: "insert",
          node: {
            id: "para-sub",
            type: "paragraph",
            content: [{ type: "text", text: "初期値x₀とx₁²を考える", marks: [] }],
          },
          position: { kind: "root", index: 0 },
        },
      ],
    });
    const parsed = DocumentPatchSchema.parse(normalized);
    const op = parsed.operations[0];
    if (op?.op !== "insert" || op.node.type !== "paragraph") {
      throw new Error("unexpected shape");
    }
    const runs = op.node.content.flatMap((inline) =>
      inline.type === "text" ? [[inline.text, inline.marks.join("+")]] : [],
    );
    expect(runs).toEqual([
      ["初期値x", ""],
      ["0", "subscript"],
      ["とx", ""],
      ["1", "subscript"],
      ["2", "superscript"],
      ["を考える", ""],
    ]);
  });
});
