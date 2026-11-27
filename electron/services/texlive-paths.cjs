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
  Boolean(findCommandInDirs("tlmgr", getManagedTexliveBinDirs(platform, arch, root), platform));

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
const getManagedTexliveRoot = (platform = process.platform, env = process.env, arch = process.arch) =>
  listManagedTexliveRoots(platform, env, arch)[0] || getManagedInstallRoot(null, platform, env);

// TeX Live 2023 changed the Windows binary directory from win32 to windows.
// TinyTeX and relocated trees need not include a year in the install path.
const windowsTexBins = root => ["windows", "win32"].map(name => path.win32.join(root, "bin", name));

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
    return windowsTexBins(root);
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
function windowsTinytexRoots(env) {
  const override = typeof env?.TINYTEX_DIR === "string" && env.TINYTEX_DIR.trim();
  if (override) {
    // Accept a portable tree itself and the parent used by TinyTeX's installer.
    return [override, path.win32.join(override, "TinyTeX")];
  }
  const roaming = typeof env?.APPDATA === "string" && env.APPDATA.trim();
  const own = roaming && path.win32.join(roaming, "TinyTeX");
  const shared = path.win32.join(getWindowsProgramData(env), "TinyTeX");
  return [own, shared].filter(Boolean);
}

const getTinytexRoot = (platform = process.platform, env = process.env) => {
  if (platform === "win32") {
    const roots = windowsTinytexRoots(env);
    return roots.find(root => fs.existsSync(path.win32.join(root, "bin"))) || roots[0];
  }
  if (typeof env?.TINYTEX_DIR === "string" && env.TINYTEX_DIR.trim()) {
    return env.TINYTEX_DIR.trim();
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
  if (platform === "win32") return windowsTinytexRoots(env).flatMap(windowsTexBins);
  const root = getTinytexRoot(platform, env);
  if (!root) return [];
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
    const local = getWindowsLocalAppData();
    const programDirs = [
      process.env.ProgramFiles || "C:/Program Files",
      process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
      local && path.win32.join(local, "Programs"),
    ].filter(Boolean);
    const systemDrive = process.env.SystemDrive || process.env.SYSTEMDRIVE ||
      path.win32.parse(process.env.SystemRoot || process.env.SYSTEMROOT || "").root;
    const drives = new Set([systemDrive, "C:"].filter(v => /^[a-z]:[\\/]?$/i.test(v))
      .map(v => v.slice(0, 2).toUpperCase()));
    const standard = [];
    for (const drive of drives) {
      const base = path.win32.join(drive + "\\", "texlive");
      let years = [];
      try { years = fs.readdirSync(base).filter(name => /^\d{4}$/.test(name)); } catch { /* defaults still apply */ }
      for (const y of [...new Set([...years, year, "2026", "2025", "2024", "2023", "2022"])].sort().reverse()) {
        standard.push(path.win32.join(base, y, "bin", Number(y) < 2023 ? "win32" : "windows"));
      }
    }
    return [
      ...standard,
      ...programDirs.map(dir => path.win32.join(dir, "MiKTeX", "miktex", "bin", "x64")),
      ...getTinytexBinDirs(platform, arch),
    ];
  }
  return ["/usr/local/bin", "/usr/bin", ...getTinytexBinDirs(platform, arch)];
};

const unique = (items, platform) => {
  const seen = new Set();
  return items.filter(item => {
    if (typeof item !== "string" || !item) return false;
    const key = platform === "win32" ? path.win32.normalize(item).toLowerCase() : item;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

function splitCommandPath(value, platform) {
  if (!value) return [];
  if (platform !== "win32") return value.split(":");
  // A semicolon in a quoted Windows PATH entry is part of the directory name.
  return (value.match(/(?:[^;"]+|"[^"]*")+/g) || []).map(dir => dir.trim().replace(/^"|"$/g, ""));
}

function commandSearchDirs(existingPath, platform, arch, extraDirs = []) {
  const p = pathFor(platform);
  const roots = getManagedTexliveBases(platform);
  const override = process.env.TEX64_MANAGED_TEXLIVE_ROOT?.trim();
  const ready = listManagedTexliveRoots(platform, process.env, arch);
  const dirs = unique([
    ...extraDirs,
    ...getManagedTexliveBinDirs(platform, arch, ready[0] || ""),
    ...getSystemTexliveBinDirs(platform, arch),
    ...splitCommandPath(existingPath, platform),
  ], platform);
  // The install destination may also be present in a PATH inherited from
  // the terminal. Do not launch its partially populated tools through either route.
  return dirs.filter(dir => {
    const bin = p.dirname(dir);
    if (p.basename(bin).toLowerCase() !== "bin") return true;
    const root = p.dirname(bin);
    const managed = override ? p.relative(override, root) === ""
      : /^\d{4}$/.test(p.basename(root)) && roots.some(base => p.relative(base, p.dirname(root)) === "");
    return !managed || ready.some(installed => p.relative(root, installed) === "");
  });
}

const getPreferredTexliveBinDirs = (platform = process.platform, arch = process.arch) =>
  commandSearchDirs("", platform, arch);

const extendTexlivePath = (existingPath, platform = process.platform, arch = process.arch) => {
  const dirs = commandSearchDirs(existingPath, platform, arch);
  return dirs.map(dir => platform === "win32" && dir.includes(";") ? '"' + dir + '"' : dir)
    .join(pathFor(platform).delimiter);
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
  for (const dir of unique(dirs, platform)) {
    for (const name of names) {
      const candidate = pathFor(platform).join(dir, name);
      try {
        if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) continue;
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* Continue to the next installation if this one is inaccessible. */ }
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
    commandSearchDirs(process.env.PATH, platform, arch, extraDirs),
    platform
  );

// Strict managed-only lookup. Unlike findTexCommand it never falls through to a
// system TeX Live or PATH, so managed install / tlmgr operations can never target
// a read-only system installation such as /usr/local/texlive.
const findManagedTexCommand = (
  command,
  platform = process.platform,
  arch = process.arch,
  root = getManagedTexliveRoot(platform, process.env, arch)
) => root && !fs.existsSync(getInstallingFlagPath(root, platform))
  ? findCommandInDirs(command, getManagedTexliveBinDirs(platform, arch, root), platform) : null;

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
