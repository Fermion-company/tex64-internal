const normalizeLineEndings = (value) => value.replace(/\r\n?/g, "\n");
const getLineIndent = (line) => {
    const match = line.match(/^[ \t]*/);
    return match ? match[0] : "";
};
const stripIndent = (line, count) => {
    if (count <= 0) {
        return line;
    }
    let index = 0;
    let removed = 0;
    while (index < line.length && removed < count) {
        const char = line[index];
        if (char !== " " && char !== "\t") {
            break;
        }
        index += 1;
        removed += 1;
    }
    return line.slice(index);
};
const detectIndentUnit = (lines, baseIndent) => {
    if (baseIndent.includes("\t")) {
        return "\t";
    }
    for (const line of lines) {
        const indent = getLineIndent(line);
        if (indent.includes("\t")) {
            return "\t";
        }
    }
    const indents = lines
        .filter((line) => line.trim().length > 0)
        .map((line) => getLineIndent(line).length)
        .filter((length) => length > 0);
    if (indents.length === 0) {
        return "  ";
    }
    const sorted = Array.from(new Set(indents)).sort((a, b) => a - b);
    let minDiff = Infinity;
    for (let i = 1; i < sorted.length; i += 1) {
        const diff = sorted[i] - sorted[i - 1];
        if (diff > 0) {
            minDiff = Math.min(minDiff, diff);
        }
    }
    const unit = minDiff !== Infinity ? minDiff : sorted[0];
    return " ".repeat(unit);
};
const normalizeLinesForInsert = (lines, baseIndent) => {
    const nonEmpty = lines.filter((line) => line.trim().length > 0);
    if (nonEmpty.length === 0) {
        return lines;
    }
    let minIndent = Infinity;
    nonEmpty.forEach((line) => {
        minIndent = Math.min(minIndent, getLineIndent(line).length);
    });
    const stripped = lines.map((line) => {
        if (line.trim().length === 0) {
            return line;
        }
        return stripIndent(line, minIndent);
    });
    return stripped.map((line, index) => {
        if (index === 0 || line.trim().length === 0) {
            return line;
        }
        return baseIndent + line;
    });
};
const isDisplayWrapperPair = (firstLine, lastLine) => {
    const first = firstLine.trim();
    const last = lastLine.trim();
    if (first === "\\[" && last === "\\]") {
        return true;
    }
    if (first === "$$" && last === "$$") {
        return true;
    }
    return false;
};
const formatBlockLinesForInsert = (lines, baseIndent, indentUnit) => {
    const firstNonEmpty = lines.findIndex((line) => line.trim().length > 0);
    if (firstNonEmpty === -1) {
        return lines;
    }
    let lastNonEmpty = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].trim().length > 0) {
            lastNonEmpty = i;
            break;
        }
    }
    if (lastNonEmpty === -1 || lastNonEmpty === firstNonEmpty) {
        return normalizeLinesForInsert(lines, baseIndent);
    }
    const onlyBlankBefore = lines
        .slice(0, firstNonEmpty)
        .every((line) => line.trim().length === 0);
    const onlyBlankAfter = lines
        .slice(lastNonEmpty + 1)
        .every((line) => line.trim().length === 0);
    if (!onlyBlankBefore || !onlyBlankAfter) {
        return normalizeLinesForInsert(lines, baseIndent);
    }
    const firstLine = lines[firstNonEmpty].trim();
    const lastLine = lines[lastNonEmpty].trim();
    const isEnvPair = firstLine.startsWith("\\begin{") && lastLine.startsWith("\\end{");
    const isDisplayPair = isDisplayWrapperPair(firstLine, lastLine);
    if (!isEnvPair && !isDisplayPair) {
        return normalizeLinesForInsert(lines, baseIndent);
    }
    const innerLines = lines.slice(firstNonEmpty + 1, lastNonEmpty);
    const innerNonEmpty = innerLines.filter((line) => line.trim().length > 0);
    let innerMinIndent = 0;
    if (innerNonEmpty.length > 0) {
        innerMinIndent = innerNonEmpty.reduce((min, line) => {
            return Math.min(min, getLineIndent(line).length);
        }, Infinity);
        if (!Number.isFinite(innerMinIndent)) {
            innerMinIndent = 0;
        }
    }
    const innerIndent = isEnvPair ? indentUnit : baseIndent ? indentUnit : "";
    return lines.map((line, index) => {
        if (line.trim().length === 0) {
            return line;
        }
        const prefix = index === 0 ? "" : baseIndent;
        if (index === firstNonEmpty || index === lastNonEmpty) {
            return prefix + line.trimStart();
        }
        if (index > firstNonEmpty && index < lastNonEmpty) {
            const stripped = stripIndent(line, innerMinIndent);
            return prefix + innerIndent + stripped;
        }
        return prefix + line.trimStart();
    });
};
export const formatSnippetForInsert = (snippet, model, position, options) => {
    if (!position || !(model === null || model === void 0 ? void 0 : model.getLineContent)) {
        return snippet;
    }
    const lineContent = model.getLineContent(position.lineNumber);
    const prefix = lineContent.slice(0, Math.max(0, position.column - 1));
    if (prefix.trim().length > 0) {
        return snippet;
    }
    const normalized = normalizeLineEndings(snippet);
    if (!normalized.includes("\n")) {
        return snippet;
    }
    const lines = normalized.split("\n");
    const indentUnit = detectIndentUnit(lines, prefix);
    const formattedLines = (options === null || options === void 0 ? void 0 : options.alignEnv)
        ? formatBlockLinesForInsert(lines, prefix, indentUnit)
        : normalizeLinesForInsert(lines, prefix);
    return formattedLines.join("\n");
};
