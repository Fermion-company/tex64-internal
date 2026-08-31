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
 *     write_file  — refuses destructive shrinks unless allowFullRewrite=true;
 *                   protected LaTeX structure cannot be removed by the agent
 *
 *   Compile / arXiv / environment:
 *     compile_document, arxiv_search, arxiv_bibtex,
 *     check_environment
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
 * Extract a short human-readable target from tool args so the status line
 * can say "Reading file — main.tex" instead of just "Reading file".
 */
const describeToolTarget = (name, args) => {
  if (!args || typeof args !== "object") {
    return "";
  }
  const candidates = [args.path, args.dir, args.command, args.query, args.arxivId, args.target];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      const flattened = value.trim().replace(/\s+/g, " ");
      return flattened.length > 60 ? `${flattened.slice(0, 57)}…` : flattened;
    }
  }
  return "";
};

/**
 * Wrap a tool function so it emits IPC status events before/after execution.
 */
const wrapWithIpc = (name, fn, service, conversationId) => {
  return async (args) => {
    const label =
      name === "compile_document"
        ? "Compiling document"
        : TOOL_STATUS_LABELS[name] || name;
    const detail = describeToolTarget(name, args);
    service.sendToRenderer("agent:tool", {
      name,
      label,
      detail,
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
        detail,
        summary,
        conversationId,
      });
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (err) {
      const errMsg = err?.message ?? String(err);
      service.sendToRenderer("agent:tool", {
        name,
        label,
        detail,
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
const buildTools = (service, conversationId, policy, runContext = {}) => {
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
  const { handleFindMathRegion } = require("../agent-tools-math.cjs");

  const rootPath =
    typeof runContext.rootPath === "string" && runContext.rootPath.trim()
      ? runContext.rootPath.trim()
      : service.workspace.getRootPath() || "";
  const activeDocumentPath =
    typeof runContext.context?.activeFilePath === "string"
      ? runContext.context.activeFilePath.trim()
      : "";
  const turnSignal = runContext.signal;

  const assertWorkspaceBound = () => {
    if (service.workspace.getRootPath() !== rootPath) {
      const error = new Error(
        "The workspace changed during this Axiom turn. This tool was refused; retry in the current workspace."
      );
      error.code = "AGENT_WORKSPACE_CHANGED";
      throw error;
    }
  };
  const resolveCapturedWorkspacePath = (relativePath) => {
    // Keep the preview read on the same canonical boundary as the actual
    // proposal/apply path. A lexical prefix check alone follows a symlink in
    // the workspace to an arbitrary file outside it.
    const resolved = service.workspace.resolvePath(String(relativePath ?? ""));
    const resolvedRoot = nodePath.resolve(rootPath);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${nodePath.sep}`)) {
      throw new Error("The requested path must stay inside the captured workspace.");
    }
    return resolved;
  };

  const make = (name, description, parameters, fn) => ({
    type: "function",
    function: { name, description, parameters },
    execute: wrapWithIpc(
      name,
      async (args) => {
        assertWorkspaceBound();
        // Structural removal has no model-facing approval primitive today.
        // Force the internal escape hatch off at the common execution boundary
        // so omitted JSON-schema strictness or an invented extra property can
        // never turn it on. A future UI approval must use a trusted path that
        // does not pass through buildTools.
        const safeArgs =
          args && typeof args === "object" && !Array.isArray(args)
            ? { ...args, allowStructuralRemoval: false }
            : args;
        const result = await fn(safeArgs);
        assertWorkspaceBound();
        return result;
      },
      service,
      conversationId,
    ),
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
    async (args) =>
      handleReplaceLines(
        service,
        { ...args, allowStructuralRemoval: false },
        policy,
        conversationId,
      ),
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
      "Input: { path, startLine, endLine, allowFullRewrite?, summary? }. 1-based inclusive. " +
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
    async (args) =>
      handleDeleteLines(
        service,
        { ...args, allowStructuralRemoval: false },
        policy,
        conversationId,
      ),
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
    async (args) =>
      handleReplaceSection(
        service,
        { ...args, allowStructuralRemoval: false },
        policy,
        conversationId,
      ),
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

  // ---- Math region location ----
  const findMathRegionTool = make(
    "find_math_region",
    "Locate the LaTeX math construct that contains a given line: a math " +
      "environment (equation / align / gather / multline / ...), a display " +
      "block (\\[ \\] or $$ $$), or inline math ($ $ or \\( \\)). Returns " +
      "{ found, kind, environment, startLine, endLine, content }. Use this " +
      "BEFORE filling in derivation steps or rewriting an equation when you " +
      "only know the cursor/selection line: it gives you the full formula and " +
      "the exact range to pass to replace_lines. Input: { path, line, column? } " +
      "(line is 1-based).",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number", description: "1-based line inside or near the formula" },
        column: { type: "number", description: "1-based column (optional; disambiguates inline $...$)" },
      },
      required: ["path", "line"],
    },
    async (args) => handleFindMathRegion(service, args, policy, conversationId),
  );

  // ---- Whole-file write (last resort) ----
  const writeFileTool = make(
    "write_file",
    "Create a new file OR fully rewrite an existing one. This is a dangerous " +
      "tool: for any targeted change in an existing file, prefer replace_lines / " +
      "insert_lines / delete_lines / replace_section / append_to_section. " +
      "Destructive shrinks (new content < 50% of original lines) are REJECTED " +
      "unless you explicitly pass allowFullRewrite=true. Protected LaTeX structure " +
      "is preserved even then and cannot be removed by Axiom editing tools. " +
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
          // This internal escape hatch is reserved for a future trusted UI
          // approval flow. Model-supplied extra properties cannot enable it.
          allowStructuralRemoval: false,
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
      "unified diff ready. Protected LaTeX structure cannot be removed by Axiom " +
      "editing tools. Input: { patch, path?, allowFullRewrite? }.",
    {
      type: "object",
      properties: {
        patch: { type: "string" },
        path: { type: "string" },
        allowFullRewrite: { type: "boolean" },
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

      const absPath = resolveCapturedWorkspacePath(targetPath);
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
          allowStructuralRemoval: false,
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

  // ---- compile_document ----
  const compileDocumentTool = make(
    "compile_document",
    "Compile a LaTeX document through TeX64's real build service and return " +
      "structured errors plus the relevant compiler log. With no mainFile it " +
      "compiles the active .tex document " +
      "for this turn; a nested document is built exactly and is not replaced by " +
      "the workspace-wide root. Input: { mainFile?, engine? }.",
    {
      type: "object",
      properties: {
        mainFile: {
          type: "string",
          description: "Workspace-relative .tex document. Omit to compile the active document.",
        },
        engine: {
          type: "string",
          enum: ["lualatex", "pdflatex", "xelatex", "uplatex"],
        },
      },
    },
    async (args) =>
      service.executeToolCall(
        {
          name: "run_build",
          args: {
            ...(typeof args?.mainFile === "string"
              ? { mainFile: args.mainFile }
              : {}),
            ...(typeof args?.engine === "string" ? { engine: args.engine } : {}),
          },
        },
        conversationId,
      ),
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
        signal:
          turnSignal && typeof AbortSignal.any === "function"
            ? AbortSignal.any([turnSignal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
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
      const entry = await fetchArxivEntry(id, { signal: turnSignal });
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

  return [
    readFileTool,
    listFilesTool,
    listSectionsTool,
    readSectionTool,
    replaceSectionTool,
    appendToSectionTool,
    findMathRegionTool,
    replaceLinesTool,
    insertLinesTool,
    deleteLinesTool,
    createFileTool,
    writeFileTool,
    applyPatchTool,
    compileDocumentTool,
    getCompileLogTool,
    arxivSearchTool,
    arxivBibtexTool,
    checkEnvironmentTool,
  ];
};

module.exports = { buildTools, TOOL_STATUS_LABELS };
