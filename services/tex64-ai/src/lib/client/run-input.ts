import type { AgentRun, StartRunInput } from "./types";
import { containsUnsafeUserFacingCopy } from "@/lib/user-facing-copy";

/** Keep domain terms visible while withholding concrete internal execution copy. */
export function userFacingRunNote(
  note: string | undefined,
  fallback: string,
): string {
  const value = note?.trim();
  return value && !containsUnsafeUserFacingCopy(value) ? value : fallback;
}

export function createRunReplyInput(
  run: AgentRun | null,
  prompt: string,
): StartRunInput {
  if (!run || !isRunAwaitingInput(run)) {
    return { prompt };
  }
  return { prompt, replyToRunId: run.id };
}

/**
 * "waiting_approval" is the historical status literal for awaiting-input
 * runs; today it only ever means an open question (request_input / review).
 */
export function isRunAwaitingInput(run: AgentRun): boolean {
  return run.status === "waiting_approval" && run.stage === "needs_input";
}

/**
 * Select the run which currently controls the composer. A failed response may
 * be newer than the still-open question it attempted to answer, so recency
 * alone is not enough. Work in progress wins first, then the newest unresolved
 * question, and finally the newest terminal run.
 */
export function selectConversationRun(
  runs: readonly AgentRun[],
  activeRun: AgentRun | null = null,
): AgentRun | null {
  const byId = new Map(runs.map((run) => [run.id, run]));
  if (activeRun) byId.set(activeRun.id, activeRun);
  const ordered = [...byId.values()].sort(compareRunRecency);

  return (
    ordered.find(
      (run) => run.status === "queued" || run.status === "running",
    ) ??
    ordered.find(isRunAwaitingInput) ??
    ordered[0] ??
    null
  );
}

/**
 * A transport failure must not erase the pending question being answered.
 * Keeping the exact persisted source run lets a changed retry retain its
 * replyToRunId, while an identical retry can still reuse its idempotency key.
 */
export function recoverableReplySource(
  runs: readonly AgentRun[],
  input: StartRunInput,
): AgentRun | null {
  if (!input.replyToRunId) return null;
  const source = runs.find((run) => run.id === input.replyToRunId) ?? null;
  if (!source || !isRunAwaitingInput(source)) {
    return null;
  }
  return source;
}

function compareRunRecency(left: AgentRun, right: AgentRun): number {
  const created = right.createdAt.localeCompare(left.createdAt);
  if (created !== 0) return created;
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  if (updated !== 0) return updated;
  return right.id.localeCompare(left.id);
}

export function runRequestIdentity(
  documentId: string,
  prompt: string,
  input: StartRunInput,
): string {
  return JSON.stringify([
    documentId,
    prompt,
    input.prompt ?? null,
    input.replyToRunId ?? null,
    input.targetNodeId ?? null,
  ]);
}
