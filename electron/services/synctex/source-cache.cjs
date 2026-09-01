const fs = require("fs");
const path = require("path");

module.exports = (SynctexService) => {
  SynctexService.prototype.getSourceLines = function (sourcePath) {
    if (!sourcePath || typeof sourcePath !== "string") {
      return null;
    }
    const normalizedPath = this.normalizeComparePath(sourcePath) ?? path.resolve(sourcePath);
    if (this.sourceLineCache.has(normalizedPath)) {
      return this.sourceLineCache.get(normalizedPath);
    }
    let lines = null;
    try {
      const raw = fs.readFileSync(normalizedPath, "utf8");
      lines = raw.split(/\r?\n/);
    } catch {
      lines = null;
    }
    this.sourceLineCache.set(normalizedPath, lines);
    return lines;
  };

  SynctexService.prototype.getSourceLine = function (sourcePath, line) {
    if (!Number.isFinite(line) || line < 1) {
      return null;
    }
    const lines = this.getSourceLines(sourcePath);
    if (!Array.isArray(lines) || lines.length === 0) {
      return null;
    }
    const index = Math.floor(line) - 1;
    if (index < 0 || index >= lines.length) {
      return null;
    }
    return typeof lines[index] === "string" ? lines[index] : null;
  };

  SynctexService.prototype.isLowSignalTexLine = function (lineText) {
    if (typeof lineText !== "string") {
      return false;
    }
    const trimmed = lineText.trim();
    if (!trimmed) {
      return true;
    }
    if (/^\\(?:begin|end|hline|cline|toprule|midrule|bottomrule|centering)\b/.test(trimmed)) {
      return true;
    }
    return false;
  };

  SynctexService.prototype.getReverseLinePenalty = function ({ sourcePath, line }) {
    const text = this.getSourceLine(sourcePath, line);
    if (!this.isLowSignalTexLine(text)) {
      return 0;
    }
    return 1200;
  };

  SynctexService.prototype.getRefineColumns = function ({ sourcePath, line, baseColumn }) {
    const columns = new Set();
    if (Number.isFinite(baseColumn) && baseColumn >= 1) {
      columns.add(Math.floor(baseColumn));
    }
    columns.add(1);
    const lineText = this.getSourceLine(sourcePath, line);
    if (typeof lineText === "string" && lineText.length > 0) {
      const firstNonSpace = lineText.search(/\S/);
      if (firstNonSpace >= 0) {
        columns.add(firstNonSpace + 1);
      }
      const length = lineText.length;
      if (length >= 6) {
        columns.add(Math.max(1, Math.floor(length * 0.33)));
        columns.add(Math.max(1, Math.floor(length * 0.66)));
      }
    }
    return Array.from(columns)
      .filter((value) => Number.isFinite(value) && value >= 1)
      .sort((left, right) => left - right)
      .slice(0, 6);
  };
};

