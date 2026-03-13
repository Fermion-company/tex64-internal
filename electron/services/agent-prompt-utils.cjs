/**
 * System prompt — OpenPrism style (simple, concise).
 *
 * Matches the system prompt from OpenPrism's agentService.js on GitHub.
 * Only change: "OpenPrism" -> "TeX64".
 */

"use strict";

const resolveResponseModel = (response) => {
  if (!response || typeof response !== "object") {
    return "";
  }
  const candidates = [
    response.resolvedModel,
    response.modelVersion,
    response.model,
    response.output?.model,
    response.usage?.model,
    response.usageMetadata?.model,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

const buildSystemPrompt = (_context, _rootPath) => {
  return [
    "You are a LaTeX paper assistant for TeX64.",
    "You can read files and propose patches via tools, and you may call tools multiple times.",
    "If a request affects multiple files (e.g., sections + bib), inspect and update all relevant files.",
    "You can use arxiv_search to find papers and arxiv_bibtex to generate BibTeX.",
    "Never assume writes are applied; use propose_patch and wait for user confirmation.",
    "Use apply_patch for localized edits; use propose_patch for full-file rewrites.",
    "Be concise. Provide a short summary in the final response.",
  ].join(" ");
};

module.exports = {
  resolveResponseModel,
  buildSystemPrompt,
};
