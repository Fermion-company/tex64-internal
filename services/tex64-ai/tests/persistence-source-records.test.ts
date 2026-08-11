import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SAMPLE_DOCUMENT } from "@/domain/document";
import {
  MAX_SOURCE_CONTENT_BYTES_PER_DOCUMENT,
  MAX_SOURCES_PER_DOCUMENT,
  assertSourceRecordCapacity,
} from "@/server/persistence/limits";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import {
  ResourceLimitExceededError,
  SourceRecordConflictError,
  type SourceRecord,
} from "@/server/persistence";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "40000000-0000-4000-8000-000000000002";
const OTHER_DOCUMENT_ID = "30000000-0000-4000-8000-000000000099";
const SOURCE_ID = "60000000-0000-4000-8000-000000000001";

let temporaryDirectory: string;
let repository: LocalDocumentRepository;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-sources-"));
  repository = new LocalDocumentRepository(
    path.join(temporaryDirectory, "store.json"),
  );
  await repository.createDocument(USER_ID, structuredClone(SAMPLE_DOCUMENT));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sourceRecord(
  overrides: Partial<SourceRecord> = {},
): SourceRecord {
  const contentText = overrides.contentText ?? "Verified evidence.";
  return {
    schemaVersion: 1,
    id: SOURCE_ID,
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    kind: "https",
    canonicalLocator: "https://papers.example.com/article",
    resolvedLocator: "https://papers.example.com/article",
    verification: "verified_content",
    evidenceScope: "full_text",
    contentText,
    contentSha256: digest(contentText),
    metadata: {
      provider: "origin",
      authors: [],
      contentType: "text/html",
      title: "Stable source",
    },
    fetchedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("LocalDocumentRepository source provenance", () => {
  it("stores and reads validated records only within their tenant and document", async () => {
    const source = sourceRecord();
    await expect(repository.saveSourceRecord(source)).resolves.toEqual(source);
    await expect(
      repository.getSourceRecord(USER_ID, SAMPLE_DOCUMENT.id, source.id),
    ).resolves.toEqual(source);
    await expect(
      repository.getSourceRecord(USER_ID, OTHER_DOCUMENT_ID, source.id),
    ).resolves.toBeNull();
    await expect(
      repository.getSourceRecord(OTHER_USER_ID, SAMPLE_DOCUMENT.id, source.id),
    ).resolves.toBeNull();
    await expect(
      repository.getSourceRecordByLocator(
        USER_ID,
        SAMPLE_DOCUMENT.id,
        source.canonicalLocator,
      ),
    ).resolves.toEqual(source);
    await expect(
      repository.listSourceRecordsByIds(USER_ID, SAMPLE_DOCUMENT.id, [
        "60000000-0000-4000-8000-000000000099",
        source.id,
        source.id,
      ]),
    ).resolves.toEqual([source]);
  });

  it("preserves the first immutable snapshot for a canonical locator", async () => {
    const first = sourceRecord();
    await repository.saveSourceRecord(first);
    const changedText = "Content changed at the origin.";
    const changed = sourceRecord({
      id: "60000000-0000-4000-8000-000000000002",
      contentText: changedText,
      contentSha256: digest(changedText),
      fetchedAt: "2026-08-07T01:00:00.000Z",
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        repository.saveSourceRecord(structuredClone(changed)),
      ),
    );
    expect(results.every((result) => result.id === first.id)).toBe(true);
    await expect(
      repository.getSourceRecordByLocator(
        USER_ID,
        SAMPLE_DOCUMENT.id,
        first.canonicalLocator,
      ),
    ).resolves.toEqual(first);
  });

  it("allows the same canonical locator to have a separate document snapshot", async () => {
    const first = sourceRecord();
    await repository.saveSourceRecord(first);
    const otherDocument = {
      ...structuredClone(SAMPLE_DOCUMENT),
      id: OTHER_DOCUMENT_ID,
    };
    await repository.createDocument(USER_ID, otherDocument);
    const otherContent = "Evidence captured for another document.";
    const other = sourceRecord({
      id: "60000000-0000-4000-8000-000000000003",
      documentId: OTHER_DOCUMENT_ID,
      contentText: otherContent,
      contentSha256: digest(otherContent),
    });

    await expect(repository.saveSourceRecord(other)).resolves.toEqual(other);
    await expect(
      repository.getSourceRecordByLocator(
        USER_ID,
        OTHER_DOCUMENT_ID,
        first.canonicalLocator,
      ),
    ).resolves.toEqual(other);
    await expect(
      repository.getSourceRecordByLocator(
        USER_ID,
        SAMPLE_DOCUMENT.id,
        first.canonicalLocator,
      ),
    ).resolves.toEqual(first);
  });

  it("rejects identifier rebinding, invalid records, and oversized batches", async () => {
    const first = sourceRecord();
    await repository.saveSourceRecord(first);
    await expect(
      repository.saveSourceRecord(
        sourceRecord({
          canonicalLocator: "https://papers.example.com/another",
          resolvedLocator: "https://papers.example.com/another",
        }),
      ),
    ).rejects.toBeInstanceOf(SourceRecordConflictError);
    await expect(
      repository.saveSourceRecord({
        ...first,
        verification: "metadata_only",
      }),
    ).rejects.toThrow();
    await expect(
      repository.listSourceRecordsByIds(
        USER_ID,
        SAMPLE_DOCUMENT.id,
        Array.from({ length: 101 }, () => first.id),
      ),
    ).rejects.toThrow("Batch value count is outside the supported range");
  });

  it("upgrades a legacy local store without a sourceRecords collection", async () => {
    const legacy = JSON.parse(
      await readFile(repository.filePath, "utf8"),
    ) as Record<string, unknown>;
    delete legacy.sourceRecords;
    await writeFile(repository.filePath, JSON.stringify(legacy));

    await expect(
      repository.getSourceRecord(USER_ID, SAMPLE_DOCUMENT.id, SOURCE_ID),
    ).resolves.toBeNull();
    await expect(repository.saveSourceRecord(sourceRecord())).resolves.toMatchObject({
      id: SOURCE_ID,
    });
  });

  it("rejects a persisted snapshot whose evidence no longer matches its digest", async () => {
    const source = sourceRecord();
    await repository.saveSourceRecord(source);
    const store = JSON.parse(
      await readFile(repository.filePath, "utf8"),
    ) as { sourceRecords: Record<string, SourceRecord> };
    store.sourceRecords[`${USER_ID}:${source.id}`]!.contentText =
      "Tampered evidence";
    await writeFile(repository.filePath, JSON.stringify(store));

    await expect(
      repository.getSourceRecord(USER_ID, SAMPLE_DOCUMENT.id, source.id),
    ).rejects.toThrow();
  });

  it("enforces the per-document source count atomically", async () => {
    const store = JSON.parse(
      await readFile(repository.filePath, "utf8"),
    ) as { sourceRecords: Record<string, SourceRecord> };
    for (let index = 0; index < MAX_SOURCES_PER_DOCUMENT; index += 1) {
      const suffix = String(index + 1).padStart(12, "0");
      const source = sourceRecord({
        id: `60000000-0000-4000-8000-${suffix}`,
        canonicalLocator: `https://papers.example.com/${index + 1}`,
        resolvedLocator: `https://papers.example.com/${index + 1}`,
      });
      store.sourceRecords[`${USER_ID}:${source.id}`] = source;
    }
    await writeFile(repository.filePath, JSON.stringify(store));

    await expect(
      repository.saveSourceRecord(
        sourceRecord({
          id: "60000000-0000-4000-8000-999999999999",
          canonicalLocator: "https://papers.example.com/overflow",
          resolvedLocator: "https://papers.example.com/overflow",
        }),
      ),
    ).rejects.toMatchObject({ resource: "sources" });
  });

  it("enforces the aggregate UTF-8 evidence budget", () => {
    expect(() =>
      assertSourceRecordCapacity({
        currentCount: 3,
        currentContentBytes: MAX_SOURCE_CONTENT_BYTES_PER_DOCUMENT - 1,
        incomingContentBytes: 2,
      }),
    ).toThrowError(ResourceLimitExceededError);
    expect(() =>
      assertSourceRecordCapacity({
        currentCount: 3,
        currentContentBytes: MAX_SOURCE_CONTENT_BYTES_PER_DOCUMENT - 1,
        incomingContentBytes: 1,
      }),
    ).not.toThrow();
  });

  it(
    "applies the aggregate evidence budget while saving local snapshots",
    async () => {
      const largeContent = "界".repeat(2_000_000);
      const largeDigest = digest(largeContent);
      for (let index = 1; index <= 3; index += 1) {
        await repository.saveSourceRecord(
          sourceRecord({
            id: `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            canonicalLocator: `https://papers.example.com/large-${index}`,
            resolvedLocator: `https://papers.example.com/large-${index}`,
            contentText: largeContent,
            contentSha256: largeDigest,
          }),
        );
      }

      const overflowContent = "界".repeat(1_000_000);
      await expect(
        repository.saveSourceRecord(
          sourceRecord({
            id: "60000000-0000-4000-8000-999999999998",
            canonicalLocator: "https://papers.example.com/content-overflow",
            resolvedLocator: "https://papers.example.com/content-overflow",
            contentText: overflowContent,
            contentSha256: digest(overflowContent),
          }),
        ),
      ).rejects.toMatchObject({ resource: "source_content" });
    },
    15_000,
  );
});
