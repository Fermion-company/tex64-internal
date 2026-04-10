/**
 * agent-tools-latex.cjs
 *
 * LaTeX structural editing tools.
 *
 * The E2E test demonstrated that line-based edits alone are not enough:
 * the LLM can track "the Introduction section" conceptually but struggles
 * to translate that into the right line numbers, especially as the file
 * grows and sections shift. These tools give the agent a higher-level
 * interface that speaks the same language as its intent:
 *
 *   - list_sections : outline of the document
 *   - read_section  : read the body of a specific section by title
 *   - replace_section: replace a section body by title (optionally
 *                      including/excluding the \section{} header itself)
 *   - append_to_section: append content to a section body (common case)
 *
 * The parser is deliberately simple. It recognises:
 *   \section{...}, \subsection{...}, \subsubsection{...},
 *   \chapter{...}, \paragraph{...}
 *   \begin{abstract}...\end{abstract}
 *   \begin{document}, \end{document}
 *
 * Each "structure node" has an integer id = 1-based index in the outline
 * (e.g. the third \section{Introduction} in the file). Titles are matched
 * case-insensitively and whitespace-insensitively, and the caller can
 * disambiguate by supplying {type, title, occurrence} or a numeric
 * sectionId returned from list_sections.
 */

"use strict";

const {
  readCurrentTextContent,
  submitEditedContent,
} = require("./agent-tools-file.cjs");
const { normalizePath, isBlockedPath, isTextExtension } = require("./agent-policy.cjs");

const HEADING_COMMANDS = [
  { name: "chapter", level: 0 },
  { name: "section", level: 1 },
  { name: "subsection", level: 2 },
  { name: "subsubsection", level: 3 },
  { name: "paragraph", level: 4 },
  { name: "subparagraph", level: 5 },
];

const HEADING_PATTERN = (() => {
  const names = HEADING_COMMANDS.map((h) => h.name).join("|");
  // Matches \section{title}, \section*{title}, with optional leading whitespace
  return new RegExp("^\\s*\\\\(" + names + ")\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}");
})();

const ABSTRACT_BEGIN_PATTERN = /^\s*\\begin\{abstract\}/;
const ABSTRACT_END_PATTERN = /^\s*\\end\{abstract\}/;
const DOC_BEGIN_PATTERN = /^\s*\\begin\{document\}/;
const DOC_END_PATTERN = /^\s*\\end\{document\}/;

const normalizeTitleKey = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * Parse a LaTeX document into a flat list of structure nodes.
 *
 * Each node has:
 *   id         : 1-based index (stable within a single parse call)
 *   type       : "chapter" | "section" | ... | "abstract" | "preamble" | "document"
 *   level      : numeric level (0 for chapter, 1 for section, ...; abstract = 100)
 *   title      : the title text (for headings), "" for abstract/preamble/document
 *   headerLine : 1-based line where the \section{...} or \begin{abstract} starts
 *   startLine  : 1-based line where the body content starts (headerLine + 1)
 *   endLine    : 1-based line where the body content ends (inclusive)
 *                — for headings, this is the line BEFORE the next heading of
 *                  equal or higher rank (or \end{document} / EOF).
 *                — for abstract, this is the line BEFORE \end{abstract}.
 */
const parseLatexStructure = (content) => {
  const lines = (content || "").split(/\r?\n/);
  const total = lines.length;
  const nodes = [];

  // Identify document zone and abstract
  let docBeginLine = null;
  let docEndLine = null;
  let abstractBeginLine = null;
  let abstractEndLine = null;

  for (let i = 0; i < total; i += 1) {
    const line = lines[i];
    if (docBeginLine === null && DOC_BEGIN_PATTERN.test(line)) {
      docBeginLine = i + 1;
    } else if (docEndLine === null && DOC_END_PATTERN.test(line)) {
      docEndLine = i + 1;
    }
    if (abstractBeginLine === null && ABSTRACT_BEGIN_PATTERN.test(line)) {
      abstractBeginLine = i + 1;
    } else if (abstractEndLine === null && ABSTRACT_END_PATTERN.test(line)) {
      abstractEndLine = i + 1;
    }
  }

  // Preamble node: from line 1 to the line before \begin{document}.
  if (docBeginLine !== null && docBeginLine > 1) {
    nodes.push({
      id: 0, // assigned below
      type: "preamble",
      level: -1,
      title: "",
      headerLine: 1,
      startLine: 1,
      endLine: docBeginLine - 1,
    });
  }

  // Abstract node
  if (abstractBeginLine !== null && abstractEndLine !== null && abstractEndLine > abstractBeginLine) {
    nodes.push({
      id: 0,
      type: "abstract",
      level: 100,
      title: "abstract",
      headerLine: abstractBeginLine,
      startLine: abstractBeginLine + 1,
      endLine: abstractEndLine - 1,
    });
  }

  // Scan for heading commands
  const headingHits = [];
  for (let i = 0; i < total; i += 1) {
    const line = lines[i];
    const m = line.match(HEADING_PATTERN);
    if (!m) continue;
    const cmdName = m[1];
    const title = m[2];
    const heading = HEADING_COMMANDS.find((h) => h.name === cmdName);
    if (!heading) continue;
    headingHits.push({
      type: cmdName,
      level: heading.level,
      title,
      headerLine: i + 1,
    });
  }

  // Compute endLine for each heading: it's the line before the next heading
  // at equal or higher rank (lower numeric level), or \end{document}, or EOF.
  const hardEnd = docEndLine !== null ? docEndLine - 1 : total;
  for (let idx = 0; idx < headingHits.length; idx += 1) {
    const cur = headingHits[idx];
    let end = hardEnd;
    for (let j = idx + 1; j < headingHits.length; j += 1) {
      if (headingHits[j].level <= cur.level) {
        end = headingHits[j].headerLine - 1;
        break;
      }
    }
    nodes.push({
      id: 0,
      type: cur.type,
      level: cur.level,
      title: cur.title,
      headerLine: cur.headerLine,
      startLine: cur.headerLine + 1,
      endLine: end,
    });
  }

  // Sort by headerLine and assign 1-based ids
  nodes.sort((a, b) => a.headerLine - b.headerLine);
  nodes.forEach((node, idx) => {
    node.id = idx + 1;
  });

  return {
    lines,
    total,
    docBeginLine,
    docEndLine,
    nodes,
  };
};

const findNode = (structure, query) => {
  if (!query || typeof query !== "object") return null;
  if (Number.isFinite(query.sectionId)) {
    const id = Math.round(query.sectionId);
    return structure.nodes.find((n) => n.id === id) || null;
  }
  const desiredType = typeof query.type === "string" ? query.type.toLowerCase() : null;
  const desiredTitleKey = normalizeTitleKey(query.title || "");
  if (!desiredTitleKey && !desiredType) return null;
  const occurrenceRaw = Number(query.occurrence);
  const occurrence = Number.isFinite(occurrenceRaw) && occurrenceRaw >= 1 ? Math.round(occurrenceRaw) : 1;
  const matches = structure.nodes.filter((node) => {
    if (desiredType && node.type !== desiredType) return false;
    if (desiredTitleKey && normalizeTitleKey(node.title) !== desiredTitleKey) return false;
    return true;
  });
  if (matches.length === 0) return null;
  return matches[occurrence - 1] || null;
};

const formatOutline = (structure) => {
  return structure.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    level: node.level,
    title: node.title,
    headerLine: node.headerLine,
    startLine: node.startLine,
    endLine: node.endLine,
    bodyLines: Math.max(0, node.endLine - node.startLine + 1),
  }));
};

// ---- Tool handlers ----

const handleListSections = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args?.path);
  if (!targetPath) return { error: "path is empty." };
  if (isBlockedPath(targetPath, policy)) return { error: "Target path is read-protected." };
  if (!isTextExtension(targetPath, policy)) return { error: "Only text files can be read." };
  const read = await readCurrentTextContent(service, policy, conversationId, targetPath);
  if (!read.ok) return { error: read.error };
  const structure = parseLatexStructure(read.content);
  return {
    path: targetPath,
    totalLines: structure.total,
    documentRange:
      structure.docBeginLine !== null && structure.docEndLine !== null
        ? { beginLine: structure.docBeginLine, endLine: structure.docEndLine }
        : null,
    outline: formatOutline(structure),
  };
};

const handleReadSection = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args?.path);
  if (!targetPath) return { error: "path is empty." };
  if (isBlockedPath(targetPath, policy)) return { error: "Target path is read-protected." };
  if (!isTextExtension(targetPath, policy)) return { error: "Only text files can be read." };
  const read = await readCurrentTextContent(service, policy, conversationId, targetPath);
  if (!read.ok) return { error: read.error };
  const structure = parseLatexStructure(read.content);
  const node = findNode(structure, args || {});
  if (!node) {
    return {
      error:
        "No section matched. Call list_sections to see the available outline, then retry with a matching type+title or sectionId.",
    };
  }
  const bodyLines = structure.lines.slice(node.startLine - 1, node.endLine);
  return {
    path: targetPath,
    section: {
      id: node.id,
      type: node.type,
      title: node.title,
      headerLine: node.headerLine,
      startLine: node.startLine,
      endLine: node.endLine,
    },
    body: bodyLines.join("\n"),
  };
};

const handleReplaceSection = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args?.path);
  if (!targetPath) return { error: "path is empty." };
  const read = await readCurrentTextContent(service, policy, conversationId, targetPath);
  if (!read.ok) return { error: read.error };
  const structure = parseLatexStructure(read.content);
  const node = findNode(structure, args || {});
  if (!node) {
    return {
      error:
        "No section matched. Call list_sections to see the outline, then retry with a matching type+title or sectionId.",
    };
  }
  const includeHeader = args?.includeHeader === true;
  const replacementText = typeof args?.content === "string" ? args.content : "";
  const startLine = includeHeader ? node.headerLine : node.startLine;
  const endLine = node.endLine;
  if (startLine > endLine && !includeHeader) {
    // Empty-body section: treat as insertion after the header line.
    const afterLine = node.headerLine;
    return handleInsertIntoFile(
      service,
      policy,
      conversationId,
      targetPath,
      structure.lines,
      afterLine,
      replacementText,
      `Fill in ${node.type} "${node.title}"`,
    );
  }
  const newline = read.content.includes("\r\n") ? "\r\n" : "\n";
  const originalLines = read.content.replace(/\r\n/g, "\n").split("\n");
  const normalizedReplacement = replacementText.replace(/\r\n/g, "\n");
  const replacementLines = normalizedReplacement.split("\n");
  const updatedLines = [
    ...originalLines.slice(0, startLine - 1),
    ...replacementLines,
    ...originalLines.slice(endLine),
  ];
  let updatedContent = updatedLines.join("\n");
  if (newline === "\r\n") {
    updatedContent = updatedContent.replace(/\n/g, "\r\n");
  }
  return submitEditedContent({
    service,
    policy,
    conversationId,
    targetPath,
    originalContent: read.content,
    updatedContent,
    baseContentHash: read.baseContentHash,
    baseSource: read.baseSource,
    summary:
      typeof args?.summary === "string" && args.summary.trim()
        ? args.summary
        : `Replace ${node.type} "${node.title}"`,
    allowFullRewrite: args?.allowFullRewrite === true,
    proposalType: "patch",
  });
};

const handleInsertIntoFile = async (
  service,
  policy,
  conversationId,
  targetPath,
  originalLines,
  afterLine,
  insertionText,
  summary,
) => {
  const newline = originalLines.join("\n").includes("\r\n") ? "\r\n" : "\n";
  const normalizedInsertion = (insertionText || "").replace(/\r\n/g, "\n");
  const insertionLines = normalizedInsertion.split("\n");
  if (
    insertionLines.length > 0 &&
    insertionLines[insertionLines.length - 1] === "" &&
    normalizedInsertion.endsWith("\n")
  ) {
    insertionLines.pop();
  }
  const updatedLines = [
    ...originalLines.slice(0, afterLine),
    ...insertionLines,
    ...originalLines.slice(afterLine),
  ];
  const originalContent = originalLines.join("\n");
  let updatedContent = updatedLines.join("\n");
  if (newline === "\r\n") {
    updatedContent = updatedContent.replace(/\n/g, "\r\n");
  }
  return submitEditedContent({
    service,
    policy,
    conversationId,
    targetPath,
    originalContent,
    updatedContent,
    baseContentHash: null,
    baseSource: null,
    summary: summary || `Insert content into ${targetPath}`,
    allowFullRewrite: true,
    proposalType: "patch",
  });
};

const handleAppendToSection = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args?.path);
  if (!targetPath) return { error: "path is empty." };
  const read = await readCurrentTextContent(service, policy, conversationId, targetPath);
  if (!read.ok) return { error: read.error };
  const structure = parseLatexStructure(read.content);
  const node = findNode(structure, args || {});
  if (!node) {
    return {
      error:
        "No section matched. Call list_sections to see the outline, then retry with a matching type+title or sectionId.",
    };
  }
  const appendText = typeof args?.content === "string" ? args.content : "";
  if (!appendText) return { error: "content is empty — nothing to append." };
  const newline = read.content.includes("\r\n") ? "\r\n" : "\n";
  const originalLines = read.content.replace(/\r\n/g, "\n").split("\n");
  // Insert right after the current endLine of the section body
  const afterLine = Math.max(node.headerLine, node.endLine);
  const normalizedAppend = appendText.replace(/\r\n/g, "\n");
  const appendLines = normalizedAppend.split("\n");
  if (
    appendLines.length > 0 &&
    appendLines[appendLines.length - 1] === "" &&
    normalizedAppend.endsWith("\n")
  ) {
    appendLines.pop();
  }
  const updatedLines = [
    ...originalLines.slice(0, afterLine),
    ...appendLines,
    ...originalLines.slice(afterLine),
  ];
  let updatedContent = updatedLines.join("\n");
  if (newline === "\r\n") {
    updatedContent = updatedContent.replace(/\n/g, "\r\n");
  }
  return submitEditedContent({
    service,
    policy,
    conversationId,
    targetPath,
    originalContent: read.content,
    updatedContent,
    baseContentHash: read.baseContentHash,
    baseSource: read.baseSource,
    summary: `Append to ${node.type} "${node.title}"`,
    allowFullRewrite: true,
    proposalType: "patch",
  });
};

module.exports = {
  parseLatexStructure,
  formatOutline,
  findNode,
  handleListSections,
  handleReadSection,
  handleReplaceSection,
  handleAppendToSection,
};
