const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { normalizePath } = require("./agent-policy.cjs");

const DEFAULT_TERMINAL_HISTORY_CHARS = 1_000_000;
const DEFAULT_TERMINAL_READ_CHARS = 24_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

const clampNumber = (value, fallback, { min, max }) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

const trimHead = (value, maxChars) => {
  if (typeof value !== "string") {
    return "";
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return value;
  }
  return value.length > maxChars ? value.slice(value.length - maxChars) : value;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const nowTs = () => Date.now();

const randomId = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

const resolveWorkspaceCwd = (service, cwdArg) => {
  const rootPath = service.workspace.getRootPath();
  if (!rootPath) {
    return { error: "ワークスペースが選択されていません。" };
  }
  if (typeof cwdArg !== "string" || !cwdArg.trim()) {
    return { cwd: rootPath };
  }
  try {
    const resolved = service.workspace.resolvePath(normalizePath(cwdArg));
    return { cwd: resolved };
  } catch {
    return { error: "cwd が不正です。" };
  }
};

const resolveShell = (shellArg) => {
  const fromArg = typeof shellArg === "string" ? shellArg.trim() : "";
  if (fromArg) {
    return fromArg;
  }
  if (typeof process.env.SHELL === "string" && process.env.SHELL.trim()) {
    return process.env.SHELL.trim();
  }
  return "/bin/zsh";
};

const ensureTerminalMap = (service) => {
  if (!(service.terminalsById instanceof Map)) {
    service.terminalsById = new Map();
  }
  if (!(service.terminalIdsByConversation instanceof Map)) {
    service.terminalIdsByConversation = new Map();
  }
};

const registerTerminal = (service, conversationId, terminal) => {
  ensureTerminalMap(service);
  service.terminalsById.set(terminal.id, terminal);
  const normalizedConversationId =
    typeof conversationId === "string" && conversationId.trim()
      ? conversationId.trim()
      : "default";
  if (!service.terminalIdsByConversation.has(normalizedConversationId)) {
    service.terminalIdsByConversation.set(normalizedConversationId, new Set());
  }
  service.terminalIdsByConversation.get(normalizedConversationId).add(terminal.id);
};

const unregisterTerminal = (service, terminalId, conversationId) => {
  if (!(service.terminalsById instanceof Map)) {
    return;
  }
  const terminal = service.terminalsById.get(terminalId);
  if (terminal) {
    terminal.closed = true;
  }
  service.terminalsById.delete(terminalId);
  if (service.terminalIdsByConversation instanceof Map) {
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    const ids = service.terminalIdsByConversation.get(normalizedConversationId);
    if (ids instanceof Set) {
      ids.delete(terminalId);
      if (ids.size === 0) {
        service.terminalIdsByConversation.delete(normalizedConversationId);
      }
    }
  }
};

const appendTerminalOutput = (terminal, channel, text) => {
  const value = typeof text === "string" ? text : "";
  if (!value) {
    return;
  }
  terminal.updatedAt = nowTs();
  if (channel === "stderr") {
    terminal.stderr = trimHead(
      `${terminal.stderr}${value}`,
      terminal.maxHistoryChars
    );
  } else {
    terminal.stdout = trimHead(
      `${terminal.stdout}${value}`,
      terminal.maxHistoryChars
    );
  }
  const combinedNext = `${terminal.combined}${value}`;
  if (combinedNext.length > terminal.maxHistoryChars) {
    const overflow = combinedNext.length - terminal.maxHistoryChars;
    terminal.outputBaseOffset += overflow;
    terminal.combined = combinedNext.slice(overflow);
  } else {
    terminal.combined = combinedNext;
  }
};

const settleWaiter = (terminal, payload) => {
  const waiter = terminal.waiter;
  if (!waiter) {
    return;
  }
  if (waiter.timer) {
    clearTimeout(waiter.timer);
  }
  terminal.waiter = null;
  waiter.resolve(payload);
};

const checkTerminalWaiter = (terminal) => {
  const waiter = terminal.waiter;
  if (!waiter) {
    return;
  }
  const stdoutSlice = terminal.stdout.slice(waiter.stdoutStart);
  const markerPattern = new RegExp(
    `${escapeRegExp(waiter.marker)}:(-?\\d+)`,
    "m"
  );
  const markerMatch = markerPattern.exec(stdoutSlice);
  if (!markerMatch) {
    return;
  }
  const markerIndex = markerMatch.index;
  const exitCode = Number.parseInt(markerMatch[1], 10);
  const stdout = stdoutSlice.slice(0, markerIndex);
  const stderr = terminal.stderr.slice(waiter.stderrStart);
  settleWaiter(terminal, {
    sessionId: terminal.id,
    status: Number.isFinite(exitCode) && exitCode === 0 ? "success" : "failure",
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    stdout,
    stderr,
    timedOut: false,
  });
};

const buildTerminalSession = (service, conversationId, { cwd, shell }) => {
  const proc = spawn(shell, ["-l"], {
    cwd,
    env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const terminal = {
    id: randomId(),
    conversationId,
    proc,
    shell,
    cwd,
    createdAt: nowTs(),
    updatedAt: nowTs(),
    closed: false,
    stdout: "",
    stderr: "",
    combined: "",
    outputBaseOffset: 0,
    maxHistoryChars: DEFAULT_TERMINAL_HISTORY_CHARS,
    queue: Promise.resolve(),
    waiter: null,
  };

  proc.stdout?.on("data", (chunk) => {
    appendTerminalOutput(terminal, "stdout", chunk?.toString("utf8") ?? "");
    checkTerminalWaiter(terminal);
  });
  proc.stderr?.on("data", (chunk) => {
    appendTerminalOutput(terminal, "stderr", chunk?.toString("utf8") ?? "");
    checkTerminalWaiter(terminal);
  });
  proc.on("error", (error) => {
    const message =
      typeof error?.message === "string" && error.message
        ? error.message
        : "terminal process error";
    appendTerminalOutput(terminal, "stderr", `${message}\n`);
    if (terminal.waiter) {
      settleWaiter(terminal, {
        sessionId: terminal.id,
        status: "error",
        exitCode: null,
        stdout: "",
        stderr: message,
        timedOut: false,
        error: message,
      });
    }
  });
  proc.on("close", (code, signal) => {
    terminal.closed = true;
    terminal.updatedAt = nowTs();
    if (terminal.waiter) {
      settleWaiter(terminal, {
        sessionId: terminal.id,
        status: "closed",
        exitCode: Number.isFinite(code) ? code : null,
        stdout: "",
        stderr: `terminal closed${signal ? ` (${signal})` : ""}`,
        timedOut: false,
        error: "terminal closed",
      });
    }
    unregisterTerminal(service, terminal.id, terminal.conversationId);
  });

  registerTerminal(service, conversationId, terminal);
  return terminal;
};

const getTerminalById = (service, sessionId) => {
  ensureTerminalMap(service);
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) {
    return null;
  }
  const terminal = service.terminalsById.get(id) ?? null;
  if (!terminal || terminal.closed) {
    return null;
  }
  return terminal;
};

const ensureTerminalSession = async (service, args, conversationId) => {
  const requestedSessionId =
    typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
  if (requestedSessionId) {
    const terminal = getTerminalById(service, requestedSessionId);
    if (!terminal) {
      return { error: "sessionId が見つからないか終了済みです。" };
    }
    return { terminal };
  }

  const cwdInfo = resolveWorkspaceCwd(service, args?.cwd);
  if (cwdInfo.error) {
    return { error: cwdInfo.error };
  }
  const shell = resolveShell(args?.shell);
  const terminal = buildTerminalSession(service, conversationId, {
    cwd: cwdInfo.cwd,
    shell,
  });
  return { terminal, created: true };
};

const executeQueuedCommand = (terminal, command, timeoutMs) =>
  new Promise((resolve) => {
    if (terminal.closed || !terminal.proc || terminal.proc.killed) {
      resolve({
        sessionId: terminal.id,
        status: "closed",
        exitCode: null,
        stdout: "",
        stderr: "terminal session is closed",
        timedOut: false,
        error: "terminal closed",
      });
      return;
    }

    const marker = `__TEX64_CMD_DONE_${randomId()}__`;
    const stdoutStart = terminal.stdout.length;
    const stderrStart = terminal.stderr.length;
    const commandText = typeof command === "string" ? command : "";
    terminal.waiter = {
      marker,
      stdoutStart,
      stderrStart,
      resolve,
      timer: null,
    };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      terminal.waiter.timer = setTimeout(() => {
        if (terminal.waiter?.marker !== marker) {
          return;
        }
        try {
          terminal.proc.stdin.write("\u0003");
        } catch {
          // noop
        }
        settleWaiter(terminal, {
          sessionId: terminal.id,
          status: "timeout",
          exitCode: null,
          stdout: terminal.stdout.slice(stdoutStart),
          stderr: terminal.stderr.slice(stderrStart),
          timedOut: true,
          error: "command timed out",
        });
      }, timeoutMs);
    }

    try {
      const commandPayload = [
        commandText,
        `printf '${marker}:%s\\n' \"$?\"`,
      ].join("\n");
      terminal.proc.stdin.write(`${commandPayload}\n`);
    } catch (error) {
      settleWaiter(terminal, {
        sessionId: terminal.id,
        status: "error",
        exitCode: null,
        stdout: "",
        stderr: error?.message ?? "stdin write failed",
        timedOut: false,
        error: error?.message ?? "stdin write failed",
      });
    }
  });

const openTerminalSession = async (service, args, conversationId) => {
  const session = await ensureTerminalSession(service, args, conversationId);
  if (session.error) {
    return { error: session.error };
  }
  const terminal = session.terminal;
  return {
    status: "ready",
    sessionId: terminal.id,
    created: Boolean(session.created),
    shell: terminal.shell,
    cwd: terminal.cwd,
  };
};

const executeBashCommand = async (service, args, conversationId) => {
  const command = typeof args?.command === "string" ? args.command : "";
  if (!command.trim()) {
    return { error: "command が空です。" };
  }
  const session = await ensureTerminalSession(service, args, conversationId);
  if (session.error) {
    return { error: session.error };
  }
  const terminal = session.terminal;
  const timeoutMs = clampNumber(args?.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, {
    min: 1000,
    max: MAX_COMMAND_TIMEOUT_MS,
  });
  const queue = terminal.queue
    .catch(() => null)
    .then(() => executeQueuedCommand(terminal, command, timeoutMs));
  terminal.queue = queue.then(() => null).catch(() => null);
  const result = await queue;
  return {
    ...result,
    sessionId: terminal.id,
    created: Boolean(session.created),
  };
};

const sendTerminalInput = async (service, args) => {
  const terminal = getTerminalById(service, args?.sessionId);
  if (!terminal) {
    return { error: "sessionId が見つからないか終了済みです。" };
  }
  const chars = typeof args?.chars === "string" ? args.chars : "";
  if (!chars) {
    return { error: "chars が空です。" };
  }
  try {
    terminal.proc.stdin.write(chars);
    terminal.updatedAt = nowTs();
    return { status: "sent", sessionId: terminal.id, length: chars.length };
  } catch (error) {
    return { error: error?.message ?? "入力送信に失敗しました。" };
  }
};

const readTerminalOutput = async (service, args) => {
  const terminal = getTerminalById(service, args?.sessionId);
  if (!terminal) {
    return { error: "sessionId が見つからないか終了済みです。" };
  }
  const sinceRaw = Number(args?.since);
  const since = Number.isFinite(sinceRaw) ? Math.max(0, Math.round(sinceRaw)) : 0;
  const maxChars = clampNumber(args?.maxChars, DEFAULT_TERMINAL_READ_CHARS, {
    min: 128,
    max: 200_000,
  });
  const safeSince = Math.max(since, terminal.outputBaseOffset);
  const startIndex = Math.max(0, safeSince - terminal.outputBaseOffset);
  const source = terminal.combined.slice(startIndex);
  const output = source.length > maxChars ? source.slice(0, maxChars) : source;
  const nextSince = safeSince + output.length;
  return {
    sessionId: terminal.id,
    output,
    nextSince,
    truncated: safeSince > since,
    hasMore: source.length > output.length,
    closed: terminal.closed === true,
  };
};

const killTerminalSession = async (service, args) => {
  const terminal = getTerminalById(service, args?.sessionId);
  if (!terminal) {
    return { error: "sessionId が見つからないか終了済みです。" };
  }
  const signal = typeof args?.signal === "string" && args.signal.trim() ? args.signal.trim() : "SIGTERM";
  try {
    terminal.proc.kill(signal);
    unregisterTerminal(service, terminal.id, terminal.conversationId);
    return { status: "killed", sessionId: terminal.id, signal };
  } catch (error) {
    return { error: error?.message ?? "terminal の停止に失敗しました。" };
  }
};

const terminateConversationTerminals = (service, conversationId) => {
  ensureTerminalMap(service);
  const normalizedConversationId =
    typeof conversationId === "string" && conversationId.trim()
      ? conversationId.trim()
      : "default";
  const ids = service.terminalIdsByConversation.get(normalizedConversationId);
  if (!(ids instanceof Set) || ids.size === 0) {
    return;
  }
  Array.from(ids).forEach((id) => {
    const terminal = service.terminalsById.get(id);
    if (!terminal) {
      return;
    }
    try {
      terminal.proc.kill("SIGTERM");
    } catch {
      // noop
    }
    unregisterTerminal(service, terminal.id, normalizedConversationId);
  });
};

const terminateAllTerminals = (service) => {
  ensureTerminalMap(service);
  const terminals = Array.from(service.terminalsById.values());
  terminals.forEach((terminal) => {
    if (!terminal || terminal.closed) {
      return;
    }
    try {
      terminal.proc.kill("SIGTERM");
    } catch {
      // noop
    }
    unregisterTerminal(service, terminal.id, terminal.conversationId);
  });
};

module.exports = {
  openTerminalSession,
  executeBashCommand,
  sendTerminalInput,
  readTerminalOutput,
  killTerminalSession,
  terminateConversationTerminals,
  terminateAllTerminals,
};
