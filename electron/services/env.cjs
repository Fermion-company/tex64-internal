const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const {
  getOwnedProcessCompletion,
  spawnOwnedProcess,
  terminateWindowsProcessTree,
} = require("./process-tree.cjs");

const {
  extendTexlivePath,
  findTexCommand,
  findManagedTexCommand,
  getManagedTexliveRoot,
  getManagedTexliveYear,
  getManagedInstallRoot,
  getInstallingFlagPath,
  getRootYear,
  readReleaseYear,
  listManagedTexliveRoots,
  getTinytexRoot,
} = require("./texlive-paths.cjs");

const {
  ALL_PROBES,
  TEX_ENGINES,
  TEX_TOOLS,
  parseKpsewhichOutput,
  parseDistributionBanner,
  classifySource,
  rootFromBinPath,
  yearFromPath,
  describeDistribution,
  classifyCoverage,
  buildRecommendation,
} = require("./tex-detect.cjs");

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

// E2E seam: when set, command detection ignores any system TeX and only counts the
// app-managed install. Lets us verify the full "empty -> one-click install -> ready"
// flow on a machine that already has a system TeX, without deleting it.
const shouldIgnoreSystemTex = () => {
  const raw = process.env.TEX64_E2E_IGNORE_SYSTEM_TEX;
  return typeof raw === "string" && /^(1|true|yes)$/i.test(raw.trim());
};

const INSTALLER_URLS = {
  darwin: "https://mirror.ctan.org/systems/texlive/tlnet/install-tl-unx.tar.gz",
  win32: "https://mirror.ctan.org/systems/texlive/tlnet/install-tl.zip",
};

// Official TinyTeX-1 daily assets keep stable URLs while tracking the current
// TeX Live repository. TeX64 extracts them into its own managed root and never
// runs `tlmgr path add`, so an existing system TeX remains untouched.
const LIGHTWEIGHT_BUNDLE_URLS = {
  darwin:
    "https://github.com/rstudio/tinytex-releases/releases/download/daily/TinyTeX-1-darwin.tar.xz",
  win32:
    "https://github.com/rstudio/tinytex-releases/releases/download/daily/TinyTeX-1-windows.exe",
};

const INSTALL_VARIANTS = {
  light: {
    id: "light",
    scheme: "scheme-small",
    bundle: "TinyTeX-1",
    approxBytes: 300 * 1024 * 1024,
    approxDownloadBytes: 75 * 1024 * 1024,
  },
  full: {
    id: "full",
    scheme: "scheme-full",
    approxBytes: 5 * 1024 * 1024 * 1024,
  },
};

const DEFAULT_INSTALL_VARIANT = "light";

const FULL_INSTALL_ALIASES = new Set(["full", "texlive-full", "scheme-full"]);

// Old launcher builds used names such as basictex/tinytex/minimal. They now map
// to the supported lightweight profile; only an explicit full variant requests
// the multi-gigabyte package set.
const normalizeInstallVariant = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return FULL_INSTALL_ALIASES.has(normalized) ? "full" : "light";
};

// Written into the managed tree so later sessions can identify TeX64's profile.
const INSTALL_MARKER_FILE = "tex64-install.json";

// TeX Live's package repository, asked which TeX Live year it serves: the first
// 4 KB of its package list carries "depend release/2027". A new year appears every
// spring, and a managed tree of the year before can no longer add packages.
const RELEASE_REPOSITORIES = [
  "https://mirror.ctan.org/systems/texlive/tlnet",
  "https://tlnet.yihui.org",
];
const CROSS_RELEASE = /older than remote repository|cross release updates|is newer than local/i;

const parseReleaseYear = (text) => {
  const match = String(text || "").match(/^depend release\/(\d{4})\s*$/m);
  return match ? match[1] : "";
};

// Historical target names stay accepted so an old renderer can still ask a new
// main process to create a usable managed environment.
const TEXLIVE_INSTALL_TARGETS = new Set([
  "basictex",
  "synctex",
  "texlive",
  "full",
  "texlive-full",
  "scheme-full",
  "light",
  "tinytex",
  "minimal",
  "texlive-light",
]);

const normalizeProfilePath = (value) => {
  if (process.platform === "win32") {
    return String(value || "").replace(/\\/g, "/");
  }
  return String(value || "");
};

const fetch = async (...args) => {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is unavailable. Node.js 18+ is required.");
  }
  return globalThis.fetch(...args);
};

const runCommand = (command, args = [], options = {}) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ code: 1, signal: "aborted", output: "", ok: false, aborted: true });
      return;
    }
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : 600000;
    const env = { ...process.env, ...(options.env || {}) };
    if (options.extendPath !== false) {
      env.PATH = extendTexlivePath(env.PATH);
    }
    const useShell =
      process.platform === "win32" && /\.(?:bat|cmd)$/i.test(String(command || ""));
    const child = spawnOwnedProcess(command, args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      shell: useShell,
      detached: process.platform !== "win32",
    });
    let output = "";
    let lineBuffer = "";
    let settled = false;
    let killReason = null;
    let cleanupFailed = false;
    let terminationPromise = null;
    let forceKillTimer = null;
    let forceFinishTimer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer !== null) clearTimeout(forceKillTimer);
      if (forceFinishTimer !== null) clearTimeout(forceFinishTimer);
      options.signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const killTree = (reason) => {
      if (killReason !== null) return;
      killReason = reason;
      try {
        if (process.platform === "win32" && Number.isInteger(child.pid)) {
          terminationPromise = terminateWindowsProcessTree(child);
        } else if (Number.isInteger(child.pid)) {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        if (process.platform === "win32") {
          terminationPromise = Promise.resolve(false);
        }
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
      }
      forceKillTimer = setTimeout(() => {
        try {
          if (process.platform !== "win32" && Number.isInteger(child.pid)) {
            process.kill(-child.pid, "SIGKILL");
          } else if (process.platform !== "win32") {
            child.kill("SIGKILL");
          }
        } catch { /* already gone */ }
      }, 2_000);
      forceKillTimer.unref?.();
      // Some process wrappers never deliver close after termination. Release
      // the caller deterministically once the whole tree has had time to die.
      forceFinishTimer = setTimeout(() => {
        const settle = (verified = true) => {
          if (!verified && !cleanupFailed) {
            cleanupFailed = true;
            output += "\n[tex64] Windows process-tree cleanup could not be verified.\n";
          }
          finish(resolve, {
            code: 1,
            signal: reason,
            output,
            ok: false,
            aborted: reason === "aborted",
            cleanupFailed,
          });
        };
        if (process.platform === "win32" && terminationPromise) {
          void Promise.resolve(terminationPromise).then(
            settle,
            () => settle(false),
          );
          return;
        }
        settle();
      }, 5_000);
      forceFinishTimer.unref?.();
    };
    const onAbort = () => killTree("aborted");
    const onLine = typeof options.onLine === "function" ? options.onLine : null;
    const appendOutput = (chunk) => {
      const text = chunk.toString();
      output += text;
      if (output.length > 24000) {
        output = output.slice(-24000);
      }
      if (!onLine) {
        return;
      }
      lineBuffer += text;
      let newlineIndex;
      while ((newlineIndex = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        try {
          onLine(line);
        } catch {
          // progress parsing must never break the install
        }
      }
    };
    const timer = setTimeout(() => killTree("timeout"), timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.on("error", (error) => {
      finish(reject, error);
    });
    child.on("close", (code, signal) => {
      const settle = (verified = true) => {
        if (!verified && !cleanupFailed) {
          cleanupFailed = true;
          output += "\n[tex64] Windows process-tree cleanup could not be verified.\n";
        }
        finish(resolve, {
          code: code ?? 1,
          signal: killReason || signal,
          output,
          ok: code === 0 && killReason === null && !cleanupFailed,
          aborted: killReason === "aborted" || options.signal?.aborted === true,
          cleanupFailed,
        });
      };
      if (process.platform === "win32" && terminationPromise) {
        void Promise.resolve(terminationPromise).then(
          settle,
          () => settle(false),
        );
        return;
      }
      if (process.platform === "win32") {
        settle(getOwnedProcessCompletion(child)?.cleanupOk === true);
        return;
      }
      settle();
    });
  });

const ensureOk = async (command, args, options = {}) => {
  const result = await runCommand(command, args, options);
  if (!result.ok) {
    const suffix = result.output ? `\n${result.output.trim()}` : "";
    throw new Error(`${path.basename(command)} failed with code ${result.code}.${suffix}`);
  }
  return result;
};

const downloadFile = async (url, outPath, options = {}) => {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${url} (${response.status})`);
  }
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const totalHeader = Number.parseInt(response.headers.get("content-length") || "", 10);
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
  let current = 0;
  const readable = Readable.fromWeb(response.body);
  if (typeof options.onProgress === "function") {
    readable.on("data", (chunk) => {
      current += chunk.length;
      options.onProgress(current, total);
    });
  }
  await pipeline(readable, fs.createWriteStream(outPath));
};

const walkForFile = async (rootDir, fileNames) => {
  const wanted = new Set(fileNames.map((name) => name.toLowerCase()));
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if ((entry.isFile() || entry.isSymbolicLink()) && wanted.has(entry.name.toLowerCase())) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
  return null;
};

// TinyTeX's macOS archive contains absolute links into the directory where the
// archive was unpacked. TeX64 relocates that tree into its managed root, so
// rewrite only links that still point inside the extracted tree. External links
// (if a future bundle contains any) are deliberately left untouched.
const rewriteRelocatedSymlinks = async (rootDir, extractedRoot) => {
  if (process.platform === "win32") {
    return 0;
  }
  const normalizedSource = path.resolve(extractedRoot);
  const normalizedDestination = path.resolve(rootDir);
  const stack = [normalizedDestination];
  let rewritten = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isSymbolicLink()) {
        continue;
      }
      const target = await fsp.readlink(entryPath);
      if (
        !path.isAbsolute(target) ||
        (target !== normalizedSource && !target.startsWith(`${normalizedSource}${path.sep}`))
      ) {
        continue;
      }
      const relocatedTarget = path.join(
        normalizedDestination,
        path.relative(normalizedSource, target)
      );
      await fsp.unlink(entryPath);
      await fsp.symlink(relocatedTarget, entryPath);
      rewritten += 1;
    }
  }
  return rewritten;
};

const SAFE_TEX_FILE = /^[A-Za-z0-9][A-Za-z0-9+_.-]*\.(?:sty|cls|clo|cfg|def|fd|tex|lua|bst|bbx|cbx|lbx|tfm|map|enc|otf|ttf|ttc|pfb)$/i;
const SAFE_TEX_PACKAGE = /^[A-Za-z0-9][A-Za-z0-9+_.-]*$/;

const extractMissingTexFiles = (output) => {
  if (typeof output !== "string" || !output.trim()) {
    return [];
  }
  const files = [];
  const seen = new Set();
  const patterns = [
    /(?:(?:LaTeX|Package\s+\S+)\s+Error:\s+File|I can't find file)\s+[`']([^`'\r\n]+)[`'](?:\s+not found)?/gi,
    // luaotfload reports a missing font separately from LaTeX's usual
    // "File ... not found" error, but tlmgr can resolve the font filename in
    // exactly the same safe way as a .sty or .cls file.
    /\bFile not found:\s*["']([^"'\r\n]+)["']/gi,
    /\bfile:([A-Za-z0-9][A-Za-z0-9+_.-]*\.(?:otf|ttf|ttc|pfb))(?=[:;\s])[^\r\n]*\bnot loadable\b/gi,
  ];
  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(output)) !== null) {
      const fileName = path.basename(String(match[1] || "").trim());
      const key = fileName.toLowerCase();
      if (!SAFE_TEX_FILE.test(fileName) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      files.push(fileName);
      if (files.length >= 8) {
        return files;
      }
    }
  }
  return files;
};

const parseTlmgrSearchPackages = (output, fileName) => {
  if (typeof output !== "string" || !output.trim() || !SAFE_TEX_FILE.test(fileName)) {
    return [];
  }
  const wanted = fileName.toLowerCase();
  const packages = [];
  const seen = new Set();
  let activePackage = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const packageHeader = rawLine.match(/^([^\s:][^:]*):\s*$/);
    if (packageHeader) {
      const candidate = packageHeader[1].trim();
      activePackage = SAFE_TEX_PACKAGE.test(candidate) ? candidate : null;
      continue;
    }
    if (!activePackage) {
      continue;
    }
    const listedPath = rawLine.trim().replace(/\\/g, "/");
    if (path.posix.basename(listedPath).toLowerCase() !== wanted) {
      continue;
    }
    const key = activePackage.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      packages.push(activePackage);
    }
  }
  return packages;
};

class EnvService {
  constructor() {
    this.platform = process.platform;
    this.arch = process.arch;
    this.onProgress = null;
    this.progressVariant = DEFAULT_INSTALL_VARIANT;
    this.detectCache = null;
    this.detectInFlight = null;
    this.detectEpoch = 0;
  }

  // An install or repair changes the answer: drop the cached report and stop
  // sharing a probe that started before the change.
  invalidateDetection() {
    this.detectCache = null;
    this.detectInFlight = null;
    this.detectEpoch += 1;
  }

  // Map each install phase onto a single monotonic 0-100 bar so the renderer can
  // show real, forward-moving progress (the long install-tl / tlmgr phases carry
  // an actual package count). Driven by parsed "[n/m]" lines, not CSS animation,
  // so it keeps moving even under prefers-reduced-motion.
  emitProgress(phase, current = null, total = null) {
    if (typeof this.onProgress !== "function") {
      return;
    }
    const hasCount = Number.isFinite(current) && Number.isFinite(total) && total > 0;
    const ratio = hasCount ? Math.min(1, current / total) : 0;
    let percent = null;
    if (this.progressVariant === "light") {
      if (phase === "download") {
        percent = hasCount ? Math.min(80, 2 + Math.round(ratio * 78)) : 2;
      } else if (phase === "extract") {
        percent = 84;
      } else if (phase === "texlive") {
        percent = 90;
      } else if (phase === "packages") {
        percent = hasCount ? Math.min(98, 90 + Math.round(ratio * 8)) : 92;
      } else if (phase === "finalize") {
        percent = 99;
      }
    } else if (phase === "download") {
      percent = 2;
    } else if (phase === "extract") {
      percent = 6;
    } else if (phase === "texlive") {
      percent = Math.min(80, 8 + Math.round(ratio * 72));
    } else if (phase === "packages") {
      percent = Math.min(98, 80 + Math.round(ratio * 18));
    } else if (phase === "finalize") {
      percent = 99;
    }
    try {
      this.onProgress({
        phase,
        // Byte counts make the UI noisy; they are only used to calculate the
        // lightweight bundle's real download percentage.
        current: hasCount && phase !== "download" ? current : null,
        total: hasCount && phase !== "download" ? total : null,
        percent,
      });
    } catch {
      // never let progress reporting break the install
    }
  }

  getPlatform() {
    return this.platform;
  }

  extendPath(existingPath) {
    return extendTexlivePath(existingPath, this.platform, this.arch);
  }

  findCommand(command, extraDirs = []) {
    return findTexCommand(command, this.platform, this.arch, extraDirs);
  }

  async checkCommand(command) {
    if (shouldForceMissingTool(command)) {
      return false;
    }
    if (shouldIgnoreSystemTex()) {
      return Boolean(this.findManagedCommand(command));
    }
    const found = this.findCommand(command);
    if (found) {
      return true;
    }
    try {
      const checker = this.platform === "win32" ? "where" : "which";
      const result = await runCommand(checker, [command], {
        timeoutMs: 30000,
        extendPath: true,
      });
      return result.ok;
    } catch {
      return false;
    }
  }

  managedRoot() {
    return getManagedTexliveRoot(this.platform);
  }

  installTimeoutMs() {
    const parsed = Number.parseInt(
      process.env.TEX64_MANAGED_TEXLIVE_INSTALL_TIMEOUT_MS || "",
      10
    );
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 90 * 60 * 1000;
  }

  async installEnvironment(target, onProgress, options = {}) {
    this.onProgress = typeof onProgress === "function" ? onProgress : null;
    try {
      if (this.platform !== "darwin" && this.platform !== "win32") {
        return { success: false, message: "Unsupported platform." };
      }
      const variant = normalizeInstallVariant(options.variant || target);
      this.progressVariant = variant;
      if (TEXLIVE_INSTALL_TARGETS.has(String(target || "").trim().toLowerCase())) {
        return options.renew === true
          ? await this.renewManagedTexlive()
          : await this.installManagedTexlive(variant);
      }
      if (target === "latexmk" || target === "latexindent") {
        return await this.installManagedTexPackage(target, target);
      }
      return { success: false, message: "Unknown install target." };
    } catch (error) {
      return {
        success: false,
        message:
          typeof error?.message === "string" && error.message
            ? error.message
            : "Installation failed.",
      };
    } finally {
      this.onProgress = null;
      this.progressVariant = DEFAULT_INSTALL_VARIANT;
    }
  }

  async installManagedTexPackage(target, packageName) {
    if (await this.checkCommand(target)) {
      return { success: true, message: `${target} is already available.` };
    }
    const variant = this.readInstallMarker().variant ?? DEFAULT_INSTALL_VARIANT;
    await this.ensureManagedTexliveInstalled(variant);
    if (!(await this.checkCommand(target))) {
      await this.runTlmgr(["install", packageName], {
        allowFailure: false,
        timeoutMs: this.installTimeoutMs(),
      });
    }
    const available = await this.checkCommand(target);
    return {
      success: available,
      message: available
        ? `${target} was installed in the TeX64 managed TeX Live environment.`
        : `${target} installation finished, but the command was not detected.`,
    };
  }

  async installManagedTexlive(variant = DEFAULT_INSTALL_VARIANT) {
    let resolved = normalizeInstallVariant(variant);
    const alreadyInstalled = Boolean(this.findManagedCommand("tlmgr"));
    const currentVariant = this.readInstallMarker().variant;
    if (alreadyInstalled && currentVariant === "full") {
      // Never replace a complete tree with a lightweight one.
      resolved = "full";
    } else if (alreadyInstalled && currentVariant === "light" && resolved === "full") {
      this.emitProgress("packages");
      await this.runTlmgr(["install", "scheme-full"], {
        allowFailure: false,
        timeoutMs: this.installTimeoutMs(),
      });
    } else {
      await this.ensureManagedTexliveInstalled(resolved);
    }
    if (resolved === "light" && !this.findManagedCommand("synctex")) {
      this.emitProgress("packages");
      await this.runTlmgr(["install", "synctex"], {
        allowFailure: false,
        timeoutMs: this.installTimeoutMs(),
      });
    }
    this.emitProgress("finalize");
    const [lualatex, latexmk, synctex] = await Promise.all([
      this.checkCommand("lualatex"),
      this.checkCommand("latexmk"),
      this.checkCommand("synctex"),
    ]);
    const success = Boolean(lualatex && latexmk && synctex);
    if (success) {
      this.writeInstallMarker(resolved);
    }
    this.invalidateDetection();
    return {
      success,
      variant: resolved,
      message: success
        ? `TeX64 managed TeX Live ${getManagedTexliveYear()} is ready.`
        : "TeX Live installation finished, but required commands were not detected.",
    };
  }

  // A new TeX Live year is out: install the same kind of tree (light or full) for
  // it, then remove the managed trees of earlier years. Scoring64 does the same
  // from its own TeX dialog, on the same shared folder.
  async renewManagedTexlive() {
    const current = this.managedRoot();
    const older = getRootYear(current, this.platform);
    if (!this.findManagedCommand("tlmgr") || !older) {
      return { success: false, message: "There is no TeX64-managed TeX Live to renew." };
    }
    const variant = this.readInstallMarker().variant ?? DEFAULT_INSTALL_VARIANT;
    this.progressVariant = variant;
    // no download when the repository is still on this year
    const latest = await this.checkRemoteYear({ force: true });
    if (latest && Number(latest) <= Number(older)) {
      return { success: false, variant, message: `No newer TeX Live than ${older} is out yet.` };
    }
    try {
      await this.ensureManagedTexliveInstalled(variant, { older });
    } catch (error) {
      if (error?.code === "NO_NEWER_RELEASE") {
        return { success: false, variant, message: error.message };
      }
      throw error;
    }
    if (variant === "light" && !this.findManagedCommand("synctex")) {
      this.emitProgress("packages");
      await this.runTlmgr(["install", "synctex"], { allowFailure: false, timeoutMs: this.installTimeoutMs() });
    }
    this.emitProgress("finalize");
    const renewed = this.managedRoot();
    const ready = Boolean(this.findManagedCommand("lualatex") && this.findManagedCommand("latexmk"));
    if (!ready || renewed === current) {
      this.invalidateDetection();
      return { success: false, variant, message: "The new TeX Live was installed, but required commands were not detected." };
    }
    this.writeInstallMarker(variant);
    await this.removeOlderManagedTrees(renewed);
    this.remoteBlocked = "";
    this.invalidateDetection();
    return {
      success: true,
      variant,
      message: `TeX64 managed TeX Live ${getRootYear(renewed, this.platform)} is ready.`,
    };
  }

  // Only managed trees (a marker or TinyTeX's token): never a system TeX.
  async removeOlderManagedTrees(root) {
    const year = Number(getRootYear(root, this.platform));
    for (const old of listManagedTexliveRoots(this.platform)) {
      const oldYear = Number(getRootYear(old, this.platform));
      const managed = fs.existsSync(path.join(old, INSTALL_MARKER_FILE)) || fs.existsSync(path.join(old, ".tinytex"));
      if (old !== root && managed && oldYear && year && oldYear < year) {
        await fsp.rm(old, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  // The TeX Live year the repository serves, at most every 12 hours; "" offline.
  async checkRemoteYear(options = {}) {
    const cache = this.remoteYearCache;
    if (options.force !== true && cache && Date.now() - cache.at < 12 * 60 * 60 * 1000) {
      return cache.year;
    }
    for (const repository of RELEASE_REPOSITORIES) {
      try {
        const response = await fetch(`${repository}/tlpkg/texlive.tlpdb`, {
          headers: { Range: "bytes=0-4095" },
          signal: AbortSignal.timeout(15000),
        });
        const year = parseReleaseYear((await response.text()).slice(0, 8192));
        if (year) {
          this.remoteYearCache = { at: Date.now(), year };
          return year;
        }
      } catch {
        // try the next repository
      }
    }
    return cache?.year || "";
  }

  installMarkerPath() {
    const root = this.managedRoot();
    return root ? path.join(root, INSTALL_MARKER_FILE) : "";
  }

  // `variant: null` means there is no record. Both current profiles are kept so
  // the build path knows whether missing packages may be installed on demand.
  readInstallMarker() {
    const unknown = { variant: null, installedAt: null, known: false };
    const markerPath = this.installMarkerPath();
    if (!markerPath) {
      return unknown;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (typeof parsed?.variant !== "string" || !parsed.variant.trim()) {
        return unknown;
      }
      const storedVariant = parsed.variant.trim().toLowerCase();
      return {
        variant: storedVariant === "light" ? "light" : "full",
        installedAt: typeof parsed?.installedAt === "string" ? parsed.installedAt : null,
        known: true,
      };
    } catch {
      return unknown;
    }
  }

  writeInstallMarker(variant) {
    const markerPath = this.installMarkerPath();
    if (!markerPath) {
      return;
    }
    try {
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify(
          {
            variant: normalizeInstallVariant(variant),
            year: getRootYear(this.managedRoot()) || getManagedTexliveYear(),
            installedAt: new Date().toISOString(),
          },
          null,
          2
        )}\n`,
        "utf8"
      );
    } catch {
      // A missing marker only costs us the upgrade hint; never fail the install.
    }
  }

  // A fresh managed tree in <base>/<its TeX Live year>. `older` (a renewal) is the
  // year of the tree being replaced; the new one must be of a later year.
  async ensureManagedTexliveInstalled(variant = DEFAULT_INSTALL_VARIANT, options = {}) {
    const older = options.older || "";
    if (!getManagedInstallRoot(null, this.platform)) {
      throw new Error("Managed TeX Live is not supported on this platform.");
    }
    const existingTlmgr = this.findManagedCommand("tlmgr");
    if (existingTlmgr && !older) {
      return existingTlmgr;
    }

    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-texlive-"));
    let root = "";
    try {
      const resolved = normalizeInstallVariant(variant);
      if (resolved === "light") {
        root = await this.installLightweightBundle(workDir, older);
        const installedTlmgr = this.findManagedCommand("tlmgr");
        if (!installedTlmgr) {
          throw new Error("TinyTeX installation finished, but tlmgr was not found.");
        }
        return installedTlmgr;
      }
      const installerUrl = INSTALLER_URLS[this.platform];
      if (!installerUrl) {
        throw new Error("No TeX Live installer is configured for this platform.");
      }
      const archivePath = path.join(
        workDir,
        this.platform === "win32" ? "install-tl.zip" : "install-tl-unx.tar.gz"
      );
      this.emitProgress("download");
      await downloadFile(installerUrl, archivePath);
      this.emitProgress("extract");
      await this.extractInstallerArchive(archivePath, workDir);
      const installer = await this.resolveInstallerExecutable(workDir);
      root = this.newTreeRoot(readReleaseYear(path.dirname(installer)), older);
      // install-tl fills the folder in place: mark it as being installed, so
      // neither app uses a half-made tree and the next install replaces it.
      const flag = getInstallingFlagPath(root, this.platform);
      if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
        if (!fs.existsSync(flag)) {
          throw new Error(`The TeX Live folder ${root} already holds other files.`);
        }
        await fsp.rm(root, { recursive: true, force: true });
      }
      await fsp.mkdir(path.dirname(root), { recursive: true });
      await fsp.writeFile(flag, "", "utf8");
      const profilePath = path.join(workDir, "tex64-texlive.profile");
      await fsp.writeFile(profilePath, this.buildInstallProfile(root, variant), "utf8");
      this.emitProgress("texlive");
      await this.runInstaller(installer, profilePath);
      await fsp.rm(flag, { force: true });
    } catch (error) {
      if (root && fs.existsSync(getInstallingFlagPath(root, this.platform))) {
        await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
        await fsp.rm(getInstallingFlagPath(root, this.platform), { force: true }).catch(() => {});
      }
      throw error;
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

    const installedTlmgr = this.findManagedCommand("tlmgr");
    if (!installedTlmgr) {
      throw new Error("TeX Live installer finished, but tlmgr was not found.");
    }
    return installedTlmgr;
  }

  // <base>/<year> for a tree just unpacked. A renewal needs a later year than the
  // tree it replaces; the repository may not have moved on yet.
  newTreeRoot(year, older = "") {
    if (older && (!year || Number(year) <= Number(older))) {
      const error = new Error(`No newer TeX Live than ${older} is out yet.`);
      error.code = "NO_NEWER_RELEASE";
      throw error;
    }
    return getManagedInstallRoot(year || null, this.platform);
  }

  async installLightweightBundle(workDir, older = "") {
    const bundleUrl = LIGHTWEIGHT_BUNDLE_URLS[this.platform];
    if (!bundleUrl) {
      throw new Error("No lightweight TeX bundle is configured for this platform.");
    }
    const bundlePath = path.join(
      workDir,
      this.platform === "win32" ? "TinyTeX-1-windows.exe" : "TinyTeX-1-darwin.tar.xz"
    );
    this.emitProgress("download");
    await downloadFile(bundleUrl, bundlePath, {
      onProgress: (current, total) => this.emitProgress("download", current, total),
    });
    this.emitProgress("extract");
    if (this.platform === "win32") {
      await ensureOk(bundlePath, ["-y", `-o${workDir}`], {
        timeoutMs: 10 * 60 * 1000,
        extendPath: false,
      });
    } else {
      await ensureOk("tar", ["-xJf", bundlePath, "-C", workDir], {
        timeoutMs: 10 * 60 * 1000,
        extendPath: false,
      });
    }
    const extractedTlmgr = await walkForFile(workDir, [
      "tlmgr",
      "tlmgr.bat",
      "tlmgr.exe",
    ]);
    if (!extractedTlmgr) {
      throw new Error("The TinyTeX bundle did not contain tlmgr.");
    }
    const extractedRoot = path.resolve(path.dirname(extractedTlmgr), "..", "..");
    const root = this.newTreeRoot(readReleaseYear(extractedRoot), older);
    const flag = getInstallingFlagPath(root, this.platform);
    if (fs.existsSync(flag)) {
      // a full install that was stopped part-way
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(flag, { force: true });
    }
    await fsp.mkdir(root, { recursive: true });
    await fsp.cp(extractedRoot, root, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
    await rewriteRelocatedSymlinks(root, extractedRoot);
    this.emitProgress("texlive");
    return root;
  }

  async extractInstallerArchive(archivePath, workDir) {
    if (this.platform === "win32") {
      const script =
        "Expand-Archive -LiteralPath $env:TEX64_TL_ARCHIVE -DestinationPath $env:TEX64_TL_DEST -Force";
      await ensureOk("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ], {
        timeoutMs: 10 * 60 * 1000,
        env: {
          TEX64_TL_ARCHIVE: archivePath,
          TEX64_TL_DEST: workDir,
        },
        extendPath: false,
      });
      return;
    }
    await ensureOk("tar", ["-xzf", archivePath, "-C", workDir], {
      timeoutMs: 10 * 60 * 1000,
      extendPath: false,
    });
  }

  async resolveInstallerExecutable(workDir) {
    if (this.platform === "win32") {
      const installer = await walkForFile(workDir, [
        "install-tl-windows.bat",
        "install-tl-windows.exe",
      ]);
      if (!installer) {
        throw new Error("install-tl-windows was not found in the TeX Live archive.");
      }
      return installer;
    }
    const installer = await walkForFile(workDir, ["install-tl"]);
    if (!installer) {
      throw new Error("install-tl was not found in the TeX Live archive.");
    }
    await fsp.chmod(installer, 0o755).catch(() => {});
    return installer;
  }

  buildInstallProfile(root, variant = "full") {
    const texdir = normalizeProfilePath(root);
    const texmfLocal = normalizeProfilePath(path.join(root, "texmf-local"));
    const texmfConfig = normalizeProfilePath(path.join(root, "texmf-config"));
    const texmfVar = normalizeProfilePath(path.join(root, "texmf-var"));
    const texmfHome = normalizeProfilePath(path.join(root, "texmf-home"));
    const texmfUserConfig = normalizeProfilePath(path.join(root, "texmf-user-config"));
    const texmfUserVar = normalizeProfilePath(path.join(root, "texmf-user-var"));
    return [
      `selected_scheme ${INSTALL_VARIANTS[normalizeInstallVariant(variant)].scheme}`,
      `TEXDIR ${texdir}`,
      `TEXMFLOCAL ${texmfLocal}`,
      `TEXMFSYSCONFIG ${texmfConfig}`,
      `TEXMFSYSVAR ${texmfVar}`,
      `TEXMFCONFIG ${texmfUserConfig}`,
      `TEXMFVAR ${texmfUserVar}`,
      `TEXMFHOME ${texmfHome}`,
      "instopt_adjustpath 0",
      "instopt_adjustrepo 1",
      "instopt_portable 0",
      "instopt_write18_restricted 1",
      "tlpdbopt_autobackup 0",
      "tlpdbopt_create_formats 1",
      "tlpdbopt_desktop_integration 0",
      "tlpdbopt_file_assocs 0",
      "tlpdbopt_generate_updmap 1",
      "tlpdbopt_install_docfiles 0",
      "tlpdbopt_install_srcfiles 0",
      "tlpdbopt_w32_multi_user 0",
      "",
    ].join("\n");
  }

  async runInstaller(installer, profilePath) {
    const args = [
      "-profile",
      profilePath,
      "-no-interaction",
      "-no-doc-install",
      "-no-src-install",
      "-repository",
      "ctan",
    ];
    await ensureOk(installer, args, {
      cwd: path.dirname(installer),
      timeoutMs: this.installTimeoutMs(),
      env: {
        TEXLIVE_INSTALL_ENV_NOCHECK: "1",
        TEXLIVE_INSTALL_NO_WELCOME: "1",
      },
      extendPath: false,
      onLine: (line) => {
        const match = line.match(/Installing \[(\d+)\/(\d+)/);
        // install-tl prints a short preliminary "[n/4]" infra pass before the main
        // package run; ignore tiny totals so the bar climbs once, monotonically,
        // instead of jumping forward and snapping back to the start.
        if (match && Number(match[2]) >= 20) {
          this.emitProgress("texlive", Number(match[1]), Number(match[2]));
        }
      },
    });
  }

  findManagedCommand(command) {
    return findManagedTexCommand(
      command,
      this.platform,
      this.arch,
      this.managedRoot()
    );
  }

  async runTlmgr(args, options = {}) {
    // Managed installs must only ever drive the managed tlmgr. Never fall back to
    // a system tlmgr — that would try to modify a read-only system TeX Live
    // (e.g. /usr/local/texlive) and fail with a permission error.
    const tlmgr = this.findManagedCommand("tlmgr");
    if (!tlmgr) {
      if (options.allowFailure) {
        return { ok: false, code: 127, output: "managed tlmgr not found" };
      }
      throw new Error(
        "Managed tlmgr not found; the managed TeX Live install did not complete."
      );
    }
    const result = await runCommand(tlmgr, args, {
      timeoutMs: options.timeoutMs || this.installTimeoutMs(),
      extendPath: true,
      signal: options.signal,
      env: {
        TEXLIVE_INSTALL_ENV_NOCHECK: "1",
      },
      onLine: (line) => {
        const match = line.match(/\[(\d+)\/(\d+)/);
        if (match) {
          this.emitProgress("packages", Number(match[1]), Number(match[2]));
        }
      },
    });
    if (!result.ok && !options.allowFailure) {
      const detail = result.output ? ` ${result.output.trim()}` : "";
      throw new Error(`tlmgr ${args.join(" ")} failed.${detail}`);
    }
    return result;
  }

  isManagedLightweight() {
    return Boolean(
      this.findManagedCommand("tlmgr") && this.readInstallMarker().variant === "light"
    );
  }

  async findManagedPackageForFile(fileName, options = {}) {
    if (!SAFE_TEX_FILE.test(String(fileName || ""))) {
      return null;
    }
    const result = await this.runTlmgr(
      ["search", "--global", "--file", `/${fileName}`],
      { allowFailure: true, timeoutMs: 2 * 60 * 1000, signal: options.signal }
    );
    if (result.aborted) {
      const error = new Error("TeX package recovery was aborted.");
      error.name = "AbortError";
      throw error;
    }
    if (!result.ok) {
      return null;
    }
    return parseTlmgrSearchPackages(result.output, fileName)[0] || null;
  }

  async installMissingPackagesFromLog(output, options = {}) {
    const files = extractMissingTexFiles(output);
    if (!this.isManagedLightweight() || files.length === 0) {
      return { attempted: false, success: false, files, packages: [] };
    }
    const packages = [];
    const seen = new Set();
    const excluded = new Set(
      Array.isArray(options.excludePackages)
        ? options.excludePackages.map((entry) => String(entry || "").toLowerCase())
        : []
    );
    for (const fileName of files) {
      if (options.signal?.aborted) {
        const error = new Error("TeX package recovery was aborted.");
        error.name = "AbortError";
        throw error;
      }
      const packageName = await this.findManagedPackageForFile(fileName, {
        signal: options.signal,
      });
      const key = String(packageName || "").toLowerCase();
      if (!packageName || seen.has(key) || excluded.has(key)) {
        continue;
      }
      seen.add(key);
      packages.push(packageName);
    }
    if (packages.length === 0) {
      return { attempted: true, success: false, files, packages };
    }
    if (typeof options.onPackagesResolved === "function") {
      options.onPackagesResolved([...packages], [...files]);
    }
    const result = await this.runTlmgr(["install", ...packages], {
      allowFailure: true,
      timeoutMs: this.installTimeoutMs(),
      signal: options.signal,
    });
    if (result.aborted) {
      const error = new Error("TeX package recovery was aborted.");
      error.name = "AbortError";
      throw error;
    }
    this.invalidateDetection();
    if (!result.ok && CROSS_RELEASE.test(result.output || "")) {
      // a new TeX Live year is out: the settings screen now offers to renew
      this.remoteBlocked = getRootYear(this.managedRoot(), this.platform);
      await this.checkRemoteYear({ force: true });
    }
    return {
      attempted: true,
      success: result.ok,
      files,
      packages,
      message: result.ok
        ? `Installed ${packages.join(", ")}.`
        : this.remoteBlocked
        ? `TeX Live ${this.remoteBlocked} can no longer add packages. Renew it in Settings > Environment.`
        : "The missing TeX packages could not be installed.",
    };
  }

  // Honors the same E2E seams as checkCommand so the "empty machine" flow can be
  // exercised on a developer box that already has a system TeX.
  resolveCommandPath(command) {
    if (shouldForceMissingTool(command)) {
      return null;
    }
    if (shouldIgnoreSystemTex()) {
      return this.findManagedCommand(command);
    }
    return this.findCommand(command);
  }

  // One structured answer to "is there a usable TeX on this machine, whose is
  // it, and is its package set wide enough" — so the setup screen can decide by
  // itself whether to show an install choice at all.
  async detectEnvironment(options = {}) {
    if (options.remote === true && this.findManagedCommand("tlmgr")) {
      // The settings screen asks whether a newer TeX Live year is out (a 4 KB
      // read, at most twice a day); the report below then carries `renew`.
      const before = this.remoteYearCache?.year || "";
      const year = await this.checkRemoteYear();
      if (year !== before) {
        this.invalidateDetection();
      }
    }
    const ttlMs = 10000;
    if (options.force !== true) {
      if (this.detectCache && Date.now() - this.detectCache.at < ttlMs) {
        return this.detectCache.value;
      }
      // Startup, the settings page and the first workspace update all ask at
      // once. Each probe runs tlmgr --version and a kpsewhich sweep (~0.3 s)
      // and the installation cannot change in between: share the one running.
      if (this.detectInFlight) return this.detectInFlight;
    }
    const run = this.probeEnvironment();
    this.detectInFlight = run;
    try {
      return await run;
    } finally {
      if (this.detectInFlight === run) this.detectInFlight = null;
    }
  }

  async probeEnvironment() {
    const epoch = this.detectEpoch;

    const managedRoot = this.managedRoot();
    const engines = {};
    let primaryEngine = null;
    for (const engine of TEX_ENGINES) {
      const found = this.resolveCommandPath(engine);
      engines[engine] = found || null;
      if (found && !primaryEngine) {
        primaryEngine = found;
      }
    }
    const tools = {};
    for (const tool of TEX_TOOLS) {
      tools[tool] = this.resolveCommandPath(tool) || null;
    }

    const source = classifySource(primaryEngine, managedRoot);
    const marker = source === "managed" ? this.readInstallMarker() : null;

    let banner = { kind: "unknown", year: "", version: "", root: "" };
    if (tools.tlmgr || primaryEngine) {
      // tlmgr names the tree it is bound to, which beats guessing from a symlink
      // farm like /Library/TeX/texbin; the engine banner is the fallback.
      const probe = tools.tlmgr
        ? await runCommand(tools.tlmgr, ["--version"], { timeoutMs: 20000 }).catch(() => null)
        : null;
      if (probe && probe.output) {
        banner = parseDistributionBanner(probe.output);
      }
      if (banner.kind === "unknown" && primaryEngine) {
        const engineProbe = await runCommand(primaryEngine, ["--version"], {
          timeoutMs: 20000,
        }).catch(() => null);
        if (engineProbe && engineProbe.output) {
          banner = parseDistributionBanner(engineProbe.output);
        }
      }
    }

    const root =
      banner.root ||
      (source === "managed" ? managedRoot : "") ||
      rootFromBinPath(primaryEngine || "") ||
      "";
    const year = banner.year || yearFromPath(root) || "";
    const tinytexRoot = getTinytexRoot(this.platform);
    const isTinytex = Boolean(
      root && (fs.existsSync(path.join(root, ".tinytex")) || (tinytexRoot && root === tinytexRoot))
    );

    let coverage = {
      level: "unknown",
      missingCore: [],
      missingRecommended: [],
      missingFull: [],
      probed: ALL_PROBES.length,
      found: 0,
    };
    if (tools.kpsewhich) {
      const probe = await runCommand(tools.kpsewhich, ALL_PROBES, {
        timeoutMs: 30000,
      }).catch(() => null);
      if (probe) {
        coverage = classifyCoverage(parseKpsewhichOutput(probe.output), banner.kind);
      }
    }

    if (source === "managed" && marker?.variant === "light" && coverage.level !== "broken") {
      coverage = { ...coverage, level: "on-demand" };
    }

    const hasEngine = Boolean(primaryEngine);
    const recommendation = buildRecommendation({
      source,
      hasEngine,
      hasLatexmk: Boolean(tools.latexmk),
      hasSynctex: Boolean(tools.synctex),
      coverageLevel: coverage.level,
    });

    const report = {
      hasEngine,
      source,
      ready: hasEngine && Boolean(tools.latexmk) && Boolean(tools.synctex) && coverage.level !== "broken",
      distribution: {
        kind: banner.kind,
        name: describeDistribution({
          kind: banner.kind,
          year,
          version: banner.version,
          root,
          source,
          platform: this.platform,
          isTinytex,
        }),
        year,
        root,
        isTinytex,
      },
      managedVariant: marker && marker.known ? marker.variant : null,
      // The managed tree's TeX Live year, and a newer year to renew to once the
      // repository has moved on (a light tree can no longer add packages then).
      managedYear: source === "managed" ? getRootYear(managedRoot, this.platform) : "",
      renew:
        source === "managed" &&
        Number(this.remoteYearCache?.year || 0) > Number(getRootYear(managedRoot, this.platform) || 0) &&
        getRootYear(managedRoot, this.platform)
          ? { from: getRootYear(managedRoot, this.platform), to: this.remoteYearCache.year }
          : null,
      engines,
      tools,
      coverage,
      recommendation,
      checkedAt: new Date().toISOString(),
    };
    if (epoch === this.detectEpoch) this.detectCache = { at: Date.now(), value: report };
    return report;
  }

}

module.exports = {
  EnvService,
  INSTALL_VARIANTS,
  DEFAULT_INSTALL_VARIANT,
  normalizeInstallVariant,
  extractMissingTexFiles,
  parseTlmgrSearchPackages,
  rewriteRelocatedSymlinks,
};
