const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

module.exports = (SynctexService) => {
  SynctexService.prototype.normalizeComparePath = function (targetPath) {
    if (!targetPath || typeof targetPath !== "string") {
      return null;
    }
    let normalized = path.normalize(path.resolve(targetPath));
    try {
      if (typeof fs.realpathSync.native === "function") {
        normalized = fs.realpathSync.native(normalized);
      } else {
        normalized = fs.realpathSync(normalized);
      }
    } catch {
      // Keep the resolved path when realpath cannot be resolved.
    }
    normalized = path.normalize(normalized);
    if (process.platform === "win32") {
      return normalized.toLowerCase();
    }
    return normalized;
  };

  SynctexService.prototype.isSamePath = function (leftPath, rightPath) {
    const left = this.normalizeComparePath(leftPath);
    const right = this.normalizeComparePath(rightPath);
    return Boolean(left && right && left === right);
  };

  SynctexService.prototype.runProcess = function (command, args, cwd, env) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
      });
      let output = "";
      proc.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.on("error", (err) => {
        reject(err);
      });
      proc.on("close", (code) => {
        resolve({ output, status: code ?? 1 });
      });
    });
  };

  SynctexService.prototype.extendPath = function (existingPath) {
    const base = existingPath ?? "";
    const extra = [];
    if (process.platform === "darwin") {
      extra.push("/Library/TeX/texbin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
    } else if (process.platform === "win32") {
      extra.push(
        "C:\\texlive\\2024\\bin\\windows",
        "C:\\texlive\\2023\\bin\\windows",
        "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64",
        "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64"
      );
    }
    const parts = [...extra, base].filter(Boolean);
    return parts.join(path.delimiter);
  };

  SynctexService.prototype.findSynctex = function () {
    const candidates = [];
    if (process.platform === "darwin") {
      candidates.push(
        "/Library/TeX/texbin/synctex",
        "/usr/local/bin/synctex",
        "/opt/homebrew/bin/synctex",
        "/usr/bin/synctex"
      );
    } else if (process.platform === "win32") {
      candidates.push(
        "C:\\texlive\\2024\\bin\\windows\\synctex.exe",
        "C:\\texlive\\2023\\bin\\windows\\synctex.exe",
        "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\synctex.exe",
        "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64\\synctex.exe"
      );
    }
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
    for (const entry of pathEntries) {
      const name = process.platform === "win32" ? "synctex.exe" : "synctex";
      candidates.push(path.join(entry, name));
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  };
};

