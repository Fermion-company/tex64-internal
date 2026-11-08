"use strict";

const arxivService = require("../services/openprism/arxiv-service.cjs");
const { extractArxivId, buildArxivKey, buildArxivBibtex } = arxivService;
const { appendBibEntry, resolveBibTarget } = require("../services/arxiv-bib.cjs");
const { createWorkspaceGuard } = require("../services/bib-append.cjs");

const MAX_QUERY_CHARS = 500;

/**
 * Network, rate-limit and timeout failures as a plain { code, message }: the
 * renderer words them. The original exception is not touched (a DOMException's
 * `code` is read-only).
 */
const classify = (error) => {
  const message = String(error?.message || error);
  const cause = String(error?.cause?.code || error?.cause?.message || "");
  let code = "ARXIV_ERROR";
  if (error?.name === "TimeoutError" || /timeout|timed out/i.test(message)) code = "TIMEOUT";
  else if (/\b(429|503)\b/.test(message)) code = "RATE_LIMIT";
  else if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH/i.test(`${message} ${cause}`)) code = "NETWORK";
  return { code, message };
};

/**
 * IPC "tex64:arxiv": the no-LLM path from the editor to arXiv.
 *   search { query, max }        → { papers }
 *   cite   { arxivId, activeFilePath, documentMainFile? } → { bibtex, key, bibPath, created, duplicate }
 * One search request is in flight at a time; a newer one aborts the older.
 * `key` is the key actually in the .bib (another paper may hold the generated
 * one). `service` replaces the network calls in tests.
 */
const registerArxivHandlers = ({ ipcMain, workspace, isOwner, state, withWorkspaceMutation, service: overrides = {} }) => {
  const service = { ...arxivService, ...overrides };
  let inflight = null;
  const guard = createWorkspaceGuard({ workspace, state, withWorkspaceMutation });

  // Words are ANDed; one request per call. An empty result stays empty (the
  // renderer says so instead of dropping words).
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
      const papers = await service.searchArxiv(query, { max, terms, signal: controller.signal });
      return { papers, query: terms.join(" ") };
    } catch (error) {
      if (controller.signal.aborted && inflight !== controller) return { papers: [], superseded: true };
      throw classify(error);
    } finally {
      if (inflight === controller) inflight = null;
    }
  };

  // The target is decided before arXiv is asked; the append runs only if the
  // same workspace session is still open when the answer arrives.
  const cite = async (payload) => {
    const session = guard.capture();
    if (!session.root) throw new Error("No workspace is open.");
    const arxivId = extractArxivId(payload?.arxivId);
    if (!arxivId || !/^[A-Za-z0-9.\-/]+$/.test(arxivId)) throw new Error("Invalid arXiv ID.");
    const text = (value) => (typeof value === "string" ? value : "");
    const target = await resolveBibTarget(workspace, text(payload?.activeFilePath), {
      documentMainFile: text(payload?.documentMainFile),
    });
    let entry;
    try {
      entry = await service.fetchArxivEntry(arxivId);
    } catch (error) {
      throw classify(error);
    }
    if (!entry) throw new Error("No arXiv metadata found.");
    const key = buildArxivKey(entry);
    const bibtex = buildArxivBibtex(entry);
    const result = await guard.commit(session, () => appendBibEntry(workspace, { target, key, bibtex }));
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
