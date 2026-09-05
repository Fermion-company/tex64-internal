/**
 * Where a change landed: the section it sits in and, once the PDF exists,
 * the page. The change card shows both in one line ("§3 Method · p.2").
 *
 * The section comes from the written file itself (first differing line
 * against the previous content, then the heading above it). The page comes
 * from the SyncTeX forward index after a successful build of this turn.
 */

"use strict";

const path = require("path");
const { outlineOf, sectionAtLine } = require("./agent-document-map.cjs");

/** First line (1-based) where the two texts differ; null when identical. */
const firstChangedLine = (before, after) => {
  const a = String(before ?? "").split(/\r?\n/);
  const b = String(after ?? "").split(/\r?\n/);
  const limit = Math.min(a.length, b.length);
  for (let index = 0; index < limit; index += 1) {
    if (a[index] !== b[index]) return index + 1;
  }
  if (a.length === b.length) return null;
  return limit + 1;
};

/** The section (title, number-free) containing the first change of a proposal. */
const describeProposalScope = (proposal) => {
  if (!proposal || typeof proposal !== "object") return null;
  if (typeof proposal.path !== "string" || !/\.(tex|ltx)$/i.test(proposal.path)) return null;
  if (proposal.encoding === "base64" || proposal.isBinary) return null;
  const after = typeof proposal.content === "string" ? proposal.content : "";
  const before = typeof proposal.originalContent === "string" ? proposal.originalContent : "";
  const line = proposal.isNewFile ? 1 : firstChangedLine(before, after);
  if (!line) return null;
  const sections = outlineOf(after);
  const section = sectionAtLine({ sections }, Math.min(line, Math.max(1, after.split(/\r?\n/).length)));
  return {
    line,
    ...(section
      ? {
          section: section.title || section.type,
          sectionType: section.type,
          sectionLine: section.line,
        }
      : {}),
  };
};

/** Remember a written proposal so its page can be resolved after the build. */
const rememberProposalForPages = (service, proposal) => {
  if (!proposal?.scope?.line || typeof proposal.path !== "string") return;
  const conversationId =
    typeof proposal.conversationId === "string" && proposal.conversationId.trim()
      ? proposal.conversationId.trim()
      : "default";
  if (!service.proposalScopesByConversation) service.proposalScopesByConversation = new Map();
  let list = service.proposalScopesByConversation.get(conversationId);
  if (!list) {
    list = [];
    service.proposalScopesByConversation.set(conversationId, list);
  }
  list.push({ proposalId: proposal.id, path: proposal.path, line: proposal.scope.line });
  if (list.length > 40) list.splice(0, list.length - 40);
};

/**
 * After a successful build: look up the page of every change of this
 * conversation that has no page yet, and tell the renderer.
 */
const resolveProposalPages = async (service, conversationId, pdfPath) => {
  const synctex = service.synctexService;
  if (!synctex || typeof synctex.forwardLinesQuick !== "function") return;
  const list = service.proposalScopesByConversation?.get(conversationId);
  if (!Array.isArray(list) || list.length === 0) return;
  const rootPath = service.workspace.getRootPath?.();
  if (!rootPath) return;
  const absolutePdf = path.isAbsolute(pdfPath) ? pdfPath : path.join(rootPath, pdfPath);
  const byPath = new Map();
  for (const entry of list) {
    if (entry.page) continue;
    const group = byPath.get(entry.path) ?? [];
    group.push(entry);
    byPath.set(entry.path, group);
  }
  for (const [relativePath, entries] of byPath) {
    let result;
    try {
      result = synctex.forwardLinesQuick({
        sourcePath: path.join(rootPath, relativePath),
        pdfPath: absolutePdf,
        lines: entries.map((entry) => entry.line),
      });
    } catch {
      continue;
    }
    if (!result?.ok || !Array.isArray(result.results)) continue;
    for (const hit of result.results) {
      if (!hit?.found || !Number.isFinite(hit.page)) continue;
      const entry = entries.find((candidate) => candidate.line === hit.line);
      if (!entry) continue;
      entry.page = hit.page;
      service.sendToRenderer("agent:proposalScope", {
        conversationId,
        proposalId: entry.proposalId,
        page: hit.page,
      });
    }
  }
};

module.exports = {
  describeProposalScope,
  firstChangedLine,
  rememberProposalForPages,
  resolveProposalPages,
};
