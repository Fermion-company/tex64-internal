const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const isEnvMissingMessage = (message) => {
  if (!message) {
    return false;
  }
  const lower = message.toLowerCase();
  const hasMissing = message.includes("見つかりません") || lower.includes("not found");
  const mentionsTool =
    lower.includes("latexmk") ||
    lower.includes("lualatex") ||
    lower.includes("pdflatex") ||
    lower.includes("xelatex") ||
    lower.includes("uplatex") ||
    message.includes("TeX環境");
  return hasMissing && mentionsTool;
};

const splitArgsString = (input) => {
  if (!input || typeof input !== "string") {
    return [];
  }
  const result = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    result.push(current);
  }
  return result;
};

const pickOutDirFromLatexmkArgs = (args) => {
  if (!Array.isArray(args)) {
    return null;
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== "string") {
      continue;
    }
    if (arg.startsWith("-outdir=")) {
      return arg.slice("-outdir=".length).trim() || null;
    }
    if (arg === "-outdir") {
      const next = typeof args[index + 1] === "string" ? args[index + 1].trim() : "";
      return next || null;
    }
  }
  return null;
};

const normalizeOutDir = (rootPath, outDir) => {
  if (!outDir || typeof outDir !== "string") {
    return null;
  }
  const trimmed = outDir.trim();
  if (!trimmed || trimmed === ".") {
    return null;
  }
  if (path.isAbsolute(trimmed)) {
    return null;
  }
  const resolved = path.resolve(rootPath, trimmed);
  const rootResolved = path.resolve(rootPath);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return null;
  }
  const relative = path.relative(rootResolved, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join(path.sep);
};

class BuildService {
  constructor() {
    this.isBuilding = false;
  }

  async build(rootPath, mainFileName = "main.tex", engine = "lualatex", buildProfile = null) {
    if (this.isBuilding) {
      return { kind: "busy" };
    }
    this.isBuilding = true;
    try {
      return await this.runBuild(rootPath, mainFileName, engine, buildProfile);
    } finally {
      this.isBuilding = false;
    }
  }

  async clean(rootPath, mainFileName = "main.tex", options = {}, buildProfile = null) {
    if (this.isBuilding) {
      return { kind: "busy" };
    }
    this.isBuilding = true;
    try {
      return await this.runClean(rootPath, mainFileName, options, buildProfile);
    } finally {
      this.isBuilding = false;
    }
  }

  async runBuild(rootPath, mainFileName, engine, buildProfile) {
    const mainFilePath = path.join(rootPath, mainFileName);
    if (!fs.existsSync(mainFilePath)) {
      const issue = {
        severity: "error",
        message: `${mainFileName} が見つかりません。`,
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    const { outDir, extraArgs, hasExplicitOutDirArg, outDirRequested } =
      this.resolveLatexmkProfile(rootPath, mainFileName, buildProfile);
    if (outDirRequested && !outDir) {
      const issue = {
        severity: "error",
        message: "outDir が不正です。",
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    const jobName = path.basename(mainFileName, path.extname(mainFileName));
    const pdfBase = `${jobName}.pdf`;
    const fallbackDir = path.dirname(mainFileName ?? "");
    const pdfDir = outDir
      ? path.join(rootPath, outDir)
      : fallbackDir && fallbackDir !== "."
      ? path.join(rootPath, fallbackDir)
      : rootPath;
    const pdfPath = path.join(pdfDir, pdfBase);

    let output = "";
    let status = 1;
    try {
      const result = await this.runLatexmk(rootPath, mainFileName, engine, {
        outDir,
        extraArgs,
        hasExplicitOutDirArg,
      });
      output = result.output;
      status = result.status;
    } catch (error) {
      const message = error?.message ?? String(error);
      if (isEnvMissingMessage(message)) {
        const issue = {
          severity: "error",
          message: "latexmk が見つかりません。TeX環境を確認してください。",
          line: null,
          action: "open-runtime",
        };
        return { kind: "failure", summary: issue.message, issues: [issue] };
      }
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
    if (isEnvMissingMessage(summary)) {
      const fallback = {
        severity: "error",
        message: summary,
        line: null,
        action: "open-runtime",
      };
      return {
        kind: "failure",
        summary,
        issues: [fallback],
        log: output,
      };
    }
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

  async runClean(rootPath, mainFileName, options, buildProfile) {
    const mainFilePath = path.join(rootPath, mainFileName);
    if (!fs.existsSync(mainFilePath)) {
      const issue = {
        severity: "error",
        message: `${mainFileName} が見つかりません。`,
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    const deep = options?.deep === true;
    const { outDir, extraArgs, hasExplicitOutDirArg, outDirRequested } =
      this.resolveLatexmkProfile(rootPath, mainFileName, buildProfile);
    if (outDirRequested && !outDir) {
      const issue = {
        severity: "error",
        message: "outDir が不正です。",
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    let output = "";
    let status = 1;
    try {
      const result = await this.runLatexmkClean(rootPath, mainFileName, {
        deep,
        outDir,
        extraArgs,
        hasExplicitOutDirArg,
      });
      output = result.output;
      status = result.status;
    } catch (error) {
      const message = error?.message ?? String(error);
      if (isEnvMissingMessage(message)) {
        const issue = {
          severity: "error",
          message: "latexmk が見つかりません。TeX環境を確認してください。",
          line: null,
          action: "open-runtime",
        };
        return { kind: "failure", summary: issue.message, issues: [issue] };
      }
      const issue = {
        severity: "error",
        message: "clean の起動に失敗しました。",
        line: null,
      };
      return { kind: "failure", summary: issue.message, issues: [issue] };
    }
    if (status === 0) {
      return {
        kind: "success",
        summary: deep ? "clean（全削除）完了" : "clean 完了",
        issues: [],
        log: output,
      };
    }
    const summary = "clean に失敗しました。";
    return {
      kind: "failure",
      summary,
      issues: [
        {
          severity: "error",
          message: summary,
          line: null,
        },
      ],
      log: output,
    };
  }

  resolveLatexmkProfile(rootPath, mainFileName, buildProfile) {
    const rawExtra = typeof buildProfile?.extraArgs === "string" ? buildProfile.extraArgs : "";
    const extraArgs = splitArgsString(rawExtra);
    const outDirFromArgs = pickOutDirFromLatexmkArgs(extraArgs);
    const rawOutDir =
      typeof buildProfile?.outDir === "string" ? buildProfile.outDir.trim() : "";
    const derivedOutDir = path.dirname(mainFileName ?? "");
    const outDirCandidate =
      outDirFromArgs || rawOutDir || (derivedOutDir && derivedOutDir !== "." ? derivedOutDir : "");
    const outDir = normalizeOutDir(rootPath, outDirCandidate);
    const outDirRequested = Boolean(outDirFromArgs || rawOutDir);
    return {
      outDir,
      extraArgs,
      hasExplicitOutDirArg: Boolean(outDirFromArgs),
      outDirRequested,
    };
  }

  async runLatexmk(rootPath, mainFileName, engine, options = {}) {
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

    const args = [];
    args.push("-g");
    const outDir =
      typeof options?.outDir === "string" && options.outDir.trim()
        ? options.outDir.trim()
        : null;
    const hasExplicitOutDirArg = options?.hasExplicitOutDirArg === true;
    if (!hasExplicitOutDirArg && outDir) {
      args.push(`-outdir=${outDir}`);
    }
    args.push(
      engineFlag,
      "-synctex=1",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-file-line-error",
      ...(Array.isArray(options?.extraArgs) ? options.extraArgs : []),
      mainFileName
    );
    const env = { ...process.env };
    env.PATH = this.extendPath(env.PATH);
    const result = await this.runProcess(latexmkPath, args, rootPath, env);
    return result;
  }

  async runLatexmkClean(rootPath, mainFileName, options = {}) {
    const latexmkPath = this.findLatexmk();
    if (!latexmkPath) {
      throw new Error("latexmk not found");
    }
    const args = [];
    args.push(options.deep === true ? "-C" : "-c");
    const outDir =
      typeof options?.outDir === "string" && options.outDir.trim()
        ? options.outDir.trim()
        : null;
    const hasExplicitOutDirArg = options?.hasExplicitOutDirArg === true;
    if (!hasExplicitOutDirArg && outDir) {
      args.push(`-outdir=${outDir}`);
    }
    args.push(...(Array.isArray(options?.extraArgs) ? options.extraArgs : []), mainFileName);
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
