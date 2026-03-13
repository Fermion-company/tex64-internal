/**
 * Tool definitions — OpenPrism style.
 *
 * Exactly 7 tools matching the OpenPrism reference implementation:
 *   read_file, list_files, propose_patch, apply_patch,
 *   get_compile_log, arxiv_search, arxiv_bibtex
 *
 * Each tool wraps existing tex64 handlers where available, and implements
 * new logic (apply_patch, get_compile_log, arxiv_*) directly.
 *
 * arXiv tools use fast-xml-parser and return JSON (same as OpenPrism).
 */

"use strict";

const { existsSync, readFileSync } = require("fs");
const nodePath = require("path");
const { extractArxivId, fetchArxivEntry, buildArxivBibtex } = require("./arxiv-service.cjs");

const TOOL_STATUS_LABELS = {
  read_file: "ファイル確認中",
  list_files: "構成把握中",
  propose_patch: "変更案作成中",
  apply_patch: "変更案作成中",
  get_compile_log: "ログ確認中",
  arxiv_search: "arXiv検索中",
  arxiv_bibtex: "BibTeX取得中",
};

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
 * Build the 7 LangChain tools for a given agent run.
 *
 * @param {object} modules  — ESM bridge output (z, DynamicStructuredTool, etc.)
 * @param {object} service  — AgentService instance
 * @param {string} conversationId
 * @param {object} policy   — resolved agent policy
 * @returns {import("@langchain/core/tools").DynamicStructuredTool[]}
 */
const buildTools = (modules, service, conversationId, policy) => {
  const { DynamicStructuredTool, z } = modules;

  const {
    handleListFiles,
    handleProposeWrite,
    handleReadFile,
  } = require("../agent-tools-file.cjs");

  const rootPath = service.workspace.getRootPath() || "";

  const make = (name, description, schema, fn) =>
    new DynamicStructuredTool({
      name,
      description,
      schema,
      func: wrapWithIpc(name, fn, service, conversationId),
    });

  // ---- 1. read_file ----
  const readFileTool = make(
    "read_file",
    "Read a UTF-8 file from the project. Input: { path } (relative to project root).",
    z.object({ path: z.string() }),
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
    z.object({ dir: z.string().optional() }),
    (args) => handleListFiles(service, { directory: args.dir }, policy, conversationId),
  );

  // ---- 3. propose_patch (full file rewrite) ----
  const proposePatchTool = make(
    "propose_patch",
    "Propose a full file rewrite. Input: { path, content }. This does NOT write. It returns a patch for user confirmation.",
    z.object({ path: z.string(), content: z.string() }),
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
    z.object({ patch: z.string(), path: z.string().optional() }),
    async (args) => {
      let targetPath = args.path;
      if (!targetPath) {
        const match = args.patch.match(/^---\s+a\/(.+)/m);
        if (match) targetPath = match[1];
      }
      if (!targetPath) {
        throw new Error("Patch missing file path");
      }

      // Read current file
      const absPath = nodePath.resolve(rootPath, targetPath);
      const oldContent = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";

      // Apply unified diff
      const Diff = require("diff");
      const newContent = Diff.applyPatch(oldContent, args.patch);
      if (newContent === false) {
        throw new Error("Failed to apply patch");
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
    z.object({}),
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
    z.object({ query: z.string(), maxResults: z.number().optional() }),
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
    z.object({ arxivId: z.string() }),
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
