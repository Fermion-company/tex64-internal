import type { IndexEntry, SectionEntry } from "./types.js";
import { getUiLocale } from "./i18n.js";

export const dedupeByKey = (entries: IndexEntry[]) => {
  const map = new Map<string, IndexEntry>();
  entries.forEach((entry) => {
    if (!map.has(entry.key)) {
      map.set(entry.key, entry);
    }
  });
  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key, getUiLocale()));
};

export const dedupeByKeyAndLocation = (entries: IndexEntry[]) => {
  const map = new Map<string, IndexEntry>();
  entries.forEach((entry) => {
    const token = `${entry.key}|${entry.path}|${entry.line}`;
    if (!map.has(token)) {
      map.set(token, entry);
    }
  });
  return Array.from(map.values()).sort((a, b) =>
    a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path, getUiLocale())
  );
};

export const dedupeSections = (entries: SectionEntry[]) => {
  const map = new Map<string, SectionEntry>();
  entries.forEach((entry) => {
    const token = `${entry.title}|${entry.path}|${entry.line}|${entry.level}`;
    if (!map.has(token)) {
      map.set(token, entry);
    }
  });
  return Array.from(map.values()).sort((a, b) => {
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path, getUiLocale());
    }
    return a.line - b.line;
  });
};

export const pickCitationEntries = (entries: IndexEntry[]) => {
  const definitions = entries.filter((entry) => /\.bib$/i.test(entry.path) || entry.definition);
  return dedupeByKey(definitions.length ? definitions : entries);
};
