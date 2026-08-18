import type {
  DocumentModel,
  DocumentOperation,
} from "@/domain/document";
import type { SourceRecord } from "@/server/sources/schema";

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

/**
 * "waiting_approval" is the historical name of the awaiting-input status. It
 * now only ever means "waiting for the user's answer to a question"
 * (request_input / review clarifications); the approval flow itself was
 * removed. The literal is kept so stored runs remain readable.
 */
export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";


/**
 * Coarse lifecycle marker for one turn. The conversation itself carries what
 * happened; this only distinguishes "in flight" from "finished".
 */
export type AgentRunStage = "writing" | "ready" | "failed";

export type StoredAgentRun = {
  id: string;
  userId: string;
  documentId: string;
  prompt: string;
  /**
   * Document node this turn's request is scoped to (PDF element selection).
   * Advisory context for the agent; never shown in user-facing copy.
   */
  targetNodeId: string | null;
  idempotencyKey: string;
  status: AgentRunStatus;
  stage: AgentRunStage;
  baseRevision: number;
  resultRevision: number | null;
  /**
   * Exact PDF accepted by this turn. Null means that no artifact is published,
   * including turns that only answered a question.
   */
  artifactRelease: ArtifactReleaseBinding | null;
  errorMessage: string | null;
  /** Sanitized closing message from the agent, stored on completed turns. */
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

/**
 * One entry of the model-visible conversation for a document. `content` holds
 * an AI SDK ModelMessage content payload verbatim (text parts, tool calls,
 * tool results) so a turn can be resumed by replaying the thread as-is.
 */
export type StoredConversationMessage = {
  userId: string;
  documentId: string;
  sequence: number;
  /** Turn (agent run) that produced this message. */
  turnId: string;
  role: "user" | "assistant" | "tool";
  content: unknown;
  createdAt: string;
};

export type AppendConversationMessagesInput = {
  userId: string;
  documentId: string;
  turnId: string;
  messages: readonly { role: StoredConversationMessage["role"]; content: unknown }[];
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

export type CreateRunInput = Pick<
  StoredAgentRun,
  "id" | "userId" | "documentId" | "prompt" | "idempotencyKey" | "baseRevision"
> & {
  replyToRunId?: string | null;
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




export type UpdateRunInput = Partial<
  Pick<
    StoredAgentRun,
    "status" | "stage" | "resultRevision" | "errorMessage" | "resultNote"
  >
> & {
  /**
   * Optional compare-and-swap token. Callers that read a run before updating it
   * can prevent a stale writer from replacing newer state.
   */
  expectedStateVersion?: number;
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
  getRevision(userId: string, documentId: string, revision: number): Promise<StoredRevision | null>;
  listRevisions(
    userId: string,
    documentId: string,
    page?: ListPageRequest,
  ): Promise<StoredRevisionListItem[]>;
  commitDocument(input: CommitDocumentInput): Promise<StoredDocument>;
  createRun(input: CreateRunInput): Promise<StoredAgentRun>;
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
  /** Appends one turn's messages; returns them with their assigned sequence. */
  appendConversationMessages(
    input: AppendConversationMessagesInput,
  ): Promise<StoredConversationMessage[]>;
  /** Chronological conversation tail, oldest first. */
  listConversationMessages(
    userId: string,
    documentId: string,
    limit?: number,
  ): Promise<StoredConversationMessage[]>;
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

