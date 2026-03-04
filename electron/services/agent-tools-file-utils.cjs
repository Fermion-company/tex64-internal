const path = require("path");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { normalizeRelativePath } = require("./workspace.cjs");
const { isBlockedPath, normalizePath } = require("./agent-policy.cjs");

const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_TIMEOUT_MS = 60 * 1000;
const BASE64_DATA_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHELL_OPERATOR_PATTERN = /[;&|><`]/;
const SUBSHELL_PATTERN = /\$\(/;
const ALLOWED_RUN_COMMANDS = new Set([
  "biber",
  "bibtex",
  "cat",
  "echo",
  "find",
  "grep",
  "head",
  "kpsewhich",
  "latexmk",
  "ls",
  "lualatex",
  "pdflatex",
  "printf",
  "pwd",
  "rg",
  "tail",
  "texcount",
  "uplatex",
  "wc",
  "which",
  "xelatex",
]);

const readFileFromDisk = async (resolvedPath, { forceBase64 = false } = {}) => {
  const buffer = await fsp.readFile(resolvedPath);
  const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (forceBase64) {
    return {
      content: buffer.toString("base64"),
      encoding: "base64",
      binary: true,
      size: buffer.length,
      contentHash,
    };
  }
  if (buffer.length === 0) {
    return { content: "", encoding: "utf8", binary: false, size: 0, contentHash };
  }
  const hasNullByte = buffer.includes(0);
  if (hasNullByte) {
    return {
      content: buffer.toString("base64"),
      encoding: "base64",
      binary: true,
      size: buffer.length,
      contentHash,
    };
  }
  return {
    content: buffer.toString("utf8"),
    encoding: "utf8",
    binary: false,
    size: buffer.length,
    contentHash,
  };
};

const hashUtf8Text = (value) =>
  crypto.createHash("sha256").update(Buffer.from(value ?? "", "utf8")).digest("hex");

const normalizeBase64Data = (value) => (typeof value === "string" ? value.replace(/\s+/g, "") : "");

const decodeBase64Strict = (value) => {
  const normalized = normalizeBase64Data(value);
  if (normalized.length % 4 !== 0) {
    return null;
  }
  if (!BASE64_DATA_PATTERN.test(normalized)) {
    return null;
  }
  const buffer = Buffer.from(normalized, "base64");
  const noPadNormalized = normalized.replace(/=+$/g, "");
  const noPadEncoded = buffer.toString("base64").replace(/=+$/g, "");
  if (noPadNormalized !== noPadEncoded) {
    return null;
  }
  return { normalized, buffer };
};

const parseCommandLine = (command) => {
  if (SHELL_OPERATOR_PATTERN.test(command) || SUBSHELL_PATTERN.test(command)) {
    return { error: "シェル演算子（`|`, `;`, `>`, `&` など）は使用できません。" };
  }
  if (/[\r\n]/.test(command)) {
    return { error: "改行を含む command は使用できません。" };
  }
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const char of command) {
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
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) {
    return { error: "command の末尾エスケープが不正です。" };
  }
  if (quote) {
    return { error: "command の引用符が閉じていません。" };
  }
  if (current) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    return { error: "command が空です。" };
  }
  return {
    executable: tokens[0],
    args: tokens.slice(1),
  };
};

const runShellCommand = (
  executable,
  args,
  { cwd, env, timeoutMs, maxOutputBytes = DEFAULT_MAX_COMMAND_OUTPUT_BYTES } = {}
) =>
  new Promise((resolve) => {
    const outputLimit =
      Number.isFinite(maxOutputBytes) && maxOutputBytes > 0
        ? maxOutputBytes
        : Number.POSITIVE_INFINITY;
    const sanitizedEnv = {};
    if (env && typeof env === "object") {
      Object.entries(env).forEach(([key, value]) => {
        if (typeof value === "string") {
          sanitizedEnv[key] = value;
        }
      });
    }
    const proc = spawn(executable, Array.isArray(args) ? args : [], {
      cwd,
      env: { ...process.env, ...sanitizedEnv },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let totalBytes = 0;
    let timedOut = false;

    const appendChunk = (target, chunk) => {
      if (!chunk) {
        return target;
      }
      const text = chunk.toString("utf8");
      if (!Number.isFinite(outputLimit)) {
        totalBytes += Buffer.byteLength(text);
        return target + text;
      }
      const remaining = outputLimit - totalBytes;
      if (remaining <= 0) {
        truncated = true;
        return target;
      }
      const buffer = Buffer.from(text, "utf8");
      if (buffer.length <= remaining) {
        totalBytes += buffer.length;
        return target + text;
      }
      truncated = true;
      totalBytes += remaining;
      return target + buffer.slice(0, remaining).toString("utf8");
    };

    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            proc.kill("SIGKILL");
          }, timeoutMs)
        : null;

    proc.stdout?.on("data", (chunk) => {
      stdout = appendChunk(stdout, chunk);
    });
    proc.stderr?.on("data", (chunk) => {
      stderr = appendChunk(stderr, chunk);
    });
    proc.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr || error?.message || "command error",
        truncated,
        timedOut,
      });
    });
    proc.on("close", (code, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        truncated,
        timedOut,
      });
    });
  });

const replaceOnceWithCount = (text, search, replace) => {
  const index = text.indexOf(search);
  if (index === -1) {
    return { text, count: 0 };
  }
  return {
    text: text.slice(0, index) + replace + text.slice(index + search.length),
    count: 1,
  };
};

const replaceAllWithCount = (text, search, replace) => {
  let index = text.indexOf(search);
  if (index === -1) {
    return { text, count: 0 };
  }
  let result = "";
  let lastIndex = 0;
  let count = 0;
  while (index !== -1) {
    result += text.slice(lastIndex, index) + replace;
    lastIndex = index + search.length;
    count += 1;
    index = text.indexOf(search, lastIndex);
  }
  result += text.slice(lastIndex);
  return { text: result, count };
};

const handleListFiles = async (service, args, policy) => {
  const directory = normalizePath(args.directory);
  const rootPath = service.workspace.getRootPath();
  if (!rootPath) {
    return { error: "ワークスペースが選択されていません。" };
  }
  if (directory && isBlockedPath(directory, policy)) {
    return { error: "対象パスは読み取り禁止です。" };
  }
  let basePath = "";
  try {
    basePath = service.workspace.resolvePath(directory);
  } catch {
    return { error: "ディレクトリが見つかりません。" };
  }
  const baseStat = await fsp.stat(basePath).catch(() => null);
  if (!baseStat || !baseStat.isDirectory()) {
    return { error: "ディレクトリが見つかりません。" };
  }
  const results = [];
  const maxEntries = 5000;
  let count = 0;
  const walk = async (dirPath) => {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (count >= maxEntries) {
        return;
      }
      const absPath = path.join(dirPath, entry.name);
      const relPath = normalizeRelativePath(path.relative(rootPath, absPath));
      if (isBlockedPath(relPath, policy)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      results.push(relPath);
      count += 1;
    }
  };
  await walk(basePath);
  return { files: results.sort((a, b) => a.localeCompare(b, "ja")) };
};

const handleRunCommand = async (service, args) => {
  if (service?.agentOptions?.allowRunCommand !== true) {
    return {
      error:
        "run_command は現在無効です。必要な場合は agent settings の allowRunCommand を有効にしてください。",
    };
  }
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) {
    return { error: "command が空です。" };
  }
  const rootPath = service.workspace.getRootPath();
  if (!rootPath) {
    return { error: "ワークスペースが選択されていません。" };
  }
  let cwd = rootPath;
  if (typeof args.cwd === "string" && args.cwd.trim()) {
    try {
      cwd = service.workspace.resolvePath(normalizePath(args.cwd));
    } catch {
      return { error: "cwd が不正です。" };
    }
  }
  const timeoutMs =
    Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? Math.min(args.timeoutMs, MAX_COMMAND_TIMEOUT_MS)
      : null;
  const maxOutputBytes = Number.isFinite(args.maxOutputBytes)
    ? args.maxOutputBytes
    : DEFAULT_MAX_COMMAND_OUTPUT_BYTES;
  const shellExecutable =
    typeof process.env.SHELL === "string" && process.env.SHELL.trim()
      ? process.env.SHELL.trim()
      : "/bin/zsh";
  const result = await runShellCommand(shellExecutable, ["-lc", command], {
    cwd,
    env: args.env,
    timeoutMs,
    maxOutputBytes,
  });
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    timedOut: result.timedOut,
  };
};

module.exports = {
  ALLOWED_RUN_COMMANDS,
  MAX_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
  readFileFromDisk,
  hashUtf8Text,
  decodeBase64Strict,
  parseCommandLine,
  runShellCommand,
  replaceOnceWithCount,
  replaceAllWithCount,
  handleListFiles,
  handleRunCommand,
};
