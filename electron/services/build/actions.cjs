const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { terminateWindowsProcessTree } = require("../process-tree.cjs");

const {
  savePreviewCacheGeneration,
  loadPreviewCacheCandidate,
} = require("./preview-cache.cjs");
const { isEnvMissingMessage } = require("./utils.cjs");

const PREVIEW_CACHE_AUX_SUFFIXES = [
  ".aux", ".toc", ".lof", ".lot", ".loa", ".lol", ".out", ".bbl", ".bcf",
  ".run.xml", ".idx", ".ind", ".glo", ".gls", ".acn", ".acr", ".nav", ".snm",
  ".vrb", ".thm",
];
const PREVIEW_CACHE_IGNORED_DIRECTORIES = new Set([
  ".git", ".tex64", "node_modules", "DerivedData", "build",
]);
const MAX_PREVIEW_CACHE_AUX_FILES = 61;
const MAX_PREVIEW_CACHE_DIRECTORIES = 10_000;
const MAX_BUILD_RECORDER_BYTES = 8 * 1024 * 1024;
const MAX_BUILD_INPUT_BYTES = 256 * 1024 * 1024;
const CANONICAL_SEED_SUFFIXES = new Set([".aux", ".toc", ".lof", ".lot", ".out"]);

const signatureFor = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const regularFile = (filePath) => {
  try {
    const stats = fs.lstatSync(filePath);
    return stats.isFile() && !stats.isSymbolicLink() ? stats : null;
  } catch {
    return null;
  }
};

const regularFileAsync = async (filePath) => {
  try {
    const stats = await fs.promises.lstat(filePath);
    return stats.isFile() && !stats.isSymbolicLink() ? stats : null;
  } catch {
    return null;
  }
};

const sha256File = async (filePath) => {
  const stats = await regularFileAsync(filePath);
  if (!stats || stats.size > MAX_BUILD_INPUT_BYTES) return null;
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of fs.createReadStream(filePath)) {
      bytes += chunk.length;
      if (bytes > stats.size) return null;
      hash.update(chunk);
    }
  } catch {
    return null;
  }
  const after = await regularFileAsync(filePath);
  if (!after || bytes !== stats.size || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs ||
      (Number(stats.ino) > 0 && (stats.ino !== after.ino || stats.dev !== after.dev))) return null;
  return { sha256: hash.digest("hex"), bytes };
};

const isWithin = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const parseBuildRecorderInputs = async ({ rootPath, mainFileName, recorderPath }) => {
  const stats = await regularFileAsync(recorderPath);
  if (!stats || stats.size < 1 || stats.size > MAX_BUILD_RECORDER_BYTES) {
    return { ok: false, reason: "build-recorder-unavailable", inputs: [] };
  }
  let text;
  try { text = await fs.promises.readFile(recorderPath, "utf8"); }
  catch { return { ok: false, reason: "build-recorder-unreadable", inputs: [] }; }
  const rootRealPath = await fs.promises.realpath(rootPath).catch(() => null);
  if (!rootRealPath) return { ok: false, reason: "project-unavailable", inputs: [] };
  let compileDirectory = rootRealPath;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("PWD ")) continue;
    const value = line.slice(4).trim();
    if (value && path.isAbsolute(value)) compileDirectory = path.resolve(value);
    break;
  }
  const compileRealPath = await fs.promises.realpath(compileDirectory).catch(() => null);
  if (compileRealPath !== rootRealPath) {
    return { ok: false, reason: "build-recorder-cwd-mismatch", inputs: [] };
  }
  const inputPaths = new Set();
  const outputPaths = new Set();
  for (const line of text.split(/\r?\n/)) {
    const prefix = line.startsWith("INPUT ") ? "INPUT " : line.startsWith("OUTPUT ") ? "OUTPUT " : null;
    if (!prefix) continue;
    const value = line.slice(prefix.length).trim();
    if (!value || value.startsWith("|")) {
      if (prefix === "INPUT ") return { ok: false, reason: "build-recorder-dynamic-input", inputs: [] };
      continue;
    }
    const resolved = path.resolve(compileDirectory, value);
    (prefix === "INPUT " ? inputPaths : outputPaths).add(resolved);
  }
  const outputIdentities = new Set();
  for (const output of outputPaths) {
    const identity = await fs.promises.realpath(output).catch(() => null);
    if (identity) outputIdentities.add(identity);
  }
  const records = new Map();
  for (const recordedPath of inputPaths) {
    if (outputPaths.has(recordedPath)) continue;
    const identity = await fs.promises.realpath(recordedPath).catch(() => null);
    if (!identity) {
      if (isWithin(rootRealPath, recordedPath) &&
          !path.relative(rootRealPath, recordedPath).split(path.sep).some((part) =>
            part === ".tex64" || part.startsWith(".tex64-build-"))) {
        return { ok: false, reason: "build-recorder-project-input-unavailable", inputs: [] };
      }
      continue;
    }
    if (isWithin(rootRealPath, recordedPath) && !isWithin(rootRealPath, identity)) {
      return { ok: false, reason: "build-recorder-project-input-escaped", inputs: [] };
    }
    const relative = path.relative(rootRealPath, identity);
    if (!isWithin(rootRealPath, identity) || outputIdentities.has(identity) ||
        relative.split(path.sep).some((part) => part === ".tex64" || part.startsWith(".tex64-build-"))) {
      continue;
    }
    if (records.has(identity)) continue;
    const digest = await sha256File(identity);
    if (!digest) return { ok: false, reason: "build-recorder-project-input-changed", inputs: [] };
    records.set(identity, {
      role: "project",
      path: relative.split(path.sep).join("/"),
      sha256: digest.sha256,
      bytes: digest.bytes,
    });
  }
  const inputs = [...records.values()].sort((left, right) => left.path.localeCompare(right.path));
  const mainPath = path.resolve(rootRealPath, mainFileName);
  const mainIdentity = await fs.promises.realpath(mainPath).catch(() => null);
  if (!mainIdentity || !records.has(mainIdentity)) {
    return { ok: false, reason: "build-recorder-main-input-missing", inputs };
  }
  return { ok: true, reason: null, inputs };
};

const cacheableAuxiliaryName = (name) => {
  const lower = name.toLowerCase();
  return PREVIEW_CACHE_AUX_SUFFIXES.some(
    (suffix) => lower.endsWith(suffix) && lower.length > suffix.length
  );
};

const collectPreviewCacheAuxiliaries = async (directory, startedAt) => {
  const root = path.resolve(directory);
  const pending = [root];
  const artifacts = [];
  let visitedDirectories = 0;
  while (pending.length > 0 && artifacts.length < MAX_PREVIEW_CACHE_AUX_FILES) {
    const current = pending.pop();
    visitedDirectories += 1;
    if (visitedDirectories > MAX_PREVIEW_CACHE_DIRECTORIES) break;
    let entries = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (artifacts.length >= MAX_PREVIEW_CACHE_AUX_FILES) break;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          !entry.isSymbolicLink() &&
          !PREVIEW_CACHE_IGNORED_DIRECTORIES.has(entry.name) &&
          !entry.name.startsWith(".tex64-build-")
        ) {
          pending.push(absolutePath);
        }
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !cacheableAuxiliaryName(entry.name)) {
        continue;
      }
      const stats = await regularFileAsync(absolutePath);
      if (!stats || stats.mtimeMs + 1000 < startedAt) continue;
      const logicalName = path.relative(root, absolutePath).split(path.sep).join("/");
      if (!logicalName || logicalName.startsWith("../")) continue;
      artifacts.push({ path: absolutePath, logicalName });
    }
  }
  return artifacts;
};

const captureStaticPreviewCandidate = async ({
  rootPath,
  mainFileName,
  requestedEngine,
  effectiveEngine,
  outDir,
  extraArgs,
  finalPdfPath,
  auxiliaryDirectory,
  recorderPath,
  startedAt,
  durationMs,
}) => {
  const synctexPath = [".synctex.gz", ".synctex"]
    .map((suffix) => finalPdfPath.replace(/\.pdf$/i, suffix))
    .find((candidate) => {
      const stats = regularFile(candidate);
      return stats && stats.mtimeMs + 1000 >= startedAt;
    });
  const profile = {
    runner: "latexmk",
    requestedEngine,
    effectiveEngine,
    synctex: true,
    interaction: "nonstopmode",
    haltOnError: true,
    fileLineError: true,
    extraArgs: [...extraArgs],
    mainFile: mainFileName.split(path.sep).join("/"),
  };
  const recorder = await parseBuildRecorderInputs({ rootPath, mainFileName, recorderPath });
  const provenance = {
    inputProof: recorder.ok ? "build-fls" : "none",
    dynamicInputs: false,
    unknownInputs: recorder.ok ? [] : [recorder.reason],
    systemInputsStable: true,
  };
  const profileSignature = signatureFor({ version: 2, profile, outDir: outDir ?? null });
  const engineSignature = signatureFor({
    version: 2,
    requestedEngine,
    effectiveEngine,
  });
  const auxiliaryArtifacts = await collectPreviewCacheAuxiliaries(auxiliaryDirectory, startedAt);
  const boundedDurationMs = Math.max(1, Math.min(900_000, Math.round(durationMs)));
  const saved = await savePreviewCacheGeneration({
    rootPath,
    mainFileName,
    descriptor: {
      profileSignature,
      engineSignature,
      provenance: {
        ...provenance,
        snapshotId: recorder.ok ? signatureFor(recorder.inputs) : null,
        engine: { requestedEngine, effectiveEngine, profile },
      },
      inputs: recorder.inputs,
      artifacts: {
        pdf: finalPdfPath,
        ...(synctexPath ? { synctex: synctexPath } : {}),
        ...(regularFile(recorderPath) ? { fls: recorderPath } : {}),
        aux: auxiliaryArtifacts,
      },
      metrics: { durationMs: boundedDurationMs, profile, provenance },
    },
  });
  if (!saved.saved || !recorder.ok || !synctexPath?.toLowerCase().endsWith(".synctex.gz") ||
      requestedEngine !== "lualatex" || effectiveEngine !== "lualatex" || extraArgs.length !== 0) {
    return { ...saved, canonicalBuild: null, recorder };
  }
  const loaded = await loadPreviewCacheCandidate({
    rootPath,
    mainFileName,
    expected: { profileSignature, engineSignature },
  });
  if (!loaded.hit || loaded.candidateClass !== "reuse-candidate" ||
      !loaded.artifacts?.pdf || !loaded.artifacts?.synctex || !loaded.artifacts?.fls) {
    return { ...saved, canonicalBuild: null, recorder, loadReason: loaded.reason ?? loaded.blockers };
  }
  const mainStem = path.basename(mainFileName).replace(/\.tex$/i, "");
  const allowedAux = loaded.artifacts.aux.flatMap((artifact) => {
    const lower = artifact.logicalName.toLowerCase();
    const extension = [...CANONICAL_SEED_SUFFIXES].find((suffix) => lower.endsWith(suffix));
    if (!extension || lower !== `${mainStem.toLowerCase()}${extension}`) return [];
    return [{
      ext: extension.slice(1),
      logicalName: artifact.logicalName,
      path: artifact.filePath,
      sha256: artifact.sha256,
    }];
  });
  return {
    ...saved,
    recorder,
    canonicalBuild: {
      schemaVersion: 1,
      profile,
      provenance,
      artifacts: {
        pdf: { path: loaded.artifacts.pdf.filePath, sha256: loaded.artifacts.pdf.sha256 },
        synctex: {
          path: loaded.artifacts.synctex.filePath,
          sha256: loaded.artifacts.synctex.sha256,
          compression: "gzip",
        },
        fls: { path: loaded.artifacts.fls.filePath, sha256: loaded.artifacts.fls.sha256 },
        aux: allowedAux,
      },
      inputs: loaded.inputs.map((record) => ({
        path: path.resolve(rootPath, ...record.path.split("/")),
        sha256: record.sha256,
      })),
      metrics: { durationMs: boundedDurationMs },
    },
  };
};

const timedOutBuildResult = (result) => {
  const message = "Build timed out before completion. No new PDF was published. See the build log.";
  return {
    kind: "failure",
    summary: message,
    issues: [{ severity: "error", message, line: null }],
    log: result.output,
  };
};

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
    const previousAdoption = this.pendingBuildAdoption;
    let heavyWorkLease = null;
    let result = null;
    let adoptionOwnsLease = false;
    try {
      if (previousAdoption) await previousAdoption;
      if (this.cancelRequested) {
        result = {
          kind: "cancelled",
          summary: "Build cancelled.",
          issues: [],
          log: "",
        };
        return result;
      }
      if (this.acquireHeavyWorkLease) {
        try {
          heavyWorkLease = await this.acquireHeavyWorkLease({
            projectRoot: rootPath,
            mainFile: mainFileName,
            isCancelled: () => this.cancelRequested,
          });
        } catch (error) {
          if (error?.code === "TDOM_BUILD_LEASE_UNAVAILABLE") {
            const message =
              "Build could not reserve the TeX engine. No compiler was started; try again or restart Live preview.";
            result = {
              kind: "failure",
              summary: message,
              issues: [{ severity: "error", message, line: null }],
              log: "",
            };
            return result;
          }
          // Live preview is optional. A missing or older engine must not turn
          // an ordinary, otherwise valid Build into a failure.
          console.warn(
            "[build] Could not reserve TDOM heavy work:",
            error?.message ?? error
          );
        }
      }
      result = await this.runBuild(rootPath, mainFileName, engine, buildProfile);
      if (result?.kind === "success" && result.canonicalBuild && heavyWorkLease?.adopt) {
        const canonicalBuild = result.canonicalBuild;
        // The PDF is already committed. Return Build success now so the
        // handler can display it while a cold resident consumes the immutable
        // candidate. This continuation owns the lease until import/open has
        // either completed or safely fallen back.
        let adoptionPromise = null;
        try {
          adoptionPromise = Promise.resolve(heavyWorkLease.adopt(canonicalBuild));
        } catch (error) {
          console.warn("[build] Could not begin successful Build import:", error?.message ?? error);
        }
        if (adoptionPromise) {
          adoptionOwnsLease = true;
          result.canonicalBuildImport = { pending: true };
          const adoptionContinuation = adoptionPromise.then((imported) => {
            if (imported?.adopted !== true && imported?.deferred !== true) {
              console.warn(
                "[build] Successful Build was not imported by Live preview:",
                imported?.reason ?? "build-import-rejected"
              );
            }
          }).catch((error) => {
            // The Build output is already committed and cached. An engine which
            // rejects or cannot consume the optional candidate falls back to its
            // ordinary canonical path without changing Build success.
            console.warn("[build] Could not import successful Build output:", error?.message ?? error);
          }).finally(async () => {
            try {
              await heavyWorkLease.release({ outcome: "success" });
            } catch (error) {
              console.warn("[build] Could not release TDOM heavy work:", error?.message ?? error);
            }
          });
          this.pendingBuildAdoption = adoptionContinuation;
          void adoptionContinuation.finally(() => {
            if (this.pendingBuildAdoption === adoptionContinuation) {
              this.pendingBuildAdoption = null;
            }
          });
        }
      }
      delete result?.canonicalBuild;
      return result;
    } finally {
      if (!adoptionOwnsLease) {
        try {
          await heavyWorkLease?.release?.({
            outcome: result?.kind ?? (this.cancelRequested ? "cancelled" : "failure"),
          });
        } catch (error) {
          console.warn(
            "[build] Could not release TDOM heavy work:",
            error?.message ?? error
          );
        }
      }
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
    const previousAdoption = this.pendingBuildAdoption;
    if (previousAdoption) await previousAdoption;
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
      jobName,
      pdfPath,
    } = this.resolveBuildOutputProfile(rootPath, mainFileName, buildProfile);
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
      let effectiveEngine = engine;
      try {
        const result = await this.runLatexmk(rootPath, mainFileName, engine, {
          outDir: runOutDir,
          extraArgs: runExtraArgs,
          hasExplicitOutDirArg: runHasExplicitOutDirArg,
          stagedOutput: Boolean(pdfOutputTransaction),
        });
        output = result.output;
        status = result.status;
        if (result.timedOut === true) return timedOutBuildResult(result);
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
          effectiveEngine = "pdflatex";
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
          if (fallback.timedOut === true) return timedOutBuildResult({ ...fallback, output });
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
      // The panel shows the compiler's own transcript; latexmk's console output is
      // only the fallback for when the .log could not be read.
      const transcript =
        this.readBuildTranscript(rootPath, mainFileName, { outDir: runOutDir, jobName }) ?? output;
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
        const buildDurationMs = Math.max(1, Date.now() - startedAt);
        const stagedExpectedPdfPath = pdfOutputTransaction
          ? path.join(pdfOutputTransaction.stagingDir, path.basename(pdfPath))
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
          const recorderPath = resolvedPdfPath.replace(/\.pdf$/i, ".fls");
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
          try {
            const cached = await captureStaticPreviewCandidate({
              rootPath,
              mainFileName,
              requestedEngine: engine,
              effectiveEngine,
              outDir,
              extraArgs,
              finalPdfPath,
              auxiliaryDirectory:
                pdfOutputTransaction?.stagingDir ?? path.dirname(resolvedPdfPath),
              recorderPath,
              startedAt,
              durationMs: buildDurationMs,
            });
            if (!cached.saved) {
              console.warn(
                "[build] Could not cache the last-good preview:",
                cached.reason,
                cached.detail ?? ""
              );
            }
            if (cached.canonicalBuild) {
              return {
                kind: "success",
                summary: "Build succeeded",
                issues,
                pdfPath: finalPdfPath,
                log: transcript,
                canonicalBuild: cached.canonicalBuild,
              };
            }
          } catch (error) {
            // The PDF is already committed. Cache availability must not turn a
            // successful document build into a failure.
            console.warn(
              "[build] Could not cache the last-good preview:",
              error?.message ?? error
            );
          }
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
