const fs = require("fs");
const path = require("path");

const {
  isPathWithinRoot,
  listRecentFiles,
  parseFlsPdfOutputs,
  parseFdbPdfOutputs,
} = require("./utils.cjs");

module.exports = (BuildService) => {
  BuildService.prototype.resolvePdfPathAfterBuild = function (rootPath, mainFileName, options = {}) {
    const startedAt = Number.isFinite(options?.startedAt) ? options.startedAt : 0;
    const minMtimeMs = startedAt > 0 ? startedAt - 5000 : 0;
    const expectedPdfPath =
      typeof options?.expectedPdfPath === "string" && options.expectedPdfPath.trim()
        ? options.expectedPdfPath.trim()
        : null;
    if (expectedPdfPath && fs.existsSync(expectedPdfPath)) {
      return expectedPdfPath;
    }

    const jobName = typeof options?.jobName === "string" ? options.jobName.trim() : "";
    const mainBaseName = path.basename(mainFileName ?? "", path.extname(mainFileName ?? ""));
    const outDir = typeof options?.outDir === "string" ? options.outDir.trim() : "";

    const candidateDirs = [];
    const pushDir = (dirPath) => {
      if (!dirPath || typeof dirPath !== "string") {
        return;
      }
      const resolved = path.resolve(dirPath);
      if (candidateDirs.includes(resolved)) {
        return;
      }
      try {
        if (!fs.statSync(resolved).isDirectory()) {
          return;
        }
      } catch {
        return;
      }
      candidateDirs.push(resolved);
    };

    if (expectedPdfPath) {
      pushDir(path.dirname(expectedPdfPath));
    }
    if (outDir) {
      pushDir(path.join(rootPath, outDir));
    }
    pushDir(path.dirname(path.join(rootPath, mainFileName)));
    pushDir(rootPath);

    if (jobName) {
      for (const dirPath of candidateDirs) {
        const direct = path.join(dirPath, `${jobName}.pdf`);
        if (fs.existsSync(direct) && isPathWithinRoot(rootPath, direct)) {
          return direct;
        }
      }
    }

    const probeArtifact = (baseName, ext, filePath) => {
      if (!baseName || typeof baseName !== "string") {
        return null;
      }
      if (!filePath || typeof filePath !== "string") {
        return null;
      }
      if (!fs.existsSync(filePath) || !isPathWithinRoot(rootPath, filePath)) {
        return null;
      }
      let content = "";
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch {
        return null;
      }
      if (ext === ".fls") {
        const parsed = parseFlsPdfOutputs(content);
        const baseDir = parsed.pwd && path.isAbsolute(parsed.pwd) ? parsed.pwd : path.dirname(filePath);
        for (const outputPath of parsed.outputs) {
          const abs = path.isAbsolute(outputPath) ? outputPath : path.resolve(baseDir, outputPath);
          if (!isPathWithinRoot(rootPath, abs)) {
            continue;
          }
          try {
            if (fs.statSync(abs).isFile()) {
              return abs;
            }
          } catch {
            // ignore
          }
        }
        return null;
      }
      if (ext === ".fdb_latexmk") {
        const pdfs = parseFdbPdfOutputs(content);
        const baseDir = path.dirname(filePath);
        for (const value of pdfs) {
          const abs = path.isAbsolute(value) ? value : path.resolve(baseDir, value);
          if (!isPathWithinRoot(rootPath, abs)) {
            continue;
          }
          try {
            if (fs.statSync(abs).isFile()) {
              return abs;
            }
          } catch {
            // ignore
          }
        }
        return null;
      }
      return null;
    };

    const recentFls = [];
    for (const dirPath of candidateDirs) {
      recentFls.push(
        ...listRecentFiles(dirPath, (name) => name.toLowerCase().endsWith(".fls"), minMtimeMs).slice(
          0,
          10
        )
      );
    }
    recentFls.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of recentFls.slice(0, 20)) {
      const resolved = probeArtifact(jobName || mainBaseName, ".fls", entry.path);
      if (resolved) {
        return resolved;
      }
    }

    for (const dirPath of candidateDirs) {
      const candidates = [];
      if (jobName) {
        candidates.push(jobName);
      }
      if (mainBaseName && mainBaseName !== jobName) {
        candidates.push(mainBaseName);
      }
      for (const baseName of candidates) {
        const flsPath = path.join(dirPath, `${baseName}.fls`);
        const resolved = probeArtifact(baseName, ".fls", flsPath);
        if (resolved) {
          return resolved;
        }
      }
    }

    const recentFdb = [];
    for (const dirPath of candidateDirs) {
      recentFdb.push(
        ...listRecentFiles(
          dirPath,
          (name) => name.toLowerCase().endsWith(".fdb_latexmk"),
          minMtimeMs
        ).slice(0, 10)
      );
    }
    recentFdb.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of recentFdb.slice(0, 20)) {
      const resolved = probeArtifact(jobName || mainBaseName, ".fdb_latexmk", entry.path);
      if (resolved) {
        return resolved;
      }
    }

    for (const dirPath of candidateDirs) {
      const candidates = [];
      if (jobName) {
        candidates.push(jobName);
      }
      if (mainBaseName && mainBaseName !== jobName) {
        candidates.push(mainBaseName);
      }
      for (const baseName of candidates) {
        const fdbPath = path.join(dirPath, `${baseName}.fdb_latexmk`);
        const resolved = probeArtifact(baseName, ".fdb_latexmk", fdbPath);
        if (resolved) {
          return resolved;
        }
      }
    }

    const recentPdf = [];
    for (const dirPath of candidateDirs) {
      recentPdf.push(
        ...listRecentFiles(dirPath, (name) => name.toLowerCase().endsWith(".pdf"), minMtimeMs).slice(
          0,
          20
        )
      );
    }
    recentPdf.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of recentPdf.slice(0, 20)) {
      if (!isPathWithinRoot(rootPath, entry.path)) {
        continue;
      }
      try {
        if (fs.statSync(entry.path).isFile()) {
          return entry.path;
        }
      } catch {
        // ignore
      }
    }

    return null;
  };
};

