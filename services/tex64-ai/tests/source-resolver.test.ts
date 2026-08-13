import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalCitationMetadataFromSource,
  canSourceSupportClaims,
  resolveSource,
  type PinnedFetch,
  type SourceResolverDependencies,
} from "@/server/sources";

const USER_ID = "50000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "50000000-0000-4000-8000-000000000002";
const SOURCE_ID = "50000000-0000-4000-8000-000000000003";

function dependencies(pinnedFetch: PinnedFetch): SourceResolverDependencies {
  return {
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    pinnedFetch,
    now: () => new Date("2026-08-07T00:00:00.000Z"),
    randomUuid: () => SOURCE_ID,
  };
}

describe("source resolver", () => {
  it("resolves HTTPS HTML to script-free normalized content with a stable digest", async () => {
    const source = await resolveSource(
      {
        userId: USER_ID,
        documentId: DOCUMENT_ID,
        locator: "https://reader:secret@papers.example.com/article#section",
      },
      dependencies(async () => ({
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
        body: Buffer.from(
          "<html><head><title>論文</title><style>hidden</style><script>bad()</script></head><body><h1>本文</h1><p>結果 &amp; 考察</p></body></html>",
        ),
      })),
    );

    expect(source).toMatchObject({
      id: SOURCE_ID,
      kind: "https",
      canonicalLocator: "https://papers.example.com/article",
      resolvedLocator: "https://papers.example.com/article",
      verification: "verified_content",
      evidenceScope: "full_text",
      contentText: "論文\n本文\n\n結果 & 考察",
      metadata: { provider: "origin", title: "論文", contentType: "text/html" },
      fetchedAt: "2026-08-07T00:00:00.000Z",
    });
    expect(source.contentSha256).toBe(
      createHash("sha256").update(source.contentText!, "utf8").digest("hex"),
    );
    expect(source.contentText).not.toContain("bad()");
    expect(canSourceSupportClaims(source)).toBe(true);
  });

  it("makes scholarly HTML citation-ready from inert citation meta tags", async () => {
    const source = await resolveSource(
      {
        id: SOURCE_ID,
        userId: USER_ID,
        documentId: DOCUMENT_ID,
        locator: "https://papers.example.com/article",
      },
      dependencies(async () => ({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from(`
          <html><head>
            <meta name="citation_title" content="Web Evidence">
            <meta name="citation_author" content="Ada Lovelace">
            <meta name="citation_publication_date" content="2026-08-07">
            <meta name="citation_journal_title" content="Open Research">
            <meta name="citation_publisher" content="Open Press">
            <meta name="citation_volume" content="8">
            <meta name="citation_issue" content="2">
            <meta name="citation_firstpage" content="10">
            <meta name="citation_lastpage" content="19">
            <meta name="citation_language" content="en">
            <meta name="citation_doi" content="10.5555/web-evidence">
            <script type="application/ld+json">
              {"author":"Injected","datePublished":"1999"}
            </script>
          </head><body><p>Verified body.</p></body></html>
        `),
      })),
    );

    expect(source.metadata).toMatchObject({
      title: "Web Evidence",
      authors: [{ name: "Ada Lovelace" }],
      publication: "Open Research",
      publisher: "Open Press",
      volume: "8",
      issue: "2",
      pages: "10-19",
      language: "en",
      workType: "journal_article",
      publishedAt: "2026-08-07",
      doi: "10.5555/web-evidence",
    });
    expect(canonicalCitationMetadataFromSource(source)).toEqual({
      sourceId: SOURCE_ID,
      authors: ["Ada Lovelace"],
      title: "Web Evidence",
      year: "2026",
      publication: "Open Research",
      publisher: "Open Press",
      volume: "8",
      issue: "2",
      pages: "10-19",
      sourceType: "journal_article",
      sourceLanguage: "en",
      doi: "10.5555/web-evidence",
      url: "https://papers.example.com/article",
    });
  });

  it("marks a DOI verified only when Crossref provides structured metadata and an abstract", async () => {
    let requestedUrl = "";
    const source = await resolveSource(
      {
        id: SOURCE_ID,
        userId: USER_ID,
        documentId: DOCUMENT_ID,
        locator: "DOI:10.5555/ABC.123",
      },
      dependencies(async (request) => {
        requestedUrl = request.url.href;
        return {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: Buffer.from(
            JSON.stringify({
              status: "ok",
              message: {
                DOI: "10.5555/abc.123",
                title: ["Selective attention"],
                author: [
                  {
                    given: "Ada",
                    family: "Lovelace",
                    ORCID: "http://orcid.org/0000-0000-0000-0001",
                  },
                ],
                publisher: "Research Press",
                "container-title": ["Journal of Attention"],
                volume: "12",
                issue: "3",
                page: "44-58",
                type: "journal-article",
                issued: { "date-parts": [[2025, 7, 2]] },
                abstract: "<jats:p>Attention improves &amp; selects signals.</jats:p>",
              },
            }),
          ),
        };
      }),
    );

    expect(requestedUrl).toBe("https://api.crossref.org/works/10.5555%2Fabc.123");
    expect(source).toMatchObject({
      kind: "doi",
      canonicalLocator: "https://doi.org/10.5555/abc.123",
      verification: "verified_content",
      evidenceScope: "abstract",
      contentText: "Attention improves & selects signals.",
      metadata: {
        provider: "crossref",
        title: "Selective attention",
        authors: [
          {
            name: "Ada Lovelace",
            orcid: "https://orcid.org/0000-0000-0000-0001",
          },
        ],
        publication: "Journal of Attention",
        publisher: "Research Press",
        volume: "12",
        issue: "3",
        pages: "44-58",
        workType: "journal_article",
        publishedAt: "2025-07-02",
        doi: "10.5555/abc.123",
      },
    });
    expect(canSourceSupportClaims(source)).toBe(true);
  });

  it("keeps Crossref metadata without an abstract out of claim evidence", async () => {
    const source = await resolveSource(
      {
        id: SOURCE_ID,
        userId: USER_ID,
        documentId: DOCUMENT_ID,
        locator: "10.5555/no-abstract",
      },
      dependencies(async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(
          JSON.stringify({
            status: "ok",
            message: {
              DOI: "10.5555/no-abstract",
              title: ["Metadata only"],
              author: [{ name: "Researcher" }],
              issued: { "date-parts": [[2024]] },
            },
          }),
        ),
      })),
    );

    expect(source).toMatchObject({
      verification: "metadata_only",
      evidenceScope: "none",
      contentText: null,
      contentSha256: null,
    });
    expect(canSourceSupportClaims(source)).toBe(false);
  });

  it("rejects Crossref responses for a different DOI", async () => {
    await expect(
      resolveSource(
        { userId: USER_ID, documentId: DOCUMENT_ID, locator: "10.5555/requested" },
        dependencies(async () => ({
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({
              status: "ok",
              message: { DOI: "10.5555/different", title: ["Wrong work"] },
            }),
          ),
        })),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects unsupported MIME types and explicit non-UTF-8 charsets", async () => {
    await expect(
      resolveSource(
        { userId: USER_ID, documentId: DOCUMENT_ID, locator: "https://papers.example.com/a" },
        dependencies(async () => ({
          status: 200,
          headers: { "content-type": "application/pdf" },
          body: Buffer.from("%PDF"),
        })),
      ),
    ).rejects.toMatchObject({ code: "unsupported_mime" });
    await expect(
      resolveSource(
        { userId: USER_ID, documentId: DOCUMENT_ID, locator: "https://papers.example.com/a" },
        dependencies(async () => ({
          status: 200,
          headers: { "content-type": "text/plain; charset=shift_jis" },
          body: Buffer.from("text"),
        })),
      ),
    ).rejects.toMatchObject({ code: "unsupported_mime" });
    await expect(
      resolveSource(
        { userId: USER_ID, documentId: DOCUMENT_ID, locator: "https://papers.example.com/a" },
        dependencies(async () => ({
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: Uint8Array.from([0xc3, 0x28]),
        })),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
