/**
 * Tool definitions — Plain objects with JSON Schema.
 *
 * Surface available to the LaTeX editing agent:
 *
 *   Read tools:
 *     read_file, list_files, get_compile_log
 *
 *   Precision editing (preferred):
 *     replace_lines, insert_lines, delete_lines,
 *     apply_patch (unified diff), create_file
 *
 *   LaTeX structural editing (preferred for section-level work):
 *     list_sections, read_section, replace_section, append_to_section
 *
 *   Whole-file replacement (last resort, with safety guards):
 *     write_file  — refuses destructive shrinks unless allowFullRewrite=true
 *
 *   Shell / arXiv / environment:
 *     run_command, arxiv_search, arxiv_bibtex,
 *     check_environment, install_environment
 *
 * Every file-modifying tool returns a structured success result
 * containing { status, path, change: { linesBefore, linesAfter,
 * linesAdded, linesRemoved, shaBefore, shaAfter }, sha } so the LLM
 * can base subsequent edits on the post-write state.
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
      const summary =
        result && typeof result === "object" && typeof result.error === "string"
          ? result.error
          : result && typeof result === "object" && typeof result.summary === "string"
            ? result.summary
            : "ok";
      service.sendToRenderer("agent:tool", {
        name,
        label,
        summary,
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
 * Build the tool set for a given agent run.
 *
 * @param {object} service  — AgentService instance
 * @param {string} conversationId
 * @param {object} policy   — resolved agent policy
 */
const buildTools = (service, conversationId, policy) => {
  const {
    handleCreateFile,
    handleDeleteLines,
    handleInsertLines,
    handleListFiles,
    handleProposeWrite,
    handleReadFile,
    handleReplaceLines,
  } = require("../agent-tools-file.cjs");
  const {
    handleListSections,
    handleReadSection,
    handleReplaceSection,
    handleAppendToSection,
  } = require("../agent-tools-latex.cjs");
  const { handleRunCommand } = require("../agent-tools-file-utils.cjs");

  const rootPath = service.workspace.getRootPath() || "";

  const make = (name, description, parameters, fn) => ({
    type: "function",
    function: { name, description, parameters },
    execute: wrapWithIpc(name, fn, service, conversationId),
  });

  // ---- Read tools ----
  const readFileTool = make(
    "read_file",
    "Read a UTF-8 file from the project. Always call this before editing " +
      "an existing file so you know the current content and line numbers. " +
      "Input: { path } (relative to project root).",
    {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async (args) => {
      const result = await handleReadFile(service, args, policy, conversationId);
      if (result?.error) return result;
      const content = typeof result?.content === "string" ? result.content : "";
      const truncated = content.length > 20000;
      const displayed = truncated ? content.slice(0, 20000) : content;
      return {
        path: args.path,
        content: displayed,
        bytes: Buffer.byteLength(content, "utf8"),
        truncated,
      };
    },
  );

  const listFilesTool = make(
    "list_files",
    "List files under a directory. Input: { dir } (relative path, optional).",
    {
      type: "object",
      properties: { dir: { type: "string" } },
    },
    (args) => handleListFiles(service, { directory: args.dir }, policy, conversationId),
  );

  // ---- Precision editing ----
  const replaceLinesTool = make(
    "replace_lines",
    "Replace a contiguous block of lines in an existing file. Prefer this over " +
      "write_file whenever you want to change a specific region. " +
      "Input: { path, startLine, endLine, content, summary? }. " +
      "Line numbers are 1-based inclusive.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
        content: { type: "string", description: "New content to replace lines [startLine..endLine]" },
        summary: { type: "string" },
      },
      required: ["path", "startLine", "endLine", "content"],
    },
    async (args) => handleReplaceLines(service, args, policy, conversationId),
  );

  const insertLinesTool = make(
    "insert_lines",
    "Insert new lines into an existing file at a specific position, without " +
      "touching existing lines. Input: { path, afterLine, content, summary? }. " +
      "Use afterLine=0 to insert at the top of the file.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        afterLine: { type: "number", description: "0 = top of file, N = after line N" },
        content: { type: "string" },
        summary: { type: "string" },
      },
      required: ["path", "afterLine", "content"],
    },
    async (args) => handleInsertLines(service, args, policy, conversationId),
  );

  const deleteLinesTool = make(
    "delete_lines",
    "Delete a contiguous block of lines from an existing file. " +
      "Input: { path, startLine, endLine, summary? }. 1-based inclusive. " +
      "Refuses destructive deletions (> 50% of the file) unless allowFullRewrite=true.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
        allowFullRewrite: { type: "boolean" },
        summary: { type: "string" },
      },
      required: ["path", "startLine", "endLine"],
    },
    async (args) => handleDeleteLines(service, args, policy, conversationId),
  );

  const createFileTool = make(
    "create_file",
    "Create a brand-new file. Fails if the file already exists (use replace_lines " +
      "or write_file+allowFullRewrite=true to overwrite an existing file). " +
      "Input: { path, content, summary? }.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        summary: { type: "string" },
      },
      required: ["path", "content"],
    },
    async (args) => handleCreateFile(service, args, policy, conversationId),
  );

  // ---- LaTeX structural editing ----
  const listSectionsTool = make(
    "list_sections",
    "Return the outline of a LaTeX file: every \\chapter / \\section / \\subsection / " +
      "\\subsubsection / \\paragraph, plus the preamble region and \\begin{abstract} " +
      "environment if present. Each entry has { id, type, title, headerLine, startLine, " +
      "endLine, bodyLines }. Use the id or (type, title) with read_section / " +
      "replace_section / append_to_section. Input: { path }.",
    {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async (args) => handleListSections(service, args, policy, conversationId),
  );

  const readSectionTool = make(
    "read_section",
    "Read the body of a specific LaTeX section. Identify the section by either " +
      "{ sectionId } (from list_sections) or { type, title, occurrence? }. For the " +
      "abstract pass { type: 'abstract' }. Input: { path, sectionId? | type?, title?, occurrence? }.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        sectionId: { type: "number" },
        type: { type: "string" },
        title: { type: "string" },
        occurrence: { type: "number" },
      },
      required: ["path"],
    },
    async (args) => handleReadSection(service, args, policy, conversationId),
  );

  const replaceSectionTool = make(
    "replace_section",
    "Replace the BODY of a specific LaTeX section with new content. Preserves the " +
      "\\section{} header line (set includeHeader=true to also replace the header). " +
      "Identify by { sectionId } or { type, title, occurrence? }. For the abstract " +
      "pass { type: 'abstract' }. Input: { path, sectionId? | type?, title?, " +
      "occurrence?, content, includeHeader?, allowFullRewrite?, summary? }.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        sectionId: { type: "number" },
        type: { type: "string" },
        title: { type: "string" },
        occurrence: { type: "number" },
        content: { type: "string" },
        includeHeader: { type: "boolean" },
        allowFullRewrite: { type: "boolean" },
        summary: { type: "string" },
      },
      required: ["path", "content"],
    },
    async (args) => handleReplaceSection(service, args, policy, conversationId),
  );

  const appendToSectionTool = make(
    "append_to_section",
    "Append content to the end of a LaTeX section body, without touching the rest " +
      "of the document. Identify by { sectionId } or { type, title, occurrence? }. " +
      "Input: { path, sectionId? | type?, title?, occurrence?, content }.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        sectionId: { type: "number" },
        type: { type: "string" },
        title: { type: "string" },
        occurrence: { type: "number" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    async (args) => handleAppendToSection(service, args, policy, conversationId),
  );

  // ---- Whole-file write (last resort) ----
  const writeFileTool = make(
    "write_file",
    "Create a new file OR fully rewrite an existing one. This is a dangerous " +
      "tool: for any targeted change in an existing file, prefer replace_lines / " +
      "insert_lines / delete_lines / replace_section / append_to_section. " +
      "Destructive shrinks (new content < 50% of original lines) are REJECTED " +
      "unless you explicitly pass allowFullRewrite=true. " +
      "Input: { path, content, mode?, allowFullRewrite?, summary? }.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        mode: {
          type: "string",
          enum: ["create", "overwrite", "any"],
          description: "create = new file only, overwrite = existing only, any = either (default)",
        },
        allowFullRewrite: {
          type: "boolean",
          description: "Required for destructive shrinks",
        },
        summary: { type: "string" },
      },
      required: ["path", "content"],
    },
    async (args) => {
      const result = await handleProposeWrite(
        service,
        {
          path: args.path,
          content: args.content,
          summary: args.summary || "Full file rewrite",
          mode: args.mode,
          allowFullRewrite: args.allowFullRewrite,
        },
        policy,
        conversationId,
      );
      return result;
    },
  );

  // ---- apply_patch ----
  const applyPatchTool = make(
    "apply_patch",
    "Apply a unified diff to a file. Prefer replace_lines / insert_lines / " +
      "delete_lines or the replace_section family unless you have a precise " +
      "unified diff ready. Input: { patch, path? }.",
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
          "If you cannot construct a valid unified diff, use replace_lines instead."
        );
      }

      const absPath = nodePath.resolve(rootPath, targetPath);
      const oldContent = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";

      const Diff = require("diff");
      const newContent = Diff.applyPatch(oldContent, args.patch);
      if (newContent === false) {
        throw new Error(
          "Failed to apply patch to " + targetPath + ". The unified diff could not be applied — " +
          "line numbers or context lines may not match the current file contents. " +
          "Use replace_lines with exact line numbers instead."
        );
      }

      const result = await handleProposeWrite(
        service,
        {
          path: targetPath,
          content: newContent,
          summary: "Applied unified diff",
          mode: "any",
          // A successful diff application implies the diff was valid for the
          // current file, so destructive shrink is unlikely; still let it be
          // gated by allowFullRewrite if the patch removes most of the file.
          allowFullRewrite: args.allowFullRewrite === true,
        },
        policy,
        conversationId,
      );
      return result;
    },
  );

  // ---- get_compile_log ----
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

  // ---- arxiv_search ----
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

  // ---- arxiv_bibtex ----
  const arxivBibtexTool = make(
    "arxiv_bibtex",
    "Generate BibTeX for an arXiv paper from its exact metadata (authors, title, " +
      "year, URL). ALWAYS use this instead of fabricating BibTeX entries from " +
      "memory — the LLM's memory of author names is often wrong. Input: { arxivId }.",
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

  // ---- check_environment ----
  const checkEnvironmentTool = make(
    "check_environment",
    "Check if a TeX-related command is available on the system. Input: { command }. " +
      "Example commands: lualatex, pdflatex, xelatex, uplatex, latexmk, synctex, latexindent.",
    {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    async (args) => {
      if (!service.envService) {
        return JSON.stringify({ error: "Environment service is not available." });
      }
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (!command) {
        return JSON.stringify({ error: "command is required." });
      }
      const available = await service.envService.checkCommand(command);
      return JSON.stringify({ command, available });
    },
  );

  // ---- install_environment ----
  const installEnvironmentTool = make(
    "install_environment",
    "Install a TeX-related package. Input: { target }. Supported targets: 'basictex' " +
      "(TeX64 managed TeX Live), 'latexmk', 'latexindent'. Uses the official TeX Live installer on macOS/Windows.",
    {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
    },
    async (args) => {
      if (!service.envService) {
        return JSON.stringify({ error: "Environment service is not available." });
      }
      const target = typeof args.target === "string" ? args.target.trim() : "";
      if (!target) {
        return JSON.stringify({ error: "target is required." });
      }
      const result = await service.envService.installEnvironment(target);
      return JSON.stringify(result);
    },
  );

  // ---- run_command ----
  const runCommandTool = make(
    "run_command",
    "Run a shell command in the project directory and return stdout/stderr. " +
      "Use for: building (latexmk), file operations (rm, mv, mkdir), inspecting " +
      "logs, grep, and any other terminal task.",
    {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: { type: "string", description: "Working directory (relative to project root, optional)" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds (optional, max 120000)" },
      },
      required: ["command"],
    },
    async (args) => {
      const result = await handleRunCommand(service, args);
      if (result?.error) return JSON.stringify(result);
      const parts = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
      if (result.timedOut) parts.push("[timed out]");
      const output = parts.join("\n").slice(0, 20000) || "(no output)";
      return `[exit ${result.exitCode ?? "?"}]\n${output}`;
    },
  );

  return [
    readFileTool,
    listFilesTool,
    listSectionsTool,
    readSectionTool,
    replaceSectionTool,
    appendToSectionTool,
    replaceLinesTool,
    insertLinesTool,
    deleteLinesTool,
    createFileTool,
    writeFileTool,
    applyPatchTool,
    runCommandTool,
    getCompileLogTool,
    arxivSearchTool,
    arxivBibtexTool,
    checkEnvironmentTool,
    installEnvironmentTool,
  ];
};

module.exports = { buildTools, TOOL_STATUS_LABELS };
