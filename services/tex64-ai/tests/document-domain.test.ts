import { describe, expect, it } from "vitest";
import {
  DocumentConflictError,
  DocumentOperationSchema,
  DocumentPatchSchema,
  DocumentSchema,
  DocumentValidationError,
  MAX_CODE_BYTES,
  MAX_MATRIX_CELLS,
  SAMPLE_DOCUMENT,
  SAMPLE_DOCUMENT_IDS,
  SAMPLE_DOCUMENT_REVISION,
  applyDocumentPatch,
  safeValidateDocument,
  validateDocument,
  type DocumentModel,
  type DocumentNode,
  type DocumentPatch,
  type DocumentRevision,
} from "@/domain/document";

type ParagraphNode = Extract<DocumentNode, { type: "paragraph" }>;

const PATCH_ID = "20000000-0000-4000-8000-000000000001";
const INSERTED_PARAGRAPH_ID = "20000000-0000-4000-8000-000000000002";

function paragraph(document: DocumentModel): ParagraphNode {
  const node = document.nodes.find((candidate) => candidate.id === SAMPLE_DOCUMENT_IDS.paragraph);
  if (node?.type !== "paragraph") throw new Error("Sample paragraph is missing");
  return node;
}

function normalPatch(): DocumentPatch {
  const updatedParagraph: ParagraphNode = {
    ...paragraph(SAMPLE_DOCUMENT),
    content: [{ type: "text", text: "原子的なpatchで内容を更新しました。", marks: ["bold"] }],
  };
  return {
    id: PATCH_ID,
    documentId: SAMPLE_DOCUMENT.id,
    baseRevision: 0,
    createdAt: "2026-08-07T01:00:00.000Z",
    operations: [
      {
        op: "insert",
        node: {
          id: INSERTED_PARAGRAPH_ID,
          type: "paragraph",
          content: [{ type: "text", text: "新しく挿入された段落です。", marks: [] }],
        },
        position: { kind: "root", index: 1 },
      },
      { op: "update", nodeId: updatedParagraph.id, node: updatedParagraph },
      {
        op: "move",
        nodeId: SAMPLE_DOCUMENT_IDS.callout,
        position: { kind: "section", parentId: SAMPLE_DOCUMENT_IDS.section, index: 0 },
      },
      { op: "delete", nodeId: SAMPLE_DOCUMENT_IDS.pageBreak },
      {
        op: "setMetadata",
        metadata: {
          ...SAMPLE_DOCUMENT.metadata,
          title: "更新済み文書",
          updatedAt: "2026-08-07T00:30:00.000Z",
        },
      },
    ],
  };
}

describe("document domain", () => {
  it("rejects a schema-valid document above the aggregate serialized budget", () => {
    const oversized = structuredClone(SAMPLE_DOCUMENT);
    const section = oversized.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.section,
    );
    if (section?.type !== "section") throw new Error("Sample section is missing");
    for (let index = 0; index < 24; index += 1) {
      const id = `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      oversized.nodes.push({
        id,
        type: "paragraph",
        content: [{ type: "text", text: "あ".repeat(95_000), marks: [] }],
      });
      section.children.push(id);
    }

    expect(() => validateDocument(oversized)).toThrow(DocumentValidationError);
    const result = safeValidateDocument(oversized);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ code: "resource_limit" }),
      );
    }
  });

  it("exports a valid sample covering the typed document model", () => {
    expect(DocumentSchema.safeParse(SAMPLE_DOCUMENT).success).toBe(true);
    expect(DocumentPatchSchema.safeParse(normalPatch()).success).toBe(true);
    expect(DocumentOperationSchema.safeParse(normalPatch().operations[0]).success).toBe(true);
    expect(validateDocument(SAMPLE_DOCUMENT)).toEqual(SAMPLE_DOCUMENT);

    const types = new Set(SAMPLE_DOCUMENT.nodes.map((node) => node.type));
    expect(types).toEqual(
      new Set([
        "section",
        "paragraph",
        "heading",
        "list",
        "equation",
        "figure",
        "table",
        "callout",
        "pageBreak",
        "citation",
        "bibliography",
        "footnote",
      ]),
    );
  });

  it("applies insert, update, move, delete and metadata operations atomically", () => {
    const before = structuredClone(SAMPLE_DOCUMENT_REVISION);
    const originalJson = JSON.stringify(before);
    const result = applyDocumentPatch(before, normalPatch());

    expect(result.revision).toBe(1);
    expect(result.document.schemaVersion).toBe(1);
    expect(result.revisionId).toBe(PATCH_ID);
    expect(result.parentRevisionId).toBe(SAMPLE_DOCUMENT_REVISION.revisionId);
    expect(result.document.metadata.title).toBe("更新済み文書");
    expect(result.document.metadata.updatedAt).toBe("2026-08-07T01:00:00.000Z");
    expect(result.document.root[1]).toBe(INSERTED_PARAGRAPH_ID);
    expect(paragraph(result.document).content[0]).toMatchObject({
      type: "text",
      text: "原子的なpatchで内容を更新しました。",
    });

    const section = result.document.nodes.find((node) => node.id === SAMPLE_DOCUMENT_IDS.section);
    expect(section?.type).toBe("section");
    if (section?.type !== "section") throw new Error("Section is missing");
    expect(section.children[0]).toBe(SAMPLE_DOCUMENT_IDS.callout);
    expect(section.children).not.toContain(SAMPLE_DOCUMENT_IDS.pageBreak);
    expect(result.document.nodes.some((node) => node.id === SAMPLE_DOCUMENT_IDS.pageBreak)).toBe(false);
    expect(JSON.stringify(before)).toBe(originalJson);
  });

  it("upgrades legacy documents when an allowlisted layout is applied", () => {
    const metadata = {
      ...structuredClone(SAMPLE_DOCUMENT.metadata),
      layout: { preset: "compact", pageSize: "A5", columns: 2 } as const,
      citationStyle: { schemaVersion: 1, style: "numeric" } as const,
    };
    const result = applyDocumentPatch(SAMPLE_DOCUMENT_REVISION, {
      id: "20000000-0000-4000-8000-000000000010",
      documentId: SAMPLE_DOCUMENT.id,
      baseRevision: 0,
      createdAt: "2026-08-07T02:00:00.000Z",
      operations: [{ op: "setMetadata", metadata }],
    });

    expect(result.document.schemaVersion).toBe(2);
    expect(result.document.metadata.layout).toEqual(metadata.layout);
    expect(result.document.metadata.citationStyle).toEqual(
      metadata.citationStyle,
    );
    expect(
      DocumentSchema.safeParse({
        ...result.document,
        metadata: {
          ...result.document.metadata,
          layout: {
            ...metadata.layout,
            documentClass: String.raw`article]{}\input{/etc/passwd}`,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a stale baseRevision as a typed conflict", () => {
    const patch = { ...normalPatch(), baseRevision: 99 };
    expect(() => applyDocumentPatch(SAMPLE_DOCUMENT_REVISION, patch)).toThrow(DocumentConflictError);
    try {
      applyDocumentPatch(SAMPLE_DOCUMENT_REVISION, patch);
    } catch (error) {
      expect(error).toMatchObject({
        code: "revision_conflict",
        expectedRevision: 99,
        actualRevision: 0,
      });
    }
  });

  it("does not mutate the current revision when a patch creates a cycle", () => {
    const current = structuredClone(SAMPLE_DOCUMENT_REVISION);
    const before = JSON.stringify(current);
    const section = current.document.nodes.find((node) => node.id === SAMPLE_DOCUMENT_IDS.nestedSection);
    if (section?.type !== "section") throw new Error("Nested section is missing");

    const patch: DocumentPatch = {
      id: "20000000-0000-4000-8000-000000000003",
      documentId: current.document.id,
      baseRevision: 0,
      createdAt: "2026-08-07T02:00:00.000Z",
      operations: [
        {
          op: "update",
          nodeId: section.id,
          node: { ...section, children: [SAMPLE_DOCUMENT_IDS.section] },
        },
      ],
    };

    expect(() => applyDocumentPatch(current, patch)).toThrow(DocumentValidationError);
    expect(JSON.stringify(current)).toBe(before);
  });

  it("detects duplicate IDs, broken references and cycles", () => {
    const duplicate = structuredClone(SAMPLE_DOCUMENT);
    duplicate.nodes.push(structuredClone(paragraph(duplicate)));
    const duplicateResult = safeValidateDocument(duplicate);
    expect(duplicateResult.success).toBe(false);
    if (!duplicateResult.success) {
      expect(duplicateResult.error.issues.some((issue) => issue.code === "duplicate_id")).toBe(true);
    }

    const brokenReference = structuredClone(SAMPLE_DOCUMENT);
    const cited = brokenReference.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.citedParagraph,
    );
    if (cited?.type !== "paragraph") throw new Error("Cited paragraph is missing");
    cited.content = [
      {
        type: "footnoteRef",
        footnoteId: "20000000-0000-4000-8000-000000000099",
      },
    ];
    const referenceResult = safeValidateDocument(brokenReference);
    expect(referenceResult.success).toBe(false);
    if (!referenceResult.success) {
      expect(
        referenceResult.error.issues.some((issue) => issue.code === "missing_reference"),
      ).toBe(true);
    }

    const cyclic = structuredClone(SAMPLE_DOCUMENT);
    const nestedSection = cyclic.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.nestedSection,
    );
    if (nestedSection?.type !== "section") throw new Error("Nested section is missing");
    nestedSection.children.push(SAMPLE_DOCUMENT_IDS.section);
    const cycleResult = safeValidateDocument(cyclic);
    expect(cycleResult.success).toBe(false);
    if (!cycleResult.success) {
      expect(cycleResult.error.issues.some((issue) => issue.code === "cycle")).toBe(true);
    }
  });

  it("rejects rawTeX or any other untyped body field", () => {
    const input = structuredClone(SAMPLE_DOCUMENT) as unknown as {
      nodes: Array<Record<string, unknown>>;
    };
    input.nodes[1] = { ...input.nodes[1], rawTeX: "\\input{/etc/passwd}" };
    expect(DocumentSchema.safeParse(input).success).toBe(false);
  });

  it("upgrades to schema v2 only when a patch adds extended semantic nodes", () => {
    const theoremId = "40000000-0000-4000-8000-000000000001";
    const statementId = "40000000-0000-4000-8000-000000000002";
    const proofId = "40000000-0000-4000-8000-000000000003";
    const proofParagraphId = "40000000-0000-4000-8000-000000000004";
    const patch: DocumentPatch = {
      id: "40000000-0000-4000-8000-000000000005",
      documentId: SAMPLE_DOCUMENT.id,
      baseRevision: 0,
      createdAt: "2026-08-07T04:00:00.000Z",
      operations: [
        {
          op: "insert",
          node: {
            id: theoremId,
            type: "theorem",
            theoremKind: "theorem",
            title: [{ type: "text", text: "基本定理", marks: [] }],
            children: [],
          },
          position: { kind: "root", index: SAMPLE_DOCUMENT.root.length },
        },
        {
          op: "insert",
          node: {
            id: statementId,
            type: "paragraph",
            content: [{ type: "text", text: "命題の主張です。", marks: [] }],
          },
          position: { kind: "container", parentId: theoremId, index: 0 },
        },
        {
          op: "insert",
          node: { id: proofId, type: "proof", children: [] },
          position: { kind: "container", parentId: theoremId, index: 1 },
        },
        {
          op: "insert",
          node: {
            id: proofParagraphId,
            type: "paragraph",
            content: [{ type: "text", text: "証明の本文です。", marks: [] }],
          },
          position: { kind: "container", parentId: proofId, index: 0 },
        },
      ],
    };

    const inserted = applyDocumentPatch(SAMPLE_DOCUMENT_REVISION, patch);
    expect(inserted.document.schemaVersion).toBe(2);
    expect(validateDocument(inserted.document)).toEqual(inserted.document);
    expect(
      DocumentSchema.safeParse({
        ...inserted.document,
        schemaVersion: 1,
      }).success,
    ).toBe(false);

    const deletePatch: DocumentPatch = {
      id: "40000000-0000-4000-8000-000000000006",
      documentId: SAMPLE_DOCUMENT.id,
      baseRevision: 1,
      createdAt: "2026-08-07T05:00:00.000Z",
      operations: [{ op: "delete", nodeId: theoremId }],
    };
    const deleted = applyDocumentPatch(inserted, deletePatch);
    expect(
      deleted.document.nodes.some((node) =>
        [theoremId, statementId, proofId, proofParagraphId].includes(node.id),
      ),
    ).toBe(false);
    expect(deleted.document.schemaVersion).toBe(2);
  });

  it("validates typed cross-references and rejects deleting a referenced target atomically", () => {
    const sectionId = "41000000-0000-4000-8000-000000000001";
    const paragraphId = "41000000-0000-4000-8000-000000000002";
    const equationId = "41000000-0000-4000-8000-000000000003";
    const document: DocumentModel = {
      ...structuredClone(SAMPLE_DOCUMENT),
      schemaVersion: 2,
      root: [sectionId, equationId],
      nodes: [
        {
          id: sectionId,
          type: "section",
          title: [{ type: "text", text: "参照", marks: [] }],
          children: [paragraphId],
        },
        {
          id: paragraphId,
          type: "paragraph",
          content: [
            { type: "text", text: "式", marks: [] },
            {
              type: "crossRef",
              targetType: "equation",
              targetId: equationId,
              format: "number",
            },
          ],
        },
        {
          id: equationId,
          type: "equation",
          expression: { kind: "symbol", name: "x" },
          numbered: true,
        },
      ],
    };
    expect(validateDocument(document)).toEqual(document);

    const wrongType = structuredClone(document);
    const paragraph = wrongType.nodes.find((node) => node.id === paragraphId);
    if (paragraph?.type !== "paragraph") throw new Error("Paragraph is missing");
    const crossRef = paragraph.content[1];
    if (crossRef?.type !== "crossRef") throw new Error("Cross-reference is missing");
    crossRef.targetType = "figure";
    const wrongTypeResult = safeValidateDocument(wrongType);
    expect(wrongTypeResult.success).toBe(false);
    if (!wrongTypeResult.success) {
      expect(wrongTypeResult.error.issues).toContainEqual(
        expect.objectContaining({ code: "invalid_reference" }),
      );
    }

    const unnumbered = structuredClone(document);
    const unnumberedEquation = unnumbered.nodes.find(
      (node) => node.id === equationId,
    );
    if (unnumberedEquation?.type !== "equation") {
      throw new Error("Equation is missing");
    }
    unnumberedEquation.numbered = false;
    const unnumberedResult = safeValidateDocument(unnumbered);
    expect(unnumberedResult.success).toBe(false);
    if (!unnumberedResult.success) {
      expect(unnumberedResult.error.issues).toContainEqual(
        expect.objectContaining({ code: "invalid_reference" }),
      );
    }

    const missing = structuredClone(document);
    const missingParagraph = missing.nodes.find((node) => node.id === paragraphId);
    if (missingParagraph?.type !== "paragraph") {
      throw new Error("Paragraph is missing");
    }
    const missingReference = missingParagraph.content[1];
    if (missingReference?.type !== "crossRef") {
      throw new Error("Cross-reference is missing");
    }
    missingReference.targetId = "41000000-0000-4000-8000-000000000099";
    const missingResult = safeValidateDocument(missing);
    expect(missingResult.success).toBe(false);
    if (!missingResult.success) {
      expect(missingResult.error.issues).toContainEqual(
        expect.objectContaining({ code: "missing_reference" }),
      );
    }

    const revision: DocumentRevision = {
      revisionId: "41000000-0000-4000-8000-000000000004",
      revision: 0,
      parentRevisionId: null,
      committedAt: "2026-08-07T00:00:00.000Z",
      document,
    };
    const before = JSON.stringify(revision);
    expect(() =>
      applyDocumentPatch(revision, {
        id: "41000000-0000-4000-8000-000000000005",
        documentId: document.id,
        baseRevision: 0,
        createdAt: "2026-08-07T01:00:00.000Z",
        operations: [{ op: "delete", nodeId: equationId }],
      }),
    ).toThrow(DocumentValidationError);
    expect(JSON.stringify(revision)).toBe(before);
  });

  it("rejects malformed advanced math and independent resource-budget overruns", () => {
    const equationId = "42000000-0000-4000-8000-000000000001";
    const ragged: DocumentModel = {
      ...structuredClone(SAMPLE_DOCUMENT),
      schemaVersion: 2,
      root: [equationId],
      nodes: [
        {
          id: equationId,
          type: "equation",
          expression: {
            kind: "matrix",
            delimiter: "parentheses",
            rows: [
              [
                { kind: "literal", value: "1" },
                { kind: "literal", value: "2" },
              ],
              [{ kind: "literal", value: "3" }],
            ],
          },
          numbered: true,
        },
      ],
    };
    const raggedResult = safeValidateDocument(ragged);
    expect(raggedResult.success).toBe(false);
    if (!raggedResult.success) {
      expect(raggedResult.error.issues).toContainEqual(
        expect.objectContaining({ code: "invalid_math" }),
      );
    }

    const incompleteIntegral = structuredClone(ragged);
    const integralEquation = incompleteIntegral.nodes[0];
    if (integralEquation?.type !== "equation") {
      throw new Error("Equation is missing");
    }
    integralEquation.expression = {
      kind: "integral",
      integrand: { kind: "symbol", name: "f" },
      variable: { kind: "symbol", name: "x" },
      lowerBound: { kind: "literal", value: "0" },
    };
    const integralResult = safeValidateDocument(incompleteIntegral);
    expect(integralResult.success).toBe(false);
    if (!integralResult.success) {
      expect(integralResult.error.issues).toContainEqual(
        expect.objectContaining({ code: "schema" }),
      );
    }

    const excessiveMatrix = structuredClone(ragged);
    const matrixEquation = excessiveMatrix.nodes[0];
    if (matrixEquation?.type !== "equation") throw new Error("Equation is missing");
    matrixEquation.expression = {
      kind: "matrix",
      delimiter: "brackets",
      rows: Array.from({ length: 101 }, () =>
        Array.from({ length: 100 }, () => ({
          kind: "literal" as const,
          value: "0",
        })),
      ),
    };
    expect(MAX_MATRIX_CELLS).toBeLessThan(101 * 100);
    const matrixBudgetResult = safeValidateDocument(excessiveMatrix);
    expect(matrixBudgetResult.success).toBe(false);
    if (!matrixBudgetResult.success) {
      expect(matrixBudgetResult.error.issues).toContainEqual(
        expect.objectContaining({ code: "resource_limit" }),
      );
    }

    const codeId = "42000000-0000-4000-8000-000000000002";
    const excessiveCode: DocumentModel = {
      ...structuredClone(SAMPLE_DOCUMENT),
      schemaVersion: 2,
      root: [codeId],
      nodes: [
        {
          id: codeId,
          type: "codeBlock",
          language: "text",
          code: "x".repeat(MAX_CODE_BYTES + 1),
          showLineNumbers: false,
        },
      ],
    };
    const codeBudgetResult = safeValidateDocument(excessiveCode);
    expect(codeBudgetResult.success).toBe(false);
    if (!codeBudgetResult.success) {
      expect(codeBudgetResult.error.issues).toContainEqual(
        expect.objectContaining({ code: "resource_limit" }),
      );
    }
  });

  it("rejects deeply nested and cyclic raw inputs without leaking a RangeError", () => {
    const deep = structuredClone(SAMPLE_DOCUMENT) as unknown as Record<string, unknown>;
    let cursor: Record<string, unknown> = deep;
    for (let index = 0; index < 140; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.extra = next;
      cursor = next;
    }
    const deepResult = safeValidateDocument(deep);
    expect(deepResult.success).toBe(false);
    if (!deepResult.success) {
      expect(deepResult.error).toBeInstanceOf(DocumentValidationError);
      expect(deepResult.error.issues).toContainEqual(
        expect.objectContaining({ code: "depth_limit" }),
      );
    }

    const cyclic = structuredClone(SAMPLE_DOCUMENT) as unknown as Record<string, unknown>;
    cyclic.cycle = cyclic;
    const cyclicResult = safeValidateDocument(cyclic);
    expect(cyclicResult.success).toBe(false);
    if (!cyclicResult.success) {
      expect(cyclicResult.error).toBeInstanceOf(DocumentValidationError);
      expect(cyclicResult.error.issues).toContainEqual(
        expect.objectContaining({ code: "resource_limit" }),
      );
    }
  });
});
