/**
 * arXiv service — separated module matching OpenPrism's arxivService.js.
 *
 * Provides:
 *   - extractArxivId(input)
 *   - fetchArxivEntry(arxivId)
 *   - buildArxivBibtex(entry)
 *
 * Uses fast-xml-parser for XML parsing (same as OpenPrism).
 */

"use strict";

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

/**
 * Extract a clean arXiv ID from user input (URL, prefixed ID, etc.).
 */
const extractArxivId = (input) => {
  if (!input) return "";
  const trimmed = String(input).trim();
  const match = trimmed.match(/arxiv\.org\/(abs|pdf|e-print)\/([^?#/]+)/i);
  let id = match ? match[2] : trimmed;
  id = id.replace(/\.pdf$/i, "");
  id = id.replace(/v\d+$/i, "");
  return id;
};

/**
 * Fetch metadata for a single arXiv paper by ID.
 * Returns an entry object or null.
 */
const fetchArxivEntry = async (arxivId) => {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "tex64/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`arXiv API failed: ${res.status}`);
  }
  const xml = await res.text();
  const Parser = await ensureParser();
  const parser = new Parser({ ignoreAttributes: false });
  const data = parser.parse(xml);
  const entry = Array.isArray(data?.feed?.entry)
    ? data.feed.entry[0]
    : data?.feed?.entry;
  if (!entry) return null;

  const authors = Array.isArray(entry.author)
    ? entry.author
    : [entry.author].filter(Boolean);
  const authorNames = authors.map((a) => a?.name).filter(Boolean);
  const published = entry.published || "";
  const year = published ? String(published).slice(0, 4) : "";

  return {
    title: String(entry.title || "").replace(/\s+/g, " ").trim(),
    abstract: String(entry.summary || "").replace(/\s+/g, " ").trim(),
    authors: authorNames,
    year,
    id: String(entry.id || ""),
    arxivId,
  };
};

/**
 * Build a BibTeX entry from arXiv metadata.
 */
const buildArxivBibtex = (entry) => {
  if (!entry) return "";
  const key = `arxiv:${entry.arxivId}`;
  const author = entry.authors.join(" and ");
  const year = entry.year || "2024";
  return [
    `@article{${key},`,
    `  title={${entry.title}},`,
    `  author={${author}},`,
    `  journal={arXiv preprint arXiv:${entry.arxivId}},`,
    `  year={${year}}`,
    `}`,
  ].join("\n");
};

module.exports = { extractArxivId, fetchArxivEntry, buildArxivBibtex };
