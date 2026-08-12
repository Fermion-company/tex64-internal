import { createHash } from "node:crypto";

import { DocumentPatchSchema, type DocumentPatch } from "@/domain/document";

import {
  PendingDocumentActionConflictError,
  RunReplyConflictError,
  type CreateRunInput,
  type NeedsInputCode,
  type PendingDocumentActionDraft,
  type StoredAgentRun,
  type StoredPendingDocumentAction,
  type StoredRunEvent,
} from "./types";

export function documentPatchDigest(patchValue: DocumentPatch): string {
  const patch = DocumentPatchSchema.parse(patchValue);
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(patch)))
    .digest("hex");
}

export function assertPendingActionDraft(input: {
  documentId: string;
  draft: PendingDocumentActionDraft;
}): DocumentPatch {
  const patch = DocumentPatchSchema.parse(input.draft.patch);
  if (patch.documentId !== input.documentId) {
    throw new PendingDocumentActionConflictError(
      "Pending patch targets a different document.",
    );
  }
  if (input.draft.patchDigest !== documentPatchDigest(patch)) {
    throw new PendingDocumentActionConflictError(
      "Pending patch digest does not match its validated content.",
    );
  }
  if (!input.draft.summary.trim() || input.draft.summary.length > 1_000) {
    throw new PendingDocumentActionConflictError(
      "Pending patch summary is invalid.",
    );
  }
  return patch;
}

export function assertStoredPendingAction(
  action: StoredPendingDocumentAction,
): StoredPendingDocumentAction {
  if (
    action.patch.documentId !== action.documentId ||
    action.patch.baseRevision !== action.baseRevision ||
    documentPatchDigest(action.patch) !== action.patchDigest
  ) {
    throw new PendingDocumentActionConflictError(
      "Stored pending patch failed its integrity check.",
    );
  }
  return action;
}

export function needsInputEventCode(
  events: readonly Pick<StoredRunEvent, "stage" | "detail">[],
): NeedsInputCode | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.stage !== "needs_input") continue;
    const code = event.detail?.code;
    if (code === "clarification_required" || code === "approval_required") {
      return code;
    }
  }
  return null;
}

export function needsInputQuestion(
  run: StoredAgentRun,
  events: readonly Pick<StoredRunEvent, "stage" | "detail">[],
  expectedCode: NeedsInputCode,
): string | null {
  if (needsInputEventCode(events) !== expectedCode) return null;
  const question = run.errorMessage?.trim() ?? "";
  if (!question) return null;
  const event = [...events]
    .reverse()
    .find(
      (candidate) =>
        candidate.stage === "needs_input" &&
        candidate.detail?.code === expectedCode,
    );
  if (
    typeof event?.detail?.question === "string" &&
    event.detail.question.trim() !== question
  ) {
    return null;
  }
  return question;
}

export function assertRunReplyTarget(input: {
  request: CreateRunInput;
  source: StoredAgentRun | null;
  events: readonly Pick<StoredRunEvent, "stage" | "detail">[];
  pendingAction: StoredPendingDocumentAction | null;
  activeResponse: StoredAgentRun | null;
}): void {
  const { request } = input;
  if (!request.replyToRunId) {
    if (request.decision) {
      throw new RunReplyConflictError(
        "A structured decision must target a pending run.",
      );
    }
    return;
  }

  const source = input.source;
  if (
    !source ||
    source.id === request.id ||
    source.userId !== request.userId ||
    source.documentId !== request.documentId ||
    source.status !== "waiting_approval" ||
    source.stage !== "needs_input"
  ) {
    throw new RunReplyConflictError();
  }
  if (input.activeResponse) {
    throw new RunReplyConflictError(
      "Another response is already handling this pending run.",
    );
  }

  const expectedCode: NeedsInputCode = request.decision
    ? "approval_required"
    : "clarification_required";
  if (!needsInputQuestion(source, input.events, expectedCode)) {
    throw new RunReplyConflictError(
      "The response kind does not match the pending request.",
    );
  }

  if (request.decision) {
    const action = input.pendingAction;
    if (
      !action ||
      action.userId !== request.userId ||
      action.documentId !== request.documentId ||
      action.sourceRunId !== source.id ||
      action.status !== "pending" ||
      action.resolvedByRunId !== null
    ) {
      throw new PendingDocumentActionConflictError(
        "The approval no longer has a pending document change.",
      );
    }
    assertStoredPendingAction(action);
  }
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
