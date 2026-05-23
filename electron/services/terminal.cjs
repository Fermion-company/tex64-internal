"use strict";

const os = require("os");
const pty = require("@homebridge/node-pty-prebuilt-multiarch");

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const pickShell = () => {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/zsh";
};

// macOS GUI apps inherit a minimal PATH, so spawn a login shell — it sources the
// user's profile and rebuilds PATH the way their normal terminal would.
const shellArgs = (shell) => {
  if (process.platform === "win32") {
    return [];
  }
  return /(?:^|\/)(?:bash|zsh|sh)$/.test(shell) ? ["-l"] : [];
};

const clampDim = (value, fallback) =>
  Number.isInteger(value) && value > 0 && value < 1000 ? value : fallback;

// Owns the node-pty sessions for the renderer. The renderer drives everything by
// id; we stream output/exit back through the injected callbacks (wired to the
// "tex64:terminal:data" / "tex64:terminal:exit" channels in main).
class TerminalService {
  constructor({ onData, onExit } = {}) {
    this.sessions = new Map();
    this.onData = typeof onData === "function" ? onData : () => {};
    this.onExit = typeof onExit === "function" ? onExit : () => {};
    this.nextId = 1;
  }

  create({ cwd, cols, rows, shell } = {}) {
    const id = `term-${this.nextId++}`;
    const safeCols = clampDim(cols, DEFAULT_COLS);
    const safeRows = clampDim(rows, DEFAULT_ROWS);
    const shellPath = typeof shell === "string" && shell ? shell : pickShell();
    const requestedCwd = typeof cwd === "string" && cwd ? cwd : os.homedir();

    const spawnIn = (dir) =>
      pty.spawn(shellPath, shellArgs(shellPath), {
        name: "xterm-256color",
        cols: safeCols,
        rows: safeRows,
        cwd: dir,
        env: { ...process.env, TERM: "xterm-256color" },
      });

    let proc;
    try {
      proc = spawnIn(requestedCwd);
    } catch {
      proc = spawnIn(os.homedir());
    }

    proc.onData((data) => this.onData(id, data));
    proc.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id);
      this.onExit(id, exitCode, signal);
    });

    this.sessions.set(id, proc);
    return { id, shell: shellPath, cwd: requestedCwd };
  }

  write(id, data) {
    const proc = this.sessions.get(id);
    if (proc && typeof data === "string") {
      proc.write(data);
    }
  }

  resize(id, cols, rows) {
    const proc = this.sessions.get(id);
    if (!proc) {
      return;
    }
    try {
      proc.resize(clampDim(cols, DEFAULT_COLS), clampDim(rows, DEFAULT_ROWS));
    } catch {
      /* a resize on a just-exited pty is harmless to drop */
    }
  }

  kill(id) {
    const proc = this.sessions.get(id);
    if (!proc) {
      return;
    }
    this.sessions.delete(id);
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }

  killAll() {
    for (const proc of this.sessions.values()) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
  }
}

module.exports = { TerminalService };
