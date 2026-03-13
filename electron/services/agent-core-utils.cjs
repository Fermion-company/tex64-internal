const path = require("path");
const crypto = require("crypto");
const { normalizePath } = require("./agent-policy.cjs");

const TOOL_STATUS_LABELS = {
  read_file: "ファイル確認中",
  list_files: "構成把握中",
  propose_patch: "変更案作成中",
  apply_patch: "変更案作成中",
  get_compile_log: "ログ確認中",
  arxiv_search: "arXiv検索中",
  arxiv_bibtex: "BibTeX取得中",
};
const MAX_USER_INLINE_DATA_BYTES = 5 * 1024 * 1024;
const MAX_USER_INLINE_DATA_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_APPLY_UNDO_ENTRIES = 200;
const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
const REQUEST_HISTORY_MAX_MESSAGES = 48;
const REQUEST_HISTORY_MAX_CHARS = 128_000;
const BASE64_DATA_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DEFAULT_PREFETCH_FILES_LIMIT = 3;
const PREFETCH_FILE_MENTION_PATTERN =
  /(?:^|[^A-Za-z0-9_./-])([A-Za-z0-9_./-]+\.(?:tex|bib|sty|cls|ltx|dtx|md|txt|json|ya?ml|toml|js|ts|cjs|mjs|css|html))(?![A-Za-z0-9_./-])/gi;
// Turn-level routing heuristics:
// - Avoid dragging edit context into plain greetings / standalone Q&A.
// - Avoid leaking internal tool names / file names when the user is not asking about the workspace.
const GREETING_ONLY_PATTERN =
  /^(?:こんにちは|こんばんは|おはよう(?:ございます)?|もしもし|やあ|こんちは|はじめまして|おい|ねえ|hi|hello|hey)[!！。.\s]*$/i;
const TOPIC_RESET_PATTERN =
  /(?:話題変|別件|関係ないけど|余談|ところで|最初から|これまでの話.*無視|前の話.*無視|前の話.*忘れて|全部忘れて)/i;
const CONTINUATION_CUE_PATTERN =
  /(?:それ|これ|あれ|さっき|先ほど|前の|前回|続き|上の|上記|この件|それについて|これについて|as\s+above|previous|earlier|that\s+(?:one|part)|this\s+(?:one|part)|それでいい|OK|ok|いいよ|了解|うん|そうして|そうする|続けて|continue)/i;
const CAPABILITY_QUESTION_PATTERN =
  /(?:何ができる|できること|できる機能|能力|capabilit|what\s+can\s+you\s+do|help\s+me\s+with)/i;
const DOCUMENT_TOPIC_HINT_PATTERN =
  /(?:latex|tex|\.tex\b|\\(?:documentclass|begin|end|section|subsection|label|ref|eqref|cite|input|include)\b|タイトル|著者|日付|概要|abstract|章|節|セクション|本文|段落|見出し|図|表|数式|引用|参照|ラベル|ビルド|compile|コンパイル|latexmk|lualatex|pdflatex|xelatex|uplatex|log|エラー|警告|overfull|undefined\s+(?:control|citation|reference))/i;
const EDIT_REQUEST_PATTERN =
  /(変えて|変える|変更して|変更する|修正して|修正する|直して|直す|なおして|なおす|書いて|書く|執筆して|執筆する|書き換えて|書き換える|書き足して|書き足す|書き加えて|書き加える|置換して|置換する|追加して|追加する|削除して|削除する|更新して|更新する|移動して|移動する|リネームして|リネームする|編集して|編集する|推敲して|推敲する|校正して|校正する|要約して|要約する|翻訳して|翻訳する|生成して|生成する|作成して|作成する|\brename\b|\bchange\b|\bupdate\b|\brewrite\b|\breplace\b|\bedit\b|\bdelete\b|\bremove\b|\binsert\b|\bappend\b|\bmodify\b|\btranslate\b|\bgenerate\b|\bcreate\b|\bwrite\b|\bdraft\b|\bcompose\b)/i;
const VERIFICATION_REQUEST_PATTERN =
  /(ビルド|compile|コンパイル|check|検証|テスト|latexmk|lualatex|pdflatex|xelatex|uplatex)/i;
const QUESTION_LIKE_PATTERN = /[?？]|(?:どう(?:やって|すれば)|how\s+to|how\s+do\s+i|what\s+is)/i;
// Temperature profiles (midpoints of user-requested ranges):
// - research themes / outlines / novel ideas: 0.65-0.8 -> 0.75
// - drafting: 0.4-0.55 -> 0.5
// - proofreading / consistency checks: 0.1-0.25 -> 0.2
const TEMPERATURE_IDEATION = 0.75;
const TEMPERATURE_DRAFT = 0.5;
const TEMPERATURE_VERIFY = 0.2;
const IDEATION_REQUEST_PATTERN =
  /(研究テーマ|テーマ|章構成|構成案|アウトライン|新規提案|アイデア|ブレスト|brainstorm|novel|独創|別案|複数案|(?:3|３)案|提案して|提案を出して)/i;
const DRAFT_REQUEST_PATTERN =
  /(本文|ドラフト|下書き|執筆|書いて|書き起こ|段落|セクション|abstract|アブストラクト|introduction|related\s+work|method|experiments|results|discussion|conclusion|まとめ|今後の課題|beamer|スライド)/i;
const PROOFREAD_REQUEST_PATTERN =
  /(校正|推敲|整合|整合性|チェック|検証|レビュー|誤字|脱字|文法|proofread|typo|consistency|参照切れ|undefined|overfull|warning|error)/i;
// Keep this strict: generic words like "文書/プロジェクト" alone should NOT trigger workspace mode.
const EXPLICIT_WORKSPACE_REFERENCE_PATTERN =
  /(?:\b[\w./-]+\.(?:tex|bib|sty|cls|ltx|md|txt|json|ya?ml|toml)\b|main\.tex|\\(?:input|include)\{|(?:この|今の|現在の|開いている|編集中の|対象の)\s*ファイル|(?:this|current)\s+file)/i;
const PERSIST_SESSION_VERSION = 1;
const PERSIST_MAX_MESSAGES = 140;
const PERSIST_DEBOUNCE_MS = 450;
const PERSIST_MAX_TEXT_CHARS = 50_000;
const PERSIST_MAX_TOOL_CHARS = 80_000;
const PERSIST_MAX_ARG_CHARS = 8_000;
const PERSIST_MAX_DEPTH = 10;
const PERSIST_MAX_ARRAY_LENGTH = 120;
const PERSIST_MAX_OBJECT_KEYS = 120;
const parseNumber = (value, fallback = 0) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};
const parseInteger = (value, fallback = 0) => Math.round(parseNumber(value, fallback));

const digestJson = (value) => {
  try {
    return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
  } catch {
    return null;
  }
};

const clipText = (value, max = 120) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return "";
  }
  const limit = Number.isFinite(max) ? Math.max(16, Math.round(max)) : 120;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

const clipLongString = (value, maxChars) => {
  if (typeof value !== "string") {
    return "";
  }
  const limit = Number.isFinite(maxChars)
    ? Math.max(256, Math.round(maxChars))
    : PERSIST_MAX_TEXT_CHARS;
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}…`;
};

const sanitizeForPersistence = (
  value,
  {
    maxStringChars = PERSIST_MAX_TEXT_CHARS,
    maxDepth = PERSIST_MAX_DEPTH,
    maxArrayLength = PERSIST_MAX_ARRAY_LENGTH,
    maxObjectKeys = PERSIST_MAX_OBJECT_KEYS,
  } = {},
  depth = 0
) => {
  if (depth > maxDepth) {
    return null;
  }
  if (value === null || value === undefined) {
    return null;
  }
  const type = typeof value;
  if (type === "string") {
    return clipLongString(value, maxStringChars);
  }
  if (type === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (type === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const limited = value.length > maxArrayLength ? value.slice(0, maxArrayLength) : value;
    return limited.map((entry) =>
      sanitizeForPersistence(
        entry,
        { maxStringChars, maxDepth, maxArrayLength, maxObjectKeys },
        depth + 1
      )
    );
  }
  if (type !== "object") {
    return null;
  }
  const keys = Object.keys(value);
  const limitedKeys = keys.length > maxObjectKeys ? keys.slice(0, maxObjectKeys) : keys;
  const result = {};
  limitedKeys.forEach((key) => {
    result[key] = sanitizeForPersistence(
      value[key],
      { maxStringChars, maxDepth, maxArrayLength, maxObjectKeys },
      depth + 1
    );
  });
  return result;
};

/**
 * Sanitize a conversation for persistence.
 * Handles OpenAI format ({ role, content }) entries.
 */
const sanitizeConversationForPersistence = (conversation) => {
  const source = Array.isArray(conversation) ? conversation : [];
  const windowed =
    source.length > PERSIST_MAX_MESSAGES
      ? source.slice(source.length - PERSIST_MAX_MESSAGES)
      : source;
  const sanitized = [];
  windowed.forEach((message) => {
    if (!message || typeof message !== "object") {
      return;
    }
    const role =
      typeof message.role === "string" && message.role.trim() ? message.role.trim() : "user";
    const content = typeof message.content === "string" ? message.content : "";
    if (!content.trim()) {
      return;
    }
    sanitized.push({
      role,
      content: clipLongString(content, PERSIST_MAX_TEXT_CHARS),
    });
  });
  return sanitized;
};

const summarizeToolArgs = (toolName, argsLike) => {
  const args = argsLike && typeof argsLike === "object" ? argsLike : {};
  const name = typeof toolName === "string" ? toolName : "";
  if (name === "read_file") {
    return {
      path: clipText(args.path, 260),
      encoding: clipText(args.encoding, 20) || (args.binary === true ? "base64" : "utf8"),
    };
  }
  if (name === "read_files") {
    const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === "string") : [];
    return {
      count: paths.length,
      paths: paths.slice(0, 5).map((p) => clipText(p, 200)),
      encoding: clipText(args.encoding, 20) || (args.binary === true ? "base64" : "utf8"),
    };
  }
  if (name === "search_files") {
    return { query: clipText(args.query, 120) };
  }
  if (name === "list_files") {
    return { directory: clipText(args.directory, 260) };
  }
  if (name === "get_project_structure") {
    return { maxDepth: Number.isFinite(args.maxDepth) ? Math.round(args.maxDepth) : null };
  }
  if (name === "get_index") {
    return {
      kinds: Array.isArray(args.kinds) ? args.kinds.slice(0, 10).map((k) => clipText(k, 40)) : [],
      query: clipText(args.query, 120),
      limit: Number.isFinite(args.limit) ? Math.round(args.limit) : null,
    };
  }
  if (name === "rename_latex_symbol") {
    return {
      from: clipText(args.from, 80),
      to: clipText(args.to, 80),
      kinds: Array.isArray(args.kinds) ? args.kinds.slice(0, 10).map((k) => clipText(k, 40)) : [],
    };
  }
  if (name === "run_build") {
    return {
      mainFile: clipText(args.mainFile, 260),
      engine: clipText(args.engine, 20),
    };
  }
  if (name === "run_command") {
    return {
      command: clipText(args.command, 260),
      cwd: clipText(args.cwd, 260),
      timeoutMs: Number.isFinite(args.timeoutMs) ? Math.round(args.timeoutMs) : null,
    };
  }
  if (name === "open_terminal_session") {
    return {
      shell: clipText(args.shell, 120),
      cwd: clipText(args.cwd, 260),
    };
  }
  if (name === "execute_bash_command") {
    return {
      sessionId: clipText(args.sessionId, 80),
      command: clipText(args.command, 260),
      cwd: clipText(args.cwd, 260),
      timeoutMs: Number.isFinite(args.timeoutMs) ? Math.round(args.timeoutMs) : null,
    };
  }
  if (name === "send_terminal_input") {
    return {
      sessionId: clipText(args.sessionId, 80),
      charsLength: typeof args.chars === "string" ? args.chars.length : 0,
    };
  }
  if (name === "read_terminal_output") {
    return {
      sessionId: clipText(args.sessionId, 80),
      since: Number.isFinite(args.since) ? Math.round(args.since) : null,
      maxChars: Number.isFinite(args.maxChars) ? Math.round(args.maxChars) : null,
    };
  }
  if (name === "kill_terminal") {
    return {
      sessionId: clipText(args.sessionId, 80),
      signal: clipText(args.signal, 24),
    };
  }
  if (name === "search_web") {
    return {
      query: clipText(args.query, 220),
      limit: Number.isFinite(args.limit) ? Math.round(args.limit) : null,
      timeoutMs: Number.isFinite(args.timeoutMs) ? Math.round(args.timeoutMs) : null,
    };
  }
  if (name === "read_url") {
    return {
      url: clipText(args.url, 260),
      maxChars: Number.isFinite(args.maxChars) ? Math.round(args.maxChars) : null,
      timeoutMs: Number.isFinite(args.timeoutMs) ? Math.round(args.timeoutMs) : null,
    };
  }
  if (name === "get_app_settings") {
    return { keys: Array.isArray(args.keys) ? args.keys.slice(0, 40).map((k) => clipText(k, 60)) : [] };
  }
  if (name === "set_app_settings") {
    const settings =
      args.settings && typeof args.settings === "object" && !Array.isArray(args.settings)
        ? args.settings
        : {};
    return { keys: Object.keys(settings).slice(0, 40).map((k) => clipText(k, 60)) };
  }
  if (name === "read_scratchpad") {
    return {};
  }
  if (name === "write_scratchpad") {
    return {
      mode: clipText(args.mode, 20),
      contentChars: typeof args.content === "string" ? args.content.length : 0,
    };
  }
  if (name === "propose_write") {
    return { path: clipText(args.path, 260), contentChars: typeof args.content === "string" ? args.content.length : 0 };
  }
  if (name === "write_file") {
    return { path: clipText(args.path, 260), contentChars: typeof args.content === "string" ? args.content.length : 0 };
  }
  if (name === "propose_patch") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    return {
      path: clipText(args.path, 260),
      edits: edits.length,
      replaceAll: args.replaceAll === true,
    };
  }
  if (name === "patch_file") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    return {
      path: clipText(args.path, 260),
      edits: edits.length,
      replaceAll: args.replaceAll === true,
    };
  }
  if (name === "replace_lines") {
    return {
      path: clipText(args.path, 260),
      startLine: Number.isFinite(args.startLine) ? Math.round(args.startLine) : null,
      endLine: Number.isFinite(args.endLine) ? Math.round(args.endLine) : null,
      contentChars: typeof args.content === "string" ? args.content.length : 0,
    };
  }
  if (name === "propose_delete") {
    return { path: clipText(args.path, 260) };
  }
  if (name === "delete_file") {
    return { path: clipText(args.path, 260) };
  }
  if (name === "propose_rename") {
    return { oldPath: clipText(args.oldPath, 260), newPath: clipText(args.newPath, 260) };
  }
  if (name === "rename_file") {
    return { oldPath: clipText(args.oldPath, 260), newPath: clipText(args.newPath, 260) };
  }
  if (name === "propose_create_directory") {
    return { path: clipText(args.path, 260) };
  }
  if (name === "create_directory") {
    return { path: clipText(args.path, 260) };
  }
  return { keys: Object.keys(args).slice(0, 40).map((k) => clipText(k, 60)) };
};

const summarizeToolResult = (toolName, resultLike) => {
  const result = resultLike && typeof resultLike === "object" ? resultLike : {};
  const name = typeof toolName === "string" ? toolName : "";
  const error = typeof result.error === "string" && result.error ? clipText(result.error, 260) : "";
  const base = {
    ok: !error,
    error: error || null,
  };
  if (name === "read_file") {
    const encoding = typeof result.encoding === "string" ? result.encoding : "utf8";
    const content = typeof result.content === "string" ? result.content : "";
    const bytes =
      encoding === "base64" ? Math.round(content.length * 0.75) : Buffer.byteLength(content, "utf8");
    return {
      ...base,
      encoding,
      bytes,
      binary: result.binary === true,
      partial: result.partial === true,
      source: typeof result.source === "string" ? result.source : null,
    };
  }
  if (name === "read_files") {
    const files = result.files && typeof result.files === "object" ? result.files : {};
    const entries = Object.values(files);
    const errorCount = entries.filter((entry) => entry && typeof entry === "object" && typeof entry.error === "string" && entry.error).length;
    return {
      ...base,
      fileCount: Object.keys(files).length,
      errorCount,
    };
  }
  if (name === "search_files") {
    const results = Array.isArray(result.results) ? result.results : [];
    return {
      ...base,
      resultCount: results.length,
      sample: results.slice(0, 5).map((entry) => ({
        path: clipText(entry?.path, 260),
        line: typeof entry?.line === "number" ? entry.line : null,
      })),
    };
  }
  if (
    name === "open_terminal_session" ||
    name === "execute_bash_command" ||
    name === "send_terminal_input" ||
    name === "read_terminal_output" ||
    name === "kill_terminal"
  ) {
    return {
      ...base,
      status: typeof result.status === "string" ? result.status : null,
      sessionId: clipText(result.sessionId, 80) || null,
      exitCode:
        typeof result.exitCode === "number" && Number.isFinite(result.exitCode)
          ? result.exitCode
          : null,
      stdoutChars: typeof result.stdout === "string" ? result.stdout.length : 0,
      stderrChars: typeof result.stderr === "string" ? result.stderr.length : 0,
      outputChars: typeof result.output === "string" ? result.output.length : 0,
      timedOut: result.timedOut === true,
    };
  }
  if (name === "search_web") {
    const results = Array.isArray(result.results) ? result.results : [];
    return {
      ...base,
      resultCount: results.length,
      sample: results.slice(0, 5).map((entry) => ({
        title: clipText(entry?.title, 80),
        url: clipText(entry?.url, 200),
      })),
    };
  }
  if (name === "read_url") {
    const text = typeof result.text === "string" ? result.text : "";
    return {
      ...base,
      status:
        typeof result.status === "number" && Number.isFinite(result.status)
          ? result.status
          : null,
      url: clipText(result.url, 200) || null,
      contentType: clipText(result.contentType, 80) || null,
      title: clipText(result.title, 120) || null,
      bytes:
        typeof result.bytes === "number" && Number.isFinite(result.bytes) ? result.bytes : null,
      chars: text.length,
      truncated: result.truncated === true,
    };
  }
  if (name === "read_scratchpad" || name === "write_scratchpad") {
    return {
      ...base,
      length: typeof result.length === "number" && Number.isFinite(result.length) ? result.length : null,
      mode: typeof result.mode === "string" ? result.mode : null,
      status: typeof result.status === "string" ? result.status : null,
    };
  }
  if (
    name === "propose_write" ||
    name === "write_file" ||
    name === "propose_patch" ||
    name === "patch_file" ||
    name === "replace_lines" ||
    name === "propose_delete" ||
    name === "delete_file" ||
    name === "propose_rename" ||
    name === "rename_file" ||
    name === "propose_create_directory" ||
    name === "create_directory" ||
    name === "rename_latex_symbol"
  ) {
    const proposalIds = Array.isArray(result.proposalIds) ? result.proposalIds : [];
    const hasSingleProposalId =
      typeof result.proposalId === "string" && result.proposalId.trim().length > 0;
    const files = Array.isArray(result.files) ? result.files : [];
    const appliedCount = files.filter((entry) => entry && entry.ok === true).length;
    const failedCount = files.filter((entry) => entry && entry.ok === false).length;
    return {
      ...base,
      status: typeof result.status === "string" ? result.status : null,
      proposalCount: proposalIds.length > 0 ? proposalIds.length : hasSingleProposalId ? 1 : 0,
      appliedCount,
      failedCount,
      autoBuildStatus:
        result.autoBuild && typeof result.autoBuild === "object"
          ? clipText(result.autoBuild.status, 40) || null
          : null,
    };
  }
  return base;
};

const resolvePrefetchMaxChars = (settings) => {
  const raw = settings?.openFileMaxChars;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 12_000;
  }
  if (raw <= 0) {
    return 50_000;
  }
  return Math.min(50_000, Math.max(2_000, Math.round(raw)));
};

const extractMentionedPaths = (text) => {
  if (typeof text !== "string" || !text.trim()) {
    return [];
  }
  PREFETCH_FILE_MENTION_PATTERN.lastIndex = 0;
  const seen = new Set();
  let match = null;
  while ((match = PREFETCH_FILE_MENTION_PATTERN.exec(text)) !== null) {
    const candidate = normalizePath(match[1]);
    if (candidate) {
      seen.add(candidate);
    }
  }
  return Array.from(seen);
};

const extractTextFromParts = (parts) => {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
};

const normalizeWorkspaceRelativePath = (rootPath, value) => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const resolved =
    path.isAbsolute(raw) && typeof rootPath === "string" && rootPath.trim()
      ? path.relative(rootPath, raw)
      : raw;
  return normalizePath(resolved);
};

const findLastTopicResetIndex = (conversation) => {
  const source = Array.isArray(conversation) ? conversation : [];
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const entry = source[index];
    if (!entry || typeof entry !== "object" || entry.role !== "user") {
      continue;
    }
    const text = (typeof entry.content === "string" ? entry.content : "").trim();
    if (text && TOPIC_RESET_PATTERN.test(text)) {
      return index;
    }
  }
  return -1;
};

const conversationLooksLikeWorkspace = (conversation) => {
  const source = Array.isArray(conversation) ? conversation : [];
  const resetIndex = findLastTopicResetIndex(source);
  const start = Math.max(0, resetIndex + 1);
  const lookbackLimit = 10;
  let seen = 0;
  for (let index = source.length - 1; index >= start; index -= 1) {
    const entry = source[index];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (entry.role === "tool") {
      return true;
    }
    if (entry.role !== "user" && entry.role !== "assistant") {
      continue;
    }
    const text = (typeof entry.content === "string" ? entry.content : "").trim();
    if (!text) {
      continue;
    }
    if (
      DOCUMENT_TOPIC_HINT_PATTERN.test(text) ||
      EXPLICIT_WORKSPACE_REFERENCE_PATTERN.test(text) ||
      EDIT_REQUEST_PATTERN.test(text) ||
      VERIFICATION_REQUEST_PATTERN.test(text)
    ) {
      return true;
    }
    seen += 1;
    if (seen >= lookbackLimit) {
      break;
    }
  }
  return false;
};

const deriveTurnRouting = (userText, conversation) => {
  const text = typeof userText === "string" ? userText.trim() : "";
  const greetingOnly = Boolean(text && GREETING_ONLY_PATTERN.test(text));
  const topicReset = Boolean(text && TOPIC_RESET_PATTERN.test(text));
  const capabilityQuestion = Boolean(text && CAPABILITY_QUESTION_PATTERN.test(text));
  const continuationCue = Boolean(text && CONTINUATION_CUE_PATTERN.test(text));
  const explicitWorkspaceRef = Boolean(text && EXPLICIT_WORKSPACE_REFERENCE_PATTERN.test(text));
  const docHint = Boolean(text && DOCUMENT_TOPIC_HINT_PATTERN.test(text));
  const editRequest = Boolean(text && EDIT_REQUEST_PATTERN.test(text));
  const verifyRequest = Boolean(text && VERIFICATION_REQUEST_PATTERN.test(text));
  const draftRequest = Boolean(text && DRAFT_REQUEST_PATTERN.test(text));
  const proofreadRequest = Boolean(text && PROOFREAD_REQUEST_PATTERN.test(text));
  const conversationIsWorkspaceLike = conversationLooksLikeWorkspace(conversation);
  const wantsWorkspace = Boolean(
    explicitWorkspaceRef || docHint || editRequest || verifyRequest || draftRequest || proofreadRequest
  );
  const continueWorkspace = Boolean(continuationCue && conversationIsWorkspaceLike);
  const capabilityInWorkspace = Boolean(
    capabilityQuestion && (wantsWorkspace || continueWorkspace || conversationIsWorkspaceLike)
  );
  const useWorkspaceContext =
    !greetingOnly && !topicReset && (wantsWorkspace || continueWorkspace || capabilityInWorkspace);
  const mode = greetingOnly ? "smalltalk" : useWorkspaceContext ? "workspace" : "standalone";
  const questionLike = Boolean(text && QUESTION_LIKE_PATTERN.test(text));
  const pureCapabilityQuestion = capabilityQuestion && !editRequest && !verifyRequest;
  const forceToolCall = verifyRequest ? "build" : editRequest && !questionLike ? "edit" : null;
  return {
    mode,
    useWorkspaceContext,
    disableTools: mode !== "workspace" || pureCapabilityQuestion,
    forceToolCall,
    capabilityQuestion,
    pureCapabilityQuestion,
  };
};

const clampTemperature = (value, fallback = 0.2) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, parsed));
};

const deriveTurnTemperature = (userText, routing, settings) => {
  const text = typeof userText === "string" ? userText.trim() : "";
  const base = clampTemperature(settings?.temperature, 1.0);
  if (!text) {
    return { temperature: base, profile: "default" };
  }
  // Keep smalltalk stable and simple.
  if (routing?.mode === "smalltalk") {
    return { temperature: base, profile: "smalltalk" };
  }
  // Verification / consistency checks should be low-variance.
  if (
    routing?.forceToolCall === "build" ||
    VERIFICATION_REQUEST_PATTERN.test(text) ||
    PROOFREAD_REQUEST_PATTERN.test(text)
  ) {
    return { temperature: TEMPERATURE_VERIFY, profile: "verify" };
  }
  // Research ideation benefits from higher diversity.
  if (IDEATION_REQUEST_PATTERN.test(text)) {
    return { temperature: TEMPERATURE_IDEATION, profile: "ideation" };
  }
  // Drafting prefers moderate exploration without going off the rails.
  if (DRAFT_REQUEST_PATTERN.test(text)) {
    return { temperature: TEMPERATURE_DRAFT, profile: "draft" };
  }
  return { temperature: base, profile: "default" };
};

module.exports = {
  TOOL_STATUS_LABELS,
  MAX_USER_INLINE_DATA_BYTES,
  MAX_USER_INLINE_DATA_TOTAL_BYTES,
  MAX_APPLY_UNDO_ENTRIES,
  DEFAULT_CHAT_MODEL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  REQUEST_HISTORY_MAX_MESSAGES,
  REQUEST_HISTORY_MAX_CHARS,
  BASE64_DATA_PATTERN,
  DEFAULT_PREFETCH_FILES_LIMIT,
  GREETING_ONLY_PATTERN,
  CAPABILITY_QUESTION_PATTERN,
  PERSIST_SESSION_VERSION,
  PERSIST_MAX_MESSAGES,
  PERSIST_DEBOUNCE_MS,
  PERSIST_MAX_TEXT_CHARS,
  PERSIST_MAX_TOOL_CHARS,
  PERSIST_MAX_ARG_CHARS,
  PERSIST_MAX_DEPTH,
  PERSIST_MAX_ARRAY_LENGTH,
  PERSIST_MAX_OBJECT_KEYS,
  parseNumber,
  parseInteger,
  digestJson,
  clipText,
  clipLongString,
  sanitizeForPersistence,
  sanitizeConversationForPersistence,
  summarizeToolArgs,
  summarizeToolResult,
  resolvePrefetchMaxChars,
  extractMentionedPaths,
  extractTextFromParts,
  normalizeWorkspaceRelativePath,
  findLastTopicResetIndex,
  deriveTurnRouting,
  deriveTurnTemperature,
};
