const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

class BuildService {
  constructor() {
    this.isBuilding = false;
  }

  async build(rootPath, mainFileName = "main.tex", engine = "lualatex") {
    if (this.isBuilding) {
      return { kind: "busy" };
    }
    this.isBuilding = true;
    try {
      return await this.runBuild(rootPath, mainFileName, engine);
    } finally {
      this.isBuilding = false;
    }
  }

  async runBuild(rootPath, mainFileName, engine) {
    const mainFilePath = path.join(rootPath, mainFileName);
    if (!fs.existsSync(mainFilePath)) {
      const issue = {
        severity: "error",
        message: `${mainFileName} が見つかりません。`,
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    const pdfPath = path.join(
      path.dirname(mainFilePath),
      `${path.basename(mainFileName, path.extname(mainFileName))}.pdf`
    );

    let output = "";
    let status = 1;
    try {
      const result = await this.runLatexmk(rootPath, mainFileName, engine);
      output = result.output;
      status = result.status;
    } catch (_error) {
      const issue = {
        severity: "error",
        message: "ビルドの起動に失敗しました。",
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }

    const issues = this.parseIssues(output, rootPath);
    if (status === 0) {
      return { kind: "success", summary: "ビルド成功", issues, pdfPath, log: output };
    }
    const summary = this.failureSummary(output, issues, mainFileName);
    const fallback = {
      severity: "error",
      message: summary,
      line: null,
    };
    return {
      kind: "failure",
      summary,
      issues: issues.length > 0 ? issues : [fallback],
      log: output,
    };
  }

  async runLatexmk(rootPath, mainFileName, engine) {
    const latexmkPath = this.findLatexmk();
    if (!latexmkPath) {
      throw new Error("latexmk not found");
    }

    let engineFlag = "-lualatex";
    if (engine === "pdflatex") {
      engineFlag = "-pdf";
    } else if (engine === "xelatex") {
      engineFlag = "-xelatex";
    } else if (engine === "uplatex") {
      engineFlag = "-pdfdvi"; // Basic support for uplatex via DVI
    }

    const args = [
      engineFlag,
      "-synctex=1",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-file-line-error",
      mainFileName,
    ];
    const env = { ...process.env };
    env.PATH = this.extendPath(env.PATH);
    const result = await this.runProcess(latexmkPath, args, rootPath, env);
    return result;
  }

  async runProcess(command, args, cwd, env) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { cwd, env });
      let output = "";
      proc.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.on("error", (err) => {
        reject(err);
      });
      proc.on("close", (code) => {
        resolve({ output, status: code ?? 1 });
      });
    });
  }

  extendPath(existingPath) {
    const base = existingPath ?? "";
    const extra = [];
    if (process.platform === "darwin") {
      extra.push("/Library/TeX/texbin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
    } else if (process.platform === "win32") {
      extra.push(
        "C:\\texlive\\2024\\bin\\windows",
        "C:\\texlive\\2023\\bin\\windows",
        "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64",
        "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64"
      );
    }
    const parts = [...extra, base].filter(Boolean);
    return parts.join(path.delimiter);
  }

  findLatexmk() {
    const candidates = [];
    if (process.platform === "darwin") {
      candidates.push(
        "/Library/TeX/texbin/latexmk",
        "/usr/local/bin/latexmk",
        "/opt/homebrew/bin/latexmk",
        "/usr/bin/latexmk"
      );
    } else if (process.platform === "win32") {
      candidates.push(
        "C:\\texlive\\2024\\bin\\windows\\latexmk.exe",
        "C:\\texlive\\2023\\bin\\windows\\latexmk.exe",
        "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\latexmk.exe",
        "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64\\latexmk.exe"
      );
    }
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
    for (const entry of pathEntries) {
      const name = process.platform === "win32" ? "latexmk.exe" : "latexmk";
      candidates.push(path.join(entry, name));
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  parseIssues(output, rootPath) {
    const lines = output.split(/\r?\n/);
    const issues = [];
    for (const line of lines) {
      if (issues.length >= 20) {
        break;
      }
      const location = this.extractIssueLocation(line, rootPath);
      if (line.startsWith("!") || line.includes("LaTeX Error")) {
        const message = line.trim();
        const lineNumber = location?.line ?? this.extractLineNumber(line);
        issues.push({
          severity: "error",
          message,
          line: lineNumber,
          column: location?.column ?? null,
          path: location?.path ?? null,
        });
      } else if (line.includes("Warning")) {
        const message = line.trim();
        const lineNumber = location?.line ?? this.extractLineNumber(line);
        issues.push({
          severity: "warning",
          message,
          line: lineNumber,
          column: location?.column ?? null,
          path: location?.path ?? null,
        });
      }
    }
    return issues;
  }

  extractLineNumber(line) {
    const match = line.match(/(?:l\.|:)(\d+)/);
    if (!match) {
      return null;
    }
    return Number.parseInt(match[1], 10);
  }

  extractIssueLocation(line, rootPath) {
    const match = line.match(/((?:[A-Za-z]:)?[^:\s]+?\.tex):(\d+)(?::(\d+))?/);
    if (!match) {
      return null;
    }
    let filePath = match[1];
    if (filePath.startsWith("./")) {
      filePath = filePath.slice(2);
    }
    if (rootPath && path.isAbsolute(filePath)) {
      filePath = path.relative(rootPath, filePath);
    }
    return {
      path: filePath,
      line: Number.parseInt(match[2], 10),
      column: match[3] ? Number.parseInt(match[3], 10) : null,
    };
  }

  failureSummary(output, issues, mainFileName) {
    const lower = output.toLowerCase();
    if (lower.includes("latexmk") && lower.includes("not found")) {
      return "latexmk が見つかりません。TeX環境を確認してください。";
    }
    if (output.includes(mainFileName) && output.includes("No such file")) {
      return `${mainFileName} が見つかりません。`;
    }
    if (issues[0]) {
      return issues[0].message;
    }
    return "ビルドに失敗しました。Issuesを確認してください。";
  }
}

module.exports = {
  BuildService,
};
