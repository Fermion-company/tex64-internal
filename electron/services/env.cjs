const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");

const {
  extendTexlivePath,
  findTexCommand,
  findManagedTexCommand,
  getManagedTexliveRoot,
  getManagedTexliveYear,
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

// TeX64 deliberately has one managed install profile: the complete CTAN set.
const INSTALL_VARIANTS = {
  full: {
    id: "full",
    scheme: "scheme-full",
    approxBytes: 5 * 1024 * 1024 * 1024,
  },
};

const DEFAULT_INSTALL_VARIANT = "full";

// Legacy callers may still send an old target/variant string. They all normalize
// to the single supported profile instead of silently creating a partial tree.
const normalizeInstallVariant = () => DEFAULT_INSTALL_VARIANT;

// Written into the managed tree so later sessions can identify TeX64's profile.
const INSTALL_MARKER_FILE = "tex64-install.json";

// Every one of these means "set up the complete managed TeX Live". Old aliases
// remain accepted for compatibility with older renderer builds.
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      shell: useShell,
    });
    let output = "";
    let lineBuffer = "";
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
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        signal,
        output,
        ok: code === 0,
      });
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

const downloadFile = async (url, outPath) => {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${url} (${response.status})`);
  }
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(outPath));
};

const walkForFile = async (rootDir, fileNames) => {
  const wanted = new Set(fileNames.map((name) => name.toLowerCase()));
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && wanted.has(entry.name.toLowerCase())) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
  return null;
};

class EnvService {
  constructor() {
    this.platform = process.platform;
    this.arch = process.arch;
    this.onProgress = null;
    this.detectCache = null;
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
    if (phase === "download") {
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
        current: hasCount ? current : null,
        total: hasCount ? total : null,
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
      if (TEXLIVE_INSTALL_TARGETS.has(String(target || "").trim().toLowerCase())) {
        return await this.installManagedTexlive(variant);
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
    const resolved = normalizeInstallVariant(variant);
    const alreadyInstalled = Boolean(this.findManagedCommand("tlmgr"));
    if (alreadyInstalled && this.readInstallMarker().variant === "light") {
      // Upgrade any development build that created the retired partial profile.
      this.emitProgress("packages");
      await this.runTlmgr(["install", "scheme-full"], {
        allowFailure: false,
        timeoutMs: this.installTimeoutMs(),
      });
    } else {
      await this.ensureManagedTexliveInstalled(resolved);
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
    this.detectCache = null;
    return {
      success,
      variant: resolved,
      message: success
        ? `TeX64 managed TeX Live ${getManagedTexliveYear()} is ready.`
        : "TeX Live installation finished, but required commands were not detected.",
    };
  }

  installMarkerPath() {
    const root = this.managedRoot();
    return root ? path.join(root, INSTALL_MARKER_FILE) : "";
  }

  // `variant: null` means there is no record. "light" is only returned for a
  // retired development marker so callers can upgrade that tree in place.
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
        // Preserve the retired partial-profile marker long enough to trigger
        // the one-time scheme-full upgrade. New markers are always "full".
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
            year: getManagedTexliveYear(),
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

  async ensureManagedTexliveInstalled(variant = DEFAULT_INSTALL_VARIANT) {
    const root = this.managedRoot();
    if (!root) {
      throw new Error("Managed TeX Live is not supported on this platform.");
    }
    const existingTlmgr = this.findManagedCommand("tlmgr");
    if (existingTlmgr) {
      return existingTlmgr;
    }

    await fsp.mkdir(path.dirname(root), { recursive: true });
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-texlive-"));
    try {
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
      const profilePath = path.join(workDir, "tex64-texlive.profile");
      await fsp.writeFile(profilePath, this.buildInstallProfile(root, variant), "utf8");
      this.emitProgress("texlive");
      await this.runInstaller(installer, profilePath);
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

    const installedTlmgr = this.findManagedCommand("tlmgr");
    if (!installedTlmgr) {
      throw new Error("TeX Live installer finished, but tlmgr was not found.");
    }
    return installedTlmgr;
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

  buildInstallProfile(root) {
    const texdir = normalizeProfilePath(root);
    const texmfLocal = normalizeProfilePath(path.join(root, "texmf-local"));
    const texmfConfig = normalizeProfilePath(path.join(root, "texmf-config"));
    const texmfVar = normalizeProfilePath(path.join(root, "texmf-var"));
    const texmfHome = normalizeProfilePath(path.join(root, "texmf-home"));
    const texmfUserConfig = normalizeProfilePath(path.join(root, "texmf-user-config"));
    const texmfUserVar = normalizeProfilePath(path.join(root, "texmf-user-var"));
    return [
      // Full scheme: install every CTAN package so anything that compiles under a
      // system MacTeX also compiles through TeX64's managed TeX Live (parity).
      "selected_scheme scheme-full",
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
    const ttlMs = 10000;
    if (
      options.force !== true &&
      this.detectCache &&
      Date.now() - this.detectCache.at < ttlMs
    ) {
      return this.detectCache.value;
    }

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
      engines,
      tools,
      coverage,
      recommendation,
      checkedAt: new Date().toISOString(),
    };
    this.detectCache = { at: Date.now(), value: report };
    return report;
  }

}

module.exports = {
  EnvService,
  INSTALL_VARIANTS,
  DEFAULT_INSTALL_VARIANT,
  normalizeInstallVariant,
};
