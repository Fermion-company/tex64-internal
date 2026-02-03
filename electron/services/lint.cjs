const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const isEnvMissingMessage = (message) => {
  if (!message) {
    return false;
  }
  const lower = message.toLowerCase();
  const hasMissing = message.includes("見つかりません") || lower.includes("not found");
  const mentionsTool = lower.includes("chktex");
  return hasMissing && mentionsTool;
};

class LintService {
  constructor() {
    this.isRunning = false;
  }

  async lint(rootPath, mainFileName = "main.tex") {
    if (this.isRunning) {
      return { kind: "busy" };
    }
    this.isRunning = true;
    try {
      return await this.runChktex(rootPath, mainFileName);
    } finally {
      this.isRunning = false;
    }
  }

  async runChktex(rootPath, mainFileName) {
    const mainFilePath = path.join(rootPath, mainFileName);
    if (!fs.existsSync(mainFilePath)) {
      const issue = {
        severity: "error",
        message: `${mainFileName} が見つかりません。`,
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    const chktexPath = this.findChktex();
    if (!chktexPath) {
      const issue = {
        severity: "error",
        message: "chktex が見つかりません。TeX環境を確認してください。",
        line: null,
        action: "open-runtime",
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }

    const args = ["-q", "-v3", mainFileName];
    const env = { ...process.env };
    env.PATH = this.extendPath(env.PATH);

    let output = "";
    let status = 0;
    try {
      const result = await this.runProcess(chktexPath, args, rootPath, env);
      output = result.output;
      status = result.status;
    } catch (error) {
      const message = error?.message ?? String(error);
      if (isEnvMissingMessage(message)) {
        const issue = {
          severity: "error",
          message: "chktex が見つかりません。TeX環境を確認してください。",
          line: null,
          action: "open-runtime",
        };
        return { kind: "failure", summary: issue.message, issues: [issue] };
      }
      const issue = {
        severity: "error",
        message: "lint の起動に失敗しました。",
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue], log: output };
    }

    const issues = this.parseChktexOutput(output, rootPath);
    const count = issues.length;
    const summary =
      count > 0 ? `Lint: ${count}件（ChkTeX）` : status === 0 ? "Lint 完了" : "Lint 完了（警告あり）";
    return { kind: "success", summary, issues, log: output };
  }

  parseChktexOutput(output, rootPath) {
    if (!output) {
      return [];
    }
    const issues = [];
    const lines = output.split(/\r?\n/);
    const lineRegex = /^"(.+?)",\s*line\s*(\d+):\s*(.+)$/;
    for (const line of lines) {
      if (!line || issues.length >= 80) {
        continue;
      }
      if (line.startsWith("chktex:")) {
        continue;
      }
      const match = line.match(lineRegex);
      if (!match) {
        continue;
      }
      let filePath = (match[1] ?? "").trim();
      const lineNumber = Number.parseInt(match[2] ?? "", 10);
      const message = (match[3] ?? "").trim();
      if (!filePath || !Number.isFinite(lineNumber) || lineNumber < 1 || !message) {
        continue;
      }
      if (filePath.startsWith("./")) {
        filePath = filePath.slice(2);
      }
      if (rootPath && path.isAbsolute(filePath)) {
        const relative = path.relative(rootPath, filePath);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
          continue;
        }
        filePath = relative;
      }
      filePath = filePath.split(path.sep).join("/");
      issues.push({
        severity: "warning",
        message,
        line: lineNumber,
        column: null,
        path: filePath,
      });
    }
    return issues;
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
        resolve({ output, status: code ?? 0 });
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

  findChktex() {
    const candidates = [];
    if (process.platform === "darwin") {
      candidates.push(
        "/Library/TeX/texbin/chktex",
        "/usr/local/bin/chktex",
        "/opt/homebrew/bin/chktex",
        "/usr/bin/chktex"
      );
    } else if (process.platform === "win32") {
      candidates.push(
        "C:\\texlive\\2024\\bin\\windows\\chktex.exe",
        "C:\\texlive\\2023\\bin\\windows\\chktex.exe",
        "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\chktex.exe",
        "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64\\chktex.exe"
      );
    }
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
    for (const entry of pathEntries) {
      const name = process.platform === "win32" ? "chktex.exe" : "chktex";
      candidates.push(path.join(entry, name));
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }
}

module.exports = { LintService };
