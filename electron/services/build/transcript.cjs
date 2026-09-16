const fs = require("fs");
const path = require("path");

// The panel's "Detailed log" used to show latexmk's console chatter, which is
// the run's narration rather than the compiler's transcript. The .log file is
// what a TeX user means by "the log": it holds the error context lines (l.42
// ...), the package versions, and everything that scrolled past. Read it back
// after the run so the panel can show that instead.
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

module.exports = (BuildService) => {
  BuildService.prototype.readBuildTranscript = function (rootPath, mainFileName, options = {}) {
    const jobName = typeof options?.jobName === "string" ? options.jobName.trim() : "";
    const outDir = typeof options?.outDir === "string" ? options.outDir.trim() : "";
    const baseName = path.basename(mainFileName ?? "", path.extname(mainFileName ?? ""));
    const names = [jobName, baseName].filter(Boolean);
    const dirs = [outDir ? path.resolve(rootPath ?? ".", outDir) : null, rootPath].filter(Boolean);

    for (const dir of dirs) {
      for (const name of names) {
        const candidate = path.join(dir, `${name}.log`);
        try {
          const stat = fs.statSync(candidate);
          if (!stat.isFile()) {
            continue;
          }
          if (Number.isFinite(options.startedAt) && stat.mtimeMs < options.startedAt - 1000) {
            continue;
          }
          const text = fs.readFileSync(candidate, "utf8");
          if (!text.trim()) {
            continue;
          }
          return text.length > MAX_TRANSCRIPT_BYTES
            ? `${text.slice(-MAX_TRANSCRIPT_BYTES)}\n[…truncated to the last 2 MB]`
            : text;
        } catch {
          // Unreadable or absent: try the next candidate.
        }
      }
    }
    return null;
  };
};
