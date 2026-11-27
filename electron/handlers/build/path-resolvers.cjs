const { matchSourcePathBySuffix } = require("../../services/synctex/source-path.cjs");

const createBuildPathResolvers = ({ fs, path }) => {
  const workspaceTexIgnoreDirs = new Set([".git", "node_modules", ".tex64"]);

  const collectWorkspaceTexFiles = (rootPath) => {
    if (!rootPath || typeof rootPath !== "string") {
      return [];
    }
    const files = [];
    const stack = [rootPath];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (workspaceTexIgnoreDirs.has(entry.name) || entry.name.startsWith(".")) {
            continue;
          }
          stack.push(path.join(current, entry.name));
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (!entry.name.toLowerCase().endsWith(".tex")) {
          continue;
        }
        files.push(path.join(current, entry.name));
      }
    }
    return files;
  };

  const resolveSynctexExternalTexPath = (rootPath, targetPath) => {
    if (!rootPath || !targetPath || typeof targetPath !== "string") {
      return null;
    }
    if (!path.isAbsolute(targetPath) || !targetPath.toLowerCase().endsWith(".tex")) {
      return null;
    }
    const targetBasename = path.basename(targetPath);
    const matches = collectWorkspaceTexFiles(rootPath).filter((file) => path.basename(file) === targetBasename);
    return matchSourcePathBySuffix(targetPath, matches);
  };

  const resolveWorkspacePathFromRoot = (rootPath, targetPath) => {
    if (!targetPath || typeof targetPath !== "string") {
      return null;
    }
    return path.isAbsolute(targetPath) ? targetPath : path.join(rootPath, targetPath);
  };

  const resolveWorkspaceRelativePath = (rootPath, targetPath) => {
    if (!rootPath || !targetPath || typeof targetPath !== "string") {
      return null;
    }
    if (!path.isAbsolute(targetPath)) {
      return targetPath;
    }
    const relative = path.relative(rootPath, targetPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    return relative;
  };

  const resolveSynctexWorkspacePath = (rootPath, targetPath) => {
    if (!rootPath || !targetPath || typeof targetPath !== "string") {
      return null;
    }
    const absolutePath = path.isAbsolute(targetPath) ? targetPath : path.join(rootPath, targetPath);
    const workspaceRelative = resolveWorkspaceRelativePath(rootPath, absolutePath);
    if (workspaceRelative) {
      try {
        if (fs.statSync(absolutePath).isFile()) return path.resolve(rootPath, workspaceRelative);
      } catch {
        // The PDF may predate a move. Look for its source in the current tree.
      }
    }
    const fallback = resolveSynctexExternalTexPath(rootPath, absolutePath);
    if (fallback) {
      return fallback;
    }
    return null;
  };

  const isWorkspaceSynctexPathSame = (rootPath, leftPath, rightPath) => {
    const leftResolved = resolveSynctexWorkspacePath(rootPath, leftPath);
    const rightResolved = resolveSynctexWorkspacePath(rootPath, rightPath);
    if (!leftResolved || !rightResolved) {
      return false;
    }
    const normalize = (inputPath) => {
      if (!inputPath || typeof inputPath !== "string") {
        return null;
      }
      let normalized = path.normalize(path.resolve(inputPath));
      try {
        if (typeof fs.realpathSync.native === "function") {
          normalized = fs.realpathSync.native(normalized);
        } else {
          normalized = fs.realpathSync(normalized);
        }
      } catch {
        // Keep resolved path when realpath cannot be resolved.
      }
      normalized = path.normalize(normalized);
      if (process.platform === "win32") {
        return normalized.toLowerCase();
      }
      return normalized;
    };
    return normalize(leftResolved) === normalize(rightResolved);
  };

  return {
    resolveWorkspacePathFromRoot,
    resolveWorkspaceRelativePath,
    resolveSynctexWorkspacePath,
    resolveSynctexExternalTexPath,
    isWorkspaceSynctexPathSame,
  };
};

module.exports = { createBuildPathResolvers };

