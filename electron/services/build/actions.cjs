const fs = require("fs");
const path = require("path");

const { isEnvMissingMessage, pickJobNameFromLatexmkArgs } = require("./utils.cjs");

// Package dependency chains are short but real; five rounds covers every case we
// have seen while keeping a pathological document from rebuilding forever.
const MAX_PACKAGE_REPAIR_ROUNDS = 5;

module.exports = (BuildService) => {
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
    if (!this.isBuilding || !this.activeProcess) {
      return false;
    }
    const proc = this.activeProcess;
    this.cancelRequested = true;
    let sent = false;
    try {
      sent = proc.kill("SIGTERM");
    } catch {
      sent = false;
    }
    if (!sent) {
      try {
        sent = proc.kill();
      } catch {
        sent = false;
      }
    }
    if (sent) {
      const timer = setTimeout(() => {
        try {
          if (proc.exitCode === null) {
            proc.kill("SIGKILL");
          }
        } catch {
          // ignore
        }
      }, 2000);
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
    const { outDir, extraArgs, hasExplicitOutDirArg, outDirRequested } = this.resolveLatexmkProfile(
      rootPath,
      mainFileName,
      buildProfile
    );
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

    const startedAt = Date.now();
    let output = "";
    // The most recent latexmk run on its own, used to decide what is still
    // missing after a package repair round.
    let lastOutput = "";
    let status = 1;
    try {
      const result = await this.runLatexmk(rootPath, mainFileName, engine, {
        outDir,
        extraArgs,
        hasExplicitOutDirArg,
      });
      output = result.output;
      lastOutput = result.output;
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
          outDir,
          extraArgs,
          hasExplicitOutDirArg,
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
        lastOutput = fallback.output;
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

    // A light TeX install is only safe if a missing package fixes itself. When the
    // build failed on a file we can install, fetch it and rebuild — the same
    // detect/repair/retry shape as the xypdf fallback above. Several rounds are
    // needed in practice because packages pull in packages (mdframed -> zref ->
    // needspace), and each round only sees the file LaTeX stopped on.
    if (typeof this.packageInstaller === "function") {
      const attempted = new Set();
      for (let round = 0; round < MAX_PACKAGE_REPAIR_ROUNDS; round += 1) {
        if (status === 0 || this.cancelRequested) {
          break;
        }
        let repair = null;
        try {
          // Only the newest run's log: earlier rounds' errors are already fixed,
          // and re-resolving them would cost a tlmgr search each time.
          repair = await this.packageInstaller(lastOutput);
        } catch {
          break;
        }
        const installed = (Array.isArray(repair?.installed) ? repair.installed : []).filter(
          (name) => !attempted.has(name)
        );
        // No new package means the next rebuild would fail identically.
        if (installed.length === 0) {
          break;
        }
        for (const name of installed) {
          attempted.add(name);
        }
        let retry = null;
        try {
          retry = await this.runLatexmk(rootPath, mainFileName, engine, {
            outDir,
            extraArgs,
            hasExplicitOutDirArg,
          });
        } catch {
          // Keep the original failure; the retry is a bonus, never a new failure
          // mode.
          break;
        }
        lastOutput = retry.output;
        output = [
          output,
          "",
          `[tex64] Installed missing package(s): ${installed.join(", ")}. Rebuilding.`,
          retry.output,
        ]
          .filter(Boolean)
          .join("\n");
        status = retry.status;
        if (retry.cancelled === true || this.cancelRequested) {
          return {
            kind: "cancelled",
            summary: "Build cancelled.",
            issues: [],
            log: output,
          };
        }
      }
    }

    const issues = this.parseIssues(output, rootPath);
    const missingGlyphIssues = this.findMissingGlyphIssues(issues);
    if (missingGlyphIssues.length > 0) {
      const summary =
        "The PDF contains characters it cannot display. Configure a Unicode-aware document class/package or font.";
      return {
        kind: "failure",
        summary,
        issues: missingGlyphIssues,
        log: output,
      };
    }
    if (status === 0) {
      const resolvedPdfPath = this.resolvePdfPathAfterBuild(rootPath, mainFileName, {
        outDir,
        startedAt,
        expectedPdfPath: pdfPath,
        jobName,
      });
      if (resolvedPdfPath) {
        return {
          kind: "success",
          summary: "Build succeeded",
          issues,
          pdfPath: resolvedPdfPath,
          log: output,
        };
      }
      const message =
        "The build succeeded but the PDF was not found. Check -jobname / outDir / latexmkrc.";
      return {
        kind: "failure",
        summary: message,
        issues: [{ severity: "error", message, line: null }],
        log: output,
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
        log: output,
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
      log: output,
    };
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
    const { outDir, extraArgs, hasExplicitOutDirArg, outDirRequested } = this.resolveLatexmkProfile(
      rootPath,
      mainFileName,
      buildProfile
    );
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
