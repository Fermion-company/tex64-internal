const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);

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

class EnvService {
  constructor() {
    this.platform = process.platform; // 'darwin' or 'win32' or 'linux'
  }

  getPlatform() {
    return this.platform;
  }

  extendPath(existingPath) {
    const base = existingPath ?? "";
    const extra = [];
    if (this.platform === "darwin") {
      extra.push("/Library/TeX/texbin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
    } else if (this.platform === "win32") {
      extra.push(
        "C:\\texlive\\2026\\bin\\windows",
        "C:\\texlive\\2025\\bin\\windows",
        "C:\\texlive\\2024\\bin\\windows",
        "C:\\texlive\\2023\\bin\\windows",
        "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64",
        "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64"
      );
    }
    const parts = [...extra, base].filter(Boolean);
    return parts.join(require("path").delimiter);
  }

  async checkCommand(command) {
    if (shouldForceMissingTool(command)) {
      return false;
    }
    try {
      const checkCmd = this.platform === "win32" ? `where ${command}` : `which ${command}`;
      const env = { ...process.env };
      env.PATH = this.extendPath(env.PATH);
      await execAsync(checkCmd, { env });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Tries to install the target environment.
   * target: 'basictex' | 'latexmk'
   * Returns: { success: boolean, message: string }
   */
  async installEnvironment(target) {
    // Note: Interactive installation (password prompt) is tricky in background.
    // For Mac (brew), we assume the user has brew.
    // For Windows (winget), we try to launch a terminal or use non-interactive if possible,
    // but winget often requires elevation.
    
    // Simplification for MVP: We run the command and hope for the best, 
    // or return a command string for the user to run if we can't do it automatically.
    
    // However, the requirement is "one click". 
    // On Mac, `brew install --cask basictex` might ask for password.
    // On Windows, `winget install ...` might ask for UAC.
    
    try {
      if (this.platform === "darwin") {
        return await this.installMac(target);
      } else if (this.platform === "win32") {
        return await this.installWin(target);
      } else {
        return { success: false, message: "Unsupported platform." };
      }
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  async hasBrew() {
    try {
      await execAsync("which brew");
      return true;
    } catch {
      return false;
    }
  }

  async installMac(target) {
    let cmd = "";
    let fallbackHint = "";
    if (target === "basictex") {
      cmd = "brew install --cask basictex";
      fallbackHint = "Download and install MacTeX from https://tug.org/mactex/.";
    } else if (target === "latexmk") {
      cmd = "brew install latexmk";
      fallbackHint = "Run brew install latexmk in terminal.";
    } else if (target === "latexindent") {
      // Try tlmgr first (TeX Live package manager), then brew
      try {
        await execAsync("tlmgr install latexindent");
        return { success: true, message: "Performed latexindent installation. Please recheck." };
      } catch {
        cmd = "brew install latexindent";
        fallbackHint = "Run tlmgr install latexindent or brew install latexindent in terminal.";
      }
    }

    if (!cmd) return { success: false, message: "Unknown install target." };

    // Check if Homebrew is available
    const brewAvailable = await this.hasBrew();
    if (!brewAvailable) {
      const message = target === "basictex"
        ? `Homebrew not found. ${fallbackHint}`
        : `Homebrew not found. ${fallbackHint}`;
      return { success: false, message };
    }

    try {
       await execAsync(cmd, { timeout: 600000 }); // 10 min timeout for large downloads
       return { success: true, message: "Installation performed. Please recheck." };
    } catch (error) {
       console.error("Install failed:", error);
       return { success: false, message: `Installation failed. Run ${cmd} in terminal.` };
    }
  }

  async installWin(target) {
    let cmd = "";
    if (target === "basictex" || target === "latexmk" || target === "latexindent") {
       cmd = "winget install -e --id TeXLive.TeXLive";
    }

    if (!cmd) return { success: false, message: "Unknown install target." };

    try {
      await execAsync(cmd, { timeout: 600000 });
      return { success: true, message: "Installation performed. Please recheck." };
    } catch (error) {
      return { success: false, message: `Installation failed. Run ${cmd} in PowerShell.` };
    }
  }
}

module.exports = { EnvService };
