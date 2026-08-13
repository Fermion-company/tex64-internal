import { randomUUID } from "node:crypto";
import type {
  DocumentRepository,
  RunDecision,
  StoredAgentRun,
} from "@/server/persistence";

const WORKFLOW_START_LEASE_MS = 30_000;

export type DocumentWorkflowInput = {
  userId: string;
  documentId: string;
  runId: string;
  prompt: string;
  baseRevision: number;
  replyToRunId: string | null;
  decision: RunDecision | null;
  targetNodeId: string | null;
};

export type DocumentWorkflowStarter = (
  input: DocumentWorkflowInput,
) => Promise<{ runId: string }>;

export class WorkflowStartUnavailableError extends Error {
  constructor() {
    super("The document workflow could not be started.");
    this.name = "WorkflowStartUnavailableError";
  }
}

export async function createAndStartDocumentRun(input: {
  repository: DocumentRepository;
  requestedRunId: string;
  userId: string;
  documentId: string;
  prompt: string;
  idempotencyKey: string;
  baseRevision: number;
  replyToRunId?: string | null;
  decision?: RunDecision | null;
  targetNodeId?: string | null;
  startWorkflow: DocumentWorkflowStarter;
}): Promise<StoredAgentRun> {
  const run = await input.repository.createRun({
    id: input.requestedRunId,
    userId: input.userId,
    documentId: input.documentId,
    prompt: input.prompt,
    idempotencyKey: input.idempotencyKey,
    baseRevision: input.baseRevision,
    replyToRunId: input.replyToRunId ?? null,
    decision: input.decision ?? null,
    targetNodeId: input.targetNodeId ?? null,
  });

  if (
    run.workflowRunId !== null ||
    (run.status !== "queued" && run.status !== "running")
  ) {
    return run;
  }

  const leaseToken = randomUUID();
  const claim = await input.repository.claimRunForWorkflowStart(
    input.userId,
    run.id,
    leaseToken,
    WORKFLOW_START_LEASE_MS,
  );
  if (!claim.claimed) return claim.run;

  let workflowRunId: string;
  try {
    const workflowRun = await input.startWorkflow({
      userId: run.userId,
      documentId: run.documentId,
      runId: run.id,
      prompt: run.prompt,
      baseRevision: run.baseRevision,
      replyToRunId: run.replyToRunId,
      decision: run.decision,
      targetNodeId: run.targetNodeId,
    });
    workflowRunId = workflowRun.runId;
  } catch {
    // Keep the durable run queued. A replay of the same idempotency key can
    // safely retry start(), while a start that was accepted before throwing
    // will bind itself from the workflow entrypoint.
    await input.repository
      .releaseRunWorkflowStartClaim(input.userId, run.id, leaseToken)
      .catch(() => false);
    throw new WorkflowStartUnavailableError();
  }

  const ownership = await input.repository.activateRunForWorkflow(
    input.userId,
    run.id,
    workflowRunId,
  );
  return ownership.run;
}
