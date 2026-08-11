import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SAMPLE_DOCUMENT,
  SAMPLE_DOCUMENT_IDS,
  type DocumentModel,
  type DocumentNode,
  type DocumentPatch,
} from "@/domain/document";
import {
  SourceProvenanceError,
  canonicalCitationMetadataFromSource,
  citationSourceIdsForPatch,
  normalizeCitationPatchWithSources,
  type SourceRecord,
} from "@/server/sources";

const SOURCE_ID = "70000000-0000-4000-8000-000000000001";
const SECOND_SOURCE_ID = "70000000-0000-4000-8000-000000000002";
const NEW_CITATION_ID = "70000000-0000-4000-8000-000000000003";
const PATCH_ID = "70000000-0000-4000-8000-000000000004";
const CONTENT = "Verified abstract evidence.";

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    schemaVersion: 1,
    id: SOURCE_ID,
    userId: "70000000-0000-4000-8000-000000000005",
    documentId: SAMPLE_DOCUMENT.id,
    kind: "doi",
    canonicalLocator: "https://doi.org/10.5555/attention",
    resolvedLocator: "https://api.crossref.org/works/10.5555%2Fattention",
    verification: "verified_content",
    evidenceScope: "abstract",
    contentText: CONTENT,
    contentSha256: createHash("sha256").update(CONTENT, "utf8").digest("hex"),
    metadata: {
      provider: "crossref",
      title: "  Selective\n attention  ",
      authors: [{ name: " Ada   Lovelace " }, { name: "Alan Turing" }],
      publication: " Journal of Attention ",
      publisher: " Research Press ",
      volume: " 12 ",
      issue: " 3 ",
      pages: " 44-58 ",
      workType: "journal_article",
      language: "en",
      publishedAt: "2025-07-02",
      doi: "10.5555/ATTENTION",
      contentType: "application/json",
    },
    fetchedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

function patch(operations: DocumentPatch["operations"]): DocumentPatch {
  return {
    id: PATCH_ID,
    documentId: SAMPLE_DOCUMENT.id,
    baseRevision: 0,
    createdAt: "2026-08-07T00:00:00.000Z",
    operations,
  };
}

function fakeCitation(id = NEW_CITATION_ID, sourceId: string | null = SOURCE_ID) {
  return {
    id,
    type: "citation" as const,
    ...(sourceId ? { sourceId } : {}),
    authors: ["Invented Author"],
    title: "Invented title",
    year: "1999",
    publication: "Invented publication",
    doi: "10.0000/invented",
    url: "https://attacker.example.net/fake",
  };
}

function currentCitation(document: DocumentModel): Extract<DocumentNode, { type: "citation" }> {
  const citation = document.nodes.find((node) => node.id === SAMPLE_DOCUMENT_IDS.citation);
  if (citation?.type !== "citation") throw new Error("Sample citation missing");
  return citation;
}

describe("citation source provenance", () => {
  it("projects bounded canonical citation metadata from verified SourceRecord only", () => {
    expect(canonicalCitationMetadataFromSource(source())).toEqual({
      sourceId: SOURCE_ID,
      authors: ["Ada Lovelace", "Alan Turing"],
      title: "Selective attention",
      year: "2025",
      publication: "Journal of Attention",
      publisher: "Research Press",
      volume: "12",
      issue: "3",
      pages: "44-58",
      sourceType: "journal_article",
      sourceLanguage: "en",
      doi: "10.5555/attention",
      url: "https://doi.org/10.5555/attention",
    });
  });

  it("requires sourceId on new citations and returns unique IDs in operation order", () => {
    const missing = patch([
      {
        op: "insert",
        node: fakeCitation(NEW_CITATION_ID, null),
        position: { kind: "definitions" },
      },
    ]);
    expect(() => citationSourceIdsForPatch(SAMPLE_DOCUMENT, missing)).toThrow(
      expect.objectContaining<Partial<SourceProvenanceError>>({
        code: "citation_source_required",
      }),
    );

    const withTwoMutations = patch([
      {
        op: "insert",
        node: fakeCitation(),
        position: { kind: "definitions" },
      },
      {
        op: "update",
        nodeId: NEW_CITATION_ID,
        node: fakeCitation(NEW_CITATION_ID),
      },
    ]);
    expect(citationSourceIdsForPatch(SAMPLE_DOCUMENT, withTwoMutations)).toEqual([SOURCE_ID]);
  });

  it("replaces every model-supplied citation field with the canonical source projection", () => {
    const input = patch([
      {
        op: "insert",
        node: fakeCitation(),
        position: { kind: "definitions" },
      },
    ]);
    const normalized = normalizeCitationPatchWithSources({
      document: SAMPLE_DOCUMENT,
      patch: input,
      sources: [source()],
    });
    const operation = normalized.operations[0];
    expect(operation?.op).toBe("insert");
    if (operation?.op !== "insert") return;
    expect(operation.node).toEqual({
      id: NEW_CITATION_ID,
      type: "citation",
      sourceId: SOURCE_ID,
      authors: ["Ada Lovelace", "Alan Turing"],
      title: "Selective attention",
      year: "2025",
      publication: "Journal of Attention",
      publisher: "Research Press",
      volume: "12",
      issue: "3",
      pages: "44-58",
      sourceType: "journal_article",
      sourceLanguage: "en",
      doi: "10.5555/attention",
      url: "https://doi.org/10.5555/attention",
    });
  });

  it("safely inherits the current sourceId when updating an existing citation", () => {
    const document = structuredClone(SAMPLE_DOCUMENT);
    const citation = currentCitation(document);
    citation.sourceId = SOURCE_ID;
    const updated = { ...citation, sourceId: undefined, title: "Model rewrite" };
    const input = patch([{ op: "update", nodeId: citation.id, node: updated }]);

    expect(citationSourceIdsForPatch(document, input)).toEqual([SOURCE_ID]);
    const normalized = normalizeCitationPatchWithSources({
      document,
      patch: input,
      sources: [source()],
    });
    const operation = normalized.operations[0];
    expect(operation?.op).toBe("update");
    if (operation?.op !== "update") return;
    expect(operation.node).toMatchObject({
      type: "citation",
      sourceId: SOURCE_ID,
      title: "Selective attention",
    });
  });

  it("allows unchanged legacy citations and citationRef reuse without loading a source", () => {
    const paragraph = SAMPLE_DOCUMENT.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.paragraph,
    );
    if (paragraph?.type !== "paragraph") throw new Error("Sample paragraph missing");
    const updated = {
      ...paragraph,
      content: [{ type: "citationRef" as const, citationId: SAMPLE_DOCUMENT_IDS.citation }],
    };
    const input = patch([{ op: "update", nodeId: paragraph.id, node: updated }]);
    expect(citationSourceIdsForPatch(SAMPLE_DOCUMENT, input)).toEqual([]);
    expect(
      normalizeCitationPatchWithSources({ document: SAMPLE_DOCUMENT, patch: input, sources: [] }),
    ).toBe(input);
  });

  it("rejects changing an existing citation into a different node type", () => {
    const citation = currentCitation(SAMPLE_DOCUMENT);
    const input = patch([
      {
        op: "update",
        nodeId: citation.id,
        node: {
          id: citation.id,
          type: "paragraph",
          content: [{ type: "text", text: "replacement", marks: [] }],
        },
      },
    ]);
    expect(() => citationSourceIdsForPatch(SAMPLE_DOCUMENT, input)).toThrow(
      expect.objectContaining({ code: "citation_type_change" }),
    );
  });

  it("fails closed for metadata-only, tampered, incomplete, missing and cross-document sources", () => {
    const input = patch([
      {
        op: "insert",
        node: fakeCitation(),
        position: { kind: "definitions" },
      },
    ]);
    const cases: Array<[readonly SourceRecord[], string]> = [
      [[], "citation_source_not_found"],
      [
        [
          source({
            verification: "metadata_only",
            evidenceScope: "none",
            contentText: null,
            contentSha256: null,
          }),
        ],
        "citation_source_not_verified",
      ],
      [[source({ contentSha256: "a".repeat(64) })], "citation_source_not_verified"],
      [
        [source({ metadata: { ...source().metadata, authors: [] } })],
        "citation_metadata_incomplete",
      ],
      [
        [source({ documentId: "70000000-0000-4000-8000-000000000099" })],
        "citation_source_scope_mismatch",
      ],
    ];
    for (const [sources, code] of cases) {
      expect(() =>
        normalizeCitationPatchWithSources({ document: SAMPLE_DOCUMENT, patch: input, sources }),
      ).toThrow(expect.objectContaining({ code }));
    }
  });

  it("uses the most recent sourceId across sequential citation updates", () => {
    const second = source({
      id: SECOND_SOURCE_ID,
      canonicalLocator: "https://doi.org/10.5555/second",
      metadata: { ...source().metadata, doi: "10.5555/second", title: "Second source" },
    });
    const input = patch([
      {
        op: "insert",
        node: fakeCitation(),
        position: { kind: "definitions" },
      },
      {
        op: "update",
        nodeId: NEW_CITATION_ID,
        node: fakeCitation(NEW_CITATION_ID, SECOND_SOURCE_ID),
      },
      {
        op: "update",
        nodeId: NEW_CITATION_ID,
        node: fakeCitation(NEW_CITATION_ID, null),
      },
    ]);
    expect(citationSourceIdsForPatch(SAMPLE_DOCUMENT, input)).toEqual([
      SOURCE_ID,
      SECOND_SOURCE_ID,
    ]);
    const normalized = normalizeCitationPatchWithSources({
      document: SAMPLE_DOCUMENT,
      patch: input,
      sources: [source(), second],
    });
    const final = normalized.operations[2];
    expect(final?.op).toBe("update");
    if (final?.op !== "update") return;
    expect(final.node).toMatchObject({ sourceId: SECOND_SOURCE_ID, title: "Second source" });
  });

  it("fails closed before loading an unbounded number of citation sources", () => {
    const operations = Array.from({ length: 101 }, (_, index) => ({
      op: "insert" as const,
      node: fakeCitation(
        `72000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        `73000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ),
      position: { kind: "definitions" as const },
    }));
    expect(() => citationSourceIdsForPatch(SAMPLE_DOCUMENT, patch(operations))).toThrow(
      expect.objectContaining({ code: "invalid_document_patch" }),
    );
  });
});
