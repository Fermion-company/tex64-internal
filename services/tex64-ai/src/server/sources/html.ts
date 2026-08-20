import { normalizeDoi } from "./canonicalize";

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  rsquo: "’",
});

function decodeEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const point = Number.parseInt(body.slice(2), 16);
      return Number.isSafeInteger(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    }
    if (body.startsWith("#")) {
      const point = Number.parseInt(body.slice(1), 10);
      return Number.isSafeInteger(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

function normalizePlainText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .normalize("NFC");
}

export function htmlToPlainText(html: string): string {
  const withoutExecutableContent = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
  const withBreaks = withoutExecutableContent
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(
      /<\/?(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]*>/g, " ");
  return normalizePlainText(decodeEntities(withBreaks));
}

function extractHtmlTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match?.[1]) return undefined;
  const title = htmlToPlainText(match[1]);
  return title ? title.slice(0, 10_000) : undefined;
}

export function normalizeTextContent(text: string): string {
  return normalizePlainText(decodeEntities(text));
}

export interface HtmlBibliographicMetadata {
  title?: string;
  authors: string[];
  publication?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  language?: string;
  publishedAt?: string;
  doi?: string;
}

interface HtmlMetaEntry {
  key: string;
  content: string;
}

const MAX_META_TAGS = 512;
const MAX_META_TAG_LENGTH = 16_384;
const MAX_META_CONTENT_LENGTH = 20_000;

function metaEntries(html: string): HtmlMetaEntry[] {
  const entries: HtmlMetaEntry[] = [];
  const metaPattern = /<meta\b[^>]{0,16384}>/giu;
  for (const match of html.matchAll(metaPattern)) {
    if (entries.length >= MAX_META_TAGS) break;
    const tag = match[0];
    if (tag.length > MAX_META_TAG_LENGTH) continue;
    const attributes = new Map<string, string>();
    const attributePattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
    for (const attribute of tag.slice(5, -1).matchAll(attributePattern)) {
      const name = attribute[1]?.toLowerCase();
      if (!name || attributes.has(name)) continue;
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      attributes.set(name, value);
    }
    const key = (attributes.get("name") ?? attributes.get("property"))?.trim().toLowerCase();
    const rawContent = attributes.get("content");
    if (!key || rawContent === undefined || rawContent.length > MAX_META_CONTENT_LENGTH) continue;
    const content = normalizeTextContent(rawContent);
    if (content) entries.push({ key, content });
  }
  return entries;
}

function firstMetaValue(
  entries: readonly HtmlMetaEntry[],
  keys: readonly string[],
  maximum: number,
): string | undefined {
  for (const key of keys) {
    const value = entries.find((entry) => entry.key === key)?.content;
    if (value && value.length <= maximum) return value;
  }
  return undefined;
}

function normalizedPublishedAt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?/.exec(value);
  if (!match?.[1]) return undefined;
  const month = match[2] ? Number(match[2]) : undefined;
  const day = match[3] ? Number(match[3]) : undefined;
  if (month !== undefined && (month < 1 || month > 12)) return undefined;
  if (day !== undefined && (day < 1 || day > 31)) return undefined;
  return [match[1], month, day]
    .filter((part): part is string | number => part !== undefined)
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join("-");
}

/**
 * Reads only inert HTML meta attributes. Scripts and JSON-LD are deliberately
 * excluded from the provenance surface and are never executed or interpreted.
 */
export function extractHtmlBibliographicMetadata(html: string): HtmlBibliographicMetadata {
  const entries = metaEntries(html);
  const title =
    firstMetaValue(entries, ["citation_title"], 10_000) ??
    firstMetaValue(
      entries,
      ["dc.title", "dcterms.title", "og:title", "twitter:title"],
      10_000,
    ) ??
    extractHtmlTitle(html);

  const primaryAuthors = entries.filter((entry) => entry.key === "citation_author");
  const fallbackAuthorKeys = new Set([
    "dc.creator",
    "dc.creator.personalname",
    "dcterms.creator",
    "author",
  ]);
  const authorEntries = primaryAuthors.length > 0
    ? primaryAuthors
    : entries.filter((entry) => fallbackAuthorKeys.has(entry.key));
  const authorKeys = new Set<string>();
  const authors: string[] = [];
  for (const entry of authorEntries) {
    if (entry.content.length > 1_000) continue;
    const dedupeKey = entry.content.toLocaleLowerCase("en-US");
    if (authorKeys.has(dedupeKey)) continue;
    authorKeys.add(dedupeKey);
    authors.push(entry.content);
    if (authors.length >= 100) break;
  }

  const publication = firstMetaValue(
    entries,
    [
      "citation_journal_title",
      "citation_conference_title",
      "citation_publisher",
      "dc.source",
      "dcterms.ispartof",
      "og:site_name",
    ],
    2_000,
  );
  const publishedAt = normalizedPublishedAt(
    firstMetaValue(
      entries,
      [
        "citation_publication_date",
        "citation_date",
        "dc.date",
        "dcterms.date",
        "dcterms.issued",
        "article:published_time",
        "date",
      ],
      64,
    ),
  );
  const publisher = firstMetaValue(
    entries,
    ["citation_publisher", "dc.publisher", "dcterms.publisher"],
    2_000,
  );
  const volume = firstMetaValue(entries, ["citation_volume"], 1_000);
  const issue = firstMetaValue(entries, ["citation_issue"], 1_000);
  const firstPage = firstMetaValue(entries, ["citation_firstpage"], 500);
  const lastPage = firstMetaValue(entries, ["citation_lastpage"], 500);
  const pages =
    firstMetaValue(entries, ["citation_pages"], 1_000) ??
    (firstPage && lastPage ? `${firstPage}-${lastPage}` : firstPage);
  const language = firstMetaValue(
    entries,
    ["citation_language", "dc.language", "dcterms.language"],
    64,
  );
  let doi: string | undefined;
  for (const key of ["citation_doi", "dc.identifier", "dcterms.identifier"]) {
    for (const entry of entries) {
      if (entry.key !== key) continue;
      doi = normalizeDoi(entry.content);
      if (doi) break;
    }
    if (doi) break;
  }

  return {
    ...(title ? { title } : {}),
    authors,
    ...(publication ? { publication } : {}),
    ...(publisher ? { publisher } : {}),
    ...(volume ? { volume } : {}),
    ...(issue ? { issue } : {}),
    ...(pages ? { pages } : {}),
    ...(language ? { language } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(doi ? { doi } : {}),
  };
}
