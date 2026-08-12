import { ResourceLimitExceededError } from "./types";
import type { SourceRecord } from "@/server/sources/schema";

export const MAX_DOCUMENTS_PER_USER = 100;
export const MAX_REVISIONS_PER_DOCUMENT = 500;
export const MAX_SOURCES_PER_DOCUMENT = 100;
export const MAX_SOURCE_CONTENT_BYTES_PER_DOCUMENT = 20 * 1024 * 1024;

export function assertDocumentCountWithinLimit(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Stored document count is invalid.");
  }
  if (count >= MAX_DOCUMENTS_PER_USER) {
    throw new ResourceLimitExceededError("documents");
  }
}

export function assertRevisionWithinLimit(currentRevision: number): void {
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 1) {
    throw new Error("Stored document revision is invalid.");
  }
  if (currentRevision >= MAX_REVISIONS_PER_DOCUMENT) {
    throw new ResourceLimitExceededError("revisions");
  }
}

export function sourceRecordContentByteSize(
  source: Pick<SourceRecord, "contentText">,
): number {
  return source.contentText === null
    ? 0
    : Buffer.byteLength(source.contentText, "utf8");
}

export function assertSourceRecordCapacity(input: {
  currentCount: number;
  currentContentBytes: number;
  incomingContentBytes: number;
}): void {
  for (const value of [
    input.currentCount,
    input.currentContentBytes,
    input.incomingContentBytes,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Stored source capacity is invalid.");
    }
  }
  if (input.currentCount >= MAX_SOURCES_PER_DOCUMENT) {
    throw new ResourceLimitExceededError("sources");
  }
  if (
    input.currentContentBytes + input.incomingContentBytes >
    MAX_SOURCE_CONTENT_BYTES_PER_DOCUMENT
  ) {
    throw new ResourceLimitExceededError("source_content");
  }
}
