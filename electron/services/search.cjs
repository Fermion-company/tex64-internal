const path = require("path");
const fsp = require("fs/promises");
const { normalizeRelativePath } = require("./workspace.cjs");
const { isSearchableSourceFile } = require("./text-file-types.cjs");

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".tex64",
  ".swiftpm",
  "node_modules",
  "DerivedData",
  "build",
  "tex64.xcodeproj",
]);
const MAX_SEARCH_RESULTS = 200;
const PREVIEW_CONTEXT_BEFORE = 48;
const PREVIEW_CONTEXT_AFTER = 96;

const isSearchableFile = (name) => isSearchableSourceFile(name);

const buildPreview = (line, matchIndex, matchLength) => {
  const start = Math.max(0, matchIndex - PREVIEW_CONTEXT_BEFORE);
  const end = Math.min(line.length, matchIndex + matchLength + PREVIEW_CONTEXT_AFTER);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < line.length ? "..." : "";
  const snippet = line.slice(start, end);
  return {
    preview: `${prefix}${snippet}${suffix}`,
    matchStart: prefix.length + (matchIndex - start),
    matchLength,
  };
};

class SearchService {
  async search(rootPath, query) {
    const trimmed = (query ?? "").trim();
    if (!trimmed) {
      return [];
    }
    const lowerQuery = trimmed.toLowerCase();
    const results = [];

    const walk = async (dirPath) => {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (results.length >= MAX_SEARCH_RESULTS) {
          return;
        }
        if (entry.name.startsWith(".")) {
          continue;
        }
        if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        const absPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await walk(absPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (!isSearchableFile(entry.name)) {
          continue;
        }
        const content = await fsp.readFile(absPath, "utf8").catch(() => null);
        if (content === null) {
          continue;
        }
        if (!content.toLowerCase().includes(lowerQuery)) {
          continue;
        }
        const relPath = normalizeRelativePath(path.relative(rootPath, absPath));
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (results.length >= MAX_SEARCH_RESULTS) {
            return;
          }
          const line = lines[index];
          const matchIndex = line.toLowerCase().indexOf(lowerQuery);
          if (matchIndex < 0) {
            continue;
          }
          const match = buildPreview(line, matchIndex, lowerQuery.length);
          results.push({
            path: relPath,
            line: index + 1,
            preview: match.preview,
            matchStart: match.matchStart,
            matchLength: match.matchLength,
          });
        }
      }
    };

    await walk(rootPath);
    return results;
  }
}

module.exports = {
  SearchService,
};
