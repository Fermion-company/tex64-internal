const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const ensureDirectory = async (dirPath) => {
  await fsp.mkdir(dirPath, { recursive: true });
};

const safeUnlink = async (filePath) => {
  if (!filePath) {
    return;
  }
  await fsp.unlink(filePath).catch(() => null);
};

const INDENT_UNIT = "  ";
const VERBATIM_ENVIRONMENTS = new Set([
  "verbatim",
  "verbatim*",
  "Verbatim",
  "lstlisting",
  "minted",
  "filecontents",
  "filecontents*",
]);

const stripComments = (line) => {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "%") {
      continue;
    }
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) {
      return line.slice(0, i);
    }
  }
  return line;
};

const extractTokens = (line) => {
  const tokens = [];
  const regex = /\\(begin|end)\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(line))) {
    tokens.push({
      type: match[1],
      env: match[2]?.trim() ?? "",
      index: match.index,
    });
  }
  return tokens;
};

const simpleIndent = (content) => {
  if (!content) {
    return content ?? "";
  }
  const endsWithNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  const output = [];
  let indentLevel = 0;
  let inVerbatim = false;
  let verbatimEnv = null;

  for (const line of lines) {
    if (inVerbatim) {
      output.push(line);
      const parsed = stripComments(line);
      const tokens = extractTokens(parsed);
      if (verbatimEnv) {
        const hasEnd = tokens.some(
          (token) => token.type === "end" && token.env === verbatimEnv
        );
        if (hasEnd) {
          inVerbatim = false;
          verbatimEnv = null;
          indentLevel = Math.max(indentLevel - 1, 0);
        }
      }
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      output.push("");
      continue;
    }

    const parsed = stripComments(line);
    const tokens = extractTokens(parsed);

    let scan = parsed.replace(/^\s+/, "");
    let dedentBefore = 0;
    const endPattern = /^\\end\{([^}]+)\}/;
    while (endPattern.test(scan)) {
      dedentBefore += 1;
      scan = scan.replace(endPattern, "").replace(/^\s+/, "");
    }
    indentLevel = Math.max(indentLevel - dedentBefore, 0);

    const trimmedLeading = line.replace(/^\s+/, "");
    output.push(`${INDENT_UNIT.repeat(indentLevel)}${trimmedLeading}`);

    let beginCount = 0;
    let endCount = 0;
    tokens.forEach((token) => {
      if (token.type === "begin") {
        beginCount += 1;
      } else {
        endCount += 1;
      }
    });
    const endAfter = Math.max(endCount - dedentBefore, 0);
    indentLevel = Math.max(indentLevel + beginCount - endAfter, 0);

    for (const token of tokens) {
      if (token.type !== "begin") {
        continue;
      }
      if (!VERBATIM_ENVIRONMENTS.has(token.env)) {
        continue;
      }
      const hasEndSameLine = tokens.some(
        (entry) => entry.type === "end" && entry.env === token.env && entry.index > token.index
      );
      if (!hasEndSameLine) {
        inVerbatim = true;
        verbatimEnv = token.env;
        break;
      }
    }
  }

  const formatted = output.join("\n");
  return endsWithNewline ? `${formatted}\n` : formatted;
};

class FormatterService {
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

  findLatexindent() {
    const candidates = [];
    if (process.platform === "darwin") {
      candidates.push(
        "/Library/TeX/texbin/latexindent",
        "/usr/local/bin/latexindent",
        "/opt/homebrew/bin/latexindent",
        "/usr/bin/latexindent"
      );
    } else if (process.platform === "win32") {
      candidates.push(
        "C:\\texlive\\2024\\bin\\windows\\latexindent.exe",
        "C:\\texlive\\2023\\bin\\windows\\latexindent.exe",
        "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\latexindent.exe",
        "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64\\latexindent.exe"
      );
    }
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
    pathEntries.forEach((entry) => {
      if (!entry) {
        return;
      }
      candidates.push(path.join(entry, process.platform === "win32" ? "latexindent.exe" : "latexindent"));
    });
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  runProcess(command, args, cwd, env) {
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

  async formatContent(rootPath, relativePath, content) {
    if (!rootPath || !relativePath) {
      return { ok: false, error: "format target missing" };
    }
    if (path.extname(relativePath).toLowerCase() !== ".tex") {
      return { ok: true, content, skipped: true };
    }
    const latexindentPath = this.findLatexindent();
    if (latexindentPath) {
      const tempDir = path.join(rootPath, ".tex180", ".format");
      await ensureDirectory(tempDir);
      const baseName = path.basename(relativePath, path.extname(relativePath)) || "document";
      const tempName = `${baseName}-${Date.now()}-${Math.random().toString(16).slice(2)}.tex`;
      const tempPath = path.join(tempDir, tempName);
      await fsp.writeFile(tempPath, content ?? "", "utf8");
      const env = { ...process.env };
      env.PATH = this.extendPath(env.PATH);
      const result = await this.runProcess(latexindentPath, ["-w", "-l", tempPath], rootPath, env)
        .catch((error) => ({ output: error?.message ?? String(error), status: 1 }));
      let formatted = null;
      if (result.status === 0) {
        formatted = await fsp.readFile(tempPath, "utf8").catch(() => null);
      }
      await safeUnlink(tempPath);
      await safeUnlink(`${tempPath}.bak`);
      await safeUnlink(path.join(tempDir, "indent.log"));
      await safeUnlink(path.join(rootPath, "indent.log"));
      if (result.status === 0 && formatted !== null) {
        return { ok: true, content: formatted, formatted: formatted !== content };
      }
    }
    const fallback = simpleIndent(content ?? "");
    return { ok: true, content: fallback, formatted: fallback !== content, fallback: true };
  }

  async formatFile(rootPath, relativePath) {
    if (!rootPath || !relativePath) {
      return { ok: false, error: "format target missing" };
    }
    const absPath = path.join(rootPath, relativePath);
    const content = await fsp.readFile(absPath, "utf8");
    const result = await this.formatContent(rootPath, relativePath, content);
    if (result.ok && typeof result.content === "string" && result.content !== content) {
      await fsp.writeFile(absPath, result.content, "utf8");
    }
    return result;
  }
}

module.exports = FormatterService;
