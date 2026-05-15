const fs = require("fs");
const path = require("path");

const DEFAULT_MANAGED_TEXLIVE_YEAR = "2026";

const normalizeYear = (value) => {
  const text = String(value || "").trim();
  return /^\d{4}$/.test(text) ? text : DEFAULT_MANAGED_TEXLIVE_YEAR;
};

const getManagedTexliveYear = () =>
  normalizeYear(process.env.TEX64_MANAGED_TEXLIVE_YEAR);

const getManagedTexliveRoot = (platform = process.platform) => {
  if (typeof process.env.TEX64_MANAGED_TEXLIVE_ROOT === "string") {
    const override = process.env.TEX64_MANAGED_TEXLIVE_ROOT.trim();
    if (override) {
      return path.resolve(override);
    }
  }
  const year = getManagedTexliveYear();
  if (platform === "darwin") {
    return path.join("/Users", "Shared", "TeX64", "texlive", year);
  }
  if (platform === "win32") {
    return path.join("C:\\", "texlive", `tex64-${year}`);
  }
  return "";
};

const getManagedTexliveBinDirs = (
  platform = process.platform,
  arch = process.arch,
  root = getManagedTexliveRoot(platform)
) => {
  if (!root) {
    return [];
  }
  if (platform === "darwin") {
    const archSpecific = arch === "arm64" ? "aarch64-darwin" : "x86_64-darwin";
    const fallback = arch === "arm64" ? "x86_64-darwin" : "aarch64-darwin";
    return [
      path.join(root, "bin", "universal-darwin"),
      path.join(root, "bin", archSpecific),
      path.join(root, "bin", fallback),
    ];
  }
  if (platform === "win32") {
    return [path.join(root, "bin", "windows")];
  }
  if (platform === "linux") {
    const archSpecific = arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
    return [path.join(root, "bin", archSpecific)];
  }
  return [];
};

const getSystemTexliveBinDirs = (platform = process.platform) => {
  const year = getManagedTexliveYear();
  if (platform === "darwin") {
    return [
      "/Library/TeX/texbin",
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
    ];
  }
  if (platform === "win32") {
    return [
      path.join("C:\\", "texlive", year, "bin", "windows"),
      "C:\\texlive\\2026\\bin\\windows",
      "C:\\texlive\\2025\\bin\\windows",
      "C:\\texlive\\2024\\bin\\windows",
      "C:\\texlive\\2023\\bin\\windows",
      "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64",
      "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64",
    ];
  }
  return ["/usr/local/bin", "/usr/bin"];
};

const unique = (items) => {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (typeof item !== "string" || !item) {
      continue;
    }
    const key = process.platform === "win32" ? item.toLowerCase() : item;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
};

const getPreferredTexliveBinDirs = (platform = process.platform, arch = process.arch) =>
  unique([
    ...getManagedTexliveBinDirs(platform, arch),
    ...getSystemTexliveBinDirs(platform),
  ]);

const extendTexlivePath = (
  existingPath,
  platform = process.platform,
  arch = process.arch
) => {
  const base = typeof existingPath === "string" ? existingPath : "";
  return unique([...getPreferredTexliveBinDirs(platform, arch), base])
    .filter(Boolean)
    .join(path.delimiter);
};

const commandFileNames = (command, platform = process.platform) => {
  const base = String(command || "").trim();
  if (!base) {
    return [];
  }
  if (platform !== "win32" || /\.[a-z0-9]+$/i.test(base)) {
    return [base];
  }
  return [`${base}.exe`, `${base}.bat`, `${base}.cmd`, base];
};

const findTexCommand = (
  command,
  platform = process.platform,
  arch = process.arch,
  extraDirs = []
) => {
  const dirs = unique([
    ...extraDirs,
    ...getPreferredTexliveBinDirs(platform, arch),
    ...(process.env.PATH || "").split(path.delimiter),
  ]);
  const names = commandFileNames(command, platform);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
};

module.exports = {
  DEFAULT_MANAGED_TEXLIVE_YEAR,
  getManagedTexliveYear,
  getManagedTexliveRoot,
  getManagedTexliveBinDirs,
  getSystemTexliveBinDirs,
  getPreferredTexliveBinDirs,
  extendTexlivePath,
  commandFileNames,
  findTexCommand,
};
