"use strict";

const {
  extractArxivId,
  searchArxiv,
  fetchArxivEntry,
  buildArxivKey,
  buildArxivBibtex,
} = require("../services/openprism/arxiv-service.cjs");
const { appendBibEntry } = require("../services/bib-append.cjs");

const MAX_QUERY_CHARS = 500;

/** Give network, rate-limit and timeout failures a code the renderer can word. */
const classify = (error) => {
  const message = String(error?.message || error);
  const cause = String(error?.cause?.code || error?.cause?.message || "");
  if (error?.name === "TimeoutError" || /timeout|timed out/i.test(message)) error.code = "TIMEOUT";
  else if (/\b429\b/.test(message)) error.code = "RATE_LIMIT";
  else if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH/i.test(`${message} ${cause}`)) error.code = "NETWORK";
  return error;
};

/**
 * IPC "tex64:arxiv": the no-LLM path from the editor to arXiv.
 *   search { query, max }        → { papers }
 *   cite   { arxivId, activeFilePath } → { bibtex, key, bibPath, created, duplicate }
 * One search request is in flight at a time; a newer one aborts the older.
 */
const registerArxivHandlers = ({ ipcMain, workspace, isOwner }) => {
  let inflight = null;

  // Words are ANDed. An empty result drops the last word once, no further.
  const search = async (payload) => {
    const query = typeof payload?.query === "string" ? payload.query.trim() : "";
    if (!query) return { papers: [] };
    if (query.length > MAX_QUERY_CHARS) throw new Error("The query is too long.");
    const max = Math.min(20, Math.max(1, Number(payload?.max) || 10));
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    try {
      const terms = query.split(/\s+/).filter(Boolean);
      let papers = await searchArxiv(query, { max, terms, signal: controller.signal });
      let relaxed = false;
      if (papers.length === 0 && terms.length > 1) {
        papers = await searchArxiv(query, { max, terms: terms.slice(0, -1), signal: controller.signal });
        relaxed = true;
      }
      return { papers, relaxed };
    } catch (error) {
      if (controller.signal.aborted && inflight !== controller) return { papers: [], superseded: true };
      throw classify(error);
    } finally {
      if (inflight === controller) inflight = null;
    }
  };

  const cite = async (payload) => {
    if (!workspace.getRootPath()) throw new Error("No workspace is open.");
    const arxivId = extractArxivId(payload?.arxivId);
    if (!arxivId || !/^[A-Za-z0-9.\-/]+$/.test(arxivId)) throw new Error("Invalid arXiv ID.");
    let entry;
    try {
      entry = await fetchArxivEntry(arxivId);
    } catch (error) {
      throw classify(error);
    }
    if (!entry) throw new Error("No arXiv metadata found.");
    const key = buildArxivKey(entry);
    const bibtex = buildArxivBibtex(entry);
    const activeFilePath = typeof payload?.activeFilePath === "string" ? payload.activeFilePath : "";
    const result = await appendBibEntry(workspace, { activeFilePath, key, bibtex });
    return { bibtex, key, ...result };
  };

  ipcMain.handle("tex64:arxiv", async (event, action, payload = {}) => {
    if (!isOwner(event)) return { ok: false, code: "INVALID_OWNER", error: "Invalid arXiv owner." };
    try {
      if (action === "search") return { ok: true, ...(await search(payload)) };
      if (action === "cite") return { ok: true, ...(await cite(payload)) };
      throw new Error(`Unknown arXiv action: ${action}`);
    } catch (error) {
      return { ok: false, code: error?.code || "ARXIV_ERROR", error: error?.message || String(error) };
    }
  });
};

module.exports = { registerArxivHandlers };
