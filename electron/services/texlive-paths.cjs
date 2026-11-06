const fs = require("fs");
const path = require("path");

const DEFAULT_MANAGED_TEXLIVE_YEAR = "2026";

const normalizeYear = (value) => {
  const text = String(value || "").trim();
  return /^\d{4}$/.test(text) ? text : DEFAULT_MANAGED_TEXLIVE_YEAR;
};

const getManagedTexliveYear = (env = process.env) =>
  normalizeYear(env?.TEX64_MANAGED_TEXLIVE_YEAR);

const getWindowsLocalAppData = (env = process.env) => {
  if (typeof env?.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim()) {
    return path.win32.resolve(env.LOCALAPPDATA.trim());
  }
  if (typeof env?.USERPROFILE === "string" && env.USERPROFILE.trim()) {
    return path.win32.join(env.USERPROFILE.trim(), "AppData", "Local");
  }
  if (
    typeof env?.HOMEDRIVE === "string" &&
    env.HOMEDRIVE.trim() &&
    typeof env?.HOMEPATH === "string" &&
    env.HOMEPATH.trim()
  ) {
    const profile = path.win32.resolve(
      `${env.HOMEDRIVE.trim()}${env.HOMEPATH.trim()}`
    );
    return path.win32.join(profile, "AppData", "Local");
  }
  if (typeof env?.APPDATA === "string" && env.APPDATA.trim()) {
    const roaming = path.win32.resolve(env.APPDATA.trim());
    if (path.win32.basename(roaming).toLowerCase() === "roaming") {
      return path.win32.join(path.win32.dirname(roaming), "Local");
    }
  }
  if (
    typeof env?.HOME === "string" &&
    /^(?:[a-z]:[\\/]|\\\\)/i.test(env.HOME.trim())
  ) {
    return path.win32.join(env.HOME.trim(), "AppData", "Local");
  }
  return "";
};

const getWindowsProgramData = (env = process.env) => {
  const value = String(env?.ProgramData || env?.PROGRAMDATA || env?.ALLUSERSPROFILE || "").trim();
  return value ? path.win32.resolve(value) : "C:\\ProgramData";
};

// TeX Live runs reliably only from a path of printable ASCII without spaces. A
// Japanese (or spaced) Windows user name puts %LOCALAPPDATA% outside that, so the
// managed tree then goes under %ProgramData%, the rule TinyTeX's installer uses.
const isPlainPath = (value) =>
  typeof value === "string" && value.length > 0 && [...value].every((ch) => ch.charCodeAt(0) > 32 && ch.charCodeAt(0) < 127);

// Folders holding the managed TeX Live, one tree per TeX Live year (<base>/2026),
// the folder new installs use first. The other Windows folder stays in the list so
// a tree already installed there is still found. Scoring64 uses the same rules
// (backend/scoring64/texenv.py), so the two apps share one TeX.
const getManagedTexliveBases = (platform = process.platform, env = process.env) => {
  if (typeof env?.TEX64_MANAGED_TEXLIVE_BASE === "string" && env.TEX64_MANAGED_TEXLIVE_BASE.trim()) {
    const base = env.TEX64_MANAGED_TEXLIVE_BASE.trim();
    return [platform === "win32" ? path.win32.resolve(base) : path.resolve(base)];
  }
  if (platform === "darwin") {
    return [path.join("/Users", "Shared", "TeX64", "texlive")];
  }
  if (platform === "win32") {
    const localAppData = getWindowsLocalAppData(env);
    const own = localAppData ? path.win32.join(localAppData, "TeX64", "texlive") : "";
    const shared = path.win32.join(getWindowsProgramData(env), "TeX64", "texlive");
    return (isPlainPath(own) ? [own, shared] : [shared, own]).filter(Boolean);
  }
  return [];
};

const pathFor = (platform) => (platform === "win32" ? path.win32 : path);

// <base>/.installing-<year> exists while TeX Live's installer fills <base>/<year>;
// such a tree is not used, and the next install replaces it.
const getInstallingFlagPath = (root, platform = process.platform) => {
  const p = pathFor(platform);
  return p.join(p.dirname(root), `.installing-${p.basename(root)}`);
};

const getRootYear = (root, platform = process.platform) => {
  const name = pathFor(platform).basename(String(root || ""));
  return /^\d{4}$/.test(name) ? name : "";
};

// release-texlive.txt in a tree or an unpacked installer: "... version 2026".
const readReleaseYear = (dir) => {
  try {
    const text = fs.readFileSync(path.join(dir, "release-texlive.txt"), "utf8").slice(0, 2000);
    const match = text.match(/version\s+(\d{4})/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
};

const hasTlmgr = (root, platform = process.platform, arch = process.arch) =>
  getManagedTexliveBinDirs(platform, arch, root).some((dir) =>
    ["tlmgr", "tlmgr.bat"].some((name) => fs.existsSync(pathFor(platform).join(dir, name)))
  );

// Every finished managed tree, newest TeX Live year first (the preferred folder
// first within a year).
const listManagedTexliveRoots = (
  platform = process.platform,
  env = process.env,
  arch = process.arch
) => {
  if (typeof env?.TEX64_MANAGED_TEXLIVE_ROOT === "string" && env.TEX64_MANAGED_TEXLIVE_ROOT.trim()) {
    const root = getManagedInstallRoot(null, platform, env);
    return hasTlmgr(root, platform, arch) && !fs.existsSync(getInstallingFlagPath(root, platform)) ? [root] : [];
  }
  const found = [];
  getManagedTexliveBases(platform, env).forEach((base, rank) => {
    let names = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      return;
    }
    for (const name of names) {
      const root = pathFor(platform).join(base, name);
      if (/^\d{4}$/.test(name) && hasTlmgr(root, platform, arch) && !fs.existsSync(getInstallingFlagPath(root, platform))) {
        found.push({ year: Number(name), rank, root });
      }
    }
  });
  found.sort((a, b) => b.year - a.year || a.rank - b.rank);
  return found.map((entry) => entry.root);
};

// Where a new managed tree for TeX Live `year` goes.
const getManagedInstallRoot = (year = null, platform = process.platform, env = process.env) => {
  if (typeof env?.TEX64_MANAGED_TEXLIVE_ROOT === "string") {
    const override = env.TEX64_MANAGED_TEXLIVE_ROOT.trim();
    if (override) {
      return platform === "win32" ? path.win32.resolve(override) : path.resolve(override);
    }
  }
  const bases = getManagedTexliveBases(platform, env);
  const chosen = /^\d{4}$/.test(String(year || "")) ? String(year) : getManagedTexliveYear(env);
  return bases.length ? pathFor(platform).join(bases[0], chosen) : "";
};

// The managed TeX Live in use: the newest finished tree, else where a new one
// would go ("" where there is none).
const getManagedTexliveRoot = (platform = process.platform, env = process.env) =>
  listManagedTexliveRoots(platform, env)[0] || getManagedInstallRoot(null, platform, env);

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
    return [path.win32.join(root, "bin", "windows")];
  }
  if (platform === "linux") {
    const archSpecific = arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
    return [path.join(root, "bin", archSpecific)];
  }
  return [];
};

// TinyTeX (https://yihui.org/tinytex) installs a user-owned TeX Live outside the
// usual system prefixes and only symlinks into PATH via `tlmgr path add`, which
// the user may have skipped. Probing its fixed home makes detection reliable.
const getTinytexRoot = (platform = process.platform, env = process.env) => {
  if (typeof env?.TINYTEX_DIR === "string" && env.TINYTEX_DIR.trim()) {
    return env.TINYTEX_DIR.trim();
  }
  if (platform === "win32") {
    const appData = typeof env?.APPDATA === "string" ? env.APPDATA.trim() : "";
    return appData ? path.win32.join(appData, "TinyTeX") : "";
  }
  const home = typeof env?.HOME === "string" ? env.HOME.trim() : "";
  if (!home) {
    return "";
  }
  return platform === "darwin"
    ? path.join(home, "Library", "TinyTeX")
    : path.join(home, ".TinyTeX");
};

const getTinytexBinDirs = (
  platform = process.platform,
  arch = process.arch,
  env = process.env
) => {
  const root = getTinytexRoot(platform, env);
  if (!root) {
    return [];
  }
  if (platform === "win32") {
    return [path.win32.join(root, "bin", "windows")];
  }
  if (platform === "darwin") {
    const archSpecific = arch === "arm64" ? "aarch64-darwin" : "x86_64-darwin";
    return [
      path.join(root, "bin", "universal-darwin"),
      path.join(root, "bin", archSpecific),
    ];
  }
  const archSpecific = arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
  return [path.join(root, "bin", archSpecific)];
};

const getSystemTexliveBinDirs = (
  platform = process.platform,
  arch = process.arch
) => {
  const year = getManagedTexliveYear();
  if (platform === "darwin") {
    return [
      "/Library/TeX/texbin",
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      ...getTinytexBinDirs(platform, arch),
    ];
  }
  if (platform === "win32") {
    // any C:\texlive\<year> (a newer year than this build knows included), newest first
    let installedYears = [];
    try {
      installedYears = fs.readdirSync("C:\\texlive").filter((name) => /^\d{4}$/.test(name)).sort().reverse();
    } catch {
      installedYears = [];
    }
    return [
      ...installedYears.map((y) => path.win32.join("C:\\", "texlive", y, "bin", "windows")),
      path.win32.join("C:\\", "texlive", year, "bin", "windows"),
      "C:\\texlive\\2026\\bin\\windows",
      "C:\\texlive\\2025\\bin\\windows",
      "C:\\texlive\\2024\\bin\\windows",
      "C:\\texlive\\2023\\bin\\windows",
      "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64",
      "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64",
      ...getTinytexBinDirs(platform, arch),
    ];
  }
  return ["/usr/local/bin", "/usr/bin", ...getTinytexBinDirs(platform, arch)];
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
    ...getSystemTexliveBinDirs(platform, arch),
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

const findCommandInDirs = (command, dirs, platform = process.platform) => {
  const names = commandFileNames(command, platform);
  for (const dir of unique(dirs)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
};

const findTexCommand = (
  command,
  platform = process.platform,
  arch = process.arch,
  extraDirs = []
) =>
  findCommandInDirs(
    command,
    [
      ...extraDirs,
      ...getPreferredTexliveBinDirs(platform, arch),
      ...(process.env.PATH || "").split(path.delimiter),
    ],
    platform
  );

// Strict managed-only lookup. Unlike findTexCommand it never falls through to a
// system TeX Live or PATH, so managed install / tlmgr operations can never target
// a read-only system installation such as /usr/local/texlive.
const findManagedTexCommand = (
  command,
  platform = process.platform,
  arch = process.arch,
  root = getManagedTexliveRoot(platform)
) => findCommandInDirs(command, getManagedTexliveBinDirs(platform, arch, root), platform);

module.exports = {
  DEFAULT_MANAGED_TEXLIVE_YEAR,
  getManagedTexliveYear,
  getWindowsLocalAppData,
  getWindowsProgramData,
  isPlainPath,
  getManagedTexliveBases,
  getInstallingFlagPath,
  getRootYear,
  readReleaseYear,
  listManagedTexliveRoots,
  getManagedInstallRoot,
  getManagedTexliveRoot,
  getManagedTexliveBinDirs,
  getTinytexRoot,
  getTinytexBinDirs,
  getSystemTexliveBinDirs,
  getPreferredTexliveBinDirs,
  extendTexlivePath,
  commandFileNames,
  findCommandInDirs,
  findTexCommand,
  findManagedTexCommand,
};
