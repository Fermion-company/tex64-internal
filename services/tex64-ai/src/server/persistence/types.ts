import type {
  DocumentModel,
  DocumentOperation,
  DocumentPatch,
} from "@/domain/document";
import type { StoredDocumentAgentSession } from "@/domain/brief";
import type { ResearchLedger } from "@/server/research/schema";
import type { SourceRecord } from "@/server/sources/schema";

export type { StoredDocumentAgentSession } from "@/domain/brief";
export type { ResearchLedger } from "@/server/research/schema";
export type { SourceRecord } from "@/server/sources/schema";

export type RevisionActor = "user" | "agent" | "system";

export type StoredDocument = {
  id: string;
  userId: string;
  title: string;
  document: DocumentModel;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * Bounded projection used by document indexes. Keeping the document JSON out
 * of list queries prevents a page of large manuscripts from being loaded just
 * to render titles and status.
 */
export type StoredDocumentListItem = {
  id: string;
  userId: string;
  title: string;
  documentType: DocumentModel["metadata"]["documentType"];
  hasContent: boolean;
  preview: string;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
};

export type StoredRevision = {
  userId: string;
  documentId: string;
  commitId: string;
  revision: number;
  document: DocumentModel;
  actor: RevisionActor;
  summary: string;
  operations: DocumentOperation[];
  createdAt: string;
};

/** Metadata-only revision projection for version history. */
export type StoredRevisionListItem = Pick<
  StoredRevision,
  "userId" | "documentId" | "revision" | "actor" | "summary" | "createdAt"
>;

export type AgentRunStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export type RunDecision = "approve" | "reject";
export type NeedsInputCode = "clarification_required" | "approval_required";

export type AgentRunStage =
  | "understanding"
  | "planning"
  | "writing"
  | "checking"
  | "formatting"
  | "ready"
  | "needs_input"
  | "failed";

export type StoredAgentRun = {
  id: string;
  userId: string;
  documentId: string;
  prompt: string;
  replyToRunId: string | null;
  decision: RunDecision | null;
  /**
   * Document node this run's request is scoped to (PDF/element selection).
   * Advisory context for the agent prompt; never shown in user-facing copy.
   */
  targetNodeId: string | null;
  idempotencyKey: string;
  workflowRunId: string | null;
  status: AgentRunStatus;
  stage: AgentRunStage;
  baseRevision: number;
  resultRevision: number | null;
  /**
   * Exact PDF accepted by this run. Null means that no artifact is published,
   * including legacy completed runs created before release binding existed.
   */
  artifactRelease: ArtifactReleaseBinding | null;
  errorMessage: string | null;
  /**
   * Sanitized closing message from the agent for a completed run. Null for
   * runs completed before this field existed and for non-completed runs.
   */
  resultNote: string | null;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type StoredRunEvent = {
  userId: string;
  runId: string;
  idempotencyKey: string;
  sequence: number;
  stage: AgentRunStage;
  message: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

export type StoredArtifact = {
  userId: string;
  documentId: string;
  revision: number;
  storageKey: string;
  sha256: string;
  byteSize: number;
  compileDurationMs: number;
  /** Null only for artifacts created before rendered-page inspection existed. */
  pageCount: number | null;
  /** Old rows use zero and must be recompiled before reuse. */
  qualityVersion: number;
  createdAt: string;
};

/** Content identity atomically attached to a completed run at publication. */
export type ArtifactReleaseBinding = Pick<
  StoredArtifact,
  | "revision"
  | "storageKey"
  | "sha256"
  | "byteSize"
  | "qualityVersion"
> & {
  /** A release can only bind an artifact whose rendered pages were inspected. */
  pageCount: number;
};

export type PendingDocumentActionStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "cancelled";

export type StoredPendingDocumentAction = {
  id: string;
  userId: string;
  documentId: string;
  sourceRunId: string;
  status: PendingDocumentActionStatus;
  baseRevision: number;
  patch: DocumentPatch;
  patchDigest: string;
  summary: string;
  question: string;
  resolvedByRunId: string | null;
  appliedRevision: number | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateRunInput = Pick<
  StoredAgentRun,
  "id" | "userId" | "documentId" | "prompt" | "idempotencyKey" | "baseRevision"
> & {
  replyToRunId?: string | null;
  decision?: RunDecision | null;
  targetNodeId?: string | null;
};

export type ListPageRequest = {
  limit?: number;
  offset?: number;
};

export type CommitDocumentInput = {
  commitId: string;
  userId: string;
  documentId: string;
  expectedRevision: number;
  document: DocumentModel;
  actor: RevisionActor;
  summary: string;
  operations: DocumentOperation[];
};

export type PendingDocumentActionDraft = Pick<
  StoredPendingDocumentAction,
  "id" | "patch" | "patchDigest" | "summary"
>;

export type SetRunNeedsInputInput = {
  userId: string;
  documentId: string;
  runId: string;
  expectedStateVersion: number;
  code: NeedsInputCode;
  question: string;
  pendingAction?: PendingDocumentActionDraft;
};

export type ClarificationReplyResult = {
  sourceRun: StoredAgentRun;
  question: string;
};

export type ClarificationSessionSaveBinding = {
  responseRunId: string;
  sourceRunId: string;
};

export type PendingDocumentDecisionResult =
  | {
      status: "applied";
      revision: number;
      action: StoredPendingDocumentAction;
    }
  | {
      status: "rejected";
      action: StoredPendingDocumentAction;
    }
  | {
      status: "stale";
      action: StoredPendingDocumentAction;
      message: string;
    };

export type UpdateRunInput = Partial<
  Pick<
    StoredAgentRun,
    "workflowRunId" | "status" | "stage" | "resultRevision" | "errorMessage" | "resultNote"
  >
> & {
  /**
   * Optional compare-and-swap token. Callers that read a run before updating it
   * can prevent a stale writer from replacing newer state.
   */
  expectedStateVersion?: number;
};

export type WorkflowStartClaim = {
  /** True only for the caller holding the unexpired launch lease. */
  claimed: boolean;
  leaseExpiresAt: string | null;
  run: StoredAgentRun;
};

export type WorkflowRunOwnership = {
  /** True only for the durable workflow allowed to perform paid work. */
  owned: boolean;
  run: StoredAgentRun;
};

export type CompleteRunForCurrentRevisionInput = {
  userId: string;
  documentId: string;
  runId: string;
  revision: number;
  artifact: ArtifactReleaseBinding;
  eventKey: string;
  eventMessage: string;
  /** Already-sanitized closing message to store on the completed run. */
  resultNote?: string | null;
};

export type CompleteRunForCurrentRevisionResult = {
  run: StoredAgentRun;
  artifact: StoredArtifact;
  event: StoredRunEvent;
};

type RunEventPayload = Pick<StoredRunEvent, "userId" | "runId" | "stage" | "message" | "detail">;

/**
 * Events must carry a stable retry key. Existing workflow callers put that key
 * in detail.eventKey; other callers can provide it explicitly.
 */
export type AppendRunEventInput = RunEventPayload &
  (
    | { idempotencyKey: string }
    | {
        idempotencyKey?: undefined;
        detail: Record<string, unknown> & { eventKey: string };
      }
  );

export interface DocumentRepository {
  listDocuments(
    userId: string,
    page?: ListPageRequest,
  ): Promise<StoredDocumentListItem[]>;
  createDocument(userId: string, document: DocumentModel): Promise<StoredDocument>;
  getDocument(userId: string, documentId: string): Promise<StoredDocument | null>;
  getDocumentAgentSession(
    userId: string,
    documentId: string,
  ): Promise<StoredDocumentAgentSession | null>;
  /**
   * Persists the next session snapshot. `null` creates version zero; later
   * writes compare against the supplied version and advance it by one.
   * Replaying a non-null `lastProcessedRunId` returns the first saved result.
   */
  saveDocumentAgentSession(
    session: StoredDocumentAgentSession,
    expectedStateVersion: number | null,
  ): Promise<StoredDocumentAgentSession>;
  /** Atomically saves an answered session and consumes its source question. */
  saveDocumentAgentSessionForClarificationReply(
    session: StoredDocumentAgentSession,
    expectedStateVersion: number | null,
    binding: ClarificationSessionSaveBinding,
  ): Promise<StoredDocumentAgentSession>;
  getRevision(userId: string, documentId: string, revision: number): Promise<StoredRevision | null>;
  listRevisions(
    userId: string,
    documentId: string,
    page?: ListPageRequest,
  ): Promise<StoredRevisionListItem[]>;
  commitDocument(input: CommitDocumentInput): Promise<StoredDocument>;
  createRun(input: CreateRunInput): Promise<StoredAgentRun>;
  validateRunReplyTarget(input: CreateRunInput): Promise<void>;
  claimRunForWorkflowStart(
    userId: string,
    runId: string,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<WorkflowStartClaim>;
  releaseRunWorkflowStartClaim(
    userId: string,
    runId: string,
    leaseToken: string,
  ): Promise<boolean>;
  activateRunForWorkflow(
    userId: string,
    runId: string,
    workflowRunId: string,
  ): Promise<WorkflowRunOwnership>;
  getRun(userId: string, runId: string): Promise<StoredAgentRun | null>;
  listRuns(
    userId: string,
    documentId: string,
    page?: ListPageRequest,
  ): Promise<StoredAgentRun[]>;
  /** Returns completion evidence for one exact rendered revision. */
  getCompletedRunForRevision(
    userId: string,
    documentId: string,
    revision: number,
  ): Promise<StoredAgentRun | null>;
  updateRun(userId: string, runId: string, update: UpdateRunInput): Promise<StoredAgentRun>;
  appendRunEvent(input: AppendRunEventInput): Promise<StoredRunEvent>;
  listRunEvents(
    userId: string,
    runId: string,
    afterSequence?: number,
    limit?: number,
  ): Promise<StoredRunEvent[]>;
  setRunNeedsInput(input: SetRunNeedsInputInput): Promise<StoredAgentRun>;
  consumeClarificationReply(
    userId: string,
    documentId: string,
    responseRunId: string,
    sourceRunId: string,
  ): Promise<ClarificationReplyResult>;
  resolvePendingDocumentDecision(
    userId: string,
    documentId: string,
    responseRunId: string,
    sourceRunId: string,
  ): Promise<PendingDocumentDecisionResult>;
  getPendingDocumentAction(
    userId: string,
    sourceRunId: string,
  ): Promise<StoredPendingDocumentAction | null>;
  listPendingDocumentActions(
    userId: string,
    sourceRunIds: readonly string[],
  ): Promise<StoredPendingDocumentAction[]>;
  completeRunForCurrentRevision(
    input: CompleteRunForCurrentRevisionInput,
  ): Promise<CompleteRunForCurrentRevisionResult>;
  saveArtifact(artifact: StoredArtifact): Promise<void>;
  replaceArtifact(
    expected: StoredArtifact,
    replacement: StoredArtifact,
  ): Promise<StoredArtifact>;
  getArtifact(userId: string, documentId: string, revision: number): Promise<StoredArtifact | null>;
  listArtifactsForRevisions(
    userId: string,
    revisions: readonly { documentId: string; revision: number }[],
  ): Promise<StoredArtifact[]>;
  saveSourceRecord(record: SourceRecord): Promise<SourceRecord>;
  getSourceRecord(
    userId: string,
    documentId: string,
    sourceId: string,
  ): Promise<SourceRecord | null>;
  getSourceRecordByLocator(
    userId: string,
    documentId: string,
    canonicalLocator: string,
  ): Promise<SourceRecord | null>;
  listSourceRecordsByIds(
    userId: string,
    documentId: string,
    sourceIds: readonly string[],
  ): Promise<SourceRecord[]>;
  saveResearchLedger(ledger: ResearchLedger): Promise<ResearchLedger>;
  getResearchLedger(
    userId: string,
    documentId: string,
    ledgerId: string,
  ): Promise<ResearchLedger | null>;
}

export class DocumentNotFoundError extends Error {
  constructor() {
    super("Document not found.");
    this.name = "DocumentNotFoundError";
  }
}

export class RevisionConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`Revision conflict: expected ${expectedRevision}, current ${actualRevision}.`);
    this.name = "RevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class AgentRunNotFoundError extends Error {
  constructor() {
    super("Agent run not found.");
    this.name = "AgentRunNotFoundError";
  }
}

export class IdempotencyConflictError extends Error {
  readonly resource: "agent_run" | "run_event" | "document_commit";
  readonly idempotencyKey: string;

  constructor(
    resource: "agent_run" | "run_event" | "document_commit",
    idempotencyKey: string,
  ) {
    super(`Idempotency key was reused with different ${resource} content.`);
    this.name = "IdempotencyConflictError";
    this.resource = resource;
    this.idempotencyKey = idempotencyKey;
  }
}

export class AgentRunConflictError extends Error {
  readonly expectedStateVersion: number;
  readonly actualStateVersion: number;

  constructor(expectedStateVersion: number, actualStateVersion: number) {
    super(
      `Agent run state conflict: expected version ${expectedStateVersion}, current ${actualStateVersion}.`,
    );
    this.name = "AgentRunConflictError";
    this.expectedStateVersion = expectedStateVersion;
    this.actualStateVersion = actualStateVersion;
  }
}

export class DocumentAgentSessionConflictError extends Error {
  readonly expectedStateVersion: number | null;
  readonly actualStateVersion: number | null;

  constructor(
    expectedStateVersion: number | null,
    actualStateVersion: number | null,
  ) {
    super(
      `Document agent session state conflict: expected version ${expectedStateVersion ?? "none"}, current ${actualStateVersion ?? "none"}.`,
    );
    this.name = "DocumentAgentSessionConflictError";
    this.expectedStateVersion = expectedStateVersion;
    this.actualStateVersion = actualStateVersion;
  }
}

export class InvalidAgentRunTransitionError extends Error {
  constructor(message = "Invalid agent run state transition.") {
    super(message);
    this.name = "InvalidAgentRunTransitionError";
  }
}

export class ArtifactConflictError extends Error {
  constructor() {
    super("Artifact metadata is immutable for a document revision.");
    this.name = "ArtifactConflictError";
  }
}

export class RunReplyConflictError extends Error {
  constructor(message = "The run reply cannot be applied to the requested source run.") {
    super(message);
    this.name = "RunReplyConflictError";
  }
}

export class PendingDocumentActionConflictError extends Error {
  constructor(message = "The pending document action no longer matches this decision.") {
    super(message);
    this.name = "PendingDocumentActionConflictError";
  }
}

export class ResourceLimitExceededError extends Error {
  readonly resource: "documents" | "revisions" | "sources" | "source_content";

  constructor(resource: "documents" | "revisions" | "sources" | "source_content") {
    super(`The ${resource} resource limit has been reached.`);
    this.name = "ResourceLimitExceededError";
    this.resource = resource;
  }
}

export class SourceRecordConflictError extends Error {
  constructor() {
    super("The source identifier is already bound to another source record.");
    this.name = "SourceRecordConflictError";
  }
}

export class ResearchLedgerConflictError extends Error {
  constructor() {
    super("The research review identifier is already bound to another immutable result.");
    this.name = "ResearchLedgerConflictError";
  }
}
