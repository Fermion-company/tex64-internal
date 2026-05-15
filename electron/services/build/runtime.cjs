const { spawn } = require("child_process");

const { shouldForceMissingTool } = require("./utils.cjs");
const {
  extendTexlivePath,
  findTexCommand,
} = require("../texlive-paths.cjs");

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
    return extendTexlivePath(existingPath);
  };

  BuildService.prototype.findLatexmk = function () {
    if (shouldForceMissingTool("latexmk")) {
      return null;
    }
    return findTexCommand("latexmk");
  };
};
