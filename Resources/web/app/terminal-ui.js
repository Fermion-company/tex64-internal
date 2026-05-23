const getBridge = () => {
    const bridge = window.tex64Terminal;
    return bridge && typeof bridge.create === "function" ? bridge : null;
};
// xterm needs concrete colors (no CSS vars). Keep this aligned with the dark panel.
const TERMINAL_THEME = {
    background: "#0e1116",
    foreground: "#cdd3de",
    cursor: "#cdd3de",
    selectionBackground: "rgba(255, 255, 255, 0.18)",
    black: "#1c2129", red: "#f47067", green: "#57ab5a", yellow: "#c69026",
    blue: "#539bf5", magenta: "#b083f0", cyan: "#39c5cf", white: "#adbac7",
    brightBlack: "#636e7b", brightRed: "#ff938a", brightGreen: "#6bc46d",
    brightYellow: "#daaa3f", brightBlue: "#6cb6ff", brightMagenta: "#dcbdfb",
    brightCyan: "#56d4dd", brightWhite: "#cdd9e5",
};
export const initTerminalUi = (context) => {
    const host = context.dom.terminalHost;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let term = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fitAddon = null;
    let sessionId = null;
    let starting = false;
    let termInputDisposer = null;
    let sessionDisposers = [];
    let resizeObserver = null;
    let rafId = null;
    const showMessage = (text) => {
        if (host) {
            host.textContent = text;
        }
    };
    const clearSessionDisposers = () => {
        sessionDisposers.forEach((d) => {
            try {
                d();
            }
            catch {
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
        }
        catch {
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
                    term.writeln("\r\n\x1b[90m[process exited — reopen Terminal to start a new session]\x1b[0m");
                }
            }
        });
        sessionDisposers.push(offData, offExit);
    };
    const ensureStarted = async () => {
        var _a;
        if (term) {
            // Session ended (shell exited / failed to start): spin up a fresh one.
            if (!sessionId && !starting) {
                starting = true;
                try {
                    await startSession();
                }
                finally {
                    starting = false;
                }
            }
            return;
        }
        if (starting) {
            return;
        }
        const TerminalCtor = window.Terminal;
        const fitNamespace = window.FitAddon;
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
            term = new TerminalCtor({
                fontFamily: 'Menlo, Monaco, "SF Mono", "Cascadia Code", "Roboto Mono", monospace',
                fontSize: 12,
                cursorBlink: true,
                theme: TERMINAL_THEME,
                scrollback: 5000,
            });
            // eslint-disable-next-line new-cap
            fitAddon = new FitCtor();
            term.loadAddon(fitAddon);
            term.open(host);
            fitNow();
            const inputSub = term.onData((data) => {
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
            const textarea = (_a = term.textarea) !== null && _a !== void 0 ? _a : null;
            const hideCursor = () => {
                if (term) {
                    term.options.theme = {
                        ...TERMINAL_THEME,
                        cursor: TERMINAL_THEME.background,
                        cursorAccent: TERMINAL_THEME.background,
                    };
                }
            };
            const restoreCursor = () => {
                if (term) {
                    term.options.theme = { ...TERMINAL_THEME };
                }
            };
            if (textarea) {
                textarea.addEventListener("compositionstart", hideCursor);
                textarea.addEventListener("compositionend", restoreCursor);
            }
            termInputDisposer = () => {
                try {
                    inputSub.dispose();
                }
                catch {
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
        }
        finally {
            starting = false;
        }
    };
    const show = () => {
        void ensureStarted().then(() => {
            scheduleFit();
            if (term) {
                try {
                    term.focus();
                }
                catch {
                    /* ignore */
                }
            }
        });
    };
    const hide = () => {
        /* Keep the pty session alive while hidden, mirroring VS Code. */
    };
    const dispose = () => {
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
            }
            catch {
                /* ignore */
            }
            term = null;
        }
        fitAddon = null;
    };
    return { show, hide, dispose };
};
