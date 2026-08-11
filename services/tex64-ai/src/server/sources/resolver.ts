import { createHash, randomUUID } from "node:crypto";
import { canonicalizeSourceLocator } from "./canonicalize";
import { parseCrossrefWork } from "./crossref";
import { SourceResolutionError } from "./errors";
import {
  extractHtmlBibliographicMetadata,
  htmlToPlainText,
  normalizeTextContent,
} from "./html";
import {
  safeFetchHttps,
  type SafeFetchDependencies,
  type SafeFetchResult,
} from "./http";
import {
  ResolveSourceInputSchema,
  SourceRecordSchema,
  type ResolveSourceInput,
  type SourceMetadata,
  type SourceRecord,
} from "./schema";

export interface SourceResolverDependencies extends SafeFetchDependencies {
  now?: () => Date;
  randomUuid?: () => string;
}

interface ParsedContentType {
  mime: string;
  charset?: string;
}

function firstHeader(
  headers: SafeFetchResult["headers"],
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseContentType(response: SafeFetchResult): ParsedContentType {
  const value = firstHeader(response.headers, "content-type");
  if (!value) {
    throw new SourceResolutionError("unsupported_mime", "The source did not declare a MIME type");
  }
  const [mimePart, ...parameters] = value.split(";");
  const mime = mimePart?.trim().toLowerCase();
  if (!mime || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) {
    throw new SourceResolutionError("unsupported_mime", "The source MIME type is invalid");
  }
  const charsets: string[] = [];
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*"?([^";\s]+)"?\s*$/i.exec(parameter);
    if (match?.[1]) charsets.push(match[1].toLowerCase());
  }
  if (
    charsets.some(
      (charset) => charset !== "utf-8" && charset !== "utf8" && charset !== "us-ascii",
    )
  ) {
    throw new SourceResolutionError("unsupported_mime", "Only UTF-8 source text is supported");
  }
  const normalizedCharsets = new Set(
    charsets.map((charset) => (charset === "utf8" ? "utf-8" : charset)),
  );
  if (normalizedCharsets.size > 1) {
    throw new SourceResolutionError("unsupported_mime", "The source charset is ambiguous");
  }
  return { mime, charset: normalizedCharsets.values().next().value };
}

function decodeUtf8(body: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new SourceResolutionError("invalid_response", "The source body is not valid UTF-8");
  }
}

function contentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function parsedRecord(record: SourceRecord): SourceRecord {
  const result = SourceRecordSchema.safeParse(record);
  if (!result.success) {
    throw new SourceResolutionError("invalid_response", "The resolved source record is invalid");
  }
  return result.data;
}

async function resolveDoi(
  input: ResolveSourceInput,
  canonicalLocator: string,
  doi: string,
  dependencies: SourceResolverDependencies,
): Promise<SourceRecord> {
  const endpoint = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const response = await safeFetchHttps(endpoint, dependencies, {
    accept: "application/json",
    maxBytes: 1024 * 1024,
    maxRedirects: 3,
    userAgent: "TeX64-SourceResolver/1.0 (Crossref metadata lookup)",
  });
  const { mime } = parseContentType(response);
  if (mime !== "application/json" && !mime.endsWith("+json")) {
    throw new SourceResolutionError("unsupported_mime", "Crossref did not return JSON");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeUtf8(response.body));
  } catch (error) {
    if (error instanceof SourceResolutionError) throw error;
    throw new SourceResolutionError("invalid_response", "Crossref returned invalid JSON");
  }
  const work = parseCrossrefWork(payload, doi);
  const contentText = work.abstractText;
  const verification = contentText ? "verified_content" : "metadata_only";

  return parsedRecord({
    schemaVersion: 1,
    id: input.id ?? (dependencies.randomUuid ?? randomUUID)(),
    userId: input.userId,
    documentId: input.documentId,
    kind: "doi",
    canonicalLocator,
    resolvedLocator: response.finalUrl,
    verification,
    evidenceScope: contentText ? "abstract" : "none",
    contentText,
    contentSha256: contentText ? contentDigest(contentText) : null,
    metadata: work.metadata,
    fetchedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  });
}

async function resolveHttps(
  input: ResolveSourceInput,
  canonicalLocator: string,
  dependencies: SourceResolverDependencies,
): Promise<SourceRecord> {
  const response = await safeFetchHttps(canonicalLocator, dependencies);
  const { mime } = parseContentType(response);
  const raw = decodeUtf8(response.body);
  let contentText: string;
  let bibliographic: ReturnType<typeof extractHtmlBibliographicMetadata> = { authors: [] };
  if (mime === "text/html" || mime === "application/xhtml+xml") {
    bibliographic = extractHtmlBibliographicMetadata(raw);
    contentText = htmlToPlainText(raw);
  } else if (mime === "text/plain") {
    contentText = normalizeTextContent(raw);
  } else {
    throw new SourceResolutionError(
      "unsupported_mime",
      "Only HTML, XHTML and plain-text sources are supported",
    );
  }
  if (!contentText) {
    throw new SourceResolutionError("empty_content", "The source contains no usable text");
  }

  const metadata: SourceMetadata = {
    provider: "origin",
    ...bibliographic,
    authors: bibliographic.authors.map((name) => ({ name })),
    workType: bibliographic.publication ? "journal_article" : "web",
    contentType: mime,
  };
  return parsedRecord({
    schemaVersion: 1,
    id: input.id ?? (dependencies.randomUuid ?? randomUUID)(),
    userId: input.userId,
    documentId: input.documentId,
    kind: "https",
    canonicalLocator,
    resolvedLocator: response.finalUrl,
    verification: "verified_content",
    evidenceScope: "full_text",
    contentText,
    contentSha256: contentDigest(contentText),
    metadata,
    fetchedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  });
}

export async function resolveSource(
  rawInput: ResolveSourceInput,
  dependencies: SourceResolverDependencies = {},
): Promise<SourceRecord> {
  const parsedInput = ResolveSourceInputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    throw new SourceResolutionError("invalid_locator", "The source request is invalid");
  }
  const input = parsedInput.data;
  const canonical = canonicalizeSourceLocator(input.locator);
  if (canonical.kind === "doi") {
    return resolveDoi(
      input,
      canonical.canonicalLocator,
      canonical.doi!,
      dependencies,
    );
  }
  return resolveHttps(input, canonical.canonicalLocator, dependencies);
}
