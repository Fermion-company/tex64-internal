const path = require("path");
const { readFileUpTo } = require("./bounded-file-read.cjs");
const { isUtf8 } = require("node:buffer");

// Legacy editor formats retain their existing decoding and size behaviour.
// The renderer trusts the main process's openFileResult, not an extension list.
const TEXT_FILE_EXTENSIONS = new Set([
  "tex", "bib", "sty", "cls", "bst", "bbx", "cbx", "cfg", "def", "lbx",
  "ins", "dtx", "ltx", "txt", "aux", "bbl", "blg", "log", "out", "toc",
  "lof", "lot", "fdb_latexmk", "fls",
]);

// Search and collaboration also use these names; content-based editor fallback
// must not expand either policy.
const EXTENDED_TEXT_FILE_EXTENSIONS = new Set([
  "py", "pyw", "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts",
  "json", "jsonc", "json5", "md", "markdown", "yaml", "yml", "toml", "xml",
  "html", "htm", "xhtml", "css", "scss", "sass", "less", "c", "h", "cpp",
  "hpp", "cc", "hh", "cxx", "hxx", "java", "kt", "kts", "rs", "go", "rb",
  "erb", "php", "pl", "pm", "lua", "swift", "m", "mm", "cs", "fs", "fsx",
  "hs", "erl", "ex", "exs", "clj", "cljs", "scala", "groovy", "dart", "r",
  "jl", "sql", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "vue",
  "svelte", "astro", "graphql", "gql", "proto", "cmake", "gradle", "conf",
  "properties", "env", "csv", "tsv", "lock", "editorconfig", "gitignore",
  "gitattributes", "dockerfile", "makefile", "mk", "nix", "zig", "diff", "patch",
]);
const EXTENDED_TEXT_FILE_NAMES = new Set([
  "makefile", "gnumakefile", "dockerfile", "rakefile", "gemfile", "procfile",
  "justfile", "vagrantfile", "brewfile", "license", "readme", "changelog",
  "authors", "contributing", "notice", "codeowners",
]);

const MAX_EXTENDED_TEXT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_UNKNOWN_TEXT_FILE_BYTES = MAX_EXTENDED_TEXT_FILE_BYTES;
const TEXT_SNIFF_BYTES = 8 * 1024;
const SEARCHABLE_SOURCE_EXTENSIONS = new Set(["tex", "bib", "sty", "cls"]);

const getLooseFileExtension = (name) => {
  const basename = typeof name === "string" ? path.basename(name).toLowerCase() : "";
  const ext = path.extname(basename).toLowerCase();
  if (ext) {
    return ext.startsWith(".") ? ext.slice(1) : ext;
  }
  return basename.startsWith(".") ? basename.slice(1) : "";
};

const isExtendedTextFileName = (name) => {
  const basename = typeof name === "string" ? path.basename(name).toLowerCase() : "";
  return EXTENDED_TEXT_FILE_EXTENSIONS.has(getLooseFileExtension(name)) ||
    EXTENDED_TEXT_FILE_NAMES.has(basename);
};

const looksBinary = (buffer) => buffer.subarray(0, TEXT_SNIFF_BYTES).includes(0);

const isUnknownTextBuffer = (buffer) =>
  buffer.length <= MAX_UNKNOWN_TEXT_FILE_BYTES && !looksBinary(buffer) && isUtf8(buffer);

const readUnknownTextFile = async (absolutePath) => {
  const data = await readFileUpTo(absolutePath, MAX_UNKNOWN_TEXT_FILE_BYTES);
  // Buffer.toString preserves a UTF-8 BOM for round-trip saves.
  return data && isUnknownTextBuffer(data) ? data.toString("utf8") : null;
};

const isSearchableSourceFile = (name) =>
  SEARCHABLE_SOURCE_EXTENSIONS.has(getLooseFileExtension(name)) ||
  isExtendedTextFileName(name);

module.exports = {
  TEXT_FILE_EXTENSIONS,
  EXTENDED_TEXT_FILE_EXTENSIONS,
  EXTENDED_TEXT_FILE_NAMES,
  getLooseFileExtension,
  isExtendedTextFileName,
  looksBinary,
  MAX_EXTENDED_TEXT_FILE_BYTES,
  MAX_UNKNOWN_TEXT_FILE_BYTES,
  TEXT_SNIFF_BYTES,
  isUnknownTextBuffer,
  readUnknownTextFile,
  SEARCHABLE_SOURCE_EXTENSIONS,
  isSearchableSourceFile,
};
