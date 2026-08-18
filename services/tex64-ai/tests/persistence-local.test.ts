import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SAMPLE_DOCUMENT, type DocumentModel } from "@/domain/document";
import {
  CURRENT_ARTIFACT_QUALITY_VERSION,
  artifactReleaseBinding,
} from "@/server/artifacts";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import {
  AgentRunConflictError,
  ArtifactConflictError,
  DocumentNotFoundError,
  IdempotencyConflictError,
  InvalidAgentRunTransitionError,
  RevisionConflictError,
  ResourceLimitExceededError,
  type CreateRunInput,
  type CommitDocumentInput,
  type StoredArtifact,
  type StoredDocument,
} from "@/server/persistence";
import {
  MAX_DOCUMENTS_PER_USER,
  MAX_REVISIONS_PER_DOCUMENT,
} from "@/server/persistence/limits";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "40000000-0000-4000-8000-000000000002";
const RUN_ID = "50000000-0000-4000-8000-000000000001";
const RETRY_RUN_ID = "50000000-0000-4000-8000-000000000002";

let temporaryDirectory: string;
let repository: LocalDocumentRepository;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-persistence-"));
  repository = new LocalDocumentRepository(path.join(temporaryDirectory, "store.json"));
  await repository.createDocument(USER_ID, structuredClone(SAMPLE_DOCUMENT));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function runInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    id: RUN_ID,
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    prompt: "章立てを整えてください。",
    idempotencyKey: "run-request-1",
    baseRevision: 1,
    ...overrides,
  };
}

function artifact(overrides: Partial<StoredArtifact> = {}): StoredArtifact {
  return {
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
    ...overrides,
  };
}

function documentCommitInput(): CommitDocumentInput {
  const document = structuredClone(SAMPLE_DOCUMENT);
  document.metadata.title = "再送を検証する文書";
  return {
    commitId: "70000000-0000-4000-8000-000000000099",
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    expectedRevision: 1,
    document,
    actor: "user",
    summary: "タイトルを更新",
    operations: [{ op: "setMetadata", metadata: document.metadata }],
  };
}

describe("LocalDocumentRepository retry invariants", () => {
  it("returns bounded metadata projections for document and revision indexes", async () => {
    const documents = await repository.listDocuments(USER_ID, {
      limit: 1,
      offset: 0,
    });
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      id: SAMPLE_DOCUMENT.id,
      userId: USER_ID,
      currentRevision: 1,
      documentType: SAMPLE_DOCUMENT.metadata.documentType,
      hasContent: true,
    });
    expect(documents[0]).not.toHaveProperty("document");

    const revisions = await repository.listRevisions(
      USER_ID,
      SAMPLE_DOCUMENT.id,
      { limit: 1, offset: 0 },
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      revision: 1,
      summary: "文書を作成",
    });
    expect(revisions[0]).not.toHaveProperty("document");
    expect(revisions[0]).not.toHaveProperty("operations");

    await expect(
      repository.listDocuments(USER_ID, { limit: 101 }),
    ).rejects.toThrow("Pagination request is outside the supported range");
    await expect(
      repository.listRevisions(USER_ID, SAMPLE_DOCUMENT.id, { offset: 10_001 }),
    ).rejects.toThrow("Pagination request is outside the supported range");
  });

  it("paginates recent runs deterministically and bounds event reads", async () => {
    const ids = [
      "50000000-0000-4000-8000-000000000011",
      "50000000-0000-4000-8000-000000000012",
      "50000000-0000-4000-8000-000000000013",
    ];
    for (const [index, id] of ids.entries()) {
      await repository.createRun(
        runInput({
          id,
          idempotencyKey: `page-run-${index}`,
          prompt: `依頼 ${index}`,
        }),
      );
      await repository.appendRunEvent({
        userId: USER_ID,
        runId: id,
        stage: "writing",
        message: `計画 ${index}`,
        detail: { eventKey: `${id}:planning` },
      });
    }

    const firstPage = await repository.listRuns(USER_ID, SAMPLE_DOCUMENT.id, {
      limit: 2,
      offset: 0,
    });
    const secondPage = await repository.listRuns(USER_ID, SAMPLE_DOCUMENT.id, {
      limit: 2,
      offset: 2,
    });
    expect(firstPage).toHaveLength(2);
    expect(secondPage).toHaveLength(1);
    expect(new Set([...firstPage, ...secondPage].map((run) => run.id))).toEqual(
      new Set(ids),
    );
    await expect(
      repository.listRunEvents(USER_ID, ids[0]!, 0, 1),
    ).resolves.toHaveLength(1);
    await expect(
      repository.listRunEvents(USER_ID, ids[0]!, 0, 501),
    ).rejects.toThrow("Event page size is outside the supported range");
  });

  it("enforces per-workspace document and per-document revision budgets", async () => {
    const store = JSON.parse(
      await readFile(repository.filePath, "utf8"),
    ) as { documents: Record<string, StoredDocument> };
    const template = Object.values(store.documents)[0];
    if (!template) throw new Error("expected stored document");
    for (let index = 1; index < MAX_DOCUMENTS_PER_USER; index += 1) {
      const id = `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      store.documents[`${USER_ID}:${id}`] = {
        ...structuredClone(template),
        id,
        document: { ...structuredClone(template.document), id },
      };
    }
    await writeFile(repository.filePath, JSON.stringify(store));

    const extra = structuredClone(SAMPLE_DOCUMENT);
    extra.id = "30000000-0000-4000-8000-999999999999";
    await expect(repository.createDocument(USER_ID, extra)).rejects.toBeInstanceOf(
      ResourceLimitExceededError,
    );

    const refreshed = JSON.parse(
      await readFile(repository.filePath, "utf8"),
    ) as { documents: Record<string, StoredDocument> };
    refreshed.documents[`${USER_ID}:${SAMPLE_DOCUMENT.id}`]!.currentRevision =
      MAX_REVISIONS_PER_DOCUMENT;
    await writeFile(repository.filePath, JSON.stringify(refreshed));
    const updated = structuredClone(SAMPLE_DOCUMENT);
    updated.metadata.title = "上限後の更新";
    await expect(
      repository.commitDocument({
        commitId: "70000000-0000-4000-8000-999999999999",
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        expectedRevision: MAX_REVISIONS_PER_DOCUMENT,
        document: updated,
        actor: "user",
        summary: "上限後の更新",
        operations: [{ op: "setMetadata", metadata: updated.metadata }],
      }),
    ).rejects.toMatchObject({ resource: "revisions" });
  });

  it("accepts only an exact document commit replay", async () => {
    const original = documentCommitInput();
    await repository.commitDocument(original);
    await expect(repository.commitDocument(structuredClone(original))).resolves.toMatchObject({
      currentRevision: 2,
    });

    const differentDocument = structuredClone(original);
    differentDocument.document.metadata.title = "異なる内容";
    const differentActor = { ...structuredClone(original), actor: "agent" as const };
    const differentSummary = { ...structuredClone(original), summary: "異なる要約" };
    const differentOperations = { ...structuredClone(original), operations: [] };
    const differentBase = { ...structuredClone(original), expectedRevision: 2 };

    for (const replay of [
      differentDocument,
      differentActor,
      differentSummary,
      differentOperations,
      differentBase,
    ]) {
      await expect(repository.commitDocument(replay)).rejects.toMatchObject({
        name: "IdempotencyConflictError",
        resource: "document_commit",
        idempotencyKey: original.commitId,
      });
    }
  });

  it("repairs artifact metadata only with a matching compare-and-swap value", async () => {
    const damaged = artifact({
      storageKey: `documents/${USER_ID}/${SAMPLE_DOCUMENT.id}/1-damaged.pdf`,
      sha256: "1".repeat(64),
      byteSize: 11,
    });
    const repaired = artifact({
      storageKey: `documents/${USER_ID}/${SAMPLE_DOCUMENT.id}/1-repaired.pdf`,
      sha256: "2".repeat(64),
      byteSize: 22,
    });
    await repository.saveArtifact(damaged);
    await expect(repository.replaceArtifact(damaged, repaired)).resolves.toEqual(
      repaired,
    );
    await expect(
      repository.replaceArtifact(damaged, artifact({ sha256: "3".repeat(64) })),
    ).rejects.toBeInstanceOf(ArtifactConflictError);
    await expect(
      repository.getArtifact(USER_ID, SAMPLE_DOCUMENT.id, 1),
    ).resolves.toEqual(repaired);
  });

  it("loads legacy artifact rows as explicitly unreleasable metadata", async () => {
    await repository.saveArtifact(artifact());
    const stored = JSON.parse(await readFile(repository.filePath, "utf8")) as {
      artifacts: Record<
        string,
        Partial<StoredArtifact> & Pick<StoredArtifact, "sha256">
      >;
    };
    const legacyArtifact = Object.values(stored.artifacts)[0];
    if (!legacyArtifact) throw new Error("Stored artifact is missing");
    delete legacyArtifact.pageCount;
    delete legacyArtifact.qualityVersion;
    await writeFile(repository.filePath, JSON.stringify(stored), "utf8");

    const reloaded = new LocalDocumentRepository(repository.filePath);
    const normalized = await reloaded.getArtifact(
      USER_ID,
      SAMPLE_DOCUMENT.id,
      1,
    );
    if (!normalized) throw new Error("Normalized artifact is missing");
    expect(normalized).toMatchObject({ pageCount: null, qualityVersion: 0 });
    expect(() => artifactReleaseBinding(normalized)).toThrow(
      "not eligible for publication",
    );
  });

  it("returns the original run for a matching key and rejects different request content", async () => {
    const created = await repository.createRun(runInput());
    const replayed = await repository.createRun(runInput({ id: RETRY_RUN_ID }));
    const replayedAfterRevisionAdvance = await repository.createRun(
      runInput({ id: RETRY_RUN_ID, baseRevision: 2 }),
    );

    expect(replayed.id).toBe(created.id);
    expect(replayedAfterRevisionAdvance.id).toBe(created.id);
    expect(replayedAfterRevisionAdvance.baseRevision).toBe(1);
    expect(replayed.stateVersion).toBe(0);
    await expect(
      repository.createRun(runInput({ id: RETRY_RUN_ID, prompt: "別の依頼です。" })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("rejects a new run against a stale base revision", async () => {
    await expect(
      repository.createRun(
        runInput({ id: RETRY_RUN_ID, idempotencyKey: "run-request-2", baseRevision: 2 }),
      ),
    ).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it("uses stateVersion as a CAS token and prevents terminal state regression", async () => {
    const created = await repository.createRun(runInput());
    expect(created).toMatchObject({
      status: "running",
      stage: "writing",
      stateVersion: 0,
    });

    const completed = await repository.updateRun(USER_ID, RUN_ID, {
      expectedStateVersion: created.stateVersion,
      status: "completed",
      stage: "ready",
      resultRevision: 1,
      errorMessage: null,
    });
    expect(completed.stateVersion).toBe(1);

    // Replaying the same write against the same expected version is a no-op.
    const replay = await repository.updateRun(USER_ID, RUN_ID, {
      status: "completed",
      stage: "ready",
      resultRevision: 1,
      errorMessage: null,
    });
    expect(replay.stateVersion).toBe(1);

    await expect(
      repository.updateRun(USER_ID, RUN_ID, {
        expectedStateVersion: created.stateVersion,
        status: "completed",
        stage: "ready",
        resultRevision: 2,
      }),
    ).rejects.toBeInstanceOf(AgentRunConflictError);

    await expect(
      repository.updateRun(USER_ID, RUN_ID, {
        status: "failed",
        stage: "failed",
        errorMessage: "late failure",
      }),
    ).rejects.toBeInstanceOf(InvalidAgentRunTransitionError);
  });

  it("rejects inconsistent status and stage combinations", async () => {
    await repository.createRun(runInput());
    await expect(
      repository.updateRun(USER_ID, RUN_ID, { status: "running", stage: "ready" }),
    ).rejects.toBeInstanceOf(InvalidAgentRunTransitionError);
    await expect(
      repository.updateRun(USER_ID, RUN_ID, { status: "failed", stage: "failed" }),
    ).rejects.toBeInstanceOf(InvalidAgentRunTransitionError);

    // A turn that only answered completes with no result revision.
    await expect(
      repository.updateRun(USER_ID, RUN_ID, { status: "completed", stage: "ready" }),
    ).resolves.toMatchObject({ status: "completed", resultRevision: null });
  });

  it("deduplicates a retried event and rejects key reuse with different content", async () => {
    await repository.createRun(runInput());
    const input = {
      userId: USER_ID,
      runId: RUN_ID,
      stage: "writing" as const,
      message: "構成を考えています",
      detail: { eventKey: `${RUN_ID}:planning:primary`, attempt: 0 },
    };
    const first = await repository.appendRunEvent(input);
    const replay = await repository.appendRunEvent(input);

    expect(replay).toEqual(first);
    expect(replay.idempotencyKey).toBe(input.detail.eventKey);
    expect(await repository.listRunEvents(USER_ID, RUN_ID)).toHaveLength(1);
    await expect(
      repository.appendRunEvent({ ...input, message: "異なるメッセージ" }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("keeps artifact metadata immutable while accepting a same-content retry", async () => {
    const first = artifact();
    await repository.saveArtifact(first);
    await repository.saveArtifact(
      artifact({ compileDurationMs: 999, createdAt: "2026-08-07T00:01:00.000Z" }),
    );

    expect(await repository.getArtifact(USER_ID, SAMPLE_DOCUMENT.id, 1)).toEqual(first);
    await expect(
      repository.saveArtifact(artifact({ sha256: "b".repeat(64) })),
    ).rejects.toBeInstanceOf(ArtifactConflictError);
    await expect(
      repository.saveArtifact(artifact({ revision: 99 })),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  it("completes a run and appends its ready event atomically and idempotently", async () => {
    await repository.createRun(runInput());
    await repository.saveArtifact(artifact());

    const completions = await Promise.all(
      Array.from({ length: 12 }, () =>
        repository.completeRunForCurrentRevision({
          userId: USER_ID,
          documentId: SAMPLE_DOCUMENT.id,
          runId: RUN_ID,
          revision: 1,
          artifact: artifactReleaseBinding(artifact()),
          eventKey: `${RUN_ID}:ready:primary`,
          eventMessage: "文書が完成しました",
        }),
      ),
    );

    expect(completions.every((result) => result.run.status === "completed")).toBe(true);
    await expect(repository.getRun(USER_ID, RUN_ID)).resolves.toMatchObject({
      status: "completed",
      stage: "ready",
      resultRevision: 1,
    });
    await expect(repository.listRunEvents(USER_ID, RUN_ID)).resolves.toMatchObject([
      {
        stage: "ready",
        message: "文書が完成しました",
        detail: { eventKey: `${RUN_ID}:ready:primary` },
      },
    ]);

    const current = await repository.getDocument(USER_ID, SAMPLE_DOCUMENT.id);
    if (!current) throw new Error("expected document");
    const updated = structuredClone(current.document);
    updated.metadata.title = "完了後に手動更新";
    await repository.commitDocument({
      commitId: "70000000-0000-4000-8000-000000000001",
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      expectedRevision: 1,
      document: updated,
      actor: "user",
      summary: "完了後に更新",
      operations: [{ op: "setMetadata", metadata: updated.metadata }],
    });

    await expect(
      repository.completeRunForCurrentRevision({
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        runId: RUN_ID,
        revision: 1,
        artifact: artifactReleaseBinding(artifact()),
        eventKey: `${RUN_ID}:ready:primary`,
        eventMessage: "文書が完成しました",
      }),
    ).resolves.toMatchObject({ run: { status: "completed", resultRevision: 1 } });
    await expect(repository.listRunEvents(USER_ID, RUN_ID)).resolves.toHaveLength(1);
  });

  it("rejects a stale completion without changing the run or appending ready", async () => {
    await repository.createRun(runInput());
    await repository.saveArtifact(artifact());

    const current = await repository.getDocument(USER_ID, SAMPLE_DOCUMENT.id);
    if (!current) throw new Error("expected document");
    const updated = structuredClone(current.document);
    updated.metadata.title = "先に更新された文書";
    await repository.commitDocument({
      commitId: "70000000-0000-4000-8000-000000000002",
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      expectedRevision: 1,
      document: updated,
      actor: "user",
      summary: "先行更新",
      operations: [{ op: "setMetadata", metadata: updated.metadata }],
    });

    await expect(
      repository.completeRunForCurrentRevision({
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        runId: RUN_ID,
        revision: 1,
        artifact: artifactReleaseBinding(artifact()),
        eventKey: `${RUN_ID}:ready:primary`,
        eventMessage: "文書が完成しました",
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    await expect(repository.getRun(USER_ID, RUN_ID)).resolves.toMatchObject({
      status: "running",
      resultRevision: null,
    });
    await expect(repository.listRunEvents(USER_ID, RUN_ID)).resolves.toEqual([]);
  });

  it("does not complete a run without persisted artifact metadata", async () => {
    await repository.createRun(runInput());

    await expect(
      repository.completeRunForCurrentRevision({
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        runId: RUN_ID,
        revision: 1,
        artifact: artifactReleaseBinding(artifact()),
        eventKey: `${RUN_ID}:ready:primary`,
        eventMessage: "文書が完成しました",
      }),
    ).rejects.toThrow("Document artifact metadata is unavailable");
    await expect(repository.getRun(USER_ID, RUN_ID)).resolves.toMatchObject({
      status: "running",
    });
    await expect(repository.listRunEvents(USER_ID, RUN_ID)).resolves.toEqual([]);
  });

  it("serializes writes from repository instances sharing a file", async () => {
    const sharedFile = path.join(temporaryDirectory, "shared.json");
    const left = new LocalDocumentRepository(sharedFile);
    const right = new LocalDocumentRepository(sharedFile);
    const leftDocument = structuredClone(SAMPLE_DOCUMENT);
    const rightDocument: DocumentModel = {
      ...structuredClone(SAMPLE_DOCUMENT),
      id: "60000000-0000-4000-8000-000000000001",
    };

    await Promise.all([
      left.createDocument(USER_ID, leftDocument),
      right.createDocument(OTHER_USER_ID, rightDocument),
    ]);

    await expect(left.getDocument(USER_ID, leftDocument.id)).resolves.not.toBeNull();
    await expect(right.getDocument(OTHER_USER_ID, rightDocument.id)).resolves.not.toBeNull();
  });
});
