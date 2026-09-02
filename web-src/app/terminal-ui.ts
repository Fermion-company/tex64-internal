import type { AppContext } from "./context.js";
import {
  getCurrentAppearanceTheme,
  onAppearanceThemeChange,
  type AppearanceTheme,
} from "./appearance.js";
import { uiText } from "./i18n.js";
import { getTerminalTheme, TERMINAL_FONT_FAMILY } from "./terminal-theme.js";

type TerminalBridge = {
  create: (options?: {
    cols?: number;
    rows?: number;
    cwd?: string;
  }) => Promise<{ id?: string; error?: string; cwd?: string }>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  kill: (id: string) => void;
  onData: (handler: (msg: { id: string; data: string }) => void) => () => void;
  onExit: (handler: (msg: { id: string; exitCode: number }) => void) => () => void;
  openWindow?: (options?: { theme?: AppearanceTheme }) => Promise<{ ok?: boolean; error?: string }>;
};

const getBridge = (): TerminalBridge | null => {
  const bridge = (window as unknown as { tex64Terminal?: TerminalBridge }).tex64Terminal;
  return bridge && typeof bridge.create === "function" ? bridge : null;
};

/** One shell: its xterm instance, its pty id, and the DOM it lives in. */
type TerminalSession = {
  key: string;
  title: string;
  host: HTMLElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  term: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fitAddon: any;
  sessionId: string | null;
  startingCwd: string | undefined;
  starting: boolean;
  exited: boolean;
  /** Bridge listeners for the current pty; replaced every time one starts. */
  ptyDisposers: Array<() => void>;
  /** xterm-side listeners, alive for the lifetime of the session. */
  viewDisposers: Array<() => void>;
};

export type TerminalUiApi = {
  /** Called when the Terminal tab becomes visible: starts a session lazily and fits. */
  show: () => void;
  /** Called when the tab/panel is hidden; sessions are kept alive. */
  hide: () => void;
  /** Header ⟳ button: restart the shell in the focused pane. */
  restart: () => void;
  /** Open one more shell as a new tab (Ctrl+T / the + button). */
  newSession: (options?: { cwd?: string; focus?: boolean }) => void;
  dispose: () => void;
};

export const initTerminalUi = (context: AppContext): TerminalUiApi => {
  const { terminalArea, terminalTabs, terminalPanes } = context.dom;

  const sessions: TerminalSession[] = [];
  // One entry per visible pane; a pane names the session it currently shows.
  // Splitting is capped at two panes: any more and an already-small bottom
  // panel stops being usable for a shell.
  let paneKeys: Array<string | null> = [null];
  let focusedPane = 0;
  let nextKey = 1;
  let currentTheme = getCurrentAppearanceTheme();
  let resizeObserver: ResizeObserver | null = null;
  let rafId: number | null = null;
  let visible = false;

  const disposeThemeListener = onAppearanceThemeChange((theme) => {
    currentTheme = theme;
    sessions.forEach((session) => {
      if (session.term) {
        session.term.options.theme = { ...getTerminalTheme(currentTheme) };
      }
    });
  });

  const runDisposers = (disposers: Array<() => void>) => {
    disposers.forEach((dispose) => {
      try {
        dispose();
      } catch {
        /* a listener whose owner is already gone is not an error */
      }
    });
  };

  const findSession = (key: string | null) =>
    key ? sessions.find((session) => session.key === key) ?? null : null;

  const focusedSession = () => findSession(paneKeys[focusedPane] ?? null);

  const showMessage = (text: string) => {
    if (terminalPanes) {
      terminalPanes.textContent = text;
    }
  };

  const fitAll = () => {
    sessions.forEach((session) => {
      if (!session.term || !session.fitAddon) {
        return;
      }
      if (session.host.clientWidth === 0 || session.host.clientHeight === 0) {
        return;
      }
      try {
        session.fitAddon.fit();
      } catch {
        return;
      }
      const bridge = getBridge();
      if (bridge && session.sessionId && session.term.cols > 0 && session.term.rows > 0) {
        bridge.resize(session.sessionId, session.term.cols, session.term.rows);
      }
    });
  };

  const scheduleFit = () => {
    if (rafId !== null) {
      return;
    }
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      fitAll();
    });
  };

  const startPty = async (session: TerminalSession) => {
    const bridge = getBridge();
    if (!bridge || !session.term || session.sessionId || session.starting) {
      return;
    }
    session.starting = true;
    try {
      // Only the previous pty's listeners are dropped here. The xterm input
      // subscription must outlive every restart, or the shell silently stops
      // receiving keystrokes.
      runDisposers(session.ptyDisposers);
      session.ptyDisposers = [];
      const result = await bridge.create({
        cols: session.term.cols,
        rows: session.term.rows,
        cwd: session.startingCwd,
      });
      if (!result || result.error || !result.id) {
        const reason = result && result.error ? result.error : "unknown error";
        session.term.writeln(`\x1b[31mFailed to start terminal: ${reason}\x1b[0m`);
        return;
      }
      session.sessionId = result.id;
      session.exited = false;
      const offData = bridge.onData((msg) => {
        if (msg && msg.id === session.sessionId && session.term) {
          session.term.write(msg.data);
        }
      });
      const offExit = bridge.onExit((msg) => {
        if (msg && msg.id === session.sessionId) {
          session.sessionId = null;
          session.exited = true;
          session.term?.writeln(
            `\r\n\x1b[90m${uiText(
              "[process exited — press any key to start a new shell]",
              "[プロセスが終了しました — 何かキーを押すと新しいシェルを開始します]"
            )}\x1b[0m`
          );
        }
      });
      session.ptyDisposers.push(offData, offExit);
    } finally {
      session.starting = false;
    }
  };

  const createSession = (options: { cwd?: string } = {}): TerminalSession | null => {
    const TerminalCtor = (window as unknown as { Terminal?: unknown }).Terminal;
    const fitNamespace = (window as unknown as { FitAddon?: { FitAddon?: unknown } }).FitAddon;
    const FitCtor = fitNamespace && (fitNamespace.FitAddon || fitNamespace);
    if (!terminalPanes || typeof TerminalCtor !== "function" || typeof FitCtor !== "function") {
      showMessage(uiText("Terminal is unavailable in this environment.", "この環境ではターミナルを利用できません。"));
      return null;
    }
    if (!getBridge()) {
      showMessage(uiText("Terminal is unavailable (no shell bridge).", "ターミナルを利用できません（シェルブリッジなし）。"));
      return null;
    }

    const host = document.createElement("div");
    host.className = "terminal-view";
    const key = `t${nextKey}`;
    host.dataset.terminalKey = key;

    // eslint-disable-next-line new-cap
    const term = new (TerminalCtor as new (options: unknown) => unknown)({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 12,
      cursorBlink: true,
      theme: getTerminalTheme(currentTheme),
      scrollback: 5000,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    // eslint-disable-next-line new-cap
    const fitAddon = new (FitCtor as new () => unknown)();
    term.loadAddon(fitAddon);

    const session: TerminalSession = {
      key,
      title: `zsh ${nextKey}`,
      host,
      term,
      fitAddon,
      sessionId: null,
      startingCwd: options.cwd,
      starting: false,
      exited: false,
      ptyDisposers: [],
      viewDisposers: [],
    };
    nextKey += 1;
    sessions.push(session);

    const inputSub = term.onData((data: string) => {
      const bridge = getBridge();
      if (!bridge) {
        return;
      }
      if (!session.sessionId) {
        // A shell that exited used to swallow every keystroke in silence, which
        // read as "commands stopped working". Typing now brings it back.
        void startPty(session).then(() => scheduleFit());
        return;
      }
      bridge.write(session.sessionId, data);
    });

    host.addEventListener("mousedown", () => {
      const index = paneKeys.indexOf(session.key);
      if (index >= 0) {
        focusedPane = index;
        renderTabs();
      }
    });

    terminalPanes.appendChild(host);
    term.open(host);

    // During IME composition xterm keeps its block cursor parked at the
    // composition start, so it sits stranded to the left of the text being
    // typed and "jumps" on commit. Blend the cursor into the background while
    // composing — the underlined composition text (styled in CSS) marks the
    // insertion point instead — then restore it on commit/cancel.
    // xterm only creates its helper textarea inside open(), so this has to come
    // after it.
    const textarea: HTMLTextAreaElement | null = term.textarea ?? null;
    const hideCursor = () => {
      const baseTheme = getTerminalTheme(currentTheme);
      term.options.theme = {
        ...baseTheme,
        cursor: baseTheme.background,
        cursorAccent: baseTheme.background,
      };
    };
    const restoreCursor = () => {
      term.options.theme = { ...getTerminalTheme(currentTheme) };
    };
    if (textarea) {
      textarea.addEventListener("compositionstart", hideCursor);
      textarea.addEventListener("compositionend", restoreCursor);
    }
    session.viewDisposers.push(() => {
      try {
        inputSub.dispose();
      } catch {
        /* ignore */
      }
      if (textarea) {
        textarea.removeEventListener("compositionstart", hideCursor);
        textarea.removeEventListener("compositionend", restoreCursor);
      }
    });
    return session;
  };

  const closeSession = (key: string) => {
    const index = sessions.findIndex((session) => session.key === key);
    if (index < 0) {
      return;
    }
    const [session] = sessions.splice(index, 1);
    const bridge = getBridge();
    if (bridge && session.sessionId) {
      bridge.kill(session.sessionId);
    }
    runDisposers(session.ptyDisposers);
    runDisposers(session.viewDisposers);
    try {
      session.term?.dispose();
    } catch {
      /* ignore */
    }
    session.host.remove();

    // Any pane that was showing it falls back to another session, and an empty
    // second pane collapses the split rather than leaving a blank column.
    paneKeys = paneKeys.map((paneKey) => (paneKey === key ? null : paneKey));
    const spare = sessions.find((candidate) => !paneKeys.includes(candidate.key)) ?? sessions[0];
    paneKeys = paneKeys.map((paneKey) => paneKey ?? spare?.key ?? null);
    if (paneKeys.length > 1 && (paneKeys[1] === null || paneKeys[1] === paneKeys[0])) {
      paneKeys = [paneKeys[0]];
      focusedPane = 0;
    }
    if (sessions.length === 0) {
      paneKeys = [null];
      focusedPane = 0;
    }
    applyLayout();
  };

  const applyLayout = () => {
    if (!terminalPanes) {
      return;
    }
    terminalPanes.dataset.paneCount = String(paneKeys.length);
    sessions.forEach((session) => {
      const paneIndex = paneKeys.indexOf(session.key);
      session.host.classList.toggle("is-visible", paneIndex >= 0);
      session.host.style.order = paneIndex >= 0 ? String(paneIndex) : "";
      session.host.classList.toggle("is-focused-pane", paneIndex === focusedPane);
    });
    renderTabs();
    scheduleFit();
  };

  const renderTabs = () => {
    if (!terminalTabs) {
      return;
    }
    terminalTabs.innerHTML = "";
    const list = document.createElement("div");
    list.className = "terminal-tab-list";
    sessions.forEach((session) => {
      const tab = document.createElement("div");
      const paneIndex = paneKeys.indexOf(session.key);
      tab.className = "terminal-tab";
      tab.classList.toggle("is-active", paneIndex >= 0);
      tab.classList.toggle("is-focused", paneIndex === focusedPane);
      tab.dataset.terminalKey = session.key;

      const label = document.createElement("button");
      label.type = "button";
      label.className = "terminal-tab-label";
      label.textContent = session.exited
        ? uiText(`${session.title} (exited)`, `${session.title}（終了）`)
        : session.title;
      label.addEventListener("click", () => {
        paneKeys[focusedPane] = session.key;
        applyLayout();
        session.term?.focus();
      });

      const close = document.createElement("button");
      close.type = "button";
      close.className = "terminal-tab-close";
      close.setAttribute("aria-label", uiText("Close terminal", "ターミナルを閉じる"));
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeSession(session.key);
      });

      tab.append(label, close);
      list.appendChild(tab);
    });

    const actions = document.createElement("div");
    actions.className = "terminal-tab-actions";
    const addAction = (
      label: string,
      title: string,
      handler: () => void,
      disabled = false
    ) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "terminal-action";
      button.textContent = label;
      button.title = title;
      button.disabled = disabled;
      button.addEventListener("click", handler);
      actions.appendChild(button);
    };
    addAction("+", uiText("New terminal (Ctrl+T)", "新しいターミナル (Ctrl+T)"), () =>
      newSession({ focus: true })
    );
    addAction(
      paneKeys.length > 1 ? "⫿" : "⫽",
      paneKeys.length > 1
        ? uiText("Unsplit terminal", "分割を解除")
        : uiText("Split terminal", "ターミナルを分割"),
      toggleSplit
    );
    addAction("⧉", uiText("Open terminal in a new window", "別ウィンドウで開く"), openInNewWindow);

    terminalTabs.append(list, actions);
  };

  const newSession = (options: { cwd?: string; focus?: boolean } = {}) => {
    const session = createSession({ cwd: options.cwd });
    if (!session) {
      return;
    }
    paneKeys[focusedPane] = session.key;
    applyLayout();
    void startPty(session).then(() => {
      scheduleFit();
      if (options.focus !== false) {
        session.term?.focus();
      }
    });
  };

  const toggleSplit = () => {
    if (paneKeys.length > 1) {
      paneKeys = [paneKeys[0]];
      focusedPane = 0;
      applyLayout();
      focusedSession()?.term?.focus();
      return;
    }
    const spare = sessions.find((session) => !paneKeys.includes(session.key));
    if (spare) {
      paneKeys = [paneKeys[0], spare.key];
      focusedPane = 1;
      applyLayout();
      spare.term?.focus();
      return;
    }
    const session = createSession({});
    if (!session) {
      return;
    }
    paneKeys = [paneKeys[0], session.key];
    focusedPane = 1;
    applyLayout();
    void startPty(session).then(() => {
      scheduleFit();
      session.term?.focus();
    });
  };

  const openInNewWindow = () => {
    void getBridge()?.openWindow?.({ theme: currentTheme });
  };

  const ensureStarted = () => {
    if (sessions.length === 0) {
      newSession({ focus: true });
      return;
    }
    const session = focusedSession();
    if (session && !session.sessionId && !session.starting) {
      void startPty(session).then(() => scheduleFit());
    }
  };

  const show = () => {
    visible = true;
    ensureStarted();
    scheduleFit();
    if (!resizeObserver && terminalPanes && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => scheduleFit());
      resizeObserver.observe(terminalPanes);
    }
    window.requestAnimationFrame(() => {
      scheduleFit();
      focusedSession()?.term?.focus();
    });
  };

  const hide = () => {
    visible = false;
    /* Keep the pty sessions alive while hidden, mirroring VS Code. */
  };

  const restart = () => {
    const session = focusedSession();
    if (!session) {
      newSession({ focus: true });
      return;
    }
    const bridge = getBridge();
    if (bridge && session.sessionId) {
      const oldId = session.sessionId;
      session.sessionId = null;
      bridge.kill(oldId);
    }
    try {
      session.term?.reset();
    } catch {
      /* ignore */
    }
    void startPty(session).then(() => {
      scheduleFit();
      session.term?.focus();
    });
  };

  // Ctrl+T (and Cmd+T on macOS) opens another shell, as asked for in issue #38.
  // It only fires while the terminal actually has focus, so it never competes
  // with the editor.
  const handleKeydown = (event: KeyboardEvent) => {
    if (!visible || event.key.toLowerCase() !== "t") {
      return;
    }
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    if (event.altKey || event.shiftKey) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (!terminalArea || !target || !terminalArea.contains(target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    newSession({ focus: true });
  };
  window.addEventListener("keydown", handleKeydown, true);

  const dispose = () => {
    disposeThemeListener();
    window.removeEventListener("keydown", handleKeydown, true);
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    [...sessions].forEach((session) => closeSession(session.key));
  };

  renderTabs();

  return { show, hide, restart, newSession, dispose };
};
