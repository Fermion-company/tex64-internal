const path = require("path");

const {
  normalizeOutDir,
  pickAuxDirFromLatexmkArgs,
  pickJobNameFromLatexmkArgs,
  pickOutDirFromLatexmkArgs,
  splitArgsString,
} = require("./utils.cjs");

module.exports = (BuildService) => {
  BuildService.prototype.resolveLatexmkProfile = function (rootPath, mainFileName, buildProfile) {
    const rawExtra = typeof buildProfile?.extraArgs === "string" ? buildProfile.extraArgs : "";
    const extraArgs = splitArgsString(rawExtra);
    const outDirFromArgs = pickOutDirFromLatexmkArgs(extraArgs);
    const auxDirFromArgs = pickAuxDirFromLatexmkArgs(extraArgs);
    const rawOutDir = typeof buildProfile?.outDir === "string" ? buildProfile.outDir.trim() : "";
    const derivedOutDir = path.dirname(mainFileName ?? "");
    const outDirCandidate =
      outDirFromArgs || rawOutDir || (derivedOutDir && derivedOutDir !== "." ? derivedOutDir : "");
    const outDir = normalizeOutDir(rootPath, outDirCandidate);
    const outDirRequested = Boolean(outDirFromArgs || rawOutDir);
    const auxDirRequested = auxDirFromArgs !== null;
    const auxDirValid =
      !auxDirRequested ||
      auxDirFromArgs === "." ||
      Boolean(normalizeOutDir(rootPath, auxDirFromArgs));
    return {
      outDir,
      extraArgs,
      hasExplicitOutDirArg: Boolean(outDirFromArgs),
      outDirRequested,
      invalidDirectoryArgument: auxDirValid ? null : "auxDir",
    };
  };

  BuildService.prototype.resolveBuildOutputProfile = function (rootPath, mainFileName, buildProfile) {
    const profile = this.resolveLatexmkProfile(rootPath, mainFileName, buildProfile);
    const jobName =
      pickJobNameFromLatexmkArgs(profile.extraArgs) ??
      path.basename(mainFileName, path.extname(mainFileName));
    const fallbackDir = path.dirname(mainFileName ?? "");
    const pdfDir = profile.outDir
      ? path.join(rootPath, profile.outDir)
      : fallbackDir && fallbackDir !== "."
        ? path.join(rootPath, fallbackDir)
        : rootPath;
    return {
      ...profile,
      jobName,
      pdfPath: path.join(pdfDir, `${jobName}.pdf`),
    };
  };
};
