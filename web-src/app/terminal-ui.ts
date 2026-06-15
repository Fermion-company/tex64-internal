import type { AppContext } from "./context.js";
import {
  getCurrentAppearanceTheme,
  onAppearanceThemeChange,
  type AppearanceTheme,
} from "./appearance.js";

type TerminalBridge = {
  create: (options?: { cols?: number; rows?: number }) => Promise<{ id?: string; error?: string }>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  kill: (id: string) => void;
  onData: (handler: (msg: { id: string; data: string }) => void) => () => void;
  onExit: (handler: (msg: { id: string; exitCode: number }) => void) => () => void;
};

const getBridge = (): TerminalBridge | null => {
  const bridge = (window as unknown as { tex64Terminal?: TerminalBridge }).tex64Terminal;
  return bridge && typeof bridge.create === "function" ? bridge : null;
};

// xterm needs concrete colors (no CSS vars). Keep these aligned with app themes.
const TERMINAL_THEMES = {
  dark: {
    background: "#0e1116",
    foreground: "#cdd3de",
    cursor: "#cdd3de",
    selectionBackground: "rgba(255, 255, 255, 0.18)",
    black: "#1c2129", red: "#f47067", green: "#57ab5a", yellow: "#c69026",
    blue: "#539bf5", magenta: "#b083f0", cyan: "#39c5cf", white: "#adbac7",
    brightBlack: "#636e7b", brightRed: "#ff938a", brightGreen: "#6bc46d",
    brightYellow: "#daaa3f", brightBlue: "#6cb6ff", brightMagenta: "#dcbdfb",
    brightCyan: "#56d4dd", brightWhite: "#cdd9e5",
  },
  light: {
    background: "#ffffff",
    foreground: "#1f2937",
    cursor: "#1d4ed8",
    selectionBackground: "rgba(37, 99, 235, 0.18)",
    black: "#1f2937", red: "#dc2626", green: "#15803d", yellow: "#b45309",
    blue: "#2563eb", magenta: "#9333ea", cyan: "#0891b2", white: "#e5e7eb",
    brightBlack: "#64748b", brightRed: "#ef4444", brightGreen: "#16a34a",
    brightYellow: "#d97706", brightBlue: "#3b82f6", brightMagenta: "#a855f7",
    brightCyan: "#06b6d4", brightWhite: "#f8fafc",
  },
};

const getTerminalTheme = (theme: AppearanceTheme) =>
  TERMINAL_THEMES[theme] ?? TERMINAL_THEMES.dark;

export type TerminalUiApi = {
  /** Called when the Terminal tab becomes visible: starts the session lazily and fits. */
  show: () => void;
  /** Called when the tab/panel is hidden; the session is kept alive. */
  hide: () => void;
  dispose: () => void;
};

export const initTerminalUi = (context: AppContext): TerminalUiApi => {
  const host = context.dom.terminalHost;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let term: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fitAddon: any = null;
  let sessionId: string | null = null;
  let starting = false;
  let termInputDisposer: (() => void) | null = null;
  let sessionDisposers: Array<() => void> = [];
  let resizeObserver: ResizeObserver | null = null;
  let rafId: number | null = null;
  let currentTheme = getCurrentAppearanceTheme();

  const applyTerminalTheme = () => {
    if (term) {
      term.options.theme = { ...getTerminalTheme(currentTheme) };
    }
  };

  const disposeThemeListener = onAppearanceThemeChange((theme) => {
    currentTheme = theme;
    applyTerminalTheme();
  });

  const showMessage = (text: string) => {
    if (host) {
      host.textContent = text;
    }
  };

  const clearSessionDisposers = () => {
    sessionDisposers.forEach((d) => {
      try {
        d();
      } catch {
        /* ignore */
      }
    });
    sessionDisposers = [];
  };

  const fitNow = () => {
    if (!term || !fitAddon || !host) {
      return;
    }
    if (host.clientWidth === 0 || host.clientHeight === 0) {
      return;
    }
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    const bridge = getBridge();
    if (bridge && sessionId && term.cols > 0 && term.rows > 0) {
      bridge.resize(sessionId, term.cols, term.rows);
    }
  };

  const scheduleFit = () => {
    if (rafId !== null) {
      return;
    }
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      fitNow();
    });
  };

  const startSession = async () => {
    const bridge = getBridge();
    if (!bridge || !term || sessionId) {
      return;
    }
    clearSessionDisposers();
    const result = await bridge.create({ cols: term.cols, rows: term.rows });
    if (!result || result.error || !result.id) {
      const reason = result && result.error ? result.error : "unknown error";
      term.writeln(`\x1b[31mFailed to start terminal: ${reason}\x1b[0m`);
      return;
    }
    sessionId = result.id;
    const offData = bridge.onData((msg) => {
      if (msg && msg.id === sessionId && term) {
        term.write(msg.data);
      }
    });
    const offExit = bridge.onExit((msg) => {
      if (msg && msg.id === sessionId) {
        sessionId = null;
        if (term) {
          term.writeln(
            "\r\n\x1b[90m[process exited — reopen Terminal to start a new session]\x1b[0m"
          );
        }
      }
    });
    sessionDisposers.push(offData, offExit);
  };

  const ensureStarted = async () => {
    if (term) {
      // Session ended (shell exited / failed to start): spin up a fresh one.
      if (!sessionId && !starting) {
        starting = true;
        try {
          await startSession();
        } finally {
          starting = false;
        }
      }
      return;
    }
    if (starting) {
      return;
    }

    const TerminalCtor = (window as unknown as { Terminal?: unknown }).Terminal;
    const fitNamespace = (window as unknown as { FitAddon?: { FitAddon?: unknown } }).FitAddon;
    const FitCtor = fitNamespace && (fitNamespace.FitAddon || fitNamespace);

    if (!host || typeof TerminalCtor !== "function" || typeof FitCtor !== "function") {
      showMessage("Terminal is unavailable in this environment.");
      return;
    }
    if (!getBridge()) {
      showMessage("Terminal is unavailable (no shell bridge).");
      return;
    }

    starting = true;
    try {
      host.textContent = "";
      // eslint-disable-next-line new-cap
      term = new (TerminalCtor as new (options: unknown) => unknown)({
        fontFamily: 'Menlo, Monaco, "SF Mono", "Cascadia Code", "Roboto Mono", monospace',
        fontSize: 12,
        cursorBlink: true,
        theme: getTerminalTheme(currentTheme),
        scrollback: 5000,
      });
      // eslint-disable-next-line new-cap
      fitAddon = new (FitCtor as new () => unknown)();
      term.loadAddon(fitAddon);
      term.open(host);
      fitNow();

      const inputSub = term.onData((data: string) => {
        const bridge = getBridge();
        if (bridge && sessionId) {
          bridge.write(sessionId, data);
        }
      });

      // During IME composition xterm keeps its block cursor parked at the
      // composition start, so it sits stranded to the left of the text being
      // typed and "jumps" on commit. Blend the cursor into the background while
      // composing — the underlined composition text (styled in CSS) marks the
      // insertion point instead — then restore it on commit/cancel.
      const textarea: HTMLTextAreaElement | null = term.textarea ?? null;
      const hideCursor = () => {
        if (term) {
          const baseTheme = getTerminalTheme(currentTheme);
          term.options.theme = {
            ...baseTheme,
            cursor: baseTheme.background,
            cursorAccent: baseTheme.background,
          };
        }
      };
      const restoreCursor = () => {
        applyTerminalTheme();
      };
      if (textarea) {
        textarea.addEventListener("compositionstart", hideCursor);
        textarea.addEventListener("compositionend", restoreCursor);
      }

      termInputDisposer = () => {
        try {
          inputSub.dispose();
        } catch {
          /* ignore */
        }
        if (textarea) {
          textarea.removeEventListener("compositionstart", hideCursor);
          textarea.removeEventListener("compositionend", restoreCursor);
        }
      };

      await startSession();

      if (!resizeObserver && typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => scheduleFit());
        resizeObserver.observe(host);
      }
    } finally {
      starting = false;
    }
  };

  const show = () => {
    void ensureStarted().then(() => {
      scheduleFit();
      if (term) {
        try {
          term.focus();
        } catch {
          /* ignore */
        }
      }
    });
  };

  const hide = () => {
    /* Keep the pty session alive while hidden, mirroring VS Code. */
  };

  const dispose = () => {
    disposeThemeListener();
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    clearSessionDisposers();
    if (termInputDisposer) {
      termInputDisposer();
      termInputDisposer = null;
    }
    const bridge = getBridge();
    if (bridge && sessionId) {
      bridge.kill(sessionId);
    }
    sessionId = null;
    if (term) {
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
      term = null;
    }
    fitAddon = null;
  };

  return { show, hide, dispose };
};
