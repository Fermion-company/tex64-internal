import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  userId: "40000000-0000-4000-8000-000000000001",
  readPdf: vi.fn(),
}));

vi.mock("@/server/auth", () => ({
  requireSession: async () => ({ userId: doubles.userId, isNew: false }),
}));

vi.mock("@/server/artifacts", async () => {
  const actual = await vi.importActual<typeof import("@/server/artifacts")>(
    "@/server/artifacts",
  );
  return {
    ...actual,
    getArtifactStore: () => ({
      readPdf: doubles.readPdf,
      savePdf: vi.fn(),
    }),
  };
});

import { GET as listDocuments } from "@/app/api/documents/route";
import { GET as getLegacyArtifact } from "@/app/api/documents/[documentId]/artifacts/[revision]/route";
import { GET as getArtifact } from "@/app/api/documents/[documentId]/artifacts/[revision]/[sha256]/route";
import { SAMPLE_DOCUMENT } from "@/domain/document";
import {
  CURRENT_ARTIFACT_QUALITY_VERSION,
  artifactReleaseBinding,
  runReleasesArtifact,
} from "@/server/artifacts";
import {
  ArtifactConflictError,
  type DocumentRepository,
  type StoredArtifact,
} from "@/server/persistence";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import { loadDocumentDetail } from "@/server/presentation/load-document";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "40000000-0000-4000-8000-000000000002";
const RUN_ID = "50000000-0000-4000-8000-000000000001";
const PDF_A = new TextEncoder().encode("%PDF-1.7\nA\n%%EOF\n");
const PDF_B = new TextEncoder().encode("%PDF-1.7\nB\n%%EOF\n");

type RepositoryGlobal = typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
};

let temporaryDirectory: string;
let storePath: string;
let repository: LocalDocumentRepository;
let staged: StoredArtifact;

beforeEach(async () => {
  doubles.userId = USER_ID;
  doubles.readPdf.mockReset();
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-release-"));
  storePath = path.join(temporaryDirectory, "store.json");
  repository = new LocalDocumentRepository(storePath);
  (globalThis as RepositoryGlobal).__tex64DocumentRepository = repository;
  await repository.createDocument(USER_ID, structuredClone(SAMPLE_DOCUMENT));
  await repository.createRun({
    id: RUN_ID,
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    prompt: "文書を完成させて",
    idempotencyKey: "release-boundary",
    baseRevision: 1,
  });
  await repository.activateRunForWorkflow(USER_ID, RUN_ID, "release-workflow");
  staged = artifactFor(PDF_A, 1);
  await repository.saveArtifact(staged);
});

afterEach(async () => {
  delete (globalThis as RepositoryGlobal).__tex64DocumentRepository;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe.sequential("artifact publication boundary", () => {
  it("keeps staged metadata hidden from detail, list, old URL, and direct GET", async () => {
    await expect(loadDocumentDetail(USER_ID, SAMPLE_DOCUMENT.id)).resolves.not.toHaveProperty(
      "artifactUrl",
    );
    const list = await listDocuments(
      new Request("http://localhost/api/documents"),
    );
    await expect(list.json()).resolves.toMatchObject({
      documents: [{ id: SAMPLE_DOCUMENT.id, status: "working" }],
    });

    const legacy = await legacyArtifactResponse();
    const direct = await artifactResponse(1, staged.sha256);
    expect(legacy.status).toBe(404);
    expect(direct.status).toBe(404);
    expect(doubles.readPdf).not.toHaveBeenCalled();
  });

  it("publishes only the exact digest-bound accepted bytes", async () => {
    const completion = await complete(staged);
    expect(completion.run.artifactRelease).toEqual(
      artifactReleaseBinding(completion.artifact),
    );
    doubles.readPdf.mockResolvedValue({
      body: PDF_A,
      byteSize: PDF_A.byteLength,
      etag: "provider-etag",
    });

    const detail = await loadDocumentDetail(USER_ID, SAMPLE_DOCUMENT.id);
    expect(detail).toMatchObject({
      status: "ready",
      artifactUrl: `/api/documents/${SAMPLE_DOCUMENT.id}/artifacts/1/${staged.sha256}`,
    });
    const list = await listDocuments(
      new Request("http://localhost/api/documents"),
    );
    await expect(list.json()).resolves.toMatchObject({
      documents: [{ id: SAMPLE_DOCUMENT.id, status: "ready" }],
    });

    const response = await artifactResponse(1, staged.sha256);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(`"${staged.sha256}"`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF_A);
  });

  it.each([
    ["digest", { sha256: "f".repeat(64) }],
    ["storage key", { storageKey: "documents/wrong.pdf" }],
    ["byte size", { byteSize: PDF_A.byteLength + 1 }],
    ["page count", { pageCount: 2 }],
    ["quality version", { qualityVersion: CURRENT_ARTIFACT_QUALITY_VERSION + 1 }],
  ])("does not complete when the %s differs from the compiled artifact", async (_field, change) => {
    await expect(
      repository.completeRunForCurrentRevision({
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        runId: RUN_ID,
        revision: 1,
        artifact: { ...artifactReleaseBinding(staged), ...change },
        eventKey: `${RUN_ID}:ready`,
        eventMessage: "文書が完成しました",
      }),
    ).rejects.toBeInstanceOf(ArtifactConflictError);
    await expect(repository.getRun(USER_ID, RUN_ID)).resolves.toMatchObject({
      status: "running",
      artifactRelease: null,
    });
    await expect(repository.listRunEvents(USER_ID, RUN_ID)).resolves.toEqual([]);
  });

  it("rejects a replacement that lands between compilation and completion", async () => {
    const compiledIdentity = artifactReleaseBinding(staged);
    const racedReplacement = artifactFor(PDF_B, 1);
    await repository.replaceArtifact(staged, racedReplacement);

    await expect(
      repository.completeRunForCurrentRevision({
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        runId: RUN_ID,
        revision: 1,
        artifact: compiledIdentity,
        eventKey: `${RUN_ID}:ready`,
        eventMessage: "文書が完成しました",
      }),
    ).rejects.toBeInstanceOf(ArtifactConflictError);
    await expect(repository.getRun(USER_ID, RUN_ID)).resolves.toMatchObject({
      status: "running",
      artifactRelease: null,
    });
    await expect(repository.listRunEvents(USER_ID, RUN_ID)).resolves.toEqual([]);
  });

  it("treats a legacy completed run without an exact release binding as unpublished", async () => {
    await complete(staged);
    const data = JSON.parse(await readFile(storePath, "utf8")) as {
      runs: Record<string, { artifactRelease?: unknown }>;
    };
    const run = Object.values(data.runs)[0];
    if (!run) throw new Error("Stored run is missing");
    delete run.artifactRelease;
    await writeFile(storePath, JSON.stringify(data), "utf8");
    repository = new LocalDocumentRepository(storePath);
    (globalThis as RepositoryGlobal).__tex64DocumentRepository = repository;

    await expect(
      repository.getCompletedRunForRevision(USER_ID, SAMPLE_DOCUMENT.id, 1),
    ).resolves.toBeNull();
    await expect(loadDocumentDetail(USER_ID, SAMPLE_DOCUMENT.id)).resolves.not.toHaveProperty(
      "artifactUrl",
    );
    const list = await listDocuments(
      new Request("http://localhost/api/documents"),
    );
    await expect(list.json()).resolves.toMatchObject({
      documents: [{ id: SAMPLE_DOCUMENT.id, status: "working" }],
    });
    expect((await artifactResponse(1, staged.sha256)).status).toBe(404);
  });

  it("revokes both the old alias and a replacement candidate until a new acceptance", async () => {
    await complete(staged);
    const replacement = artifactFor(PDF_B, 1);
    await repository.replaceArtifact(staged, replacement);

    const completedRun = await repository.getRun(USER_ID, RUN_ID);
    expect(runReleasesArtifact(completedRun, replacement)).toBe(false);
    await expect(loadDocumentDetail(USER_ID, SAMPLE_DOCUMENT.id)).resolves.not.toHaveProperty(
      "artifactUrl",
    );
    const list = await listDocuments(
      new Request("http://localhost/api/documents"),
    );
    await expect(list.json()).resolves.toMatchObject({
      documents: [{ id: SAMPLE_DOCUMENT.id, status: "working" }],
    });
    expect((await artifactResponse(1, staged.sha256)).status).toBe(404);
    expect((await artifactResponse(1, replacement.sha256)).status).toBe(404);
    expect((await legacyArtifactResponse()).status).toBe(404);
    expect(doubles.readPdf).not.toHaveBeenCalled();

    await expect(
      repository.completeRunForCurrentRevision({
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        runId: RUN_ID,
        revision: 1,
        artifact: artifactReleaseBinding(replacement),
        eventKey: `${RUN_ID}:ready`,
        eventMessage: "文書が完成しました",
      }),
    ).rejects.toBeInstanceOf(ArtifactConflictError);
  });

  it("does not authorize a candidate on another revision or tenant", async () => {
    await complete(staged);
    const current = await repository.getDocument(USER_ID, SAMPLE_DOCUMENT.id);
    if (!current) throw new Error("Document is missing");
    const updated = structuredClone(current.document);
    updated.metadata.title = "未承認の次版";
    await repository.commitDocument({
      commitId: "70000000-0000-4000-8000-000000000010",
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      expectedRevision: 1,
      document: updated,
      actor: "user",
      summary: "次版",
      operations: [{ op: "setMetadata", metadata: updated.metadata }],
    });
    const nextRevisionCandidate = artifactFor(PDF_B, 2);
    await repository.saveArtifact(nextRevisionCandidate);

    await expect(loadDocumentDetail(USER_ID, SAMPLE_DOCUMENT.id)).resolves.not.toHaveProperty(
      "artifactUrl",
    );
    expect(
      (await artifactResponse(2, nextRevisionCandidate.sha256)).status,
    ).toBe(404);

    doubles.userId = OTHER_USER_ID;
    expect((await artifactResponse(1, staged.sha256)).status).toBe(404);
    expect(doubles.readPdf).not.toHaveBeenCalled();
  });

  it("refuses tampered backing bytes even for an exact release record", async () => {
    await complete(staged);
    doubles.readPdf.mockResolvedValue({
      body: PDF_B,
      byteSize: PDF_B.byteLength,
    });

    expect((await artifactResponse(1, staged.sha256)).status).toBe(404);
    expect(doubles.readPdf).toHaveBeenCalledOnce();
  });
});

function artifactFor(pdf: Uint8Array, revision: number): StoredArtifact {
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  return {
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    revision,
    storageKey: `documents/${USER_ID}/${SAMPLE_DOCUMENT.id}/${revision}-${sha256}.pdf`,
    sha256,
    byteSize: pdf.byteLength,
    compileDurationMs: 10,
    pageCount: 1,
    qualityVersion: CURRENT_ARTIFACT_QUALITY_VERSION,
    createdAt: "2026-08-08T00:00:00.000Z",
  };
}

async function complete(artifact: StoredArtifact) {
  return repository.completeRunForCurrentRevision({
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    runId: RUN_ID,
    revision: artifact.revision,
    artifact: artifactReleaseBinding(artifact),
    eventKey: `${RUN_ID}:ready`,
    eventMessage: "文書が完成しました",
  });
}

async function artifactResponse(revision: number, sha256: string) {
  return getArtifact(new Request("http://localhost"), {
    params: Promise.resolve({
      documentId: SAMPLE_DOCUMENT.id,
      revision: String(revision),
      sha256,
    }),
  });
}

async function legacyArtifactResponse() {
  return getLegacyArtifact();
}
