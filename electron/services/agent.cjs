const path = require("path");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { normalizeRelativePath } = require("./workspace.cjs");
const { AGENT_TOOL_DECLARATIONS } = require("./agent-tools.cjs");
const { requestGemini } = require("./agent-llm.cjs");

const DEFAULT_MAX_FILE_BYTES = Number.POSITIVE_INFINITY;
const DEFAULT_MAX_READ_FILES = Number.POSITIVE_INFINITY;
const DEFAULT_MAX_ITERATIONS = 12;
const DEFAULT_TEXT_EXTENSIONS = null;
const DEFAULT_BLOCKED_TOP_LEVEL = new Set();
const ALWAYS_IGNORED_DIRECTORIES = new Set();
const DEFAULT_LATEX_SYMBOL_EXTENSIONS = new Set([
  "tex",
  "bib",
  "sty",
  "cls",
  "ltx",
  "dtx",
]);
const LATEX_REF_COMMANDS = [
  "ref",
  "eqref",
  "pageref",
  "autoref",
  "cref",
  "Cref",
  "namecref",
  "labelcref",
  "cpageref",
  "Cpageref",
];
const LATEX_REF_RANGE_COMMANDS = [
  "crefrange",
  "Crefrange",
  "cpagerefrange",
  "Cpagerefrange",
];
const LATEX_CITE_COMMANDS = [
  "cite",
  "citet",
  "citep",
  "citealp",
  "citeauthor",
  "citeyear",
  "citeyearpar",
  "Cite",
  "Citet",
  "Citep",
  "Citealp",
  "Citeauthor",
  "Citeyear",
  "Citeyearpar",
  "nocite",
  "parencite",
  "Parencite",
  "textcite",
  "Textcite",
  "footcite",
  "Footcite",
  "autocite",
  "Autocite",
  "smartcite",
  "Smartcite",
  "supercite",
  "Supercite",
  "cites",
  "Cites",
  "parencites",
  "Parencites",
  "textcites",
  "Textcites",
];
const MAX_SEARCH_RESULTS = 200;
const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const TOOL_STATUS_LABELS = {
  list_files: "構成把握中",
  get_project_structure: "構成把握中",
  get_index: "構造解析中",
  read_file: "ファイル確認中",
  read_files: "ファイル確認中",
  search_files: "検索中",
  run_build: "ビルド検証中",
  run_command: "コマンド実行中",
  rename_latex_symbol: "シンボルリネーム中",
  get_app_settings: "設定取得中",
  set_app_settings: "設定更新中",
  propose_write: "変更案作成中",
  propose_patch: "変更案作成中",
  propose_delete: "変更案作成中",
  propose_rename: "変更案作成中",
  propose_create_directory: "変更案作成中",
};

const normalizePath = (value) => normalizeRelativePath((value ?? "").trim());

const normalizeStringList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const normalizeExtensionList = (value) => {
  const entries = normalizeStringList(value);
  const result = new Set();
  entries.forEach((entry) => {
    const clean = entry.toLowerCase().replace(/^\./, "");
    if (clean) {
      result.add(clean);
    }
  });
  return result;
};

const normalizeTopLevelList = (value) => {
  const entries = normalizeStringList(value);
  const result = new Set();
  entries.forEach((entry) => {
    const normalized = normalizePath(entry);
    const top = normalized.split("/")[0];
    if (top) {
      result.add(top);
    }
  });
  return result;
};

const clampNumber = (value, fallback, { min, max }) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
};

const normalizeLimit = (value, fallback) => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return parsed;
};

const normalizeEncoding = (value) => {
  if (typeof value === "string" && value.toLowerCase() === "base64") {
    return "base64";
  }
  return "utf8";
};

const wantsBase64 = (args) =>
  args?.binary === true || normalizeEncoding(args?.encoding) === "base64";

const buildAgentPolicy = (settings = {}) => {
  const maxFileBytes = normalizeLimit(settings.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const maxReadFiles = Math.round(
    normalizeLimit(settings.maxReadFiles, DEFAULT_MAX_READ_FILES)
  );
  let textExtensions = DEFAULT_TEXT_EXTENSIONS
    ? new Set(DEFAULT_TEXT_EXTENSIONS)
    : null;
  const overrideExtensions = normalizeExtensionList(settings.textExtensions);
  if (overrideExtensions.size > 0) {
    textExtensions = overrideExtensions;
  }
  const extraExtensions = normalizeExtensionList(settings.extraTextExtensions);
  if (textExtensions) {
    extraExtensions.forEach((entry) => textExtensions.add(entry));
  }
  let blockedTopLevel = new Set(DEFAULT_BLOCKED_TOP_LEVEL);
  const blockedOverride = normalizeTopLevelList(settings.blockedTopLevel);
  if (blockedOverride.size > 0) {
    blockedTopLevel = blockedOverride;
  }
  const allowedTopLevel = normalizeTopLevelList(settings.allowedTopLevel);
  return {
    maxFileBytes,
    maxReadFiles,
    textExtensions,
    blockedTopLevel,
    allowedTopLevel,
  };
};

const formatByteLimit = (bytes) => {
  if (!Number.isFinite(bytes)) {
    return "無制限";
  }
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb % 1 === 0 ? mb.toFixed(0) : mb.toFixed(1)}MB`;
  }
  return `${Math.round(bytes / 1024)}KB`;
};

const isPathAllowed = (relativePath, policy) => {
  const normalized = normalizePath(relativePath);
  if (!normalized) {
    return false;
  }
  const top = normalized.split("/")[0];
  if (policy?.allowedTopLevel?.has(top)) {
    return true;
  }
  if (policy?.blockedTopLevel?.has(top)) {
    return false;
  }
  return true;
};

const buildSearchResults = (content, lowerQuery, relPath, results, limit) => {
  if (!content) {
    return;
  }
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (results.length >= limit) {
      return;
    }
    const line = lines[index];
    if (line.toLowerCase().includes(lowerQuery)) {
      results.push({
        path: relPath,
        line: index + 1,
        preview: line.trim(),
      });
    }
  }
};

const isBlockedPath = (relativePath, policy) => {
  const normalized = normalizePath(relativePath);
  if (!normalized) return true;
  const top = normalized.split("/")[0];
  if (policy?.allowedTopLevel?.has(top)) {
    return false;
  }
  return policy?.blockedTopLevel?.has(top) ?? false;
};

const isTextExtension = (relativePath, policy) => {
  if (!policy?.textExtensions || policy.textExtensions.size === 0) {
    return true;
  }
  const ext = path.extname(relativePath).toLowerCase();
  if (!ext) {
    return true;
  }
  return policy?.textExtensions?.has(ext.slice(1)) ?? false;
};

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

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const splitLineComment = (line) => {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "%") {
      continue;
    }
    let slashCount = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) {
      slashCount += 1;
    }
    if (slashCount % 2 === 0) {
      return { code: line.slice(0, i), comment: line.slice(i) };
    }
  }
  return { code: line, comment: "" };
};

const replaceKeyInList = (value, from, to) => {
  if (typeof value !== "string") {
    return { text: value, count: 0 };
  }
  let count = 0;
  const parts = value.split(",");
  const updated = parts.map((part) => {
    const trimmed = part.trim();
    if (trimmed !== from) {
      return part;
    }
    count += 1;
    const leading = part.match(/^\s*/)?.[0] ?? "";
    const trailing = part.match(/\s*$/)?.[0] ?? "";
    return `${leading}${to}${trailing}`;
  });
  return { text: updated.join(","), count };
};

const LABEL_PATTERN = /(\\label\*?)\{([^}]*)\}/g;
const REF_PATTERN = new RegExp(
  `(\\\\(?:${LATEX_REF_COMMANDS.join("|")})\\*?)\\{([^}]*)\\}`,
  "g"
);
const REF_RANGE_PATTERN = new RegExp(
  `(\\\\(?:${LATEX_REF_RANGE_COMMANDS.join("|")})\\*?)\\{([^}]*)\\}\\{([^}]*)\\}`,
  "g"
);
const CITE_PATTERN = new RegExp(
  `(\\\\(?:${LATEX_CITE_COMMANDS.join("|")})\\*?(?:\\[[^\\]]*\\])*)\\{([^}]*)\\}`,
  "g"
);
const BIBITEM_PATTERN = /(\\bibitem\*?(?:\[[^\]]*\])?)\{([^}]*)\}/g;

const renameLatexInText = (content, { from, to, renameLabels, renameCites }) => {
  let totalCount = 0;
  const lines = content.split(/\r?\n/);
  const updatedLines = lines.map((line) => {
    const { code, comment } = splitLineComment(line);
    let text = code;
    if (renameLabels) {
      text = text.replace(LABEL_PATTERN, (match, prefix, keys) => {
        const result = replaceKeyInList(keys, from, to);
        if (result.count === 0) {
          return match;
        }
        totalCount += result.count;
        return `${prefix}{${result.text}}`;
      });
      text = text.replace(REF_RANGE_PATTERN, (match, prefix, first, second) => {
        const firstResult = replaceKeyInList(first, from, to);
        const secondResult = replaceKeyInList(second, from, to);
        const count = firstResult.count + secondResult.count;
        if (count === 0) {
          return match;
        }
        totalCount += count;
        return `${prefix}{${firstResult.text}}{${secondResult.text}}`;
      });
      text = text.replace(REF_PATTERN, (match, prefix, keys) => {
        const result = replaceKeyInList(keys, from, to);
        if (result.count === 0) {
          return match;
        }
        totalCount += result.count;
        return `${prefix}{${result.text}}`;
      });
    }
    if (renameCites) {
      text = text.replace(CITE_PATTERN, (match, prefix, keys) => {
        const result = replaceKeyInList(keys, from, to);
        if (result.count === 0) {
          return match;
        }
        totalCount += result.count;
        return `${prefix}{${result.text}}`;
      });
      text = text.replace(BIBITEM_PATTERN, (match, prefix, keys) => {
        const result = replaceKeyInList(keys, from, to);
        if (result.count === 0) {
          return match;
        }
        totalCount += result.count;
        return `${prefix}{${result.text}}`;
      });
    }
    return text + comment;
  });
  return { text: updatedLines.join("\n"), count: totalCount };
};

const renameBibEntryKey = (content, from, to) => {
  const pattern = new RegExp(
    `(^\\s*@\\w+\\s*\\{\\s*)${escapeRegex(from)}(\\s*,)`,
    "gmi"
  );
  let count = 0;
  const text = content.replace(pattern, (_match, prefix, suffix) => {
    count += 1;
    return `${prefix}${to}${suffix}`;
  });
  return { text, count };
};

const readFileFromDisk = async (resolvedPath, { forceBase64 = false } = {}) => {
  const buffer = await fsp.readFile(resolvedPath);
  if (forceBase64) {
    return {
      content: buffer.toString("base64"),
      encoding: "base64",
      binary: true,
      size: buffer.length,
    };
  }
  if (buffer.length === 0) {
    return { content: "", encoding: "utf8", binary: false, size: 0 };
  }
  const hasNullByte = buffer.includes(0);
  if (hasNullByte) {
    return {
      content: buffer.toString("base64"),
      encoding: "base64",
      binary: true,
      size: buffer.length,
    };
  }
  return {
    content: buffer.toString("utf8"),
    encoding: "utf8",
    binary: false,
    size: buffer.length,
  };
};

const runShellCommand = (
  command,
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
    const proc = spawn(command, {
      cwd,
      env: { ...process.env, ...sanitizedEnv },
      shell: true,
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

const buildSystemPrompt = (context, rootPath, policy) => {
  const activeFilePath = context?.activeFilePath ?? "";
  const activeFileContent =
    typeof context?.activeFileContent === "string" ? context.activeFileContent : "";
  const activeFileIsDirty = Boolean(context?.activeFileIsDirty);
  const activeFileContentTruncated = Boolean(context?.activeFileContentTruncated);
  const activeFileContentLength =
    typeof context?.activeFileContentLength === "number" ? context.activeFileContentLength : null;
  const openFiles = Array.isArray(context?.openFiles) ? context.openFiles : [];
  const openFileLabel = openFiles.length
    ? openFiles
        .map((entry) => {
          const dirty = entry.isDirty ? " *" : "";
          const active = entry.isActive ? " (active)" : "";
          return `${entry.path}${dirty}${active}`;
        })
        .join(", ")
    : "";
  const dirtyOpenCount = openFiles.filter((entry) => entry.isDirty).length;
  const blockedList = policy?.blockedTopLevel ? Array.from(policy.blockedTopLevel) : [];
  const allowedList = policy?.allowedTopLevel ? Array.from(policy.allowedTopLevel) : [];
  const blockedLabel = blockedList.length > 0 ? blockedList.join(" / ") : "(なし)";
  const allowedLabel = allowedList.length > 0 ? allowedList.join(" / ") : "";
  const fileSizeLabel = formatByteLimit(policy?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const readFilesLimit = policy?.maxReadFiles ?? DEFAULT_MAX_READ_FILES;

  const lines = [
    "あなたは tex64 に統合されたAIアシスタントです。",
    "LaTeXプロジェクトの編集を支援します。",
    "",
    "## 利用可能なツール",
    "- list_files: ファイル一覧を取得",
    "- read_file: ファイルを読み取り",
    "- read_files: 複数ファイルを一括読み取り（効率的）",
    "- search_files: テキスト検索",
    "- get_project_structure: プロジェクト構造をツリー形式で取得",
    "- get_index: ラベル/参照/引用/セクションのインデックス取得",
    "- rename_latex_symbol: LaTeXのラベル/参照/引用キーを一括リネーム",
    "- run_build: ビルド検証を実行",
    "- run_command: ターミナルコマンドを実行",
    "- get_app_settings: アプリ設定を取得",
    "- set_app_settings: アプリ設定を更新",
    "- propose_write: ファイル作成/上書きを提案",
    "- propose_patch: 部分編集を提案（複数ファイル/複数箇所対応）",
    "- propose_delete: ファイル削除を提案",
    "- propose_rename: ファイルのリネーム/移動を提案",
    "- propose_create_directory: ディレクトリ作成を提案",
    "",
    "## 必須ルール",
    "- 検証が必要なタスクでは run_build を使って確認する（ユーザー依頼がある場合は必ず実行）",
    "- 変更は全て propose_* で提案する（適用はユーザー承認、または autoApply 有効時に自動）",
    "- 変更前に必ず read_file / read_files で現状を確認する（アクティブファイルのスナップショットが提供されている場合はそれを利用してよい）",
    `- ブロック対象: ${blockedLabel}${allowedLabel ? `（許可: ${allowedLabel}）` : ""}`,
    Number.isFinite(readFilesLimit)
      ? `- read_files は最大${readFilesLimit}件まで`
      : "- read_files は無制限",
    fileSizeLabel === "無制限"
      ? "- ファイルサイズ制限なし"
      : `- 1ファイル最大${fileSizeLabel}まで読み書き可能`,
    "- バイナリファイルは read_file/read_files の encoding: base64 で取得できる",
    "- 大きな変更は propose_patch で部分編集を優先する",
    "",
    "## 出力ルール",
    "- ユーザー向けの最終応答の冒頭に、短い要約を必ず付ける",
    "- 形式: 「方針: ...」「理由: ...」の2行（各1文程度）",
    "- 内部の推論や思考過程は書かない",
    "",
    "## ワークスペース",
    `- Root: ${rootPath}`,
    `- Active file: ${activeFilePath || "(none)"}`,
  ];

  if (openFileLabel) {
    lines.push(`- Open files: ${openFileLabel}`);
    if (dirtyOpenCount > 0) {
      lines.push(`- Unsaved buffers: ${dirtyOpenCount}件（read_file は開いている未保存内容を優先）`);
    }
  }

  if (activeFileContent) {
    lines.push(`- Active file status: ${activeFileIsDirty ? "未保存の変更あり" : "保存済み"}`);
    if (activeFileContentTruncated) {
      const fullLength = activeFileContentLength ?? activeFileContent.length;
      lines.push(`- Active file note: 先頭${activeFileContent.length}文字のみ（全${fullLength}文字）`);
    }
    lines.push("", "## Active file snapshot", "```", activeFileContent, "```");
  }

  const openSnapshots = Array.isArray(context?.openFileSnapshots)
    ? context.openFileSnapshots
    : [];
  if (openSnapshots.length > 0) {
    const seenPaths = new Set();
    const usableSnapshots = openSnapshots.filter((snapshot) => {
      if (!snapshot || typeof snapshot.path !== "string" || typeof snapshot.content !== "string") {
        return false;
      }
      if (snapshot.path === activeFilePath) {
        return false;
      }
      if (seenPaths.has(snapshot.path)) {
        return false;
      }
      seenPaths.add(snapshot.path);
      return true;
    });
    if (usableSnapshots.length > 0) {
      lines.push("", "## Open file snapshots");
      usableSnapshots.forEach((snapshot) => {
        const dirtyLabel = snapshot.isDirty ? " (未保存)" : "";
        lines.push(`### ${snapshot.path}${dirtyLabel}`);
        if (snapshot.truncated) {
          const fullLength =
            typeof snapshot.contentLength === "number"
              ? snapshot.contentLength
              : snapshot.content.length;
          lines.push(`- Snapshot note: 先頭${snapshot.content.length}文字のみ（全${fullLength}文字）`);
        }
        lines.push("```", snapshot.content, "```");
      });
    }
  }

  const recentIssues = Array.isArray(context?.recentIssues) ? context.recentIssues : [];
  const recentIssueSummary =
    typeof context?.recentIssueSummary === "string" ? context.recentIssueSummary : "";
  const recentIssueStatus =
    typeof context?.recentIssueStatus === "string" ? context.recentIssueStatus : "";
  const recentIssuesUpdatedAt =
    typeof context?.recentIssuesUpdatedAt === "string" ? context.recentIssuesUpdatedAt : "";
  if (recentIssues.length > 0) {
    lines.push("", "## Recent issues");
    if (recentIssueSummary) {
      lines.push(`- Summary: ${recentIssueSummary}${recentIssueStatus ? ` (${recentIssueStatus})` : ""}`);
    }
    if (recentIssuesUpdatedAt) {
      lines.push(`- Updated: ${recentIssuesUpdatedAt}`);
    }
    recentIssues.forEach((issue) => {
      if (!issue || typeof issue.message !== "string") {
        return;
      }
      const location = issue.path
        ? `${issue.path}${issue.line ? `:${issue.line}` : ""}`
        : issue.line
        ? `line ${issue.line}`
        : "location unknown";
      const severity = issue.severity || "error";
      const resolution =
        typeof issue.resolution === "string" && issue.resolution.trim()
          ? ` / fix: ${issue.resolution.trim()}`
          : "";
      lines.push(`- [${severity}] ${issue.message} (${location})${resolution}`);
    });
  }

  lines.push("", "必要に応じてファイルを読み、変更は提案してください。");
  return lines.join("\n");
};

class AgentService {
  constructor({
    workspace,
    searchService,
    ensureUserSettings,
    sendToRenderer,
    updateWorkspaceIfNeeded,
    requestIndex,
    buildService,
    sendBuildState,
    sendBuildLog,
    sendIssues,
    indexerService,
  }) {
    this.workspace = workspace;
    this.searchService = searchService;
    this.ensureUserSettings = ensureUserSettings;
    this.sendToRenderer = sendToRenderer;
    this.updateWorkspaceIfNeeded = updateWorkspaceIfNeeded;
    this.requestIndex = requestIndex;
    this.buildService = buildService;
    this.sendBuildState = sendBuildState;
    this.sendBuildLog = sendBuildLog;
    this.sendIssues = sendIssues;
    this.indexerService = indexerService;
    this.conversations = new Map();
    this.proposals = new Map();
    this.contextByConversation = new Map();
    this.abortController = null;
    this.agentPolicy = buildAgentPolicy();
    this.agentOptions = {
      maxIterations: DEFAULT_MAX_ITERATIONS,
      stream: true,
      autoApply: false,
      autoBuild: false,
    };
    this.autoBuildInProgress = false;
    this.pendingSettingsRequests = new Map();
  }

  sendStatus(state, message, conversationId) {
    this.sendToRenderer("agent:status", { state, message, conversationId });
  }

  buildConversation(conversationId) {
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, []);
    }
    return this.conversations.get(conversationId);
  }

  clearConversation(conversationId) {
    this.conversations.set(conversationId, []);
    this.contextByConversation.delete(conversationId);
  }

  abort() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  resolveAgentPolicy(settings) {
    const policy = buildAgentPolicy(settings);
    this.agentPolicy = policy;
    return policy;
  }

  resolveAgentOptions(settings) {
    const options = {
      maxIterations: clampNumber(
        settings?.maxIterations,
        DEFAULT_MAX_ITERATIONS,
        { min: 1, max: 30 }
      ),
      stream: settings?.stream !== false,
      autoApply: settings?.autoApply === true,
      autoBuild: settings?.autoBuild === true,
    };
    this.agentOptions = options;
    return options;
  }

  setContext(conversationId, context) {
    if (!conversationId) {
      return;
    }
    this.contextByConversation.set(conversationId, context ?? {});
  }

  requestAppSettings(action, payload) {
    const requestId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSettingsRequests.delete(requestId);
        resolve({ error: "設定の取得に失敗しました。" });
      }, 3000);
      this.pendingSettingsRequests.set(requestId, { resolve, timer });
      this.sendToRenderer("settings:request", {
        requestId,
        action,
        ...payload,
      });
    });
  }

  handleSettingsResponse(payload) {
    const requestId = payload?.requestId;
    if (!requestId || !this.pendingSettingsRequests.has(requestId)) {
      return;
    }
    const entry = this.pendingSettingsRequests.get(requestId);
    this.pendingSettingsRequests.delete(requestId);
    if (entry?.timer) {
      clearTimeout(entry.timer);
    }
    entry?.resolve?.(payload);
  }

  async maybeAutoBuild(proposal) {
    if (!this.agentOptions.autoBuild || this.autoBuildInProgress) {
      return;
    }
    const pathValue = proposal?.path ?? "";
    if (!/\.(tex|bib|sty|cls|ltx|dtx)$/i.test(pathValue)) {
      return;
    }
    this.autoBuildInProgress = true;
    try {
      await this.executeToolCall(
        { name: "run_build", args: {} },
        proposal?.conversationId ?? "default"
      );
    } finally {
      this.autoBuildInProgress = false;
    }
  }

  getContextSnapshot(conversationId, targetPath) {
    if (!targetPath) {
      return null;
    }
    const context = this.contextByConversation.get(conversationId);
    if (!context || !targetPath) {
      return null;
    }
    if (context.activeFilePath === targetPath && typeof context.activeFileContent === "string") {
      return {
        path: targetPath,
        content: context.activeFileContent,
        isDirty: Boolean(context.activeFileIsDirty),
        truncated: Boolean(context.activeFileContentTruncated),
        contentLength:
          typeof context.activeFileContentLength === "number"
            ? context.activeFileContentLength
            : context.activeFileContent.length,
      };
    }
    const snapshots = Array.isArray(context.openFileSnapshots)
      ? context.openFileSnapshots
      : [];
    const match = snapshots.find((entry) => entry.path === targetPath);
    if (!match || typeof match.content !== "string") {
      return null;
    }
    return {
      path: match.path,
      content: match.content,
      isDirty: Boolean(match.isDirty),
      truncated: Boolean(match.truncated),
      contentLength:
        typeof match.contentLength === "number" ? match.contentLength : match.content.length,
    };
  }

  async applyProposal(proposalId) {
    const proposal = this.proposals.get(proposalId);
    const rootPath = this.workspace.getRootPath();
    if (!proposal) {
      this.sendToRenderer("agent:applyResult", {
        proposalId,
        ok: false,
        error: "提案が見つかりません。",
      });
      return;
    }
    if (!rootPath) {
      this.sendToRenderer("agent:applyResult", {
        proposalId,
        ok: false,
        error: "ワークスペースが選択されていません。",
      });
      return;
    }
    try {
      const type = proposal.type || "write";
      
      if (type === "delete") {
        const resolved = this.workspace.resolvePath(proposal.path);
        await fsp.unlink(resolved);
      } else if (type === "rename") {
        const oldResolved = this.workspace.resolvePath(proposal.oldPath);
        const newResolved = this.workspace.resolvePath(proposal.path);
        await fsp.mkdir(path.dirname(newResolved), { recursive: true });
        await fsp.rename(oldResolved, newResolved);
        this.sendToRenderer("renameResult", {
          oldPath: proposal.oldPath,
          newPath: proposal.path,
          isDirectory: false,
        });
      } else if (type === "mkdir") {
        const resolved = this.workspace.resolvePath(proposal.path);
        await fsp.mkdir(resolved, { recursive: true });
      } else {
        // write or patch
        const resolved = this.workspace.resolvePath(proposal.path);
        await fsp.mkdir(path.dirname(resolved), { recursive: true });
        if (proposal.encoding === "base64") {
          const buffer = Buffer.from(proposal.content, "base64");
          await fsp.writeFile(resolved, buffer);
        } else {
          await this.workspace.writeFile(proposal.path, proposal.content);
          this.sendToRenderer("agent:applyContent", {
            path: proposal.path,
            content: proposal.content,
            updateSaved: true,
          });
        }
      }
      
      await this.updateWorkspaceIfNeeded(rootPath, true);
      this.requestIndex(rootPath);
      this.proposals.delete(proposalId);
      this.sendToRenderer("agent:applyResult", { proposalId, ok: true });
      await this.maybeAutoBuild(proposal);
    } catch (error) {
      this.sendToRenderer("agent:applyResult", {
        proposalId,
        ok: false,
        error: error?.message ?? "操作に失敗しました。",
      });
    }
  }

  buildProgressMessage(label) {
    if (!label) {
      return "思考中...";
    }
    return `思考中: ${label}`;
  }

  async executeToolCall(toolCall, conversationId) {
    try {
      const name = toolCall?.name ?? "";
      const policy = this.agentPolicy ?? buildAgentPolicy();
      const statusLabel = TOOL_STATUS_LABELS[name];
      if (statusLabel) {
        this.sendStatus("running", this.buildProgressMessage(statusLabel), conversationId);
      }
      let args = toolCall?.args ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }

      if (name === "list_files") {
        const directory = normalizePath(args.directory);
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        if (directory && isBlockedPath(directory, policy)) {
          return { error: "対象パスは読み取り禁止です。" };
        }
        let basePath = "";
        try {
          basePath = this.workspace.resolvePath(directory);
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
      }

      if (name === "read_file") {
        const targetPath = normalizePath(args.path);
        if (!targetPath) {
          return { error: "path が空です。" };
        }
        if (isBlockedPath(targetPath, policy)) {
          return { error: "対象パスは読み取り禁止です。" };
        }
        const useBase64 = wantsBase64(args);
        if (!isTextExtension(targetPath, policy) && !useBase64) {
          return {
            error:
              "テキストファイルのみ読み取れます。バイナリは encoding: base64 を指定してください。",
          };
        }
        const snapshot = this.getContextSnapshot(conversationId, targetPath);
        if (snapshot && snapshot.content) {
          if (snapshot.contentLength > policy.maxFileBytes) {
            return { error: "ファイルが大きすぎます。" };
          }
          if (useBase64) {
            return {
              content: Buffer.from(snapshot.content, "utf8").toString("base64"),
              encoding: "base64",
              binary: true,
              partial: snapshot.truncated,
              source: "buffer",
            };
          }
          return {
            content: snapshot.content,
            partial: snapshot.truncated,
            source: "buffer",
          };
        }
        const resolved = this.workspace.resolvePath(targetPath);
        const stat = await fsp.stat(resolved).catch(() => null);
        if (!stat || !stat.isFile()) {
          return { error: "ファイルが見つかりません。" };
        }
        if (stat.size > policy.maxFileBytes) {
          return { error: "ファイルが大きすぎます。" };
        }
        const result = await readFileFromDisk(resolved, { forceBase64: useBase64 });
        const response = { content: result.content };
        if (result.binary) {
          response.encoding = "base64";
          response.binary = true;
          response.size = result.size;
        }
        return response;
      }

      if (name === "read_files") {
        const paths = Array.isArray(args.paths) ? args.paths : [];
        if (paths.length === 0) {
          return { error: "paths が空です。" };
        }
        if (paths.length > policy.maxReadFiles) {
          return { error: `一度に読み取れるファイルは${policy.maxReadFiles}個までです。` };
        }
        const useBase64 = wantsBase64(args);
        const results = {};
        for (const p of paths) {
          const targetPath = normalizePath(p);
          if (
            !targetPath ||
            isBlockedPath(targetPath, policy) ||
            (!isTextExtension(targetPath, policy) && !useBase64)
          ) {
            results[p] = {
              error: useBase64
                ? "読み取り不可"
                : "テキストのみ読み取り可能です。バイナリは encoding: base64 を指定してください。",
            };
            continue;
          }
          try {
            const snapshot = this.getContextSnapshot(conversationId, targetPath);
            if (snapshot && snapshot.content) {
              if (snapshot.contentLength > policy.maxFileBytes) {
                results[p] = { error: "ファイルが大きすぎます。" };
              } else {
                if (useBase64) {
                  results[p] = {
                    content: Buffer.from(snapshot.content, "utf8").toString("base64"),
                    encoding: "base64",
                    binary: true,
                    partial: snapshot.truncated,
                    source: "buffer",
                  };
                } else {
                  results[p] = {
                    content: snapshot.content,
                    partial: snapshot.truncated,
                    source: "buffer",
                  };
                }
              }
              continue;
            }
            const resolved = this.workspace.resolvePath(targetPath);
            const stat = await fsp.stat(resolved).catch(() => null);
            if (!stat || !stat.isFile() || stat.size > policy.maxFileBytes) {
              results[p] = { error: "ファイルが見つからないか大きすぎます" };
              continue;
            }
            const result = await readFileFromDisk(resolved, { forceBase64: useBase64 });
            results[p] = { content: result.content };
            if (result.binary) {
              results[p].encoding = "base64";
              results[p].binary = true;
              results[p].size = result.size;
            }
          } catch {
            results[p] = { error: "読み取りエラー" };
          }
        }
        return { files: results };
      }

      if (name === "search_files") {
        const query = typeof args.query === "string" ? args.query : "";
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        const trimmed = query.trim();
        if (!trimmed) {
          return { results: [] };
        }
        const lowerQuery = trimmed.toLowerCase();
        const results = [];
        const seenPaths = new Set();
        const context = this.contextByConversation.get(conversationId);
        const activePath =
          typeof context?.activeFilePath === "string" ? normalizePath(context.activeFilePath) : "";
        if (
          activePath &&
          typeof context?.activeFileContent === "string" &&
          results.length < MAX_SEARCH_RESULTS &&
          isPathAllowed(activePath, policy) &&
          isTextExtension(activePath, policy)
        ) {
          seenPaths.add(activePath);
          buildSearchResults(
            context.activeFileContent,
            lowerQuery,
            activePath,
            results,
            MAX_SEARCH_RESULTS
          );
        }
        if (context?.openFileSnapshots && Array.isArray(context.openFileSnapshots)) {
          context.openFileSnapshots.forEach((snapshot) => {
            if (
              typeof snapshot?.path === "string" &&
              typeof snapshot?.content === "string" &&
              results.length < MAX_SEARCH_RESULTS
            ) {
              seenPaths.add(snapshot.path);
              buildSearchResults(
                snapshot.content,
                lowerQuery,
                snapshot.path,
                results,
                MAX_SEARCH_RESULTS
              );
            }
          });
        }
        const walk = async (dirPath) => {
          const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
          for (const entry of entries) {
            if (results.length >= MAX_SEARCH_RESULTS) {
              return;
            }
            if (entry.isDirectory() && ALWAYS_IGNORED_DIRECTORIES.has(entry.name)) {
              continue;
            }
            const absPath = path.join(dirPath, entry.name);
            const relPath = normalizeRelativePath(path.relative(rootPath, absPath));
            if (!isPathAllowed(relPath, policy)) {
              continue;
            }
            if (entry.isDirectory()) {
              await walk(absPath);
              continue;
            }
            if (!entry.isFile()) {
              continue;
            }
            if (!isTextExtension(relPath, policy)) {
              continue;
            }
            if (seenPaths.has(relPath)) {
              continue;
            }
            const stat = await fsp.stat(absPath).catch(() => null);
            if (!stat || !stat.isFile() || stat.size > policy.maxFileBytes) {
              continue;
            }
            const content = await fsp.readFile(absPath, "utf8").catch(() => null);
            if (content === null) {
              continue;
            }
            buildSearchResults(content, lowerQuery, relPath, results, MAX_SEARCH_RESULTS);
          }
        };
        await walk(rootPath);
        return { results };
      }

      if (name === "get_project_structure") {
        const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 3;
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        const buildTree = async (dir, depth) => {
          if (depth > maxDepth) return null;
          const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
          const result = [];
          for (const entry of entries) {
            const absPath = path.join(dir, entry.name);
            const relPath = normalizeRelativePath(path.relative(rootPath, absPath));
            const top = relPath.split("/")[0];
            if (policy.blockedTopLevel.has(top) && !policy.allowedTopLevel.has(top)) {
              continue;
            }
            if (entry.isDirectory()) {
              const children = await buildTree(absPath, depth + 1);
              result.push({ name: entry.name, type: "dir", children: children || [] });
            } else {
              result.push({ name: entry.name, type: "file" });
            }
          }
          return result;
        };
        const tree = await buildTree(rootPath, 1);
        return { structure: tree };
      }

      if (name === "get_index") {
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        if (!this.indexerService) {
          return { error: "インデクサが利用できません。" };
        }
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 200;
        const query =
          typeof args.query === "string" && args.query.trim() ? args.query.trim().toLowerCase() : "";
        const kinds = Array.isArray(args.kinds)
          ? args.kinds.filter((kind) => typeof kind === "string")
          : [];
        const snapshot = await this.indexerService.buildIndex(rootPath);
        const filterSymbols = (items, keyField) => {
          let result = items;
          if (query) {
            result = result.filter((entry) =>
              String(entry[keyField] ?? "").toLowerCase().includes(query)
            );
          }
          if (Number.isFinite(limit)) {
            result = result.slice(0, Math.max(0, limit));
          }
          return result;
        };
        const includeAll = kinds.length === 0;
        const data = {};
        if (includeAll || kinds.includes("labels")) {
          data.labels = filterSymbols(snapshot.labels, "key");
        }
        if (includeAll || kinds.includes("references")) {
          data.references = filterSymbols(snapshot.references, "key");
        }
        if (includeAll || kinds.includes("citations")) {
          data.citations = filterSymbols(snapshot.citations, "key");
        }
        if (includeAll || kinds.includes("sections")) {
          data.sections = filterSymbols(snapshot.sections, "title");
        }
        if (includeAll || kinds.includes("figures")) {
          data.figures = filterSymbols(snapshot.figures, "key");
        }
        if (includeAll || kinds.includes("tables")) {
          data.tables = filterSymbols(snapshot.tables, "key");
        }
        if (includeAll || kinds.includes("todos")) {
          data.todos = filterSymbols(snapshot.todos, "key");
        }
        return { index: data };
      }

      if (name === "get_app_settings") {
        const keys = Array.isArray(args.keys)
          ? args.keys.filter((entry) => typeof entry === "string")
          : [];
        const response = await this.requestAppSettings("get", { keys });
        if (response?.error) {
          return { error: response.error };
        }
        const settings = response?.settings ?? response?.payload?.settings ?? null;
        if (!settings) {
          return { error: "設定が取得できませんでした。" };
        }
        if (keys.length === 0) {
          return { settings };
        }
        const filtered = {};
        keys.forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(settings, key)) {
            filtered[key] = settings[key];
          }
        });
        return { settings: filtered };
      }

      if (name === "set_app_settings") {
        const patch =
          args?.settings && typeof args.settings === "object" ? args.settings : null;
        if (!patch) {
          return { error: "settings が空です。" };
        }
        const response = await this.requestAppSettings("set", { settings: patch });
        if (response?.error) {
          return { error: response.error };
        }
        const settings = response?.settings ?? response?.payload?.settings ?? null;
        if (!settings) {
          return { error: "設定が更新できませんでした。" };
        }
        return { settings };
      }

      if (name === "run_build") {
        if (!this.buildService) {
          return { error: "ビルド機能が利用できません。" };
        }
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        const requestedMain = typeof args.mainFile === "string" ? args.mainFile.trim() : "";
        const requestedEngine = typeof args.engine === "string" ? args.engine.trim() : "";
        const rootInfo = await this.workspace.rootInfo().catch(() => null);
        const targetFile = requestedMain || rootInfo?.path || "main.tex";
        this.sendBuildState?.("building", "AIがビルド中...");
        this.sendIssues?.(0, "AIがビルド中...", "info", []);
        const result = await this.buildService.build(
          rootPath,
          targetFile,
          requestedEngine || "lualatex"
        );
        if (result.kind === "busy") {
          this.sendBuildState?.("building", "すでにビルド中です。");
          this.sendIssues?.(0, "すでにビルド中です。", "info", []);
          return { status: "busy", summary: "すでにビルド中です。" };
        }
        if (result.log) {
          this.sendBuildLog?.(result.log);
        }
        if (result.kind === "success") {
          const warningIssues = result.issues.filter(
            (issue) => issue.severity === "warning"
          );
          if (warningIssues.length > 0) {
            const summaryText = warningIssues[0]?.message ?? result.summary;
            this.sendIssues?.(warningIssues.length, summaryText, "info", warningIssues);
          } else {
            this.sendIssues?.(0, result.summary, "success", []);
          }
          this.sendBuildState?.("success", result.summary);
          return {
            status: "success",
            summary: result.summary,
            issues: result.issues,
            pdfPath: result.pdfPath ?? null,
          };
        }
        if (result.kind === "failure") {
          const count = Math.max(result.issues.length, 1);
          const summaryText = result.issues[0]?.message ?? result.summary;
          this.sendBuildState?.("failed", result.summary);
          this.sendIssues?.(count, summaryText, "error", result.issues);
          return { status: "failure", summary: result.summary, issues: result.issues };
        }
        return { status: "unknown", summary: "ビルド結果が不明です。" };
      }

      if (name === "run_command") {
        const command = typeof args.command === "string" ? args.command.trim() : "";
        if (!command) {
          return { error: "command が空です。" };
        }
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        let cwd = rootPath;
        if (typeof args.cwd === "string" && args.cwd.trim()) {
          try {
            cwd = this.workspace.resolvePath(normalizePath(args.cwd));
          } catch {
            return { error: "cwd が不正です。" };
          }
        }
        const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : null;
        const maxOutputBytes = Number.isFinite(args.maxOutputBytes)
          ? args.maxOutputBytes
          : DEFAULT_MAX_COMMAND_OUTPUT_BYTES;
        const result = await runShellCommand(command, {
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
      }

      if (name === "rename_latex_symbol") {
        const from = typeof args.from === "string" ? args.from.trim() : "";
        const to = typeof args.to === "string" ? args.to.trim() : "";
        if (!from || !to) {
          return { error: "from と to は必須です。" };
        }
        if (from === to) {
          return { error: "from と to が同じです。" };
        }
        const invalidPattern = /[\s,{}]/;
        if (invalidPattern.test(from) || invalidPattern.test(to)) {
          return { error: "from/to に空白や区切り文字は使えません。" };
        }
        const kinds = normalizeStringList(args.kinds).map((entry) => entry.toLowerCase());
        const renameLabels =
          kinds.length === 0 || kinds.includes("label") || kinds.includes("ref");
        const renameCites =
          kinds.length === 0 || kinds.includes("cite") || kinds.includes("citation");
        if (!renameLabels && !renameCites) {
          return { error: "kinds が不正です。" };
        }
        const extOverride = normalizeExtensionList(args.extensions);
        const targetExtensions =
          extOverride.size > 0
            ? extOverride
            : new Set(DEFAULT_LATEX_SYMBOL_EXTENSIONS);
        if (!renameCites && extOverride.size === 0) {
          targetExtensions.delete("bib");
        }
        let fileList = [];
        try {
          fileList = await this.workspace.listFiles();
        } catch {
          return { error: "ファイル一覧の取得に失敗しました。" };
        }

        const preparedProposals = [];
        const skipped = [];

        for (const targetPath of fileList) {
          if (!targetPath) {
            continue;
          }
          if (isBlockedPath(targetPath, policy)) {
            skipped.push({ path: targetPath, reason: "blocked" });
            continue;
          }
          const ext = path.extname(targetPath).toLowerCase().replace(/^\./, "");
          if (!targetExtensions.has(ext)) {
            continue;
          }
          if (!isTextExtension(targetPath, policy)) {
            skipped.push({ path: targetPath, reason: "non_text" });
            continue;
          }

          let originalContent = "";
          const snapshot = this.getContextSnapshot(conversationId, targetPath);
          if (snapshot && typeof snapshot.content === "string") {
            if (snapshot.truncated && snapshot.isDirty) {
              return {
                error:
                  `${targetPath} は未保存の変更があり、スナップショットが省略されています。` +
                  "保存してから再実行してください。",
              };
            }
            if (!snapshot.truncated) {
              originalContent = snapshot.content;
            }
          }

          if (!originalContent) {
            let resolved = "";
            try {
              resolved = this.workspace.resolvePath(targetPath);
            } catch {
              continue;
            }
            const stat = await fsp.stat(resolved).catch(() => null);
            if (!stat || !stat.isFile()) {
              continue;
            }
            if (stat.size > policy.maxFileBytes) {
              skipped.push({ path: targetPath, reason: "too_large" });
              continue;
            }
            const result = await readFileFromDisk(resolved);
            if (result.binary) {
              skipped.push({ path: targetPath, reason: "binary" });
              continue;
            }
            originalContent = result.content;
          }

          let updatedContent = originalContent;
          let appliedCount = 0;

          if (ext === "bib") {
            if (renameCites) {
              const result = renameBibEntryKey(updatedContent, from, to);
              updatedContent = result.text;
              appliedCount += result.count;
            }
          } else {
            const result = renameLatexInText(updatedContent, {
              from,
              to,
              renameLabels,
              renameCites,
            });
            updatedContent = result.text;
            appliedCount += result.count;
          }

          if (appliedCount === 0 || updatedContent === originalContent) {
            continue;
          }
          if (updatedContent.length > policy.maxFileBytes) {
            skipped.push({ path: targetPath, reason: "too_large" });
            continue;
          }
          preparedProposals.push({
            path: targetPath,
            originalContent,
            updatedContent,
            appliedCount,
          });
        }

        if (preparedProposals.length === 0) {
          return { error: "一致するシンボルが見つかりません。" };
        }

        const proposals = [];
        const summaryBase =
          renameLabels && renameCites
            ? "シンボルリネーム"
            : renameLabels
            ? "ラベルリネーム"
            : "引用キーリネーム";

        for (const prepared of preparedProposals) {
          const id =
            typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
          const proposal = {
            id,
            type: "patch",
            path: prepared.path,
            content: prepared.updatedContent,
            originalContent: prepared.originalContent,
            summary: `${summaryBase}: ${from} → ${to} (${prepared.appliedCount}箇所)`,
            isNewFile: false,
            conversationId,
          };
          this.proposals.set(id, proposal);
          this.sendToRenderer("agent:proposal", { proposal });
          proposals.push({
            proposalId: id,
            path: prepared.path,
            appliedCount: prepared.appliedCount,
          });
        }

        if (this.agentOptions.autoApply) {
          for (const entry of proposals) {
            await this.applyProposal(entry.proposalId);
          }
        }

        return {
          status: "proposed",
          proposalIds: proposals.map((proposal) => proposal.proposalId),
          files: proposals,
          skipped,
        };
      }

      if (name === "propose_write") {
        const targetPath = normalizePath(args.path);
        const content = typeof args.content === "string" ? args.content : "";
        const summary = typeof args.summary === "string" ? args.summary : "";
        const encoding = normalizeEncoding(args.encoding);
        const binaryWrite = encoding === "base64";
        if (!targetPath) {
          return { error: "path が空です。" };
        }
        if (isBlockedPath(targetPath, policy)) {
          return { error: "対象パスは書き込み禁止です。" };
        }
        if (!isTextExtension(targetPath, policy) && !binaryWrite) {
          return {
            error:
              "テキストファイルのみ書き込み可能です。バイナリは encoding: base64 を指定してください。",
          };
        }
        let contentBytes = Buffer.byteLength(content, "utf8");
        if (binaryWrite) {
          try {
            contentBytes = Buffer.from(content, "base64").length;
          } catch {
            return { error: "base64 の内容が不正です。" };
          }
        }
        if (contentBytes > policy.maxFileBytes) {
          return { error: "内容が大きすぎます。" };
        }
        let originalContent = "";
        let isNewFile = true;
        let isBinary = binaryWrite;
        const snapshot = this.getContextSnapshot(conversationId, targetPath);
        if (snapshot && snapshot.content) {
          if (snapshot.contentLength > policy.maxFileBytes) {
            return { error: "ファイルが大きすぎます。" };
          }
          originalContent = binaryWrite
            ? Buffer.from(snapshot.content, "utf8").toString("base64")
            : snapshot.content;
          isNewFile = false;
        } else {
          try {
            const resolved = this.workspace.resolvePath(targetPath);
            const result = await readFileFromDisk(resolved, { forceBase64: binaryWrite });
            originalContent = result.content;
            isBinary = isBinary || result.binary;
            isNewFile = false;
          } catch {
            originalContent = "";
            isNewFile = true;
          }
        }
        const id =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const proposal = {
          id,
          type: "write",
          path: targetPath,
          content,
          originalContent,
          encoding: binaryWrite ? "base64" : undefined,
          isBinary,
          summary,
          isNewFile,
          conversationId,
        };
        this.proposals.set(id, proposal);
        this.sendToRenderer("agent:proposal", { proposal });
        if (this.agentOptions.autoApply) {
          await this.applyProposal(id);
        }
        return { status: "proposed", proposalId: id };
      }

      if (name === "propose_patch") {
        const summaryPrefix = typeof args.summary === "string" ? args.summary.trim() : "";
        const editsArg = Array.isArray(args.edits) ? args.edits : null;
        const normalizedEdits = [];

        if (editsArg && editsArg.length === 0) {
          return { error: "edits が空です。" };
        }

        if (editsArg && editsArg.length > 0) {
          for (const edit of editsArg) {
            const targetPath = normalizePath(edit?.path);
            const search = typeof edit?.search === "string" ? edit.search : "";
            const replace = typeof edit?.replace === "string" ? edit.replace : "";
            const replaceAll = edit?.replaceAll === true;
            if (!targetPath || !search) {
              return { error: "edits の各項目に path と search は必須です。" };
            }
            normalizedEdits.push({ path: targetPath, search, replace, replaceAll });
          }
        } else {
          const targetPath = normalizePath(args.path);
          const search = typeof args.search === "string" ? args.search : "";
          const replace = typeof args.replace === "string" ? args.replace : "";
          const replaceAll = args.replaceAll === true;
          if (!targetPath || !search) {
            return { error: "path と search は必須です。" };
          }
          normalizedEdits.push({ path: targetPath, search, replace, replaceAll });
        }

        const editsByPath = new Map();
        for (const edit of normalizedEdits) {
          if (isBlockedPath(edit.path, policy)) {
            return { error: "対象パスは編集禁止です。" };
          }
          if (!isTextExtension(edit.path, policy)) {
            return { error: "テキストファイルのみ編集可能です。" };
          }
          if (!editsByPath.has(edit.path)) {
            editsByPath.set(edit.path, []);
          }
          editsByPath.get(edit.path).push(edit);
        }

        const fileCount = editsByPath.size;
        const preparedProposals = [];

        const buildSummary = (path, edits, appliedCount) => {
          if (summaryPrefix && fileCount === 1) {
            return summaryPrefix;
          }
          let base = "";
          if (edits.length === 1) {
            const searchPreview = edits[0].search.slice(0, 20);
            const replacePreview = edits[0].replace.slice(0, 20);
            base = `"${searchPreview}..." → "${replacePreview}..." (${appliedCount}箇所)`;
          } else {
            base = `${edits.length}件の置換（${appliedCount}箇所）`;
          }
          if (!summaryPrefix) {
            return base;
          }
          return `${summaryPrefix} (${path}: ${base})`;
        };

        for (const [targetPath, edits] of editsByPath.entries()) {
          let originalContent = "";
          const snapshot = this.getContextSnapshot(conversationId, targetPath);
          if (snapshot && snapshot.content) {
            if (snapshot.contentLength > policy.maxFileBytes) {
              return { error: "ファイルが大きすぎます。" };
            }
            originalContent = snapshot.content;
          } else {
            try {
              const resolved = this.workspace.resolvePath(targetPath);
              const result = await readFileFromDisk(resolved);
              if (result.binary) {
                return { error: "バイナリファイルのため部分編集できません。" };
              }
              originalContent = result.content;
            } catch {
              return { error: "ファイルが見つかりません。" };
            }
          }
          let updatedContent = originalContent;
          let appliedCount = 0;
          for (const edit of edits) {
            const result = edit.replaceAll
              ? replaceAllWithCount(updatedContent, edit.search, edit.replace)
              : replaceOnceWithCount(updatedContent, edit.search, edit.replace);
            if (result.count === 0) {
              return { error: `${targetPath} に検索文字列が見つかりません。` };
            }
            updatedContent = result.text;
            appliedCount += result.count;
          }
          if (appliedCount === 0 || updatedContent === originalContent) {
            return { error: "変更がありません。" };
          }
          if (updatedContent.length > policy.maxFileBytes) {
            return { error: "内容が大きすぎます。" };
          }
          preparedProposals.push({
            path: targetPath,
            edits,
            originalContent,
            updatedContent,
            appliedCount,
          });
        }

        const proposals = [];
        for (const prepared of preparedProposals) {
          const id =
            typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
          const proposal = {
            id,
            type: "patch",
            path: prepared.path,
            content: prepared.updatedContent,
            originalContent: prepared.originalContent,
            summary: buildSummary(prepared.path, prepared.edits, prepared.appliedCount),
            isNewFile: false,
            conversationId,
          };
          this.proposals.set(id, proposal);
          this.sendToRenderer("agent:proposal", { proposal });
          proposals.push({
            proposalId: id,
            path: prepared.path,
            appliedCount: prepared.appliedCount,
          });
        }

        if (this.agentOptions.autoApply) {
          for (const entry of proposals) {
            await this.applyProposal(entry.proposalId);
          }
        }

        return {
          status: "proposed",
          proposalIds: proposals.map((proposal) => proposal.proposalId),
          files: proposals,
        };
      }

      if (name === "propose_delete") {
        const targetPath = normalizePath(args.path);
        const summary = typeof args.summary === "string" ? args.summary : "ファイル削除";
        if (!targetPath) {
          return { error: "path が空です。" };
        }
        if (isBlockedPath(targetPath, policy)) {
          return { error: "対象パスは削除禁止です。" };
        }
        const resolved = this.workspace.resolvePath(targetPath);
        const stat = await fsp.stat(resolved).catch(() => null);
        if (!stat || !stat.isFile()) {
          return { error: "ファイルが見つかりません。" };
        }
        let originalContent = "";
        let isBinary = false;
        const snapshot = this.getContextSnapshot(conversationId, targetPath);
        if (snapshot && snapshot.content) {
          if (snapshot.contentLength > policy.maxFileBytes) {
            return { error: "ファイルが大きすぎます。" };
          }
          originalContent = snapshot.content;
        } else {
          try {
            const result = await readFileFromDisk(resolved);
            originalContent = result.content;
            isBinary = result.binary;
          } catch {
            originalContent = "";
          }
        }
        const id =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const proposal = {
          id,
          type: "delete",
          path: targetPath,
          content: "",
          originalContent,
          isBinary,
          summary,
          isNewFile: false,
          conversationId,
        };
        this.proposals.set(id, proposal);
        this.sendToRenderer("agent:proposal", { proposal });
        return { status: "proposed", proposalId: id };
      }

      if (name === "propose_rename") {
        const oldPath = normalizePath(args.oldPath);
        const newPath = normalizePath(args.newPath);
        const summary = typeof args.summary === "string" ? args.summary : `${oldPath} → ${newPath}`;
        if (!oldPath || !newPath) {
          return { error: "oldPath と newPath は必須です。" };
        }
        if (isBlockedPath(oldPath, policy) || isBlockedPath(newPath, policy)) {
          return { error: "対象パスは操作禁止です。" };
        }
        const resolved = this.workspace.resolvePath(oldPath);
        const stat = await fsp.stat(resolved).catch(() => null);
        if (!stat || !stat.isFile()) {
          return { error: "ファイルが見つかりません。" };
        }
        let originalContent = "";
        let isBinary = false;
        const snapshot = this.getContextSnapshot(conversationId, oldPath);
        if (snapshot && snapshot.content) {
          if (snapshot.contentLength > policy.maxFileBytes) {
            return { error: "ファイルが大きすぎます。" };
          }
          originalContent = snapshot.content;
        } else {
          try {
            const result = await readFileFromDisk(resolved);
            originalContent = result.content;
            isBinary = result.binary;
          } catch {
            originalContent = "";
          }
        }
        const id =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const proposal = {
          id,
          type: "rename",
          path: newPath,
          oldPath,
          content: originalContent,
          originalContent,
          isBinary,
          summary,
          isNewFile: false,
          conversationId,
        };
        this.proposals.set(id, proposal);
        this.sendToRenderer("agent:proposal", { proposal });
        return { status: "proposed", proposalId: id };
      }

      if (name === "propose_create_directory") {
        const targetPath = normalizePath(args.path);
        const summary = typeof args.summary === "string" ? args.summary : "ディレクトリ作成";
        if (!targetPath) {
          return { error: "path が空です。" };
        }
        if (isBlockedPath(targetPath, policy)) {
          return { error: "対象パスは作成禁止です。" };
        }
        const id =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const proposal = {
          id,
          type: "mkdir",
          path: targetPath,
          content: "",
          originalContent: "",
          summary,
          isNewFile: true,
          conversationId,
        };
        this.proposals.set(id, proposal);
        this.sendToRenderer("agent:proposal", { proposal });
        if (this.agentOptions.autoApply) {
          await this.applyProposal(id);
        }
        return { status: "proposed", proposalId: id };
      }

      return { error: `unknown tool: ${name}` };
    } catch (error) {
      return { error: error?.message ?? "tool error" };
    }
  }

  async run({ message, context, conversationId = "default" }) {
    const rootPath = this.workspace.getRootPath();
    if (!rootPath) {
      this.sendToRenderer("agent:error", {
        message: "ワークスペースが選択されていません。",
        conversationId,
      });
      this.sendStatus("error", "ワークスペースが未選択です。", conversationId);
      return;
    }

    this.sendStatus("running", this.buildProgressMessage("準備中"), conversationId);
    const settings = await this.ensureUserSettings().getAgentSettings();
    const policy = this.resolveAgentPolicy(settings);
    const options = this.resolveAgentOptions(settings);
    this.contextByConversation.set(conversationId, context ?? {});
    const proxyUrl = (
      typeof process.env.TEX64_AI_PROXY_URL === "string"
        ? process.env.TEX64_AI_PROXY_URL.trim()
        : ""
    ).trim();
    const resolvedProxyUrl = proxyUrl || "https://tex64.vercel.app/api/ai-chat";

    const conversation = this.buildConversation(conversationId);
    conversation.push({ role: "user", parts: [{ text: message }] });

    const systemPrompt = buildSystemPrompt(context, rootPath, policy);
    const tools = [{ functionDeclarations: AGENT_TOOL_DECLARATIONS }];
    const generationConfig = {
      temperature: settings.temperature ?? 0.2,
      maxOutputTokens: settings.maxOutputTokens ?? 2048,
    };

    this.sendStatus("running", this.buildProgressMessage("文脈整理中"), conversationId);
    this.abort();
    this.abortController = new AbortController();

    for (let i = 0; i < options.maxIterations; i += 1) {
      try {
        const thinkingLabel = i === 0 ? "方針検討中" : "追加検討中";
        this.sendStatus("running", this.buildProgressMessage(thinkingLabel), conversationId);
        const handleDelta =
          options.stream === true
            ? (text) => {
                if (text) {
                  this.sendToRenderer("agent:messageDelta", { text, conversationId });
                }
              }
            : null;
        const response = await requestGemini({
          proxyUrl: resolvedProxyUrl,
          contents: conversation,
          systemInstruction: { parts: [{ text: systemPrompt }] },
          tools,
          toolConfig: { functionCallingConfig: { mode: "AUTO" } },
          generationConfig,
          signal: this.abortController.signal,
          onDelta: handleDelta,
        });

        const candidate = response?.candidates?.[0]?.content ?? null;
        const parts = candidate?.parts ?? [];
        const functionCalls = parts.filter((part) => part.functionCall);
        const textParts = parts
          .map((part) => part.text)
          .filter((text) => typeof text === "string" && text.trim().length > 0);

        if (candidate) {
          conversation.push(candidate);
        }

        if (functionCalls.length > 0) {
          for (const part of functionCalls) {
            const call = part.functionCall;
            const result = await this.executeToolCall(call, conversationId);
            this.sendToRenderer("agent:tool", {
              name: call.name,
              summary: result?.error ?? "ok",
              conversationId,
            });
            conversation.push({
              role: "tool",
              parts: [
                {
                  functionResponse: {
                    name: call.name,
                    response: result,
                  },
                },
              ],
            });
          }
          continue;
        }

        if (textParts.length > 0) {
          const text = textParts.join("\n");
          this.sendStatus("running", this.buildProgressMessage("回答整形中"), conversationId);
          this.sendToRenderer("agent:message", { text, conversationId });
          this.sendStatus("idle", "待機中", conversationId);
          return;
        }

        this.sendToRenderer("agent:message", {
          text: "応答が空でした。",
          conversationId,
        });
        this.sendStatus("idle", "待機中", conversationId);
        return;
      } catch (error) {
        if (error?.name === "AbortError") {
          this.sendStatus("idle", "中断しました。", conversationId);
          return;
        }
        this.sendToRenderer("agent:error", {
          message: error?.message ?? "AIの呼び出しに失敗しました。",
          conversationId,
        });
        this.sendStatus("error", "AIエラー", conversationId);
        return;
      }
    }

    this.sendToRenderer("agent:message", {
      text: "上限回数に達したため停止しました。",
      conversationId,
    });
    this.sendStatus("idle", "待機中", conversationId);
  }
}

module.exports = {
  AgentService,
};
