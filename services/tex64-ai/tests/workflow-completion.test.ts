import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SAMPLE_DOCUMENT } from "@/domain/document";
import {
  CURRENT_ARTIFACT_QUALITY_VERSION,
  artifactReleaseBinding,
} from "@/server/artifacts";
import {
  RevisionConflictError,
  type DocumentRepository,
  type ArtifactReleaseBinding,
  type StoredArtifact,
} from "@/server/persistence";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import { loadDocumentDetail } from "@/server/presentation/load-document";
import { completeDocumentRunStep } from "@/workflows/document-agent/steps";
import type { DocumentAgentWorkflowInput } from "@/workflows/document-agent/types";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const RUN_ID = "50000000-0000-4000-8000-000000000001";

type RepositoryGlobal = typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
};

let temporaryDirectory: string;
let repository: LocalDocumentRepository;
let workflow: DocumentAgentWorkflowInput;
let artifactRelease: ArtifactReleaseBinding;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-completion-"));
  repository = new LocalDocumentRepository(
    path.join(temporaryDirectory, "store.json"),
  );
  (globalThis as RepositoryGlobal).__tex64DocumentRepository = repository;
  await repository.createDocument(USER_ID, structuredClone(SAMPLE_DOCUMENT));
  const run = await repository.createRun({
    id: RUN_ID,
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    prompt: "論文を完成させて",
    idempotencyKey: "workflow-completion-1",
    baseRevision: 1,
  });
  await repository.activateRunForWorkflow(USER_ID, RUN_ID, "workflow-completion-test");
  workflow = {
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    runId: RUN_ID,
    prompt: run.prompt,
    baseRevision: run.baseRevision,
    replyToRunId: null,
  };
  const artifact: StoredArtifact = {
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    revision: 1,
    storageKey: `documents/${USER_ID}/${SAMPLE_DOCUMENT.id}/1.pdf`,
    sha256: "a".repeat(64),
    byteSize: 1024,
    compileDurationMs: 120,
    pageCount: 1,
    qualityVersion: CURRENT_ARTIFACT_QUALITY_VERSION,
    createdAt: "2026-08-07T00:00:00.000Z",
  };
  await repository.saveArtifact(artifact);
  artifactRelease = artifactReleaseBinding(artifact);
});

afterEach(async () => {
  delete (globalThis as RepositoryGlobal).__tex64DocumentRepository;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe.sequential("workflow completion boundary", () => {
  it("keeps a staged PDF hidden until its exact revision is completed", async () => {
    await expect(loadDocumentDetail(USER_ID, SAMPLE_DOCUMENT.id)).resolves.not.toHaveProperty(
      "artifactUrl",
    );
    await expect(
      repository.getCompletedRunForRevision(USER_ID, SAMPLE_DOCUMENT.id, 1),
    ).resolves.toBeNull();

    await completeDocumentRunStep({
      workflow,
      revision: 1,
      artifact: artifactRelease,
      eventKey: `${RUN_ID}:ready:visibility`,
    });

    await expect(loadDocumentDetail(USER_ID, SAMPLE_DOCUMENT.id)).resolves.toMatchObject({
      status: "ready",
      artifactUrl: `/api/documents/${SAMPLE_DOCUMENT.id}/artifacts/1/${"a".repeat(64)}`,
    });
    await expect(
      repository.getCompletedRunForRevision(USER_ID, SAMPLE_DOCUMENT.id, 1),
    ).resolves.toMatchObject({ status: "completed", resultRevision: 1 });
  });

  it("does not publish a stale compiled revision as the current result", async () => {
    const current = await repository.getDocument(USER_ID, SAMPLE_DOCUMENT.id);
    if (!current) throw new Error("expected document");
    const updated = structuredClone(current.document);
    updated.metadata.title = "組版中に更新された文書";
    await repository.commitDocument({
      commitId: "70000000-0000-4000-8000-000000000001",
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      expectedRevision: 1,
      document: updated,
      actor: "user",
      summary: "組版中の更新",
      operations: [{ op: "setMetadata", metadata: updated.metadata }],
    });

    await expect(
      completeDocumentRunStep({
        workflow,
        revision: 1,
        artifact: artifactRelease,
        eventKey: `${RUN_ID}:ready:primary`,
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError);

    await expect(repository.getRun(USER_ID, RUN_ID)).resolves.toMatchObject({
      status: "running",
      resultRevision: null,
    });
    expect(
      (await repository.listRunEvents(USER_ID, RUN_ID)).some(
        (event) => event.stage === "ready",
      ),
    ).toBe(false);
  });

  it("replays the completed step without duplicating its ready event", async () => {
    const input = {
      workflow,
      revision: 1,
      artifact: artifactRelease,
      eventKey: `${RUN_ID}:ready:primary`,
    };

    const first = await completeDocumentRunStep(input);
    const replay = await completeDocumentRunStep(input);

    expect(replay).toEqual(first);
    await expect(repository.listRunEvents(USER_ID, RUN_ID)).resolves.toHaveLength(1);
    await expect(repository.getRun(USER_ID, RUN_ID)).resolves.toMatchObject({
      status: "completed",
      stage: "ready",
      resultRevision: 1,
    });
  });
});
