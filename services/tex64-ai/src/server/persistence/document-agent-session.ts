import {
  StoredDocumentAgentSessionSchema,
  type StoredDocumentAgentSession,
} from "@/domain/brief";
import { DocumentAgentSessionConflictError } from "./types";

export type DocumentAgentSessionSaveDisposition =
  | "create"
  | "update"
  | "replay";

/** Parse untrusted JSON/JSONB and enforce the duplicated storage invariants. */
export function parseStoredDocumentAgentSession(
  value: unknown,
): StoredDocumentAgentSession {
  const stored = StoredDocumentAgentSessionSchema.parse(value);
  if (
    stored.documentId !== stored.session.documentId ||
    stored.documentId !== stored.session.brief.documentId
  ) {
    throw new Error("Stored document agent session is outside its document scope.");
  }
  if (stored.stateVersion !== stored.session.stateVersion) {
    throw new Error("Stored document agent session versions do not agree.");
  }
  if (Date.parse(stored.updatedAt) !== Date.parse(stored.session.updatedAt)) {
    throw new Error("Stored document agent session timestamps do not agree.");
  }
  return stored;
}

export function assertDocumentAgentSessionScope(
  stored: StoredDocumentAgentSession,
  userId: string,
  documentId: string,
): void {
  if (stored.userId !== userId || stored.documentId !== documentId) {
    throw new Error("Stored document agent session is outside its tenant scope.");
  }
}

/**
 * Applies the shared CAS/idempotency contract before either repository writes.
 * A durable workflow retry is recognized before CAS so a timed-out successful
 * write can safely be repeated with its original expected version.
 */
export function classifyDocumentAgentSessionSave(input: {
  current: StoredDocumentAgentSession | null;
  candidate: StoredDocumentAgentSession;
  expectedStateVersion: number | null;
}): DocumentAgentSessionSaveDisposition {
  const { current, candidate, expectedStateVersion } = input;
  const processedRunId = candidate.session.lastProcessedRunId;
  if (
    current &&
    processedRunId !== null &&
    current.session.lastProcessedRunId === processedRunId
  ) {
    return "replay";
  }

  const actualStateVersion = current?.stateVersion ?? null;
  if (expectedStateVersion !== actualStateVersion) {
    throw new DocumentAgentSessionConflictError(
      expectedStateVersion,
      actualStateVersion,
    );
  }

  const nextStateVersion = actualStateVersion === null
    ? 0
    : actualStateVersion + 1;
  if (candidate.stateVersion !== nextStateVersion) {
    throw new Error(
      `Document agent session must advance to state version ${nextStateVersion}.`,
    );
  }

  if (current) {
    if (
      candidate.session.id !== current.session.id ||
      candidate.session.rootRunId !== current.session.rootRunId ||
      Date.parse(candidate.session.createdAt) !==
        Date.parse(current.session.createdAt)
    ) {
      throw new Error("Document agent session identity cannot be changed.");
    }
    if (Date.parse(candidate.updatedAt) < Date.parse(current.updatedAt)) {
      throw new Error("Document agent session timestamp cannot move backwards.");
    }
    if (
      current.session.lastProcessedRunId !== null &&
      candidate.session.lastProcessedRunId === null
    ) {
      throw new Error("The last processed run cannot be cleared.");
    }
  }

  return current ? "update" : "create";
}
