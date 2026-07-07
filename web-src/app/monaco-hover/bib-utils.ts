import { escapeRegExp } from "./utils.js";

// LaTeX accent command → combining diacritical mark. Applied as
// letter + combining mark, then NFC-normalized ("\'e" → "é").
const ACCENT_COMBINING: Record<string, string> = {
  "'": "́",
  "`": "̀",
  '"': "̈",
  "^": "̂",
  "~": "̃",
  "=": "̄",
  ".": "̇",
  u: "̆",
  v: "̌",
  H: "̋",
  c: "̧",
  k: "̨",
};

const SPECIAL_LETTERS: Record<string, string> = {
  "\\ss": "ß",
  "\\o": "ø",
  "\\O": "Ø",
  "\\ae": "æ",
  "\\AE": "Æ",
  "\\aa": "å",
  "\\AA": "Å",
  "\\l": "ł",
  "\\L": "Ł",
  "\\i": "ı",
  "\\j": "ȷ",
};

/**
 * Reduce a raw BibTeX field value to plain readable text: resolve accent
 * commands, unwrap style commands, drop protective braces, and normalize
 * TeX punctuation. Best-effort — unknown commands keep their argument text.
 */
export const cleanBibValue = (value: string): string => {
  if (!value) {
    return "";
  }
  let text = value;
  // Accent commands: \'e, \'{e}, \c{c}, \v{s}, ...
  text = text.replace(
    /\\(['`"^~=.]|[uvHck])\s*\{?([a-zA-Z])\}?/g,
    (whole, cmd: string, letter: string) => {
      const mark = ACCENT_COMBINING[cmd];
      return mark ? `${letter}${mark}` : whole;
    }
  );
  for (const [command, replacement] of Object.entries(SPECIAL_LETTERS)) {
    text = text.split(`${command}{}`).join(replacement);
    text = text.replace(new RegExp(`${escapeRegExp(command)}(?![a-zA-Z])`, "g"), replacement);
  }
  // Style commands keep their argument text.
  text = text.replace(
    /\\(?:emph|textit|textbf|texttt|textsc|textrm|textsf|mathrm|text|mkbibquote|enquote)\s*\{([^{}]*)\}/g,
    "$1"
  );
  text = text.replace(/\\&/g, "&");
  text = text.replace(/\\%/g, "%");
  text = text.replace(/\\_/g, "_");
  text = text.replace(/---/g, "—");
  text = text.replace(/--/g, "–");
  text = text.replace(/~/g, " ");
  // Inline math: keep the content, drop the dollars.
  text = text.replace(/\$([^$]*)\$/g, "$1");
  // Remaining unknown commands: drop the backslash-name, keep braces content.
  text = text.replace(/\\[a-zA-Z]+\s*/g, "");
  text = text.replace(/[{}]/g, "");
  text = text.replace(/\s+/g, " ").trim();
  try {
    text = text.normalize("NFC");
  } catch {
    // Environments without full ICU keep the decomposed form.
  }
  return text;
};

const MAX_DISPLAY_AUTHORS = 3;

/** "Last, First and Last2, First2 and others" → "First Last, First2 Last2, et al." */
export const formatBibAuthors = (raw: string): string => {
  const cleaned = cleanBibValue(raw);
  if (!cleaned) {
    return "";
  }
  const parts = cleaned
    .split(/\s+and\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  let hasOthers = false;
  const names = parts
    .filter((part) => {
      if (/^others$/i.test(part)) {
        hasOthers = true;
        return false;
      }
      return true;
    })
    .map((part) => {
      const commaIndex = part.indexOf(",");
      if (commaIndex < 0) {
        return part;
      }
      const last = part.slice(0, commaIndex).trim();
      const first = part.slice(commaIndex + 1).trim();
      return first ? `${first} ${last}` : last;
    });
  if (names.length === 0) {
    return "";
  }
  if (hasOthers || names.length > MAX_DISPLAY_AUTHORS + 1) {
    return `${names.slice(0, MAX_DISPLAY_AUTHORS).join(", ")}, et al.`;
  }
  return names.join(", ");
};

/**
 * Format parsed BibTeX fields as a compact markdown card:
 * bold title, author line, year · venue, and DOI/URL links.
 */
export const formatBibEntryMarkdown = (fields: Record<string, string>): string => {
  const lines: string[] = [];
  const title = cleanBibValue(fields.title || "");
  if (title) {
    lines.push(`**${title}**`);
  }
  const authors = formatBibAuthors(fields.author || fields.editor || "");
  if (authors) {
    lines.push(authors);
  }
  const venue = cleanBibValue(
    fields.journal ||
      fields.booktitle ||
      fields.publisher ||
      fields.school ||
      fields.institution ||
      fields.howpublished ||
      ""
  );
  const year = cleanBibValue(fields.year || "");
  const meta = [year, venue].filter(Boolean).join(" · ");
  if (meta) {
    lines.push(meta);
  }
  const links: string[] = [];
  const doi = (fields.doi || "").trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  if (doi) {
    links.push(`[doi:${doi}](https://doi.org/${encodeURI(doi)})`);
  }
  const eprint = (fields.eprint || "").trim();
  const archivePrefix = (fields.archiveprefix || "").trim().toLowerCase();
  if (eprint && (archivePrefix === "arxiv" || /^\d{4}\.\d{4,5}/.test(eprint))) {
    links.push(`[arXiv:${eprint}](https://arxiv.org/abs/${encodeURI(eprint)})`);
  } else if (!doi && typeof fields.url === "string" && /^https?:\/\//i.test(fields.url.trim())) {
    links.push(`[URL](${fields.url.trim()})`);
  }
  if (links.length > 0) {
    lines.push(links.join(" · "));
  }
  return lines.join("  \n");
};

export const extractBibEntryText = (text: string, citeKey: string) => {
  if (!text || !citeKey) {
    return null;
  }
  const escaped = escapeRegExp(citeKey.trim());
  const headerRegex = new RegExp(`@\\w+\\s*\\{\\s*${escaped}\\s*,`, "i");
  const match = headerRegex.exec(text);
  if (!match || typeof match.index !== "number") {
    return null;
  }
  const openBraceIndex = text.indexOf("{", match.index);
  if (openBraceIndex < 0) {
    return null;
  }
  let depth = 0;
  let endIndex = -1;
  for (let i = openBraceIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    }
  }
  if (endIndex < 0) {
    return null;
  }
  return text.slice(match.index, endIndex + 1);
};

export const parseBibFields = (entryText: string) => {
  const fields: Record<string, string> = {};
  if (!entryText) {
    return fields;
  }
  const firstComma = entryText.indexOf(",");
  if (firstComma < 0) {
    return fields;
  }
  let i = firstComma + 1;
  const len = entryText.length;
  const skipSpace = () => {
    while (i < len && /[\s,]/.test(entryText[i])) {
      i += 1;
    }
  };
  const readName = () => {
    const start = i;
    while (i < len && /[A-Za-z]/.test(entryText[i])) {
      i += 1;
    }
    return entryText.slice(start, i);
  };
  const readValue = () => {
    skipSpace();
    if (i >= len) {
      return "";
    }
    const ch = entryText[i];
    if (ch === "{") {
      i += 1;
      let depth = 1;
      const start = i;
      while (i < len && depth > 0) {
        const c = entryText[i];
        if (c === "{") {
          depth += 1;
        } else if (c === "}") {
          depth -= 1;
        }
        i += 1;
      }
      const raw = entryText.slice(start, Math.max(start, i - 1));
      return raw;
    }
    if (ch === "\"") {
      i += 1;
      const start = i;
      while (i < len) {
        const c = entryText[i];
        if (c === "\\" && i + 1 < len) {
          i += 2;
          continue;
        }
        if (c === "\"") {
          break;
        }
        i += 1;
      }
      const raw = entryText.slice(start, i);
      if (entryText[i] === "\"") {
        i += 1;
      }
      return raw;
    }
    const start = i;
    while (i < len && entryText[i] !== "," && entryText[i] !== "\n") {
      i += 1;
    }
    return entryText.slice(start, i);
  };
  while (i < len) {
    skipSpace();
    const name = readName();
    if (!name) {
      break;
    }
    skipSpace();
    if (entryText[i] !== "=") {
      break;
    }
    i += 1;
    const value = readValue()
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^{|}$/g, "")
      .trim();
    if (value) {
      fields[name.toLowerCase()] = value;
    }
    skipSpace();
    if (entryText[i] === ",") {
      i += 1;
    }
  }
  return fields;
};

