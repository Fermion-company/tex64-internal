import { getCurrentAppearanceTheme, onAppearanceThemeChange } from "./appearance.js";
import { uiText } from "./i18n.js";
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
        background: "#f8fafc",
        foreground: "#263244",
        cursor: "#1d4ed8",
        selectionBackground: "rgba(37, 99, 235, 0.18)",
        black: "#1f2937", red: "#dc2626", green: "#15803d", yellow: "#b45309",
        blue: "#2563eb", magenta: "#9333ea", cyan: "#0891b2", white: "#e5e7eb",
        brightBlack: "#64748b", brightRed: "#ef4444", brightGreen: "#16a34a",
        brightYellow: "#d97706", brightBlue: "#3b82f6", brightMagenta: "#a855f7",
        brightCyan: "#06b6d4", brightWhite: "#f8fafc",
    },
};
const getTerminalTheme = (theme) => { var _a; return (_a = TERMINAL_THEMES[theme]) !== null && _a !== void 0 ? _a : TERMINAL_THEMES.dark; };
export const initTerminalUi = (context) => {
    const host = context.dom.terminalHost;
    const bridge = window.tex64Terminal;
    const globals = window;
    const groups = [];
    const sessionsById = new Map();
    // PTY output can arrive before invoke(create) resolves. Subscribe once, before
    // any spawn, and replay those early events when its id becomes known.
    const early = new Map();
    let activeGroup = null;
    let activeSession = null;
    let nextNumber = 1;
    let nextPaneNumber = 1;
    let visible = false;
    let disposed = false;
    let startingCount = 0;
    let rafId = null;
    let currentTheme = getCurrentAppearanceTheme();
    const tabs = document.createElement("div");
    tabs.className = "terminal-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", uiText("Terminal sessions", "ターミナルセッション"));
    const body = document.createElement("div");
    body.className = "terminal-panes";
    host === null || host === void 0 ? void 0 : host.replaceChildren(tabs, body);
    const allSessions = () => groups.flatMap((group) => group.panes);
    const setState = (session, state) => {
        session.state = state;
        session.element.dataset.state = state;
        session.label.textContent = `${session.number} · ${session.title}${session === activeSession ? uiText(" · Active", " · 選択中") : ""}`;
    };
    const fitNow = () => {
        var _a;
        if (!visible)
            return;
        for (const session of (_a = activeGroup === null || activeGroup === void 0 ? void 0 : activeGroup.panes) !== null && _a !== void 0 ? _a : []) {
            if (!session.screen.clientWidth || !session.screen.clientHeight)
                continue;
            try {
                session.fit.fit();
                if (session.id)
                    bridge === null || bridge === void 0 ? void 0 : bridge.resize(session.id, session.term.cols, session.term.rows);
            }
            catch { /* hidden or just disposed */ }
        }
    };
    const scheduleFit = () => {
        if (rafId !== null || disposed)
            return;
        rafId = requestAnimationFrame(() => { rafId = null; fitNow(); });
    };
    const focus = () => {
        if (visible && !disposed)
            activeSession === null || activeSession === void 0 ? void 0 : activeSession.term.focus();
    };
    const render = () => {
        tabs.replaceChildren();
        for (const group of groups) {
            const item = document.createElement("div");
            item.className = "terminal-tab";
            item.classList.toggle("is-active", group === activeGroup);
            const select = document.createElement("button");
            select.type = "button";
            select.setAttribute("role", "tab");
            select.setAttribute("aria-selected", String(group === activeGroup));
            select.textContent = `${group.number}: ${group.panes.map((pane) => pane.title).join(" / ")}`;
            select.addEventListener("click", () => {
                activeGroup = group;
                activeSession = group.panes[0];
                render();
                focus();
            });
            const close = document.createElement("button");
            close.type = "button";
            close.className = "terminal-tab-close";
            close.textContent = "×";
            close.title = group.panes.length > 1 ? uiText("Close both panes in this tab", "このタブの2ペインを終了") : uiText("Close this tab and its shell", "このタブとシェルを終了");
            close.setAttribute("aria-label", close.title);
            close.addEventListener("click", () => {
                for (const session of [...group.panes])
                    closeSession(session);
            });
            item.append(select, close);
            tabs.append(item);
            for (const session of group.panes) {
                session.element.hidden = group !== activeGroup;
                session.element.classList.toggle("is-active", session === activeSession);
                setState(session, session.state);
                session.element.classList.toggle("is-split", group.panes.length > 1);
            }
        }
        scheduleFit();
    };
    const exited = (session, code) => {
        if (session.id)
            sessionsById.delete(session.id);
        session.id = null;
        delete session.element.dataset.sessionId;
        setState(session, "exited");
        session.term.writeln(`\r\n\x1b[90m${uiText("Shell exited", "シェル終了")} (${code}). ${uiText("Press Enter to restart.", "Enterで再開。")}\x1b[0m`);
    };
    const offData = bridge === null || bridge === void 0 ? void 0 : bridge.onData(({ id, data }) => {
        var _a;
        const session = sessionsById.get(id);
        if (session)
            session.term.write(data);
        else if (startingCount && early.size < 24) {
            const event = (_a = early.get(id)) !== null && _a !== void 0 ? _a : { data: "" };
            event.data = (event.data + data).slice(-65536);
            early.set(id, event);
        }
    });
    const offExit = bridge === null || bridge === void 0 ? void 0 : bridge.onExit(({ id, exitCode }) => {
        var _a;
        const session = sessionsById.get(id);
        if (session)
            exited(session, exitCode);
        else if (startingCount && early.size < 24) {
            const event = (_a = early.get(id)) !== null && _a !== void 0 ? _a : { data: "" };
            event.exitCode = exitCode;
            early.set(id, event);
        }
    });
    const start = async (session) => {
        var _a, _b, _c;
        if (!bridge || session.disposed || disposed || session.id)
            return;
        const generation = ++session.generation;
        setState(session, "starting");
        startingCount += 1;
        try {
            const result = await bridge.create({
                cols: session.term.cols, rows: session.term.rows, cwd: session.cwd,
            });
            if (disposed || session.disposed || generation !== session.generation) {
                if (result === null || result === void 0 ? void 0 : result.id)
                    bridge.kill(result.id);
                return;
            }
            if (!(result === null || result === void 0 ? void 0 : result.id) || result.error)
                throw new Error((result === null || result === void 0 ? void 0 : result.error) || "Unable to start shell.");
            session.id = result.id;
            session.cwd = (_a = result.cwd) !== null && _a !== void 0 ? _a : session.cwd;
            session.title = ((_b = result.shell) === null || _b === void 0 ? void 0 : _b.split(/[\\/]/).pop()) || "Shell";
            session.element.dataset.sessionId = result.id;
            session.element.title = (_c = session.cwd) !== null && _c !== void 0 ? _c : "";
            sessionsById.set(result.id, session);
            setState(session, "running");
            const event = early.get(result.id);
            early.delete(result.id);
            if (event === null || event === void 0 ? void 0 : event.data)
                session.term.write(event.data);
            if ((event === null || event === void 0 ? void 0 : event.exitCode) !== undefined)
                exited(session, event.exitCode);
            if (session.id && session.pendingInput)
                bridge.write(session.id, session.pendingInput);
            session.pendingInput = "";
            render();
        }
        catch (error) {
            if (!session.disposed && generation === session.generation) {
                session.pendingInput = "";
                setState(session, "error");
                session.term.writeln(`\r\n\x1b[31m${String(error instanceof Error ? error.message : error)}\x1b[0m`);
                session.term.writeln(uiText("Press Enter to retry.", "Enterで再試行。"));
            }
        }
        finally {
            startingCount -= 1;
            if (!startingCount)
                early.clear();
        }
    };
    const makeSession = (cwd) => {
        var _a;
        const Fit = (_a = globals.FitAddon) === null || _a === void 0 ? void 0 : _a.FitAddon;
        if (!host || !bridge || !globals.Terminal || !Fit) {
            body.textContent = uiText("Terminal is unavailable.", "ターミナルを利用できません。");
            return null;
        }
        const element = document.createElement("section");
        element.className = "terminal-pane";
        const header = document.createElement("div");
        header.className = "terminal-pane-header";
        const label = document.createElement("span");
        label.textContent = "Shell";
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "×";
        close.title = uiText("Close this pane and its shell", "このペインとシェルを終了");
        close.setAttribute("aria-label", close.title);
        const screen = document.createElement("div");
        screen.className = "terminal-screen";
        header.append(label, close);
        element.append(header, screen);
        body.append(element);
        const term = new globals.Terminal({
            fontFamily: 'Menlo, Monaco, "SF Mono", "Cascadia Code", monospace',
            fontSize: 12, cursorBlink: true, scrollback: 10000,
            theme: { ...getTerminalTheme(currentTheme) },
        });
        const fit = new Fit();
        term.loadAddon(fit);
        term.open(screen);
        term.attachCustomKeyEventHandler((event) => !((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "t")
            && !(event.ctrlKey && event.code === "Backquote"));
        const session = {
            term, fit, element, screen, label, id: null, title: "Shell", number: nextPaneNumber++, cwd,
            state: "starting", pendingInput: "", generation: 0, disposed: false, disposers: [],
        };
        close.addEventListener("click", () => closeSession(session));
        screen.addEventListener("focusin", () => {
            activeSession = session;
            for (const pane of allSessions()) {
                pane.element.classList.toggle("is-active", pane === session);
                setState(pane, pane.state);
            }
        });
        const input = term.onData((data) => {
            if (session.disposed)
                return;
            if (session.id)
                bridge.write(session.id, data);
            else if (session.state === "starting")
                session.pendingInput += data;
            else {
                // Retain the first keystroke after exit; Enter simply starts the shell.
                session.pendingInput = data === "\r" ? "" : data;
                void start(session);
            }
        });
        session.disposers.push(() => input.dispose());
        const textarea = term.textarea;
        const composing = () => {
            const theme = getTerminalTheme(currentTheme);
            term.options.theme = { ...theme, cursor: theme.background, cursorAccent: theme.background };
        };
        const composed = () => { term.options.theme = { ...getTerminalTheme(currentTheme) }; };
        textarea === null || textarea === void 0 ? void 0 : textarea.addEventListener("compositionstart", composing);
        textarea === null || textarea === void 0 ? void 0 : textarea.addEventListener("compositionend", composed);
        session.disposers.push(() => {
            textarea === null || textarea === void 0 ? void 0 : textarea.removeEventListener("compositionstart", composing);
            textarea === null || textarea === void 0 ? void 0 : textarea.removeEventListener("compositionend", composed);
        });
        return session;
    };
    const destroySession = (session) => {
        session.disposed = true;
        session.generation += 1;
        if (session.id) {
            sessionsById.delete(session.id);
            bridge === null || bridge === void 0 ? void 0 : bridge.kill(session.id);
        }
        session.disposers.forEach((dispose) => dispose());
        session.term.dispose();
        session.element.remove();
    };
    const closeSession = (session) => {
        var _a, _b;
        const group = groups.find((entry) => entry.panes.includes(session));
        if (!group)
            return;
        destroySession(session);
        group.panes.splice(group.panes.indexOf(session), 1);
        if (!group.panes.length) {
            const index = groups.indexOf(group);
            groups.splice(index, 1);
            if (activeGroup === group)
                activeGroup = (_a = groups[Math.max(0, index - 1)]) !== null && _a !== void 0 ? _a : null;
        }
        if (activeSession === session)
            activeSession = (_b = activeGroup === null || activeGroup === void 0 ? void 0 : activeGroup.panes[0]) !== null && _b !== void 0 ? _b : null;
        render();
        focus();
    };
    const create = (cwd) => {
        if (disposed)
            return;
        const session = makeSession(cwd);
        if (!session)
            return;
        const group = { number: nextNumber++, panes: [session] };
        groups.push(group);
        activeGroup = group;
        activeSession = session;
        render();
        fitNow();
        void start(session);
        focus();
    };
    const split = () => {
        if (!activeGroup) {
            create();
            return;
        }
        if (activeGroup.panes.length >= 2)
            return;
        const session = makeSession();
        if (!session)
            return;
        activeGroup.panes.push(session);
        activeSession = session;
        render();
        fitNow();
        void start(session);
        focus();
    };
    const restart = (confirm = false) => {
        const session = activeSession;
        if (!session) {
            create();
            return;
        }
        if (session.state === "starting")
            return;
        if (confirm && !window.confirm(uiText(`Restart pane ${session.number} · ${session.title}? Running commands in this pane will stop.`, `端末 ${session.number}・${session.title} を再起動しますか？この端末で実行中のコマンドは終了します。`)))
            return;
        if (session.id) {
            sessionsById.delete(session.id);
            bridge === null || bridge === void 0 ? void 0 : bridge.kill(session.id);
            session.id = null;
        }
        session.term.reset();
        session.pendingInput = "";
        void start(session);
        focus();
    };
    const keydown = (event) => {
        if (event.isComposing)
            return;
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "t") {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.shiftKey)
                split();
            else
                create();
        }
        else if (!(event.ctrlKey && event.code === "Backquote")) {
            // Shell controls (Ctrl+C/D/Z/L/S etc.) must never reach editor shortcuts.
            event.stopPropagation();
        }
    };
    host === null || host === void 0 ? void 0 : host.addEventListener("keydown", keydown);
    const focusIn = () => bridge === null || bridge === void 0 ? void 0 : bridge.setFocused(true);
    const focusOut = (event) => {
        if (!(host === null || host === void 0 ? void 0 : host.contains(event.relatedTarget)))
            bridge === null || bridge === void 0 ? void 0 : bridge.setFocused(false);
    };
    host === null || host === void 0 ? void 0 : host.addEventListener("focusin", focusIn);
    host === null || host === void 0 ? void 0 : host.addEventListener("focusout", focusOut);
    const resizeObserver = new ResizeObserver(scheduleFit);
    if (host)
        resizeObserver.observe(host);
    const offTheme = onAppearanceThemeChange((theme) => {
        currentTheme = theme;
        for (const session of allSessions())
            session.term.options.theme = { ...getTerminalTheme(theme) };
    });
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        offData === null || offData === void 0 ? void 0 : offData();
        offExit === null || offExit === void 0 ? void 0 : offExit();
        offTheme();
        resizeObserver.disconnect();
        host === null || host === void 0 ? void 0 : host.removeEventListener("keydown", keydown);
        host === null || host === void 0 ? void 0 : host.removeEventListener("focusin", focusIn);
        host === null || host === void 0 ? void 0 : host.removeEventListener("focusout", focusOut);
        bridge === null || bridge === void 0 ? void 0 : bridge.setFocused(false);
        window.removeEventListener("beforeunload", dispose);
        if (rafId !== null)
            cancelAnimationFrame(rafId);
        for (const session of allSessions())
            destroySession(session);
        groups.length = 0;
        early.clear();
    };
    window.addEventListener("beforeunload", dispose);
    return {
        show: () => { visible = true; if (!groups.length)
            create(); scheduleFit(); focus(); },
        hide: () => { visible = false; bridge === null || bridge === void 0 ? void 0 : bridge.setFocused(false); },
        create, split, restart, dispose,
    };
};
