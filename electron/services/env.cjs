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
} = require("./texlive-paths.cjs");

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

const DEFAULT_EXTRA_PACKAGES = [
  "latexmk",
  "latexindent",
  "collection-latexrecommended",
  "collection-fontsrecommended",
  "collection-luatex",
  "collection-xetex",
  "collection-langjapanese",
];

const parseExtraPackages = () => {
  const raw = process.env.TEX64_MANAGED_TEXLIVE_EXTRA_PACKAGES;
  if (typeof raw !== "string" || !raw.trim()) {
    return DEFAULT_EXTRA_PACKAGES;
  }
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

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

  async installEnvironment(target, onProgress) {
    this.onProgress = typeof onProgress === "function" ? onProgress : null;
    try {
      if (this.platform !== "darwin" && this.platform !== "win32") {
        return { success: false, message: "Unsupported platform." };
      }
      if (target === "basictex") {
        return await this.installManagedTexlive();
      }
      if (target === "latexmk" || target === "latexindent") {
        return await this.installManagedTexPackage(target, target);
      }
      if (target === "synctex") {
        return await this.installManagedTexlive();
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
    await this.ensureManagedTexliveInstalled();
    await this.ensureDefaultPackages();
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

  async installManagedTexlive() {
    await this.ensureManagedTexliveInstalled();
    await this.ensureDefaultPackages();
    this.emitProgress("finalize");
    const [lualatex, latexmk, synctex] = await Promise.all([
      this.checkCommand("lualatex"),
      this.checkCommand("latexmk"),
      this.checkCommand("synctex"),
    ]);
    const success = Boolean(lualatex && latexmk && synctex);
    return {
      success,
      message: success
        ? `TeX64 managed TeX Live ${getManagedTexliveYear()} is ready.`
        : "TeX Live installation finished, but required commands were not detected.",
    };
  }

  async ensureManagedTexliveInstalled() {
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
      await fsp.writeFile(profilePath, this.buildInstallProfile(root), "utf8");
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

  async ensureDefaultPackages() {
    const packages = parseExtraPackages();
    if (packages.length === 0) {
      return;
    }
    await this.runTlmgr(["install", ...packages], {
      allowFailure: false,
      timeoutMs: this.installTimeoutMs(),
    });
  }
}

module.exports = { EnvService };
