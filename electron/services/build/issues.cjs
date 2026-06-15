const path = require("path");

module.exports = (BuildService) => {
  BuildService.prototype.parseIssues = function (output, rootPath) {
    const lines = output.split(/\r?\n/);
    const parsed = [];
    const seen = new Set();
    const maxIssues = 20;
    let activeTexPath = null;
    const pushIssue = (issue) => {
      const token =
        issue.code === "missing-glyph"
          ? `${issue.code}|${issue.path ?? ""}|${issue.codePoint ?? ""}`
          : `${issue.severity}|${issue.path ?? ""}|${issue.line ?? ""}|${
              issue.column ?? ""
            }|${issue.message}`;
      if (seen.has(token)) {
        return;
      }
      seen.add(token);
      parsed.push(issue);
    };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const contextPath = this.extractContextTexPath(line, rootPath);
      if (contextPath) {
        activeTexPath = contextPath;
      }
      const missingGlyphIssues = this.extractMissingGlyphIssues(line, activeTexPath);
      if (missingGlyphIssues.length > 0) {
        for (const issue of missingGlyphIssues) {
          pushIssue(issue);
        }
        continue;
      }
      const severity = this.extractIssueSeverity(line);
      if (!severity) {
        continue;
      }
      const wrappedLineNumber = this.extractWrappedLineNumber(lines, index, line);
      const message = this.composeIssueMessage(line, wrappedLineNumber);
      const location = this.extractIssueLocation(line, rootPath);
      const shouldSearchNearby = severity === "error";
      const nearbyLocation = shouldSearchNearby ? this.extractNearbyIssueLocation(lines, index, rootPath) : null;
      const directLineNumber = this.extractLineNumber(line);
      const lineNumber =
        location?.line ?? directLineNumber ?? wrappedLineNumber ?? nearbyLocation?.line ?? null;
      const issue = {
        severity,
        message,
        line: lineNumber,
        column: location?.column ?? nearbyLocation?.column ?? null,
        path: location?.path ?? activeTexPath ?? nearbyLocation?.path ?? null,
      };
      pushIssue(issue);
    }
    const errors = parsed.filter((issue) => issue.severity === "error");
    const warnings = parsed.filter((issue) => issue.severity === "warning");
    return errors.concat(warnings).slice(0, maxIssues);
  };

  BuildService.prototype.extractMissingGlyphIssues = function (line, activeTexPath = null) {
    if (typeof line !== "string" || !line.includes("Missing character:")) {
      return [];
    }
    const issues = [];
    const regex =
      /Missing character:\s*There is no\s+(.+?)\s+\(U\+([0-9A-Fa-f]{4,6})\)\s+in font\s+([^!\r\n]*?)(?:!|$)/g;
    let match = null;
    while ((match = regex.exec(line)) !== null) {
      const rawCharacter = String(match[1] ?? "").trim();
      const codePoint = `U+${String(match[2] ?? "").toUpperCase()}`;
      const font = String(match[3] ?? "").trim().replace(/[;:]+$/, "");
      const character = rawCharacter || codePoint;
      const fontPart = font ? `現在のフォント ${font} にこのグリフがありません。` : "";
      issues.push({
        severity: "error",
        code: "missing-glyph",
        character,
        codePoint,
        font: font || null,
        line: null,
        column: null,
        path: activeTexPath ?? null,
        message:
          `PDFで表示できない文字があります: ${character} (${codePoint})。` +
          `${fontPart}` +
          "Unicode 対応の文書クラス/パッケージ（日本語: ltjsarticle または luatexja、中国語: ctex、韓国語: kotex、その他: fontspec + 対応フォント）を使ってください。",
      });
    }
    return issues;
  };

  BuildService.prototype.findMissingGlyphIssues = function (issues) {
    if (!Array.isArray(issues)) {
      return [];
    }
    return issues.filter((issue) => issue?.code === "missing-glyph");
  };

  BuildService.prototype.extractIssueSeverity = function (line) {
    const text = typeof line === "string" ? line.trim() : "";
    if (!text) {
      return null;
    }
    const lower = text.toLowerCase();
    if (
      text.startsWith("!") ||
      /^\S+\s+error:/i.test(text) ||
      /^package\s+.+\s+error:/i.test(text) ||
      /^class\s+.+\s+error:/i.test(text) ||
      lower.includes("latex error") ||
      lower.includes("undefined control sequence") ||
      lower.includes("emergency stop") ||
      lower.includes("fatal error occurred") ||
      lower.includes("missing $ inserted")
    ) {
      return "error";
    }
    if (
      lower.includes(" warning") ||
      lower.startsWith("warning:") ||
      lower.startsWith("overfull \\hbox") ||
      lower.startsWith("underfull \\hbox")
    ) {
      return "warning";
    }
    return null;
  };

  BuildService.prototype.isXypdfPdftexRequirementError = function (output) {
    if (typeof output !== "string" || !output.trim()) {
      return false;
    }
    const lower = output.toLowerCase();
    if (!lower.includes("xypdf error")) {
      return false;
    }
    return lower.includes("pdftex version") || lower.includes("pdf output");
  };

  BuildService.prototype.extractLineNumber = function (line) {
    if (typeof line !== "string") {
      return null;
    }
    const directLineMatch = line.match(/\bl\.(\d+)\b/);
    if (directLineMatch) {
      return Number.parseInt(directLineMatch[1], 10);
    }
    const inputLineMatch = line.match(/\bon input line\s+(\d+)\b/i);
    if (inputLineMatch) {
      return Number.parseInt(inputLineMatch[1], 10);
    }
    const paragraphLineMatch = line.match(/\bat lines?\s+(\d+)(?:--\d+)?\b/i);
    if (paragraphLineMatch) {
      return Number.parseInt(paragraphLineMatch[1], 10);
    }
    const fileLineMatch = line.match(/\.tex:(\d+)(?::\d+)?(?::|\s|$)/i);
    if (fileLineMatch) {
      return Number.parseInt(fileLineMatch[1], 10);
    }
    return null;
  };

  BuildService.prototype.extractWrappedLineNumber = function (lines, index, line) {
    if (!Array.isArray(lines) || typeof line !== "string") {
      return null;
    }
    const trimmed = line.trim();
    const endsWithInputLine = /\bon input line\s*$/i.test(trimmed);
    const endsWithAtLines = /\bat lines?\s*$/i.test(trimmed);
    if (!endsWithInputLine && !endsWithAtLines) {
      return null;
    }
    for (let offset = 1; offset <= 2; offset += 1) {
      const nextLine = lines[index + offset];
      if (typeof nextLine !== "string") {
        break;
      }
      const nextTrimmed = nextLine.trim();
      const match = nextTrimmed.match(/^(\d+)(?:\.)?$/);
      if (match) {
        return Number.parseInt(match[1], 10);
      }
      if (nextTrimmed.length > 0) {
        break;
      }
    }
    return null;
  };

  BuildService.prototype.composeIssueMessage = function (line, wrappedLineNumber) {
    const message = typeof line === "string" ? line.trim() : "";
    if (!message || !Number.isFinite(wrappedLineNumber)) {
      return message;
    }
    if (/\bon input line\s*$/i.test(message)) {
      return `${message} ${wrappedLineNumber}.`;
    }
    if (/\bat lines?\s*$/i.test(message)) {
      return `${message} ${wrappedLineNumber}`;
    }
    return message;
  };

  BuildService.prototype.normalizeIssuePath = function (filePath, rootPath) {
    if (!filePath || typeof filePath !== "string") {
      return null;
    }
    let normalized = filePath.trim();
    if (!normalized) {
      return null;
    }
    normalized = normalized
      .replace(/^\(+/, "")
      .replace(/\)+$/, "")
      .replace(/^\.([\\/])/, "");
    if (rootPath && path.isAbsolute(normalized)) {
      normalized = path.relative(rootPath, normalized);
    }
    if (!normalized || normalized === ".") {
      return null;
    }
    return normalized;
  };

  BuildService.prototype.extractIssueLocation = function (line, rootPath) {
    if (typeof line !== "string") {
      return null;
    }
    const match = line.match(
      /((?:[A-Za-z]:)?[^:\r\n]+?\.tex):(\d+)(?::(\d+))?(?::|\s|$)/i
    );
    if (!match) {
      return null;
    }
    const filePath = this.normalizeIssuePath(match[1], rootPath);
    if (!filePath) {
      return null;
    }
    return {
      path: filePath,
      line: Number.parseInt(match[2], 10),
      column: match[3] ? Number.parseInt(match[3], 10) : null,
    };
  };

  BuildService.prototype.extractContextTexPath = function (line, rootPath) {
    if (typeof line !== "string") {
      return null;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }
    const starMatch = trimmed.match(/^\*\*([^\r\n]+?\.tex)\s*$/i);
    if (starMatch) {
      return this.normalizeIssuePath(starMatch[1], rootPath);
    }
    const openMatch = trimmed.match(/^\(([^()\r\n]+?\.tex)\b/i);
    if (openMatch) {
      return this.normalizeIssuePath(openMatch[1], rootPath);
    }
    return null;
  };

  BuildService.prototype.extractNearbyIssueLocation = function (lines, index, rootPath) {
    if (!Array.isArray(lines)) {
      return null;
    }
    const maxOffset = 12;
    let nearbyLine = null;
    let nearbyPath = null;
    for (let offset = 1; offset <= maxOffset; offset += 1) {
      const nextLine = lines[index + offset];
      if (typeof nextLine !== "string") {
        break;
      }
      const location = this.extractIssueLocation(nextLine, rootPath);
      if (location) {
        return location;
      }
      if (nearbyLine === null) {
        const directLineMatch = nextLine.match(/\bl\.(\d+)\b/);
        if (directLineMatch) {
          nearbyLine = Number.parseInt(directLineMatch[1], 10);
        }
      }
      if (!nearbyPath) {
        nearbyPath = this.extractContextTexPath(nextLine, rootPath);
      }
    }
    if (nearbyLine === null && !nearbyPath) {
      return null;
    }
    return { path: nearbyPath ?? null, line: nearbyLine, column: null };
  };

  BuildService.prototype.failureSummary = function (output, issues, mainFileName) {
    const lower = output.toLowerCase();
    const latexmkMissing =
      lower.includes("latexmk: command not found") ||
      lower.includes("/latexmk: not found") ||
      lower.includes("spawn latexmk enoent") ||
      lower.includes("'latexmk' is not recognized") ||
      lower.includes('"latexmk" is not recognized');
    if (latexmkMissing) {
      return "latexmk がnot found。TeX environmentを確認してください。";
    }
    if (output.includes(mainFileName) && output.includes("No such file")) {
      return `${mainFileName} がnot found。`;
    }
    const firstError = issues.find((issue) => issue.severity === "error");
    if (firstError) {
      return firstError.message;
    }
    if (issues[0]) {
      return issues[0].message;
    }
    return "build failed。Issuesを確認してください。";
  };
};
