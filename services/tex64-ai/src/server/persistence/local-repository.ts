import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  applyDocumentPatch,
  assertDocumentResourceBudget,
  type DocumentModel,
  type DocumentPatch,
} from "@/domain/document";
import {
  CanonicalSourceLocatorSchema,
  SourceRecordSchema,
  type SourceRecord,
} from "@/server/sources/schema";
import { parseResearchLedger } from "@/server/research";
import {
  artifactMatchesRelease,
  releaseBindingsMatch,
} from "@/server/artifacts/release";
import {
  assertDocumentCountWithinLimit,
  assertRevisionWithinLimit,
  assertSourceRecordCapacity,
  sourceRecordContentByteSize,
} from "./limits";
import {
  DEFAULT_DOCUMENT_PAGE_SIZE,
  DEFAULT_REVISION_PAGE_SIZE,
  DEFAULT_RUN_PAGE_SIZE,
  assertBatchSize,
  normalizeBatchIds,
  normalizeEventLimit,
  normalizePageRequest,
} from "./pagination";
import {
  AgentRunNotFoundError,
  ArtifactConflictError,
  DocumentNotFoundError,
  PendingDocumentActionConflictError,
  ResearchLedgerConflictError,
  RevisionConflictError,
  RunReplyConflictError,
  SourceRecordConflictError,
  type AppendRunEventInput,
  type CreateRunInput,
  type DocumentRepository,
  type StoredAgentRun,
  type StoredArtifact,
  type StoredDocument,
  type StoredDocumentAgentSession,
  type StoredDocumentListItem,
  type StoredPendingDocumentAction,
  type ResearchLedger,
  type StoredRevision,
  type StoredRevisionListItem,
  type StoredRunEvent,
  type UpdateRunInput,
  type WorkflowRunOwnership,
  type WorkflowStartClaim,
} from "./types";
import {
  assertDocumentAgentSessionReplyTarget,
  assertDocumentAgentSessionScope,
  classifyDocumentAgentSessionSave,
  parseStoredDocumentAgentSession,
} from "./document-agent-session";
import {
  assertArtifactReplayMatches,
  assertArtifactScopeMatches,
  assertDocumentCommitReplayMatches,
  assertRunEventReplayMatches,
  assertRunReplayMatches,
  prepareRunUpdate,
  runEventIdempotencyKey,
} from "./invariants";
import {
  assertPendingActionDraft,
  assertRunReplyTarget,
  assertStoredPendingAction,
  needsInputQuestion,
} from "./pending-actions";

type LocalStoreData = {
  version: 1;
  documents: Record<string, StoredDocument>;
  revisions: Record<string, StoredRevision>;
  runs: Record<string, StoredAgentRun>;
  events: Record<string, StoredRunEvent[]>;
  artifacts: Record<string, StoredArtifact>;
  pendingActions: Record<string, StoredPendingDocumentAction>;
  documentAgentSessions: Record<string, StoredDocumentAgentSession>;
  sourceRecords: Record<string, SourceRecord>;
  researchLedgers: Record<string, ResearchLedger>;
  workflowLaunchLeases: Record<string, LocalWorkflowLaunchLease>;
};

type LocalWorkflowLaunchLease = {
  userId: string;
  runId: string;
  token: string;
  expiresAt: string;
};

const EMPTY_STORE: LocalStoreData = {
  version: 1,
  documents: {},
  revisions: {},
  runs: {},
  events: {},
  artifacts: {},
  pendingActions: {},
  documentAgentSessions: {},
  sourceRecords: {},
  researchLedgers: {},
  workflowLaunchLeases: {},
};

const queueGlobal = globalThis as typeof globalThis & {
  __tex64LocalRepositoryQueues?: Map<string, Promise<void>>;
};
const repositoryQueues =
  (queueGlobal.__tex64LocalRepositoryQueues ??= new Map<string, Promise<void>>());

export class LocalDocumentRepository implements DocumentRepository {
  readonly filePath: string;

  constructor(filePath = path.join(process.env.TEX64_LOCAL_DATA_DIR ?? path.join(process.cwd(), ".data"), "store.json")) {
    this.filePath = path.resolve(filePath);
  }

  async listDocuments(
    userId: string,
    page?: Parameters<DocumentRepository["listDocuments"]>[1],
  ): Promise<StoredDocumentListItem[]> {
    const { limit, offset } = normalizePageRequest(
      page,
      DEFAULT_DOCUMENT_PAGE_SIZE,
    );
    const data = await this.readAfterWrites();
    return Object.values(data.documents)
      .filter((document) => document.userId === userId)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          right.id.localeCompare(left.id),
      )
      .slice(offset, offset + limit)
      .map(toDocumentListItem);
  }

  async createDocument(userId: string, document: DocumentModel): Promise<StoredDocument> {
    assertDocumentResourceBudget(document);
    return this.write(async (data) => {
      const now = new Date().toISOString();
      const id = document.id;
      const key = documentKey(userId, id);
      if (data.documents[key]) throw new Error("Document already exists.");
      assertDocumentCountWithinLimit(
        Object.values(data.documents).filter(
          (candidate) => candidate.userId === userId,
        ).length,
      );
      const stored: StoredDocument = {
        id,
        userId,
        title: document.metadata.title,
        document,
        currentRevision: 1,
        createdAt: now,
        updatedAt: now,
      };
      data.documents[key] = stored;
      data.revisions[revisionKey(userId, id, 1)] = {
        userId,
        documentId: id,
        commitId: randomUUID(),
        revision: 1,
        document,
        actor: "system",
        summary: "文書を作成",
        operations: [],
        createdAt: now,
      };
      return clone(stored);
    });
  }

  async getDocument(userId: string, documentId: string): Promise<StoredDocument | null> {
    const data = await this.readAfterWrites();
    const document = data.documents[documentKey(userId, documentId)];
    return document ? clone(document) : null;
  }

  async getDocumentAgentSession(
    userId: string,
    documentId: string,
  ): Promise<StoredDocumentAgentSession | null> {
    const data = await this.readAfterWrites();
    const stored = data.documentAgentSessions[documentKey(userId, documentId)];
    if (!stored) return null;
    const parsed = parseStoredDocumentAgentSession(clone(stored));
    assertDocumentAgentSessionScope(parsed, userId, documentId);
    return parsed;
  }

  async saveDocumentAgentSession(
    session: StoredDocumentAgentSession,
    expectedStateVersion: number | null,
  ): Promise<StoredDocumentAgentSession> {
    const candidate = parseStoredDocumentAgentSession(clone(session));
    assertDocumentAgentSessionScope(
      candidate,
      candidate.userId,
      candidate.documentId,
    );
    return this.write(async (data) => {
      const key = documentKey(candidate.userId, candidate.documentId);
      if (!data.documents[key]) throw new DocumentNotFoundError();
      const currentValue = data.documentAgentSessions[key];
      const current = currentValue
        ? parseStoredDocumentAgentSession(clone(currentValue))
        : null;
      if (current) {
        assertDocumentAgentSessionScope(
          current,
          candidate.userId,
          candidate.documentId,
        );
      }
      const disposition = classifyDocumentAgentSessionSave({
        current,
        candidate,
        expectedStateVersion,
      });
      if (disposition === "replay") return clone(current!);
      data.documentAgentSessions[key] = candidate;
      return clone(candidate);
    });
  }

  async saveDocumentAgentSessionForClarificationReply(
    session: StoredDocumentAgentSession,
    expectedStateVersion: number | null,
    binding: Parameters<
      DocumentRepository["saveDocumentAgentSessionForClarificationReply"]
    >[2],
  ): Promise<StoredDocumentAgentSession> {
    const candidate = parseStoredDocumentAgentSession(clone(session));
    assertDocumentAgentSessionScope(
      candidate,
      candidate.userId,
      candidate.documentId,
    );
    if (candidate.session.lastProcessedRunId !== binding.responseRunId) {
      throw new RunReplyConflictError(
        "Clarification session was not produced by the response run.",
      );
    }
    const activeQuestion = candidate.session.activeQuestionId
      ? candidate.session.questions.find(
          (question) => question.id === candidate.session.activeQuestionId,
        )
      : null;
    if (activeQuestion?.sourceRunId === binding.sourceRunId) {
      throw new RunReplyConflictError(
        "Clarification session still waits on the consumed question.",
      );
    }

    return this.write(async (data) => {
      const key = documentKey(candidate.userId, candidate.documentId);
      if (!data.documents[key]) throw new DocumentNotFoundError();
      const responseKey = runKey(candidate.userId, binding.responseRunId);
      const sourceKey = runKey(candidate.userId, binding.sourceRunId);
      const response = data.runs[responseKey];
      const source = data.runs[sourceKey];
      if (!response || !source) throw new AgentRunNotFoundError();
      assertReplyScope(
        response,
        source,
        candidate.documentId,
        binding.sourceRunId,
        null,
      );
      const markerKey = `${binding.responseRunId}:clarification-continuation:${binding.sourceRunId}`;
      const marker = (data.events[responseKey] ?? []).find(
        (event) => event.idempotencyKey === markerKey,
      );
      if (
        !marker ||
        marker.detail?.code !== "clarification_continuation" ||
        marker.detail?.sourceRunId !== binding.sourceRunId
      ) {
        throw new RunReplyConflictError(
          "Clarification response was not claimed before session save.",
        );
      }

      const currentValue = data.documentAgentSessions[key];
      const current = currentValue
        ? parseStoredDocumentAgentSession(clone(currentValue))
        : null;
      const disposition = classifyDocumentAgentSessionSave({
        current,
        candidate,
        expectedStateVersion,
      });
      if (disposition === "replay") {
        if (source.status !== "cancelled") {
          throw new RunReplyConflictError(
            "Clarification replay does not match a consumed source run.",
          );
        }
        return clone(current!);
      }
      if (
        response.status !== "running" ||
        source.status !== "waiting_approval" ||
        source.stage !== "needs_input"
      ) {
        throw new RunReplyConflictError(
          "Clarification source is no longer available for this response.",
        );
      }

      data.documentAgentSessions[key] = candidate;
      data.runs[sourceKey] = prepareRunUpdate(
        source,
        {
          expectedStateVersion: source.stateVersion,
          status: "cancelled",
        },
        new Date().toISOString(),
      );
      return clone(candidate);
    });
  }

  async getRevision(userId: string, documentId: string, revision: number): Promise<StoredRevision | null> {
    const data = await this.readAfterWrites();
    const stored = data.revisions[revisionKey(userId, documentId, revision)];
    return stored ? clone(stored) : null;
  }

  async listRevisions(
    userId: string,
    documentId: string,
    page?: Parameters<DocumentRepository["listRevisions"]>[2],
  ): Promise<StoredRevisionListItem[]> {
    const { limit, offset } = normalizePageRequest(
      page,
      DEFAULT_REVISION_PAGE_SIZE,
    );
    const data = await this.readAfterWrites();
    return Object.values(data.revisions)
      .filter((revision) => revision.userId === userId && revision.documentId === documentId)
      .sort((left, right) => right.revision - left.revision)
      .slice(offset, offset + limit)
      .map(toRevisionListItem);
  }

  async commitDocument(input: Parameters<DocumentRepository["commitDocument"]>[0]): Promise<StoredDocument> {
    assertDocumentResourceBudget(input.document);
    return this.write(async (data) => {
      const key = documentKey(input.userId, input.documentId);
      const current = data.documents[key];
      if (!current) throw new DocumentNotFoundError();
      const priorCommit = Object.values(data.revisions).find(
        (revision) =>
          revision.userId === input.userId &&
          revision.documentId === input.documentId &&
          revision.commitId === input.commitId,
      );
      if (priorCommit) {
        assertDocumentCommitReplayMatches(priorCommit, input);
        return clone(current);
      }
      assertRevisionWithinLimit(current.currentRevision);
      if (current.currentRevision !== input.expectedRevision) {
        throw new RevisionConflictError(input.expectedRevision, current.currentRevision);
      }
      if (input.document.id !== input.documentId) throw new Error("Document identity cannot be changed.");

      const nextRevision = current.currentRevision + 1;
      const now = new Date().toISOString();
      const updated: StoredDocument = {
        ...current,
        title: input.document.metadata.title,
        document: input.document,
        currentRevision: nextRevision,
        updatedAt: now,
      };
      data.documents[key] = updated;
      data.revisions[revisionKey(input.userId, input.documentId, nextRevision)] = {
        userId: input.userId,
        documentId: input.documentId,
        commitId: input.commitId,
        revision: nextRevision,
        document: input.document,
        actor: input.actor,
        summary: input.summary,
        operations: input.operations,
        createdAt: now,
      };
      return clone(updated);
    });
  }

  async createRun(input: CreateRunInput): Promise<StoredAgentRun> {
    return this.write(async (data) => {
      const existing = Object.values(data.runs).find(
        (run) =>
          run.userId === input.userId &&
          run.documentId === input.documentId &&
          run.idempotencyKey === input.idempotencyKey,
      );
      if (existing) {
        assertRunReplayMatches(existing, input);
        return clone(existing);
      }
      const sameId = data.runs[runKey(input.userId, input.id)];
      if (sameId) {
        throw new Error("Agent run identifier already exists.");
      }
      assertLocalRunReplyTarget(data, input);
      const document = data.documents[documentKey(input.userId, input.documentId)];
      if (!document) throw new DocumentNotFoundError();
      if (document.currentRevision !== input.baseRevision) {
        throw new RevisionConflictError(input.baseRevision, document.currentRevision);
      }

      const now = new Date().toISOString();
      const run: StoredAgentRun = {
        ...input,
        replyToRunId: input.replyToRunId ?? null,
        decision: input.decision ?? null,
        targetNodeId: input.targetNodeId ?? null,
        workflowRunId: null,
        status: "queued",
        stage: "understanding",
        resultRevision: null,
        artifactRelease: null,
        errorMessage: null,
        resultNote: null,
        stateVersion: 0,
        createdAt: now,
        updatedAt: now,
      };
      data.runs[runKey(input.userId, input.id)] = run;
      return clone(run);
    });
  }

  async validateRunReplyTarget(input: CreateRunInput): Promise<void> {
    const data = await this.readAfterWrites();
    const existing = Object.values(data.runs).find(
      (run) =>
        run.userId === input.userId &&
        run.documentId === input.documentId &&
        run.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      assertRunReplayMatches(existing, input);
      return;
    }
    assertLocalRunReplyTarget(data, input);
  }

  async claimRunForWorkflowStart(
    userId: string,
    runId: string,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<WorkflowStartClaim> {
    assertWorkflowLaunchLease(leaseToken, leaseDurationMs);
    return this.write(async (data) => {
      const key = runKey(userId, runId);
      const current = data.runs[key];
      if (!current) throw new AgentRunNotFoundError();
      if (
        current.workflowRunId !== null ||
        (current.status !== "queued" && current.status !== "running")
      ) {
        return { claimed: false, leaseExpiresAt: null, run: clone(current) };
      }

      const now = Date.now();
      const existingLease = data.workflowLaunchLeases[key];
      if (existingLease && Date.parse(existingLease.expiresAt) > now) {
        return {
          claimed: false,
          leaseExpiresAt: existingLease.expiresAt,
          run: clone(current),
        };
      }

      const lease: LocalWorkflowLaunchLease = {
        userId,
        runId,
        token: leaseToken,
        expiresAt: new Date(now + leaseDurationMs).toISOString(),
      };
      data.workflowLaunchLeases[key] = lease;
      return {
        claimed: true,
        leaseExpiresAt: lease.expiresAt,
        run: clone(current),
      };
    });
  }

  async releaseRunWorkflowStartClaim(
    userId: string,
    runId: string,
    leaseToken: string,
  ): Promise<boolean> {
    assertWorkflowLaunchLease(leaseToken, 1);
    return this.write(async (data) => {
      const key = runKey(userId, runId);
      if (!data.runs[key]) throw new AgentRunNotFoundError();
      const lease = data.workflowLaunchLeases[key];
      if (!lease || lease.token !== leaseToken) return false;
      delete data.workflowLaunchLeases[key];
      return true;
    });
  }

  async activateRunForWorkflow(
    userId: string,
    runId: string,
    workflowRunId: string,
  ): Promise<WorkflowRunOwnership> {
    return this.write(async (data) => {
      const key = runKey(userId, runId);
      const current = data.runs[key];
      if (!current) throw new AgentRunNotFoundError();
      if (current.workflowRunId === workflowRunId) {
        delete data.workflowLaunchLeases[key];
        return { owned: true, run: clone(current) };
      }
      if (
        current.workflowRunId !== null ||
        (current.status !== "queued" && current.status !== "running")
      ) {
        return { owned: false, run: clone(current) };
      }

      const activated = prepareRunUpdate(
        current,
        {
          expectedStateVersion: current.stateVersion,
          workflowRunId,
          status: "running",
          stage: current.status === "queued" ? "understanding" : current.stage,
        },
        new Date().toISOString(),
      );
      data.runs[key] = activated;
      delete data.workflowLaunchLeases[key];
      return { owned: true, run: clone(activated) };
    });
  }

  async getRun(userId: string, runId: string): Promise<StoredAgentRun | null> {
    const data = await this.readAfterWrites();
    const run = data.runs[runKey(userId, runId)];
    return run ? clone(run) : null;
  }

  async listRuns(
    userId: string,
    documentId: string,
    page?: Parameters<DocumentRepository["listRuns"]>[2],
  ): Promise<StoredAgentRun[]> {
    const { limit, offset } = normalizePageRequest(page, DEFAULT_RUN_PAGE_SIZE);
    const data = await this.readAfterWrites();
    return Object.values(data.runs)
      .filter((run) => run.userId === userId && run.documentId === documentId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      )
      .slice(offset, offset + limit)
      .map(clone);
  }

  async getCompletedRunForRevision(
    userId: string,
    documentId: string,
    revision: number,
  ): Promise<StoredAgentRun | null> {
    if (!Number.isSafeInteger(revision) || revision < 1) return null;
    const data = await this.readAfterWrites();
    const completed = Object.values(data.runs)
      .filter(
        (run) =>
          run.userId === userId &&
          run.documentId === documentId &&
          run.status === "completed" &&
          run.stage === "ready" &&
          run.resultRevision === revision &&
          run.artifactRelease !== null &&
          run.artifactRelease.revision === revision,
      )
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.id.localeCompare(left.id),
      )[0];
    return completed ? clone(completed) : null;
  }

  async updateRun(userId: string, runId: string, update: UpdateRunInput): Promise<StoredAgentRun> {
    return this.write(async (data) => {
      const key = runKey(userId, runId);
      const current = data.runs[key];
      if (!current) throw new AgentRunNotFoundError();
      const updated = prepareRunUpdate(current, update, new Date().toISOString());
      if (updated.stateVersion === current.stateVersion) return clone(updated);
      data.runs[key] = updated;
      return clone(updated);
    });
  }

  async appendRunEvent(input: AppendRunEventInput): Promise<StoredRunEvent> {
    return this.write(async (data) => {
      const key = runKey(input.userId, input.runId);
      if (!data.runs[key]) throw new AgentRunNotFoundError();
      const events = data.events[key] ?? [];
      const idempotencyKey = runEventIdempotencyKey(input);
      const existing = events.find((event) => event.idempotencyKey === idempotencyKey);
      if (existing) {
        assertRunEventReplayMatches(existing, input);
        return clone(existing);
      }
      const event: StoredRunEvent = {
        ...input,
        idempotencyKey,
        sequence: (events.at(-1)?.sequence ?? 0) + 1,
        createdAt: new Date().toISOString(),
      };
      events.push(event);
      data.events[key] = events;
      return clone(event);
    });
  }

  async listRunEvents(
    userId: string,
    runId: string,
    afterSequence = 0,
    limitValue?: number,
  ): Promise<StoredRunEvent[]> {
    const limit = normalizeEventLimit(limitValue);
    const data = await this.readAfterWrites();
    return (data.events[runKey(userId, runId)] ?? [])
      .filter((event) => event.sequence > afterSequence)
      .slice(0, limit)
      .map(clone);
  }

  async setRunNeedsInput(
    input: Parameters<DocumentRepository["setRunNeedsInput"]>[0],
  ): Promise<StoredAgentRun> {
    return this.write(async (data) => {
      const runKeyValue = runKey(input.userId, input.runId);
      const current = data.runs[runKeyValue];
      if (!current) throw new AgentRunNotFoundError();
      if (current.documentId !== input.documentId) {
        throw new RunReplyConflictError("Needs-input run is outside the document scope.");
      }
      const question = input.question.trim();
      if (!question || question.length > 500) {
        throw new RunReplyConflictError("Needs-input question is invalid.");
      }
      if (input.code === "approval_required" && !input.pendingAction) {
        throw new PendingDocumentActionConflictError(
          "Approval requires an exact pending document patch.",
        );
      }
      if (input.code === "clarification_required" && input.pendingAction) {
        throw new PendingDocumentActionConflictError(
          "Clarification cannot carry a destructive pending action.",
        );
      }

      const events = data.events[runKeyValue] ?? [];
      const eventKey = `${input.runId}:needs_input:primary`;
      const existingEvent = events.find(
        (event) => event.idempotencyKey === eventKey,
      );
      const actionKey = pendingActionKey(input.userId, input.runId);
      const existingAction = data.pendingActions[actionKey];
      const patch = input.pendingAction
        ? assertPendingActionDraft({
            documentId: input.documentId,
            draft: input.pendingAction,
          })
        : null;
      const expectedPatchBase = current.resultRevision ?? current.baseRevision;
      if (patch && patch.baseRevision !== expectedPatchBase) {
        throw new PendingDocumentActionConflictError(
          "Pending patch base does not match the run revision.",
        );
      }

      if (current.status === "waiting_approval") {
        if (
          current.stage !== "needs_input" ||
          current.errorMessage !== question ||
          (existingEvent !== undefined &&
            (existingEvent.detail?.code !== input.code ||
              existingEvent.detail?.question !== question))
        ) {
          throw new RunReplyConflictError(
            "Run is already waiting for a different response.",
          );
        }
        const replayedAt = new Date().toISOString();
        if (input.pendingAction && patch) {
          if (
            existingAction &&
            (assertStoredPendingAction(existingAction).status !== "pending" ||
              existingAction.id !== input.pendingAction.id ||
              existingAction.documentId !== input.documentId ||
              existingAction.sourceRunId !== input.runId ||
              existingAction.patchDigest !== input.pendingAction.patchDigest ||
              existingAction.summary !== input.pendingAction.summary ||
              existingAction.question !== question ||
              JSON.stringify(existingAction.patch) !== JSON.stringify(patch))
          ) {
            throw new PendingDocumentActionConflictError();
          }
          if (!existingAction) {
            data.pendingActions[actionKey] = createPendingAction({
              input,
              patch,
              question,
              now: replayedAt,
            });
          }
        } else if (existingAction) {
          throw new PendingDocumentActionConflictError();
        }
        if (!existingEvent) {
          events.push(createNeedsInputEvent({ input, question, events, now: replayedAt }));
          data.events[runKeyValue] = events;
        }
        return clone(current);
      }

      const now = new Date().toISOString();
      const updated = prepareRunUpdate(
        current,
        {
          expectedStateVersion: input.expectedStateVersion,
          status: "waiting_approval",
          stage: "needs_input",
          errorMessage: question,
        },
        now,
      );

      if (input.pendingAction && patch) {
        if (existingAction) throw new PendingDocumentActionConflictError();
        data.pendingActions[actionKey] = createPendingAction({
          input,
          patch,
          question,
          now,
        });
      }

      if (existingEvent) {
        throw new RunReplyConflictError("Needs-input event already exists.");
      }
      if (!input.pendingAction && existingAction) {
        throw new PendingDocumentActionConflictError();
      }
      events.push(createNeedsInputEvent({ input, question, events, now }));
      data.events[runKeyValue] = events;
      data.runs[runKeyValue] = updated;
      return clone(updated);
    });
  }

  async consumeClarificationReply(
    userId: string,
    documentId: string,
    responseRunId: string,
    sourceRunId: string,
  ) {
    return this.write(async (data) => {
      const responseKey = runKey(userId, responseRunId);
      const sourceKey = runKey(userId, sourceRunId);
      const response = data.runs[responseKey];
      const source = data.runs[sourceKey];
      if (!response || !source) throw new AgentRunNotFoundError();
      assertReplyScope(response, source, documentId, sourceRunId, null);

      const sourceEvents = data.events[sourceKey] ?? [];
      const question = needsInputQuestion(
        source,
        sourceEvents,
        "clarification_required",
      );
      if (!question) {
        throw new RunReplyConflictError("Source run is not awaiting clarification.");
      }

      const markerKey = `${responseRunId}:clarification-continuation:${sourceRunId}`;
      const responseEvents = data.events[responseKey] ?? [];
      const marker = responseEvents.find(
        (event) => event.idempotencyKey === markerKey,
      );
      if (marker) {
        if (
          marker.detail?.code !== "clarification_continuation" ||
          marker.detail?.sourceRunId !== sourceRunId ||
          !(
            source.status === "cancelled" ||
            (source.status === "waiting_approval" && source.stage === "needs_input")
          )
        ) {
          throw new RunReplyConflictError();
        }
        return { sourceRun: clone(source), question };
      }
      if (response.status !== "running") {
        throw new RunReplyConflictError("Clarification response is not active.");
      }
      if (source.status !== "waiting_approval" || source.stage !== "needs_input") {
        throw new RunReplyConflictError("Clarification was already consumed.");
      }

      const now = new Date().toISOString();
      responseEvents.push({
        userId,
        runId: responseRunId,
        idempotencyKey: markerKey,
        sequence: (responseEvents.at(-1)?.sequence ?? 0) + 1,
        stage: "understanding",
        message: "ご要望を整理しています",
        detail: {
          eventKey: markerKey,
          code: "clarification_continuation",
          sourceRunId,
        },
        createdAt: now,
      });
      data.events[responseKey] = responseEvents;
      return { sourceRun: clone(source), question };
    });
  }

  async resolvePendingDocumentDecision(
    userId: string,
    documentId: string,
    responseRunId: string,
    sourceRunId: string,
  ) {
    return this.write(async (data) => {
      const responseKey = runKey(userId, responseRunId);
      const sourceKey = runKey(userId, sourceRunId);
      const response = data.runs[responseKey];
      const source = data.runs[sourceKey];
      if (!response || !source) throw new AgentRunNotFoundError();
      if (!response.decision) {
        throw new RunReplyConflictError("A structured approval decision is required.");
      }
      assertReplyScope(
        response,
        source,
        documentId,
        sourceRunId,
        response.decision,
      );

      const actionKey = pendingActionKey(userId, sourceRunId);
      const actionValue = data.pendingActions[actionKey];
      if (!actionValue) throw new PendingDocumentActionConflictError();
      const action = assertStoredPendingAction(actionValue);
      if (
        action.userId !== userId ||
        action.documentId !== documentId ||
        action.sourceRunId !== sourceRunId
      ) {
        throw new PendingDocumentActionConflictError();
      }

      if (action.resolvedByRunId === responseRunId) {
        if (
          (action.status === "rejected" && response.decision !== "reject") ||
          ((action.status === "applied" || action.status === "cancelled") &&
            response.decision !== "approve")
        ) {
          throw new PendingDocumentActionConflictError(
            "Resolved action does not match the stored decision.",
          );
        }
        const healed = healResolvedLocalDecisionRuns({
          data,
          sourceKey,
          responseKey,
          source,
          response,
          action,
          now: new Date().toISOString(),
        });
        if (action.status === "applied" && action.appliedRevision !== null) {
          return { status: "applied" as const, revision: action.appliedRevision, action: clone(action) };
        }
        if (action.status === "rejected") {
          return { status: "rejected" as const, action: clone(action) };
        }
        if (action.status === "cancelled") {
          return {
            status: "stale" as const,
            action: clone(action),
            message: healed.response.errorMessage ?? "文書が更新されたため、この変更は適用しませんでした。",
          };
        }
      }
      const approvalQuestion = needsInputQuestion(
        source,
        data.events[sourceKey] ?? [],
        "approval_required",
      );
      if (
        action.status !== "pending" ||
        action.resolvedByRunId !== null ||
        response.status !== "running" ||
        source.status !== "waiting_approval" ||
        approvalQuestion === null ||
        approvalQuestion !== action.question
      ) {
        throw new PendingDocumentActionConflictError();
      }

      const now = new Date().toISOString();
      if (response.decision === "reject") {
        const rejected: StoredPendingDocumentAction = {
          ...action,
          status: "rejected",
          resolvedByRunId: responseRunId,
          updatedAt: now,
        };
        data.pendingActions[actionKey] = rejected;
        data.runs[sourceKey] = prepareRunUpdate(
          source,
          { expectedStateVersion: source.stateVersion, status: "cancelled" },
          now,
        );
        data.runs[responseKey] = prepareRunUpdate(
          response,
          { expectedStateVersion: response.stateVersion, status: "cancelled" },
          now,
        );
        return { status: "rejected" as const, action: clone(rejected) };
      }

      const documentKeyValue = documentKey(userId, documentId);
      const document = data.documents[documentKeyValue];
      if (!document) throw new DocumentNotFoundError();
      const priorCommit = Object.values(data.revisions).find(
        (revision) =>
          revision.userId === userId &&
          revision.documentId === documentId &&
          revision.commitId === action.patch.id,
      );
      if (priorCommit) {
        if (response.baseRevision !== action.baseRevision) {
          throw new PendingDocumentActionConflictError(
            "Approval run does not share the pending patch base revision.",
          );
        }
        assertPriorLocalPatchCommit(data, action, priorCommit);
        const applied: StoredPendingDocumentAction = {
          ...action,
          status: "applied",
          resolvedByRunId: responseRunId,
          appliedRevision: priorCommit.revision,
          updatedAt: now,
        };
        data.pendingActions[actionKey] = applied;
        healResolvedLocalDecisionRuns({
          data,
          sourceKey,
          responseKey,
          source,
          response,
          action: applied,
          now,
        });
        return {
          status: "applied" as const,
          revision: priorCommit.revision,
          action: clone(applied),
        };
      }
      if (
        document.currentRevision !== action.baseRevision ||
        response.baseRevision !== action.baseRevision
      ) {
        const message = "文書が更新されたため、この変更は適用しませんでした。";
        const cancelled: StoredPendingDocumentAction = {
          ...action,
          status: "cancelled",
          resolvedByRunId: responseRunId,
          updatedAt: now,
        };
        data.pendingActions[actionKey] = cancelled;
        data.runs[sourceKey] = prepareRunUpdate(
          source,
          { expectedStateVersion: source.stateVersion, status: "cancelled" },
          now,
        );
        data.runs[responseKey] = prepareRunUpdate(
          response,
          {
            expectedStateVersion: response.stateVersion,
            status: "failed",
            stage: "failed",
            errorMessage: message,
          },
          now,
        );
        return { status: "stale" as const, action: clone(cancelled), message };
      }

      const currentRevision = data.revisions[
        revisionKey(userId, documentId, document.currentRevision)
      ];
      if (!currentRevision) throw new DocumentNotFoundError();
      assertRevisionWithinLimit(document.currentRevision);
      const next = applyDocumentPatch(
        {
          revisionId: currentRevision.commitId,
          revision: currentRevision.revision,
          parentRevisionId: null,
          committedAt: currentRevision.createdAt,
          document: document.document,
        },
        action.patch,
      );
      const nextRevision = document.currentRevision + 1;
      const updatedDocument: StoredDocument = {
        ...document,
        title: next.document.metadata.title,
        document: next.document,
        currentRevision: nextRevision,
        updatedAt: now,
      };
      data.documents[documentKeyValue] = updatedDocument;
      data.revisions[revisionKey(userId, documentId, nextRevision)] = {
        userId,
        documentId,
        commitId: action.patch.id,
        revision: nextRevision,
        document: next.document,
        actor: "agent",
        summary: action.summary,
        operations: action.patch.operations,
        createdAt: now,
      };
      const applied: StoredPendingDocumentAction = {
        ...action,
        status: "applied",
        resolvedByRunId: responseRunId,
        appliedRevision: nextRevision,
        updatedAt: now,
      };
      data.pendingActions[actionKey] = applied;
      data.runs[sourceKey] = prepareRunUpdate(
        source,
        { expectedStateVersion: source.stateVersion, status: "cancelled" },
        now,
      );
      data.runs[responseKey] = prepareRunUpdate(
        response,
        {
          expectedStateVersion: response.stateVersion,
          status: "running",
          stage: "writing",
          resultRevision: nextRevision,
          errorMessage: null,
        },
        now,
      );
      return { status: "applied" as const, revision: nextRevision, action: clone(applied) };
    });
  }

  async getPendingDocumentAction(
    userId: string,
    sourceRunId: string,
  ): Promise<StoredPendingDocumentAction | null> {
    const data = await this.readAfterWrites();
    const action = data.pendingActions[pendingActionKey(userId, sourceRunId)];
    return action ? clone(assertStoredPendingAction(action)) : null;
  }

  async listPendingDocumentActions(
    userId: string,
    sourceRunIds: readonly string[],
  ): Promise<StoredPendingDocumentAction[]> {
    const ids = new Set(normalizeBatchIds(sourceRunIds));
    if (ids.size === 0) return [];
    const data = await this.readAfterWrites();
    return Object.values(data.pendingActions)
      .filter(
        (action) => action.userId === userId && ids.has(action.sourceRunId),
      )
      .map((action) => clone(assertStoredPendingAction(action)));
  }

  async completeRunForCurrentRevision(
    input: Parameters<DocumentRepository["completeRunForCurrentRevision"]>[0],
  ) {
    return this.write(async (data) => {
      const runKeyValue = runKey(input.userId, input.runId);
      const current = data.runs[runKeyValue];
      if (!current || current.documentId !== input.documentId) {
        throw new AgentRunNotFoundError();
      }

      const document = data.documents[
        documentKey(input.userId, input.documentId)
      ];
      if (!document) throw new DocumentNotFoundError();

      const eventInput: AppendRunEventInput = {
        userId: input.userId,
        runId: input.runId,
        stage: "ready",
        message: input.eventMessage,
        detail: { eventKey: input.eventKey },
      };
      const idempotencyKey = runEventIdempotencyKey(eventInput);
      const events = data.events[runKeyValue] ?? [];
      const existingEvent = events.find(
        (event) => event.idempotencyKey === idempotencyKey,
      );
      if (existingEvent) {
        assertRunEventReplayMatches(existingEvent, eventInput);
      }

      if (current.status !== "completed" && document.currentRevision !== input.revision) {
        throw new RevisionConflictError(
          input.revision,
          document.currentRevision,
        );
      }

      const artifact = data.artifacts[
        artifactKey(input.userId, input.documentId, input.revision)
      ];
      if (!artifact) {
        throw new Error("Document artifact metadata is unavailable.");
      }
      if (!artifactMatchesRelease(artifact, input.artifact)) {
        throw new ArtifactConflictError();
      }

      let completed = current;
      if (current.status === "completed") {
        if (
          current.stage !== "ready" ||
          current.resultRevision !== input.revision
        ) {
          throw new RevisionConflictError(
            input.revision,
            current.resultRevision ?? document.currentRevision,
          );
        }
        if (
          !current.artifactRelease ||
          !releaseBindingsMatch(current.artifactRelease, input.artifact)
        ) {
          throw new ArtifactConflictError();
        }
      } else {
        completed = {
          ...prepareRunUpdate(
            current,
            {
              expectedStateVersion: current.stateVersion,
              status: "completed",
              stage: "ready",
              resultRevision: input.revision,
              errorMessage: null,
              resultNote: input.resultNote ?? null,
            },
            new Date().toISOString(),
          ),
          artifactRelease: clone(input.artifact),
        };
        data.runs[runKeyValue] = completed;
      }

      let readyEvent = existingEvent;
      if (!readyEvent) {
        readyEvent = {
          ...eventInput,
          idempotencyKey,
          sequence: (events.at(-1)?.sequence ?? 0) + 1,
          createdAt: new Date().toISOString(),
        };
        events.push(readyEvent);
        data.events[runKeyValue] = events;
      }

      return {
        run: clone(completed),
        artifact: clone(artifact),
        event: clone(readyEvent),
      };
    });
  }

  async saveArtifact(artifact: StoredArtifact): Promise<void> {
    await this.write(async (data) => {
      const key = artifactKey(artifact.userId, artifact.documentId, artifact.revision);
      const existing = data.artifacts[key];
      if (existing) {
        assertArtifactReplayMatches(existing, artifact);
        return;
      }
      if (!data.revisions[revisionKey(artifact.userId, artifact.documentId, artifact.revision)]) {
        throw new DocumentNotFoundError();
      }
      data.artifacts[key] = clone(artifact);
    });
  }

  async replaceArtifact(
    expected: StoredArtifact,
    replacement: StoredArtifact,
  ): Promise<StoredArtifact> {
    return this.write(async (data) => {
      assertArtifactScopeMatches(expected, replacement);
      const key = artifactKey(
        expected.userId,
        expected.documentId,
        expected.revision,
      );
      const current = data.artifacts[key];
      if (!current) throw new DocumentNotFoundError();
      try {
        assertArtifactReplayMatches(current, replacement);
        return clone(current);
      } catch {
        assertArtifactReplayMatches(current, expected);
      }
      data.artifacts[key] = clone(replacement);
      return clone(replacement);
    });
  }

  async getArtifact(userId: string, documentId: string, revision: number): Promise<StoredArtifact | null> {
    const data = await this.readAfterWrites();
    const artifact = data.artifacts[artifactKey(userId, documentId, revision)];
    return artifact ? clone(artifact) : null;
  }

  async listArtifactsForRevisions(
    userId: string,
    revisions: readonly { documentId: string; revision: number }[],
  ): Promise<StoredArtifact[]> {
    assertBatchSize(revisions);
    if (
      revisions.some(
        (item) => !Number.isSafeInteger(item.revision) || item.revision < 1,
      )
    ) {
      throw new Error("Artifact revision batch is invalid.");
    }
    const data = await this.readAfterWrites();
    return revisions.flatMap(({ documentId, revision }) => {
      const artifact = data.artifacts[artifactKey(userId, documentId, revision)];
      return artifact ? [clone(artifact)] : [];
    });
  }

  async saveSourceRecord(record: SourceRecord): Promise<SourceRecord> {
    const requested = SourceRecordSchema.parse(record);
    return this.write((data) => {
      if (
        !data.documents[
          documentKey(requested.userId, requested.documentId)
        ]
      ) {
        throw new DocumentNotFoundError();
      }

      const existingForLocator = Object.values(data.sourceRecords).find(
        (candidate) =>
          candidate.userId === requested.userId &&
          candidate.documentId === requested.documentId &&
          candidate.canonicalLocator === requested.canonicalLocator,
      );
      if (existingForLocator) {
        return SourceRecordSchema.parse(clone(existingForLocator));
      }

      const key = sourceRecordKey(requested.userId, requested.id);
      if (data.sourceRecords[key]) throw new SourceRecordConflictError();

      const documentSources = Object.values(data.sourceRecords)
        .filter(
          (candidate) =>
            candidate.userId === requested.userId &&
            candidate.documentId === requested.documentId,
        )
        .map((candidate) => SourceRecordSchema.parse(candidate));
      assertSourceRecordCapacity({
        currentCount: documentSources.length,
        currentContentBytes: documentSources.reduce(
          (total, candidate) => total + sourceRecordContentByteSize(candidate),
          0,
        ),
        incomingContentBytes: sourceRecordContentByteSize(requested),
      });

      data.sourceRecords[key] = clone(requested);
      return clone(requested);
    });
  }

  async getSourceRecord(
    userId: string,
    documentId: string,
    sourceId: string,
  ): Promise<SourceRecord | null> {
    const data = await this.readAfterWrites();
    const source = data.sourceRecords[sourceRecordKey(userId, sourceId)];
    if (!source || source.documentId !== documentId) return null;
    return SourceRecordSchema.parse(clone(source));
  }

  async getSourceRecordByLocator(
    userId: string,
    documentId: string,
    canonicalLocator: string,
  ): Promise<SourceRecord | null> {
    const locator = CanonicalSourceLocatorSchema.parse(canonicalLocator);
    const data = await this.readAfterWrites();
    const source = Object.values(data.sourceRecords).find(
      (candidate) =>
        candidate.userId === userId &&
        candidate.documentId === documentId &&
        candidate.canonicalLocator === locator,
    );
    return source ? SourceRecordSchema.parse(clone(source)) : null;
  }

  async listSourceRecordsByIds(
    userId: string,
    documentId: string,
    sourceIds: readonly string[],
  ): Promise<SourceRecord[]> {
    assertBatchSize(sourceIds);
    const ids = normalizeBatchIds(sourceIds);
    const data = await this.readAfterWrites();
    return ids.flatMap((sourceId) => {
      const source = data.sourceRecords[sourceRecordKey(userId, sourceId)];
      return source && source.documentId === documentId
        ? [SourceRecordSchema.parse(clone(source))]
        : [];
    });
  }

  async saveResearchLedger(ledger: ResearchLedger): Promise<ResearchLedger> {
    const requested = parseResearchLedger(clone(ledger));
    return this.write((data) => {
      if (!data.documents[documentKey(requested.userId, requested.documentId)]) {
        throw new DocumentNotFoundError();
      }
      if (
        !data.revisions[
          revisionKey(
            requested.userId,
            requested.documentId,
            requested.target.documentRevision,
          )
        ] ||
        !data.runs[runKey(requested.userId, requested.authoringRunId)]
      ) {
        throw new ResearchLedgerConflictError();
      }

      const key = researchLedgerKey(requested.userId, requested.id);
      const existing = data.researchLedgers[key];
      if (existing) {
        const parsed = parseResearchLedger(clone(existing));
        if (parsed.ledgerDigest !== requested.ledgerDigest) {
          throw new ResearchLedgerConflictError();
        }
        return parsed;
      }

      const targetCollision = Object.values(data.researchLedgers).find(
        (candidate) =>
          candidate.userId === requested.userId &&
          candidate.documentId === requested.documentId &&
          candidate.authoringRunId === requested.authoringRunId &&
          candidate.target.documentRevision === requested.target.documentRevision &&
          candidate.target.documentDigest === requested.target.documentDigest &&
          candidate.target.briefDigest === requested.target.briefDigest &&
          candidate.target.planDigest === requested.target.planDigest &&
          candidate.target.sourceSnapshotDigest ===
            requested.target.sourceSnapshotDigest &&
          candidate.reviewer.reviewRunId === requested.reviewer.reviewRunId,
      );
      if (targetCollision) throw new ResearchLedgerConflictError();

      data.researchLedgers[key] = clone(requested);
      return clone(requested);
    });
  }

  async getResearchLedger(
    userId: string,
    documentId: string,
    ledgerId: string,
  ): Promise<ResearchLedger | null> {
    const data = await this.readAfterWrites();
    const ledger = data.researchLedgers[researchLedgerKey(userId, ledgerId)];
    if (!ledger || ledger.documentId !== documentId) return null;
    return parseResearchLedger(clone(ledger));
  }

  private async readAfterWrites(): Promise<LocalStoreData> {
    await (repositoryQueues.get(this.filePath) ?? Promise.resolve()).catch(() => undefined);
    return this.read();
  }

  private async write<T>(mutate: (data: LocalStoreData) => Promise<T> | T): Promise<T> {
    const prior = repositoryQueues.get(this.filePath) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(async () => {
      const data = await this.read();
      const result = await mutate(data);
      await this.persist(data);
      return result;
    });
    repositoryQueues.set(this.filePath, operation.then(() => undefined, () => undefined));
    return operation;
  }

  private async read(): Promise<LocalStoreData> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as LocalStoreData;
      if (parsed.version !== 1) throw new Error("Unsupported local store version.");
      normalizeLegacyStore(parsed);
      return parsed;
    } catch (error) {
      if (isMissingFile(error)) return clone(EMPTY_STORE);
      throw error;
    }
  }

  private async persist(data: LocalStoreData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}

function toDocumentListItem(
  stored: StoredDocument,
): StoredDocumentListItem {
  return {
    id: stored.id,
    userId: stored.userId,
    title: stored.title,
    documentType: stored.document.metadata.documentType,
    hasContent: stored.document.root.length > 0,
    preview: localDocumentPreview(stored.document),
    currentRevision: stored.currentRevision,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

function toRevisionListItem(
  stored: StoredRevision,
): StoredRevisionListItem {
  return {
    userId: stored.userId,
    documentId: stored.documentId,
    revision: stored.revision,
    actor: stored.actor,
    summary: stored.summary,
    createdAt: stored.createdAt,
  };
}

function localDocumentPreview(document: DocumentModel): string {
  for (const node of document.nodes) {
    if (node.type !== "paragraph" && node.type !== "callout") continue;
    const text = node.content
      .map((item) =>
        item.type === "text" ? item.text : item.type === "hardBreak" ? "\n" : "",
      )
      .join("")
      .trim();
    if (text) return text.slice(0, 120);
  }
  return "文書の作成を始めます。";
}

function normalizeLegacyStore(data: LocalStoreData): void {
  data.pendingActions ??= {};
  data.documentAgentSessions ??= {};
  data.sourceRecords ??= {};
  data.researchLedgers ??= {};
  data.workflowLaunchLeases ??= {};
  for (const [key, value] of Object.entries(data.researchLedgers)) {
    const ledger = parseResearchLedger(value);
    if (key !== researchLedgerKey(ledger.userId, ledger.id)) {
      throw new Error("Stored research review key is invalid.");
    }
    data.researchLedgers[key] = ledger;
  }
  for (const [key, value] of Object.entries(data.documentAgentSessions)) {
    const stored = parseStoredDocumentAgentSession(value);
    if (key !== documentKey(stored.userId, stored.documentId)) {
      throw new Error("Stored document agent session key is invalid.");
    }
    data.documentAgentSessions[key] = stored;
  }
  for (const run of Object.values(data.runs)) {
    run.stateVersion ??= 0;
    run.replyToRunId ??= null;
    run.decision ??= null;
    run.artifactRelease ??= null;
    run.resultNote ??= null;
    run.targetNodeId ??= null;
  }
  for (const artifact of Object.values(data.artifacts)) {
    artifact.pageCount ??= null;
    artifact.qualityVersion ??= 0;
  }
  for (const events of Object.values(data.events)) {
    for (const event of events) {
      event.idempotencyKey ??=
        typeof event.detail?.eventKey === "string"
          ? event.detail.eventKey
          : `legacy:${event.runId}:${event.sequence}`;
    }
  }
}

function assertWorkflowLaunchLease(token: string, durationMs: number): void {
  if (!token.trim() || token.length > 200) {
    throw new Error("Workflow launch lease token is invalid.");
  }
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 300_000) {
    throw new Error("Workflow launch lease duration is invalid.");
  }
}

function assertLocalRunReplyTarget(
  data: LocalStoreData,
  input: CreateRunInput,
): void {
  const storedSession = data.documentAgentSessions[
    documentKey(input.userId, input.documentId)
  ];
  const session = storedSession
    ? parseStoredDocumentAgentSession(clone(storedSession))
    : null;
  if (session) {
    assertDocumentAgentSessionScope(session, input.userId, input.documentId);
  }
  assertDocumentAgentSessionReplyTarget(session, input);

  const source = input.replyToRunId
    ? data.runs[runKey(input.userId, input.replyToRunId)] ?? null
    : null;
  const activeResponse = input.replyToRunId
    ? Object.values(data.runs).find(
        (candidate) =>
          candidate.userId === input.userId &&
          candidate.documentId === input.documentId &&
          candidate.replyToRunId === input.replyToRunId &&
          candidate.id !== input.id &&
          new Set(["queued", "running", "waiting_approval"]).has(
            candidate.status,
          ),
      ) ?? null
    : null;
  assertRunReplyTarget({
    request: input,
    source,
    events: source ? (data.events[runKey(input.userId, source.id)] ?? []) : [],
    pendingAction: source
      ? data.pendingActions[pendingActionKey(input.userId, source.id)] ?? null
      : null,
    activeResponse,
  });
}

function documentKey(userId: string, documentId: string): string {
  return `${userId}:${documentId}`;
}

function revisionKey(userId: string, documentId: string, revision: number): string {
  return `${documentKey(userId, documentId)}:${revision}`;
}

function runKey(userId: string, runId: string): string {
  return `${userId}:${runId}`;
}

function pendingActionKey(userId: string, sourceRunId: string): string {
  return `${userId}:${sourceRunId}`;
}

function sourceRecordKey(userId: string, sourceId: string): string {
  return `${userId}:${sourceId}`;
}

function researchLedgerKey(userId: string, ledgerId: string): string {
  return `${userId}:${ledgerId}`;
}

function createPendingAction(inputValue: {
  input: Parameters<DocumentRepository["setRunNeedsInput"]>[0];
  patch: DocumentPatch;
  question: string;
  now: string;
}): StoredPendingDocumentAction {
  const draft = inputValue.input.pendingAction;
  if (!draft) throw new PendingDocumentActionConflictError();
  return {
    id: draft.id,
    userId: inputValue.input.userId,
    documentId: inputValue.input.documentId,
    sourceRunId: inputValue.input.runId,
    status: "pending",
    baseRevision: inputValue.patch.baseRevision,
    patch: inputValue.patch,
    patchDigest: draft.patchDigest,
    summary: draft.summary,
    question: inputValue.question,
    resolvedByRunId: null,
    appliedRevision: null,
    createdAt: inputValue.now,
    updatedAt: inputValue.now,
  };
}

function createNeedsInputEvent(inputValue: {
  input: Parameters<DocumentRepository["setRunNeedsInput"]>[0];
  question: string;
  events: readonly StoredRunEvent[];
  now: string;
}): StoredRunEvent {
  const eventKey = `${inputValue.input.runId}:needs_input:primary`;
  return {
    userId: inputValue.input.userId,
    runId: inputValue.input.runId,
    idempotencyKey: eventKey,
    sequence: (inputValue.events.at(-1)?.sequence ?? 0) + 1,
    stage: "needs_input",
    message: "確認したいことがあります",
    detail: {
      eventKey,
      code: inputValue.input.code,
      question: inputValue.question,
      ...(inputValue.input.pendingAction
        ? {
            pendingActionId: inputValue.input.pendingAction.id,
            patchDigest: inputValue.input.pendingAction.patchDigest,
          }
        : {}),
    },
    createdAt: inputValue.now,
  };
}

function healResolvedLocalDecisionRuns(input: {
  data: LocalStoreData;
  sourceKey: string;
  responseKey: string;
  source: StoredAgentRun;
  response: StoredAgentRun;
  action: StoredPendingDocumentAction;
  now: string;
}): { source: StoredAgentRun; response: StoredAgentRun } {
  const source =
    input.source.status === "cancelled"
      ? input.source
      : prepareRunUpdate(
          input.source,
          {
            expectedStateVersion: input.source.stateVersion,
            status: "cancelled",
          },
          input.now,
        );
  let response: StoredAgentRun;
  if (input.action.status === "applied" && input.action.appliedRevision !== null) {
    if (input.response.status === "completed") {
      if (input.response.resultRevision !== input.action.appliedRevision) {
        throw new PendingDocumentActionConflictError(
          "Completed decision run points to a different revision.",
        );
      }
      response = input.response;
    } else {
      if (input.response.status === "cancelled" || input.response.status === "failed") {
        throw new PendingDocumentActionConflictError(
          "Applied decision run is terminal with another outcome.",
        );
      }
      if (
        input.response.resultRevision !== null &&
        input.response.resultRevision !== input.action.appliedRevision
      ) {
        throw new PendingDocumentActionConflictError(
          "Decision run points to a different document revision.",
        );
      }
      response = prepareRunUpdate(
        input.response,
        {
          expectedStateVersion: input.response.stateVersion,
          status: "running",
          stage: "writing",
          resultRevision: input.action.appliedRevision,
          errorMessage: null,
        },
        input.now,
      );
    }
  } else if (input.action.status === "rejected") {
    response =
      input.response.status === "cancelled"
        ? input.response
        : prepareRunUpdate(
            input.response,
            {
              expectedStateVersion: input.response.stateVersion,
              status: "cancelled",
            },
            input.now,
          );
  } else if (input.action.status === "cancelled") {
    const message =
      input.response.errorMessage ??
      "文書が更新されたため、この変更は適用しませんでした。";
    if (input.response.status === "failed") {
      if (input.response.stage !== "failed") {
        throw new PendingDocumentActionConflictError();
      }
      response = input.response;
    } else {
      if (input.response.status === "completed" || input.response.status === "cancelled") {
        throw new PendingDocumentActionConflictError(
          "Stale decision run is terminal with another outcome.",
        );
      }
      response = prepareRunUpdate(
        input.response,
        {
          expectedStateVersion: input.response.stateVersion,
          status: "failed",
          stage: "failed",
          errorMessage: message,
        },
        input.now,
      );
    }
  } else {
    throw new PendingDocumentActionConflictError();
  }
  input.data.runs[input.sourceKey] = source;
  input.data.runs[input.responseKey] = response;
  return { source, response };
}

function assertPriorLocalPatchCommit(
  data: LocalStoreData,
  action: StoredPendingDocumentAction,
  priorCommit: StoredRevision,
): void {
  const base = data.revisions[
    revisionKey(action.userId, action.documentId, action.baseRevision)
  ];
  if (!base) throw new DocumentNotFoundError();
  const expected = applyDocumentPatch(
    {
      revisionId: base.commitId,
      revision: base.revision,
      parentRevisionId: null,
      committedAt: base.createdAt,
      document: base.document,
    },
    action.patch,
  );
  if (
    priorCommit.revision !== action.baseRevision + 1 ||
    priorCommit.actor !== "agent" ||
    priorCommit.summary !== action.summary ||
    canonicalJson(priorCommit.operations) !== canonicalJson(action.patch.operations) ||
    canonicalJson(priorCommit.document) !== canonicalJson(expected.document)
  ) {
    throw new PendingDocumentActionConflictError(
      "Existing patch commit does not match the pending action.",
    );
  }
}

function assertReplyScope(
  response: StoredAgentRun,
  source: StoredAgentRun,
  documentId: string,
  sourceRunId: string,
  decision: StoredAgentRun["decision"],
): void {
  if (
    response.id === source.id ||
    response.userId !== source.userId ||
    response.documentId !== documentId ||
    source.documentId !== documentId ||
    response.replyToRunId !== sourceRunId ||
    response.decision !== decision ||
    source.createdAt > response.createdAt
  ) {
    throw new RunReplyConflictError();
  }
}

function artifactKey(userId: string, documentId: string, revision: number): string {
  return `${documentKey(userId, documentId)}:${revision}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
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

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
