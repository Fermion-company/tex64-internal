import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import {
  assertDocumentResourceBudget,
  type DocumentModel,
  type DocumentOperation,
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
  ResearchLedgerConflictError,
  RevisionConflictError,
  RunReplyConflictError,
  SourceRecordConflictError,
  type AgentRunStage,
  type AgentRunStatus,
  type AppendRunEventInput,
  type CreateRunInput,
  type DocumentRepository,
  type ResearchLedger,
  type RevisionActor,
  type StoredAgentRun,
  type StoredArtifact,
  type StoredDocument,
  type StoredDocumentAgentSession,
  type StoredDocumentListItem,
  type StoredRevision,
  type StoredRevisionListItem,
  type StoredRunEvent,
  type UpdateRunInput,
  type WorkflowRunOwnership,
  type WorkflowStartClaim,
} from "./types";
import {
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
  assertRunReplyTarget,
  needsInputQuestion,
} from "./pending-actions";

type DocumentRow = QueryResultRow & {
  id: string;
  user_id: string;
  title: string;
  document: DocumentModel;
  current_revision: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type DocumentListRow = QueryResultRow & {
  id: string;
  user_id: string;
  title: string;
  document_type: string | null;
  has_content: boolean;
  preview: string;
  current_revision: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type DocumentAgentSessionRow = QueryResultRow & {
  user_id: string;
  document_id: string;
  session: unknown;
  state_version: number;
  updated_at: Date | string;
};

type RevisionRow = QueryResultRow & {
  user_id: string;
  document_id: string;
  commit_id: string;
  revision: number;
  document: DocumentModel;
  actor: RevisionActor;
  summary: string;
  operations: DocumentOperation[];
  created_at: Date | string;
};

type RevisionListRow = QueryResultRow & {
  user_id: string;
  document_id: string;
  revision: number;
  actor: RevisionActor;
  summary: string;
  created_at: Date | string;
};

type RunRow = QueryResultRow & {
  id: string;
  user_id: string;
  document_id: string;
  prompt: string;
  reply_to_run_id: string | null;
  target_node_id: string | null;
  idempotency_key: string;
  workflow_run_id: string | null;
  status: AgentRunStatus;
  stage: AgentRunStage;
  base_revision: number;
  result_revision: number | null;
  result_artifact_revision: number | null;
  result_artifact_storage_key: string | null;
  result_artifact_sha256: string | null;
  result_artifact_byte_size: number | null;
  result_artifact_page_count: number | null;
  result_artifact_quality_version: number | null;
  error_message: string | null;
  result_note: string | null;
  state_version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type EventRow = QueryResultRow & {
  user_id: string;
  run_id: string;
  idempotency_key: string;
  sequence: number;
  stage: AgentRunStage;
  message: string;
  detail: Record<string, unknown> | null;
  created_at: Date | string;
};

type ArtifactRow = QueryResultRow & {
  user_id: string;
  document_id: string;
  revision: number;
  storage_key: string;
  sha256: string;
  byte_size: number;
  compile_duration_ms: number;
  page_count: number | null;
  quality_version: number;
  created_at: Date | string;
};

type WorkflowLaunchLeaseRow = QueryResultRow & {
  expires_at: Date | string;
};

type SourceRecordRow = QueryResultRow & {
  id: string;
  user_id: string;
  document_id: string;
  kind: SourceRecord["kind"];
  canonical_locator: string;
  resolved_locator: string;
  verification: SourceRecord["verification"];
  evidence_scope: SourceRecord["evidenceScope"];
  content_text: string | null;
  content_sha256: string | null;
  metadata: SourceRecord["metadata"];
  fetched_at: Date | string;
};

type ResearchLedgerRow = QueryResultRow & {
  id: string;
  user_id: string;
  document_id: string;
  authoring_run_id: string;
  document_revision: number;
  ledger_digest: string;
  ledger: unknown;
  created_at: Date | string;
};

export class PostgresDocumentRepository implements DocumentRepository {
  private readonly pool: Pool;

  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL persistence.");
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async listDocuments(
    userId: string,
    page?: Parameters<DocumentRepository["listDocuments"]>[1],
  ): Promise<StoredDocumentListItem[]> {
    const { limit, offset } = normalizePageRequest(
      page,
      DEFAULT_DOCUMENT_PAGE_SIZE,
    );
    return this.withUser(userId, async (client) => {
      const result = await client.query<DocumentListRow>(
        `SELECT document_row.id,
                document_row.user_id,
                document_row.title,
                document_row.document #>> '{metadata,documentType}' AS document_type,
                COALESCE(jsonb_array_length(document_row.document -> 'root') > 0, false)
                  AS has_content,
                COALESCE(
                  (
                    SELECT left(btrim(inline_item.value ->> 'text'), 120)
                    FROM jsonb_array_elements(
                      COALESCE(document_row.document -> 'nodes', '[]'::jsonb)
                    ) AS document_node(value)
                    CROSS JOIN LATERAL jsonb_array_elements(
                      COALESCE(document_node.value -> 'content', '[]'::jsonb)
                    ) AS inline_item(value)
                    WHERE document_node.value ->> 'type' IN ('paragraph', 'callout')
                      AND inline_item.value ->> 'type' = 'text'
                      AND btrim(inline_item.value ->> 'text') <> ''
                    LIMIT 1
                  ),
                  '文書の作成を始めます。'
                ) AS preview,
                document_row.current_revision,
                document_row.created_at,
                document_row.updated_at
         FROM public.tex64_documents AS document_row
         WHERE document_row.user_id = $1
         ORDER BY document_row.updated_at DESC, document_row.id DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );
      return result.rows.map(toDocumentListItem);
    });
  }

  async createDocument(userId: string, document: DocumentModel): Promise<StoredDocument> {
    assertDocumentResourceBudget(document);
    return this.withUser(userId, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(141507, hashtext($1))",
        [userId],
      );
      const count = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM public.tex64_documents
         WHERE user_id = $1`,
        [userId],
      );
      assertDocumentCountWithinLimit(count.rows[0]?.count ?? 0);
      const inserted = await client.query<DocumentRow>(
        `INSERT INTO public.tex64_documents (id, user_id, title, document, current_revision)
         VALUES ($1, $2, $3, $4::jsonb, 1)
         RETURNING *`,
        [document.id, userId, document.metadata.title, JSON.stringify(document)],
      );
      await client.query(
        `INSERT INTO public.tex64_document_revisions
          (user_id, document_id, commit_id, revision, document, actor, summary, operations)
         VALUES ($1, $2, $3, 1, $4::jsonb, 'system', $5, '[]'::jsonb)`,
        [userId, document.id, randomUUID(), JSON.stringify(document), "文書を作成"],
      );
      return toDocument(inserted.rows[0] as DocumentRow);
    });
  }

  async getDocument(userId: string, documentId: string): Promise<StoredDocument | null> {
    return this.withUser(userId, async (client) => {
      const result = await client.query<DocumentRow>(
        "SELECT * FROM public.tex64_documents WHERE id = $1 AND user_id = $2",
        [documentId, userId],
      );
      return result.rows[0] ? toDocument(result.rows[0]) : null;
    });
  }

  async getDocumentAgentSession(
    userId: string,
    documentId: string,
  ): Promise<StoredDocumentAgentSession | null> {
    return this.withUser(userId, async (client) => {
      const result = await client.query<DocumentAgentSessionRow>(
        `SELECT user_id, document_id, session, state_version, updated_at
         FROM public.tex64_document_agent_sessions
         WHERE user_id = $1 AND document_id = $2`,
        [userId, documentId],
      );
      return result.rows[0] ? toDocumentAgentSession(result.rows[0]) : null;
    });
  }

  async saveDocumentAgentSession(
    session: StoredDocumentAgentSession,
    expectedStateVersion: number | null,
  ): Promise<StoredDocumentAgentSession> {
    const candidate = parseStoredDocumentAgentSession(session);
    assertDocumentAgentSessionScope(
      candidate,
      candidate.userId,
      candidate.documentId,
    );
    return this.withUser(candidate.userId, async (client) => {
      // The parent row serializes both the first insert and later CAS updates.
      const document = await client.query<{ id: string }>(
        `SELECT id FROM public.tex64_documents
         WHERE user_id = $1 AND id = $2
         FOR UPDATE`,
        [candidate.userId, candidate.documentId],
      );
      if (!document.rows[0]) throw new DocumentNotFoundError();

      const selected = await client.query<DocumentAgentSessionRow>(
        `SELECT user_id, document_id, session, state_version, updated_at
         FROM public.tex64_document_agent_sessions
         WHERE user_id = $1 AND document_id = $2
         FOR UPDATE`,
        [candidate.userId, candidate.documentId],
      );
      const current = selected.rows[0]
        ? toDocumentAgentSession(selected.rows[0])
        : null;
      const disposition = classifyDocumentAgentSessionSave({
        current,
        candidate,
        expectedStateVersion,
      });
      if (disposition === "replay") return current!;

      if (disposition === "create") {
        const inserted = await client.query<DocumentAgentSessionRow>(
          `INSERT INTO public.tex64_document_agent_sessions
            (user_id, document_id, session, state_version, updated_at)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           RETURNING user_id, document_id, session, state_version, updated_at`,
          [
            candidate.userId,
            candidate.documentId,
            JSON.stringify(candidate.session),
            candidate.stateVersion,
            candidate.updatedAt,
          ],
        );
        return toDocumentAgentSession(
          inserted.rows[0] as DocumentAgentSessionRow,
        );
      }

      const updated = await client.query<DocumentAgentSessionRow>(
        `UPDATE public.tex64_document_agent_sessions
         SET session = $3::jsonb,
             state_version = $4,
             updated_at = $5
         WHERE user_id = $1
           AND document_id = $2
           AND state_version = $6
         RETURNING user_id, document_id, session, state_version, updated_at`,
        [
          candidate.userId,
          candidate.documentId,
          JSON.stringify(candidate.session),
          candidate.stateVersion,
          candidate.updatedAt,
          expectedStateVersion,
        ],
      );
      if (!updated.rows[0]) {
        throw new Error(
          "Document agent session changed while applying a compare-and-swap update.",
        );
      }
      return toDocumentAgentSession(updated.rows[0]);
    });
  }

  async saveDocumentAgentSessionForClarificationReply(
    session: StoredDocumentAgentSession,
    expectedStateVersion: number | null,
    binding: Parameters<
      DocumentRepository["saveDocumentAgentSessionForClarificationReply"]
    >[2],
  ): Promise<StoredDocumentAgentSession> {
    const candidate = parseStoredDocumentAgentSession(session);
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

    return this.withUser(candidate.userId, async (client) => {
      const runs = await lockRuns(
        client,
        candidate.userId,
        binding.responseRunId,
        binding.sourceRunId,
      );
      const response = runs.get(binding.responseRunId);
      const source = runs.get(binding.sourceRunId);
      if (!response || !source) throw new AgentRunNotFoundError();
      assertReplyScope(
        response,
        source,
        candidate.documentId,
        binding.sourceRunId,
      );
      const markerKey = `${binding.responseRunId}:clarification-continuation:${binding.sourceRunId}`;
      const markerResult = await client.query<EventRow>(
        `SELECT * FROM public.tex64_run_events
         WHERE user_id = $1 AND run_id = $2 AND idempotency_key = $3`,
        [candidate.userId, binding.responseRunId, markerKey],
      );
      const marker = markerResult.rows[0] ? toEvent(markerResult.rows[0]) : null;
      if (
        !marker ||
        marker.detail?.code !== "clarification_continuation" ||
        marker.detail?.sourceRunId !== binding.sourceRunId
      ) {
        throw new RunReplyConflictError(
          "Clarification response was not claimed before session save.",
        );
      }

      const document = await client.query<{ id: string }>(
        `SELECT id FROM public.tex64_documents
         WHERE user_id = $1 AND id = $2
         FOR UPDATE`,
        [candidate.userId, candidate.documentId],
      );
      if (!document.rows[0]) throw new DocumentNotFoundError();
      const selected = await client.query<DocumentAgentSessionRow>(
        `SELECT user_id, document_id, session, state_version, updated_at
         FROM public.tex64_document_agent_sessions
         WHERE user_id = $1 AND document_id = $2
         FOR UPDATE`,
        [candidate.userId, candidate.documentId],
      );
      const current = selected.rows[0]
        ? toDocumentAgentSession(selected.rows[0])
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
        return current!;
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

      let saved: StoredDocumentAgentSession;
      if (disposition === "create") {
        const inserted = await client.query<DocumentAgentSessionRow>(
          `INSERT INTO public.tex64_document_agent_sessions
            (user_id, document_id, session, state_version, updated_at)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           RETURNING user_id, document_id, session, state_version, updated_at`,
          [
            candidate.userId,
            candidate.documentId,
            JSON.stringify(candidate.session),
            candidate.stateVersion,
            candidate.updatedAt,
          ],
        );
        saved = toDocumentAgentSession(
          inserted.rows[0] as DocumentAgentSessionRow,
        );
      } else {
        const updated = await client.query<DocumentAgentSessionRow>(
          `UPDATE public.tex64_document_agent_sessions
           SET session = $3::jsonb,
               state_version = $4,
               updated_at = $5
           WHERE user_id = $1
             AND document_id = $2
             AND state_version = $6
           RETURNING user_id, document_id, session, state_version, updated_at`,
          [
            candidate.userId,
            candidate.documentId,
            JSON.stringify(candidate.session),
            candidate.stateVersion,
            candidate.updatedAt,
            expectedStateVersion,
          ],
        );
        if (!updated.rows[0]) {
          throw new Error(
            "Document agent session changed while applying a clarification reply.",
          );
        }
        saved = toDocumentAgentSession(updated.rows[0]);
      }

      const cancelled = prepareRunUpdate(
        source,
        { expectedStateVersion: source.stateVersion, status: "cancelled" },
        new Date().toISOString(),
      );
      await updateRunRecord(client, source, cancelled);
      return saved;
    });
  }

  async getRevision(userId: string, documentId: string, revision: number): Promise<StoredRevision | null> {
    return this.withUser(userId, async (client) => {
      const result = await client.query<RevisionRow>(
        "SELECT * FROM public.tex64_document_revisions WHERE document_id = $1 AND revision = $2 AND user_id = $3",
        [documentId, revision, userId],
      );
      return result.rows[0] ? toRevision(result.rows[0]) : null;
    });
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
    return this.withUser(userId, async (client) => {
      const result = await client.query<RevisionListRow>(
        `SELECT user_id, document_id, revision, actor, summary, created_at
         FROM public.tex64_document_revisions
         WHERE document_id = $1 AND user_id = $2
         ORDER BY revision DESC
         LIMIT $3 OFFSET $4`,
        [documentId, userId, limit, offset],
      );
      return result.rows.map(toRevisionListItem);
    });
  }

  async commitDocument(input: Parameters<DocumentRepository["commitDocument"]>[0]): Promise<StoredDocument> {
    assertDocumentResourceBudget(input.document);
    return this.withUser(input.userId, async (client) => {
      const current = await client.query<DocumentRow>(
        "SELECT * FROM public.tex64_documents WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [input.documentId, input.userId],
      );
      const row = current.rows[0];
      if (!row) throw new DocumentNotFoundError();
      const priorCommit = await client.query<RevisionRow>(
        "SELECT * FROM public.tex64_document_revisions WHERE document_id = $1 AND commit_id = $2 AND user_id = $3",
        [input.documentId, input.commitId, input.userId],
      );
      if (priorCommit.rows[0]) {
        assertDocumentCommitReplayMatches(toRevision(priorCommit.rows[0]), input);
        return toDocument(row);
      }
      assertRevisionWithinLimit(row.current_revision);
      if (row.current_revision !== input.expectedRevision) {
        throw new RevisionConflictError(input.expectedRevision, row.current_revision);
      }
      if (input.document.id !== input.documentId) throw new Error("Document identity cannot be changed.");

      const nextRevision = row.current_revision + 1;
      await client.query(
        `INSERT INTO public.tex64_document_revisions
          (user_id, document_id, commit_id, revision, document, actor, summary, operations)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb)`,
        [
          input.userId,
          input.documentId,
          input.commitId,
          nextRevision,
          JSON.stringify(input.document),
          input.actor,
          input.summary,
          JSON.stringify(input.operations),
        ],
      );
      const updated = await client.query<DocumentRow>(
        `UPDATE public.tex64_documents
         SET title = $2, document = $3::jsonb, current_revision = $4, updated_at = now()
         WHERE id = $1 AND current_revision = $5 AND user_id = $6
         RETURNING *`,
        [
          input.documentId,
          input.document.metadata.title,
          JSON.stringify(input.document),
          nextRevision,
          input.expectedRevision,
          input.userId,
        ],
      );
      if (!updated.rows[0]) throw new RevisionConflictError(input.expectedRevision, row.current_revision);
      return toDocument(updated.rows[0]);
    });
  }

  async createRun(input: CreateRunInput): Promise<StoredAgentRun> {
    return this.withUser(input.userId, async (client) => {
      const existing = await client.query<RunRow>(
        `SELECT * FROM public.tex64_agent_runs
         WHERE user_id = $1 AND document_id = $2 AND idempotency_key = $3
         FOR UPDATE`,
        [input.userId, input.documentId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const run = toRun(existing.rows[0]);
        assertRunReplayMatches(run, input);
        return run;
      }

      const sameId = await client.query<RunRow>(
        "SELECT * FROM public.tex64_agent_runs WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [input.id, input.userId],
      );
      if (sameId.rows[0]) throw new Error("Agent run identifier already exists.");
      await assertPostgresRunReplyTarget(client, input, "UPDATE");

      const document = await client.query<{ current_revision: number }>(
        `SELECT current_revision FROM public.tex64_documents
         WHERE id = $1 AND user_id = $2 FOR SHARE`,
        [input.documentId, input.userId],
      );
      const currentRevision = document.rows[0]?.current_revision;
      if (currentRevision === undefined) throw new DocumentNotFoundError();
      if (currentRevision !== input.baseRevision) {
        throw new RevisionConflictError(input.baseRevision, currentRevision);
      }

      const inserted = await client.query<RunRow>(
        `INSERT INTO public.tex64_agent_runs
          (id, user_id, document_id, prompt, reply_to_run_id,
           target_node_id, idempotency_key, base_revision)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          input.id,
          input.userId,
          input.documentId,
          input.prompt,
          input.replyToRunId ?? null,
          input.targetNodeId ?? null,
          input.idempotencyKey,
          input.baseRevision,
        ],
      );
      if (inserted.rows[0]) return toRun(inserted.rows[0]);

      // A concurrent request may have won the unique idempotency-key insert.
      const raced = await client.query<RunRow>(
        `SELECT * FROM public.tex64_agent_runs
         WHERE user_id = $1 AND document_id = $2 AND idempotency_key = $3
         FOR UPDATE`,
        [input.userId, input.documentId, input.idempotencyKey],
      );
      if (!raced.rows[0]) throw new Error("Agent run identifier already exists.");
      const run = toRun(raced.rows[0]);
      assertRunReplayMatches(run, input);
      return run;
    });
  }

  async validateRunReplyTarget(input: CreateRunInput): Promise<void> {
    await this.withUser(input.userId, async (client) => {
      const existing = await client.query<RunRow>(
        `SELECT * FROM public.tex64_agent_runs
         WHERE user_id = $1 AND document_id = $2 AND idempotency_key = $3
         FOR SHARE`,
        [input.userId, input.documentId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        assertRunReplayMatches(toRun(existing.rows[0]), input);
        return;
      }
      await assertPostgresRunReplyTarget(client, input, "SHARE");
    });
  }

  async claimRunForWorkflowStart(
    userId: string,
    runId: string,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<WorkflowStartClaim> {
    assertWorkflowLaunchLease(leaseToken, leaseDurationMs);
    return this.withUser(userId, async (client) => {
      const selected = await client.query<RunRow>(
        `SELECT * FROM public.tex64_agent_runs
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [runId, userId],
      );
      if (!selected.rows[0]) throw new AgentRunNotFoundError();
      const run = toRun(selected.rows[0]);
      if (
        run.workflowRunId !== null ||
        (run.status !== "queued" && run.status !== "running")
      ) {
        return { claimed: false, leaseExpiresAt: null, run };
      }

      const claimed = await client.query<WorkflowLaunchLeaseRow>(
        `INSERT INTO public.tex64_workflow_launch_leases
          (user_id, run_id, lease_token, expires_at)
         VALUES ($1, $2, $3, now() + ($4 * interval '1 millisecond'))
         ON CONFLICT (user_id, run_id) DO UPDATE
           SET lease_token = EXCLUDED.lease_token,
               expires_at = EXCLUDED.expires_at,
               updated_at = now()
           WHERE public.tex64_workflow_launch_leases.expires_at <= now()
         RETURNING expires_at`,
        [userId, runId, leaseToken, leaseDurationMs],
      );
      return {
        claimed: Boolean(claimed.rows[0]),
        leaseExpiresAt: claimed.rows[0]
          ? toIso(claimed.rows[0].expires_at)
          : null,
        run,
      };
    });
  }

  async releaseRunWorkflowStartClaim(
    userId: string,
    runId: string,
    leaseToken: string,
  ): Promise<boolean> {
    assertWorkflowLaunchLease(leaseToken, 1);
    return this.withUser(userId, async (client) => {
      const released = await client.query(
        `DELETE FROM public.tex64_workflow_launch_leases
         WHERE user_id = $1 AND run_id = $2 AND lease_token = $3
         RETURNING run_id`,
        [userId, runId, leaseToken],
      );
      return (released.rowCount ?? 0) > 0;
    });
  }

  async activateRunForWorkflow(
    userId: string,
    runId: string,
    workflowRunId: string,
  ): Promise<WorkflowRunOwnership> {
    return this.withUser(userId, async (client) => {
      const activated = await client.query<RunRow>(
        `UPDATE public.tex64_agent_runs
         SET workflow_run_id = $3,
             status = 'running',
             stage = CASE WHEN status = 'queued' THEN 'understanding' ELSE stage END,
             state_version = state_version + 1,
             updated_at = now()
         WHERE id = $1
           AND user_id = $2
           AND workflow_run_id IS NULL
           AND status IN ('queued', 'running')
         RETURNING *`,
        [runId, userId, workflowRunId],
      );
      if (activated.rows[0]) {
        await deleteWorkflowLaunchLease(client, userId, runId);
        return { owned: true, run: toRun(activated.rows[0]) };
      }

      const current = await client.query<RunRow>(
        "SELECT * FROM public.tex64_agent_runs WHERE id = $1 AND user_id = $2",
        [runId, userId],
      );
      if (!current.rows[0]) throw new AgentRunNotFoundError();
      const run = toRun(current.rows[0]);
      const owned = run.workflowRunId === workflowRunId;
      if (owned) await deleteWorkflowLaunchLease(client, userId, runId);
      return { owned, run };
    });
  }

  async getRun(userId: string, runId: string): Promise<StoredAgentRun | null> {
    return this.withUser(userId, async (client) => {
      const result = await client.query<RunRow>(
        "SELECT * FROM public.tex64_agent_runs WHERE id = $1 AND user_id = $2",
        [runId, userId],
      );
      return result.rows[0] ? toRun(result.rows[0]) : null;
    });
  }

  async listRuns(
    userId: string,
    documentId: string,
    page?: Parameters<DocumentRepository["listRuns"]>[2],
  ): Promise<StoredAgentRun[]> {
    const { limit, offset } = normalizePageRequest(page, DEFAULT_RUN_PAGE_SIZE);
    return this.withUser(userId, async (client) => {
      const result = await client.query<RunRow>(
        `SELECT * FROM public.tex64_agent_runs
         WHERE document_id = $1 AND user_id = $2
         ORDER BY created_at DESC, id DESC
         LIMIT $3 OFFSET $4`,
        [documentId, userId, limit, offset],
      );
      return result.rows.map(toRun);
    });
  }

  async getCompletedRunForRevision(
    userId: string,
    documentId: string,
    revision: number,
  ): Promise<StoredAgentRun | null> {
    if (!Number.isSafeInteger(revision) || revision < 1) return null;
    return this.withUser(userId, async (client) => {
      const result = await client.query<RunRow>(
        `SELECT *
         FROM public.tex64_agent_runs
         WHERE user_id = $1
           AND document_id = $2
           AND result_revision = $3
           AND status = 'completed'
           AND stage = 'ready'
           AND result_artifact_revision = $3
           AND result_artifact_storage_key IS NOT NULL
           AND result_artifact_sha256 IS NOT NULL
           AND result_artifact_byte_size IS NOT NULL
           AND result_artifact_page_count IS NOT NULL
           AND result_artifact_quality_version IS NOT NULL
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [userId, documentId, revision],
      );
      return result.rows[0] ? toRun(result.rows[0]) : null;
    });
  }

  async updateRun(userId: string, runId: string, update: UpdateRunInput): Promise<StoredAgentRun> {
    return this.withUser(userId, async (client) => {
      const selected = await client.query<RunRow>(
        "SELECT * FROM public.tex64_agent_runs WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [runId, userId],
      );
      if (!selected.rows[0]) throw new AgentRunNotFoundError();
      const current = toRun(selected.rows[0]);
      const prepared = prepareRunUpdate(current, update, new Date().toISOString());
      if (prepared.stateVersion === current.stateVersion) return prepared;

      const updated = await client.query<RunRow>(
        `UPDATE public.tex64_agent_runs
         SET workflow_run_id = $3,
             status = $4,
             stage = $5,
             result_revision = $6,
             error_message = $7,
             result_note = $8,
             state_version = $9,
             updated_at = $10
         WHERE id = $1 AND user_id = $2 AND state_version = $11
         RETURNING *`,
        [
          runId,
          userId,
          prepared.workflowRunId,
          prepared.status,
          prepared.stage,
          prepared.resultRevision,
          prepared.errorMessage,
          prepared.resultNote,
          prepared.stateVersion,
          prepared.updatedAt,
          current.stateVersion,
        ],
      );
      if (!updated.rows[0]) {
        throw new Error("Agent run changed while applying a compare-and-swap update.");
      }
      return toRun(updated.rows[0]);
    });
  }

  async appendRunEvent(input: AppendRunEventInput): Promise<StoredRunEvent> {
    return this.withUser(input.userId, async (client) => {
      const run = await client.query(
        "SELECT id FROM public.tex64_agent_runs WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [input.runId, input.userId],
      );
      if (run.rowCount === 0) throw new AgentRunNotFoundError();
      const idempotencyKey = runEventIdempotencyKey(input);
      const existing = await client.query<EventRow>(
        `SELECT * FROM public.tex64_run_events
         WHERE user_id = $1 AND run_id = $2 AND idempotency_key = $3`,
        [input.userId, input.runId, idempotencyKey],
      );
      if (existing.rows[0]) {
        const event = toEvent(existing.rows[0]);
        assertRunEventReplayMatches(event, input);
        return event;
      }
      const inserted = await client.query<EventRow>(
        `INSERT INTO public.tex64_run_events
          (user_id, run_id, idempotency_key, sequence, stage, message, detail)
         SELECT $1, $2, $3, COALESCE(MAX(sequence), 0) + 1, $4, $5, $6::jsonb
         FROM public.tex64_run_events WHERE run_id = $2 AND user_id = $1
         RETURNING *`,
        [
          input.userId,
          input.runId,
          idempotencyKey,
          input.stage,
          input.message,
          JSON.stringify(input.detail),
        ],
      );
      return toEvent(inserted.rows[0] as EventRow);
    });
  }

  async listRunEvents(
    userId: string,
    runId: string,
    afterSequence = 0,
    limitValue?: number,
  ): Promise<StoredRunEvent[]> {
    const limit = normalizeEventLimit(limitValue);
    return this.withUser(userId, async (client) => {
      const result = await client.query<EventRow>(
        `SELECT * FROM public.tex64_run_events
         WHERE run_id = $1 AND sequence > $2 AND user_id = $3
         ORDER BY sequence ASC
         LIMIT $4`,
        [runId, afterSequence, userId, limit],
      );
      return result.rows.map(toEvent);
    });
  }

  async setRunNeedsInput(
    input: Parameters<DocumentRepository["setRunNeedsInput"]>[0],
  ): Promise<StoredAgentRun> {
    return this.withUser(input.userId, async (client) => {
      const selected = await client.query<RunRow>(
        `SELECT * FROM public.tex64_agent_runs
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [input.runId, input.userId],
      );
      if (!selected.rows[0]) throw new AgentRunNotFoundError();
      const current = toRun(selected.rows[0]);
      if (current.documentId !== input.documentId) {
        throw new RunReplyConflictError("Needs-input run is outside the document scope.");
      }

      const question = input.question.trim();
      if (!question || question.length > 500) {
        throw new RunReplyConflictError("Needs-input question is invalid.");
      }

      const eventKey = `${input.runId}:needs_input:primary`;
      const eventResult = await client.query<EventRow>(
        `SELECT * FROM public.tex64_run_events
         WHERE user_id = $1 AND run_id = $2 AND idempotency_key = $3`,
        [input.userId, input.runId, eventKey],
      );
      const existingEvent = eventResult.rows[0]
        ? toEvent(eventResult.rows[0])
        : null;

      if (current.status === "waiting_approval") {
        if (
          current.stage !== "needs_input" ||
          current.errorMessage !== question ||
          (existingEvent !== null &&
            (existingEvent.detail?.code !== input.code ||
              existingEvent.detail?.question !== question))
        ) {
          throw new RunReplyConflictError(
            "Run is already waiting for a different response.",
          );
        }
        if (!existingEvent) {
          await insertNeedsInputEvent(
            client,
            input,
            question,
            eventKey,
            new Date().toISOString(),
          );
        }
        return current;
      }

      if (existingEvent) {
        throw new RunReplyConflictError("Needs-input event already exists.");
      }

      const now = new Date().toISOString();
      const prepared = prepareRunUpdate(
        current,
        {
          expectedStateVersion: input.expectedStateVersion,
          status: "waiting_approval",
          stage: "needs_input",
          errorMessage: question,
        },
        now,
      );
      await insertNeedsInputEvent(client, input, question, eventKey, now);
      return updateRunRecord(client, current, prepared);
    });
  }

  async consumeClarificationReply(
    userId: string,
    documentId: string,
    responseRunId: string,
    sourceRunId: string,
  ) {
    return this.withUser(userId, async (client) => {
      const runs = await lockRuns(client, userId, responseRunId, sourceRunId);
      const response = runs.get(responseRunId);
      const source = runs.get(sourceRunId);
      if (!response || !source) throw new AgentRunNotFoundError();
      assertReplyScope(response, source, documentId, sourceRunId);

      const sourceEvents = await selectRunEvents(client, userId, sourceRunId);
      const question = needsInputQuestion(
        source,
        sourceEvents,
        "clarification_required",
      );
      if (!question) {
        throw new RunReplyConflictError("Source run is not awaiting clarification.");
      }

      const markerKey = `${responseRunId}:clarification-continuation:${sourceRunId}`;
      const markerResult = await client.query<EventRow>(
        `SELECT * FROM public.tex64_run_events
         WHERE user_id = $1 AND run_id = $2 AND idempotency_key = $3`,
        [userId, responseRunId, markerKey],
      );
      const marker = markerResult.rows[0] ? toEvent(markerResult.rows[0]) : null;
      if (marker) {
        if (
          marker.detail?.code !== "clarification_continuation" ||
          marker.detail?.sourceRunId !== sourceRunId
        ) {
          throw new RunReplyConflictError();
        }
        if (
          source.status !== "cancelled" &&
          !(source.status === "waiting_approval" && source.stage === "needs_input")
        ) {
          throw new RunReplyConflictError();
        }
        return { sourceRun: source, question };
      }
      if (response.status !== "running") {
        throw new RunReplyConflictError("Clarification response is not active.");
      }
      if (source.status !== "waiting_approval" || source.stage !== "needs_input") {
        throw new RunReplyConflictError("Clarification was already consumed.");
      }

      const now = new Date().toISOString();
      await insertRunEvent(client, {
        userId,
        runId: responseRunId,
        idempotencyKey: markerKey,
        stage: "understanding",
        message: "ご要望を整理しています",
        detail: {
          eventKey: markerKey,
          code: "clarification_continuation",
          sourceRunId,
        },
        createdAt: now,
      });
      return { sourceRun: source, question };
    });
  }

  async completeRunForCurrentRevision(
    input: Parameters<DocumentRepository["completeRunForCurrentRevision"]>[0],
  ) {
    return this.withUser(input.userId, async (client) => {
      const selectedRun = await client.query<RunRow>(
        `SELECT * FROM public.tex64_agent_runs
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [input.runId, input.userId],
      );
      const current = selectedRun.rows[0]
        ? toRun(selectedRun.rows[0])
        : null;
      if (!current || current.documentId !== input.documentId) {
        throw new AgentRunNotFoundError();
      }

      const selectedDocument = await client.query<DocumentRow>(
        `SELECT * FROM public.tex64_documents
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [input.documentId, input.userId],
      );
      const document = selectedDocument.rows[0];
      if (!document) throw new DocumentNotFoundError();

      const eventInput: AppendRunEventInput = {
        userId: input.userId,
        runId: input.runId,
        stage: "ready",
        message: input.eventMessage,
        detail: { eventKey: input.eventKey },
      };
      const idempotencyKey = runEventIdempotencyKey(eventInput);
      const selectedEvent = await client.query<EventRow>(
        `SELECT * FROM public.tex64_run_events
         WHERE user_id = $1 AND run_id = $2 AND idempotency_key = $3`,
        [input.userId, input.runId, idempotencyKey],
      );
      const existingEvent = selectedEvent.rows[0]
        ? toEvent(selectedEvent.rows[0])
        : null;
      if (existingEvent) {
        assertRunEventReplayMatches(existingEvent, eventInput);
      }

      if (
        current.status !== "completed" &&
        document.current_revision !== input.revision
      ) {
        throw new RevisionConflictError(
          input.revision,
          document.current_revision,
        );
      }

      const selectedArtifact = await client.query<ArtifactRow>(
        `SELECT * FROM public.tex64_artifacts
         WHERE user_id = $1 AND document_id = $2 AND revision = $3
         FOR SHARE`,
        [input.userId, input.documentId, input.revision],
      );
      const artifact = selectedArtifact.rows[0]
        ? toArtifact(selectedArtifact.rows[0])
        : null;
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
            current.resultRevision ?? document.current_revision,
          );
        }
        if (
          !current.artifactRelease ||
          !releaseBindingsMatch(current.artifactRelease, input.artifact)
        ) {
          throw new ArtifactConflictError();
        }
      } else {
        const prepared = {
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
          artifactRelease: input.artifact,
        };
        completed = await updateRunRecord(client, current, prepared);
      }

      const readyEvent =
        existingEvent ??
        (await insertRunEvent(client, {
          ...eventInput,
          idempotencyKey,
          createdAt: new Date().toISOString(),
        }));

      return { run: completed, artifact, event: readyEvent };
    });
  }

  async saveArtifact(artifact: StoredArtifact): Promise<void> {
    await this.withUser(artifact.userId, async (client) => {
      const revision = await client.query(
        `SELECT 1 FROM public.tex64_document_revisions
         WHERE user_id = $1 AND document_id = $2 AND revision = $3`,
        [artifact.userId, artifact.documentId, artifact.revision],
      );
      if (revision.rowCount === 0) throw new DocumentNotFoundError();

      const inserted = await client.query<ArtifactRow>(
        `INSERT INTO public.tex64_artifacts
          (user_id, document_id, revision, storage_key, sha256, byte_size, compile_duration_ms, page_count, quality_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_id, document_id, revision) DO NOTHING
         RETURNING *`,
        [
          artifact.userId,
          artifact.documentId,
          artifact.revision,
          artifact.storageKey,
          artifact.sha256,
          artifact.byteSize,
          artifact.compileDurationMs,
          artifact.pageCount,
          artifact.qualityVersion,
          artifact.createdAt,
        ],
      );
      if (inserted.rows[0]) return;

      const existing = await client.query<ArtifactRow>(
        `SELECT * FROM public.tex64_artifacts
         WHERE user_id = $1 AND document_id = $2 AND revision = $3
         FOR SHARE`,
        [artifact.userId, artifact.documentId, artifact.revision],
      );
      if (!existing.rows[0]) throw new Error("Artifact conflict could not be resolved.");
      assertArtifactReplayMatches(toArtifact(existing.rows[0]), artifact);
    });
  }

  async replaceArtifact(
    expected: StoredArtifact,
    replacement: StoredArtifact,
  ): Promise<StoredArtifact> {
    assertArtifactScopeMatches(expected, replacement);
    return this.withUser(expected.userId, async (client) => {
      const replaced = await client.query<ArtifactRow>(
        `UPDATE public.tex64_artifacts
         SET storage_key = $4,
             sha256 = $5,
             byte_size = $6,
             compile_duration_ms = $7,
             page_count = $8,
             quality_version = $9,
             created_at = $10
         WHERE user_id = $1
           AND document_id = $2
           AND revision = $3
           AND storage_key = $11
           AND sha256 = $12
           AND byte_size = $13
           AND page_count IS NOT DISTINCT FROM $14
           AND quality_version = $15
         RETURNING *`,
        [
          expected.userId,
          expected.documentId,
          expected.revision,
          replacement.storageKey,
          replacement.sha256,
          replacement.byteSize,
          replacement.compileDurationMs,
          replacement.pageCount,
          replacement.qualityVersion,
          replacement.createdAt,
          expected.storageKey,
          expected.sha256,
          expected.byteSize,
          expected.pageCount,
          expected.qualityVersion,
        ],
      );
      if (replaced.rows[0]) return toArtifact(replaced.rows[0]);

      const current = await client.query<ArtifactRow>(
        `SELECT * FROM public.tex64_artifacts
         WHERE user_id = $1 AND document_id = $2 AND revision = $3
         FOR SHARE`,
        [expected.userId, expected.documentId, expected.revision],
      );
      if (!current.rows[0]) throw new DocumentNotFoundError();
      const artifact = toArtifact(current.rows[0]);
      assertArtifactReplayMatches(artifact, replacement);
      return artifact;
    });
  }

  async getArtifact(userId: string, documentId: string, revision: number): Promise<StoredArtifact | null> {
    return this.withUser(userId, async (client) => {
      const result = await client.query<ArtifactRow>(
        "SELECT * FROM public.tex64_artifacts WHERE document_id = $1 AND revision = $2 AND user_id = $3",
        [documentId, revision, userId],
      );
      return result.rows[0] ? toArtifact(result.rows[0]) : null;
    });
  }

  async listArtifactsForRevisions(
    userId: string,
    revisions: readonly { documentId: string; revision: number }[],
  ): Promise<StoredArtifact[]> {
    assertBatchSize(revisions);
    if (revisions.length === 0) return [];
    if (
      revisions.some(
        (item) => !Number.isSafeInteger(item.revision) || item.revision < 1,
      )
    ) {
      throw new Error("Artifact revision batch is invalid.");
    }
    return this.withUser(userId, async (client) => {
      const result = await client.query<ArtifactRow>(
        `SELECT artifact.*
         FROM public.tex64_artifacts AS artifact
         JOIN unnest($2::uuid[], $3::integer[])
           AS requested(document_id, revision)
           ON requested.document_id = artifact.document_id
          AND requested.revision = artifact.revision
         WHERE artifact.user_id = $1`,
        [
          userId,
          revisions.map((item) => item.documentId),
          revisions.map((item) => item.revision),
        ],
      );
      return result.rows.map(toArtifact);
    });
  }

  async saveSourceRecord(record: SourceRecord): Promise<SourceRecord> {
    const requested = SourceRecordSchema.parse(record);
    return this.withUser(requested.userId, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(141509, hashtext($1))",
        [`${requested.userId}:${requested.documentId}`],
      );
      const document = await client.query(
        `SELECT id FROM public.tex64_documents
         WHERE user_id = $1 AND id = $2
         FOR SHARE`,
        [requested.userId, requested.documentId],
      );
      if (document.rowCount === 0) throw new DocumentNotFoundError();

      const existingForLocator = await client.query<SourceRecordRow>(
        `SELECT * FROM public.tex64_source_records
         WHERE user_id = $1
           AND document_id = $2
           AND canonical_locator = $3
         FOR SHARE`,
        [
          requested.userId,
          requested.documentId,
          requested.canonicalLocator,
        ],
      );
      if (existingForLocator.rows[0]) {
        return toSourceRecord(existingForLocator.rows[0]);
      }

      const existingForId = await client.query<SourceRecordRow>(
        `SELECT * FROM public.tex64_source_records
         WHERE user_id = $1 AND document_id = $2 AND id = $3
         FOR SHARE`,
        [requested.userId, requested.documentId, requested.id],
      );
      if (existingForId.rows[0]) throw new SourceRecordConflictError();

      const capacity = await client.query<{
        source_count: number | string;
        content_bytes: number | string;
      }>(
        `SELECT count(*)::integer AS source_count,
                COALESCE(sum(octet_length(content_text)), 0)::bigint AS content_bytes
         FROM public.tex64_source_records
         WHERE user_id = $1 AND document_id = $2`,
        [requested.userId, requested.documentId],
      );
      const capacityRow = capacity.rows[0];
      assertSourceRecordCapacity({
        currentCount: postgresNonnegativeInteger(
          capacityRow?.source_count ?? 0,
          "source count",
        ),
        currentContentBytes: postgresNonnegativeInteger(
          capacityRow?.content_bytes ?? 0,
          "source content size",
        ),
        incomingContentBytes: sourceRecordContentByteSize(requested),
      });

      const inserted = await client.query<SourceRecordRow>(
        `INSERT INTO public.tex64_source_records
          (id, user_id, document_id, kind, canonical_locator,
           resolved_locator, verification, evidence_scope, content_text,
           content_sha256, metadata, fetched_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          requested.id,
          requested.userId,
          requested.documentId,
          requested.kind,
          requested.canonicalLocator,
          requested.resolvedLocator,
          requested.verification,
          requested.evidenceScope,
          requested.contentText,
          requested.contentSha256,
          JSON.stringify(requested.metadata),
          requested.fetchedAt,
        ],
      );
      if (inserted.rows[0]) return toSourceRecord(inserted.rows[0]);

      // A writer that does not use the application advisory lock can still
      // win the unique locator race. Preserve its first immutable snapshot.
      const raceWinner = await client.query<SourceRecordRow>(
        `SELECT * FROM public.tex64_source_records
         WHERE user_id = $1
           AND document_id = $2
           AND canonical_locator = $3
         FOR SHARE`,
        [
          requested.userId,
          requested.documentId,
          requested.canonicalLocator,
        ],
      );
      if (raceWinner.rows[0]) return toSourceRecord(raceWinner.rows[0]);
      throw new SourceRecordConflictError();
    });
  }

  async getSourceRecord(
    userId: string,
    documentId: string,
    sourceId: string,
  ): Promise<SourceRecord | null> {
    return this.withUser(userId, async (client) => {
      const result = await client.query<SourceRecordRow>(
        `SELECT * FROM public.tex64_source_records
         WHERE user_id = $1 AND document_id = $2 AND id = $3`,
        [userId, documentId, sourceId],
      );
      return result.rows[0] ? toSourceRecord(result.rows[0]) : null;
    });
  }

  async getSourceRecordByLocator(
    userId: string,
    documentId: string,
    canonicalLocator: string,
  ): Promise<SourceRecord | null> {
    const locator = CanonicalSourceLocatorSchema.parse(canonicalLocator);
    return this.withUser(userId, async (client) => {
      const result = await client.query<SourceRecordRow>(
        `SELECT * FROM public.tex64_source_records
         WHERE user_id = $1 AND document_id = $2 AND canonical_locator = $3`,
        [userId, documentId, locator],
      );
      return result.rows[0] ? toSourceRecord(result.rows[0]) : null;
    });
  }

  async listSourceRecordsByIds(
    userId: string,
    documentId: string,
    sourceIds: readonly string[],
  ): Promise<SourceRecord[]> {
    assertBatchSize(sourceIds);
    const ids = normalizeBatchIds(sourceIds);
    if (ids.length === 0) return [];
    return this.withUser(userId, async (client) => {
      const result = await client.query<SourceRecordRow>(
        `SELECT * FROM public.tex64_source_records
         WHERE user_id = $1 AND document_id = $2 AND id = ANY($3::uuid[])`,
        [userId, documentId, ids],
      );
      const byId = new Map(
        result.rows.map((row) => {
          const source = toSourceRecord(row);
          return [source.id, source] as const;
        }),
      );
      return ids.flatMap((id) => {
        const source = byId.get(id);
        return source ? [source] : [];
      });
    });
  }

  async saveResearchLedger(ledger: ResearchLedger): Promise<ResearchLedger> {
    const requested = parseResearchLedger(ledger);
    return this.withUser(requested.userId, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(141510, hashtext($1))",
        [`${requested.userId}:${requested.documentId}:${requested.id}`],
      );
      const scope = await client.query(
        `SELECT document_row.id
         FROM public.tex64_documents AS document_row
         JOIN public.tex64_document_revisions AS revision
           ON revision.user_id = document_row.user_id
          AND revision.document_id = document_row.id
          AND revision.revision = $3
         JOIN public.tex64_agent_runs AS run
           ON run.user_id = document_row.user_id
          AND run.document_id = document_row.id
          AND run.id = $4
         WHERE document_row.user_id = $1 AND document_row.id = $2
         FOR SHARE OF document_row, revision, run`,
        [
          requested.userId,
          requested.documentId,
          requested.target.documentRevision,
          requested.authoringRunId,
        ],
      );
      if (scope.rowCount === 0) throw new ResearchLedgerConflictError();

      const inserted = await client.query<ResearchLedgerRow>(
        `INSERT INTO public.tex64_research_ledgers
          (id, user_id, document_id, authoring_run_id, document_revision,
           document_digest, brief_version, brief_digest, plan_id, plan_version,
           plan_digest, source_snapshot_digest, reviewer_run_id, ledger_digest,
           ledger, created_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15::jsonb, $16)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          requested.id,
          requested.userId,
          requested.documentId,
          requested.authoringRunId,
          requested.target.documentRevision,
          requested.target.documentDigest,
          requested.target.briefVersion,
          requested.target.briefDigest,
          requested.target.planId,
          requested.target.planVersion,
          requested.target.planDigest,
          requested.target.sourceSnapshotDigest,
          requested.reviewer.reviewRunId,
          requested.ledgerDigest,
          JSON.stringify(requested),
          requested.createdAt,
        ],
      );
      if (inserted.rows[0]) return toResearchLedger(inserted.rows[0]);

      const existing = await client.query<ResearchLedgerRow>(
        `SELECT * FROM public.tex64_research_ledgers
         WHERE user_id = $1
           AND document_id = $2
           AND (
             id = $3
             OR (
               authoring_run_id = $4
               AND document_revision = $5
               AND document_digest = $6
               AND brief_digest = $7
               AND plan_digest = $8
               AND source_snapshot_digest = $9
               AND reviewer_run_id = $10
             )
           )
         FOR SHARE`,
        [
          requested.userId,
          requested.documentId,
          requested.id,
          requested.authoringRunId,
          requested.target.documentRevision,
          requested.target.documentDigest,
          requested.target.briefDigest,
          requested.target.planDigest,
          requested.target.sourceSnapshotDigest,
          requested.reviewer.reviewRunId,
        ],
      );
      const winner = existing.rows[0]
        ? toResearchLedger(existing.rows[0])
        : null;
      if (!winner || winner.ledgerDigest !== requested.ledgerDigest) {
        throw new ResearchLedgerConflictError();
      }
      return winner;
    });
  }

  async getResearchLedger(
    userId: string,
    documentId: string,
    ledgerId: string,
  ): Promise<ResearchLedger | null> {
    return this.withUser(userId, async (client) => {
      const result = await client.query<ResearchLedgerRow>(
        `SELECT * FROM public.tex64_research_ledgers
         WHERE user_id = $1 AND document_id = $2 AND id = $3`,
        [userId, documentId, ledgerId],
      );
      return result.rows[0] ? toResearchLedger(result.rows[0]) : null;
    });
  }

  private async withUser<T>(userId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path = pg_catalog, public");
      await client.query("SELECT set_config('app.tex64_user_id', $1, true)", [userId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function assertPostgresRunReplyTarget(
  client: PoolClient,
  input: CreateRunInput,
  lock: "SHARE" | "UPDATE",
): Promise<void> {
  if (!input.replyToRunId) return;

  const sourceResult = await client.query<RunRow>(
    `SELECT * FROM public.tex64_agent_runs
     WHERE id = $1 AND user_id = $2 AND document_id = $3
     FOR ${lock}`,
    [input.replyToRunId, input.userId, input.documentId],
  );
  const events = await client.query<EventRow>(
    `SELECT * FROM public.tex64_run_events
     WHERE user_id = $1 AND run_id = $2 AND stage = 'needs_input'
     ORDER BY sequence DESC
     LIMIT 1`,
    [input.userId, input.replyToRunId],
  );
  const activeResponse = await client.query<RunRow>(
    `SELECT * FROM public.tex64_agent_runs
     WHERE user_id = $1
       AND document_id = $2
       AND reply_to_run_id = $3
       AND id <> $4
       AND status IN ('queued', 'running', 'waiting_approval')
     LIMIT 1
     FOR SHARE`,
    [input.userId, input.documentId, input.replyToRunId, input.id],
  );
  assertRunReplyTarget({
    request: input,
    source: sourceResult.rows[0] ? toRun(sourceResult.rows[0]) : null,
    events: events.rows.map(toEvent),
    activeResponse: activeResponse.rows[0]
      ? toRun(activeResponse.rows[0])
      : null,
  });
}

async function insertNeedsInputEvent(
  client: PoolClient,
  input: Parameters<DocumentRepository["setRunNeedsInput"]>[0],
  question: string,
  eventKey: string,
  now: string,
): Promise<StoredRunEvent> {
  return insertRunEvent(client, {
    userId: input.userId,
    runId: input.runId,
    idempotencyKey: eventKey,
    stage: "needs_input",
    message: "確認したいことがあります",
    detail: {
      eventKey,
      code: input.code,
      question,
    },
    createdAt: now,
  });
}

async function insertRunEvent(
  client: PoolClient,
  input: Omit<StoredRunEvent, "sequence">,
): Promise<StoredRunEvent> {
  const inserted = await client.query<EventRow>(
    `INSERT INTO public.tex64_run_events
      (user_id, run_id, idempotency_key, sequence, stage, message, detail,
       created_at)
     SELECT $1, $2, $3, COALESCE(MAX(sequence), 0) + 1, $4, $5, $6::jsonb, $7
     FROM public.tex64_run_events
     WHERE run_id = $2 AND user_id = $1
     RETURNING *`,
    [
      input.userId,
      input.runId,
      input.idempotencyKey,
      input.stage,
      input.message,
      JSON.stringify(input.detail),
      input.createdAt,
    ],
  );
  return toEvent(inserted.rows[0] as EventRow);
}

async function updateRunRecord(
  client: PoolClient,
  current: StoredAgentRun,
  prepared: StoredAgentRun,
): Promise<StoredAgentRun> {
  if (prepared.stateVersion === current.stateVersion) return prepared;
  const updated = await client.query<RunRow>(
    `UPDATE public.tex64_agent_runs
     SET workflow_run_id = $3,
         status = $4,
         stage = $5,
         result_revision = $6,
         error_message = $7,
         result_note = $8,
         state_version = $9,
         updated_at = $10,
         result_artifact_revision = $11,
         result_artifact_storage_key = $12,
         result_artifact_sha256 = $13,
         result_artifact_byte_size = $14,
         result_artifact_page_count = $15,
         result_artifact_quality_version = $16
     WHERE id = $1 AND user_id = $2 AND state_version = $17
     RETURNING *`,
    [
      current.id,
      current.userId,
      prepared.workflowRunId,
      prepared.status,
      prepared.stage,
      prepared.resultRevision,
      prepared.errorMessage,
      prepared.resultNote,
      prepared.stateVersion,
      prepared.updatedAt,
      prepared.artifactRelease?.revision ?? null,
      prepared.artifactRelease?.storageKey ?? null,
      prepared.artifactRelease?.sha256 ?? null,
      prepared.artifactRelease?.byteSize ?? null,
      prepared.artifactRelease?.pageCount ?? null,
      prepared.artifactRelease?.qualityVersion ?? null,
      current.stateVersion,
    ],
  );
  if (!updated.rows[0]) {
    throw new Error("Agent run changed while applying a compare-and-swap update.");
  }
  return toRun(updated.rows[0]);
}

async function lockRuns(
  client: PoolClient,
  userId: string,
  responseRunId: string,
  sourceRunId: string,
): Promise<Map<string, StoredAgentRun>> {
  const selected = await client.query<RunRow>(
    `SELECT * FROM public.tex64_agent_runs
     WHERE user_id = $1 AND id = ANY($2::uuid[])
     ORDER BY id
     FOR UPDATE`,
    [userId, [responseRunId, sourceRunId]],
  );
  return new Map(selected.rows.map((row) => [row.id, toRun(row)]));
}

async function selectRunEvents(
  client: PoolClient,
  userId: string,
  runId: string,
): Promise<StoredRunEvent[]> {
  const result = await client.query<EventRow>(
    `SELECT * FROM public.tex64_run_events
     WHERE user_id = $1 AND run_id = $2
     ORDER BY sequence ASC`,
    [userId, runId],
  );
  return result.rows.map(toEvent);
}

function assertReplyScope(
  response: StoredAgentRun,
  source: StoredAgentRun,
  documentId: string,
  sourceRunId: string,
): void {
  if (
    response.id === source.id ||
    response.userId !== source.userId ||
    response.documentId !== documentId ||
    source.documentId !== documentId ||
    response.replyToRunId !== sourceRunId ||
    source.createdAt > response.createdAt
  ) {
    throw new RunReplyConflictError();
  }
}

function toDocumentAgentSession(
  row: DocumentAgentSessionRow,
): StoredDocumentAgentSession {
  const stored = parseStoredDocumentAgentSession({
    userId: row.user_id,
    documentId: row.document_id,
    session: row.session,
    stateVersion: postgresNonnegativeInteger(
      row.state_version,
      "document agent session state version",
    ),
    updatedAt: toIso(row.updated_at),
  });
  assertDocumentAgentSessionScope(stored, row.user_id, row.document_id);
  return stored;
}

function toDocument(row: DocumentRow): StoredDocument {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    document: row.document,
    currentRevision: row.current_revision,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toDocumentListItem(row: DocumentListRow): StoredDocumentListItem {
  if (!isDocumentType(row.document_type)) {
    throw new Error("Stored document type is invalid.");
  }
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    documentType: row.document_type,
    hasContent: row.has_content,
    preview: row.preview,
    currentRevision: row.current_revision,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toRevision(row: RevisionRow): StoredRevision {
  return {
    userId: row.user_id,
    documentId: row.document_id,
    commitId: row.commit_id,
    revision: row.revision,
    document: row.document,
    actor: row.actor,
    summary: row.summary,
    operations: row.operations,
    createdAt: toIso(row.created_at),
  };
}

function toRevisionListItem(row: RevisionListRow): StoredRevisionListItem {
  return {
    userId: row.user_id,
    documentId: row.document_id,
    revision: row.revision,
    actor: row.actor,
    summary: row.summary,
    createdAt: toIso(row.created_at),
  };
}

function isDocumentType(
  value: string | null,
): value is DocumentModel["metadata"]["documentType"] {
  return (
    value === "article" ||
    value === "proposal" ||
    value === "report" ||
    value === "paper" ||
    value === "letter" ||
    value === "notes"
  );
}

function toRun(row: RunRow): StoredAgentRun {
  return {
    id: row.id,
    userId: row.user_id,
    documentId: row.document_id,
    prompt: row.prompt,
    replyToRunId: row.reply_to_run_id,
    targetNodeId: row.target_node_id ?? null,
    idempotencyKey: row.idempotency_key,
    workflowRunId: row.workflow_run_id,
    status: row.status,
    stage: row.stage,
    baseRevision: row.base_revision,
    resultRevision: row.result_revision,
    artifactRelease:
      row.result_artifact_revision !== null &&
      row.result_artifact_storage_key !== null &&
      row.result_artifact_sha256 !== null &&
      row.result_artifact_byte_size !== null &&
      row.result_artifact_page_count !== null &&
      row.result_artifact_quality_version !== null
        ? {
            revision: row.result_artifact_revision,
            storageKey: row.result_artifact_storage_key,
            sha256: row.result_artifact_sha256,
            byteSize: row.result_artifact_byte_size,
            pageCount: row.result_artifact_page_count,
            qualityVersion: row.result_artifact_quality_version,
          }
        : null,
    errorMessage: row.error_message,
    resultNote: row.result_note ?? null,
    stateVersion: row.state_version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toEvent(row: EventRow): StoredRunEvent {
  return {
    userId: row.user_id,
    runId: row.run_id,
    idempotencyKey: row.idempotency_key,
    sequence: row.sequence,
    stage: row.stage,
    message: row.message,
    detail: row.detail,
    createdAt: toIso(row.created_at),
  };
}

function toArtifact(row: ArtifactRow): StoredArtifact {
  return {
    userId: row.user_id,
    documentId: row.document_id,
    revision: row.revision,
    storageKey: row.storage_key,
    sha256: row.sha256,
    byteSize: row.byte_size,
    compileDurationMs: row.compile_duration_ms,
    pageCount: row.page_count,
    qualityVersion: row.quality_version,
    createdAt: toIso(row.created_at),
  };
}

function toSourceRecord(row: SourceRecordRow): SourceRecord {
  return SourceRecordSchema.parse({
    schemaVersion: 1,
    id: row.id,
    userId: row.user_id,
    documentId: row.document_id,
    kind: row.kind,
    canonicalLocator: row.canonical_locator,
    resolvedLocator: row.resolved_locator,
    verification: row.verification,
    evidenceScope: row.evidence_scope,
    contentText: row.content_text,
    contentSha256: row.content_sha256,
    metadata: row.metadata,
    fetchedAt: toIso(row.fetched_at),
  });
}

function toResearchLedger(row: ResearchLedgerRow): ResearchLedger {
  const ledger = parseResearchLedger(row.ledger);
  if (
    ledger.id !== row.id ||
    ledger.userId !== row.user_id ||
    ledger.documentId !== row.document_id ||
    ledger.authoringRunId !== row.authoring_run_id ||
    ledger.target.documentRevision !== row.document_revision ||
    ledger.ledgerDigest !== row.ledger_digest ||
    Date.parse(ledger.createdAt) !== Date.parse(toIso(row.created_at))
  ) {
    throw new Error("Stored research review metadata does not match its immutable payload.");
  }
  return ledger;
}

function postgresNonnegativeInteger(
  value: number | string,
  label: string,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Stored ${label} is invalid.`);
  }
  return parsed;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function deleteWorkflowLaunchLease(
  client: PoolClient,
  userId: string,
  runId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM public.tex64_workflow_launch_leases
     WHERE user_id = $1 AND run_id = $2`,
    [userId, runId],
  );
}

function assertWorkflowLaunchLease(token: string, durationMs: number): void {
  if (!token.trim() || token.length > 200) {
    throw new Error("Workflow launch lease token is invalid.");
  }
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 300_000) {
    throw new Error("Workflow launch lease duration is invalid.");
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
