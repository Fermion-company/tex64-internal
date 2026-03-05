const path = require("path");
const { normalizeRelativePath } = require("./workspace.cjs");

const DEFAULT_MAX_FILE_BYTES = 400_000;
const DEFAULT_MAX_READ_FILES = 16;
const DEFAULT_MAX_ITERATIONS = 500;
const DEFAULT_TEXT_EXTENSIONS = [
  "tex",
  "bib",
  "sty",
  "cls",
  "ltx",
  "dtx",
  "md",
  "txt",
  "log",
  "json",
  "yaml",
  "yml",
  "toml",
  "csv",
  "tsv",
  "xml",
  "html",
  "css",
  "svg",
  "js",
  "ts",
  "cjs",
  "mjs",
  "sh",
  "py",
];
const DEFAULT_BLOCKED_TOP_LEVEL = new Set([
  ".git",
  ".tex64",
  ".ssh",
  ".aws",
  ".gnupg",
  ".npm",
  ".yarn",
  ".pnpm-store",
  ".cache",
  "node_modules",
  "build",
  "dist",
  "out",
  "coverage",
  ".next",
  ".swiftpm",
  "DerivedData",
  "tex64.xcodeproj",
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".netrc",
]);
const ALWAYS_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".tex64",
  ".ssh",
  ".aws",
  ".gnupg",
  "node_modules",
  ".cache",
  ".next",
  ".swiftpm",
  "DerivedData",
  "tex64.xcodeproj",
  "build",
  "dist",
  "out",
  "coverage",
]);

const normalizePath = (value) => normalizeRelativePath((value ?? "").trim());

const normalizeStringList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const normalizeExtensionList = (value) => {
  const entries = normalizeStringList(value);
  const result = new Set();
  entries.forEach((entry) => {
    const clean = entry.toLowerCase().replace(/^\./, "");
    if (clean) {
      result.add(clean);
    }
  });
  return result;
};

const normalizeTopLevelList = (value) => {
  const entries = normalizeStringList(value);
  const result = new Set();
  entries.forEach((entry) => {
    const normalized = normalizePath(entry);
    const top = normalized.split("/")[0];
    if (top) {
      result.add(top);
    }
  });
  return result;
};

const clampNumber = (value, fallback, { min, max }) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
};

const normalizeLimit = (value, fallback) => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return parsed;
};

const normalizeEncoding = (value) => {
  if (typeof value === "string" && value.toLowerCase() === "base64") {
    return "base64";
  }
  return "utf8";
};

const wantsBase64 = (args) =>
  args?.binary === true || normalizeEncoding(args?.encoding) === "base64";

const buildAgentPolicy = (settings = {}) => {
  const maxFileBytes = normalizeLimit(settings.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const maxReadFiles = Math.round(
    normalizeLimit(settings.maxReadFiles, DEFAULT_MAX_READ_FILES)
  );
  let textExtensions = DEFAULT_TEXT_EXTENSIONS
    ? new Set(DEFAULT_TEXT_EXTENSIONS)
    : null;
  const overrideExtensions = normalizeExtensionList(settings.textExtensions);
  if (overrideExtensions.size > 0) {
    textExtensions = overrideExtensions;
  }
  const extraExtensions = normalizeExtensionList(settings.extraTextExtensions);
  if (textExtensions) {
    extraExtensions.forEach((entry) => textExtensions.add(entry));
  }
  let blockedTopLevel = new Set(DEFAULT_BLOCKED_TOP_LEVEL);
  const blockedOverride = normalizeTopLevelList(settings.blockedTopLevel);
  if (blockedOverride.size > 0) {
    blockedTopLevel = blockedOverride;
  }
  const allowedTopLevel = normalizeTopLevelList(settings.allowedTopLevel);
  return {
    maxFileBytes,
    maxReadFiles,
    textExtensions,
    blockedTopLevel,
    allowedTopLevel,
  };
};

const formatByteLimit = (bytes) => {
  if (!Number.isFinite(bytes)) {
    return "無制限";
  }
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb % 1 === 0 ? mb.toFixed(0) : mb.toFixed(1)}MB`;
  }
  return `${Math.round(bytes / 1024)}KB`;
};

const isPathAllowed = (relativePath, policy) => {
  const normalized = normalizePath(relativePath);
  if (!normalized) {
    return false;
  }
  const top = normalized.split("/")[0];
  if (policy?.allowedTopLevel?.has(top)) {
    return true;
  }
  if (policy?.blockedTopLevel?.has(top)) {
    return false;
  }
  return true;
};

const isBlockedPath = (relativePath, policy) => {
  const normalized = normalizePath(relativePath);
  if (!normalized) return true;
  const top = normalized.split("/")[0];
  if (policy?.allowedTopLevel?.has(top)) {
    return false;
  }
  return policy?.blockedTopLevel?.has(top) ?? false;
};

const isTextExtension = (relativePath, policy) => {
  if (!policy?.textExtensions || policy.textExtensions.size === 0) {
    return true;
  }
  const ext = path.extname(relativePath).toLowerCase();
  if (!ext) {
    return true;
  }
  return policy?.textExtensions?.has(ext.slice(1)) ?? false;
};

module.exports = {
  ALWAYS_IGNORED_DIRECTORIES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_READ_FILES,
  buildAgentPolicy,
  clampNumber,
  formatByteLimit,
  isBlockedPath,
  isPathAllowed,
  isTextExtension,
  normalizeEncoding,
  normalizeExtensionList,
  normalizePath,
  normalizeStringList,
  normalizeTopLevelList,
  wantsBase64,
};
