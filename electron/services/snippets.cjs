"use strict";

const fsp = require("fs/promises");
const path = require("path");

// Snippet storage for "keep the macros I reuse somewhere manageable"
// (issue #38). Two scopes, both plain JSON so they can be edited by hand or
// committed with the project:
//
//   global    — <userData>/snippets.json, available in every workspace
//   workspace — <workspace>/.tex64/snippets.json, travels with the project

const MAX_SNIPPETS = 500;
const MAX_BODY_LENGTH = 20_000;

const clampText = (value, limit) => {
  if (typeof value !== "string") {
    return "";
  }
  return value.length > limit ? value.slice(0, limit) : value;
};

// A prefix is what the writer types in the editor to pull the snippet in, so it
// has to be a single completion word.
const normalizePrefix = (value) =>
  clampText(value, 64)
    .trim()
    .replace(/\s+/g, "")
    .replace(/^\\+/, "");

const normalizeSnippet = (raw, scope) => {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const prefix = normalizePrefix(raw.prefix ?? raw.name);
  const body = clampText(raw.body, MAX_BODY_LENGTH);
  if (!prefix || !body) {
    return null;
  }
  return {
    id:
      typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim()
        : `${scope}-${prefix}-${Math.random().toString(36).slice(2, 10)}`,
    name: clampText(raw.name ?? prefix, 120).trim() || prefix,
    prefix,
    description: clampText(raw.description, 300).trim(),
    body,
    scope,
  };
};

const readSnippetFile = async (filePath, scope) => {
  const raw = await fsp.readFile(filePath, "utf8").catch(() => null);
  if (raw === null) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.snippets) ? parsed.snippets : [];
  const result = [];
  for (const entry of list.slice(0, MAX_SNIPPETS)) {
    const snippet = normalizeSnippet(entry, scope);
    if (snippet) {
      result.push(snippet);
    }
  }
  return result;
};

const writeSnippetFile = async (filePath, snippets) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify(
    snippets.map(({ scope, ...rest }) => rest),
    null,
    2
  );
  await fsp.writeFile(filePath, `${payload}\n`, "utf8");
};

// Shipped so the panel is never empty on first open, and because these are the
// commands a LaTeX writer retypes most.
const BUILTIN_SNIPPETS = [
  {
    id: "builtin-fig",
    name: "Figure",
    prefix: "fig",
    description: "figure environment with graphic, caption and label",
    body:
      "\\begin{figure}[${1:htbp}]\n" +
      "  \\centering\n" +
      "  \\includegraphics[width=${2:0.8\\linewidth}]{${3:path}}\n" +
      "  \\caption{${4:caption}}\n" +
      "  \\label{fig:${5:key}}\n" +
      "\\end{figure}",
  },
  {
    id: "builtin-table",
    name: "Table",
    prefix: "table",
    description: "table with tabular, caption and label",
    body:
      "\\begin{table}[${1:htbp}]\n" +
      "  \\centering\n" +
      "  \\begin{tabular}{${2:lcr}}\n" +
      "    \\hline\n" +
      "    ${3:head} \\\\\n" +
      "    \\hline\n" +
      "    ${4:body} \\\\\n" +
      "    \\hline\n" +
      "  \\end{tabular}\n" +
      "  \\caption{${5:caption}}\n" +
      "  \\label{tab:${6:key}}\n" +
      "\\end{table}",
  },
  {
    id: "builtin-align",
    name: "Aligned equations",
    prefix: "align",
    description: "align environment with a label",
    body: "\\begin{align}\n  ${1:lhs} &= ${2:rhs} \\label{eq:${3:key}}\n\\end{align}",
  },
  {
    id: "builtin-thm",
    name: "Theorem",
    prefix: "thm",
    description: "theorem environment with a label",
    body: "\\begin{theorem}[${1:name}]\\label{thm:${2:key}}\n  ${3:statement}\n\\end{theorem}",
  },
  {
    id: "builtin-newcommand",
    name: "New command",
    prefix: "newcommand",
    description: "macro definition with an argument count",
    body: "\\newcommand{\\\\${1:name}}[${2:1}]{${3:definition}}",
  },
].map((entry) => normalizeSnippet(entry, "builtin"));

class SnippetsService {
  constructor({ userDataPath, getRootPath } = {}) {
    this.userDataPath = userDataPath;
    this.getRootPath = typeof getRootPath === "function" ? getRootPath : () => null;
  }

  #globalPath() {
    if (!this.userDataPath) {
      return null;
    }
    return path.join(this.userDataPath, "snippets.json");
  }

  #workspacePath() {
    const rootPath = this.getRootPath();
    if (!rootPath) {
      return null;
    }
    return path.join(rootPath, ".tex64", "snippets.json");
  }

  #pathForScope(scope) {
    return scope === "workspace" ? this.#workspacePath() : this.#globalPath();
  }

  async list() {
    const globalPath = this.#globalPath();
    const workspacePath = this.#workspacePath();
    const [globalSnippets, workspaceSnippets] = await Promise.all([
      globalPath ? readSnippetFile(globalPath, "global") : Promise.resolve([]),
      workspacePath ? readSnippetFile(workspacePath, "workspace") : Promise.resolve([]),
    ]);
    return {
      ok: true,
      snippets: [...BUILTIN_SNIPPETS, ...globalSnippets, ...workspaceSnippets],
      hasWorkspace: Boolean(workspacePath),
    };
  }

  async save(snippet) {
    const scope = snippet?.scope === "workspace" ? "workspace" : "global";
    const filePath = this.#pathForScope(scope);
    if (!filePath) {
      return {
        ok: false,
        error:
          scope === "workspace"
            ? "No workspace is selected."
            : "Snippet storage is unavailable.",
      };
    }
    const normalized = normalizeSnippet(snippet, scope);
    if (!normalized) {
      return { ok: false, error: "A snippet needs a prefix and a body." };
    }
    const existing = await readSnippetFile(filePath, scope);
    const index = existing.findIndex((entry) => entry.id === normalized.id);
    if (index >= 0) {
      existing[index] = normalized;
    } else {
      if (existing.length >= MAX_SNIPPETS) {
        return { ok: false, error: "Too many snippets in this scope." };
      }
      existing.push(normalized);
    }
    await writeSnippetFile(filePath, existing);
    return { ok: true, snippet: normalized };
  }

  async remove(id, scope) {
    const targetScope = scope === "workspace" ? "workspace" : "global";
    const filePath = this.#pathForScope(targetScope);
    if (!filePath || typeof id !== "string" || !id) {
      return { ok: false, error: "Invalid snippet." };
    }
    const existing = await readSnippetFile(filePath, targetScope);
    const next = existing.filter((entry) => entry.id !== id);
    if (next.length === existing.length) {
      return { ok: false, error: "Snippet not found." };
    }
    await writeSnippetFile(filePath, next);
    return { ok: true };
  }
}

module.exports = { SnippetsService, normalizeSnippet, normalizePrefix, BUILTIN_SNIPPETS };
