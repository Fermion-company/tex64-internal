import {
  RunReplyConflictError,
  type CreateRunInput,
  type NeedsInputCode,
  type StoredAgentRun,
  type StoredRunEvent,
} from "./types";

/**
 * The pending-document-action (approval) subsystem was removed; this module
 * now only hosts the clarification-reply helpers shared by both repository
 * backends. The pending_document_actions table still exists on disk (see
 * migrations/) but is no longer written or read.
 */

function needsInputEventCode(
  events: readonly Pick<StoredRunEvent, "stage" | "detail">[],
): NeedsInputCode | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.stage !== "needs_input") continue;
    const code = event.detail?.code;
    // Legacy runs persisted before the approval flow was removed carry
    // "approval_required"; their free-text reply is handled as an ordinary
    // clarification so those historical runs never become unanswerable.
    if (code === "clarification_required" || code === "approval_required") {
      return "clarification_required";
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
        (candidate.detail?.code === "clarification_required" ||
          candidate.detail?.code === "approval_required"),
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
  activeResponse: StoredAgentRun | null;
}): void {
  const { request } = input;
  if (!request.replyToRunId) return;

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

  if (!needsInputQuestion(source, input.events, "clarification_required")) {
    throw new RunReplyConflictError(
      "The response kind does not match the pending request.",
    );
  }
}
