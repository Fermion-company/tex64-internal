// Entry point for the detached terminal window (electron/terminal-preload.cjs
// supplies the bridge). One shell, one window — the panel keeps the tabs and
// splitting; this exists so a terminal can live on another display next to the
// editor, which is what issue #38 asked for.

import { getTerminalTheme, TERMINAL_FONT_FAMILY } from "./app/terminal-theme.js";
import type { AppearanceTheme } from "./app/appearance.js";

type TerminalBridge = {
  create: (options?: { cols?: number; rows?: number }) => Promise<{ id?: string; error?: string }>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  kill: (id: string) => void;
  onData: (handler: (msg: { id: string; data: string }) => void) => () => void;
  onExit: (handler: (msg: { id: string; exitCode: number }) => void) => () => void;
};

const theme: AppearanceTheme =
  new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark";

const host = document.getElementById("terminal-window-host");
const bridge = (window as unknown as { tex64Terminal?: TerminalBridge }).tex64Terminal;

const start = async () => {
  const TerminalCtor = (window as unknown as { Terminal?: unknown }).Terminal;
  const fitNamespace = (window as unknown as { FitAddon?: { FitAddon?: unknown } }).FitAddon;
  const FitCtor = fitNamespace && (fitNamespace.FitAddon || fitNamespace);
  if (!host || typeof TerminalCtor !== "function" || typeof FitCtor !== "function" || !bridge) {
    if (host) {
      host.textContent = "Terminal is unavailable in this window.";
    }
    return;
  }

  document.body.style.background = getTerminalTheme(theme).background;

  // eslint-disable-next-line new-cap
  const term = new (TerminalCtor as new (options: unknown) => unknown)({
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 12,
    cursorBlink: true,
    theme: getTerminalTheme(theme),
    scrollback: 5000,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  // eslint-disable-next-line new-cap
  const fitAddon = new (FitCtor as new () => unknown)();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  term.loadAddon(fitAddon as any);
  term.open(host);

  let sessionId: string | null = null;
  const fit = () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fitAddon as any).fit();
    } catch {
      return;
    }
    if (sessionId && term.cols > 0 && term.rows > 0) {
      bridge.resize(sessionId, term.cols, term.rows);
    }
  };
  fit();

  const open = async () => {
    const result = await bridge.create({ cols: term.cols, rows: term.rows });
    if (!result || result.error || !result.id) {
      term.writeln(`\x1b[31mFailed to start terminal: ${result?.error ?? "unknown error"}\x1b[0m`);
      return;
    }
    sessionId = result.id;
    fit();
  };

  bridge.onData((msg) => {
    if (msg && msg.id === sessionId) {
      term.write(msg.data);
    }
  });
  bridge.onExit((msg) => {
    if (msg && msg.id === sessionId) {
      sessionId = null;
      term.writeln("\r\n\x1b[90m[process exited — press any key to start a new shell]\x1b[0m");
    }
  });
  term.onData((data: string) => {
    if (!sessionId) {
      void open();
      return;
    }
    bridge.write(sessionId, data);
  });

  window.addEventListener("resize", () => fit());
  window.addEventListener("beforeunload", () => {
    if (sessionId) {
      bridge.kill(sessionId);
    }
  });

  await open();
  term.focus();
};

void start();
