import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertDocumentResourceBudget,
  type DocumentModel,
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
  type AppendRunEventInput,
  type CreateRunInput,
  type DocumentRepository,
  type StoredAgentRun,
  type StoredArtifact,
  type StoredDocument,
  type StoredConversationMessage,
  type AppendConversationMessagesInput,
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

// Legacy stores may still contain a "pendingActions" key from the removed
// approval flow; it is ignored on read and carried through untouched.
type LocalStoreData = {
  version: 1;
  documents: Record<string, StoredDocument>;
  revisions: Record<string, StoredRevision>;
  runs: Record<string, StoredAgentRun>;
  events: Record<string, StoredRunEvent[]>;
  artifacts: Record<string, StoredArtifact>;
  sourceRecords: Record<string, SourceRecord>;
  conversationMessages: Record<string, StoredConversationMessage[]>;
};

const EMPTY_STORE: LocalStoreData = {
  version: 1,
  documents: {},
  revisions: {},
  runs: {},
  events: {},
  artifacts: {},
  sourceRecords: {},
  conversationMessages: {},
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
      const document = data.documents[documentKey(input.userId, input.documentId)];
      if (!document) throw new DocumentNotFoundError();
      if (document.currentRevision !== input.baseRevision) {
        throw new RevisionConflictError(input.baseRevision, document.currentRevision);
      }

      const now = new Date().toISOString();
      const run: StoredAgentRun = {
        ...input,
        targetNodeId: input.targetNodeId ?? null,
        status: "running",
        stage: "writing",
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

  async appendConversationMessages(
    input: AppendConversationMessagesInput,
  ): Promise<StoredConversationMessage[]> {
    if (input.messages.length === 0) return [];
    return this.write(async (data) => {
      const key = documentKey(input.userId, input.documentId);
      if (!data.documents[key]) throw new DocumentNotFoundError();
      const thread = (data.conversationMessages[key] ??= []);
      const now = new Date().toISOString();
      let sequence = thread.at(-1)?.sequence ?? 0;
      const appended = input.messages.map((message) => {
        sequence += 1;
        return {
          userId: input.userId,
          documentId: input.documentId,
          sequence,
          turnId: input.turnId,
          role: message.role,
          content: clone(message.content),
          createdAt: now,
        } satisfies StoredConversationMessage;
      });
      thread.push(...appended);
      // The thread is the model's memory; older turns fall off the front so a
      // long-lived document cannot grow the store without bound.
      if (thread.length > MAX_STORED_CONVERSATION_MESSAGES) {
        thread.splice(0, thread.length - MAX_STORED_CONVERSATION_MESSAGES);
      }
      return appended.map(clone);
    });
  }

  async listConversationMessages(
    userId: string,
    documentId: string,
    limit = DEFAULT_CONVERSATION_MESSAGE_LIMIT,
  ): Promise<StoredConversationMessage[]> {
    const bounded = normalizeConversationLimit(limit);
    const data = await this.readAfterWrites();
    const thread = data.conversationMessages[documentKey(userId, documentId)] ?? [];
    return thread.slice(-bounded).map(clone);
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
  data.sourceRecords ??= {};
  data.conversationMessages ??= {};
  for (const run of Object.values(data.runs)) {
    run.stateVersion ??= 0;
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



function documentKey(userId: string, documentId: string): string {
  return `${userId}:${documentId}`;
}

function revisionKey(userId: string, documentId: string, revision: number): string {
  return `${documentKey(userId, documentId)}:${revision}`;
}

function runKey(userId: string, runId: string): string {
  return `${userId}:${runId}`;
}

function sourceRecordKey(userId: string, sourceId: string): string {
  return `${userId}:${sourceId}`;
}


function artifactKey(userId: string, documentId: string, revision: number): string {
  return `${documentKey(userId, documentId)}:${revision}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}



function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
