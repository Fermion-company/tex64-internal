const path = require("path");
const fsp = require("fs/promises");
const { normalizeRelativePath } = require("./workspace.cjs");

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".tex180",
  ".swiftpm",
  "node_modules",
  "DerivedData",
  "build",
  "Resources",
  "tex180.xcodeproj",
]);
const TEXT_FILE_EXTENSIONS = new Set([
  "tex",
  "bib",
  "sty",
  "cls",
  "bst",
  "bbx",
  "cbx",
  "cfg",
  "def",
  "lbx",
  "ins",
  "dtx",
  "ltx",
  "aux",
  "bbl",
  "blg",
  "log",
  "out",
  "toc",
  "lof",
  "lot",
  "fdb_latexmk",
  "fls",
]);

const getFileExtension = (name) => {
  const ext = path.extname(name).toLowerCase();
  return ext.startsWith(".") ? ext.slice(1) : ext;
};

const isSearchableFile = (name) => getFileExtension(name) === "tex";

class SearchService {
  async search(rootPath, query) {
    const trimmed = (query ?? "").trim();
    if (!trimmed) {
      return [];
    }
    const lowerQuery = trimmed.toLowerCase();
    const results = [];
    const maxResults = 200;

    const walk = async (dirPath) => {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) {
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
        const relPath = normalizeRelativePath(path.relative(rootPath, absPath));
        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
          if (results.length >= maxResults) {
            return;
          }
          if (line.toLowerCase().includes(lowerQuery)) {
            results.push({
              path: relPath,
              line: index + 1,
              preview: line.trim(),
            });
          }
        });
      }
    };

    await walk(rootPath);
    return results;
  }
}

module.exports = {
  SearchService,
};
