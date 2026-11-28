const crypto = require("crypto");
const { isUtf8 } = require("node:buffer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { withProjectFileWrites, writeProjectFile, recoverProjectFile, isStagingName } = require("./project-file-writes.cjs");

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".tex64",
  ".swiftpm",
  "node_modules",
  "DerivedData",
  "build",
  "tex64.xcodeproj",
]);
const HIDDEN_EDITOR_EXTENSIONS = new Set([
  "aux",
  "toc",
  "synctex",
  "fls",
  "fdb_latexmk",
]);
const IGNORED_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

const WorkspaceError = {
  invalidPath: "Invalid path.",
  invalidName: "Invalid name.",
  invalidEncoding: "Non-UTF-8 encoding.",
  alreadyExists: "Already exists.",
  notFound: "not found。",
  notEmpty: "Folder is not empty.",
  invalidMove: "Invalid destination.",
  cancelled: "Cancelled.",
  unknown: "Failed to create project.",
};

const normalizeRelativePath = (relativePath) => {
  if (!relativePath) {
    return "";
  }
  return relativePath.split(path.sep).join("/");
};

const realpathSync = (targetPath) =>
  typeof fs.realpathSync.native === "function"
    ? fs.realpathSync.native(targetPath)
    : fs.realpathSync(targetPath);

const canonicalWorkspacePath = (rootPath) => {
  let resolved = path.resolve(rootPath);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // A just-created directory may not have a real path yet.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const isWithinPath = (rootPath, targetPath) => {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

/**
 * Resolve the nearest existing ancestor. This covers both existing reads and
 * not-yet-created write targets: a symlink in any parent component is resolved
 * before the caller is allowed to touch the path.
 */
const nearestExistingRealPath = (targetPath) => {
  let current = targetPath;
  while (true) {
    try {
      fs.lstatSync(current);
      return realpathSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
};

const generateId = () => {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
};

const isHiddenName = (name) => name.startsWith(".");
const isHiddenEditorFile = (name) => {
  const lower = name.toLowerCase();
  if (lower.endsWith(".synctex.gz")) {
    return true;
  }
  const ext = path.extname(lower);
  if (!ext) {
    return false;
  }
  return HIDDEN_EDITOR_EXTENSIONS.has(ext.slice(1));
};
const isIgnoredFile = (name) => IGNORED_FILES.has(name);

const ensureDirectory = async (dirPath) => {
  await fsp.mkdir(dirPath, { recursive: true });
};

const readUtf8File = async (filePath, { requireUtf8 = false } = {}) => {
  const data = await fsp.readFile(filePath);
  if (requireUtf8 && !isUtf8(data)) {
    throw new Error(WorkspaceError.invalidEncoding);
  }
  return data.toString("utf8");
};

const extractTexMagicRoot = (content) => {
  if (!content) {
    return null;
  }
  const lines = content.split(/\r?\n/).slice(0, 40);
  for (const line of lines) {
    const match = line.match(/^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/i);
    if (!match) {
      continue;
    }
    const raw = (match[1] ?? "").trim();
    if (!raw) {
      continue;
    }
    const unquoted = raw.replace(/^['"]|['"]$/g, "").trim();
    if (!unquoted) {
      continue;
    }
    return unquoted;
  }
  return null;
};

class WorkspaceManager {
  async resolveBuildTarget(relativePath) {
    return require("./tex-build-target.cjs").resolveBuildTarget(this, relativePath);
  }

  async resolveIncludingDocuments(relativePath) {
    return require("./tex-build-target.cjs").resolveIncludingDocuments(this, relativePath);
  }

  getRecentBuildTargets() {
    return this.buildTargetsByWorkspace.get(this.rootPath) ?? [];
  }

  noteBuildTarget(relativePath) {
    const previous = this.getRecentBuildTargets();
    this.buildTargetsByWorkspace.set(this.rootPath, [relativePath, ...previous.filter((file) => file !== relativePath)]);
  }

  async listBuildTexFiles({ includeStyles = false } = {}) {
    const files = [];
    const extensions = includeStyles ? /\.(?:tex|sty|cls|clo)$/i : /\.tex$/i;
    const add = (file) => { if (extensions.test(file)) files.push(file); };
    await this.walkEntries({
      onFile: add,
      onSymlink: add,
    });
    return files;
  }

  constructor({ fileLockDirectory } = {}) {
    this.buildTargetsByWorkspace = new Map();
    this.rootPath = null;
    this.rootGeneration = 0;
    this.rootFileInfo = null;
    this.rootInfoRootPath = null;
    this.undoStack = [];
    this.fileLockDirectory = fileLockDirectory;
    this.pendingUndo = Promise.resolve();
  }

  setRootPath(rootPath) {
    this.rootGeneration++;
    this.rootPath = rootPath;
    this.rootFileInfo = null;
    this.rootInfoRootPath = null;
    this.undoStack = [];
  }

  getRootPath() {
    return this.rootPath;
  }

  assertCurrentRoot(generation) {
    if (this.rootGeneration !== generation) throw new Error("Workspace changed.");
  }

  async withFileMutation(relativePath, operation, options) {
    if (typeof operation !== "function") {
      throw new Error("A file mutation callback is required.");
    }
    return this.withFileMutations([relativePath], () => operation(), options);
  }

  // One cross-process lock per project file (project-file-writes.cjs). The
  // root generation also rejects a mutation queued before the window switched
  // folders, even when the new folder has the same path.
  async withFileMutations(relativePaths, operation, options) {
    const rootPath = this.rootPath;
    const generation = this.rootGeneration;
    if (!rootPath) throw new Error(WorkspaceError.invalidPath);
    const absolute = relativePaths.map((file) => this.resolvePath(file));
    return withProjectFileWrites(absolute, (destinations) => {
      if (this.rootPath !== rootPath) throw new Error(WorkspaceError.invalidPath);
      this.assertCurrentRoot(generation);
      relativePaths.forEach((file) => this.resolvePath(file));
      return operation(destinations);
    }, { directory: this.fileLockDirectory, ...options });
  }

  resolvePath(relativePath) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const trimmed = (relativePath ?? "").trim();
    const resolved = path.resolve(this.rootPath, trimmed);
    const rootResolved = path.resolve(this.rootPath);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(WorkspaceError.invalidPath);
    }
    try {
      const realRoot = realpathSync(rootResolved);
      const realBoundary = nearestExistingRealPath(resolved);
      if (!isWithinPath(realRoot, realBoundary)) {
        throw new Error(WorkspaceError.invalidPath);
      }
    } catch {
      throw new Error(WorkspaceError.invalidPath);
    }
    return resolved;
  }

  async rootInfo() {
    if (!this.rootPath) {
      return null;
    }
    if (this.rootInfoRootPath !== this.rootPath) {
      this.rootInfoRootPath = this.rootPath;
      this.rootFileInfo = null;
    }
    if (this.rootFileInfo) {
      return this.rootFileInfo;
    }
    const generation = this.rootGeneration;
    const settings = await this.loadSettings().catch(() => null);
    this.assertCurrentRoot(generation);
    if (typeof settings?.rootFile === "string" && /\.tex$/i.test(settings.rootFile.trim())) {
      try {
        const resolved = this.resolvePath(settings.rootFile);
        if ((await fsp.stat(resolved)).isFile()) {
          this.assertCurrentRoot(generation);
          this.rootFileInfo = { path: normalizeRelativePath(path.relative(this.rootPath, resolved)), source: "manual" };
          return this.rootFileInfo;
        }
      } catch { /* A moved project may have a stale root. Try auto-detection. */ }
    }
    this.assertCurrentRoot(generation);
    const autoRoot = await this.detectRootFile();
    this.assertCurrentRoot(generation);
    if (autoRoot) {
      this.rootFileInfo = { path: autoRoot, source: "auto" };
      return this.rootFileInfo;
    }
    return null;
  }

  async setRootFile(pathValue) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const generation = this.rootGeneration;
    const trimmed = (pathValue ?? "").trim();
    if (!trimmed) {
      return this.clearRootOverride();
    }
    const resolved = this.resolvePath(trimmed);
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error(WorkspaceError.invalidPath);
    }
    if (path.extname(resolved).toLowerCase() !== ".tex") {
      throw new Error(WorkspaceError.invalidPath);
    }
    this.assertCurrentRoot(generation);
    const relativePath = normalizeRelativePath(trimmed);
    await this.updateSettings((settings) => {
      settings.rootFile = relativePath;
      return settings;
    });
    this.assertCurrentRoot(generation);
    this.rootFileInfo = { path: relativePath, source: "manual" };
    this.rootInfoRootPath = this.rootPath;
    return this.rootFileInfo;
  }

  async clearRootOverride() {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const generation = this.rootGeneration;
    const autoRoot = await this.detectRootFile();
    this.assertCurrentRoot(generation);
    await this.updateSettings((settings) => {
      delete settings.rootFile;
      return settings;
    });
    this.assertCurrentRoot(generation);
    this.rootInfoRootPath = this.rootPath;
    this.rootFileInfo = autoRoot ? { path: autoRoot, source: "auto" } : null;
    return this.rootFileInfo;
  }

  async listFiles() {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const results = [];
    await this.walkEntries({
      onFile: (relativePath, absolutePath) => {
        const name = path.basename(absolutePath);
        if (isHiddenEditorFile(name)) {
          return;
        }
        results.push(relativePath);
      },
      limit: 5000,
    });
    return results.sort((a, b) => a.localeCompare(b, "ja"));
  }

  async listFolders() {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const results = [];
    await this.walkEntries({
      onDirectory: (relativePath) => {
        if (relativePath) {
          results.push(relativePath);
        }
      },
      limit: 5000,
    });
    return results.sort((a, b) => a.localeCompare(b, "ja"));
  }

  async readFile(relativePath, options) {
    const resolved = this.resolvePath(relativePath);
    await recoverProjectFile(resolved, { directory: this.fileLockDirectory });
    const content = await readUtf8File(resolved, options);
    return content;
  }

  async readBinaryFile(relativePath) {
    const resolved = this.resolvePath(relativePath);
    await recoverProjectFile(resolved, { directory: this.fileLockDirectory });
    return fsp.readFile(resolved);
  }

  // For reads that open the file themselves (size-limited reads): first
  // settle a save that was interrupted in place.
  async recoverFile(relativePath) {
    await recoverProjectFile(this.resolvePath(relativePath), { directory: this.fileLockDirectory });
  }

  async writeFile(relativePath, content) {
    await this.writeBinaryFile(relativePath, Buffer.from(content, "utf8"));
  }

  async writeBinaryFile(relativePath, content) {
    await this.withFileMutation(relativePath, () =>
      writeProjectFile(this.resolvePath(relativePath), content, { directory: this.fileLockDirectory }));
  }

  async createFile(relativePath) {
    await this.withFileMutation(relativePath, async () => {
      const resolved = this.resolvePath(relativePath);
      const exists = await fsp.stat(resolved).then(() => true).catch(() => false);
      if (exists) throw new Error(WorkspaceError.alreadyExists);
      await this.writeFile(relativePath, "");
    });
  }

  async createFolder(relativePath) {
    const resolved = this.resolvePath(relativePath);
    const exists = await fsp.stat(resolved).then(() => true).catch(() => false);
    if (exists) {
      throw new Error(WorkspaceError.alreadyExists);
    }
    await ensureDirectory(resolved);
  }

  // On a case-insensitive volume both spellings can address one directory entry.
  // Distinct entries (including hard links) must still never replace one another.
  async isCaseOnlyRename(source, target) {
    const folded = (name) => name.normalize("NFC").toLowerCase();
    const parentDir = path.dirname(source);
    if (path.dirname(target) !== parentDir) return false;
    const targetName = folded(path.basename(target));
    if (folded(path.basename(source)) !== targetName) return false;
    return (await fsp.readdir(parentDir)).filter((name) => folded(name) === targetName).length === 1;
  }

  async withWorkspaceEntryMove(source, target, operation = () => fsp.rename(source, target), {
    generation = this.rootGeneration, allowCaseRename = false,
  } = {}) {
    const rootPath = this.rootPath;
    this.assertCurrentRoot(generation);
    const contents = async () => {
      const stat = await fsp.lstat(source);
      if (!stat.isDirectory()) return [];
      const children = await fsp.readdir(source, { recursive: true });
      return children.filter((name) => !isStagingName(name)).sort();
    };
    const children = await contents().catch((error) => {
      if (error.code === "ENOENT") throw new Error(WorkspaceError.notFound);
      throw error;
    });
    const files = [source, target, ...children.flatMap((name) => [path.join(source, name), path.join(target, name)])];
    return withProjectFileWrites(files, async () => {
      if (this.rootPath !== rootPath) throw new Error(WorkspaceError.invalidPath);
      this.assertCurrentRoot(generation);
      this.resolvePath(source);
      this.resolvePath(target);
      if (JSON.stringify(await contents()) !== JSON.stringify(children)) {
        throw new Error(WorkspaceError.invalidMove);
      }
      const exists = await fsp.lstat(target).then(() => true, (error) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      });
      if (exists && !(allowCaseRename && await this.isCaseOnlyRename(source, target))) {
        throw new Error(WorkspaceError.alreadyExists);
      }
      await ensureDirectory(path.dirname(target));
      this.assertCurrentRoot(generation);
      const result = await operation();
      this.assertCurrentRoot(generation);
      return result;
    }, { directory: this.fileLockDirectory, allowDanglingLinks: true, entryPaths: true });
  }

  async renameItem(relativePath, newName) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const generation = this.rootGeneration;
    const trimmed = (newName ?? "").trim();
    if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) {
      throw new Error(WorkspaceError.invalidName);
    }
    const resolved = this.resolvePath(relativePath);
    const stat = await fsp.stat(resolved).catch(() => null);
    this.assertCurrentRoot(generation);
    if (!stat) {
      throw new Error(WorkspaceError.notFound);
    }
    const parentDir = path.dirname(resolved);
    const target = path.join(parentDir, trimmed);
    await this.withWorkspaceEntryMove(resolved, target, undefined, { generation, allowCaseRename: true });
    const newRelative = normalizeRelativePath(path.relative(this.rootPath, target));
    this.updateRootOverrideAfterRename(relativePath, newRelative);
    return newRelative;
  }

  async moveItem(relativePath, destinationFolder) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const generation = this.rootGeneration;
    const trimmed = (relativePath ?? "").trim();
    if (!trimmed) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const resolvedSource = this.resolvePath(trimmed);
    const stat = await fsp.stat(resolvedSource).catch(() => null);
    this.assertCurrentRoot(generation);
    if (!stat) {
      throw new Error(WorkspaceError.notFound);
    }

    let resolvedDestination;
    const destinationTrimmed = (destinationFolder ?? "").trim();
    if (!destinationTrimmed) {
      resolvedDestination = this.rootPath;
    } else {
      resolvedDestination = this.resolvePath(destinationTrimmed);
      const destStat = await fsp.stat(resolvedDestination).catch(() => null);
      if (!destStat || !destStat.isDirectory()) {
        throw new Error(WorkspaceError.invalidMove);
      }
    }

    const sourcePath = path.resolve(resolvedSource);
    const destinationPath = path.resolve(resolvedDestination);
    if (stat.isDirectory()) {
      if (destinationPath === sourcePath || destinationPath.startsWith(sourcePath + path.sep)) {
        throw new Error(WorkspaceError.invalidMove);
      }
    }

    const target = path.join(destinationPath, path.basename(sourcePath));
    if (path.resolve(target) === sourcePath) {
      return normalizeRelativePath(trimmed);
    }
    await this.withWorkspaceEntryMove(sourcePath, target, undefined, { generation });
    const newRelative = normalizeRelativePath(path.relative(this.rootPath, target));
    this.updateRootOverrideAfterRename(trimmed, newRelative);

    const affectsIndex =
      stat.isDirectory() ||
      this.isIndexTarget(trimmed) ||
      this.isIndexTarget(newRelative);
    this.undoStack.push({
      kind: "move",
      fromPath: normalizeRelativePath(trimmed),
      toPath: newRelative,
      isDirectory: stat.isDirectory(),
      affectsIndex,
      trashedPath: null,
    });
    return newRelative;
  }

  async copyItem(relativePath, destinationFolder) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const generation = this.rootGeneration;
    const trimmed = (relativePath ?? "").trim();
    if (!trimmed) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const resolvedSource = this.resolvePath(trimmed);
    const stat = await fsp.stat(resolvedSource).catch(() => null);
    this.assertCurrentRoot(generation);
    if (!stat) {
      throw new Error(WorkspaceError.notFound);
    }

    let resolvedDestination;
    const destinationTrimmed = (destinationFolder ?? "").trim();
    if (!destinationTrimmed) {
      resolvedDestination = this.rootPath;
    } else {
      resolvedDestination = this.resolvePath(destinationTrimmed);
      const destStat = await fsp.stat(resolvedDestination).catch(() => null);
      if (!destStat || !destStat.isDirectory()) {
        throw new Error(WorkspaceError.invalidMove);
      }
    }

    const target = path.join(resolvedDestination, path.basename(resolvedSource));
    await this.withWorkspaceEntryMove(resolvedSource, target, async () => {
      if (stat.isDirectory() || (await fsp.lstat(resolvedSource)).isSymbolicLink()) {
        const staging = await fsp.mkdtemp(path.join(path.dirname(target), ".tex64-copy-"));
        try {
          const copy = path.join(staging, path.basename(target));
          await fsp.cp(resolvedSource, copy, { recursive: stat.isDirectory(), force: false, errorOnExist: true });
          await fsp.rename(copy, target);
        } finally {
          await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
        }
      } else {
        await writeProjectFile(target, await fsp.readFile(resolvedSource), { mode: stat.mode });
      }
    }, { generation });
    return normalizeRelativePath(path.relative(this.rootPath, target));
  }

  async deleteItem(relativePath) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const generation = this.rootGeneration;
    const trimmed = (relativePath ?? "").trim();
    if (!trimmed) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const resolved = this.resolvePath(trimmed);
    const stat = await fsp.stat(resolved).catch(() => null);
    this.assertCurrentRoot(generation);
    if (!stat) {
      throw new Error(WorkspaceError.notFound);
    }
    const manualRootPathBeforeDelete =
      this.rootFileInfo?.source === "manual" ? this.rootFileInfo.path : null;
    const normalizedTargetPath = normalizeRelativePath(trimmed);
    const restoreRootPath =
      manualRootPathBeforeDelete &&
      (manualRootPathBeforeDelete === normalizedTargetPath ||
        manualRootPathBeforeDelete.startsWith(`${normalizedTargetPath}/`))
        ? manualRootPathBeforeDelete
        : null;
    const affectsIndex = stat.isDirectory() || this.isIndexTarget(trimmed);

    const trashedPath = await this.moveToInternalTrash(resolved);
    this.assertCurrentRoot(generation);
    this.undoStack.push({
      kind: "delete",
      fromPath: normalizeRelativePath(trimmed),
      toPath: null,
      isDirectory: stat.isDirectory(),
      affectsIndex,
      trashedPath,
      restoreRootPath,
    });
    await this.updateRootOverrideAfterDelete(trimmed);
  }

  async undoLastOperation() {
    if (!this.rootPath) throw new Error(WorkspaceError.invalidPath);
    const generation = this.rootGeneration;
    const run = this.pendingUndo.then(() => this.restoreLastOperation(generation));
    this.pendingUndo = run.catch(() => {});
    return run;
  }

  async restoreLastOperation(generation) {
    this.assertCurrentRoot(generation);
    const stack = this.undoStack;
    const index = stack.length - 1;
    const operation = stack[index];
    if (!operation) return null;
    const sourcePath = operation.kind === "move" ? operation.toPath : operation.trashedPath;
    if (!sourcePath) throw new Error(WorkspaceError.invalidMove);
    const source = this.resolvePath(sourcePath);
    const target = this.resolvePath(operation.fromPath);
    // The existence check and the rename run under the project file locks.
    await this.withWorkspaceEntryMove(source, target, undefined, { generation });
    // A failed restore remains available after the user resolves the conflict.
    stack.splice(index, 1);
    this.assertCurrentRoot(generation);
    if (operation.kind === "move") {
      this.updateRootOverrideAfterRename(operation.toPath, operation.fromPath);
    } else if (operation.restoreRootPath) {
      this.rootInfoRootPath = this.rootPath;
      this.rootFileInfo = { path: operation.restoreRootPath, source: "manual" };
      await this.updateSettings((settings) => {
        settings.rootFile = operation.restoreRootPath;
      });
    }
    return operation;
  }

  async detectRootFile() {
    if (!this.rootPath) {
      return null;
    }
    const mainCandidate = (() => {
      try {
        return this.resolvePath("main.tex");
      } catch {
        return null;
      }
    })();
    const mainExists = mainCandidate
      ? await fsp
          .stat(mainCandidate)
          .then((stat) => stat.isFile())
          .catch(() => false)
      : false;
    if (mainExists) {
      return "main.tex";
    }

    const candidates = [];
    await this.walkEntries({
      onFile: async (relativePath, absolutePath) => {
        if (path.extname(absolutePath).toLowerCase() !== ".tex") {
          return;
        }
        const content = await readUtf8File(absolutePath).catch(() => null);
        if (content === null) {
          return;
        }
        const lowerName = path.basename(absolutePath).toLowerCase();
        let score = 0;
        if (content.includes("\\documentclass")) {
          score += 3;
        }
        if (content.includes("\\begin{document}")) {
          score += 2;
        }
        if (content.includes("\\end{document}")) {
          score += 1;
        }
        if (
          [
            "main.tex",
            "root.tex",
            "paper.tex",
            "thesis.tex",
            "report.tex",
            "lecture.tex",
            "notes.tex",
          ].includes(lowerName)
        ) {
          score += 2;
        }
        if (score <= 0) {
          return;
        }
        const depth = normalizeRelativePath(relativePath).split("/").length;
        candidates.push({ path: normalizeRelativePath(relativePath), score, depth });
      },
    });

    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      return a.path.localeCompare(b.path, "ja");
    });
    return candidates[0].path;
  }

  async resolveTexRootFromMagic(relativePath, options = {}) {
    if (!this.rootPath) {
      return null;
    }
    const maxDepth = Number.isFinite(options?.maxDepth)
      ? Math.max(1, Math.floor(options.maxDepth))
      : 5;
    const visited = new Set();
    let current = normalizeRelativePath(relativePath ?? "");
    let resolvedAtLeastOnce = false;

    for (let depth = 0; depth < maxDepth; depth += 1) {
      const token = current.toLowerCase();
      if (visited.has(token)) {
        return null;
      }
      visited.add(token);
      const absPath = this.resolvePath(current);
      const content = await readUtf8File(absPath).catch(() => null);
      if (content === null) {
        return null;
      }
      const magic = extractTexMagicRoot(content);
      if (!magic) {
        return resolvedAtLeastOnce ? current : null;
      }
      const baseDir = path.dirname(absPath);
      const candidates = [];
      candidates.push(magic);
      if (!path.extname(magic)) {
        candidates.push(`${magic}.tex`);
      }
      let next = null;
      for (const candidate of candidates) {
        const resolvedAbs = path.resolve(baseDir, candidate);
        const rootResolved = path.resolve(this.rootPath);
        if (resolvedAbs !== rootResolved && !resolvedAbs.startsWith(rootResolved + path.sep)) {
          continue;
        }
        const stat = await fsp.stat(resolvedAbs).catch(() => null);
        if (!stat || !stat.isFile()) {
          continue;
        }
        if (path.extname(resolvedAbs).toLowerCase() !== ".tex") {
          continue;
        }
        next = normalizeRelativePath(path.relative(this.rootPath, resolvedAbs));
        break;
      }
      if (!next) {
        return null;
      }
      resolvedAtLeastOnce = true;
      current = next;
    }
    return resolvedAtLeastOnce ? current : null;
  }

  async updateSettings(mutator) {
    const relativePath = ".tex64/settings.json";
    const settingsPath = this.resolvePath(relativePath);
    const generation = this.rootGeneration;
    return this.withFileMutation(relativePath, async () => {
      let current = {};
      try {
        current = JSON.parse(await readUtf8File(settingsPath));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        throw new Error("Invalid project settings.");
      }
      this.assertCurrentRoot(generation);
      const next = mutator(current) ?? current;
      if (!Object.keys(next).some(key => next[key] !== undefined)) {
        await fsp.rm(settingsPath, { force: true });
        return;
      }
      this.assertCurrentRoot(generation);
      await writeProjectFile(settingsPath, JSON.stringify(next, null, 2), { directory: this.fileLockDirectory });
    });
  }

  async loadSettings() {
    if (!this.rootPath) return null;
    const settingsPath = this.resolvePath(".tex64/settings.json");
    try {
      return JSON.parse(await readUtf8File(settingsPath));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async saveSettings(settings) {
    const relativePath = ".tex64/settings.json";
    const settingsPath = this.resolvePath(relativePath);
    const generation = this.rootGeneration;
    return this.withFileMutation(relativePath, async () => {
      this.assertCurrentRoot(generation);
      await writeProjectFile(settingsPath, JSON.stringify(settings, null, 2), { directory: this.fileLockDirectory });
    });
  }

  async removeSettings() {
    if (!this.rootPath) return;
    const relativePath = ".tex64/settings.json";
    const settingsPath = this.resolvePath(relativePath);
    return this.withFileMutation(relativePath, () => fsp.rm(settingsPath, { force: true }));
  }

  updateRootOverrideAfterRename(oldPath, newPath) {
    if (!this.rootPath || this.rootInfoRootPath !== this.rootPath || !this.rootFileInfo) {
      return;
    }
    if (this.rootFileInfo.source !== "manual") {
      return;
    }
    const currentRoot = this.rootFileInfo.path;
    const normalizedOld = normalizeRelativePath(oldPath);
    const normalizedNew = normalizeRelativePath(newPath);
    if (currentRoot === normalizedOld) {
      this.rootFileInfo = { path: normalizedNew, source: "manual" };
      this.updateSettings((settings) => {
        settings.rootFile = normalizedNew;
        return settings;
      }).catch(() => null);
      return;
    }
    const prefix = normalizedOld + "/";
    if (!currentRoot.startsWith(prefix)) {
      return;
    }
    const suffix = currentRoot.slice(prefix.length);
    const updatedPath = `${normalizedNew}/${suffix}`;
    this.rootFileInfo = { path: updatedPath, source: "manual" };
    this.updateSettings((settings) => {
      settings.rootFile = updatedPath;
      return settings;
    }).catch(() => null);
  }

  async updateRootOverrideAfterDelete(deletedPath) {
    if (!this.rootPath || this.rootInfoRootPath !== this.rootPath || !this.rootFileInfo) {
      return;
    }
    if (this.rootFileInfo.source !== "manual") {
      return;
    }
    const currentRoot = this.rootFileInfo.path;
    const normalizedDeleted = normalizeRelativePath(deletedPath);
    if (currentRoot === normalizedDeleted || currentRoot.startsWith(normalizedDeleted + "/")) {
      this.rootFileInfo = null;
      await this.updateSettings((settings) => {
        delete settings.rootFile;
        return settings;
      }).catch(() => null);
    }
  }

  isIndexTarget(relativePath) {
    const lower = normalizeRelativePath(relativePath).toLowerCase();
    return lower.endsWith(".tex") || lower.endsWith(".bib");
  }

  async moveToInternalTrash(itemPath) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const generation = this.rootGeneration;
    const trashDir = this.resolvePath(".tex64/.trash");
    await ensureDirectory(trashDir);
    this.assertCurrentRoot(generation);
    const baseName = path.basename(itemPath);
    let attempt = 0;
    let candidate = this.resolvePath(
      normalizeRelativePath(path.join(".tex64", ".trash", `${generateId()}-${baseName}`)),
    );
    while (attempt < 5) {
      const exists = await fsp.stat(candidate).then(() => true).catch(() => false);
      if (!exists) {
        break;
      }
      this.assertCurrentRoot(generation);
      attempt += 1;
      candidate = this.resolvePath(
        normalizeRelativePath(path.join(".tex64", ".trash", `${generateId()}-${baseName}`)),
      );
    }
    const finalExists = await fsp.stat(candidate).then(() => true).catch(() => false);
    if (finalExists) {
      throw new Error(WorkspaceError.alreadyExists);
    }
    await this.withWorkspaceEntryMove(itemPath, candidate, undefined, { generation });
    return candidate;
  }

  async walkEntries({ onFile, onDirectory, onSymlink, limit }) {
    if (!this.rootPath) {
      return;
    }
    const max = limit ?? Number.POSITIVE_INFINITY;
    const rootPath = path.resolve(this.rootPath);
    let count = 0;

    const walk = async (dirPath) => {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (count >= max) {
          return;
        }
        // Keep the file tree focused on TeX writing:
        // - Hide dot-directories (VCS internals, tool metadata, etc.)
        // - Show dotfiles because they can contain TeX-related config (.latexmkrc, .latexindent.yaml, etc.)
        // - Hide OS noise files.
        if (entry.isDirectory() && entry.name.startsWith(".")) {
          continue;
        }
        if (entry.isFile() && isIgnoredFile(entry.name)) {
          continue;
        }
        if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        const absPath = path.join(dirPath, entry.name);
        const relPath = normalizeRelativePath(path.relative(rootPath, absPath));
        if (entry.isDirectory()) {
          if (onDirectory) {
            await onDirectory(relPath, absPath);
            count += 1;
          }
          await walk(absPath);
        } else if (entry.isFile()) {
          if (onFile) {
            await onFile(relPath, absPath);
            count += 1;
          }
        } else if (entry.isSymbolicLink() && onSymlink) {
          await onSymlink(relPath, absPath);
          count += 1;
        }
      }
    };

    await walk(rootPath);
  }
}

module.exports = {
  WorkspaceManager,
  WorkspaceError,
  normalizeRelativePath,
  canonicalWorkspacePath,
};
