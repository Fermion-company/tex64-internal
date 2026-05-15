const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  extendTexlivePath,
  findTexCommand,
} = require("../texlive-paths.cjs");

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
    return extendTexlivePath(existingPath);
  };

  SynctexService.prototype.findSynctex = function () {
    return findTexCommand("synctex");
  };
};
