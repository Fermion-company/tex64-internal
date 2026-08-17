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
