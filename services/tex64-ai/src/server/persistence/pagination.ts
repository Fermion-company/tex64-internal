import type { ListPageRequest } from "./types";

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_DOCUMENT_PAGE_SIZE = 100;
export const DEFAULT_REVISION_PAGE_SIZE = 50;
export const DEFAULT_RUN_PAGE_SIZE = 50;
const DEFAULT_EVENT_PAGE_SIZE = 200;
const MAX_EVENT_PAGE_SIZE = 500;
export const MAX_PAGE_OFFSET = 10_000;

export function normalizePageRequest(
  page: ListPageRequest | undefined,
  defaultLimit: number,
): Required<ListPageRequest> {
  const limit = page?.limit ?? defaultLimit;
  const offset = page?.offset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE_SIZE ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > MAX_PAGE_OFFSET
  ) {
    throw new Error("Pagination request is outside the supported range.");
  }
  return { limit, offset };
}

/**
 * How much of the thread a turn replays, and how much of it the store keeps.
 * One cap in both places keeps "what the model remembers" identical to "what
 * is persisted" instead of letting the two silently diverge.
 */
export const DEFAULT_CONVERSATION_MESSAGE_LIMIT = 200;
export const MAX_STORED_CONVERSATION_MESSAGES = 400;

export function normalizeConversationLimit(
  limit = DEFAULT_CONVERSATION_MESSAGE_LIMIT,
): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return DEFAULT_CONVERSATION_MESSAGE_LIMIT;
  }
  return Math.min(limit, MAX_STORED_CONVERSATION_MESSAGES);
}

export function normalizeEventLimit(limit = DEFAULT_EVENT_PAGE_SIZE): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE_SIZE) {
    throw new Error("Event page size is outside the supported range.");
  }
  return limit;
}

export function normalizeBatchIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_PAGE_SIZE) {
    throw new Error("Batch identifier count is outside the supported range.");
  }
  return unique;
}

export function assertBatchSize(values: readonly unknown[]): void {
  if (values.length > MAX_PAGE_SIZE) {
    throw new Error("Batch value count is outside the supported range.");
  }
}
