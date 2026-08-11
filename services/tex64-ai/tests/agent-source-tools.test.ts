import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ResolveSourceResultSchema,
  type ResolveSourceResult,
} from "@/server/agent/document-tools";
import type { SourceRecord } from "@/server/sources";
import {
  MAX_SOURCE_TOOL_EXCERPT_CHARS,
  resolvedSourceToolResult,
} from "@/workflows/document-agent/source-tool-result";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "40000000-0000-4000-8000-000000000002";
const SOURCE_ID = "40000000-0000-4000-8000-000000000003";
const SOURCE_CONTENT = "根拠".repeat(8_000);
const HASH = createHash("sha256")
  .update(SOURCE_CONTENT, "utf8")
  .digest("hex");

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    schemaVersion: 1,
    id: SOURCE_ID,
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    kind: "doi",
    canonicalLocator: "https://doi.org/10.5555/attention",
    resolvedLocator:
      "https://api.crossref.org/works/10.5555%2Fattention",
    verification: "verified_content",
    evidenceScope: "abstract",
    contentText: SOURCE_CONTENT,
    contentSha256: HASH,
    metadata: {
      provider: "crossref",
      title: "Selective attention",
      authors: [{ name: "Ada Lovelace" }],
      publication: "Journal of Attention",
      publisher: "Research Press",
      volume: "12",
      issue: "3",
      pages: "44-58",
      workType: "journal_article",
      language: "en",
      publishedAt: "2025-07-02",
      doi: "10.5555/attention",
      contentType: "application/json",
    },
    fetchedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("agent source tool boundary", () => {
  it("returns only bounded evidence and canonical citation metadata", () => {
    const result = resolvedSourceToolResult(source());
    expect(result).toMatchObject({
      status: "resolved",
      sourceId: SOURCE_ID,
      canonicalLocator: "https://doi.org/10.5555/attention",
      metadata: {
        authors: ["Ada Lovelace"],
        title: "Selective attention",
        year: "2025",
        publication: "Journal of Attention",
        publisher: "Research Press",
        volume: "12",
        issue: "3",
        pages: "44-58",
        sourceType: "journal_article",
        sourceLanguage: "en",
        doi: "10.5555/attention",
        url: "https://doi.org/10.5555/attention",
      },
      evidenceScope: "abstract",
      contentSha256: HASH,
      usableForClaims: true,
      citationReady: true,
    });
    if (result.status !== "resolved") return;
    expect(result.excerpt).toHaveLength(MAX_SOURCE_TOOL_EXCERPT_CHARS);
    expect(result.excerpt).not.toBe(source().contentText);
    expect(Object.keys(result).sort()).toEqual([
      "canonicalLocator",
      "citationReady",
      "contentSha256",
      "evidenceScope",
      "excerpt",
      "metadata",
      "sourceId",
      "status",
      "usableForClaims",
    ]);
  });

  it("keeps metadata-only records out of claims and citations", () => {
    const result = resolvedSourceToolResult(
      source({
        verification: "metadata_only",
        evidenceScope: "none",
        contentText: null,
        contentSha256: null,
      }),
    );
    expect(result).toMatchObject({
      status: "resolved",
      sourceId: SOURCE_ID,
      evidenceScope: "none",
      excerpt: null,
      contentSha256: null,
      usableForClaims: false,
      citationReady: false,
    });
  });

  it("does not mark verified content citation-ready without canonical metadata", () => {
    const result = resolvedSourceToolResult(
      source({
        kind: "https",
        canonicalLocator: "https://papers.example.com/article",
        resolvedLocator: "https://papers.example.com/article",
        evidenceScope: "full_text",
        metadata: {
          provider: "origin",
          title: "Undated page",
          authors: [],
          contentType: "text/html",
        },
      }),
    );
    expect(result).toMatchObject({
      status: "resolved",
      metadata: null,
      usableForClaims: true,
      citationReady: false,
      contentSha256: HASH,
    });
  });

  it("rejects source evidence whose stored digest does not match its content", () => {
    expect(() =>
      resolvedSourceToolResult(
        source({ contentSha256: "a".repeat(64) }),
      ),
    ).toThrow();
  });

  it("uses a discriminated unavailable result without a fake source id", () => {
    const unavailable: ResolveSourceResult = {
      status: "unavailable",
      message: "資料を確認できませんでした。別の候補を選んでください。",
    };
    expect(ResolveSourceResultSchema.parse(unavailable)).toEqual(unavailable);
    expect(
      ResolveSourceResultSchema.safeParse({
        ...unavailable,
        sourceId: SOURCE_ID,
      }).success,
    ).toBe(false);
  });
});
