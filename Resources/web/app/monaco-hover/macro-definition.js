/**
 * Locate the definition of a user-defined macro (\newcommand, \def,
 * \DeclareMathOperator, ...) within the current document so hovering a
 * custom command shows what it expands to. Pure text scanning — no DOM.
 */
import { escapeRegExp } from "./utils.js";
const DEFINITION_COMMANDS = "(?:re)?newcommand|providecommand|DeclareMathOperator|DeclareRobustCommand|" +
    "NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|" +
    "def|let|newcommandx|DeclarePairedDelimiter";
const MAX_DEFINITION_EXTRA_LINES = 4;
const MAX_DEFINITION_TEXT_CHARS = 280;
const buildDefinitionRegex = (command) => new RegExp(`\\\\(?:${DEFINITION_COMMANDS})\\s*\\*?\\s*\\{?\\s*\\\\${escapeRegExp(command)}(?![a-zA-Z@])`);
const braceBalance = (line) => {
    let balance = 0;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === "\\") {
            i += 1;
            continue;
        }
        if (ch === "%") {
            break;
        }
        if (ch === "{")
            balance += 1;
        else if (ch === "}")
            balance -= 1;
    }
    return balance;
};
/**
 * Scan the document for the definition of `command` (name without the
 * leading backslash). Returns the first definition found, or null.
 */
export const findMacroDefinitionInLines = (getLineContent, lineCount, command, maxLines = 5000) => {
    var _a, _b;
    const name = command.trim();
    if (!name || !/^[a-zA-Z@]+$/.test(name)) {
        return null;
    }
    const marker = `\\${name}`;
    const regex = buildDefinitionRegex(name);
    const limit = Math.min(lineCount, maxLines);
    for (let lineNumber = 1; lineNumber <= limit; lineNumber += 1) {
        let line = "";
        try {
            line = (_a = getLineContent(lineNumber)) !== null && _a !== void 0 ? _a : "";
        }
        catch {
            break;
        }
        if (!line.includes(marker)) {
            continue;
        }
        if (!regex.test(line)) {
            continue;
        }
        // Multi-line definitions: keep appending lines while braces stay open.
        const collected = [line.trim()];
        let balance = braceBalance(line);
        let extraLine = lineNumber + 1;
        while (balance > 0 &&
            extraLine <= limit &&
            collected.length <= MAX_DEFINITION_EXTRA_LINES) {
            let next = "";
            try {
                next = (_b = getLineContent(extraLine)) !== null && _b !== void 0 ? _b : "";
            }
            catch {
                break;
            }
            collected.push(next.trimEnd());
            balance += braceBalance(next);
            extraLine += 1;
        }
        let text = collected.join("\n");
        if (balance > 0) {
            text += "\n  …";
        }
        if (text.length > MAX_DEFINITION_TEXT_CHARS) {
            text = `${text.slice(0, MAX_DEFINITION_TEXT_CHARS - 1)}…`;
        }
        return { lineNumber, text };
    }
    return null;
};
/** Find the \command token containing the cursor on a line, if any. */
export const findCommandTokenAt = (line, cursorIndex) => {
    var _a;
    const regex = /\\([a-zA-Z@]+)/g;
    let match = regex.exec(line);
    while (match) {
        const start = match.index;
        const end = start + match[0].length;
        if (cursorIndex >= start && cursorIndex <= end) {
            // Ignore escaped backslash sequences like \\alpha inside \\\\.
            let slashes = 0;
            for (let i = start - 1; i >= 0 && line[i] === "\\"; i -= 1) {
                slashes += 1;
            }
            if (slashes % 2 === 1) {
                match = regex.exec(line);
                continue;
            }
            return { name: (_a = match[1]) !== null && _a !== void 0 ? _a : "", startIndex: start, endIndex: end };
        }
        match = regex.exec(line);
    }
    return null;
};
