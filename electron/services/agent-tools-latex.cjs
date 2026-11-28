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
  handleReadFile,
  readCurrentTextContent,
  submitEditedContent,
} = require("./agent-tools-file.cjs");
const { normalizePath, isBlockedPath, isTextExtension } = require("./agent-policy.cjs");
const { deliverPositions } = require("./agent-model-view.cjs");

const { activeTexSource } = require("./tex-build-target.cjs");

const HEADING_COMMANDS = [
  { name: "part", level: -1 },
  { name: "chapter", level: 0 },
  { name: "section", level: 1 },
  { name: "subsection", level: 2 },
  { name: "subsubsection", level: 3 },
  { name: "paragraph", level: 4 },
  { name: "subparagraph", level: 5 },
];

// Offsets refer to the original text. activeTexSource blanks comments and
// verbatim material without shifting offsets, including CRLF line endings.
const headingLevels = new Map(HEADING_COMMANDS.map(({ name, level }) => [name, level]));
const trailers = new Set(["bibliographystyle", "bibliography", "printbibliography", "appendix", "frontmatter", "mainmatter", "backmatter"]);
const skipSpace = (source, pos) => {
  while (pos < source.length && /\s/.test(source[pos])) pos++;
  return pos;
};

const groupEnd = (source, start) => {
  const optional = source[start] === "[";
  if (!optional && source[start] !== "{") return -1;
  let braces = optional ? 0 : 1;
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === "{") braces++;
    else if (source[i] === "}" && --braces === 0 && !optional) return i + 1;
    else if (source[i] === "]" && optional && braces === 0) return i + 1;
  }
  return -1;
};

const cleanTitle = (title) =>
  String(title || "")
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeTitleKey = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

const parseLatexStructure = (content = "", active = activeTexSource(content)) => {
  const lines = content.split(/\r?\n/);
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (pos) => {
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (lineStarts[mid] <= pos) low = mid;
      else high = mid;
    }
    return low + 1;
  };
  const tokens = /\\(?:[A-Za-z@]+|[\s\S])|[{}]/g;
  const env = /\s*\{([\w@*-]+)\}/y;
  const label = /\s*\\label\s*\{/y;
  const trailingComment = /[ \t]*%[^\r\n]*/y;
  let depth = 0, docBegin = null, docEnd = content.length, docEndLine = null, abstract = null;
  const nodes = [], openHeadings = [], environments = [];
  const add = (type, level, title, headerStart, headerEnd) => {
    const node = { type, level, title, headerStart, headerEnd, limit: content.length };
    nodes.push(node);
    return node;
  };
  const closeHeadings = (level, limit) => {
    while (openHeadings.length && openHeadings.at(-1).level >= level) {
      const heading = openHeadings.pop();
      const enclosingNext = environments[heading.scopeDepth];
      heading.limit = enclosingNext ? Math.min(limit, enclosingNext.start) : limit;
    }
  };
  let token;
  while ((token = tokens.exec(active))) {
    if (token[0] === "{") { depth++; continue; }
    if (token[0] === "}") { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    const name = token[0].slice(1);
    if (name === "endinput") {
      docEnd = token.index;
      break;
    }
    if (name === "begin" || name === "end") {
      env.lastIndex = tokens.lastIndex;
      const match = env.exec(active);
      if (!match) continue;
      tokens.lastIndex = env.lastIndex;
      if (match[1] === "document") {
        if (name === "end") {
          docEnd = token.index;
          docEndLine = lineAt(docEnd);
          break;
        }
        if (docBegin === null) {
          docBegin = token.index;
          // Commands before the document belong to its preamble.
          nodes.length = 0;
          openHeadings.length = 0;
          environments.length = 0;
          abstract = null;
          if (docBegin > 0 && content.slice(0, docBegin).trim()) add("preamble", -1, "", 0, 0).limit = docBegin;
        }
      } else if (name === "begin") {
        if (match[1] === "thebibliography" || match[1] === "theindex") closeHeadings(-Infinity, token.index);
        environments.push({ name: match[1], start: token.index });
        if (match[1] === "abstract") abstract = add("abstract", 100, "abstract", token.index, tokens.lastIndex);
      } else if (environments.at(-1)?.name === match[1]) {
        // A heading inside a wrapper must never consume its closing command.
        while (openHeadings.length && openHeadings.at(-1).scopeDepth >= environments.length) {
          openHeadings.pop().limit = token.index;
        }
        environments.pop();
        if (match[1] === "abstract" && abstract) {
          abstract.limit = token.index;
          abstract = null;
        }
      }
      continue;
    }
    if (trailers.has(name)) { closeHeadings(-Infinity, token.index); continue; }
    const level = headingLevels.get(name);
    if (level === undefined) continue;
    let start = skipSpace(active, tokens.lastIndex);
    if (active[start] === "*") start = skipSpace(active, start + 1);
    if (active[start] === "[") {
      const end = groupEnd(active, start);
      if (end < 0) continue;
      start = skipSpace(active, end);
    }
    if (active[start] !== "{") continue;
    const titleEnd = groupEnd(active, start);
    if (titleEnd < 0) continue;
    const title = active.slice(start + 1, titleEnd - 1).replace(/\s+/g, " ").trim();
    let headerEnd = titleEnd;
    for (;;) {
      label.lastIndex = headerEnd;
      if (!label.test(active)) break;
      const end = groupEnd(active, label.lastIndex - 1);
      if (end < 0) break;
      headerEnd = end;
    }
    // Keep any comment on the heading line attached to that heading.
    trailingComment.lastIndex = headerEnd;
    if (trailingComment.test(content)) headerEnd = trailingComment.lastIndex;
    closeHeadings(level, token.index);
    const heading = add(name, level, title, token.index, headerEnd);
    heading.scopeDepth = environments.length;
    openHeadings.push(heading);
    tokens.lastIndex = headerEnd;
  }
  closeHeadings(-Infinity, docEnd);
  // An unclosed abstract cannot be safely edited as a section.
  if (abstract) nodes.splice(nodes.indexOf(abstract), 1);
  for (const [i, node] of nodes.entries()) {
    const raw = content.slice(node.headerEnd, node.limit);
    const first = raw.search(/\S/);
    node.bodyStart = first < 0 ? node.headerEnd : node.headerEnd + first;
    node.bodyEnd = first < 0 ? node.headerEnd : node.headerEnd + raw.trimEnd().length;
    node.id = i + 1;
    node.headerLine = lineAt(node.headerStart);
    node.startLine = first < 0 ? lineAt(node.headerEnd) + 1 : lineAt(node.bodyStart);
    node.endLine = first < 0 ? node.startLine - 1 : lineAt(node.bodyEnd - 1);
  }
  return { lines, total: lines.length, docBeginLine: docBegin === null ? null : lineAt(docBegin), docEndLine, docEnd, nodes };
};

const findNode = (structure, query) => {
  if (!query || typeof query !== "object") return null;
  const desiredTitleKey = normalizeTitleKey(query.title);
  const titleMatches = node => !desiredTitleKey ||
    desiredTitleKey === normalizeTitleKey(node.title) ||
    desiredTitleKey === normalizeTitleKey(cleanTitle(node.title));
  if (query.sectionId !== undefined) {
    if (!Number.isInteger(query.sectionId)) return null;
    const id = query.sectionId;
    const node = structure.nodes.find((n) => n.id === id);
    if (!node || !titleMatches(node) ||
        (query.type && String(query.type).toLowerCase() !== node.type)) return null;
    return node;
  }
  const desiredType = typeof query.type === "string" ? query.type.toLowerCase() : null;
  if (!desiredTitleKey && !desiredType) return null;
  const matches = structure.nodes.filter((node) => {
    if (desiredType && node.type !== desiredType) return false;
    return titleMatches(node);
  });
  if (query.occurrence === undefined) return matches.length === 1 ? matches[0] : null;
  if (!Number.isInteger(query.occurrence) || query.occurrence < 1) return null;
  return matches[query.occurrence - 1] || null;
};

const sectionLookupError = "The section selector must match exactly one section. Call list_sections and use its sectionId, or specify the type, title and 1-based occurrence for repeated headings.";

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

// `partialRead`: the caller hands Axiom only part of the text (a section).
const readSectionSource = async (service, path, policy, conversationId, { partialRead = false } = {}) => {
  const read = await handleReadFile(service, { path }, policy, conversationId);
  if (read.error) return read;
  if (read.binary) return { error: "Cannot read sections from a binary file." };
  if (read.partial) return { error: "Save the complete editor draft before looking up its sections." };
  // An outline or a section: positions in this text, not the text itself
  // (agent-model-view.cjs).
  deliverPositions(service, conversationId, path, read.content, { truncatedRead: partialRead });
  return read;
};

const handleListSections = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args?.path);
  if (!targetPath) return { error: "path is empty." };
  if (isBlockedPath(targetPath, policy)) return { error: "Target path is read-protected." };
  if (!isTextExtension(targetPath, policy)) return { error: "Only text files can be read." };
  const read = await readSectionSource(service, targetPath, policy, conversationId);
  if (read.error) return read;
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
  const read = await readSectionSource(service, targetPath, policy, conversationId, { partialRead: true });
  if (read.error) return read;
  const structure = parseLatexStructure(read.content);
  const node = findNode(structure, args || {});
  if (!node) {
    return { error: sectionLookupError };
  }
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
    body: read.content.slice(node.bodyStart, node.bodyEnd).replace(/\r\n/g, "\n"),
  };
};

// A final TeX comment in a replacement must not consume a peer heading
// or the end of the document when it originally shared the same line.
const spliceSection = (source, start, end, replacement, newline) => {
  const rest = source.slice(end);
  if (rest && !/^[ \t]*[\r\n]/.test(rest)) {
    const lastLine = replacement.slice(replacement.lastIndexOf("\n") + 1);
    if (/^(?:\\.|[^%\\])*%/.test(lastLine)) replacement += newline;
  }
  return source.slice(0, start) + replacement + rest;
};

const handleReplaceSection = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args?.path);
  if (!targetPath) return { error: "path is empty." };
  const read = await readCurrentTextContent(service, policy, conversationId, targetPath, { forEdit: true });
  if (!read.ok) return read;
  const structure = parseLatexStructure(read.content);
  const node = findNode(structure, args || {});
  if (!node) {
    return { error: sectionLookupError };
  }
  const includeHeader = args?.includeHeader === true;
  if (typeof args?.content !== "string") return { error: "Supply the replacement content as text." };
  const replacementText = args.content;
  if (includeHeader && node.type === "abstract") {
    return { error: "To edit the abstract, supply its body with includeHeader=false. The environment boundaries are preserved." };
  }
  if (!includeHeader && HEADING_COMMANDS.some((heading) => heading.name === node.type)) {
    const peerHeader = parseLatexStructure(replacementText).nodes.some((other) =>
      headingLevels.has(other.type) && other.level <= node.level);
    if (peerHeader) return {
      error: `replace_section preserves the ${node.type} header. Supply only its body; the replacement contains an equal or higher-level heading. Use includeHeader=true only when intentionally replacing the header too.`,
    };
  }
  const newline = read.content.includes("\r\n") ? "\r\n" : "\n";
  let replacement = replacementText.replace(/\r?\n/g, newline);
  const start = includeHeader ? node.headerStart : node.bodyStart;
  if (!includeHeader && node.bodyStart === node.bodyEnd && replacement && node.type !== "preamble") {
    replacement = newline + replacement;
  }
  const updatedContent = spliceSection(read.content, start, node.bodyEnd, replacement, newline);
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
    allowStructuralRemoval: args?.allowStructuralRemoval === true,
    proposalType: "patch",
  });
};

const handleAppendToSection = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args?.path);
  if (!targetPath) return { error: "path is empty." };
  const read = await readCurrentTextContent(service, policy, conversationId, targetPath, { forEdit: true });
  if (!read.ok) return read;
  const structure = parseLatexStructure(read.content);
  const node = findNode(structure, args || {});
  if (!node) {
    return { error: sectionLookupError };
  }
  const appendText = typeof args?.content === "string" ? args.content : "";
  if (!appendText) return { error: "content is empty — nothing to append." };
  const newline = read.content.includes("\r\n") ? "\r\n" : "\n";
  const addition = appendText.replace(/^(?:[^\S\n]*\n)+|(?:\r?\n[^\S\n]*)+$/g, "").replace(/\r?\n/g, newline);
  if (!addition.trim()) return { error: "content is empty — nothing to append." };
  const separator = node.bodyEnd > node.bodyStart ? newline + newline : newline;
  const updatedContent = spliceSection(read.content, node.bodyEnd, node.bodyEnd, separator + addition, newline);
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
  cleanTitle,
  parseLatexStructure,
  formatOutline,
  findNode,
  handleListSections,
  handleReadSection,
  handleReplaceSection,
  handleAppendToSection,
};
