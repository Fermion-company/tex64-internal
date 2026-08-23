import {
  ResolveSourceResultSchema,
  type ResolveSourceResult,
} from "./document-tools";
import {
  SourceProvenanceError,
  SourceRecordSchema,
  canSourceSupportClaims,
  canonicalCitationMetadataFromSource,
  type SourceRecord,
} from "@/server/sources";

export const MAX_SOURCE_TOOL_EXCERPT_CHARS = 12_000;

/**
 * Projects an immutable source record to the bounded, non-sensitive shape the
 * model may observe. The digest remains that of the complete stored evidence,
 * while the returned excerpt is deliberately capped.
 */
export function resolvedSourceToolResult(
  rawSource: SourceRecord,
): ResolveSourceResult {
  const source = SourceRecordSchema.parse(rawSource);
  const usableForClaims = canSourceSupportClaims(source);
  let metadata: Extract<
    ResolveSourceResult,
    { status: "resolved" }
  >["metadata"] = null;
  try {
    const canonical = canonicalCitationMetadataFromSource(source);
    metadata = {
      authors: canonical.authors,
      title: canonical.title,
      year: canonical.year,
      ...(canonical.publication
        ? { publication: canonical.publication }
        : {}),
      ...(canonical.publisher ? { publisher: canonical.publisher } : {}),
      ...(canonical.volume ? { volume: canonical.volume } : {}),
      ...(canonical.issue ? { issue: canonical.issue } : {}),
      ...(canonical.pages ? { pages: canonical.pages } : {}),
      ...(canonical.sourceType ? { sourceType: canonical.sourceType } : {}),
      ...(canonical.sourceLanguage
        ? { sourceLanguage: canonical.sourceLanguage }
        : {}),
      ...(canonical.doi ? { doi: canonical.doi } : {}),
      ...(canonical.url ? { url: canonical.url } : {}),
    };
  } catch (error) {
    if (!(error instanceof SourceProvenanceError)) throw error;
    // Verified evidence can still lack complete bibliographic metadata.
  }

  return ResolveSourceResultSchema.parse({
    status: "resolved",
    sourceId: source.id,
    canonicalLocator: source.canonicalLocator,
    metadata,
    evidenceScope: source.evidenceScope,
    excerpt: usableForClaims
      ? source.contentText?.slice(0, MAX_SOURCE_TOOL_EXCERPT_CHARS)
      : null,
    contentSha256: usableForClaims ? source.contentSha256 : null,
    usableForClaims,
    citationReady: usableForClaims && metadata !== null,
  });
}
