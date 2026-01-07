const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".tex180",
  ".swiftpm",
  "node_modules",
  "DerivedData",
  "build",
  "Resources",
  "tex180.xcodeproj",
]);
const HIDDEN_EDITOR_EXTENSIONS = new Set([
  "aux",
  "toc",
  "synctex",
  "fls",
  "log",
  "fdb_latexmk",
]);

const WorkspaceError = {
  invalidPath: "不正なパスです。",
  invalidName: "名前が不正です。",
  invalidEncoding: "UTF-8以外の文字コードです。",
  alreadyExists: "すでに存在します。",
  notFound: "見つかりません。",
  notEmpty: "フォルダが空ではありません。",
  invalidMove: "移動先が不正です。",
  cancelled: "キャンセルしました。",
  unknown: "プロジェクトの作成に失敗しました。",
};

const normalizeRelativePath = (relativePath) => {
  if (!relativePath) {
    return "";
  }
  return relativePath.split(path.sep).join("/");
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

const ensureDirectory = async (dirPath) => {
  await fsp.mkdir(dirPath, { recursive: true });
};

const readUtf8File = async (filePath) => {
  const data = await fsp.readFile(filePath);
  const content = data.toString("utf8");
  if (!content && data.length > 0) {
    throw new Error(WorkspaceError.invalidEncoding);
  }
  return content;
};

const writeUtf8File = async (filePath, content) => {
  const buffer = Buffer.from(content, "utf8");
  await fsp.writeFile(filePath, buffer);
};

class WorkspaceManager {
  constructor() {
    this.rootPath = null;
    this.rootFileInfo = null;
    this.rootInfoRootPath = null;
    this.undoStack = [];
  }

  setRootPath(rootPath) {
    this.rootPath = rootPath;
    this.rootFileInfo = null;
    this.rootInfoRootPath = null;
    this.undoStack = [];
  }

  getRootPath() {
    return this.rootPath;
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
    const settings = await this.loadSettings().catch(() => null);
    if (settings?.rootFile) {
      const resolved = this.resolvePath(settings.rootFile);
      const exists = await fsp
        .stat(resolved)
        .then((stat) => stat.isFile())
        .catch(() => false);
      if (exists) {
        this.rootFileInfo = { path: settings.rootFile, source: "manual" };
        return this.rootFileInfo;
      }
    }
    const autoRoot = await this.detectRootFile();
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
    this.rootFileInfo = { path: normalizeRelativePath(trimmed), source: "manual" };
    this.rootInfoRootPath = this.rootPath;
    await this.saveSettings({ rootFile: normalizeRelativePath(trimmed) });
    return this.rootFileInfo;
  }

  async clearRootOverride() {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    this.rootInfoRootPath = this.rootPath;
    const autoRoot = await this.detectRootFile();
    if (autoRoot) {
      this.rootFileInfo = { path: autoRoot, source: "auto" };
    } else {
      this.rootFileInfo = null;
    }
    await this.removeSettings();
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

  async readFile(relativePath) {
    const resolved = this.resolvePath(relativePath);
    const content = await readUtf8File(resolved);
    return content;
  }

  async readBinaryFile(relativePath) {
    const resolved = this.resolvePath(relativePath);
    return fsp.readFile(resolved);
  }

  async writeFile(relativePath, content) {
    const resolved = this.resolvePath(relativePath);
    await writeUtf8File(resolved, content);
  }

  async createFile(relativePath) {
    const resolved = this.resolvePath(relativePath);
    const exists = await fsp.stat(resolved).then(() => true).catch(() => false);
    if (exists) {
      throw new Error(WorkspaceError.alreadyExists);
    }
    await ensureDirectory(path.dirname(resolved));
    await writeUtf8File(resolved, "");
  }

  async createFolder(relativePath) {
    const resolved = this.resolvePath(relativePath);
    const exists = await fsp.stat(resolved).then(() => true).catch(() => false);
    if (exists) {
      throw new Error(WorkspaceError.alreadyExists);
    }
    await ensureDirectory(resolved);
  }

  async renameItem(relativePath, newName) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const trimmed = (newName ?? "").trim();
    if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) {
      throw new Error(WorkspaceError.invalidName);
    }
    const resolved = this.resolvePath(relativePath);
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat) {
      throw new Error(WorkspaceError.notFound);
    }
    const parentDir = path.dirname(resolved);
    const target = path.join(parentDir, trimmed);
    const exists = await fsp.stat(target).then(() => true).catch(() => false);
    if (exists) {
      throw new Error(WorkspaceError.alreadyExists);
    }
    await fsp.rename(resolved, target);
    const newRelative = normalizeRelativePath(path.relative(this.rootPath, target));
    this.updateRootOverrideAfterRename(relativePath, newRelative);
    return newRelative;
  }

  async moveItem(relativePath, destinationFolder) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const trimmed = (relativePath ?? "").trim();
    if (!trimmed) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const resolvedSource = this.resolvePath(trimmed);
    const stat = await fsp.stat(resolvedSource).catch(() => null);
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
    const exists = await fsp.stat(target).then(() => true).catch(() => false);
    if (exists) {
      throw new Error(WorkspaceError.alreadyExists);
    }

    await fsp.rename(sourcePath, target);
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
    const trimmed = (relativePath ?? "").trim();
    if (!trimmed) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const resolvedSource = this.resolvePath(trimmed);
    const stat = await fsp.stat(resolvedSource).catch(() => null);
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
    const exists = await fsp.stat(target).then(() => true).catch(() => false);
    if (exists) {
      throw new Error(WorkspaceError.alreadyExists);
    }

    await fsp.cp(resolvedSource, target, { recursive: stat.isDirectory() });
    return normalizeRelativePath(path.relative(this.rootPath, target));
  }

  async deleteItem(relativePath) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const trimmed = (relativePath ?? "").trim();
    if (!trimmed) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const resolved = this.resolvePath(trimmed);
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat) {
      throw new Error(WorkspaceError.notFound);
    }
    const affectsIndex = stat.isDirectory() || this.isIndexTarget(trimmed);

    const trashedPath = await this.moveToInternalTrash(resolved);
    this.undoStack.push({
      kind: "delete",
      fromPath: normalizeRelativePath(trimmed),
      toPath: null,
      isDirectory: stat.isDirectory(),
      affectsIndex,
      trashedPath,
    });
    this.updateRootOverrideAfterDelete(trimmed);
  }

  async undoLastOperation() {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const operation = this.undoStack.pop();
    if (!operation) {
      return null;
    }
    if (operation.kind === "move") {
      if (!operation.toPath) {
        throw new Error(WorkspaceError.invalidMove);
      }
      const source = this.resolvePath(operation.toPath);
      const target = this.resolvePath(operation.fromPath);
      const exists = await fsp.stat(target).then(() => true).catch(() => false);
      if (exists) {
        throw new Error(WorkspaceError.alreadyExists);
      }
      await ensureDirectory(path.dirname(target));
      await fsp.rename(source, target);
      this.updateRootOverrideAfterRename(operation.toPath, operation.fromPath);
      return operation;
    }
    if (operation.kind === "delete") {
      if (!operation.trashedPath) {
        throw new Error(WorkspaceError.invalidMove);
      }
      const target = this.resolvePath(operation.fromPath);
      const exists = await fsp.stat(target).then(() => true).catch(() => false);
      if (exists) {
        throw new Error(WorkspaceError.alreadyExists);
      }
      await ensureDirectory(path.dirname(target));
      await fsp.rename(operation.trashedPath, target);
      return operation;
    }
    return null;
  }

  async initializeProject(rootPath, template) {
    await ensureDirectory(rootPath);
    const entries = await fsp.readdir(rootPath).catch(() => []);
    const visibleEntries = entries.filter((entry) => !isHiddenName(entry));
    if (visibleEntries.length > 0) {
      throw new Error(WorkspaceError.notEmpty);
    }
    const content = this.templateContent(template);
    const mainTexPath = path.join(rootPath, "main.tex");
    await writeUtf8File(mainTexPath, content);
  }

  templateContent(template) {
    if (template === "lecture") {
      return [
        "\\documentclass{article}",
        "\\title{講義ノート}",
        "\\author{講師名}",
        "\\date{\\today}",
        "",
        "\\begin{document}",
        "\\maketitle",
        "",
        "\\section{目的}",
        "この講義の目的を書きます。",
        "",
        "\\section{内容}",
        "\\subsection{ポイント1}",
        "本文をここに書きます。",
        "",
        "\\subsection{ポイント2}",
        "本文をここに書きます。",
        "",
        "\\section{まとめ}",
        "まとめを書きます。",
        "",
        "\\end{document}",
        "",
      ].join("\n");
    }
    return [
      "\\documentclass{article}",
      "\\title{論文タイトル}",
      "\\author{著者名}",
      "\\date{\\today}",
      "",
      "\\begin{document}",
      "\\maketitle",
      "",
      "\\begin{abstract}",
      "概要をここに書きます。",
      "\\end{abstract}",
      "",
      "\\section{はじめに}",
      "ここから本文を開始します。",
      "",
      "\\section{結論}",
      "結論をここに書きます。",
      "",
      "\\end{document}",
      "",
    ].join("\n");
  }

  async detectRootFile() {
    if (!this.rootPath) {
      return null;
    }
    const mainCandidate = path.join(this.rootPath, "main.tex");
    const mainExists = await fsp
      .stat(mainCandidate)
      .then((stat) => stat.isFile())
      .catch(() => false);
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

  async loadSettings() {
    if (!this.rootPath) {
      return null;
    }
    const settingsPath = path.join(this.rootPath, ".tex180", "settings.json");
    const exists = await fsp.stat(settingsPath).then(() => true).catch(() => false);
    if (!exists) {
      return null;
    }
    const raw = await readUtf8File(settingsPath);
    return JSON.parse(raw);
  }

  async saveSettings(settings) {
    if (!this.rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const directory = path.join(this.rootPath, ".tex180");
    await ensureDirectory(directory);
    const settingsPath = path.join(directory, "settings.json");
    const payload = JSON.stringify(settings, null, 2);
    await writeUtf8File(settingsPath, payload);
  }

  async removeSettings() {
    if (!this.rootPath) {
      return;
    }
    const settingsPath = path.join(this.rootPath, ".tex180", "settings.json");
    await fsp.unlink(settingsPath).catch(() => null);
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
      this.saveSettings({ rootFile: normalizedNew }).catch(() => null);
      return;
    }
    const prefix = normalizedOld + "/";
    if (!currentRoot.startsWith(prefix)) {
      return;
    }
    const suffix = currentRoot.slice(prefix.length);
    const updatedPath = `${normalizedNew}/${suffix}`;
    this.rootFileInfo = { path: updatedPath, source: "manual" };
    this.saveSettings({ rootFile: updatedPath }).catch(() => null);
  }

  updateRootOverrideAfterDelete(deletedPath) {
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
      this.removeSettings().catch(() => null);
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
    const trashDir = path.join(this.rootPath, ".tex180", ".trash");
    await ensureDirectory(trashDir);
    const baseName = path.basename(itemPath);
    let attempt = 0;
    let candidate = path.join(trashDir, `${generateId()}-${baseName}`);
    while (attempt < 5) {
      const exists = await fsp.stat(candidate).then(() => true).catch(() => false);
      if (!exists) {
        break;
      }
      attempt += 1;
      candidate = path.join(trashDir, `${generateId()}-${baseName}`);
    }
    const finalExists = await fsp.stat(candidate).then(() => true).catch(() => false);
    if (finalExists) {
      throw new Error(WorkspaceError.alreadyExists);
    }
    await fsp.rename(itemPath, candidate);
    return candidate;
  }

  async walkEntries({ onFile, onDirectory, limit }) {
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
        if (entry.name.startsWith(".")) {
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
};
