/**
 * Tool definitions — Plain objects with JSON Schema.
 *
 * Exactly 7 tools matching the OpenPrism reference implementation:
 *   read_file, list_files, propose_patch, apply_patch,
 *   get_compile_log, arxiv_search, arxiv_bibtex
 *
 * Each tool is a plain object with:
 *   - type: "function"
 *   - function: { name, description, parameters (JSON Schema) }
 *   - execute: async (args) => string
 *
 * No LangChain dependency.
 */

"use strict";

const { existsSync, readFileSync } = require("fs");
const nodePath = require("path");
const { extractArxivId, fetchArxivEntry, buildArxivBibtex } = require("./arxiv-service.cjs");
const { TOOL_STATUS_LABELS } = require("../agent-core-utils.cjs");

/**
 * Wrap a tool function so it emits IPC status events before/after execution.
 */
const wrapWithIpc = (name, fn, service, conversationId) => {
  return async (args) => {
    const label = TOOL_STATUS_LABELS[name] || name;
    service.sendToRenderer("agent:tool", {
      name,
      label,
      summary: "running",
      conversationId,
    });
    try {
      const result = await fn(args);
      service.sendToRenderer("agent:tool", {
        name,
        label,
        summary: result?.error ?? "ok",
        conversationId,
      });
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (err) {
      const errMsg = err?.message ?? String(err);
      service.sendToRenderer("agent:tool", {
        name,
        label,
        summary: errMsg,
        conversationId,
      });
      return JSON.stringify({ error: errMsg });
    }
  };
};

/**
 * Load fast-xml-parser lazily and parse arXiv Atom XML.
 */
let _XMLParser = null;
const getXMLParser = async () => {
  if (_XMLParser) return _XMLParser;
  try {
    const mod = require("fast-xml-parser");
    _XMLParser = mod.XMLParser;
  } catch {
    const mod = await import("fast-xml-parser");
    _XMLParser = mod.XMLParser;
  }
  return _XMLParser;
};

/**
 * Build the 7 tools for a given agent run.
 *
 * Returns an array of plain tool objects. Each object has:
 *   - type, function (for OpenAI API `tools` param)
 *   - execute (for local invocation)
 *
 * @param {object} service  — AgentService instance
 * @param {string} conversationId
 * @param {object} policy   — resolved agent policy
 * @returns {Array<{ type: string, function: object, execute: (args: object) => Promise<string> }>}
 */
const buildTools = (service, conversationId, policy) => {
  const {
    handleListFiles,
    handleProposeWrite,
    handleReadFile,
  } = require("../agent-tools-file.cjs");

  const rootPath = service.workspace.getRootPath() || "";

  const make = (name, description, parameters, fn) => ({
    type: "function",
    function: { name, description, parameters },
    execute: wrapWithIpc(name, fn, service, conversationId),
  });

  // ---- 1. read_file ----
  const readFileTool = make(
    "read_file",
    "Read a UTF-8 file from the project. Input: { path } (relative to project root).",
    {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async (args) => {
      const result = await handleReadFile(service, args, policy, conversationId);
      if (result?.error) return JSON.stringify(result);
      const content = typeof result?.content === "string" ? result.content : "";
      return content.slice(0, 20000);
    },
  );

  // ---- 2. list_files ----
  const listFilesTool = make(
    "list_files",
    "List files under a directory. Input: { dir } (relative path, optional).",
    {
      type: "object",
      properties: { dir: { type: "string" } },
    },
    (args) => handleListFiles(service, { directory: args.dir }, policy, conversationId),
  );

  // ---- 3. propose_patch (full file rewrite) ----
  const proposePatchTool = make(
    "propose_patch",
    "Propose a full file rewrite. Input: { path, content }. This does NOT write. It returns a patch for user confirmation.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    async (args) => {
      const result = await handleProposeWrite(
        service,
        { path: args.path, content: args.content, summary: "Full file rewrite" },
        policy,
        conversationId,
      );
      if (result?.error) return JSON.stringify(result);
      return `Patch prepared for ${args.path}. Awaiting user confirmation.`;
    },
  );

  // ---- 4. apply_patch (unified diff) ----
  const applyPatchTool = make(
    "apply_patch",
    "Apply a unified diff to a file and propose changes. Input: { patch, path? }. This does NOT write.",
    {
      type: "object",
      properties: {
        patch: { type: "string" },
        path: { type: "string" },
      },
      required: ["patch"],
    },
    async (args) => {
      let targetPath = args.path;
      if (!targetPath) {
        const match = args.patch.match(/^---\s+a\/(.+)/m);
        if (match) targetPath = match[1];
      }
      if (!targetPath) {
        throw new Error(
          "Patch missing file path. You must provide either: " +
          "(1) a 'path' parameter with the relative file path, or " +
          "(2) include a '--- a/filepath' header line in your patch string. " +
          "If you cannot construct a valid unified diff, use the propose_patch tool instead with the full file content."
        );
      }

      // Read current file
      const absPath = nodePath.resolve(rootPath, targetPath);
      const oldContent = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";

      // Apply unified diff
      const Diff = require("diff");
      const newContent = Diff.applyPatch(oldContent, args.patch);
      if (newContent === false) {
        throw new Error(
          "Failed to apply patch to " + targetPath + ". The unified diff could not be applied — " +
          "line numbers or context lines may not match the current file contents. " +
          "Use propose_patch with the full desired file content instead."
        );
      }

      // Write via proposal system
      const result = await handleProposeWrite(
        service,
        { path: targetPath, content: newContent, summary: "Applied unified diff" },
        policy,
        conversationId,
      );
      if (result?.error) return JSON.stringify(result);
      return `Patch applied in memory for ${targetPath}. Awaiting user confirmation.`;
    },
  );

  // ---- 5. get_compile_log ----
  const getCompileLogTool = make(
    "get_compile_log",
    "Return the latest compile log from the client (read-only). Input: { }.",
    { type: "object", properties: {} },
    async () => {
      const context = service.contextByConversation.get(conversationId) ?? {};
      const issues = Array.isArray(context.recentIssues) ? context.recentIssues : [];
      const summary = typeof context.recentIssueSummary === "string" ? context.recentIssueSummary : "";
      const status = typeof context.recentIssueStatus === "string" ? context.recentIssueStatus : "";

      if (issues.length === 0 && !summary) {
        return "No compile log provided.";
      }

      const lines = [];
      if (summary) lines.push(`Status: ${status || "unknown"}`, `Summary: ${summary}`);
      issues.forEach((issue) => {
        if (!issue || typeof issue.message !== "string") return;
        const loc = issue.path
          ? `${issue.path}${issue.line ? `:${issue.line}` : ""}`
          : "";
        const severity = issue.severity || "error";
        lines.push(`[${severity}] ${loc ? loc + ": " : ""}${issue.message}`);
      });
      return lines.join("\n");
    },
  );

  // ---- 6. arxiv_search ----
  const arxivSearchTool = make(
    "arxiv_search",
    "Search arXiv papers. Input: { query, maxResults? }.",
    {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["query"],
    },
    async (args) => {
      const max = Math.min(10, Math.max(1, args.maxResults ?? 5));
      const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(args.query)}&start=0&max_results=${max}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "tex64/1.0" },
      });
      if (!res.ok) {
        throw new Error(`arXiv search failed: ${res.status}`);
      }
      const xml = await res.text();

      // Parse with fast-xml-parser (matching OpenPrism)
      const Parser = await getXMLParser();
      const parser = new Parser({ ignoreAttributes: false });
      const data = parser.parse(xml);
      const entries = Array.isArray(data?.feed?.entry)
        ? data.feed.entry
        : data?.feed?.entry
          ? [data.feed.entry]
          : [];

      const papers = entries.map((entry) => {
        const authors = Array.isArray(entry.author)
          ? entry.author
          : [entry.author].filter(Boolean);
        const authorNames = authors.map((a) => a?.name).filter(Boolean);
        const id = String(entry.id || "");
        const arxivId = id ? id.split("/").pop() : "";
        return {
          title: String(entry.title || "").replace(/\s+/g, " ").trim(),
          abstract: String(entry.summary || "").replace(/\s+/g, " ").trim(),
          authors: authorNames,
          url: id,
          arxivId,
        };
      });

      return JSON.stringify({ papers });
    },
  );

  // ---- 7. arxiv_bibtex ----
  const arxivBibtexTool = make(
    "arxiv_bibtex",
    "Generate BibTeX for an arXiv paper. Input: { arxivId }.",
    {
      type: "object",
      properties: { arxivId: { type: "string" } },
      required: ["arxivId"],
    },
    async (args) => {
      const id = extractArxivId(args.arxivId);
      if (!id) throw new Error("Invalid arXiv ID");
      const entry = await fetchArxivEntry(id);
      if (!entry) throw new Error("No arXiv metadata found");
      return buildArxivBibtex(entry);
    },
  );

  return [
    readFileTool,
    listFilesTool,
    proposePatchTool,
    applyPatchTool,
    getCompileLogTool,
    arxivSearchTool,
    arxivBibtexTool,
  ];
};

module.exports = { buildTools, TOOL_STATUS_LABELS };
