import { escapeRegExp } from "./utils.js";

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

