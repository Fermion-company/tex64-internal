const fs = require("fs");
const path = require("path");

const isEnvMissingMessage = (message) => {
  if (!message) {
    return false;
  }
  const lower = message.toLowerCase();
  const hasMissing = message.includes("見つかりません") || lower.includes("not found");
  const mentionsTool =
    lower.includes("latexmk") ||
    lower.includes("lualatex") ||
    lower.includes("pdflatex") ||
    lower.includes("xelatex") ||
    lower.includes("uplatex") ||
    message.includes("TeX環境");
  return hasMissing && mentionsTool;
};

const shouldForceMissingTool = (toolName) => {
  const raw = process.env.TEX64_E2E_FORCE_MISSING_TOOLS;
  if (!raw || typeof raw !== "string") {
    return false;
  }
  const needle = String(toolName ?? "").trim().toLowerCase();
  if (!needle) {
    return false;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(needle);
};

const splitArgsString = (input) => {
  if (!input || typeof input !== "string") {
    return [];
  }
  const result = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    result.push(current);
  }
  return result;
};

const normalizeLatexJobName = (value) => {
  if (!value || typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.split("\\").join("/");
  const base = normalized.split("/").pop() ?? "";
  const cleaned = base.replace(/\.pdf$/i, "").trim();
  return cleaned || null;
};

const pickJobNameFromLatexmkArgs = (args) => {
  if (!Array.isArray(args)) {
    return null;
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== "string") {
      continue;
    }
    if (arg.startsWith("-jobname=")) {
      return normalizeLatexJobName(arg.slice("-jobname=".length).trim());
    }
    if (arg === "-jobname") {
      const next = typeof args[index + 1] === "string" ? args[index + 1].trim() : "";
      return normalizeLatexJobName(next);
    }
  }
  return null;
};

const isPathWithinRoot = (rootPath, targetPath) => {
  if (!rootPath || typeof rootPath !== "string") {
    return false;
  }
  if (!targetPath || typeof targetPath !== "string") {
    return false;
  }
  const rootResolved = path.resolve(rootPath);
  const targetResolved = path.resolve(targetPath);
  const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const rootNormalized = normalize(rootResolved);
  const targetNormalized = normalize(targetResolved);
  return targetNormalized === rootNormalized || targetNormalized.startsWith(rootNormalized + path.sep);
};

const listRecentFiles = (dirPath, predicate, minMtimeMs) => {
  if (!dirPath || typeof dirPath !== "string") {
    return [];
  }
  const entries = [];
  let dirEntries = [];
  try {
    dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of dirEntries) {
    if (!entry?.isFile?.()) {
      continue;
    }
    const name = entry.name;
    if (!predicate(name)) {
      continue;
    }
    const absPath = path.join(dirPath, name);
    let mtimeMs = 0;
    try {
      const stats = fs.statSync(absPath);
      mtimeMs = Number(stats.mtimeMs) || 0;
    } catch {
      continue;
    }
    if (Number.isFinite(minMtimeMs) && mtimeMs < minMtimeMs) {
      continue;
    }
    entries.push({ path: absPath, mtimeMs });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
};

const parseFlsPdfOutputs = (content) => {
  if (!content || typeof content !== "string") {
    return { pwd: null, outputs: [] };
  }
  const lines = content.split(/\r?\n/);
  let pwd = null;
  const outputs = [];
  for (const line of lines) {
    if (typeof line !== "string") {
      continue;
    }
    if (line.startsWith("PWD ")) {
      const value = line.slice("PWD ".length).trim();
      if (value) {
        pwd = value;
      }
      continue;
    }
    if (!line.startsWith("OUTPUT ")) {
      continue;
    }
    const value = line.slice("OUTPUT ".length).trim();
    if (!value || !value.toLowerCase().endsWith(".pdf")) {
      continue;
    }
    outputs.push(value);
  }
  return { pwd, outputs };
};

const parseFdbPdfOutputs = (content) => {
  if (!content || typeof content !== "string") {
    return [];
  }
  const lines = content.split(/\r?\n/);
  const outputs = [];
  for (const line of lines) {
    if (typeof line !== "string") {
      continue;
    }
    const match = line.match(/^\["[^"]*"\]\s+\S+\s+"[^"]+"\s+"([^"]+?\.pdf)"\s+"[^"]*"/);
    if (!match) {
      continue;
    }
    const value = match[1]?.trim();
    if (!value) {
      continue;
    }
    outputs.push(value);
  }
  return outputs;
};

const pickOutDirFromLatexmkArgs = (args) => {
  if (!Array.isArray(args)) {
    return null;
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== "string") {
      continue;
    }
    if (arg.startsWith("-outdir=")) {
      return arg.slice("-outdir=".length).trim() || null;
    }
    if (arg === "-outdir") {
      const next = typeof args[index + 1] === "string" ? args[index + 1].trim() : "";
      return next || null;
    }
  }
  return null;
};

const normalizeOutDir = (rootPath, outDir) => {
  if (!outDir || typeof outDir !== "string") {
    return null;
  }
  const trimmed = outDir.trim();
  if (!trimmed || trimmed === ".") {
    return null;
  }
  if (path.isAbsolute(trimmed)) {
    return null;
  }
  const resolved = path.resolve(rootPath, trimmed);
  const rootResolved = path.resolve(rootPath);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return null;
  }
  const relative = path.relative(rootResolved, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join(path.sep);
};

module.exports = {
  isEnvMissingMessage,
  shouldForceMissingTool,
  splitArgsString,
  normalizeLatexJobName,
  pickJobNameFromLatexmkArgs,
  isPathWithinRoot,
  listRecentFiles,
  parseFlsPdfOutputs,
  parseFdbPdfOutputs,
  pickOutDirFromLatexmkArgs,
  normalizeOutDir,
};
