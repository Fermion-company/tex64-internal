const fs = require("fs");
const path = require("path");

const { isEnvMissingMessage, pickJobNameFromLatexmkArgs } = require("./utils.cjs");

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
        message: `${mainFileName} がnot found。`,
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
    let status = 1;
    try {
      const result = await this.runLatexmk(rootPath, mainFileName, engine, {
        outDir,
        extraArgs,
        hasExplicitOutDirArg,
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
          outDir,
          extraArgs,
          hasExplicitOutDirArg,
        });
        output = [
          output,
          "",
          "[tex64] xypdf Issuesを検出したため、pdflatex で再executionしました。",
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

    const issues = this.parseIssues(output, rootPath);
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
          summary: "build成功",
          issues,
          pdfPath: resolvedPdfPath,
          log: output,
        };
      }
      const message =
        "buildは成功しましたが、PDF not found.-jobname / outDir / latexmkrc を確認してください。";
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
      ? "build failed。Warningだけでは原因を特定できません。buildログを確認してください。"
      : summaryText || "build failed。buildログを確認してください。";
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
        message: `${mainFileName} がnot found。`,
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
          summary: deep ? "clean（全Delete）をCancelled." : "Clean cancelled.",
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
        summary: deep ? "clean（全Delete）Done" : "Clean done",
        issues: [],
        log: output,
      };
    }
    const summary = "clean に失敗しました。";
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

