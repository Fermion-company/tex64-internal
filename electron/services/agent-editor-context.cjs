"use strict";

// Tab metadata is captured by the renderer. No source bodies are included here.
const getEditorContext = (context, offset = 0, limit = 16) => {
  const available = context?.contextControls?.includeOpenFiles !== false && Array.isArray(context?.openFiles);
  const start = Number.isInteger(offset) ? Math.max(0, offset) : 0;
  const size = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 16;
  const tabs = available ? context.openFiles.filter(tab => typeof tab?.path === "string" && tab.path) : [];
  return {
    available,
    focusedFile: context?.activeFilePath ?? null,
    total: tabs.length,
    files: tabs.slice(start, start + size).map(tab => ({
      path: tab.path, visible: Boolean(tab.isActive), unsaved: Boolean(tab.isDirty),
    })),
    nextOffset: start + size < tabs.length ? start + size : null,
  };
};

const buildEditorInput = (userText, context) => {
  const llmInputParts = [];
  if (context?.activeFilePath) {
    llmInputParts.push(`Active file: ${context.activeFilePath}`);
  }
  const editor = getEditorContext(context);
  if (editor.available) {
    llmInputParts.push(`OPEN EDITOR TABS (at send time; ${editor.total} total):\n` + JSON.stringify(editor.files) +
      (editor.nextOffset !== null ? "\nCall get_editor_context for the remaining tabs when available." : ""));
  }
  llmInputParts.push(`User prompt: ${userText}`);
  if (
    context?.activeSelection &&
    typeof context.activeSelection.text === "string" &&
    context.activeSelection.text.trim()
  ) {
    const selection = context.activeSelection;
    const where =
      typeof selection.path === "string" && Number.isFinite(selection.startLine)
        ? ` (${selection.path} L${selection.startLine}-${selection.endLine ?? selection.startLine})`
        : "";
    llmInputParts.push(`Selection${where}:\n${selection.text}`);
  }
  // Items the user pointed at with @: a section, a label, a bib entry, an
  // issue. Each comes with its exact place so the model reads there first.
  const contextRefs = Array.isArray(context?.explicitContextRefs)
    ? context.explicitContextRefs.filter((ref) => ref && typeof ref === "object").slice(0, 12)
    : [];
  if (contextRefs.length > 0) {
    const lines = contextRefs.map((ref) => {
      const at = typeof ref.path === "string" ? `${ref.path}${Number.isFinite(ref.line) ? `:${ref.line}` : ""}` : "";
      switch (ref.kind) {
        case "section":
          return `- section "${ref.title ?? ""}" in ${ref.path} L${ref.line}-${ref.endLine ?? ref.line}${Number.isFinite(ref.id) ? ` (id ${ref.id})` : ""}`;
        case "label":
          return `- label ${ref.key} defined at ${at}`;
        case "bib":
          return `- bib entry ${ref.key} in ${ref.path}${ref.title ? ` ("${ref.title}")` : ""}`;
        case "issue":
          return `- build issue at ${at}: ${ref.message ?? ""}`;
        case "file":
          return `- file ${ref.path}`;
        case "pdf":
          return `- the place the user marked on page ${ref.page} of the typeset PDF${ref.line ? `, which is ${ref.path}:${ref.line} in the source` : ""}${typeof ref.text === "string" && ref.text.trim() ? `; the text there reads: "${ref.text.trim().slice(0, 400)}"` : ""}. "Here" in the request means this place.`;
        default:
          return `- ${JSON.stringify(ref).slice(0, 200)}`;
      }
    });
    llmInputParts.push(`REFERENCED ITEMS (the user pointed at these; start there):\n${lines.join("\n")}`);
  }
  return llmInputParts.filter(Boolean).join("\n\n");
};

module.exports = { getEditorContext, buildEditorInput };
