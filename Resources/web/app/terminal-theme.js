// xterm needs concrete colors (no CSS vars). Keep these aligned with app themes.
// Shared by the panel terminal and the detached terminal window so a session
// looks the same wherever it is shown.
export const TERMINAL_THEMES = {
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
export const getTerminalTheme = (theme) => { var _a; return (_a = TERMINAL_THEMES[theme]) !== null && _a !== void 0 ? _a : TERMINAL_THEMES.dark; };
export const TERMINAL_FONT_FAMILY = 'Menlo, Monaco, "SF Mono", "Cascadia Code", "Roboto Mono", monospace';
