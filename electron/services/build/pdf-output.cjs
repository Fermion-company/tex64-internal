const fs = require("fs");
const path = require("path");

const { isPathWithinRoot, stripOutDirFromLatexmkArgs } = require("./utils.cjs");

const IGNORED_SOURCE_DIRECTORIES = new Set([
  ".git",
  ".tex64",
  ".swiftpm",
  ".next",
  "node_modules",
  "DerivedData",
  "build",
]);
const MAX_STAGED_SOURCE_DIRECTORIES = 10_000;
const SYNC_OUTPUT_SUFFIXES = [".synctex.gz", ".synctex"];
// TeX reads these back on the next run: the table of contents, labels,
// bibliography and index state. A staged build starts from the last good
// set so one run usually suffices and the workspace copies stay current.
const AUXILIARY_SUFFIXES = [
  ".aux", ".toc", ".lof", ".lot", ".loa", ".lol", ".out", ".bbl", ".bcf", ".blg",
  ".run.xml", ".idx", ".ind", ".ilg", ".glo", ".gls", ".acn", ".acr", ".ist", ".xdy",
  ".nav", ".snm", ".vrb", ".thm",
];

const copyRegularFile = (fromPath, toPath) => {
  const stats = lstatOrNull(fromPath);
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) return false;
  const targetStats = lstatOrNull(toPath);
  if (targetStats && (!targetStats.isFile() || targetStats.isSymbolicLink())) return false;
  fs.copyFileSync(fromPath, toPath);
  return true;
};

const auxiliaryFileNames = (stem, directory, extraSuffixes = []) => {
  const names = [...AUXILIARY_SUFFIXES, ...extraSuffixes].map((suffix) => `${stem}${suffix}`);
  // Chapters pulled in with \include keep their own .aux beside the main one.
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".aux") && !names.includes(entry.name)) {
      names.push(entry.name);
    }
  }
  return names;
};

/** Seeds the staging directory with the previous build's auxiliary files. */
const seedStagedAuxiliaries = ({ outputDir, stagingDir, stem }) => {
  for (const name of auxiliaryFileNames(stem, outputDir)) {
    try {
      copyRegularFile(path.join(outputDir, name), path.join(stagingDir, name));
    } catch {
      // A missing or unreadable auxiliary only costs an extra TeX run.
    }
  }
};

/** After the PDF is committed, the auxiliaries and log follow it. */
const carryBackStagedAuxiliaries = ({ outputDir, stagingDir, stem }) => {
  for (const name of auxiliaryFileNames(stem, stagingDir, [".log"])) {
    try {
      copyRegularFile(path.join(stagingDir, name), path.join(outputDir, name));
    } catch {
      // The paper is already in place; stale auxiliaries are refreshed next time.
    }
  }
};

const resolveRealPath = (value) => {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
};

const removeDirectory = (dirPath) => {
  if (!dirPath) return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (error) {
    console.warn("[build] Failed to remove staged PDF output:", error?.message ?? error);
  }
};

const lstatOrNull = (filePath) => {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const assertRegularWorkspaceFile = ({ filePath, rootRealPath, label }) => {
  const stats = lstatOrNull(filePath);
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`The existing ${label} output is not a regular workspace file.`);
  }
  const realPath = resolveRealPath(filePath);
  if (!realPath || !isPathWithinRoot(rootRealPath, realPath)) {
    throw new Error(`The existing ${label} output is outside the current workspace.`);
  }
  return { stats, realPath };
};

const sameFileIdentity = (left, right) => {
  const leftInode = Number(left?.ino);
  const rightInode = Number(right?.ino);
  if (!(leftInode > 0) || !(rightInode > 0)) return false;
  return Number(left?.dev) === Number(right?.dev) && leftInode === rightInode;
};

const recordedFileIdentityMatches = (current, recorded) => {
  const currentInode = Number(current?.ino);
  const recordedInode = Number(recorded?.ino);
  // Some Windows/network filesystems do not expose a useful inode. Realpath
  // and boundary checks still apply there; only skip the replacement signal.
  if (!(currentInode > 0) || !(recordedInode > 0)) return true;
  return sameFileIdentity(current, recorded);
};

const assertTransactionDirectories = (transaction, { requireStaging = true } = {}) => {
  const currentOutputDirRealPath = resolveRealPath(transaction.outputDir);
  const currentTransactionDirRealPath = resolveRealPath(transaction.transactionDir);
  if (
    currentOutputDirRealPath !== transaction.outputDirRealPath ||
    currentTransactionDirRealPath !== transaction.transactionDirRealPath ||
    !isPathWithinRoot(transaction.outputDirRealPath, currentTransactionDirRealPath)
  ) {
    throw new Error("The PDF output directory changed during the build.");
  }
  const currentOutputDirStats = fs.statSync(transaction.outputDir);
  const currentTransactionDirStats = fs.statSync(transaction.transactionDir);
  if (
    !recordedFileIdentityMatches(currentOutputDirStats, transaction.outputDirIdentity) ||
    !recordedFileIdentityMatches(currentTransactionDirStats, transaction.transactionDirIdentity)
  ) {
    throw new Error("The PDF output directory was replaced during the build.");
  }
  if (!requireStaging) return;
  const currentStagingDirRealPath = resolveRealPath(transaction.stagingDir);
  if (
    currentStagingDirRealPath !== transaction.stagingDirRealPath ||
    !isPathWithinRoot(currentTransactionDirRealPath, currentStagingDirRealPath) ||
    !recordedFileIdentityMatches(
      fs.statSync(transaction.stagingDir),
      transaction.stagingDirIdentity,
    )
  ) {
    throw new Error("The staged PDF output directory changed during the build.");
  }
};

const moveCurrentOutputAside = (transaction, filePath, label) => {
  const stats = lstatOrNull(filePath);
  if (!stats) return;
  if (stats.isDirectory()) {
    throw new Error(`The current ${label} output is not replaceable.`);
  }
  const discardedDir = path.join(transaction.transactionDir, "discarded");
  fs.mkdirSync(discardedDir, { recursive: true });
  const discardedPath = path.join(
    discardedDir,
    `${label.replace(/[^a-z0-9.-]+/gi, "-")}-${transaction.discardSequence++}`,
  );
  fs.renameSync(filePath, discardedPath);
};

const restorePdfOutputTransaction = (transaction) => {
  if (!transaction || transaction.committed || transaction.restored) return;
  // latexmk may delete or corrupt the staging subdirectory on failure. The
  // independent backup lives beside it, so rollback must not depend on the
  // staging directory still existing.
  assertTransactionDirectories(transaction, { requireStaging: false });
  const failures = [];
  // SyncTeX is restored first and the PDF last. Restoring the PDF is the
  // visible rollback commit point, matching the ordering used for promotion.
  for (const output of transaction.trackedOutputs) {
    try {
      if (path.dirname(output.finalPath) !== transaction.outputDir) {
        throw new Error("The recorded output path escaped its document directory.");
      }
      if (output.backupPath) {
        const backupStats = lstatOrNull(output.backupPath);
        const backupRealPath = resolveRealPath(output.backupPath);
        if (
          !backupStats?.isFile() ||
          backupStats.isSymbolicLink() ||
          !backupRealPath ||
          !isPathWithinRoot(transaction.transactionDirRealPath, backupRealPath)
        ) {
          throw new Error(`The ${output.label} backup is unavailable.`);
        }
        const currentStats = lstatOrNull(output.finalPath);
        if (currentStats?.isDirectory()) {
          throw new Error(`The current ${output.label} output is not replaceable.`);
        }
        // backupPath and finalPath share outputDir's filesystem. rename is the
        // atomic rollback operation and replaces a partial file or symlink
        // without following it.
        fs.renameSync(output.backupPath, output.finalPath);
      } else {
        moveCurrentOutputAside(transaction, output.finalPath, output.label);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Could not restore the last-good PDF output: ${
        failures[0]?.message ?? "unknown rollback error"
      }`,
    );
  }
  transaction.restored = true;
};

const recreateRecordedOutputDirectories = ({ expectedPdfPath, outputDir, rootPath, stagingDir }) => {
  const flsPath = expectedPdfPath.replace(/\.pdf$/i, ".fls");
  let content = "";
  try {
    content = fs.readFileSync(flsPath, "utf8");
  } catch {
    return;
  }
  let recordedWorkingDirectory = rootPath;
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("PWD ")) {
      const value = line.slice(4).trim();
      if (value && path.isAbsolute(value)) recordedWorkingDirectory = value;
      continue;
    }
    if (!line.startsWith("OUTPUT ")) continue;
    const value = line.slice(7).trim();
    if (!value) continue;
    const absoluteOutputPath = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(recordedWorkingDirectory, value);
    const relativeOutputPath = path.relative(outputDir, absoluteOutputPath);
    if (
      !relativeOutputPath ||
      path.isAbsolute(relativeOutputPath) ||
      relativeOutputPath === ".." ||
      relativeOutputPath.startsWith(`..${path.sep}`)
    ) {
      continue;
    }
    const relativeParent = path.dirname(relativeOutputPath);
    if (relativeParent === ".") continue;
    fs.mkdirSync(path.join(stagingDir, relativeParent), { recursive: true });
  }
};

const recreateSourceDirectoryLayout = ({ sourceDir, stagingDir }) => {
  const pending = [{ absolutePath: sourceDir, relativePath: "" }];
  let createdCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        IGNORED_SOURCE_DIRECTORIES.has(entry.name) ||
        entry.name.startsWith(".tex64-build-")
      ) {
        continue;
      }
      const relativePath = current.relativePath
        ? path.join(current.relativePath, entry.name)
        : entry.name;
      fs.mkdirSync(path.join(stagingDir, relativePath), { recursive: true });
      createdCount += 1;
      if (createdCount > MAX_STAGED_SOURCE_DIRECTORIES) {
        throw new Error("The document contains too many source directories to stage safely.");
      }
      pending.push({
        absolutePath: path.join(current.absolutePath, entry.name),
        relativePath,
      });
    }
  }
};

module.exports = (BuildService) => {
  /**
   * Compile every Build into a sibling staging directory. Besides preserving
   * a last-good PDF, this keeps the successful PDF, SyncTeX and recorder files
   * together long enough to copy one immutable cache generation before the
   * transaction is discarded. The first Build uses the same path even when
   * there is no output to back up.
   */
  BuildService.prototype.beginPdfOutputTransaction = function (
    rootPath,
    expectedPdfPath,
    extraArgs = [],
    mainFileName = "main.tex"
  ) {
    const rootRealPath = resolveRealPath(rootPath);
    const outputDir = path.dirname(expectedPdfPath);
    if (!rootRealPath || !isPathWithinRoot(path.resolve(rootPath), outputDir)) {
      throw new Error("The PDF output directory is outside the current workspace.");
    }
    // A valid custom outDir may not exist before its first Build. Its nearest
    // existing ancestor was checked by profile normalization; create it, then
    // prove the resulting real directory still belongs to this workspace.
    fs.mkdirSync(outputDir, { recursive: true });
    const outputDirRealPath = resolveRealPath(outputDir);
    if (!outputDirRealPath || !isPathWithinRoot(rootRealPath, outputDirRealPath)) {
      throw new Error("The PDF output directory is outside the current workspace.");
    }
    const existingPdf = assertRegularWorkspaceFile({
      filePath: expectedPdfPath,
      rootRealPath,
      label: "PDF",
    });

    const transactionDir = fs.mkdtempSync(path.join(outputDir, ".tex64-build-"));
    const stagingDir = path.join(transactionDir, "output");
    const backupDir = path.join(transactionDir, "backup");
    fs.mkdirSync(stagingDir);
    fs.mkdirSync(backupDir);
    const outDir = path.relative(path.resolve(rootPath), stagingDir);
    if (!outDir || path.isAbsolute(outDir) || outDir.startsWith(`..${path.sep}`) || outDir === "..") {
      removeDirectory(transactionDir);
      throw new Error("Could not create a safe staged PDF output directory.");
    }
    const trackedOutputs = [];
    try {
      const expectedPdfResolved = path.resolve(expectedPdfPath);
      const candidateOutputs = [
        ...SYNC_OUTPUT_SUFFIXES.map((suffix) => ({
          finalPath: expectedPdfResolved.replace(/\.pdf$/i, suffix),
          label: suffix === ".synctex.gz" ? "SyncTeX-gzip" : "SyncTeX",
        })),
        { finalPath: expectedPdfResolved, label: "PDF" },
      ];
      for (let index = 0; index < candidateOutputs.length; index += 1) {
        const output = candidateOutputs[index];
        const existing = assertRegularWorkspaceFile({
          filePath: output.finalPath,
          rootRealPath,
          label: output.label,
        });
        let backupPath = null;
        if (existing) {
          backupPath = path.join(backupDir, `${index}.backup`);
          fs.copyFileSync(output.finalPath, backupPath, fs.constants.COPYFILE_EXCL);
          const backupStats = fs.lstatSync(backupPath);
          if (
            !backupStats.isFile() ||
            backupStats.isSymbolicLink() ||
            sameFileIdentity(existing.stats, backupStats)
          ) {
            throw new Error(`Could not create an independent ${output.label} backup.`);
          }
        }
        trackedOutputs.push({ ...output, backupPath });
      }
      const sourceDir = path.dirname(path.resolve(rootPath, mainFileName));
      const sourceDirRealPath = resolveRealPath(sourceDir);
      if (!sourceDirRealPath || !isPathWithinRoot(rootRealPath, sourceDirRealPath)) {
        throw new Error("The document source directory is outside the current workspace.");
      }
      recreateSourceDirectoryLayout({ sourceDir: sourceDirRealPath, stagingDir });
      recreateRecordedOutputDirectories({
        expectedPdfPath,
        outputDir: outputDirRealPath,
        rootPath: rootRealPath,
        stagingDir,
      });
      seedStagedAuxiliaries({
        outputDir: outputDirRealPath,
        stagingDir,
        stem: path.basename(expectedPdfPath).replace(/\.pdf$/i, ""),
      });
    } catch (error) {
      removeDirectory(transactionDir);
      throw error;
    }
    return {
      rootPath: path.resolve(rootPath),
      rootRealPath,
      outputDir: path.resolve(outputDir),
      outputDirRealPath,
      outputDirIdentity: fs.statSync(outputDir),
      transactionDir,
      transactionDirRealPath: fs.realpathSync(transactionDir),
      transactionDirIdentity: fs.statSync(transactionDir),
      stagingDir,
      stagingDirRealPath: fs.realpathSync(stagingDir),
      stagingDirIdentity: fs.statSync(stagingDir),
      outDir,
      extraArgs: stripOutDirFromLatexmkArgs(extraArgs),
      finalPdfPath: path.resolve(expectedPdfPath),
      trackedOutputs,
      discardSequence: 0,
      committed: false,
      restored: false,
    };
  };

  BuildService.prototype.promotePdfOutput = function (transaction, stagedPdfPath) {
    if (!transaction) {
      return stagedPdfPath;
    }
    const stagingDir = path.resolve(transaction.stagingDir);
    const resolvedPdfPath = path.resolve(stagedPdfPath);
    assertTransactionDirectories(transaction);
    if (!isPathWithinRoot(stagingDir, resolvedPdfPath)) {
      throw new Error("The staged PDF output escaped its build directory.");
    }
    const relativePdfPath = path.relative(stagingDir, resolvedPdfPath);
    if (
      !relativePdfPath ||
      path.isAbsolute(relativePdfPath) ||
      relativePdfPath.startsWith("..") ||
      path.dirname(relativePdfPath) !== "."
    ) {
      throw new Error("The staged PDF output path is invalid.");
    }
    const finalPdfPath = path.resolve(transaction.outputDir, relativePdfPath);
    if (
      !isPathWithinRoot(transaction.outputDir, finalPdfPath) ||
      finalPdfPath !== transaction.finalPdfPath
    ) {
      throw new Error("The final PDF output escaped its document directory.");
    }
    const stagedStats = fs.lstatSync(resolvedPdfPath);
    if (!stagedStats.isFile() || stagedStats.isSymbolicLink() || stagedStats.size === 0) {
      throw new Error("The staged PDF output is not a non-empty regular file.");
    }

    const finalStats = lstatOrNull(finalPdfPath);
    if (finalStats) {
      if (!finalStats.isFile() || finalStats.isSymbolicLink()) {
        throw new Error("The final PDF output changed during the build.");
      }
    }

    // SyncTeX is committed first and the PDF last. The final rename is the
    // visible commit point: until it succeeds, Code and AI keep reading the
    // previous PDF at the exact same path. If latexmk already removed that
    // path, discardPdfOutputTransaction restores the independent backup on
    // every non-committed exit.
    for (const suffix of SYNC_OUTPUT_SUFFIXES) {
      const stagedSyncPath = resolvedPdfPath.replace(/\.pdf$/i, suffix);
      const finalSyncPath = finalPdfPath.replace(/\.pdf$/i, suffix);
      const stagedSyncStats = lstatOrNull(stagedSyncPath);
      if (!stagedSyncStats) {
        // Do not leave an old SyncTeX map paired with the new paper.
        moveCurrentOutputAside(transaction, finalSyncPath, "stale-synctex");
        continue;
      }
      if (!stagedSyncStats.isFile() || stagedSyncStats.isSymbolicLink()) {
        throw new Error("The staged SyncTeX output is not a regular file.");
      }
      const currentSyncStats = lstatOrNull(finalSyncPath);
      if (currentSyncStats && (!currentSyncStats.isFile() || currentSyncStats.isSymbolicLink())) {
        throw new Error("The final SyncTeX output changed during the build.");
      }
      fs.renameSync(stagedSyncPath, finalSyncPath);
    }
    fs.renameSync(resolvedPdfPath, finalPdfPath);
    transaction.committed = true;
    carryBackStagedAuxiliaries({
      outputDir: path.dirname(finalPdfPath),
      stagingDir,
      stem: path.basename(finalPdfPath).replace(/\.pdf$/i, ""),
    });
    return finalPdfPath;
  };

  BuildService.prototype.discardPdfOutputTransaction = function (transaction) {
    if (!transaction) return;
    try {
      restorePdfOutputTransaction(transaction);
    } catch (error) {
      // Preserve the transaction directory and its independent backups for
      // manual recovery if the output directory itself was replaced or became
      // unwritable. Silent cleanup here would destroy the last known-good copy.
      console.error("[build] Failed to restore last-good PDF output:", error?.message ?? error);
      throw error;
    }
    removeDirectory(transaction.transactionDir ?? transaction.stagingDir);
  };
};
