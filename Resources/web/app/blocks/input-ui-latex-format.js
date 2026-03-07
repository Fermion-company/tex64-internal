const ALIGNED_ENV_BEGIN = "\\begin{aligned}";
const ALIGNED_ENV_END = "\\end{aligned}";
const LEGACY_AUX_COMMAND_MAP = {
    txlbl: "label",
    txtag: "tag",
    txtgs: "tag*",
    txntg: "notag",
    txnnum: "nonumber",
    txeqr: "eqref",
    txref: "ref",
    txpgrf: "pageref",
    txatrf: "autoref",
    txintr: "intertext",
    txshintr: "shortintertext",
};
const LEGACY_AUX_COMMAND_RE = /\\(txlbl|txtag|txtgs|txntg|txnnum|txeqr|txref|txpgrf|txatrf|txintr|txshintr)\b/g;
const AUX_COMMAND_LBRACE_ARG_RE = /\\(label|tag\*?|eqref|ref|pageref|autoref|intertext|shortintertext)\{\s*\\lbrace([\s\S]*?)\\rbrace\s*\}/g;
const isEscapedAt = (text, index) => {
    let count = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
        count += 1;
    }
    return count % 2 === 1;
};
const hasUnescapedAmpersand = (text) => {
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === "&" && !isEscapedAt(text, i)) {
            return true;
        }
    }
    return false;
};
const hasLineBreak = (text) => {
    for (let i = 0; i < text.length - 1; i += 1) {
        if (text[i] === "\\" && text[i + 1] === "\\" && !isEscapedAt(text, i)) {
            return true;
        }
    }
    return false;
};
export const shouldWrapAligned = (text) => {
    if (!text) {
        return false;
    }
    if (text.includes("\\begin{") || text.includes("\\end{")) {
        return false;
    }
    return hasUnescapedAmpersand(text) || hasLineBreak(text);
};
export const wrapAligned = (text) => `${ALIGNED_ENV_BEGIN}\n${text}\n${ALIGNED_ENV_END}`;
export const unwrapAligned = (text) => {
    const start = text.indexOf(ALIGNED_ENV_BEGIN);
    const end = text.lastIndexOf(ALIGNED_ENV_END);
    if (start === -1 || end === -1) {
        return { value: text, didUnwrap: false };
    }
    const before = text.slice(0, start).trim();
    const after = text.slice(end + ALIGNED_ENV_END.length).trim();
    if (before || after) {
        return { value: text, didUnwrap: false };
    }
    let inner = text.slice(start + ALIGNED_ENV_BEGIN.length, end);
    if (inner.startsWith("\n")) {
        inner = inner.slice(1);
    }
    if (inner.endsWith("\n")) {
        inner = inner.slice(0, -1);
    }
    return { value: inner, didUnwrap: true };
};
const splitAlignedRows = (text) => {
    const rows = [];
    let current = "";
    let envDepth = 0;
    for (let i = 0; i < text.length; i += 1) {
        // Track \begin{...} / \end{...} nesting so we don't split on \\ inside
        // sub-environments (e.g. matrices nested in aligned rows).
        if (text.startsWith("\\begin{", i) && !isEscapedAt(text, i)) {
            envDepth += 1;
        }
        else if (text.startsWith("\\end{", i) && !isEscapedAt(text, i)) {
            envDepth = Math.max(0, envDepth - 1);
        }
        if (envDepth === 0 &&
            text[i] === "\\" &&
            text[i + 1] === "\\" &&
            !isEscapedAt(text, i)) {
            rows.push(current);
            current = "";
            i += 1;
            continue;
        }
        current += text[i];
    }
    rows.push(current);
    return rows;
};
const isEmptyAlignedRow = (row) => {
    const cleaned = row.replace(/\\placeholder\{\}/g, "").replace(/\s+/g, "");
    return cleaned === "" || cleaned === "&";
};
export const stripEmptyAlignedRows = (text) => {
    const rows = splitAlignedRows(text);
    if (rows.length <= 1) {
        return text;
    }
    // Only strip trailing empty rows; preserve structure and leading/middle rows
    let lastNonEmpty = rows.length - 1;
    while (lastNonEmpty > 0 && isEmptyAlignedRow(rows[lastNonEmpty])) {
        lastNonEmpty -= 1;
    }
    if (lastNonEmpty === rows.length - 1) {
        return text;
    }
    return rows.slice(0, lastNonEmpty + 1).join("\\\\");
};
export const normalizeMatrixSyntax = (value) => {
    if (!value) {
        return value;
    }
    const parseTopLevelBracedCells = (body) => {
        var _a;
        const cells = [];
        let i = 0;
        while (i < body.length) {
            while (i < body.length && /\s/.test((_a = body[i]) !== null && _a !== void 0 ? _a : "")) {
                i += 1;
            }
            if (i >= body.length) {
                break;
            }
            if (body[i] !== "{" || isEscapedAt(body, i)) {
                return null;
            }
            const start = i + 1;
            let depth = 0;
            let closed = false;
            for (; i < body.length; i += 1) {
                const ch = body[i];
                if (ch === "{" && !isEscapedAt(body, i)) {
                    depth += 1;
                    continue;
                }
                if (ch === "}" && !isEscapedAt(body, i)) {
                    depth -= 1;
                    if (depth === 0) {
                        cells.push(body.slice(start, i).trim());
                        i += 1;
                        closed = true;
                        break;
                    }
                }
            }
            if (!closed) {
                return null;
            }
        }
        return cells;
    };
    const inferMatrixShape = (cellCount) => {
        if (!Number.isFinite(cellCount) || cellCount < 4) {
            return null;
        }
        let bestRows = 0;
        let bestCols = 0;
        let bestDiff = Number.POSITIVE_INFINITY;
        for (let rows = 2; rows * rows <= cellCount; rows += 1) {
            if (cellCount % rows !== 0) {
                continue;
            }
            const cols = cellCount / rows;
            if (cols < 2) {
                continue;
            }
            const diff = Math.abs(cols - rows);
            if (diff < bestDiff) {
                bestRows = rows;
                bestCols = cols;
                bestDiff = diff;
            }
        }
        if (bestRows > 0 && bestCols > 0) {
            return { rows: bestRows, cols: bestCols };
        }
        return null;
    };
    return value.replace(/\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix)\}([\s\S]*?)\\end\{\1\}/g, (match, env, body) => {
        if (body.includes("&") || body.includes("\\\\")) {
            return match;
        }
        const cells = parseTopLevelBracedCells(body);
        if (!cells || cells.length <= 1) {
            return match;
        }
        const filtered = cells.filter((cell) => cell.length > 0);
        if (filtered.length !== cells.length) {
            return match;
        }
        const shape = inferMatrixShape(filtered.length);
        if (!shape) {
            return match;
        }
        const rows = [];
        for (let r = 0; r < shape.rows; r += 1) {
            const row = filtered.slice(r * shape.cols, (r + 1) * shape.cols);
            rows.push(row.join("&"));
        }
        return `\\begin{${env}}${rows.join("\\\\")}\\end{${env}}`;
    });
};
const restoreLegacyAlignedProxyEnvs = (value) => value.replace(/\\begin\{aligned\}([\s\S]*?)\\end\{aligned\}/g, (match, body) => {
    if (body.includes("\\txalnat")) {
        const cleaned = body.replace(/\\txalnat/g, "").trim();
        return `\\begin{alignat*}{2}${cleaned}\\end{alignat*}`;
    }
    if (body.includes("\\txflaln")) {
        const cleaned = body.replace(/\\txflaln/g, "").trim();
        return `\\begin{flalign*}${cleaned}\\end{flalign*}`;
    }
    if (body.includes("\\txarrcf")) {
        const cleaned = body.replace(/\\txarrcf/g, "").trim();
        return `\\begin{array}{@{}>r<{}c@{|}l<{}@{}}${cleaned}\\end{array}`;
    }
    return match;
});
const findBalancedBraceEnd = (text, start) => {
    if (text[start] !== "{") {
        return -1;
    }
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "{" && !isEscapedAt(text, i)) {
            depth += 1;
            continue;
        }
        if (ch === "}" && !isEscapedAt(text, i)) {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
};
const replaceCommandWithBraceArgs = (value, command, argCount, mapper) => {
    var _a;
    const needle = `\\${command}`;
    if (!value.includes(needle)) {
        return value;
    }
    let output = "";
    for (let i = 0; i < value.length;) {
        if (!value.startsWith(needle, i)) {
            output += value[i];
            i += 1;
            continue;
        }
        let cursor = i + needle.length;
        const args = [];
        let ok = true;
        for (let argIndex = 0; argIndex < argCount; argIndex += 1) {
            while (cursor < value.length && /\s/.test((_a = value[cursor]) !== null && _a !== void 0 ? _a : "")) {
                cursor += 1;
            }
            if (value[cursor] !== "{") {
                ok = false;
                break;
            }
            const end = findBalancedBraceEnd(value, cursor);
            if (end < 0) {
                ok = false;
                break;
            }
            args.push(value.slice(cursor + 1, end));
            cursor = end + 1;
        }
        if (!ok) {
            output += value[i];
            i += 1;
            continue;
        }
        output += mapper(args);
        i = cursor;
    }
    return output;
};
const restoreLegacyArrayProxyEnvs = (value) => replaceCommandWithBraceArgs(value, "txarrayc", 2, (args) => {
    var _a, _b;
    const colspec = (_a = args[0]) !== null && _a !== void 0 ? _a : "";
    const body = (_b = args[1]) !== null && _b !== void 0 ? _b : "";
    return `\\begin{array}{${colspec}}${body}\\end{array}`;
});
const normalizeLegacyAuxCommands = (value) => value.replace(LEGACY_AUX_COMMAND_RE, (_full, command) => {
    var _a;
    const mapped = (_a = LEGACY_AUX_COMMAND_MAP[command]) !== null && _a !== void 0 ? _a : command;
    return `\\${mapped}`;
});
const normalizeAuxCommandLbraceArguments = (value) => value.replace(AUX_COMMAND_LBRACE_ARG_RE, (_full, command, argument) => {
    const normalizedArgument = String(argument !== null && argument !== void 0 ? argument : "").trim();
    return `\\${command}{${normalizedArgument}}`;
});
export const normalizeLegacyEnvMarkers = (value) => {
    if (!value) {
        return value;
    }
    let normalized = value;
    if (normalized.includes("\\tx")) {
        normalized = normalizeLegacyAuxCommands(restoreLegacyAlignedProxyEnvs(restoreLegacyArrayProxyEnvs(normalized)));
    }
    if (normalized.includes("\\lbrace") && normalized.includes("\\rbrace")) {
        normalized = normalizeAuxCommandLbraceArguments(normalized);
    }
    return normalized;
};
