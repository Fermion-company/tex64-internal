import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  SourceRecordSchema,
  canSourceSupportClaims,
  canonicalizeSourceLocator,
  extractHtmlBibliographicMetadata,
  htmlToPlainText,
  isForbiddenSourceHostname,
  isPublicIpAddress,
  normalizeDoi,
} from "@/server/sources";

const BASE_RECORD = {
  schemaVersion: 1 as const,
  id: "40000000-0000-4000-8000-000000000001",
  userId: "40000000-0000-4000-8000-000000000002",
  documentId: "40000000-0000-4000-8000-000000000003",
  kind: "https" as const,
  canonicalLocator: "https://papers.example.com/article",
  resolvedLocator: "https://papers.example.com/article",
  verification: "verified_content" as const,
  evidenceScope: "full_text" as const,
  contentText: "Evidence",
  contentSha256: createHash("sha256").update("Evidence", "utf8").digest("hex"),
  metadata: {
    provider: "origin" as const,
    authors: [],
    contentType: "text/plain",
  },
  fetchedAt: "2026-08-07T00:00:00.000Z",
};

describe("source provenance policy", () => {
  it("canonicalizes DOI variants to one credential-free doi.org locator", () => {
    expect(normalizeDoi(" DOI:10.1000/ABC.Def ")).toBe("10.1000/abc.def");
    expect(canonicalizeSourceLocator("https://doi.org/10.1000/ABC.Def?x=1#section")).toEqual({
      kind: "doi",
      doi: "10.1000/abc.def",
      canonicalLocator: "https://doi.org/10.1000/abc.def",
    });
  });

  it("removes URL credentials and fragments while preserving the resource path", () => {
    expect(
      canonicalizeSourceLocator("https://reader:secret@papers.example.com:443/a?q=1#private"),
    ).toEqual({
      kind: "https",
      canonicalLocator: "https://papers.example.com/a?q=1",
    });
    expect(() => canonicalizeSourceLocator("http://papers.example.com/a")).toThrow(
      expect.objectContaining({ code: "unsupported_protocol" }),
    );
    expect(() => canonicalizeSourceLocator("https://papers.example.com:444/a")).toThrow(
      expect.objectContaining({ code: "unsupported_protocol" }),
    );
    expect(() => canonicalizeSourceLocator("https://doi.org/not-a-doi")).toThrow(
      expect.objectContaining({ code: "invalid_locator" }),
    );
    expect(canonicalizeSourceLocator("https://papers.example.com./a")).toEqual({
      kind: "https",
      canonicalLocator: "https://papers.example.com/a",
    });
  });

  it("rejects loopback, private, link-local, metadata and special-purpose IPs", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "198.51.100.1",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "2001:10::1",
      "2002:0808:0808::1",
    ]) {
      expect(isPublicIpAddress(address), address).toBe(false);
    }
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects internal, reserved and single-label hostnames before DNS", () => {
    for (const hostname of [
      "localhost",
      "metadata.google.internal",
      "service.local",
      "paper.test",
      "paper.example",
      "paper.invalid",
      "home.arpa",
      "intranet",
    ]) {
      expect(isForbiddenSourceHostname(hostname), hostname).toBe(true);
    }
    expect(isForbiddenSourceHostname("papers.example.com")).toBe(false);
  });

  it("removes script and style content before producing normalized plain text", () => {
    const html = `
      <html><head><style>.secret{display:none}</style><script>steal()</script></head>
      <body><h1>Results &amp; discussion</h1><p>A&nbsp;B<br>C</p></body></html>
    `;
    const text = htmlToPlainText(html);
    expect(text).toBe("Results & discussion\n\nA B\nC");
    expect(text).not.toContain("steal");
    expect(text).not.toContain("display:none");
  });

  it("extracts bounded citation meta tags with entity decoding and author deduplication", () => {
    const metadata = extractHtmlBibliographicMetadata(`
      <html><head>
        <meta name="citation_title" content="Attention &amp; Selection">
        <meta name="citation_author" content="Ada Lovelace">
        <meta content="ada lovelace" name="citation_author">
        <meta name="citation_author" content="Alan Turing">
        <meta name="citation_publication_date" content="2025/7/2">
        <meta name="citation_journal_title" content="Journal &amp; Review">
        <meta name="citation_doi" content="not-a-doi">
        <meta name="citation_doi" content="DOI:10.5555/ABC.123">
        <meta property="og:title" content="Lower priority title">
        <script type="application/ld+json">
          {"author":"Injected Author","datePublished":"1999-01-01"}
        </script>
      </head></html>
    `);
    expect(metadata).toEqual({
      title: "Attention & Selection",
      authors: ["Ada Lovelace", "Alan Turing"],
      publication: "Journal & Review",
      publishedAt: "2025-07-02",
      doi: "10.5555/abc.123",
    });
  });

  it("uses inert author/DC/OG fallbacks and ignores invalid DOI or JSON-LD", () => {
    const metadata = extractHtmlBibliographicMetadata(`
      <meta property="og:title" content="Fallback title">
      <meta name="author" content="Grace Hopper">
      <meta name="DC.Date" content="2024-03">
      <meta name="DC.Source" content="Example Proceedings">
      <meta name="DC.Identifier" content="javascript:alert(1)">
      <script type="application/ld+json">
        {"doi":"10.5555/injected","author":"Injected"}
      </script>
    `);
    expect(metadata).toEqual({
      title: "Fallback title",
      authors: ["Grace Hopper"],
      publication: "Example Proceedings",
      publishedAt: "2024-03",
    });
  });

  it("makes metadata-only records structurally unusable for claims", () => {
    const metadataOnly = {
      ...BASE_RECORD,
      kind: "doi" as const,
      canonicalLocator: "https://doi.org/10.1000/example",
      resolvedLocator: "https://api.crossref.org/works/10.1000%2Fexample",
      verification: "metadata_only" as const,
      evidenceScope: "none" as const,
      contentText: null,
      contentSha256: null,
      metadata: {
        provider: "crossref" as const,
        title: "A paper",
        authors: [],
        doi: "10.1000/example",
        contentType: "application/json",
      },
    };
    expect(SourceRecordSchema.safeParse(metadataOnly).success).toBe(true);
    expect(canSourceSupportClaims(metadataOnly)).toBe(false);
    expect(
      SourceRecordSchema.safeParse({
        ...metadataOnly,
        evidenceScope: "abstract",
        contentText: "Invented abstract",
        contentSha256: "b".repeat(64),
      }).success,
    ).toBe(false);
    expect(SourceRecordSchema.safeParse(BASE_RECORD).success).toBe(true);
    expect(canSourceSupportClaims(BASE_RECORD)).toBe(true);
    expect(
      SourceRecordSchema.safeParse({ ...BASE_RECORD, contentSha256: "a".repeat(64) }).success,
    ).toBe(false);
    expect(
      SourceRecordSchema.safeParse({
        ...metadataOnly,
        canonicalLocator: "https://papers.example.com/10.1000/example",
      }).success,
    ).toBe(false);
  });
});
