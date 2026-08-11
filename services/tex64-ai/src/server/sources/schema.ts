import { createHash } from "node:crypto";
import { z } from "zod";

const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const CanonicalSourceLocatorSchema = z
  .string()
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "Source locators must use HTTPS" });
    }
    if (url.port && url.port !== "443") {
      context.addIssue({ code: "custom", message: "Source locators must use HTTPS port 443" });
    }
    if (url.username || url.password || url.hash) {
      context.addIssue({
        code: "custom",
        message: "Canonical source locators cannot contain credentials or fragments",
      });
    }
  });
export type CanonicalSourceLocator = z.infer<typeof CanonicalSourceLocatorSchema>;

export const SourceKindSchema = z.enum(["https", "doi"]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SourceVerificationSchema = z.enum(["verified_content", "metadata_only"]);
export type SourceVerification = z.infer<typeof SourceVerificationSchema>;

export const SourceEvidenceScopeSchema = z.enum(["full_text", "abstract", "none"]);
export type SourceEvidenceScope = z.infer<typeof SourceEvidenceScopeSchema>;

export const SourceAuthorSchema = z.strictObject({
  name: z.string().min(1).max(1_000),
  orcid: z.string().url().max(2_000).optional(),
});
export type SourceAuthor = z.infer<typeof SourceAuthorSchema>;

export const SourceWorkTypeSchema = z.enum([
  "journal_article",
  "proceedings_article",
  "book",
  "book_chapter",
  "report",
  "thesis",
  "web",
  "other",
]);
export type SourceWorkType = z.infer<typeof SourceWorkTypeSchema>;

export const SourceMetadataSchema = z.strictObject({
  provider: z.enum(["origin", "crossref"]),
  title: z.string().min(1).max(10_000).optional(),
  authors: z.array(SourceAuthorSchema).max(1_000).default([]),
  publication: z.string().min(1).max(2_000).optional(),
  publisher: z.string().min(1).max(2_000).optional(),
  volume: z.string().min(1).max(1_000).optional(),
  issue: z.string().min(1).max(1_000).optional(),
  pages: z.string().min(1).max(1_000).optional(),
  workType: SourceWorkTypeSchema.optional(),
  publishedAt: z.string().max(64).optional(),
  language: z.string().max(64).optional(),
  doi: z.string().min(1).max(500).optional(),
  contentType: z.string().min(1).max(255),
});
export type SourceMetadata = z.infer<typeof SourceMetadataSchema>;

/**
 * A source is claim-usable only when `verification` is `verified_content` and
 * it carries the exact normalized content whose digest is recorded here.
 * Crossref metadata without an abstract is intentionally metadata-only.
 */
export const SourceRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: UuidSchema,
    userId: UuidSchema,
    documentId: UuidSchema,
    kind: SourceKindSchema,
    canonicalLocator: CanonicalSourceLocatorSchema,
    resolvedLocator: CanonicalSourceLocatorSchema,
    verification: SourceVerificationSchema,
    evidenceScope: SourceEvidenceScopeSchema,
    contentText: z.string().min(1).max(2_000_000).nullable(),
    contentSha256: Sha256Schema.nullable(),
    metadata: SourceMetadataSchema,
    fetchedAt: TimestampSchema,
  })
  .superRefine((record, context) => {
    const hasContent = record.contentText !== null && record.contentSha256 !== null;
    if ((record.contentText === null) !== (record.contentSha256 === null)) {
      context.addIssue({
        code: "custom",
        path: ["contentSha256"],
        message: "Content text and its SHA-256 digest must be present together",
      });
    }
    if (
      record.contentText !== null &&
      record.contentSha256 !== null &&
      createHash("sha256").update(record.contentText, "utf8").digest("hex") !==
        record.contentSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["contentSha256"],
        message: "Content SHA-256 does not match the normalized source text",
      });
    }
    if (record.verification === "metadata_only") {
      if (hasContent || record.evidenceScope !== "none") {
        context.addIssue({
          code: "custom",
          path: ["verification"],
          message: "Metadata-only records cannot be used as claim evidence",
        });
      }
    } else if (!hasContent || record.evidenceScope === "none") {
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message: "Verified records require normalized evidence content",
      });
    }
    if (record.kind === "doi" && record.metadata.provider !== "crossref") {
      context.addIssue({
        code: "custom",
        path: ["metadata", "provider"],
        message: "DOI records must carry Crossref provenance",
      });
    }
    if (record.kind === "doi" && new URL(record.canonicalLocator).hostname !== "doi.org") {
      context.addIssue({
        code: "custom",
        path: ["canonicalLocator"],
        message: "DOI records must use the canonical doi.org locator",
      });
    }
  });
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export const ResolveSourceInputSchema = z.strictObject({
  id: UuidSchema.optional(),
  userId: UuidSchema,
  documentId: UuidSchema,
  locator: z.string().trim().min(1).max(4_096),
});
export type ResolveSourceInput = z.infer<typeof ResolveSourceInputSchema>;

export function canSourceSupportClaims(
  source: Pick<SourceRecord, "verification" | "evidenceScope" | "contentText" | "contentSha256">,
): boolean {
  return (
    source.verification === "verified_content" &&
    source.evidenceScope !== "none" &&
    source.contentText !== null &&
    source.contentSha256 !== null
  );
}
