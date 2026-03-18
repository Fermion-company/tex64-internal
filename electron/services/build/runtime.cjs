const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { shouldForceMissingTool } = require("./utils.cjs");

module.exports = (BuildService) => {
  BuildService.prototype.runProcess = async function (command, args, cwd, env) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { cwd, env });
      this.activeProcess = proc;
      let output = "";
      proc.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.on("error", (err) => {
        if (this.activeProcess === proc) {
          this.activeProcess = null;
        }
        reject(err);
      });
      proc.on("close", (code) => {
        if (this.activeProcess === proc) {
          this.activeProcess = null;
        }
        resolve({
          output,
          status: code ?? 1,
          cancelled: this.cancelRequested,
        });
      });
    });
  };

  BuildService.prototype.extendPath = function (existingPath) {
    const base = existingPath ?? "";
    const extra = [];
    if (process.platform === "darwin") {
      extra.push("/Library/TeX/texbin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
    } else if (process.platform === "win32") {
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
    return parts.join(path.delimiter);
  };

  BuildService.prototype.findLatexmk = function () {
    if (shouldForceMissingTool("latexmk")) {
      return null;
    }
    const candidates = [];
    if (process.platform === "darwin") {
      candidates.push(
        "/Library/TeX/texbin/latexmk",
        "/usr/local/bin/latexmk",
        "/opt/homebrew/bin/latexmk",
        "/usr/bin/latexmk"
      );
    } else if (process.platform === "win32") {
      candidates.push(
        "C:\\texlive\\2024\\bin\\windows\\latexmk.exe",
        "C:\\texlive\\2023\\bin\\windows\\latexmk.exe",
        "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\latexmk.exe",
        "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64\\latexmk.exe"
      );
    }
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
    for (const entry of pathEntries) {
      const name = process.platform === "win32" ? "latexmk.exe" : "latexmk";
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

