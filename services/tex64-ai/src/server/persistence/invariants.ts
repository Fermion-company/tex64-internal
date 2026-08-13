import {
  AgentRunConflictError,
  ArtifactConflictError,
  IdempotencyConflictError,
  InvalidAgentRunTransitionError,
  type AgentRunStage,
  type AgentRunStatus,
  type AppendRunEventInput,
  type CommitDocumentInput,
  type CreateRunInput,
  type StoredAgentRun,
  type StoredArtifact,
  type StoredRunEvent,
  type StoredRevision,
  type UpdateRunInput,
} from "./types";

const ACTIVE_STAGES = new Set<AgentRunStage>([
  "understanding",
  "planning",
  "writing",
  "checking",
  "formatting",
]);

const STATUS_TRANSITIONS: Record<AgentRunStatus, ReadonlySet<AgentRunStatus>> = {
  queued: new Set(["queued", "running", "failed", "cancelled"]),
  running: new Set(["running", "waiting_approval", "completed", "failed", "cancelled"]),
  waiting_approval: new Set(["waiting_approval", "running", "failed", "cancelled"]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
};

const UPDATE_FIELDS = [
  "workflowRunId",
  "status",
  "stage",
  "resultRevision",
  "errorMessage",
  "resultNote",
] as const;

export function assertRunReplayMatches(existing: StoredAgentRun, input: CreateRunInput): void {
  if (
    existing.prompt !== input.prompt ||
    existing.replyToRunId !== (input.replyToRunId ?? null) ||
    existing.decision !== (input.decision ?? null) ||
    existing.targetNodeId !== (input.targetNodeId ?? null)
  ) {
    throw new IdempotencyConflictError("agent_run", input.idempotencyKey);
  }
}

export function assertDocumentCommitReplayMatches(
  existing: StoredRevision,
  input: CommitDocumentInput,
): void {
  if (
    existing.userId !== input.userId ||
    existing.documentId !== input.documentId ||
    existing.commitId !== input.commitId ||
    existing.revision !== input.expectedRevision + 1 ||
    existing.actor !== input.actor ||
    existing.summary !== input.summary ||
    canonicalJson(existing.document) !== canonicalJson(input.document) ||
    canonicalJson(existing.operations) !== canonicalJson(input.operations)
  ) {
    throw new IdempotencyConflictError("document_commit", input.commitId);
  }
}

export function runEventIdempotencyKey(input: AppendRunEventInput): string {
  const key =
    "idempotencyKey" in input && input.idempotencyKey !== undefined
      ? input.idempotencyKey
      : input.detail.eventKey;
  if (key.length === 0 || key.length > 200) {
    throw new Error("Run event idempotency key must contain between 1 and 200 characters.");
  }
  return key;
}

export function assertRunEventReplayMatches(
  existing: StoredRunEvent,
  input: AppendRunEventInput,
): void {
  if (
    existing.stage !== input.stage ||
    existing.message !== input.message ||
    canonicalJson(existing.detail) !== canonicalJson(input.detail)
  ) {
    throw new IdempotencyConflictError("run_event", existing.idempotencyKey);
  }
}

export function prepareRunUpdate(
  currentValue: StoredAgentRun,
  update: UpdateRunInput,
  now: string,
): StoredAgentRun {
  const current = {
    ...currentValue,
    stateVersion: currentValue.stateVersion ?? 0,
  };
  if (
    update.expectedStateVersion !== undefined &&
    update.expectedStateVersion !== current.stateVersion
  ) {
    if (runUpdateMatches(current, update)) return current;
    throw new AgentRunConflictError(update.expectedStateVersion, current.stateVersion);
  }

  const candidate: StoredAgentRun = { ...current };
  for (const field of UPDATE_FIELDS) {
    const value = update[field];
    if (value !== undefined) {
      Object.assign(candidate, { [field]: value });
    }
  }

  if (runUpdateMatches(current, update)) return current;
  assertRunTransition(current, candidate);
  return {
    ...candidate,
    stateVersion: current.stateVersion + 1,
    updatedAt: now,
  };
}

export function artifactsMatch(existing: StoredArtifact, candidate: StoredArtifact): boolean {
  return (
    existing.userId === candidate.userId &&
    existing.documentId === candidate.documentId &&
    existing.revision === candidate.revision &&
    existing.storageKey === candidate.storageKey &&
    existing.sha256 === candidate.sha256 &&
    existing.byteSize === candidate.byteSize &&
    existing.pageCount === candidate.pageCount &&
    existing.qualityVersion === candidate.qualityVersion
  );
}

export function assertArtifactReplayMatches(
  existing: StoredArtifact,
  candidate: StoredArtifact,
): void {
  if (!artifactsMatch(existing, candidate)) throw new ArtifactConflictError();
}

export function assertArtifactScopeMatches(
  existing: StoredArtifact,
  candidate: StoredArtifact,
): void {
  if (
    existing.userId !== candidate.userId ||
    existing.documentId !== candidate.documentId ||
    existing.revision !== candidate.revision
  ) {
    throw new ArtifactConflictError();
  }
}

function runUpdateMatches(current: StoredAgentRun, update: UpdateRunInput): boolean {
  return UPDATE_FIELDS.every((field) => update[field] === undefined || update[field] === current[field]);
}

function assertRunTransition(current: StoredAgentRun, candidate: StoredAgentRun): void {
  if (!STATUS_TRANSITIONS[current.status].has(candidate.status)) {
    throw new InvalidAgentRunTransitionError(
      `Agent run cannot transition from ${current.status} to ${candidate.status}.`,
    );
  }
  if (
    current.workflowRunId !== null &&
    candidate.workflowRunId !== current.workflowRunId
  ) {
    throw new InvalidAgentRunTransitionError("Workflow run identity cannot be changed.");
  }
  if (candidate.workflowRunId !== null && candidate.workflowRunId.trim().length === 0) {
    throw new InvalidAgentRunTransitionError("Workflow run identity cannot be empty.");
  }
  if (
    current.resultRevision !== null &&
    (candidate.resultRevision === null || candidate.resultRevision < current.resultRevision)
  ) {
    throw new InvalidAgentRunTransitionError("Result revision cannot move backwards.");
  }
  if (
    candidate.resultRevision !== null &&
    candidate.resultRevision < candidate.baseRevision
  ) {
    throw new InvalidAgentRunTransitionError("Result revision cannot precede the base revision.");
  }

  const validCombination =
    (candidate.status === "queued" &&
      candidate.stage === "understanding" &&
      candidate.resultRevision === null &&
      candidate.errorMessage === null &&
      candidate.resultNote === null) ||
    (candidate.status === "running" &&
      ACTIVE_STAGES.has(candidate.stage) &&
      candidate.errorMessage === null &&
      candidate.resultNote === null) ||
    (candidate.status === "waiting_approval" &&
      candidate.stage === "needs_input" &&
      candidate.resultNote === null &&
      (candidate.errorMessage === null ||
        (candidate.errorMessage.trim().length > 0 &&
          candidate.errorMessage.length <= 500))) ||
    (candidate.status === "completed" &&
      candidate.stage === "ready" &&
      candidate.resultRevision !== null &&
      candidate.errorMessage === null &&
      (candidate.resultNote === null ||
        (candidate.resultNote.trim().length > 0 &&
          candidate.resultNote.length <= 1_000))) ||
    (candidate.status === "failed" &&
      candidate.stage === "failed" &&
      Boolean(candidate.errorMessage?.trim())) ||
    candidate.status === "cancelled";

  if (!validCombination) {
    throw new InvalidAgentRunTransitionError(
      `Stage ${candidate.stage} is inconsistent with status ${candidate.status}.`,
    );
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}
