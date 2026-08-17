const path = require("path");

// Keep these sets in sync with web-src/app/files.ts.
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

const looksBinary = (buffer) => buffer.subarray(0, 8192).includes(0);

const isSearchableSourceFile = (name) =>
  SEARCHABLE_SOURCE_EXTENSIONS.has(getLooseFileExtension(name)) ||
  isExtendedTextFileName(name);

module.exports = {
  EXTENDED_TEXT_FILE_EXTENSIONS,
  EXTENDED_TEXT_FILE_NAMES,
  getLooseFileExtension,
  isExtendedTextFileName,
  looksBinary,
  MAX_EXTENDED_TEXT_FILE_BYTES,
  SEARCHABLE_SOURCE_EXTENSIONS,
  isSearchableSourceFile,
};
