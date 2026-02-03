import type { IndexEntry } from "./types.js";
import { dedupeByKey, pickCitationEntries } from "./index-utils.js";

export type CompletionState = { registered: boolean };

const REF_COMMAND_REGEX =
  /\\(?:eqref|ref|pageref|autoref|cref|Cref|namecref|Namecref|nameref|Nameref)\{([^}]*)$/;
const CITE_COMMAND_REGEX =
  /\\(?:cite|citet|citep|citeauthor|citeyear|autocite|parencite|textcite|footcite|supercite)(?:\\[[^\\]]*\\])*\\{([^}]*)$/;

const getPosixDirname = (filePath: string) => {
  const normalized = filePath.split("\\").join("/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
};

const posixRelative = (fromDir: string, toPath: string) => {
  const fromParts = fromDir ? fromDir.split("/").filter(Boolean) : [];
  const toParts = toPath ? toPath.split("/").filter(Boolean) : [];
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }
  const upCount = fromParts.length - common;
  const down = toParts.slice(common);
  const parts = [];
  for (let i = 0; i < upCount; i += 1) {
    parts.push("..");
  }
  parts.push(...down);
  return parts.join("/") || "";
};

const stripExtension = (pathValue: string) => {
  const idx = pathValue.lastIndexOf(".");
  if (idx <= 0) {
    return pathValue;
  }
  return pathValue.slice(0, idx);
};

const hasExplicitExtension = (pathValue: string) => {
  const name = pathValue.split("/").pop() ?? "";
  return name.includes(".");
};

const findPathCandidates = (params: {
  workspaceFiles: string[];
  activeFilePath: string;
  partial: string;
  allowedExtensions: Set<string>;
  preferOmitExtension: boolean;
}) => {
  const activeDir = getPosixDirname(params.activeFilePath);
  const raw = params.partial ?? "";
  const normalizedRaw = raw
    .split("\\")
    .join("/")
    .replace(/^\/+/, "")
    .replace(/^(\.\/)+/, "");
  const typedHasExt = hasExplicitExtension(normalizedRaw);
  const candidates = [];

  params.workspaceFiles.forEach((filePath) => {
    const normalized = filePath.split("\\").join("/");
    const ext = normalized.split(".").pop()?.toLowerCase() ?? "";
    if (!params.allowedExtensions.has(ext)) {
      return;
    }
    const relativeFromActive = posixRelative(activeDir, normalized);
    const insertBase =
      params.preferOmitExtension && !typedHasExt ? stripExtension(relativeFromActive) : relativeFromActive;
    if (normalizedRaw && !insertBase.startsWith(normalizedRaw)) {
      return;
    }
    candidates.push({
      label: insertBase,
      insertText: insertBase,
      detail: normalized,
    });
  });

  const unique = new Map<string, { label: string; insertText: string; detail: string }>();
  candidates.forEach((entry) => {
    if (!unique.has(entry.label)) {
      unique.set(entry.label, entry);
    }
  });
  return Array.from(unique.values()).sort((a, b) => a.label.localeCompare(b.label, "ja"));
};

const ENV_SNIPPETS: Record<string, string> = {
  figure: `figure}\n  \\centering\n  \\includegraphics[width=\\linewidth]{\${1:path}}\n  \\caption{\${2:caption}}\n  \\label{fig:\${3:key}}\n\\end{figure}`,
  table: `table}\n  \\centering\n  \\caption{\${1:caption}}\n  \\label{tab:\${2:key}}\n  \\begin{tabular}{\${3:cc}}\n    \${0}\n  \\end{tabular}\n\\end{table}`,
  align: `align}\n  \${0}\n\\end{align}`,
  itemize: `itemize}\n  \\item \${0}\n\\end{itemize}`,
};

export const registerCompletionProvider = (
  monaco: {
    languages?: {
      register?: (config: { id: string }) => void;
      registerCompletionItemProvider?: (
        languageId: string,
        provider: {
          triggerCharacters?: string[];
          provideCompletionItems: (
            model: { getLineContent: (lineNumber: number) => string },
            position: { lineNumber: number; column: number }
          ) => { suggestions: unknown[] };
        }
      ) => void;
      CompletionItemKind?: { Reference?: number; Value?: number };
    };
    Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
  },
  deps: {
    getActiveFilePath: () => string | null;
    getIndexLabels: () => IndexEntry[];
    getIndexCitations: () => IndexEntry[];
    getWorkspaceFiles: () => string[];
  },
  state: CompletionState
) => {
  if (state.registered || !monaco.languages?.registerCompletionItemProvider) {
    return;
  }
  monaco.languages.register?.({ id: "latex" });
  monaco.languages.register?.({ id: "bibtex" });

  const provideItems = (
    model: { getLineContent: (lineNumber: number) => string },
    position: { lineNumber: number; column: number }
  ) => {
    const activePath = deps.getActiveFilePath();
    if (!activePath || !activePath.endsWith(".tex")) {
      return { suggestions: [] };
    }
    const line = model.getLineContent(position.lineNumber);
    const linePrefix = line.slice(0, Math.max(position.column - 1, 0));
    const refMatch = linePrefix.match(REF_COMMAND_REGEX);
    const citeMatch = linePrefix.match(CITE_COMMAND_REGEX);
    const inputMatch = linePrefix.match(/\\input\{([^}]*)$/);
    const includeMatch = linePrefix.match(/\\include\{([^}]*)$/);
    const graphicsMatch = linePrefix.match(/\\includegraphics(?:\\[[^\\]]*\\])?\{([^}]*)$/);
    const beginMatch = linePrefix.match(/\\begin\{([^}]*)$/);

    let entries: IndexEntry[] = [];
    let partial = "";

    if (refMatch) {
      entries = dedupeByKey(deps.getIndexLabels());
      partial = (refMatch?.[1] ?? "").trimStart();
    } else if (citeMatch) {
      entries = pickCitationEntries(deps.getIndexCitations());
      const raw = citeMatch[1] ?? "";
      const parts = raw.split(",");
      partial = parts.length > 0 ? parts[parts.length - 1].trimStart() : "";
    } else if (inputMatch || includeMatch || graphicsMatch) {
      const activePath = deps.getActiveFilePath();
      if (!activePath || !activePath.endsWith(".tex")) {
        return { suggestions: [] };
      }
      const workspaceFiles = deps.getWorkspaceFiles();
      const rawPartial = (inputMatch?.[1] ?? includeMatch?.[1] ?? graphicsMatch?.[1] ?? "").trimStart();
      const allowedExtensions = inputMatch || includeMatch
        ? new Set(["tex"])
        : new Set(["png", "jpg", "jpeg", "pdf", "svg", "eps", "tif", "tiff"]);
      const suggestions = findPathCandidates({
        workspaceFiles,
        activeFilePath: activePath,
        partial: rawPartial,
        allowedExtensions,
        preferOmitExtension: Boolean(inputMatch || includeMatch),
      });
      const range = monaco.Range
        ? new monaco.Range(
            position.lineNumber,
            position.column - rawPartial.length,
            position.lineNumber,
            position.column
          )
        : undefined;
      const kind =
        monaco.languages?.CompletionItemKind?.Value ??
        monaco.languages?.CompletionItemKind?.Reference ??
        12;
      return {
        suggestions: suggestions.map((entry) => ({
          label: entry.label,
          kind,
          insertText: entry.insertText,
          range,
          detail: entry.detail,
        })),
      };
    } else if (beginMatch) {
      const typed = (beginMatch[1] ?? "").trimStart();
      const envNames = ["figure", "table", "align", "itemize", "enumerate", "quote", "center"];
      const filtered = envNames.filter((name) => name.startsWith(typed));
      const range = monaco.Range
        ? new monaco.Range(
            position.lineNumber,
            position.column - typed.length,
            position.lineNumber,
            position.column
          )
        : undefined;
      const kind = 27;
      const insertTextRule = 4;
      return {
        suggestions: filtered.map((env) => ({
          label: env,
          kind,
          insertText: ENV_SNIPPETS[env] ?? `${env}}\n  \${0}\n\\end{${env}}`,
          insertTextRules: insertTextRule,
          range,
        })),
      };
    } else {
      return { suggestions: [] };
    }

    const range = monaco.Range
      ? new monaco.Range(
          position.lineNumber,
          position.column - partial.length,
          position.lineNumber,
          position.column
        )
      : undefined;

    const kind =
      monaco.languages?.CompletionItemKind?.Reference ??
      monaco.languages?.CompletionItemKind?.Value ??
      17;

    const suggestions = entries.map((entry) => ({
      label: entry.key,
      kind,
      insertText: entry.key,
      range,
      detail: entry.path,
    }));

    return { suggestions };
  };

  ["latex", "plaintext"].forEach((languageId) => {
    monaco.languages?.registerCompletionItemProvider?.(languageId, {
      triggerCharacters: ["{", ",", "\\", "/", "."],
      provideCompletionItems: provideItems,
    });
  });

  state.registered = true;
};
