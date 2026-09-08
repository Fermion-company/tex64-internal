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
const fsp = require("fs/promises");
const nodePath = require("path");
const { execFile } = require("child_process");
const { extractArxivId, fetchArxivEntry, buildArxivBibtex } = require("./arxiv-service.cjs");
const {
  checkBibliography,
  checkReferences,
  formatOutlineForResult,
  outlineOf,
  resolveMainTexFile,
  scanDocument,
} = require("../agent-document-map.cjs");

/** Tools that change the workspace; their results carry the file's new outline. */
const WRITE_TOOL_NAMES = new Set([
  "write_file",
  "create_file",
  "apply_patch",
  "replace_lines",
  "insert_lines",
  "delete_lines",
  "replace_section",
  "append_to_section",
]);

/** What `git diff` may hand the model at most; the rest is summarized. */
const MAX_GIT_DIFF_CHARS = 60_000;

/** Run git in the workspace; resolves to stdout, or null when git is not usable there. */
const runGit = (rootPath, args, signal) =>
  new Promise((resolve) => {
    let child;
    try {
      child = execFile("git", args, { cwd: rootPath, maxBuffer: 8 * 1024 * 1024, signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
        resolve(error ? null : String(stdout ?? ""));
      });
    } catch {
      resolve(null);
    }
    if (!child) resolve(null);
  });

/** Tools that only make sense on some turns; the run loop lists them on demand. */
const OPTIONAL_TOOL_GROUPS = [
  {
    names: ["arxiv_search", "arxiv_bibtex"],
    pattern:
      /arxiv|論文|文献|引用|参考文献|出典|bib(?:tex|liography|liograph)?|\\cite|\bcit(?:e|ation)|reference|literature|paper|preprint/i,
  },
  {
    names: ["check_environment"],
    pattern:
      /環境|インストール|導入|install|package|パッケージ|latexmk|lualatex|xelatex|pdflatex|uplatex|platex|latexindent|synctex|コマンド|command|available|使え/i,
  },
];

/** A window of numbered source lines around a reported line, for compile issues. */
const sourceExcerpt = (content, line, radius = 2) => {
  const lines = String(content ?? "").split(/\r?\n/);
  const target = Math.max(1, Math.min(lines.length, Math.round(line)));
  const from = Math.max(1, target - radius);
  const to = Math.min(lines.length, target + radius);
  const rows = [];
  for (let n = from; n <= to; n += 1) {
    rows.push(`${n === target ? ">" : " "}${String(n).padStart(4, " ")}| ${lines[n - 1]}`);
  }
  return rows.join("\n");
};

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
 * The event names the tool and its target; every UI owns the words it shows.
 */
const wrapWithIpc = (name, fn, service, conversationId) => {
  return async (args) => {
    const detail = describeToolTarget(name, args);
    service.sendToRenderer("agent:tool", {
      name,
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
        detail,
        summary,
        conversationId,
      });
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (err) {
      const errMsg = err?.message ?? String(err);
      service.sendToRenderer("agent:tool", {
        name,
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
const MAX_NEXT_STEPS = 5;
const clipStepText = (value, max) => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
/**
 * A question for the user: the text, optional short fields to fill (subject,
 * audience, goal...), optional choices. The app renders it as an input card.
 */
const normalizeQuestion = (raw) => {
  if (typeof raw === "string") {
    const question = clipStepText(raw, 200);
    return question ? { question } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const question = clipStepText(raw.question, 200);
  if (!question) return null;
  const fields = (Array.isArray(raw.fields) ? raw.fields : [])
    .map((field) => ({
      key: clipStepText(field?.key, 40),
      label: clipStepText(field?.label, 60),
      placeholder: clipStepText(field?.placeholder, 80),
    }))
    .filter((field) => field.key && field.label)
    .slice(0, 5)
    .map((field) => ({
      key: field.key,
      label: field.label,
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    }));
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map((option) => clipStepText(option, 80))
    .filter(Boolean)
    .slice(0, 6);
  return {
    question,
    ...(fields.length > 0 ? { fields } : {}),
    ...(options.length > 0 ? { options } : {}),
  };
};

/** Next steps the model records for the document; ids are per reply. */
const normalizeNextSteps = (raw) => {
  if (!Array.isArray(raw)) return [];
  const steps = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const title = clipStepText(item.title, 80);
    const request = clipStepText(item.request, 600);
    if (!title || !request) continue;
    const scope = clipStepText(item.scope, 40);
    const asks = normalizeQuestion(item.asks);
    const line = Number.parseInt(item.line, 10);
    // Writing unless the model says mechanical: the brief comes first.
    const kind = item.kind === "mechanical" ? "mechanical" : "writing";
    steps.push({
      id: `p${steps.length + 1}`,
      title,
      request,
      kind,
      ...(scope ? { scope } : {}),
      ...(asks ? { asks } : {}),
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
    });
    if (steps.length >= MAX_NEXT_STEPS) break;
  }
  return steps;
};

const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", description: "The one question, in the user's language." },
    fields: {
      type: "array",
      description: "Short facts to collect together, e.g. subject, audience, goal. At most 5.",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          label: { type: "string", description: "Label shown to the user." },
          placeholder: { type: "string", description: "Example answer." },
        },
        required: ["key", "label"],
      },
    },
    options: {
      type: "array",
      description: "Choices when the answer is one of a few real alternatives. At most 6.",
      items: { type: "string" },
    },
  },
  required: ["question"],
};

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
  // Whole-file reads are remembered for the turn: the second one is refused
  // in favour of a range or a section, which is what the map is for.
  const fullReadsThisRun = new Map();
  const attachOutline = async (result) => {
    if (!result || typeof result !== "object") return result;
    const applied = result.writeApplied === true || result.status === "applied";
    const targetPath = typeof result.path === "string" ? result.path : "";
    if (!applied || !targetPath || !/\.(tex|ltx)$/i.test(targetPath)) return result;
    try {
      const content = await fsp.readFile(resolveCapturedWorkspacePath(targetPath), "utf8");
      fullReadsThisRun.delete(targetPath);
      return { ...result, outline: formatOutlineForResult(content) };
    } catch {
      return result;
    }
  };
  const loadDocumentMap = async () => {
    const mainFile = await resolveMainTexFile(service, runContext.context ?? {});
    if (!mainFile) return null;
    return scanDocument(service, mainFile);
  };

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
        // Structural removal is never the model's call. The only thing that
        // can switch it on is the run context, which the run loop derives from
        // the user's own words (an explicit request to empty or reset the
        // document); an invented extra property from the model is overridden.
        const safeArgs =
          args && typeof args === "object" && !Array.isArray(args)
            ? { ...args, allowStructuralRemoval: runContext.allowStructuralRemoval === true }
            : args;
        const result = await fn(safeArgs);
        assertWorkspaceBound();
        return result;
      },
      service,
      conversationId,
    ),
  });

  const makeWrite = (name, description, parameters, fn) =>
    make(name, description, parameters, async (args) => attachOutline(await fn(args)));

  // ---- Read tools ----
  const readFileTool = make(
    "read_file",
    "Read a UTF-8 file from the project, or a line range of it. Input: " +
      "{ path, startLine?, endLine? } (relative to project root). With a range " +
      "only those lines come back, each prefixed by its number. The DOCUMENT MAP " +
      "already gives every section's lines; prefer read_section or a range. A " +
      "whole file is returned once per turn; ask again with a range.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer", description: "1-based first line of the range to return." },
        endLine: { type: "integer", description: "1-based last line (inclusive)." },
      },
      required: ["path"],
    },
    async (args) => {
      const result = await handleReadFile(service, { path: args.path }, policy, conversationId);
      if (result?.error) return result;
      const content = typeof result?.content === "string" ? result.content : "";
      const lines = content.split(/\r?\n/);
      const start = Number.parseInt(args?.startLine, 10);
      const end = Number.parseInt(args?.endLine, 10);
      if (Number.isInteger(start) && start > 0) {
        const last = Number.isInteger(end) && end >= start ? Math.min(end, lines.length) : Math.min(start + 199, lines.length);
        const excerpt = lines
          .slice(start - 1, last)
          .map((line, index) => `${String(start + index).padStart(4, " ")}| ${line}`)
          .join("\n");
        return { path: args.path, startLine: start, endLine: last, totalLines: lines.length, content: excerpt };
      }
      const previous = fullReadsThisRun.get(args.path);
      if (previous && previous === content) {
        return {
          error:
            `${args.path} was already read in full during this turn and has not changed since. ` +
            "Use read_section with an id, or read_file with startLine/endLine, for the part you need.",
          totalLines: lines.length,
          outline: formatOutlineForResult(content).sections,
        };
      }
      fullReadsThisRun.set(args.path, content);
      const truncated = content.length > 20000;
      const displayed = truncated ? content.slice(0, 20000) : content;
      return {
        path: args.path,
        content: displayed,
        totalLines: lines.length,
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
  const replaceLinesTool = makeWrite(
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
        { ...args, allowStructuralRemoval: runContext.allowStructuralRemoval === true },
        policy,
        conversationId,
      ),
  );

  const insertLinesTool = makeWrite(
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

  const deleteLinesTool = makeWrite(
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
        { ...args, allowStructuralRemoval: runContext.allowStructuralRemoval === true },
        policy,
        conversationId,
      ),
  );

  const createFileTool = makeWrite(
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

  const replaceSectionTool = makeWrite(
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
        { ...args, allowStructuralRemoval: runContext.allowStructuralRemoval === true },
        policy,
        conversationId,
      ),
  );

  const appendToSectionTool = makeWrite(
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
  const writeFileTool = makeWrite(
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
          allowStructuralRemoval: runContext.allowStructuralRemoval === true,
        },
        policy,
        conversationId,
      );
      return result;
    },
  );

  // ---- apply_patch ----
  const applyPatchTool = makeWrite(
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
          allowStructuralRemoval: runContext.allowStructuralRemoval === true,
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
    async (args) => {
      const raw = await service.executeToolCall(
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
      );
      if (!raw || typeof raw !== "object") return raw;
      // The model needs the issues and the source around each one, not the
      // compiler's whole tail: the excerpt saves the read_file round trip and
      // the log excerpt is kept only when nothing was parsed out of it.
      const issues = Array.isArray(raw.issues) ? raw.issues : [];
      const ranked = [...issues].sort((a, b) => {
        const rank = (issue) => (issue?.severity === "error" ? 0 : issue?.severity === "warning" ? 1 : 2);
        return rank(a) - rank(b);
      });
      const excerptCache = new Map();
      const compactIssues = [];
      for (const issue of ranked.slice(0, 12)) {
        const entry = {
          severity: issue?.severity ?? "error",
          message: typeof issue?.message === "string" ? issue.message.slice(0, 300) : "",
          ...(typeof issue?.path === "string" && issue.path ? { path: issue.path } : {}),
          ...(Number.isFinite(issue?.line) ? { line: issue.line } : {}),
        };
        if (entry.path && entry.line && compactIssues.length < 6 && entry.severity !== "info") {
          try {
            if (!excerptCache.has(entry.path)) {
              excerptCache.set(
                entry.path,
                await fsp.readFile(resolveCapturedWorkspacePath(entry.path), "utf8"),
              );
            }
            entry.source = sourceExcerpt(excerptCache.get(entry.path), entry.line);
          } catch {
            // The issue line still names the place.
          }
        }
        compactIssues.push(entry);
      }
      const failed = raw.status === "failure";
      const logExcerpt =
        typeof raw.logExcerpt === "string" && raw.logExcerpt
          ? failed && compactIssues.length === 0
            ? raw.logExcerpt.slice(-2_000)
            : undefined
          : undefined;
      return {
        status: raw.status,
        ...(typeof raw.targetFile === "string" ? { targetFile: raw.targetFile } : {}),
        summary: raw.summary,
        ...(compactIssues.length > 0 ? { issues: compactIssues } : {}),
        ...(issues.length > compactIssues.length ? { moreIssues: issues.length - compactIssues.length } : {}),
        ...(typeof raw.pdfPath === "string" && raw.pdfPath ? { pdfPath: raw.pdfPath } : {}),
        ...(logExcerpt ? { logExcerpt } : {}),
        ...(typeof raw.error === "string" ? { error: raw.error } : {}),
      };
    },
  );

  // ---- check_references / check_bibliography ----
  // Deterministic checks over the whole document: no model guesswork about
  // which label or bib key exists.
  const checkReferencesTool = make(
    "check_references",
    "Check every \\label / \\ref / \\includegraphics across the document (main file " +
      "plus \\input/\\include): refs to missing labels, duplicate and unused labels, " +
      "graphics files that do not exist, floats without a label. Returns exact " +
      "file:line locations. Input: {}.",
    { type: "object", properties: {} },
    async () => {
      const map = await loadDocumentMap();
      if (!map) return { error: "No .tex document is available to check." };
      return checkReferences(service, map);
    },
  );
  const checkBibliographyTool = make(
    "check_bibliography",
    "Check the bibliography across the document: \\cite keys with no entry in the .bib " +
      "files, entries never cited, duplicate keys, and entries missing required " +
      "fields (author/title/year…). Returns exact file:line locations. Input: {}.",
    { type: "object", properties: {} },
    async () => {
      const map = await loadDocumentMap();
      if (!map) return { error: "No .tex document is available to check." };
      return checkBibliography(map);
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

  // ---- propose_next_steps ----
  // Records concrete next steps for the document. The reply keeps them as
  // structured data, so the UI can offer each one as a request to send.
  const proposeNextStepsTool = make(
    "propose_next_steps",
    "Record up to 5 concrete next steps for this document: where to start " +
      "revising and what to add. Each `request` must be a complete instruction " +
      "the user could send back as-is, naming the place it touches. When a step " +
      "depends on facts only the user knows (subject, audience, goals, results, " +
      "data), set `asks` to the one question to put to the user first; the app " +
      "asks it and sends the answer together with the request. `kind` says " +
      "how the step runs when taken: 'mechanical' (a build fix, references, " +
      "labels, bibliography, formatting, moving, renaming) is done at once; " +
      "'writing' (anything that adds or changes content) starts with the brief: " +
      "the app withholds the edit tools on that first turn and the agent asks. " +
      "Call at most once per turn, as the LAST tool call before your final " +
      "reply. Input: { proposals: [{ title, request, kind, scope?, asks?, line? }] }.",
    {
      type: "object",
      properties: {
        proposals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Short label in the user's language, at most 60 characters.",
              },
              request: {
                type: "string",
                description: "The instruction to send, in the user's language.",
              },
              kind: {
                type: "string",
                enum: ["mechanical", "writing"],
                description:
                  "'mechanical' for a fix that needs no decision from the user (build errors, references, labels, bibliography, formatting, moving); 'writing' for anything that adds or changes content.",
              },
              scope: {
                type: "string",
                description: "How much it touches, e.g. '1 paragraph', 'section 3', 'new section'.",
              },
              asks: {
                ...QUESTION_SCHEMA,
                description:
                  "The question the user must answer before this step can be written. Omit when the document already holds everything needed.",
              },
              line: {
                type: "integer",
                description:
                  "1-based line in the main file where this step applies (from list_sections). Used to mark the place on the page.",
              },
            },
            required: ["title", "request", "kind"],
          },
        },
      },
      required: ["proposals"],
    },
    async (args) => {
      const proposals = normalizeNextSteps(args?.proposals);
      if (proposals.length === 0) {
        return { error: "proposals must contain at least one { title, request }." };
      }
      if (!service.nextStepsByConversation) service.nextStepsByConversation = new Map();
      service.nextStepsByConversation.set(conversationId, proposals);
      return { ok: true, recorded: proposals.length };
    },
  );

  // ---- ask_user ----
  // One question the user must answer. Recording it ends the turn; the app
  // shows an input card and the answer arrives as the next user message.
  const askUserTool = make(
    "ask_user",
    "Ask the user ONE question that only they can answer (subject, audience, " +
      "goal, results, data, a real choice) and end this turn. Use fields to " +
      "collect several short facts at once, options for a choice. Never ask " +
      "what the document already says. Input: { question, fields?, options? }.",
    QUESTION_SCHEMA,
    async (args) => {
      const question = normalizeQuestion(args);
      if (!question) return { error: "question is required." };
      if (!service.pendingQuestionByConversation) {
        service.pendingQuestionByConversation = new Map();
      }
      service.pendingQuestionByConversation.set(conversationId, question);
      return { ok: true, waiting: "The turn ends here; the user's answer comes as the next message." };
    },
  );

  // ---- record_plan ----
  // Plan mode's product: the steps as structured data, so the chat can show
  // them as a checklist the reader edits before anything is written.
  const recordPlanTool = make(
    "record_plan",
    "Record the plan for the requested work: 3 to 8 steps in order, each with a short " +
      "title, where it applies (section or file), what will be written or changed in " +
      "one or two sentences, and, when the step depends on facts only the user has, " +
      "the one question to ask first. Call once, then reply with a 2-3 sentence summary. " +
      "Input: { title, steps: [{ title, where, what, asks? }] }.",
    {
      type: "object",
      properties: {
        title: { type: "string", description: "One line naming the plan, in the user's language." },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              where: { type: "string", description: "Section, file, or place it touches." },
              what: { type: "string", description: "What will be written or changed there." },
              asks: { ...QUESTION_SCHEMA, description: "The question the user must answer before this step." },
            },
            required: ["title", "what"],
          },
        },
      },
      required: ["title", "steps"],
    },
    async (args) => {
      const title = clipStepText(args?.title, 120);
      const steps = (Array.isArray(args?.steps) ? args.steps : [])
        .map((step, index) => ({
          id: `s${index + 1}`,
          title: clipStepText(step?.title, 100),
          where: clipStepText(step?.where, 80),
          what: clipStepText(step?.what, 400),
          ...(normalizeQuestion(step?.asks) ? { asks: normalizeQuestion(step?.asks) } : {}),
        }))
        .filter((step) => step.title && step.what)
        .slice(0, 8);
      if (!title || steps.length === 0) return { error: "title and at least one step { title, what } are required." };
      if (!service.planByConversation) service.planByConversation = new Map();
      service.planByConversation.set(conversationId, { title, steps });
      return { ok: true, recorded: steps.length };
    },
  );

  // ---- git_diff ----
  const gitDiffTool = make(
    "git_diff",
    "The uncommitted changes of the workspace: `git status --porcelain` plus the unified " +
      "diff of the working tree and the index (text files only, at most 60k characters). " +
      "Use it to review what changed before a commit. Input: {}.",
    { type: "object", properties: {} },
    async () => {
      const status = await runGit(rootPath, ["status", "--porcelain"], turnSignal);
      if (status === null) return { error: "git is not available here, or this workspace is not a repository." };
      const unstaged = (await runGit(rootPath, ["diff", "--no-color", "--unified=2", "--no-ext-diff"], turnSignal)) ?? "";
      const staged = (await runGit(rootPath, ["diff", "--no-color", "--unified=2", "--no-ext-diff", "--cached"], turnSignal)) ?? "";
      const sections = [];
      if (staged.trim()) sections.push("# staged\n" + staged);
      if (unstaged.trim()) sections.push("# unstaged\n" + unstaged);
      let diff = sections.join("\n\n");
      const truncated = diff.length > MAX_GIT_DIFF_CHARS;
      if (truncated) diff = `${diff.slice(0, MAX_GIT_DIFF_CHARS)}\n…(truncated)`;
      const files = status
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
      return {
        ok: true,
        changedFiles: files,
        ...(diff ? { diff } : { note: "No textual changes." }),
        ...(truncated ? { truncated: true } : {}),
      };
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
    checkReferencesTool,
    checkBibliographyTool,
    getCompileLogTool,
    arxivSearchTool,
    arxivBibtexTool,
    checkEnvironmentTool,
    proposeNextStepsTool,
    askUserTool,
    recordPlanTool,
    gitDiffTool,
  ];
};

module.exports = {
  buildTools,
  OPTIONAL_TOOL_GROUPS,
  WRITE_TOOL_NAMES,
  outlineOf,
  runGit,
};
