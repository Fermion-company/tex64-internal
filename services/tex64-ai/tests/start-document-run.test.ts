import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SAMPLE_DOCUMENT, SAMPLE_DOCUMENT_IDS } from "@/domain/document";
import {
  WorkflowStartUnavailableError,
  createAndStartDocumentRun,
} from "@/server/http/start-document-run";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "run-request-parallel-1";

let temporaryDirectory: string;
let repository: LocalDocumentRepository;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-start-run-"));
  repository = new LocalDocumentRepository(path.join(temporaryDirectory, "store.json"));
  await repository.createDocument(USER_ID, structuredClone(SAMPLE_DOCUMENT));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function launch(overrides: {
  requestedRunId?: string;
  prompt?: string;
  baseRevision?: number;
  startWorkflow: (input: { runId: string }) => Promise<{ runId: string }>;
}) {
  return createAndStartDocumentRun({
    repository,
    requestedRunId: overrides.requestedRunId ?? randomUUID(),
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    prompt: overrides.prompt ?? "論文の構成と本文を作成してください。",
    idempotencyKey: IDEMPOTENCY_KEY,
    baseRevision: overrides.baseRevision ?? 1,
    startWorkflow: overrides.startWorkflow,
  });
}

describe("document workflow launch boundary", () => {
  it("starts exactly one workflow for 100 concurrent replays", async () => {
    let starts = 0;
    let releaseStart!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const startWorkflow = async () => {
      starts += 1;
      notifyStarted();
      await release;
      return { runId: "workflow-run-owner" };
    };

    const requests = Array.from({ length: 100 }, () => launch({ startWorkflow }));
    await started;
    releaseStart();
    const runs = await Promise.all(requests);

    expect(starts).toBe(1);
    expect(new Set(runs.map((run) => run.id))).toHaveLength(1);
    const stored = await repository.getRun(USER_ID, runs[0]!.id);
    expect(stored?.status).toBe("running");
    expect(stored?.workflowRunId).toBe("workflow-run-owner");
  });

  it("keeps a failed launch queued so the same request can recover", async () => {
    let starts = 0;
    let failStart = true;
    const startWorkflow = async () => {
      starts += 1;
      if (failStart) throw new Error("provider details must remain private");
      return { runId: "workflow-run-recovered" };
    };

    await expect(launch({ startWorkflow })).rejects.toBeInstanceOf(
      WorkflowStartUnavailableError,
    );
    const [queued] = await repository.listRuns(USER_ID, SAMPLE_DOCUMENT.id);
    expect(queued).toMatchObject({
      status: "queued",
      stage: "understanding",
      workflowRunId: null,
    });

    failStart = false;
    const replayed = await launch({ startWorkflow });
    expect(replayed).toMatchObject({
      status: "running",
      workflowRunId: "workflow-run-recovered",
    });
    expect(starts).toBe(2);
  });

  it("recovers a lease abandoned before Workflow start", async () => {
    const run = await repository.createRun({
      id: randomUUID(),
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "論文を作成",
      idempotencyKey: "abandoned-launch-lease",
      baseRevision: 1,
    });
    const first = await repository.claimRunForWorkflowStart(
      USER_ID,
      run.id,
      "abandoned-token",
      1,
    );
    expect(first.claimed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const recovered = await repository.claimRunForWorkflowStart(
      USER_ID,
      run.id,
      "recovery-token",
      30_000,
    );
    expect(recovered.claimed).toBe(true);
  });

  it("lets an accepted workflow self-bind before the HTTP caller binds it", async () => {
    const run = await repository.createRun({
      id: randomUUID(),
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "論文を作成",
      idempotencyKey: "self-bind-after-start",
      baseRevision: 1,
    });
    await repository.claimRunForWorkflowStart(
      USER_ID,
      run.id,
      "caller-crashed-token",
      30_000,
    );
    await expect(
      repository.activateRunForWorkflow(USER_ID, run.id, "workflow-self-bound"),
    ).resolves.toMatchObject({ owned: true });

    let starts = 0;
    const replayed = await createAndStartDocumentRun({
      repository,
      requestedRunId: randomUUID(),
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "論文を作成",
      idempotencyKey: "self-bind-after-start",
      baseRevision: 1,
      startWorkflow: async () => {
        starts += 1;
        return { runId: "unexpected" };
      },
    });
    expect(replayed.workflowRunId).toBe("workflow-self-bound");
    expect(starts).toBe(0);
  });

  it("does not let a stale launch token release its replacement", async () => {
    const run = await repository.createRun({
      id: randomUUID(),
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "論文を作成",
      idempotencyKey: "stale-launch-release",
      baseRevision: 1,
    });
    await repository.claimRunForWorkflowStart(USER_ID, run.id, "stale-token", 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await repository.claimRunForWorkflowStart(
      USER_ID,
      run.id,
      "current-token",
      30_000,
    );
    await expect(
      repository.releaseRunWorkflowStartClaim(USER_ID, run.id, "stale-token"),
    ).resolves.toBe(false);
    await expect(
      repository.claimRunForWorkflowStart(
        USER_ID,
        run.id,
        "third-token",
        30_000,
      ),
    ).resolves.toMatchObject({ claimed: false });
  });

  it("replays the original run after the document advances without launching again", async () => {
    let starts = 0;
    const startWorkflow = async () => {
      starts += 1;
      return { runId: "workflow-run-replay-1" };
    };
    const first = await launch({ startWorkflow });
    const current = await repository.getDocument(USER_ID, SAMPLE_DOCUMENT.id);
    if (!current) throw new Error("expected document");
    const updated = structuredClone(current.document);
    updated.metadata.title = "更新後の文書";
    await repository.commitDocument({
      commitId: randomUUID(),
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      expectedRevision: 1,
      document: updated,
      actor: "user",
      summary: "手動更新",
      operations: [{ op: "setMetadata", metadata: updated.metadata }],
    });

    const replayed = await launch({
      requestedRunId: randomUUID(),
      baseRevision: 2,
      startWorkflow,
    });

    expect(replayed.id).toBe(first.id);
    expect(replayed.baseRevision).toBe(1);
    expect(starts).toBe(1);
  });

  it("forwards a clarification answer and its reply target to the durable workflow", async () => {
    const sourceRunId = randomUUID();
    const source = await repository.createRun({
      id: sourceRunId,
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "論文を書いて",
      idempotencyKey: "clarification-source-1",
      baseRevision: 1,
    });
    const activeSource = await repository.activateRunForWorkflow(
      USER_ID,
      source.id,
      "workflow-clarification-source",
    );
    await repository.setRunNeedsInput({
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      runId: source.id,
      expectedStateVersion: activeSource.run.stateVersion,
      code: "clarification_required",
      question: "対象読者を教えてください。",
    });
    let startedInput: { replyToRunId: string | null } | undefined;

    await createAndStartDocumentRun({
      repository,
      requestedRunId: randomUUID(),
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "学部生向けです",
      replyToRunId: sourceRunId,
      idempotencyKey: "clarification-response-1",
      baseRevision: 1,
      startWorkflow: async (input) => {
        startedInput = input;
        return { runId: "workflow-clarification-1" };
      },
    });

    expect(startedInput).toMatchObject({
      replyToRunId: sourceRunId,
    });
  });
});
