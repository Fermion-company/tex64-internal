import { pickCitationEntries } from "./index-utils.js";
const getCursorIndex = (position) => { var _a; return Math.max(0, ((_a = position.column) !== null && _a !== void 0 ? _a : 1) - 1); };
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const findCommandMatchAt = (line, cursorIndex, regex, extractKey) => {
    regex.lastIndex = 0;
    let match = regex.exec(line);
    while (match) {
        const extracted = extractKey(match, cursorIndex);
        if (extracted) {
            return extracted;
        }
        match = regex.exec(line);
    }
    return null;
};
const extractSingleKey = (match, cursorIndex) => {
    var _a, _b, _c, _d, _e;
    const command = (_a = match[1]) !== null && _a !== void 0 ? _a : "";
    const content = (_b = match[2]) !== null && _b !== void 0 ? _b : "";
    const braceIndex = match[0].indexOf("{");
    if (braceIndex < 0 || typeof match.index !== "number") {
        return null;
    }
    const contentStart = match.index + braceIndex + 1;
    const contentEnd = contentStart + content.length;
    if (cursorIndex < contentStart || cursorIndex > contentEnd) {
        return null;
    }
    const key = content.trim();
    if (!key) {
        return null;
    }
    const leading = (_e = (_d = (_c = content.match(/^\s*/)) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.length) !== null && _e !== void 0 ? _e : 0;
    return {
        command,
        key,
        startIndex: contentStart + leading,
        endIndex: contentStart + leading + key.length,
    };
};
const extractCiteKey = (match, cursorIndex) => {
    var _a, _b, _c, _d, _e;
    const command = (_a = match[1]) !== null && _a !== void 0 ? _a : "";
    const content = (_b = match[2]) !== null && _b !== void 0 ? _b : "";
    const braceIndex = match[0].indexOf("{");
    if (braceIndex < 0 || typeof match.index !== "number") {
        return null;
    }
    const contentStart = match.index + braceIndex + 1;
    const contentEnd = contentStart + content.length;
    if (cursorIndex < contentStart || cursorIndex > contentEnd) {
        return null;
    }
    const offset = cursorIndex - contentStart;
    const beforeComma = content.lastIndexOf(",", Math.max(0, offset - 1));
    const afterComma = content.indexOf(",", offset);
    const segStart = beforeComma >= 0 ? beforeComma + 1 : 0;
    const segEnd = afterComma >= 0 ? afterComma : content.length;
    const segment = content.slice(segStart, segEnd);
    const leading = (_e = (_d = (_c = segment.match(/^\s*/)) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.length) !== null && _e !== void 0 ? _e : 0;
    const key = segment.trim();
    if (!key) {
        return null;
    }
    return {
        command,
        key,
        startIndex: contentStart + segStart + leading,
        endIndex: contentStart + segStart + leading + key.length,
    };
};
const renderExcerpt = (payload) => {
    const start = Math.max(1, payload.startLine);
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    if (lines.length === 0) {
        return "```tex\n(抜粋なし)\n```";
    }
    const endLine = start + lines.length - 1;
    const width = Math.max(String(start).length, String(endLine).length);
    const body = lines
        .map((line, idx) => {
        const lineNo = start + idx;
        const marker = payload.highlightLine === lineNo ? "▶" : " ";
        const padded = String(lineNo).padStart(width, " ");
        return `${marker}${padded} | ${line}`;
    })
        .join("\n");
    return `\`\`\`tex\n${body}\n\`\`\``;
};
const sliceExcerptAroundLine = (payload) => {
    var _a, _b;
    const startLine = Number.isFinite(payload.startLine) ? Math.max(1, payload.startLine) : 1;
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const targetLine = Number.isFinite(payload.targetLine) ? Math.max(1, payload.targetLine) : 1;
    const radius = Number.isFinite(payload.radius)
        ? Math.min(80, Math.max(0, Math.floor((_a = payload.radius) !== null && _a !== void 0 ? _a : 0)))
        : 5;
    const maxLines = Number.isFinite(payload.maxLines)
        ? Math.min(200, Math.max(3, Math.floor((_b = payload.maxLines) !== null && _b !== void 0 ? _b : 0)))
        : 18;
    if (lines.length === 0) {
        return { startLine, lines: [] };
    }
    const idx = targetLine - startLine;
    if (idx < 0 || idx >= lines.length) {
        return { startLine, lines: lines.slice(0, maxLines) };
    }
    let begin = Math.max(0, idx - radius);
    let end = Math.min(lines.length, idx + radius + 1);
    if (end - begin > maxLines) {
        const half = Math.floor(maxLines / 2);
        begin = Math.max(0, idx - half);
        end = Math.min(lines.length, begin + maxLines);
        begin = Math.max(0, end - maxLines);
    }
    return { startLine: startLine + begin, lines: lines.slice(begin, end) };
};
const buildViewOnPdfLink = (payload) => {
    const pathValue = typeof payload.path === "string" ? payload.path.trim() : "";
    const line = Number.isFinite(payload.line) ? Math.max(1, Math.floor(payload.line)) : 1;
    const column = Number.isFinite(payload.column) ? Math.max(1, Math.floor(payload.column)) : 1;
    if (!pathValue) {
        return null;
    }
    const href = `tex64://view-on-pdf?path=${encodeURIComponent(pathValue)}&line=${encodeURIComponent(String(line))}&column=${encodeURIComponent(String(column))}`;
    return `[View on PDF](${href})`;
};
const findFirstUnescapedPercent = (line) => {
    for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== "%") {
            continue;
        }
        if (i > 0 && line[i - 1] === "\\") {
            continue;
        }
        return i;
    }
    return -1;
};
const findInlineMathAt = (line, cursorIndex) => {
    var _a, _b, _c;
    if (!line) {
        return null;
    }
    const commentIndex = findFirstUnescapedPercent(line);
    if (commentIndex >= 0) {
        if (cursorIndex >= commentIndex) {
            return null;
        }
        line = line.slice(0, commentIndex);
    }
    const regexPairs = [
        { regex: /\\\((.+?)\\\)/g, openLen: 2, closeLen: 2 },
        { regex: /\\\[(.+?)\\\]/g, openLen: 2, closeLen: 2 },
    ];
    for (const entry of regexPairs) {
        entry.regex.lastIndex = 0;
        let match = entry.regex.exec(line);
        while (match) {
            const raw = (_a = match[0]) !== null && _a !== void 0 ? _a : "";
            const latex = (_b = match[1]) !== null && _b !== void 0 ? _b : "";
            const index = (_c = match.index) !== null && _c !== void 0 ? _c : -1;
            if (index >= 0 && raw) {
                const startIndex = index + entry.openLen;
                const endIndex = startIndex + latex.length;
                if (cursorIndex >= startIndex && cursorIndex <= endIndex) {
                    const trimmed = latex.trim();
                    if (trimmed) {
                        return { latex: trimmed, startIndex, endIndex, raw };
                    }
                }
            }
            match = entry.regex.exec(line);
        }
    }
    const dollarIndices = [];
    for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== "$") {
            continue;
        }
        if (i > 0 && line[i - 1] === "\\") {
            continue;
        }
        if (i + 1 < line.length && line[i + 1] === "$") {
            continue;
        }
        if (i > 0 && line[i - 1] === "$") {
            continue;
        }
        dollarIndices.push(i);
    }
    for (let j = 0; j + 1 < dollarIndices.length; j += 2) {
        const open = dollarIndices[j];
        const close = dollarIndices[j + 1];
        if (cursorIndex < open + 1 || cursorIndex > close) {
            continue;
        }
        const latex = line.slice(open + 1, close);
        const trimmed = latex.trim();
        if (!trimmed) {
            continue;
        }
        return { latex: trimmed, startIndex: open + 1, endIndex: close, raw: line.slice(open, close + 1) };
    }
    return null;
};
const buildMathPreviewMarkdown = (latex) => {
    const MathLiveGlobal = window.MathLive;
    const convert = MathLiveGlobal === null || MathLiveGlobal === void 0 ? void 0 : MathLiveGlobal.convertLatexToMarkup;
    if (typeof convert !== "function") {
        return null;
    }
    try {
        const markup = convert(latex);
        if (typeof markup !== "string" || !markup.trim()) {
            return null;
        }
        return `<div class="tex64-hover-math">${markup}</div>`;
    }
    catch {
        return null;
    }
};
const stripComment = (line) => {
    const idx = findFirstUnescapedPercent(line);
    if (idx < 0) {
        return line;
    }
    return line.slice(0, idx);
};
const MATH_ENVIRONMENTS = new Set([
    "align",
    "alignat",
    "aligned",
    "alignedat",
    "array",
    "bmatrix",
    "Bmatrix",
    "cases",
    "CD",
    "eqnarray",
    "equation",
    "gather",
    "gathered",
    "matrix",
    "multline",
    "pmatrix",
    "smallmatrix",
    "split",
    "subarray",
    "Vmatrix",
    "vmatrix",
]);
const extractMathBlockFromExcerpt = (payload) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const startLine = Number.isFinite(payload.startLine) ? Math.max(1, payload.startLine) : 1;
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const targetLine = Number.isFinite(payload.targetLine) ? Math.max(1, payload.targetLine) : 1;
    const idx = targetLine - startLine;
    if (idx < 0 || idx >= lines.length) {
        return null;
    }
    const findDoubleDollarIndex = (line) => {
        for (let i = 0; i + 1 < line.length; i += 1) {
            if (line[i] !== "$" || line[i + 1] !== "$")
                continue;
            if (i > 0 && line[i - 1] === "\\")
                continue;
            return i;
        }
        return -1;
    };
    let dollarStart = -1;
    for (let i = idx; i >= 0; i -= 1) {
        const clean = stripComment((_a = lines[i]) !== null && _a !== void 0 ? _a : "");
        if (findDoubleDollarIndex(clean) >= 0) {
            dollarStart = i;
            break;
        }
    }
    if (dollarStart >= 0) {
        let dollarEnd = -1;
        for (let i = dollarStart; i < lines.length; i += 1) {
            const clean = stripComment((_b = lines[i]) !== null && _b !== void 0 ? _b : "");
            if (i === dollarStart) {
                const first = findDoubleDollarIndex(clean);
                if (first >= 0) {
                    const second = findDoubleDollarIndex(clean.slice(first + 2));
                    if (second >= 0) {
                        const inner = clean.slice(first + 2, first + 2 + second);
                        if (inner.trim()) {
                            return `\\[\n${inner.trim()}\n\\]`;
                        }
                    }
                }
            }
            else if (findDoubleDollarIndex(clean) >= 0) {
                dollarEnd = i;
                break;
            }
        }
        if (dollarEnd > dollarStart) {
            const startLineText = stripComment((_c = lines[dollarStart]) !== null && _c !== void 0 ? _c : "");
            const endLineText = stripComment((_d = lines[dollarEnd]) !== null && _d !== void 0 ? _d : "");
            const startIdx = findDoubleDollarIndex(startLineText);
            const endIdx = findDoubleDollarIndex(endLineText);
            if (startIdx >= 0 && endIdx >= 0) {
                const bodyLines = [];
                bodyLines.push(startLineText.slice(startIdx + 2));
                for (let i = dollarStart + 1; i < dollarEnd; i += 1) {
                    bodyLines.push(stripComment((_e = lines[i]) !== null && _e !== void 0 ? _e : ""));
                }
                bodyLines.push(endLineText.slice(0, endIdx));
                const inner = bodyLines.join("\n").trim();
                if (inner) {
                    return `\\[\n${inner}\n\\]`;
                }
            }
        }
    }
    const beginRegex = /\\begin\{([^}]+)\}/;
    const endRegex = /\\end\{([^}]+)\}/;
    let beginIndex = -1;
    let envName = null;
    for (let i = idx; i >= 0; i -= 1) {
        const clean = stripComment((_f = lines[i]) !== null && _f !== void 0 ? _f : "");
        const match = clean.match(beginRegex);
        if (!match) {
            continue;
        }
        const rawEnv = ((_g = match[1]) !== null && _g !== void 0 ? _g : "").trim();
        const normalized = rawEnv.replace(/\*+$/, "");
        if (!MATH_ENVIRONMENTS.has(normalized)) {
            continue;
        }
        beginIndex = i;
        envName = normalized;
        break;
    }
    if (beginIndex >= 0 && envName) {
        let endIndex = -1;
        for (let i = beginIndex + 1; i < lines.length; i += 1) {
            const clean = stripComment((_h = lines[i]) !== null && _h !== void 0 ? _h : "");
            const match = clean.match(endRegex);
            if (!match) {
                continue;
            }
            const rawEnv = ((_j = match[1]) !== null && _j !== void 0 ? _j : "").trim();
            const normalized = rawEnv.replace(/\*+$/, "");
            if (normalized !== envName) {
                continue;
            }
            endIndex = i;
            break;
        }
        if (endIndex > beginIndex && idx <= endIndex) {
            const block = lines
                .slice(beginIndex, endIndex + 1)
                .map((line) => stripComment(line !== null && line !== void 0 ? line : ""))
                .join("\n")
                .replace(/\\label\{[^}]*\}/g, "")
                .trim();
            if (block) {
                return block;
            }
        }
    }
    return null;
};
const extractBibEntryText = (text, citeKey) => {
    if (!text || !citeKey) {
        return null;
    }
    const escaped = escapeRegExp(citeKey.trim());
    const headerRegex = new RegExp(`@\\w+\\s*\\{\\s*${escaped}\\s*,`, "i");
    const match = headerRegex.exec(text);
    if (!match || typeof match.index !== "number") {
        return null;
    }
    const openBraceIndex = text.indexOf("{", match.index);
    if (openBraceIndex < 0) {
        return null;
    }
    let depth = 0;
    let endIndex = -1;
    for (let i = openBraceIndex; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "{") {
            depth += 1;
        }
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                endIndex = i;
                break;
            }
        }
    }
    if (endIndex < 0) {
        return null;
    }
    return text.slice(match.index, endIndex + 1);
};
const parseBibFields = (entryText) => {
    const fields = {};
    if (!entryText) {
        return fields;
    }
    const firstComma = entryText.indexOf(",");
    if (firstComma < 0) {
        return fields;
    }
    let i = firstComma + 1;
    const len = entryText.length;
    const skipSpace = () => {
        while (i < len && /[\s,]/.test(entryText[i])) {
            i += 1;
        }
    };
    const readName = () => {
        const start = i;
        while (i < len && /[A-Za-z]/.test(entryText[i])) {
            i += 1;
        }
        return entryText.slice(start, i);
    };
    const readValue = () => {
        skipSpace();
        if (i >= len) {
            return "";
        }
        const ch = entryText[i];
        if (ch === "{") {
            i += 1;
            let depth = 1;
            const start = i;
            while (i < len && depth > 0) {
                const c = entryText[i];
                if (c === "{") {
                    depth += 1;
                }
                else if (c === "}") {
                    depth -= 1;
                }
                i += 1;
            }
            const raw = entryText.slice(start, Math.max(start, i - 1));
            return raw;
        }
        if (ch === "\"") {
            i += 1;
            const start = i;
            while (i < len) {
                const c = entryText[i];
                if (c === "\\" && i + 1 < len) {
                    i += 2;
                    continue;
                }
                if (c === "\"") {
                    break;
                }
                i += 1;
            }
            const raw = entryText.slice(start, i);
            if (entryText[i] === "\"") {
                i += 1;
            }
            return raw;
        }
        const start = i;
        while (i < len && entryText[i] !== "," && entryText[i] !== "\n") {
            i += 1;
        }
        return entryText.slice(start, i);
    };
    while (i < len) {
        skipSpace();
        const name = readName();
        if (!name) {
            break;
        }
        skipSpace();
        if (entryText[i] !== "=") {
            break;
        }
        i += 1;
        const value = readValue()
            .replace(/\s+/g, " ")
            .trim()
            .replace(/^{|}$/g, "")
            .trim();
        if (value) {
            fields[name.toLowerCase()] = value;
        }
        skipSpace();
        if (entryText[i] === ",") {
            i += 1;
        }
    }
    return fields;
};
const resolveGraphicsCandidates = (activeFilePath, rawPath, workspaceFiles) => {
    var _a;
    const normalizePosixPath = (value) => {
        const parts = value.split("/").filter(Boolean);
        const stack = [];
        for (const part of parts) {
            if (part === ".") {
                continue;
            }
            if (part === "..") {
                if (stack.length > 0 && stack[stack.length - 1] !== "..") {
                    stack.pop();
                }
                else {
                    stack.push("..");
                }
                continue;
            }
            stack.push(part);
        }
        return stack.join("/");
    };
    const normalized = rawPath.trim().split("\\").join("/");
    if (!normalized) {
        return [];
    }
    const activeDir = activeFilePath.split("\\").join("/").split("/").slice(0, -1).join("/");
    const base = normalized.startsWith("/") ? normalized.replace(/^\/+/, "") : normalized;
    const resolved = normalizePosixPath(activeDir ? `${activeDir}/${base}` : base);
    const hasExt = ((_a = resolved.split("/").pop()) !== null && _a !== void 0 ? _a : "").includes(".");
    const allowedExts = ["png", "jpg", "jpeg", "pdf", "svg", "eps", "tif", "tiff"];
    const candidates = [];
    if (hasExt) {
        candidates.push(resolved);
    }
    else {
        candidates.push(resolved);
        allowedExts.forEach((ext) => candidates.push(`${resolved}.${ext}`));
    }
    const workspaceSet = new Set(workspaceFiles.map((p) => p.split("\\").join("/")));
    return candidates.filter((candidate) => workspaceSet.has(candidate));
};
const isPreviewableImagePath = (pathValue) => {
    var _a, _b, _c;
    const ext = (_c = (_b = ((_a = pathValue.split("/").pop()) !== null && _a !== void 0 ? _a : "").split(".").pop()) === null || _b === void 0 ? void 0 : _b.toLowerCase()) !== null && _c !== void 0 ? _c : "";
    return ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "tif", "tiff", "ico"].includes(ext);
};
export const registerHoverProvider = (monaco, deps, state) => {
    var _a;
    if (state.registered || typeof ((_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerHoverProvider) !== "function") {
        return;
    }
    const provideHover = (model, position) => {
        var _a;
        const activePath = deps.getActiveFilePath();
        if (!activePath || !activePath.endsWith(".tex")) {
            return null;
        }
        const line = model.getLineContent(position.lineNumber);
        const cursorIndex = getCursorIndex(position);
        const refMatch = findCommandMatchAt(line, cursorIndex, /\\(eqref|ref|pageref|autoref|cref|Cref|namecref|Namecref|nameref|Nameref)\{([^}]+)\}/g, extractSingleKey);
        if (refMatch) {
            const entries = deps.getIndexLabels().filter((entry) => entry.key === refMatch.key);
            const seen = new Set();
            const deduped = entries
                .filter((entry) => {
                const token = `${entry.path}:${entry.line}`;
                if (seen.has(token)) {
                    return false;
                }
                seen.add(token);
                return true;
            })
                .sort((a, b) => {
                if (a.path !== b.path) {
                    return a.path.localeCompare(b.path, "ja");
                }
                return a.line - b.line;
            });
            const locations = deduped.length > 0
                ? deduped.map((entry) => `- ${entry.path}:${entry.line}`).join("\n")
                : "- 未解決";
            const primary = deduped.length > 0 ? deduped[0] : null;
            const viewOnPdfLink = primary && primary.path && primary.line
                ? buildViewOnPdfLink({ path: primary.path, line: primary.line })
                : null;
            const range = monaco.Range
                ? new monaco.Range(position.lineNumber, refMatch.startIndex + 1, position.lineNumber, refMatch.endIndex + 1)
                : undefined;
            if (primary &&
                typeof deps.requestFileExcerpt === "function" &&
                typeof primary.path === "string" &&
                Number.isFinite(primary.line)) {
                return deps
                    .requestFileExcerpt(primary.path, primary.line, { radius: 48, maxLines: 220 })
                    .then((excerpt) => {
                    var _a, _b;
                    const mathBlock = (excerpt === null || excerpt === void 0 ? void 0 : excerpt.ok) && Array.isArray(excerpt.lines)
                        ? extractMathBlockFromExcerpt({
                            startLine: (_a = excerpt.startLine) !== null && _a !== void 0 ? _a : primary.line,
                            lines: excerpt.lines,
                            targetLine: primary.line,
                        })
                        : null;
                    const mathPreviewHtml = mathBlock ? buildMathPreviewMarkdown(mathBlock) : null;
                    const snippet = (excerpt === null || excerpt === void 0 ? void 0 : excerpt.ok) && Array.isArray(excerpt.lines)
                        ? (() => {
                            var _a;
                            const slice = sliceExcerptAroundLine({
                                startLine: (_a = excerpt.startLine) !== null && _a !== void 0 ? _a : primary.line,
                                lines: excerpt.lines,
                                targetLine: primary.line,
                                radius: 5,
                                maxLines: 18,
                            });
                            return renderExcerpt({
                                startLine: slice.startLine,
                                lines: slice.lines,
                                highlightLine: primary.line,
                            });
                        })()
                        : null;
                    const excerptError = excerpt && !excerpt.ok
                        ? (_b = excerpt.error) !== null && _b !== void 0 ? _b : "抜粋を取得できませんでした。"
                        : null;
                    const contents = [
                        { value: `**\\\\${refMatch.command || "ref"}{${refMatch.key}}**` },
                        { value: `定義:\n${locations}` },
                    ];
                    if (viewOnPdfLink) {
                        contents.push({ value: viewOnPdfLink, isTrusted: true });
                    }
                    if (snippet) {
                        contents.push({ value: snippet });
                    }
                    else if (excerptError) {
                        contents.push({ value: `(${excerptError})` });
                    }
                    if (mathPreviewHtml) {
                        contents.push({
                            value: mathPreviewHtml,
                            isTrusted: true,
                            supportHtml: true,
                        });
                    }
                    return { contents, range };
                });
            }
            return {
                contents: [
                    { value: `**\\\\${refMatch.command || "ref"}{${refMatch.key}}**` },
                    { value: `定義:\n${locations}` },
                    ...(viewOnPdfLink ? [{ value: viewOnPdfLink, isTrusted: true }] : []),
                ],
                range,
            };
        }
        const citeMatch = findCommandMatchAt(line, cursorIndex, /\\(cite|citet|citep|citeauthor|citeyear|autocite|parencite|textcite|footcite|supercite)(?:\\[[^\\]]*\\])*\{([^}]+)\}/g, extractCiteKey);
        if (citeMatch) {
            const entries = pickCitationEntries(deps.getIndexCitations()).filter((entry) => entry.key === citeMatch.key);
            const locations = entries.length > 0
                ? entries.map((entry) => `- ${entry.path}:${entry.line}`).join("\n")
                : "- 未解決";
            const primary = entries.length > 0 ? entries[0] : null;
            const range = monaco.Range
                ? new monaco.Range(position.lineNumber, citeMatch.startIndex + 1, position.lineNumber, citeMatch.endIndex + 1)
                : undefined;
            if (primary &&
                typeof deps.requestFileExcerpt === "function" &&
                typeof primary.path === "string" &&
                primary.path.endsWith(".bib") &&
                Number.isFinite(primary.line)) {
                return deps
                    .requestFileExcerpt(primary.path, primary.line, { radius: 120, maxLines: 260 })
                    .then((excerpt) => {
                    const excerptLines = (excerpt === null || excerpt === void 0 ? void 0 : excerpt.ok) ? excerpt.lines : null;
                    const startLine = (excerpt === null || excerpt === void 0 ? void 0 : excerpt.ok) ? excerpt.startLine : null;
                    const text = (excerpt === null || excerpt === void 0 ? void 0 : excerpt.ok) && Array.isArray(excerptLines) ? excerptLines.join("\n") : "";
                    const entryText = extractBibEntryText(text, citeMatch.key);
                    const fields = entryText ? parseBibFields(entryText) : {};
                    const title = fields.title || "";
                    const author = fields.author || "";
                    const year = fields.year || "";
                    const where = typeof primary.path === "string" && Number.isFinite(primary.line)
                        ? `\`${primary.path}:${primary.line}\``
                        : "";
                    const summaryParts = [
                        title ? `**Title**: ${title}` : "",
                        author ? `**Author**: ${author}` : "",
                        year ? `**Year**: ${year}` : "",
                    ].filter(Boolean);
                    const contents = [
                        { value: `**\\\\${citeMatch.command || "cite"}{${citeMatch.key}}**` },
                    ];
                    if (where) {
                        contents.push({ value: where });
                    }
                    if (summaryParts.length > 0) {
                        contents.push({ value: summaryParts.join("\n") });
                    }
                    else {
                        contents.push({ value: `定義:\n${locations}` });
                    }
                    if ((excerpt === null || excerpt === void 0 ? void 0 : excerpt.ok) && Array.isArray(excerptLines) && typeof startLine === "number") {
                        const slice = sliceExcerptAroundLine({
                            startLine: startLine,
                            lines: excerptLines,
                            targetLine: primary.line,
                            radius: 5,
                            maxLines: 18,
                        });
                        contents.push({
                            value: renderExcerpt({
                                startLine: slice.startLine,
                                lines: slice.lines,
                                highlightLine: primary.line,
                            }),
                        });
                    }
                    return { contents, range };
                });
            }
            return {
                contents: [
                    { value: `**\\\\${citeMatch.command || "cite"}{${citeMatch.key}}**` },
                    { value: `定義:\n${locations}` },
                ],
                range,
            };
        }
        const graphicsHit = findCommandMatchAt(line, cursorIndex, /\\includegraphics(?:\\[[^\\]]*\\])?\{([^}]+)\}/g, (match, cursorIdx) => {
            var _a, _b, _c, _d;
            const content = (_a = match[1]) !== null && _a !== void 0 ? _a : "";
            const braceIndex = match[0].indexOf("{");
            if (braceIndex < 0 || typeof match.index !== "number") {
                return null;
            }
            const contentStart = match.index + braceIndex + 1;
            const contentEnd = contentStart + content.length;
            if (cursorIdx < contentStart || cursorIdx > contentEnd) {
                return null;
            }
            const trimmed = content.trim();
            if (!trimmed) {
                return null;
            }
            const leading = (_d = (_c = (_b = content.match(/^\s*/)) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : 0;
            return {
                command: "includegraphics",
                key: trimmed,
                startIndex: contentStart + leading,
                endIndex: contentStart + leading + trimmed.length,
            };
        });
        if (graphicsHit) {
            const candidates = resolveGraphicsCandidates(activePath, graphicsHit.key, deps.getWorkspaceFiles());
            const range = monaco.Range
                ? new monaco.Range(position.lineNumber, graphicsHit.startIndex + 1, position.lineNumber, graphicsHit.endIndex + 1)
                : undefined;
            const value = candidates.length > 0
                ? `見つかりました:\n${candidates.map((p) => `- ${p}`).join("\n")}`
                : "見つかりません（パス/拡張子を確認してください）。";
            const previewTarget = (_a = candidates.find((path) => isPreviewableImagePath(path))) !== null && _a !== void 0 ? _a : null;
            if (previewTarget && typeof deps.requestFilePreview === "function") {
                return deps.requestFilePreview(previewTarget).then((preview) => {
                    if ((preview === null || preview === void 0 ? void 0 : preview.ok) && typeof preview.dataUrl === "string" && preview.dataUrl) {
                        return {
                            contents: [
                                { value: `**\\\\includegraphics**` },
                                { value: `\`${previewTarget}\`` },
                                { value: `![preview](${preview.dataUrl})`, isTrusted: true },
                            ],
                            range,
                        };
                    }
                    return {
                        contents: [{ value: `**\\\\includegraphics**` }, { value }],
                        range,
                    };
                });
            }
            return {
                contents: [{ value: `**\\\\includegraphics**` }, { value }],
                range,
            };
        }
        const mathHit = findInlineMathAt(line, cursorIndex);
        if (mathHit) {
            const range = monaco.Range
                ? new monaco.Range(position.lineNumber, mathHit.startIndex + 1, position.lineNumber, mathHit.endIndex + 1)
                : undefined;
            const previewHtml = buildMathPreviewMarkdown(mathHit.latex);
            const contents = [{ value: "**Math Preview**" }, { value: `\`${mathHit.raw}\`` }];
            if (previewHtml) {
                contents.push({ value: previewHtml, isTrusted: true, supportHtml: true });
            }
            else {
                contents.push({ value: `\`\`\`tex\n${mathHit.latex}\n\`\`\`` });
            }
            return { contents, range };
        }
        return null;
    };
    ["latex", "plaintext"].forEach((languageId) => {
        var _a, _b;
        (_b = (_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerHoverProvider) === null || _b === void 0 ? void 0 : _b.call(_a, languageId, { provideHover });
    });
    state.registered = true;
};
