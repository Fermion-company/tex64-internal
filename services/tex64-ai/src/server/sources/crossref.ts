import { z } from "zod";
import { normalizeDoi } from "./canonicalize";
import { SourceResolutionError } from "./errors";
import { htmlToPlainText } from "./html";
import type { SourceMetadata } from "./schema";
import type { SourceWorkType } from "./schema";

const CrossrefDateSchema = z.object({
  "date-parts": z.array(z.array(z.number().int()).min(1).max(3)).min(1).max(10),
});

const CrossrefAuthorSchema = z.object({
  given: z.string().optional(),
  family: z.string().optional(),
  name: z.string().optional(),
  ORCID: z.string().optional(),
});

const CrossrefWorkSchema = z.object({
  DOI: z.string(),
  title: z.array(z.string()).min(1),
  author: z.array(CrossrefAuthorSchema).optional(),
  publisher: z.string().optional(),
  "container-title": z.array(z.string()).optional(),
  volume: z.string().optional(),
  issue: z.string().optional(),
  page: z.string().optional(),
  type: z.string().optional(),
  "published-print": CrossrefDateSchema.optional(),
  "published-online": CrossrefDateSchema.optional(),
  issued: CrossrefDateSchema.optional(),
  language: z.string().optional(),
  abstract: z.string().optional(),
});

const CrossrefEnvelopeSchema = z.object({
  status: z.literal("ok"),
  message: CrossrefWorkSchema,
});

export interface ParsedCrossrefWork {
  metadata: SourceMetadata;
  abstractText: string | null;
}

function normalizedField(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  const normalized = htmlToPlainText(value);
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function normalizeOrcid(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "orcid.org") return undefined;
    url.protocol = "https:";
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function sourceWorkType(value: string | undefined): SourceWorkType {
  switch (value) {
    case "journal-article":
      return "journal_article";
    case "proceedings-article":
      return "proceedings_article";
    case "book":
    case "monograph":
    case "reference-book":
      return "book";
    case "book-chapter":
    case "book-section":
    case "reference-entry":
      return "book_chapter";
    case "report":
    case "report-series":
      return "report";
    case "dissertation":
      return "thesis";
    case "posted-content":
    case "web-content":
      return "web";
    default:
      return "other";
  }
}

function publishedAt(work: z.infer<typeof CrossrefWorkSchema>): string | undefined {
  const parts =
    work["published-print"]?.["date-parts"][0] ??
    work["published-online"]?.["date-parts"][0] ??
    work.issued?.["date-parts"][0];
  const year = parts?.[0];
  if (!year || year < 1 || year > 9999) return undefined;
  const month = parts[1];
  const day = parts[2];
  if (month !== undefined && (month < 1 || month > 12)) return String(year).padStart(4, "0");
  if (day !== undefined && (day < 1 || day > 31)) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  }
  return [year, month, day]
    .filter((part): part is number => part !== undefined)
    .map((part, index) => (index === 0 ? String(part).padStart(4, "0") : String(part).padStart(2, "0")))
    .join("-");
}

export function parseCrossrefWork(payload: unknown, requestedDoi: string): ParsedCrossrefWork {
  const parsed = CrossrefEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SourceResolutionError(
      "invalid_response",
      "Crossref did not return structured work metadata",
    );
  }
  const work = parsed.data.message;
  const doi = normalizeDoi(work.DOI);
  if (!doi || doi !== requestedDoi) {
    throw new SourceResolutionError("invalid_response", "Crossref returned a different DOI");
  }
  const title = normalizedField(work.title[0], 10_000);
  if (!title) {
    throw new SourceResolutionError("invalid_response", "Crossref metadata has no usable title");
  }

  const authors = (work.author ?? []).flatMap((author) => {
    const name = normalizedField(
      author.name ?? [author.given, author.family].filter(Boolean).join(" "),
      1_000,
    );
    return name ? [{ name, orcid: normalizeOrcid(author.ORCID) }] : [];
  });
  const abstractText = normalizedField(work.abstract, 2_000_000) ?? null;

  return {
    metadata: {
      provider: "crossref",
      title,
      authors,
      publication: normalizedField(work["container-title"]?.[0], 2_000),
      publisher: normalizedField(work.publisher, 2_000),
      volume: normalizedField(work.volume, 1_000),
      issue: normalizedField(work.issue, 1_000),
      pages: normalizedField(work.page, 1_000),
      workType: sourceWorkType(work.type),
      publishedAt: publishedAt(work),
      language: normalizedField(work.language, 64),
      doi,
      contentType: "application/json",
    },
    abstractText,
  };
}
