import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SAMPLE_DOCUMENT,
  SAMPLE_DOCUMENT_IDS,
  applyDocumentPatch,
  type DocumentModel,
  type DocumentPatch,
} from "@/domain/document";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import { documentPatchDigest } from "@/server/persistence/pending-actions";
import { loadDocumentDetail } from "@/server/presentation/load-document";
import {
  AgentRunNotFoundError,
  PendingDocumentActionConflictError,
  RunReplyConflictError,
  type RunDecision,
  type StoredAgentRun,
} from "@/server/persistence";
import { resolveDocumentRunDecisionStep } from "@/workflows/document-agent/steps";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "40000000-0000-4000-8000-000000000002";
const SOURCE_RUN_ID = "50000000-0000-4000-8000-000000000001";
const RESPONSE_RUN_ID = "50000000-0000-4000-8000-000000000002";
const OTHER_RUN_ID = "50000000-0000-4000-8000-000000000003";
const OTHER_DOCUMENT_ID = "60000000-0000-4000-8000-000000000001";
const ACTION_ID = "70000000-0000-4000-8000-000000000001";
const PATCH_ID = "70000000-0000-4000-8000-000000000002";

let temporaryDirectory: string;
let repository: LocalDocumentRepository;

type RepositoryGlobal = typeof globalThis & {
  __tex64DocumentRepository?: LocalDocumentRepository;
};

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-pending-action-"));
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

function destructivePatch(
  nodeId = SAMPLE_DOCUMENT_IDS.pageBreak,
): DocumentPatch {
  return {
    id: PATCH_ID,
    documentId: SAMPLE_DOCUMENT.id,
    baseRevision: 1,
    createdAt: "2026-08-07T01:00:00.000Z",
    operations: [{ op: "delete", nodeId }],
  };
}

async function createRunningRun(input: {
  id: string;
  prompt: string;
  idempotencyKey: string;
  documentId?: string;
  userId?: string;
  replyToRunId?: string | null;
  decision?: RunDecision | null;
}): Promise<StoredAgentRun> {
  const userId = input.userId ?? USER_ID;
  const run = await repository.createRun({
    id: input.id,
    userId,
    documentId: input.documentId ?? SAMPLE_DOCUMENT.id,
    prompt: input.prompt,
    replyToRunId: input.replyToRunId ?? null,
    decision: input.decision ?? null,
    idempotencyKey: input.idempotencyKey,
    baseRevision: 1,
  });
  const ownership = await repository.activateRunForWorkflow(
    userId,
    run.id,
    `workflow-${run.id}`,
  );
  expect(ownership.owned).toBe(true);
  return ownership.run;
}

async function createPendingApproval(patch = destructivePatch()) {
  const source = await createRunningRun({
    id: SOURCE_RUN_ID,
    prompt: "改ページを削除して",
    idempotencyKey: "pending-source-1",
  });
  const pendingAction = {
    id: ACTION_ID,
    patch,
    patchDigest: documentPatchDigest(patch),
    summary: "改ページを削除",
  };
  const waiting = await repository.setRunNeedsInput({
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    runId: source.id,
    expectedStateVersion: source.stateVersion,
    code: "approval_required",
    question: "この改ページを削除してよいですか？",
    pendingAction,
  });
  return { source, waiting, pendingAction };
}

async function createDecisionRun(decision: RunDecision) {
  return createRunningRun({
    id: RESPONSE_RUN_ID,
    prompt:
      decision === "approve"
        ? "見出しを削除してください"
        : "変更を取り消してください",
    replyToRunId: SOURCE_RUN_ID,
    decision,
    idempotencyKey: `pending-decision-${decision}`,
  });
}

describe.sequential("LocalDocumentRepository pending document actions", () => {
  it("validates the pending input kind before creating a response run", async () => {
    const source = await createRunningRun({
      id: SOURCE_RUN_ID,
      prompt: "テーマを確認",
      idempotencyKey: "clarification-source",
    });
    await repository.setRunNeedsInput({
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      runId: source.id,
      expectedStateVersion: source.stateVersion,
      code: "clarification_required",
      question: "対象テーマは何ですか？",
    });

    const decisionInput = {
      id: RESPONSE_RUN_ID,
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "変更を承認",
      replyToRunId: SOURCE_RUN_ID,
      decision: "approve" as const,
      idempotencyKey: "invalid-clarification-decision",
      baseRevision: 1,
    };
    await expect(
      repository.validateRunReplyTarget(decisionInput),
    ).rejects.toBeInstanceOf(RunReplyConflictError);
    await expect(repository.createRun(decisionInput)).rejects.toBeInstanceOf(
      RunReplyConflictError,
    );

    const answerInput = {
      ...decisionInput,
      decision: null,
      prompt: "注意機構です",
      idempotencyKey: "valid-clarification-answer",
    };
    await expect(repository.validateRunReplyTarget(answerInput)).resolves.toBeUndefined();
    await expect(repository.createRun(answerInput)).resolves.toMatchObject({
      status: "queued",
      replyToRunId: SOURCE_RUN_ID,
      decision: null,
    });
    await expect(
      repository.createRun({
        ...answerInput,
        id: OTHER_RUN_ID,
        idempotencyKey: "duplicate-active-answer",
      }),
    ).rejects.toBeInstanceOf(RunReplyConflictError);
  });

  it("rejects a prose answer when an approval decision is required", async () => {
    await createPendingApproval();
    await expect(
      repository.createRun({
        id: RESPONSE_RUN_ID,
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        prompt: "いいと思います",
        replyToRunId: SOURCE_RUN_ID,
        decision: null,
        idempotencyKey: "invalid-approval-answer",
        baseRevision: 1,
      }),
    ).rejects.toBeInstanceOf(RunReplyConflictError);
  });

  it("restores approval input kind in document detail after a reload", async () => {
    await createPendingApproval();

    const detail = await loadDocumentDetail(USER_ID, SAMPLE_DOCUMENT.id);

    expect(detail.runs.find((run) => run.id === SOURCE_RUN_ID)).toMatchObject({
      status: "waiting_approval",
      stage: "needs_input",
      inputKind: "approval",
    });
  });

  it("persists the needs-input state, event, and exact pending patch together", async () => {
    const { waiting, pendingAction } = await createPendingApproval();

    expect(waiting).toMatchObject({
      status: "waiting_approval",
      stage: "needs_input",
      errorMessage: "この改ページを削除してよいですか？",
    });
    const events = await repository.listRunEvents(USER_ID, SOURCE_RUN_ID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stage: "needs_input",
      detail: {
        code: "approval_required",
        question: "この改ページを削除してよいですか？",
        pendingActionId: ACTION_ID,
        patchDigest: pendingAction.patchDigest,
      },
    });
    await expect(
      repository.getPendingDocumentAction(USER_ID, SOURCE_RUN_ID),
    ).resolves.toMatchObject({
      id: ACTION_ID,
      documentId: SAMPLE_DOCUMENT.id,
      sourceRunId: SOURCE_RUN_ID,
      status: "pending",
      baseRevision: 1,
      patch: pendingAction.patch,
      patchDigest: pendingAction.patchDigest,
      summary: pendingAction.summary,
      resolvedByRunId: null,
      appliedRevision: null,
    });

    // A durable-step replay does not duplicate either half of the transition.
    await repository.setRunNeedsInput({
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      runId: SOURCE_RUN_ID,
      expectedStateVersion: waiting.stateVersion,
      code: "approval_required",
      question: "この改ページを削除してよいですか？",
      pendingAction,
    });
    await expect(
      repository.listRunEvents(USER_ID, SOURCE_RUN_ID),
    ).resolves.toHaveLength(1);
  });

  it("applies only the stored patch even when the approval run prompt asks for something else", async () => {
    const { pendingAction } = await createPendingApproval();
    await createDecisionRun("approve");

    const result = await repository.resolvePendingDocumentDecision(
      USER_ID,
      SAMPLE_DOCUMENT.id,
      RESPONSE_RUN_ID,
      SOURCE_RUN_ID,
    );

    expect(result).toMatchObject({
      status: "applied",
      revision: 2,
      action: {
        status: "applied",
        patch: pendingAction.patch,
        patchDigest: pendingAction.patchDigest,
        resolvedByRunId: RESPONSE_RUN_ID,
        appliedRevision: 2,
      },
    });
    const document = await repository.getDocument(USER_ID, SAMPLE_DOCUMENT.id);
    expect(document?.currentRevision).toBe(2);
    expect(
      document?.document.nodes.some(
        (node) => node.id === SAMPLE_DOCUMENT_IDS.pageBreak,
      ),
    ).toBe(false);
    expect(
      document?.document.nodes.some(
        (node) => node.id === SAMPLE_DOCUMENT_IDS.heading,
      ),
    ).toBe(true);
    await expect(repository.getRun(USER_ID, SOURCE_RUN_ID)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(repository.getRun(USER_ID, RESPONSE_RUN_ID)).resolves.toMatchObject({
      status: "running",
      resultRevision: 2,
    });

    // Replaying after the atomic commit returns the original decision and does
    // not create another document revision.
    await expect(
      repository.resolvePendingDocumentDecision(
        USER_ID,
        SAMPLE_DOCUMENT.id,
        RESPONSE_RUN_ID,
        SOURCE_RUN_ID,
      ),
    ).resolves.toMatchObject({ status: "applied", revision: 2 });
    await expect(
      repository.listRevisions(USER_ID, SAMPLE_DOCUMENT.id),
    ).resolves.toHaveLength(2);
  });

  it("self-heals run and action state when the exact patch commit already exists", async () => {
    const { pendingAction } = await createPendingApproval();
    await createDecisionRun("approve");
    const base = await repository.getRevision(USER_ID, SAMPLE_DOCUMENT.id, 1);
    expect(base).not.toBeNull();
    if (!base) return;
    const applied = applyDocumentPatch(
      {
        revisionId: base.commitId,
        revision: base.revision,
        parentRevisionId: null,
        committedAt: base.createdAt,
        document: base.document,
      },
      pendingAction.patch,
    );
    await repository.commitDocument({
      commitId: pendingAction.patch.id,
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      expectedRevision: pendingAction.patch.baseRevision,
      document: applied.document,
      actor: "agent",
      summary: pendingAction.summary,
      operations: pendingAction.patch.operations,
    });

    await expect(
      repository.resolvePendingDocumentDecision(
        USER_ID,
        SAMPLE_DOCUMENT.id,
        RESPONSE_RUN_ID,
        SOURCE_RUN_ID,
      ),
    ).resolves.toMatchObject({ status: "applied", revision: 2 });
    await expect(
      repository.getPendingDocumentAction(USER_ID, SOURCE_RUN_ID),
    ).resolves.toMatchObject({
      status: "applied",
      resolvedByRunId: RESPONSE_RUN_ID,
      appliedRevision: 2,
    });
    await expect(repository.getRun(USER_ID, SOURCE_RUN_ID)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(repository.getRun(USER_ID, RESPONSE_RUN_ID)).resolves.toMatchObject({
      status: "running",
      resultRevision: 2,
    });
    await expect(
      repository.listRevisions(USER_ID, SAMPLE_DOCUMENT.id),
    ).resolves.toHaveLength(2);
  });

  it("rejects safely, cancels both runs, and leaves the document unchanged", async () => {
    await createPendingApproval();
    await createDecisionRun("reject");

    await expect(
      repository.resolvePendingDocumentDecision(
        USER_ID,
        SAMPLE_DOCUMENT.id,
        RESPONSE_RUN_ID,
        SOURCE_RUN_ID,
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      action: {
        status: "rejected",
        resolvedByRunId: RESPONSE_RUN_ID,
        appliedRevision: null,
      },
    });
    await expect(repository.getRun(USER_ID, SOURCE_RUN_ID)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(repository.getRun(USER_ID, RESPONSE_RUN_ID)).resolves.toMatchObject({
      status: "cancelled",
      resultRevision: null,
    });
    await expect(
      repository.getDocument(USER_ID, SAMPLE_DOCUMENT.id),
    ).resolves.toMatchObject({ currentRevision: 1 });
    await expect(
      repository.listRevisions(USER_ID, SAMPLE_DOCUMENT.id),
    ).resolves.toHaveLength(1);

    await expect(
      repository.resolvePendingDocumentDecision(
        USER_ID,
        SAMPLE_DOCUMENT.id,
        RESPONSE_RUN_ID,
        SOURCE_RUN_ID,
      ),
    ).resolves.toMatchObject({ status: "rejected" });
  });

  it("fails a stale approval and cancels the pending action without applying it", async () => {
    await createPendingApproval();
    await createDecisionRun("approve");

    const current = await repository.getDocument(USER_ID, SAMPLE_DOCUMENT.id);
    expect(current).not.toBeNull();
    if (!current) return;
    const externallyUpdated: DocumentModel = {
      ...structuredClone(current.document),
      metadata: {
        ...structuredClone(current.document.metadata),
        title: "別の操作で更新された文書",
        updatedAt: "2026-08-07T02:00:00.000Z",
      },
    };
    await repository.commitDocument({
      commitId: "70000000-0000-4000-8000-000000000003",
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      expectedRevision: 1,
      document: externallyUpdated,
      actor: "user",
      summary: "別の操作で更新",
      operations: [
        { op: "setMetadata", metadata: externallyUpdated.metadata },
      ],
    });

    const result = await repository.resolvePendingDocumentDecision(
      USER_ID,
      SAMPLE_DOCUMENT.id,
      RESPONSE_RUN_ID,
      SOURCE_RUN_ID,
    );
    expect(result).toMatchObject({
      status: "stale",
      action: {
        status: "cancelled",
        resolvedByRunId: RESPONSE_RUN_ID,
        appliedRevision: null,
      },
    });
    await expect(repository.getRun(USER_ID, SOURCE_RUN_ID)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(repository.getRun(USER_ID, RESPONSE_RUN_ID)).resolves.toMatchObject({
      status: "failed",
      stage: "failed",
      resultRevision: null,
    });
    const document = await repository.getDocument(USER_ID, SAMPLE_DOCUMENT.id);
    expect(document).toMatchObject({
      currentRevision: 2,
      title: "別の操作で更新された文書",
    });
    expect(
      document?.document.nodes.some(
        (node) => node.id === SAMPLE_DOCUMENT_IDS.pageBreak,
      ),
    ).toBe(true);

    await expect(
      repository.resolvePendingDocumentDecision(
        USER_ID,
        SAMPLE_DOCUMENT.id,
        RESPONSE_RUN_ID,
        SOURCE_RUN_ID,
      ),
    ).resolves.toMatchObject({ status: "stale" });
  });

  it("reports a stale structured approval as failed instead of asking for clarification", async () => {
    await createPendingApproval();
    const response = await createDecisionRun("approve");
    const current = await repository.getDocument(USER_ID, SAMPLE_DOCUMENT.id);
    expect(current).not.toBeNull();
    if (!current) return;
    const externallyUpdated: DocumentModel = {
      ...structuredClone(current.document),
      metadata: {
        ...structuredClone(current.document.metadata),
        title: "先に更新された文書",
        updatedAt: "2026-08-07T02:30:00.000Z",
      },
    };
    await repository.commitDocument({
      commitId: "70000000-0000-4000-8000-000000000004",
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      expectedRevision: 1,
      document: externallyUpdated,
      actor: "user",
      summary: "先行更新",
      operations: [{ op: "setMetadata", metadata: externallyUpdated.metadata }],
    });

    await expect(
      resolveDocumentRunDecisionStep({
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        runId: response.id,
        prompt: response.prompt,
        baseRevision: response.baseRevision,
        replyToRunId: response.replyToRunId,
        decision: response.decision,
      }),
    ).resolves.toMatchObject({ status: "stale" });
    await expect(repository.getRun(USER_ID, RESPONSE_RUN_ID)).resolves.toMatchObject({
      status: "failed",
      stage: "failed",
    });
    expect(
      (await repository.listRunEvents(USER_ID, RESPONSE_RUN_ID)).some(
        (event) => event.detail?.code === "clarification_required",
      ),
    ).toBe(false);
  });

  it("rejects a response that targets the wrong run, document, or tenant", async () => {
    await createPendingApproval();
    await createRunningRun({
      id: OTHER_RUN_ID,
      prompt: "別の作業",
      idempotencyKey: "other-run-1",
    });
    await expect(
      createRunningRun({
        id: RESPONSE_RUN_ID,
        prompt: "承認",
        replyToRunId: OTHER_RUN_ID,
        decision: "approve",
        idempotencyKey: "wrong-reply-1",
      }),
    ).rejects.toBeInstanceOf(RunReplyConflictError);

    const otherDocument = {
      ...structuredClone(SAMPLE_DOCUMENT),
      id: OTHER_DOCUMENT_ID,
    };
    await repository.createDocument(USER_ID, otherDocument);
    const crossDocumentResponseId =
      "50000000-0000-4000-8000-000000000004";
    await expect(
      createRunningRun({
        id: crossDocumentResponseId,
        documentId: OTHER_DOCUMENT_ID,
        prompt: "承認",
        replyToRunId: SOURCE_RUN_ID,
        decision: "approve",
        idempotencyKey: "wrong-document-1",
      }),
    ).rejects.toBeInstanceOf(RunReplyConflictError);

    await expect(
      repository.resolvePendingDocumentDecision(
        OTHER_USER_ID,
        SAMPLE_DOCUMENT.id,
        RESPONSE_RUN_ID,
        SOURCE_RUN_ID,
      ),
    ).rejects.toBeInstanceOf(AgentRunNotFoundError);

    // None of the rejected decisions consumed the pending action.
    await expect(
      repository.getPendingDocumentAction(USER_ID, SOURCE_RUN_ID),
    ).resolves.toMatchObject({ status: "pending", resolvedByRunId: null });
    await expect(repository.getRun(USER_ID, SOURCE_RUN_ID)).resolves.toMatchObject({
      status: "waiting_approval",
    });
  });

  it("does not partially persist a needs-input transition when validation fails", async () => {
    const source = await createRunningRun({
      id: SOURCE_RUN_ID,
      prompt: "改ページを削除して",
      idempotencyKey: "invalid-pending-source-1",
    });
    const patch = destructivePatch();

    await expect(
      repository.setRunNeedsInput({
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        runId: SOURCE_RUN_ID,
        expectedStateVersion: source.stateVersion,
        code: "approval_required",
        question: "この改ページを削除してよいですか？",
        pendingAction: {
          id: ACTION_ID,
          patch,
          patchDigest: "0".repeat(64),
          summary: "改ページを削除",
        },
      }),
    ).rejects.toBeInstanceOf(PendingDocumentActionConflictError);

    await expect(repository.getRun(USER_ID, SOURCE_RUN_ID)).resolves.toMatchObject({
      status: "running",
      stage: "understanding",
      errorMessage: null,
      stateVersion: source.stateVersion,
    });
    await expect(
      repository.listRunEvents(USER_ID, SOURCE_RUN_ID),
    ).resolves.toEqual([]);
    await expect(
      repository.getPendingDocumentAction(USER_ID, SOURCE_RUN_ID),
    ).resolves.toBeNull();
  });
});
