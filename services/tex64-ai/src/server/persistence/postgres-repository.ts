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
  DEFAULT_CONVERSATION_MESSAGE_LIMIT,
  MAX_STORED_CONVERSATION_MESSAGES,
  normalizeConversationLimit,
  assertBatchSize,
  normalizeBatchIds,
  normalizeEventLimit,
  normalizePageRequest,
} from "./pagination";
import {
  AgentRunNotFoundError,
  ArtifactConflictError,
  DocumentNotFoundError,
  RevisionConflictError,
  SourceRecordConflictError,
  type AgentRunStage,
  type AgentRunStatus,
  type AppendConversationMessagesInput,
  type AppendRunEventInput,
  type CreateRunInput,
  type DocumentRepository,
  type StoredConversationMessage,
  type RevisionActor,
  type StoredAgentRun,
  type StoredArtifact,
  type StoredDocument,
  type StoredDocumentListItem,
  type StoredRevision,
  type StoredRevisionListItem,
  type StoredRunEvent,
  type UpdateRunInput,
} from "./types";
import {
  assertArtifactReplayMatches,
  assertArtifactScopeMatches,
  assertDocumentCommitReplayMatches,
  assertRunEventReplayMatches,
  assertRunReplayMatches,
  prepareRunUpdate,
  runEventIdempotencyKey,
} from "./invariants";

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
  target_node_id: string | null;
  idempotency_key: string;
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

type ConversationMessageRow = QueryResultRow & {
  user_id: string;
  document_id: string;
  sequence: string | number;
  turn_id: string;
  role: string;
  content: unknown;
  created_at: Date | string;
};

function mapConversationMessageRow(
  row: ConversationMessageRow,
): StoredConversationMessage {
  const role = row.role;
  if (role !== "user" && role !== "assistant" && role !== "tool") {
    throw new Error("Stored conversation message role is invalid.");
  }
  return {
    userId: row.user_id,
    documentId: row.document_id,
    sequence: Number(row.sequence),
    turnId: row.turn_id,
    role,
    content: row.content,
    createdAt: toIso(row.created_at),
  };
}

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
          (id, user_id, document_id, prompt,
           target_node_id, idempotency_key, base_revision,
           status, stage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', 'writing')
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          input.id,
          input.userId,
          input.documentId,
          input.prompt,
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
         SET status = $3,
             stage = $4,
             result_revision = $5,
             error_message = $6,
             result_note = $7,
             state_version = $8,
             updated_at = $9
         WHERE id = $1 AND user_id = $2 AND state_version = $10
         RETURNING *`,
        [
          runId,
          userId,
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

  async appendConversationMessages(
    input: AppendConversationMessagesInput,
  ): Promise<StoredConversationMessage[]> {
    if (input.messages.length === 0) return [];
    return this.withUser(input.userId, async (client) => {
      const now = new Date().toISOString();
      const appended: StoredConversationMessage[] = [];
      for (const message of input.messages) {
        const inserted = await client.query<ConversationMessageRow>(
          `INSERT INTO public.tex64_conversation_messages
             (user_id, document_id, sequence, turn_id, role, content, created_at)
           SELECT $1, $2,
                  COALESCE(
                    (SELECT MAX(existing.sequence) + 1
                     FROM public.tex64_conversation_messages AS existing
                     WHERE existing.user_id = $1 AND existing.document_id = $2),
                    1),
                  $3, $4, $5::jsonb, $6
           WHERE EXISTS (
             SELECT 1 FROM public.tex64_documents AS document_row
             WHERE document_row.user_id = $1 AND document_row.id = $2
           )
           RETURNING *`,
          [
            input.userId,
            input.documentId,
            input.turnId,
            message.role,
            JSON.stringify(message.content ?? null),
            now,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new DocumentNotFoundError();
        appended.push(mapConversationMessageRow(row));
      }
      await client.query(
        `DELETE FROM public.tex64_conversation_messages AS stale
         WHERE stale.user_id = $1
           AND stale.document_id = $2
           AND stale.sequence <= (
             SELECT MAX(kept.sequence) - $3
             FROM public.tex64_conversation_messages AS kept
             WHERE kept.user_id = $1 AND kept.document_id = $2
           )`,
        [input.userId, input.documentId, MAX_STORED_CONVERSATION_MESSAGES],
      );
      return appended;
    });
  }

  async listConversationMessages(
    userId: string,
    documentId: string,
    limit = DEFAULT_CONVERSATION_MESSAGE_LIMIT,
  ): Promise<StoredConversationMessage[]> {
    const bounded = normalizeConversationLimit(limit);
    return this.withUser(userId, async (client) => {
      const result = await client.query<ConversationMessageRow>(
        `SELECT * FROM (
           SELECT *
           FROM public.tex64_conversation_messages
           WHERE user_id = $1 AND document_id = $2
           ORDER BY sequence DESC
           LIMIT $3
         ) AS tail
         ORDER BY tail.sequence ASC`,
        [userId, documentId, bounded],
      );
      return result.rows.map(mapConversationMessageRow);
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
     SET status = $3,
         stage = $4,
         result_revision = $5,
         error_message = $6,
         result_note = $7,
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
    targetNodeId: row.target_node_id ?? null,
    idempotencyKey: row.idempotency_key,
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




