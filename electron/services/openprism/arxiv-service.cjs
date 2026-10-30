/**
 * arXiv service — separated module matching OpenPrism's arxivService.js.
 *
 * Provides:
 *   - extractArxivId(input)
 *   - searchArxiv(query, { max, signal })
 *   - fetchArxivEntry(arxivId)
 *   - buildArxivKey(entry)
 *   - buildArxivBibtex(entry)
 *
 * Shared by the Axiom tools (arxiv_search / arxiv_bibtex) and the direct
 * "find related papers" IPC. Uses fast-xml-parser for XML parsing.
 */

"use strict";

const ARXIV_API = "https://export.arxiv.org/api/query";
const REQUEST_TIMEOUT_MS = 30_000;

let XMLParser = null;

const ensureParser = async () => {
  if (XMLParser) return XMLParser;
  try {
    const mod = require("fast-xml-parser");
    XMLParser = mod.XMLParser;
  } catch {
    // fallback: dynamic import in case module is ESM-only
    const mod = await import("fast-xml-parser");
    XMLParser = mod.XMLParser;
  }
  return XMLParser;
};

const combineSignal = (signal) => {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
};

const fetchFeedEntries = async (url, signal) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "tex64/1.0" },
    signal: combineSignal(signal),
  });
  if (!res.ok) {
    throw new Error(`arXiv API failed: ${res.status}`);
  }
  const xml = await res.text();
  const Parser = await ensureParser();
  const parser = new Parser({ ignoreAttributes: false });
  const data = parser.parse(xml);
  return Array.isArray(data?.feed?.entry)
    ? data.feed.entry
    : data?.feed?.entry
      ? [data.feed.entry]
      : [];
};

const collapse = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** arXiv id without version, taken from the entry's id URL. */
const idFromEntryUrl = (url) => extractArxivId(url);

/** The id with its version suffix (what the API returned). */
const versionedIdFromEntryUrl = (url) => {
  const match = String(url || "").match(/arxiv\.org\/abs\/([^?#]+)/i);
  return match ? match[1] : "";
};

const normalizeEntry = (entry) => {
  const authors = Array.isArray(entry.author)
    ? entry.author
    : [entry.author].filter(Boolean);
  const authorNames = authors.map((a) => collapse(a?.name)).filter(Boolean);
  const published = entry.published || "";
  const year = published ? String(published).slice(0, 4) : "";
  const id = String(entry.id || "");
  const primaryClass = collapse(entry["arxiv:primary_category"]?.["@_term"]);
  return {
    title: collapse(entry.title),
    abstract: collapse(entry.summary),
    authors: authorNames,
    year,
    id,
    url: id,
    arxivId: idFromEntryUrl(id),
    versionedId: versionedIdFromEntryUrl(id),
    primaryClass,
  };
};

/**
 * Extract a clean arXiv ID from user input (URL, prefixed ID, etc.).
 */
const extractArxivId = (input) => {
  if (!input) return "";
  const trimmed = String(input).trim();
  const match = trimmed.match(/arxiv\.org\/(abs|pdf|e-print)\/([^?#]+)/i);
  let id = match ? match[2] : trimmed.replace(/^arxiv:/i, "");
  id = id.replace(/\.pdf$/i, "");
  id = id.replace(/v\d+$/i, "");
  return id;
};

/**
 * Search arXiv (all fields). Returns normalized entries, most relevant first.
 * `query` is sent as one `all:` clause (arXiv treats its words as OR);
 * `options.terms` instead ANDs each word: `all:w1 AND all:w2 …`.
 */
const searchArxiv = async (query, options = {}) => {
  const terms = Array.isArray(options.terms) ? options.terms.map(collapse).filter(Boolean) : [];
  const text = collapse(query);
  if (!text && terms.length === 0) return [];
  const max = Math.min(20, Math.max(1, Number(options.max) || 5));
  const searchQuery = terms.length > 0
    ? terms.map((term) => `all:${encodeURIComponent(term)}`).join("+AND+")
    : `all:${encodeURIComponent(text)}`;
  const url = `${ARXIV_API}?search_query=${searchQuery}&start=0&max_results=${max}`;
  const entries = await fetchFeedEntries(url, options.signal);
  return entries.map(normalizeEntry);
};

/**
 * Fetch metadata for a single arXiv paper by ID.
 * Returns an entry object or null.
 */
const fetchArxivEntry = async (arxivId, options = {}) => {
  const url = `${ARXIV_API}?id_list=${encodeURIComponent(arxivId)}`;
  const entries = await fetchFeedEntries(url, options.signal);
  if (entries.length === 0) return null;
  return { ...normalizeEntry(entries[0]), arxivId };
};

/** Last name of an author written "First Last" or "Last, First"; ASCII, lowercase. */
const asciiLastName = (fullName) => {
  const name = collapse(fullName);
  if (!name) return "";
  const last = name.includes(",") ? name.split(",")[0] : name.split(" ").pop();
  return String(last)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z]/g, "")
    .toLowerCase();
};

/**
 * Citation key: <first author last name><year><last 4 digits of the id>.
 * Falls back to "arxiv" when the author name has no ASCII letters.
 */
const buildArxivKey = (entry) => {
  if (!entry) return "";
  const author = asciiLastName(entry.authors?.[0]) || "arxiv";
  const year = String(entry.year || "").replace(/\D/g, "");
  const digits = String(entry.arxivId || "").replace(/\D/g, "");
  return `${author}${year}${digits.slice(-4)}`;
};


/**
 * Build a BibTeX entry from arXiv metadata.
 */
const buildArxivBibtex = (entry) => {
  if (!entry) return "";
  const key = buildArxivKey(entry);
  const author = (entry.authors || []).map(collapse).join(" and ");
  const year = entry.year || "2024";
  const arxivId = entry.arxivId;
  const lines = [
    `@article{${key},`,
    `  title={${collapse(entry.title)}},`,
    `  author={${author}},`,
    `  journal={arXiv preprint arXiv:${arxivId}},`,
    `  year={${year}},`,
    `  eprint={${arxivId}},`,
    `  archivePrefix={arXiv},`,
  ];
  if (entry.primaryClass) lines.push(`  primaryClass={${entry.primaryClass}},`);
  lines.push(`  url={https://arxiv.org/abs/${arxivId}}`, `}`);
  return lines.join("\n");
};

module.exports = { extractArxivId, searchArxiv, fetchArxivEntry, buildArxivKey, buildArxivBibtex };
