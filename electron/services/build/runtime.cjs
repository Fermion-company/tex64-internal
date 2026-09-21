const {
  getOwnedProcessCompletion,
  spawnOwnedProcess,
} = require("../process-tree.cjs");

const { shouldForceMissingTool } = require("./utils.cjs");
const {
  extendTexlivePath,
  findTexCommand,
} = require("../texlive-paths.cjs");

// A malformed document (for example an infinite macro expansion) must not
// keep Stop, workspace switching, or application shutdown locked forever.
// Large LuaLaTeX projects need several minutes for latexmk's multiple passes.
const BUILD_PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_FORCE_COMPLETION_MS = 5000;

module.exports = (BuildService) => {
  BuildService.prototype.runProcess = async function (command, args, cwd, env) {
    // Stop can land after the build lease is acquired but before spawn. The
    // request is latched on the service so a later subprocess must not start.
    if (this.cancelRequested) {
      return {
        output: "",
        status: 1,
        cancelled: true,
        timedOut: false,
      };
    }
    return new Promise((resolve, reject) => {
      const proc = spawnOwnedProcess(command, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
      });
      this.activeProcess = proc;
      let output = "";
      let timedOut = false;
      let cleanupFailed = false;
      let settled = false;
      let forceCompletionTimer = null;
      const processTimeoutMs = this.processTimeoutMs ?? BUILD_PROCESS_TIMEOUT_MS;
      const processForceCompletionMs =
        this.processForceCompletionMs ?? BUILD_FORCE_COMPLETION_MS;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceCompletionTimer !== null) clearTimeout(forceCompletionTimer);
        if (this.activeProcess === proc) this.activeProcess = null;
        if (this.activeProcessTerminationPromise) {
          this.activeProcessTerminationPromise = null;
        }
        if (this.activeProcessForceFinish === scheduleForcedCompletion) {
          this.activeProcessForceFinish = null;
        }
        callback(value);
      };
      const scheduleForcedCompletion = () => {
        if (settled || forceCompletionTimer !== null) return;
        forceCompletionTimer = setTimeout(() => {
          const settle = (verified = true) => {
            if (!verified && !cleanupFailed) {
              cleanupFailed = true;
              output += "\n[tex64] Windows process-tree cleanup could not be verified.\n";
            }
            finish(resolve, {
              output,
              status: 1,
              cancelled: true,
              timedOut,
              cleanupFailed,
            });
          };
          if (process.platform === "win32" && this.activeProcessTerminationPromise) {
            void Promise.resolve(this.activeProcessTerminationPromise).then(
              settle,
              () => settle(false),
            );
            return;
          }
          settle();
        }, processForceCompletionMs);
        if (typeof forceCompletionTimer?.unref === "function") {
          forceCompletionTimer.unref();
        }
      };
      this.activeProcessForceFinish = scheduleForcedCompletion;
      const timeout = setTimeout(() => {
        // `exitCode` becomes non-null on the child `exit` event, before
        // `close`. A detached descendant can keep stdout/stderr open forever,
        // so only our own settlement flag proves that the lease is released.
        if (settled) return;
        timedOut = true;
        output += `\n[tex64] Build process exceeded ${Math.round(
          processTimeoutMs / 1000
        )} seconds and was stopped.\n`;
        this.cancelCurrentRun();
        // A descendant can inherit latexmk's stdout pipe and prevent Node's
        // close event even after the parent exits. The process-group kill in
        // cancelCurrentRun normally closes it; this final bound releases the
        // build lease even if the OS never reports close.
        scheduleForcedCompletion();
      }, processTimeoutMs);
      if (typeof timeout?.unref === "function") timeout.unref();
      proc.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.on("error", (err) => {
        finish(reject, err);
      });
      proc.on("close", (code) => {
        const settle = (verified = true) => {
          if (!verified && !cleanupFailed) {
            cleanupFailed = true;
            output += "\n[tex64] Windows process-tree cleanup could not be verified.\n";
          }
          finish(resolve, {
            output,
            status: code ?? 1,
            cancelled: this.cancelRequested || timedOut,
            timedOut,
            cleanupFailed,
          });
        };
        if (process.platform === "win32" && this.activeProcessTerminationPromise) {
          void Promise.resolve(this.activeProcessTerminationPromise).then(
            settle,
            () => settle(false),
          );
          return;
        }
        if (process.platform === "win32") {
          settle(getOwnedProcessCompletion(proc)?.cleanupOk === true);
          return;
        }
        settle();
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
