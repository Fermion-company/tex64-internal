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

/**
 * IPC "tex64:arxiv": the no-LLM path from the editor to arXiv.
 *   search { query, max }        → { papers }
 *   cite   { arxivId, activeFilePath } → { bibtex, key, bibPath, created, duplicate }
 * One search request is in flight at a time; a newer one aborts the older.
 */
const registerArxivHandlers = ({ ipcMain, workspace, isOwner }) => {
  let inflight = null;

  const search = async (payload) => {
    const query = typeof payload?.query === "string" ? payload.query.trim() : "";
    if (!query) return { papers: [] };
    if (query.length > MAX_QUERY_CHARS) throw new Error("The query is too long.");
    const max = Math.min(20, Math.max(1, Number(payload?.max) || 10));
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    try {
      const papers = await searchArxiv(query, { max, signal: controller.signal });
      return { papers };
    } catch (error) {
      if (controller.signal.aborted && inflight !== controller) return { papers: [], superseded: true };
      throw error;
    } finally {
      if (inflight === controller) inflight = null;
    }
  };

  const cite = async (payload) => {
    if (!workspace.getRootPath()) throw new Error("No workspace is open.");
    const arxivId = extractArxivId(payload?.arxivId);
    if (!arxivId || !/^[A-Za-z0-9.\-/]+$/.test(arxivId)) throw new Error("Invalid arXiv ID.");
    const entry = await fetchArxivEntry(arxivId);
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
