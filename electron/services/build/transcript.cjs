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
        let fd;
        try {
          const stat = fs.statSync(candidate);
          if (!stat.isFile()) {
            continue;
          }
          if (Number.isFinite(options.startedAt) && stat.mtimeMs < options.startedAt - 1000) {
            continue;
          }
          fd = fs.openSync(candidate, "r");
          const { size } = fs.fstatSync(fd);
          const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
          const bytes = Buffer.allocUnsafe(size - start);
          let read = 0;
          while (read < bytes.length) {
            const count = fs.readSync(fd, bytes, read, bytes.length - read, start + read);
            if (!count) break;
            read += count;
          }
          // The tail can begin in the middle of a multibyte character.
          let first = 0;
          while (start > 0 && first < read && (bytes[first] & 0xc0) === 0x80) first++;
          const text = bytes.toString("utf8", first, read);
          if (text.trim()) return start ? `${text}\n[…truncated to the last 2 MB]` : text;
        } catch {
          // Unreadable or absent: try the next candidate.
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      }
    }
    return null;
  };
};
