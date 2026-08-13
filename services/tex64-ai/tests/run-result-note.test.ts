import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SAMPLE_DOCUMENT, SAMPLE_DOCUMENT_IDS } from "@/domain/document";
import { normalizeUserFacingResultNote } from "@/lib/user-facing-copy";
import { CURRENT_ARTIFACT_QUALITY_VERSION } from "@/server/artifacts";
import {
  IdempotencyConflictError,
  InvalidAgentRunTransitionError,
  type ArtifactReleaseBinding,
  type DocumentRepository,
  type StoredAgentRun,
  type StoredArtifact,
} from "@/server/persistence";
import { prepareRunUpdate } from "@/server/persistence/invariants";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import { toAgentRun } from "@/server/presentation/document-view";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const RUN_ID = "50000000-0000-4000-8000-000000000001";
const RESULT_NOTE = "第2節を書き直しました。";
const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const PDF_SHA256 = createHash("sha256").update(PDF).digest("hex");

type RepositoryGlobal = typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
};

let temporaryDirectory: string;
let repository: LocalDocumentRepository;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-result-note-"));
  repository = new LocalDocumentRepository(
    path.join(temporaryDirectory, "store.json"),
  );
  (globalThis as RepositoryGlobal).__tex64DocumentRepository = repository;
  await repository.createDocument(USER_ID, structuredClone(SAMPLE_DOCUMENT));
});

afterEach(async () => {
  delete (globalThis as RepositoryGlobal).__tex64DocumentRepository;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function runningRun(): StoredAgentRun {
  return {
    id: RUN_ID,
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    prompt: "第2節を書き直して",
    replyToRunId: null,
    decision: null,
    targetNodeId: null,
    idempotencyKey: "result-note-invariants",
    workflowRunId: "workflow-result-note",
    status: "running",
    stage: "writing",
    baseRevision: 1,
    resultRevision: null,
    artifactRelease: null,
    errorMessage: null,
    resultNote: null,
    stateVersion: 2,
    createdAt: "2026-08-07T00:01:00.000Z",
    updatedAt: "2026-08-07T00:02:00.000Z",
  };
}

describe("result note sanitizer", () => {
  it("passes a plain closing sentence through unchanged", () => {
    expect(
      normalizeUserFacingResultNote("第2節を数式の導出も含めて書き直しました。"),
    ).toBe("第2節を数式の導出も含めて書き直しました。");
  });

  it("fails closed on internal or malformed closing messages", () => {
    expect(normalizeUserFacingResultNote("\\section{x} を追加しました")).toBeNull();
    expect(normalizeUserFacingResultNote("あ".repeat(1001))).toBeNull();
    expect(normalizeUserFacingResultNote("")).toBeNull();
    expect(normalizeUserFacingResultNote("   \n  ")).toBeNull();
    expect(
      normalizeUserFacingResultNote("apply_document_patch で本文を更新しました"),
    ).toBeNull();
    expect(normalizeUserFacingResultNote(undefined)).toBeNull();
  });
});

describe.sequential("completed run result note persistence", () => {
  it("stores the note at completion, replays idempotently, and surfaces it to the client", async () => {
    await repository.createRun({
      id: RUN_ID,
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "第2節を書き直して",
      idempotencyKey: "result-note-completion",
      baseRevision: 1,
    });
    await repository.activateRunForWorkflow(
      USER_ID,
      RUN_ID,
      "workflow-result-note",
    );
    await repository.updateRun(USER_ID, RUN_ID, {
      status: "running",
      stage: "writing",
    });

    const artifact: StoredArtifact = {
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      revision: 1,
      storageKey: `documents/${USER_ID}/${SAMPLE_DOCUMENT.id}/1.pdf`,
      sha256: PDF_SHA256,
      byteSize: PDF.byteLength,
      compileDurationMs: 120,
      pageCount: 1,
      qualityVersion: CURRENT_ARTIFACT_QUALITY_VERSION,
      createdAt: "2026-08-07T00:00:00.000Z",
    };
    await repository.saveArtifact(artifact);
    const release: ArtifactReleaseBinding = {
      revision: 1,
      storageKey: artifact.storageKey,
      sha256: artifact.sha256,
      byteSize: artifact.byteSize,
      pageCount: 1,
      qualityVersion: CURRENT_ARTIFACT_QUALITY_VERSION,
    };
    const input = {
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      runId: RUN_ID,
      revision: 1,
      artifact: release,
      eventKey: `${RUN_ID}:ready:primary`,
      eventMessage: "組版が完了しました",
      resultNote: RESULT_NOTE,
    };

    const first = await repository.completeRunForCurrentRevision(input);
    expect(first.run).toMatchObject({
      status: "completed",
      stage: "ready",
      resultRevision: 1,
      resultNote: RESULT_NOTE,
      artifactRelease: release,
    });
    expect(first.event).toMatchObject({ stage: "ready" });

    const replay = await repository.completeRunForCurrentRevision(input);
    expect(replay.run).toEqual(first.run);
    await expect(repository.listRunEvents(USER_ID, RUN_ID)).resolves.toHaveLength(1);

    const stored = await repository.getRun(USER_ID, RUN_ID);
    expect(stored?.resultNote).toBe(RESULT_NOTE);
    if (!stored) throw new Error("Completed run is missing");
    expect(toAgentRun(stored).resultNote).toBe(RESULT_NOTE);
  });

  it("keeps a result note out of non-completed run states", () => {
    const current = runningRun();

    expect(() =>
      prepareRunUpdate(current, { resultNote: RESULT_NOTE }, "2026-08-07T00:03:00.000Z"),
    ).toThrow(InvalidAgentRunTransitionError);

    // A null note is a no-op for an active run, never a transition.
    const unchanged = prepareRunUpdate(
      current,
      { resultNote: null },
      "2026-08-07T00:03:00.000Z",
    );
    expect(unchanged).toEqual(current);
    expect(unchanged.stateVersion).toBe(current.stateVersion);
  });

  it("persists the run's target node and refuses replays that change it", async () => {
    const run = await repository.createRun({
      id: RUN_ID,
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "この段落を直して",
      idempotencyKey: "target-node-run",
      baseRevision: 1,
      targetNodeId: SAMPLE_DOCUMENT_IDS.paragraph,
    });
    expect(run.targetNodeId).toBe(SAMPLE_DOCUMENT_IDS.paragraph);
    await expect(repository.getRun(USER_ID, RUN_ID)).resolves.toMatchObject({
      targetNodeId: SAMPLE_DOCUMENT_IDS.paragraph,
    });

    // Exact replay returns the original run.
    await expect(
      repository.createRun({
        id: "50000000-0000-4000-8000-000000000002",
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        prompt: "この段落を直して",
        idempotencyKey: "target-node-run",
        baseRevision: 1,
        targetNodeId: SAMPLE_DOCUMENT_IDS.paragraph,
      }),
    ).resolves.toMatchObject({ id: RUN_ID });

    // Same key with a different selection is a conflicting request.
    await expect(
      repository.createRun({
        id: "50000000-0000-4000-8000-000000000003",
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        prompt: "この段落を直して",
        idempotencyKey: "target-node-run",
        baseRevision: 1,
        targetNodeId: SAMPLE_DOCUMENT_IDS.equation,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      repository.createRun({
        id: "50000000-0000-4000-8000-000000000004",
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        prompt: "この段落を直して",
        idempotencyKey: "target-node-run",
        baseRevision: 1,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
