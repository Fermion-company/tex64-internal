const fs = require("fs");
const path = require("path");
const { terminateWindowsProcessTree } = require("../process-tree.cjs");

const { isEnvMissingMessage, pickJobNameFromLatexmkArgs } = require("./utils.cjs");

module.exports = (BuildService) => {
  BuildService.prototype.buildQueued = function (
    rootPath,
    mainFileName = "main.tex",
    engine = "lualatex",
    buildProfile = null,
    queueOptions = null,
  ) {
    const previous = Promise.resolve(this.queuedBuildTail).catch(() => {});
    const queued = previous.then(async () => {
      // Manual Build/Clean calls use the immediate API. Wait here, then enter
      // build() synchronously in the same tick so there is no isBuilding TOCTOU
      // window between the lease check and acquisition.
      let waitedForAnotherBuild = false;
      while (this.isBuilding) {
        waitedForAnotherBuild = true;
        if (queueOptions?.signal?.aborted) {
          return { kind: "cancelled", summary: "Build cancelled before it started." };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (queueOptions?.signal?.aborted && queueOptions?.allowInitiallyAborted !== true) {
        return { kind: "cancelled", summary: "Build cancelled before it started." };
      }
      if (waitedForAnotherBuild && queueOptions?.signal?.aborted) {
        return { kind: "cancelled", summary: "Build cancelled before it started." };
      }
      queueOptions?.onStart?.();
      try {
        return await this.build(rootPath, mainFileName, engine, buildProfile);
      } finally {
        queueOptions?.onFinish?.();
      }
    });
    this.queuedBuildTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };

  BuildService.prototype.build = async function (
    rootPath,
    mainFileName = "main.tex",
    engine = "lualatex",
    buildProfile = null
  ) {
    if (this.isBuilding) {
      return { kind: "busy" };
    }
    this.isBuilding = true;
    this.cancelRequested = false;
    try {
      return await this.runBuild(rootPath, mainFileName, engine, buildProfile);
    } finally {
      this.isBuilding = false;
      this.cancelRequested = false;
    }
  };

  BuildService.prototype.clean = async function (
    rootPath,
    mainFileName = "main.tex",
    options = {},
    buildProfile = null
  ) {
    if (this.isBuilding) {
      return { kind: "busy" };
    }
    this.isBuilding = true;
    this.cancelRequested = false;
    try {
      return await this.runClean(rootPath, mainFileName, options, buildProfile);
    } finally {
      this.isBuilding = false;
      this.cancelRequested = false;
    }
  };

  BuildService.prototype.cancelCurrentRun = function () {
    if (!this.isBuilding) {
      return false;
    }
    // Latch cancellation even during profile/PDF transaction setup or between
    // fallback subprocesses. runProcess observes this before every spawn.
    this.cancelRequested = true;
    if (!this.activeProcess) {
      return true;
    }
    const proc = this.activeProcess;
    let sent = false;
    try {
      if (process.platform === "win32" && Number.isInteger(proc.pid)) {
        this.activeProcessTerminationPromise = terminateWindowsProcessTree(proc);
        sent = true;
      } else if (Number.isInteger(proc.pid)) {
        process.kill(-proc.pid, "SIGTERM");
        sent = true;
      } else {
        sent = proc.kill("SIGTERM");
      }
    } catch {
      sent = false;
    }
    if (!sent) {
      try {
        if (process.platform !== "win32" && Number.isInteger(proc.pid)) {
          process.kill(-proc.pid, "SIGTERM");
          sent = true;
        } else {
          sent = proc.kill();
        }
      } catch {
        sent = false;
      }
    }
    // The parent process/group can already be gone while a detached descendant
    // still holds its pipes. Release the build lease even when the OS kill call
    // reports failure.
    this.activeProcessForceFinish?.();
    if (sent) {
      const killEscalationMs = this.processKillEscalationMs ?? 2000;
      const timer = setTimeout(() => {
        try {
          if (process.platform !== "win32") {
            if (Number.isInteger(proc.pid)) {
              // The direct child may already have exited while a same-group
              // descendant ignores SIGTERM and keeps pipes/files open. The
              // process group, not the parent's exitCode, is authoritative.
              process.kill(-proc.pid, "SIGKILL");
            } else if (proc.exitCode === null) {
              proc.kill("SIGKILL");
            }
          }
        } catch {
          // ignore
        }
      }, killEscalationMs);
      if (typeof timer?.unref === "function") {
        timer.unref();
      }
    }
    return sent;
  };

  BuildService.prototype.runBuild = async function (rootPath, mainFileName, engine, buildProfile) {
    const mainFilePath = path.join(rootPath, mainFileName);
    if (!fs.existsSync(mainFilePath)) {
      const issue = {
        severity: "error",
        message: `${mainFileName} was not found.`,
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    const {
      outDir,
      extraArgs,
      hasExplicitOutDirArg,
      outDirRequested,
      invalidDirectoryArgument,
    } = this.resolveLatexmkProfile(rootPath, mainFileName, buildProfile);
    if (invalidDirectoryArgument) {
      const issue = {
        severity: "error",
        message: `${invalidDirectoryArgument} is invalid.`,
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    if (outDirRequested && !outDir) {
      const issue = {
        severity: "error",
        message: "outDir is invalid.",
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    const jobName =
      pickJobNameFromLatexmkArgs(extraArgs) ?? path.basename(mainFileName, path.extname(mainFileName));
    const pdfBase = `${jobName}.pdf`;
    const fallbackDir = path.dirname(mainFileName ?? "");
    const pdfDir = outDir
      ? path.join(rootPath, outDir)
      : fallbackDir && fallbackDir !== "."
      ? path.join(rootPath, fallbackDir)
      : rootPath;
    const pdfPath = path.join(pdfDir, pdfBase);

    let pdfOutputTransaction = null;
    try {
      pdfOutputTransaction = this.beginPdfOutputTransaction(
        rootPath,
        pdfPath,
        extraArgs,
        mainFileName
      );
    } catch (error) {
      const message = error?.message ?? "Could not protect the existing PDF output.";
      const issue = { severity: "error", message, line: null };
      return { kind: "failure", summary: message, issues: [issue] };
    }
    try {
      const runOutDir = pdfOutputTransaction?.outDir ?? outDir;
      const runExtraArgs = pdfOutputTransaction?.extraArgs ?? extraArgs;
      const runHasExplicitOutDirArg = pdfOutputTransaction ? false : hasExplicitOutDirArg;

      const startedAt = Date.now();
      let output = "";
      let status = 1;
      try {
        const result = await this.runLatexmk(rootPath, mainFileName, engine, {
          outDir: runOutDir,
          extraArgs: runExtraArgs,
          hasExplicitOutDirArg: runHasExplicitOutDirArg,
          stagedOutput: Boolean(pdfOutputTransaction),
        });
        output = result.output;
        status = result.status;
        if (result.cancelled === true || this.cancelRequested) {
          return {
            kind: "cancelled",
            summary: "Build cancelled.",
            issues: [],
            log: output,
          };
        }
      } catch (error) {
        const message = error?.message ?? String(error);
        if (isEnvMissingMessage(message)) {
          const issue = {
            severity: "error",
            message: "latexmk not found. Check the TeX environment.",
            line: null,
            action: "open-runtime",
          };
          return { kind: "failure", summary: issue.message, issues: [issue] };
        }
        const issue = {
          severity: "error",
          message: "Failed to start build",
          line: null,
        };
        return { kind: "failure", summary: issue.message, issues: [issue] };
      }

      if (status !== 0 && engine === "lualatex" && this.isXypdfPdftexRequirementError(output)) {
        try {
          const fallback = await this.runLatexmk(rootPath, mainFileName, "pdflatex", {
            outDir: runOutDir,
            extraArgs: runExtraArgs,
            hasExplicitOutDirArg: runHasExplicitOutDirArg,
            stagedOutput: Boolean(pdfOutputTransaction),
          });
          output = [
            output,
            "",
            "[tex64] Detected an xypdf issue and rebuilt with pdflatex.",
            fallback.output,
          ]
            .filter(Boolean)
            .join("\n");
          status = fallback.status;
          if (fallback.cancelled === true || this.cancelRequested) {
            return {
              kind: "cancelled",
              summary: "Build cancelled.",
              issues: [],
              log: output,
            };
          }
        } catch (error) {
          const message = error?.message ?? String(error);
          if (isEnvMissingMessage(message)) {
            const issue = {
              severity: "error",
              message: "latexmk not found. Check the TeX environment.",
              line: null,
              action: "open-runtime",
            };
            return { kind: "failure", summary: issue.message, issues: [issue] };
          }
        }
      }

      let issues = this.parseIssues(output, rootPath);
      // The panel shows the compiler's own transcript; latexmk's console output is
      // only the fallback for when the .log could not be read.
      const transcript =
        this.readBuildTranscript(rootPath, mainFileName, { outDir: runOutDir, jobName, startedAt }) ?? output;
      // latexmk may summarize a failed run without repeating the TeX error.
      // Recover its location from this run's transcript, never an old log.
      if (status !== 0 && !issues.some((issue) => issue.severity === "error")) {
        const transcriptErrors = this.parseIssues(transcript, rootPath).filter(
          (issue) => issue.severity === "error",
        );
        issues = [...transcriptErrors, ...issues].slice(0, 20);
      }
      const missingGlyphIssues = this.findMissingGlyphIssues(issues);
      if (missingGlyphIssues.length > 0) {
        const summary =
          "The PDF contains characters it cannot display. Configure a Unicode-aware document class/package or font.";
        return {
          kind: "failure",
          summary,
          issues: missingGlyphIssues,
          log: transcript,
        };
      }
      if (status === 0) {
        const stagedExpectedPdfPath = pdfOutputTransaction
          ? path.join(pdfOutputTransaction.stagingDir, pdfBase)
          : pdfPath;
        const resolvedPdfPath = pdfOutputTransaction
          ? this.resolvePdfPathAfterBuild(
              pdfOutputTransaction.stagingDir,
              path.basename(mainFileName),
              {
                outDir: null,
                startedAt,
                expectedPdfPath: stagedExpectedPdfPath,
                jobName,
              }
            )
          : this.resolvePdfPathAfterBuild(rootPath, mainFileName, {
              outDir,
              startedAt,
              expectedPdfPath: pdfPath,
              jobName,
            });
        if (resolvedPdfPath) {
          let finalPdfPath = resolvedPdfPath;
          try {
            finalPdfPath = this.promotePdfOutput(pdfOutputTransaction, resolvedPdfPath);
          } catch (error) {
            const message = `The build succeeded but the previous PDF was kept: ${
              error?.message ?? "the new PDF could not be committed."
            }`;
            return {
              kind: "failure",
              summary: message,
              issues: [{ severity: "error", message, line: null }],
              log: transcript,
            };
          }
          // Report only a successfully promoted PDF; never paths, source or logs.
          try { Promise.resolve(this.onPdfBuilt?.()).catch(() => {}); } catch {}
          return {
            kind: "success",
            summary: "Build succeeded",
            issues,
            pdfPath: finalPdfPath,
            log: transcript,
          };
        }
        const message =
          "The build succeeded but the PDF was not found. Check -jobname / outDir / latexmkrc.";
        return {
          kind: "failure",
          summary: message,
          issues: [{ severity: "error", message, line: null }],
          log: transcript,
        };
      }
      const summary = this.failureSummary(output, issues, mainFileName);
      if (isEnvMissingMessage(summary)) {
        const fallback = {
          severity: "error",
          message: summary,
          line: null,
          action: "open-runtime",
        };
        return {
          kind: "failure",
          summary,
          issues: [fallback],
          log: transcript,
        };
      }
      const summaryText = typeof summary === "string" ? summary.trim() : "";
      const summaryLooksWarning = /\bwarning\b/i.test(summaryText);
      const fallbackMessage = summaryLooksWarning
        ? "Build failed. Warnings alone do not pinpoint the cause; check the build log."
        : summaryText || "Build failed. Check the build log.";
      const fallback = {
        severity: "error",
        message: fallbackMessage,
        line: null,
      };
      const hasError = issues.some((issue) => issue.severity === "error");
      const summaryForUi = summaryLooksWarning ? fallbackMessage : summary;
      return {
        kind: "failure",
        summary: summaryForUi,
        issues: hasError ? issues : [fallback, ...issues].slice(0, 20),
        log: transcript,
      };
    } finally {
      this.discardPdfOutputTransaction(pdfOutputTransaction);
    }
  };

  BuildService.prototype.runClean = async function (rootPath, mainFileName, options, buildProfile) {
    const mainFilePath = path.join(rootPath, mainFileName);
    if (!fs.existsSync(mainFilePath)) {
      const issue = {
        severity: "error",
        message: `${mainFileName} was not found.`,
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    const deep = options?.deep === true;
    const {
      outDir,
      extraArgs,
      hasExplicitOutDirArg,
      outDirRequested,
      invalidDirectoryArgument,
    } = this.resolveLatexmkProfile(rootPath, mainFileName, buildProfile);
    if (invalidDirectoryArgument) {
      const issue = {
        severity: "error",
        message: `${invalidDirectoryArgument} is invalid.`,
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    if (outDirRequested && !outDir) {
      const issue = {
        severity: "error",
        message: "outDir is invalid.",
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    let output = "";
    let status = 1;
    try {
      const result = await this.runLatexmkClean(rootPath, mainFileName, {
        deep,
        outDir,
        extraArgs,
        hasExplicitOutDirArg,
      });
      output = result.output;
      status = result.status;
      if (result.cancelled === true || this.cancelRequested) {
        return {
          kind: "cancelled",
          summary: deep ? "Deep clean cancelled." : "Clean cancelled.",
          issues: [],
          log: output,
        };
      }
    } catch (error) {
      const message = error?.message ?? String(error);
      if (isEnvMissingMessage(message)) {
        const issue = {
          severity: "error",
          message: "latexmk not found. Check the TeX environment.",
          line: null,
          action: "open-runtime",
        };
        return { kind: "failure", summary: issue.message, issues: [issue] };
      }
      const issue = {
        severity: "error",
        message: "Failed to start clean.",
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    if (status === 0) {
      return {
        kind: "success",
        summary: deep ? "Deep clean done" : "Clean done",
        issues: [],
        log: output,
      };
    }
    const summary = "Clean failed.";
    return {
      kind: "failure",
      summary,
      issues: [
        {
          severity: "error",
          message: summary,
          line: null,
        },
      ],
      log: output,
    };
  };
};
