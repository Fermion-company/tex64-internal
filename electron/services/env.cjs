const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);

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

  async installMac(target) {
    let cmd = "";
    if (target === "basictex") {
      // BasicTeX is usually enough and smaller than MacTeX
      cmd = "brew install --cask basictex"; 
    } else if (target === "latexmk") {
      // latexmk is included in BasicTeX/MacTeX usually, but can be installed separately via brew
      // strictly speaking, it depends on perl.
      // If user has MacTeX but somehow no latexmk, assume brew install
      cmd = "brew install latexmk";
    }

    if (!cmd) return { success: false, message: "Unknown target" };

    try {
       // Using graphical sudo prompt might be needed for Cask, but let's try direct first.
       // Initial implementation: try running. If it fails, we might need to tell user to run in terminal.
       await execAsync(cmd);
       return { success: true, message: "Installation command executed." };
    } catch (error) {
       console.error("Install failed:", error);
       return { success: false, message: `Install failed: ${error.message}. Please run '${cmd}' in Terminal.` };
    }
  }

  async installWin(target) {
    let cmd = "";
    if (target === "basictex") {
       // TeX Live is standard
       cmd = "winget install -e --id TeXLive.TeXLive";
    } else if (target === "latexmk") {
       // Usually included in TeX Live. 
       // Windows users might use MiKTeX too.
       // Let's stick to TeXLive for now as it's closer to Mac environment
       cmd = "winget install -e --id TeXLive.TeXLive";
    }

    if (!cmd) return { success: false, message: "Unknown target" };

    try {
      await execAsync(cmd);
      return { success: true, message: "Installation command executed." };
    } catch (error) {
      return { success: false, message: `Install failed: ${error.message}. Please run '${cmd}' in PowerShell.` };
    }
  }
}

module.exports = { EnvService };
