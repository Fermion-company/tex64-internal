const path = require("path");

module.exports = (SynctexService) => {
  SynctexService.prototype.resolveReverseEntryPath = function (targetPath, cwd = null) {
    if (!targetPath || typeof targetPath !== "string") {
      return null;
    }
    const trimmed = targetPath.trim();
    if (!trimmed) {
      return null;
    }
    if (path.isAbsolute(trimmed)) {
      return trimmed;
    }
    if (cwd && typeof cwd === "string") {
      return path.resolve(cwd, trimmed);
    }
    return path.resolve(trimmed);
  };

  SynctexService.prototype.parseReverseResults = function (output, cwd = null) {
    if (!output || typeof output !== "string") {
      return [];
    }
    const lines = output.split(/\r?\n/);
    const entries = [];
    let currentPath = null;
    let currentLine = null;
    let currentColumn = null;
    const flush = () => {
      if (!currentPath || !Number.isFinite(currentLine) || currentLine < 1) {
        currentPath = null;
        currentLine = null;
        currentColumn = null;
        return;
      }
      entries.push({
        path: currentPath,
        line: currentLine,
        column: Number.isFinite(currentColumn) && currentColumn >= 1 ? currentColumn : 1,
      });
      currentPath = null;
      currentLine = null;
      currentColumn = null;
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("Input:")) {
        flush();
        const parsedPath = line.slice("Input:".length).trim();
        currentPath = this.resolveReverseEntryPath(parsedPath, cwd);
        continue;
      }
      if (line.startsWith("Line:")) {
        const parsedLine = Number.parseInt(line.slice("Line:".length).trim(), 10);
        currentLine = Number.isFinite(parsedLine) ? parsedLine : null;
        continue;
      }
      if (line.startsWith("Column:")) {
        const parsedColumn = Number.parseInt(line.slice("Column:".length).trim(), 10);
        currentColumn = Number.isFinite(parsedColumn) ? parsedColumn : null;
      }
    }
    flush();
    return entries;
  };

  SynctexService.prototype.parseReverseResult = function (output, cwd = null) {
    const entries = this.parseReverseResults(output, cwd);
    if (!entries.length) {
      return null;
    }
    return entries[0];
  };
};

