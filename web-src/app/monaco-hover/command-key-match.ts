import type { CommandKeyMatch } from "./types.js";

export const findCommandMatchAt = (
  line: string,
  cursorIndex: number,
  regex: RegExp,
  extractKey: (match: RegExpExecArray, cursorIndex: number) => CommandKeyMatch | null
) => {
  regex.lastIndex = 0;
  let match = regex.exec(line);
  while (match) {
    const extracted = extractKey(match, cursorIndex);
    if (extracted) {
      return extracted;
    }
    match = regex.exec(line);
  }
  return null;
};

export const extractSingleKey = (
  match: RegExpExecArray,
  cursorIndex: number
): CommandKeyMatch | null => {
  const command = match[1] ?? "";
  const content = match[2] ?? "";
  const braceIndex = match[0].indexOf("{");
  if (braceIndex < 0 || typeof match.index !== "number") {
    return null;
  }
  const contentStart = match.index + braceIndex + 1;
  const contentEnd = contentStart + content.length;
  if (cursorIndex < contentStart || cursorIndex > contentEnd) {
    return null;
  }
  const key = content.trim();
  if (!key) {
    return null;
  }
  const leading = content.match(/^\s*/)?.[0]?.length ?? 0;
  return {
    command,
    key,
    startIndex: contentStart + leading,
    endIndex: contentStart + leading + key.length,
  };
};

export const extractCiteKey = (
  match: RegExpExecArray,
  cursorIndex: number
): CommandKeyMatch | null => {
  const command = match[1] ?? "";
  const content = match[2] ?? "";
  const braceIndex = match[0].indexOf("{");
  if (braceIndex < 0 || typeof match.index !== "number") {
    return null;
  }
  const contentStart = match.index + braceIndex + 1;
  const contentEnd = contentStart + content.length;
  if (cursorIndex < contentStart || cursorIndex > contentEnd) {
    return null;
  }
  const offset = cursorIndex - contentStart;
  const beforeComma = content.lastIndexOf(",", Math.max(0, offset - 1));
  const afterComma = content.indexOf(",", offset);
  const segStart = beforeComma >= 0 ? beforeComma + 1 : 0;
  const segEnd = afterComma >= 0 ? afterComma : content.length;
  const segment = content.slice(segStart, segEnd);
  const leading = segment.match(/^\s*/)?.[0]?.length ?? 0;
  const key = segment.trim();
  if (!key) {
    return null;
  }
  return {
    command,
    key,
    startIndex: contentStart + segStart + leading,
    endIndex: contentStart + segStart + leading + key.length,
  };
};

export const extractCommaSeparatedKey = (
  command: string,
  content: string,
  contentStart: number,
  cursorIndex: number
): CommandKeyMatch | null => {
  const contentEnd = contentStart + content.length;
  if (cursorIndex < contentStart || cursorIndex > contentEnd) {
    return null;
  }
  const offset = cursorIndex - contentStart;
  const beforeComma = content.lastIndexOf(",", Math.max(0, offset - 1));
  const afterComma = content.indexOf(",", offset);
  const segStart = beforeComma >= 0 ? beforeComma + 1 : 0;
  const segEnd = afterComma >= 0 ? afterComma : content.length;
  const segment = content.slice(segStart, segEnd);
  const leading = segment.match(/^\s*/)?.[0]?.length ?? 0;
  const key = segment.trim();
  if (!key) {
    return null;
  }
  return {
    command,
    key,
    startIndex: contentStart + segStart + leading,
    endIndex: contentStart + segStart + leading + key.length,
  };
};

export const extractPackageKey = (
  match: RegExpExecArray,
  cursorIndex: number
): CommandKeyMatch | null => {
  const command = (match[1] ?? "usepackage").trim();
  const content = match[2] ?? "";
  const braceIndex = match[0].indexOf("{");
  if (braceIndex < 0 || typeof match.index !== "number") {
    return null;
  }
  const contentStart = match.index + braceIndex + 1;
  return extractCommaSeparatedKey(command, content, contentStart, cursorIndex);
};

export const extractDocumentClassKey = (
  match: RegExpExecArray,
  cursorIndex: number
): CommandKeyMatch | null => {
  const command = "documentclass";
  const content = match[1] ?? "";
  const braceIndex = match[0].indexOf("{");
  if (braceIndex < 0 || typeof match.index !== "number") {
    return null;
  }
  const contentStart = match.index + braceIndex + 1;
  const key = content.trim();
  if (!key) {
    return null;
  }
  const contentEnd = contentStart + content.length;
  if (cursorIndex < contentStart || cursorIndex > contentEnd) {
    return null;
  }
  const leading = content.match(/^\s*/)?.[0]?.length ?? 0;
  return {
    command,
    key,
    startIndex: contentStart + leading,
    endIndex: contentStart + leading + key.length,
  };
};

