import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  readPdf: vi.fn(),
  savePdf: vi.fn(),
  compile: vi.fn(),
  visualReview: vi.fn(),
}));

vi.mock("@/server/artifacts", async () => {
  const actual = await vi.importActual<typeof import("@/server/artifacts")>(
    "@/server/artifacts",
  );
  return {
    ...actual,
    getArtifactStore: () => ({
      readPdf: doubles.readPdf,
      savePdf: doubles.savePdf,
    }),
  };
});

vi.mock("@/server/compiler", async () => {
  const actual = await vi.importActual<typeof import("@/server/compiler")>(
    "@/server/compiler",
  );
  return {
    ...actual,
    getDocumentCompiler: () => ({ compile: doubles.compile }),
    reviewPdfVisualQuality: doubles.visualReview,
  };
});

import { SAMPLE_DOCUMENT, SAMPLE_DOCUMENT_IDS } from "@/domain/document";
import { CURRENT_ARTIFACT_QUALITY_VERSION } from "@/server/artifacts";
import type { DocumentRepository, StoredArtifact } from "@/server/persistence";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import { validateRenderCompileAndStoreStep } from "@/workflows/document-agent/steps";
import type { DocumentAgentWorkflowInput } from "@/workflows/document-agent/types";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const RUN_ID = "50000000-0000-4000-8000-000000000001";
const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const PDF_SHA256 = createHash("sha256").update(PDF).digest("hex");

type RepositoryGlobal = typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
};

let temporaryDirectory: string;
let repository: LocalDocumentRepository;
let workflow: DocumentAgentWorkflowInput;

function completionReadyDocument() {
  const document = structuredClone(SAMPLE_DOCUMENT);
  document.schemaVersion = 2;
  const figure = document.nodes.find(
    (node) => node.id === SAMPLE_DOCUMENT_IDS.figure,
  );
  if (figure?.type !== "figure") throw new Error("Sample figure is missing");
  figure.content = {
    kind: "flowDiagram",
    direction: "left-to-right",
    nodes: [
      {
        id: "40000000-0000-4000-8000-000000000101",
        label: "開始",
        shape: "terminator",
      },
      {
        id: "40000000-0000-4000-8000-000000000102",
        label: "完了",
        shape: "process",
      },
    ],
    edges: [
      {
        from: "40000000-0000-4000-8000-000000000101",
        to: "40000000-0000-4000-8000-000000000102",
      },
    ],
  };
  return document;
}

beforeEach(async () => {
  doubles.readPdf.mockReset();
  doubles.savePdf.mockReset();
  doubles.compile.mockReset();
  doubles.visualReview.mockReset();
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-artifact-reuse-"));
  repository = new LocalDocumentRepository(
    path.join(temporaryDirectory, "store.json"),
  );
  (globalThis as RepositoryGlobal).__tex64DocumentRepository = repository;
  await repository.createDocument(USER_ID, completionReadyDocument());
  const run = await repository.createRun({
    id: RUN_ID,
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    prompt: "文書を完成",
    idempotencyKey: "artifact-reuse-workflow",
    baseRevision: 1,
  });
  await repository.activateRunForWorkflow(USER_ID, RUN_ID, "artifact-reuse-test");
  workflow = {
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    runId: RUN_ID,
    prompt: run.prompt,
    baseRevision: 1,
    replyToRunId: null,
    decision: null,
  };
});

afterEach(async () => {
  delete (globalThis as RepositoryGlobal).__tex64DocumentRepository;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function artifact(overrides: Partial<StoredArtifact> = {}): StoredArtifact {
  return {
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    revision: 1,
    storageKey: "missing-object.pdf",
    sha256: "1".repeat(64),
    byteSize: 999,
    compileDurationMs: 10,
    pageCount: 1,
    qualityVersion: CURRENT_ARTIFACT_QUALITY_VERSION,
    createdAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

describe.sequential("workflow artifact verification", () => {
  it("rejects a placeholder figure before reusing or compiling an artifact", async () => {
    const current = await repository.getDocument(USER_ID, SAMPLE_DOCUMENT.id);
    if (!current) throw new Error("Document is missing");
    const placeholder = structuredClone(current.document);
    const figure = placeholder.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.figure,
    );
    if (figure?.type !== "figure") throw new Error("Sample figure is missing");
    delete figure.content;
    placeholder.schemaVersion = 1;
    await repository.commitDocument({
      commitId: "40000000-0000-4000-8000-000000000201",
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      expectedRevision: 1,
      document: placeholder,
      actor: "user",
      summary: "legacy placeholder fixture",
      operations: [{ op: "update", nodeId: figure.id, node: figure }],
    });
    await repository.saveArtifact(
      artifact({
        revision: 2,
        storageKey: "placeholder-object.pdf",
        sha256: PDF_SHA256,
        byteSize: PDF.byteLength,
      }),
    );
    doubles.readPdf.mockResolvedValue({ body: PDF, byteSize: PDF.byteLength });

    await expect(
      validateRenderCompileAndStoreStep({ workflow, revision: 2 }),
    ).resolves.toMatchObject({
      ok: false,
      code: "document_validation_failed",
      issueCount: 1,
    });
    expect(doubles.readPdf).not.toHaveBeenCalled();
    expect(doubles.compile).not.toHaveBeenCalled();
  });

  it("recompiles and repairs metadata when the recorded object is missing", async () => {
    await repository.saveArtifact(artifact());
    doubles.readPdf.mockResolvedValue(null);
    doubles.compile.mockResolvedValue({
      pdf: PDF,
      engine: "test",
      durationMs: 25,
      pageCount: 1,
      diagnostics: [],
    });
    doubles.savePdf.mockResolvedValue({
      storageKey: "repaired-object.pdf",
      sha256: PDF_SHA256,
      byteSize: PDF.byteLength,
    });

    await expect(
      validateRenderCompileAndStoreStep({ workflow, revision: 1 }),
    ).resolves.toMatchObject({
      ok: true,
      reused: false,
      artifact: { sha256: PDF_SHA256, byteSize: PDF.byteLength },
    });
    expect(doubles.compile).toHaveBeenCalledOnce();
    await expect(
      repository.getArtifact(USER_ID, SAMPLE_DOCUMENT.id, 1),
    ).resolves.toMatchObject({
      storageKey: "repaired-object.pdf",
      sha256: PDF_SHA256,
      byteSize: PDF.byteLength,
    });
  });

  it("skips compilation only after reading matching backing bytes", async () => {
    await repository.saveArtifact(
      artifact({
        storageKey: "verified-object.pdf",
        sha256: PDF_SHA256,
        byteSize: PDF.byteLength,
      }),
    );
    doubles.readPdf.mockResolvedValue({ body: PDF, byteSize: PDF.byteLength });

    await expect(
      validateRenderCompileAndStoreStep({ workflow, revision: 1 }),
    ).resolves.toMatchObject({ ok: true, reused: true });
    expect(doubles.compile).not.toHaveBeenCalled();
    expect(doubles.savePdf).not.toHaveBeenCalled();
  });

  it("recompiles an artifact created before the current PDF quality gate", async () => {
    await repository.saveArtifact(
      artifact({
        storageKey: "legacy-object.pdf",
        sha256: PDF_SHA256,
        byteSize: PDF.byteLength,
        pageCount: null,
        qualityVersion: 0,
      }),
    );
    doubles.readPdf.mockResolvedValue({ body: PDF, byteSize: PDF.byteLength });
    doubles.compile.mockResolvedValue({
      pdf: PDF,
      engine: "test",
      durationMs: 25,
      pageCount: 1,
      diagnostics: [],
    });
    doubles.savePdf.mockResolvedValue({
      storageKey: "quality-checked-object.pdf",
      sha256: PDF_SHA256,
      byteSize: PDF.byteLength,
    });

    await expect(
      validateRenderCompileAndStoreStep({ workflow, revision: 1 }),
    ).resolves.toMatchObject({ ok: true, reused: false });
    expect(doubles.compile).toHaveBeenCalledOnce();
    await expect(
      repository.getArtifact(USER_ID, SAMPLE_DOCUMENT.id, 1),
    ).resolves.toMatchObject({
      storageKey: "quality-checked-object.pdf",
      pageCount: 1,
      qualityVersion: CURRENT_ARTIFACT_QUALITY_VERSION,
    });
  });

  it("blocks persistence when the independent PDF review finds broken paper layout", async () => {
    const previousModel = process.env.TEX64_AI_MODEL;
    const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
    process.env.TEX64_AI_MODEL = "openai/gpt-5.6-sol";
    process.env.AI_GATEWAY_API_KEY = "test-only";
    doubles.compile.mockResolvedValue({
      pdf: PDF,
      engine: "test",
      durationMs: 25,
      pageCount: 1,
      diagnostics: [],
    });
    doubles.visualReview.mockResolvedValue({
      verdict: "repair_required",
      reviewedPages: [1],
      dimensions: [],
      findings: [
        {
          severity: "major",
          category: "clipping",
          page: 1,
          detail: "The final column is cut off at the right edge.",
        },
      ],
    });

    try {
      await expect(
        validateRenderCompileAndStoreStep({ workflow, revision: 1 }),
      ).resolves.toMatchObject({
        ok: false,
        code: "visual_quality_failed",
        issueCount: 1,
        visualFindings: [
          expect.objectContaining({ category: "clipping", page: 1 }),
        ],
      });
      expect(doubles.savePdf).not.toHaveBeenCalled();
    } finally {
      if (previousModel === undefined) delete process.env.TEX64_AI_MODEL;
      else process.env.TEX64_AI_MODEL = previousModel;
      if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
    }
  });
});
