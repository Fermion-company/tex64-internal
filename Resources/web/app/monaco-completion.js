import { dedupeByKey, pickCitationEntries } from "./index-utils.js";
const REF_COMMAND_REGEX = /\\(?:eqref|ref|pageref|autoref|cref|Cref|namecref|Namecref|nameref|Nameref)\{([^}]*)$/;
const CITE_COMMAND_REGEX = /\\(?:cite|citet|citep|citeauthor|citeyear|autocite|parencite|textcite|footcite|supercite)(?:\\[[^\\]]*\\])*\\{([^}]*)$/;
const getPosixDirname = (filePath) => {
    const normalized = filePath.split("\\").join("/");
    const index = normalized.lastIndexOf("/");
    return index >= 0 ? normalized.slice(0, index) : "";
};
const posixRelative = (fromDir, toPath) => {
    const fromParts = fromDir ? fromDir.split("/").filter(Boolean) : [];
    const toParts = toPath ? toPath.split("/").filter(Boolean) : [];
    let common = 0;
    while (common < fromParts.length &&
        common < toParts.length &&
        fromParts[common] === toParts[common]) {
        common += 1;
    }
    const upCount = fromParts.length - common;
    const down = toParts.slice(common);
    const parts = [];
    for (let i = 0; i < upCount; i += 1) {
        parts.push("..");
    }
    parts.push(...down);
    return parts.join("/") || "";
};
const stripExtension = (pathValue) => {
    const idx = pathValue.lastIndexOf(".");
    if (idx <= 0) {
        return pathValue;
    }
    return pathValue.slice(0, idx);
};
const hasExplicitExtension = (pathValue) => {
    var _a;
    const name = (_a = pathValue.split("/").pop()) !== null && _a !== void 0 ? _a : "";
    return name.includes(".");
};
const findPathCandidates = (params) => {
    var _a;
    const activeDir = getPosixDirname(params.activeFilePath);
    const raw = (_a = params.partial) !== null && _a !== void 0 ? _a : "";
    const normalizedRaw = raw
        .split("\\")
        .join("/")
        .replace(/^\/+/, "")
        .replace(/^(\.\/)+/, "");
    const typedHasExt = hasExplicitExtension(normalizedRaw);
    const candidates = [];
    params.workspaceFiles.forEach((filePath) => {
        var _a, _b;
        const normalized = filePath.split("\\").join("/");
        const ext = (_b = (_a = normalized.split(".").pop()) === null || _a === void 0 ? void 0 : _a.toLowerCase()) !== null && _b !== void 0 ? _b : "";
        if (!params.allowedExtensions.has(ext)) {
            return;
        }
        const relativeFromActive = posixRelative(activeDir, normalized);
        const insertBase = params.preferOmitExtension && !typedHasExt ? stripExtension(relativeFromActive) : relativeFromActive;
        if (normalizedRaw && !insertBase.startsWith(normalizedRaw)) {
            return;
        }
        candidates.push({
            label: insertBase,
            insertText: insertBase,
            detail: normalized,
        });
    });
    const unique = new Map();
    candidates.forEach((entry) => {
        if (!unique.has(entry.label)) {
            unique.set(entry.label, entry);
        }
    });
    return Array.from(unique.values()).sort((a, b) => a.label.localeCompare(b.label, "ja"));
};
const ENV_SNIPPETS = {
    figure: `figure}\n  \\centering\n  \\includegraphics[width=\\linewidth]{\${1:path}}\n  \\caption{\${2:caption}}\n  \\label{fig:\${3:key}}\n\\end{figure}`,
    table: `table}\n  \\centering\n  \\caption{\${1:caption}}\n  \\label{tab:\${2:key}}\n  \\begin{tabular}{\${3:cc}}\n    \${0}\n  \\end{tabular}\n\\end{table}`,
    align: `align}\n  \${0}\n\\end{align}`,
    itemize: `itemize}\n  \\item \${0}\n\\end{itemize}`,
};
export const registerCompletionProvider = (monaco, deps, state) => {
    var _a, _b, _c, _d, _e;
    if (state.registered || !((_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerCompletionItemProvider)) {
        return;
    }
    (_c = (_b = monaco.languages).register) === null || _c === void 0 ? void 0 : _c.call(_b, { id: "latex" });
    (_e = (_d = monaco.languages).register) === null || _e === void 0 ? void 0 : _e.call(_d, { id: "bibtex" });
    const provideItems = (model, position) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t;
        const activePath = deps.getActiveFilePath();
        if (!activePath || !activePath.endsWith(".tex")) {
            return { suggestions: [] };
        }
        const line = model.getLineContent(position.lineNumber);
        const linePrefix = line.slice(0, Math.max(position.column - 1, 0));
        const refMatch = linePrefix.match(REF_COMMAND_REGEX);
        const citeMatch = linePrefix.match(CITE_COMMAND_REGEX);
        const inputMatch = linePrefix.match(/\\input\{([^}]*)$/);
        const includeMatch = linePrefix.match(/\\include\{([^}]*)$/);
        const graphicsMatch = linePrefix.match(/\\includegraphics(?:\\[[^\\]]*\\])?\{([^}]*)$/);
        const beginMatch = linePrefix.match(/\\begin\{([^}]*)$/);
        let entries = [];
        let partial = "";
        if (refMatch) {
            entries = dedupeByKey(deps.getIndexLabels());
            partial = ((_a = refMatch === null || refMatch === void 0 ? void 0 : refMatch[1]) !== null && _a !== void 0 ? _a : "").trimStart();
        }
        else if (citeMatch) {
            entries = pickCitationEntries(deps.getIndexCitations());
            const raw = (_b = citeMatch[1]) !== null && _b !== void 0 ? _b : "";
            const parts = raw.split(",");
            partial = parts.length > 0 ? parts[parts.length - 1].trimStart() : "";
        }
        else if (inputMatch || includeMatch || graphicsMatch) {
            const activePath = deps.getActiveFilePath();
            if (!activePath || !activePath.endsWith(".tex")) {
                return { suggestions: [] };
            }
            const workspaceFiles = deps.getWorkspaceFiles();
            const rawPartial = ((_e = (_d = (_c = inputMatch === null || inputMatch === void 0 ? void 0 : inputMatch[1]) !== null && _c !== void 0 ? _c : includeMatch === null || includeMatch === void 0 ? void 0 : includeMatch[1]) !== null && _d !== void 0 ? _d : graphicsMatch === null || graphicsMatch === void 0 ? void 0 : graphicsMatch[1]) !== null && _e !== void 0 ? _e : "").trimStart();
            const allowedExtensions = inputMatch || includeMatch
                ? new Set(["tex"])
                : new Set(["png", "jpg", "jpeg", "pdf", "svg", "eps", "tif", "tiff"]);
            const suggestions = findPathCandidates({
                workspaceFiles,
                activeFilePath: activePath,
                partial: rawPartial,
                allowedExtensions,
                preferOmitExtension: Boolean(inputMatch || includeMatch),
            });
            const range = monaco.Range
                ? new monaco.Range(position.lineNumber, position.column - rawPartial.length, position.lineNumber, position.column)
                : undefined;
            const kind = (_l = (_h = (_g = (_f = monaco.languages) === null || _f === void 0 ? void 0 : _f.CompletionItemKind) === null || _g === void 0 ? void 0 : _g.Value) !== null && _h !== void 0 ? _h : (_k = (_j = monaco.languages) === null || _j === void 0 ? void 0 : _j.CompletionItemKind) === null || _k === void 0 ? void 0 : _k.Reference) !== null && _l !== void 0 ? _l : 12;
            return {
                suggestions: suggestions.map((entry) => ({
                    label: entry.label,
                    kind,
                    insertText: entry.insertText,
                    range,
                    detail: entry.detail,
                })),
            };
        }
        else if (beginMatch) {
            const typed = ((_m = beginMatch[1]) !== null && _m !== void 0 ? _m : "").trimStart();
            const envNames = ["figure", "table", "align", "itemize", "enumerate", "quote", "center"];
            const filtered = envNames.filter((name) => name.startsWith(typed));
            const range = monaco.Range
                ? new monaco.Range(position.lineNumber, position.column - typed.length, position.lineNumber, position.column)
                : undefined;
            const kind = 27;
            const insertTextRule = 4;
            return {
                suggestions: filtered.map((env) => {
                    var _a;
                    return ({
                        label: env,
                        kind,
                        insertText: (_a = ENV_SNIPPETS[env]) !== null && _a !== void 0 ? _a : `${env}}\n  \${0}\n\\end{${env}}`,
                        insertTextRules: insertTextRule,
                        range,
                    });
                }),
            };
        }
        else {
            return { suggestions: [] };
        }
        const range = monaco.Range
            ? new monaco.Range(position.lineNumber, position.column - partial.length, position.lineNumber, position.column)
            : undefined;
        const kind = (_t = (_q = (_p = (_o = monaco.languages) === null || _o === void 0 ? void 0 : _o.CompletionItemKind) === null || _p === void 0 ? void 0 : _p.Reference) !== null && _q !== void 0 ? _q : (_s = (_r = monaco.languages) === null || _r === void 0 ? void 0 : _r.CompletionItemKind) === null || _s === void 0 ? void 0 : _s.Value) !== null && _t !== void 0 ? _t : 17;
        const suggestions = entries.map((entry) => ({
            label: entry.key,
            kind,
            insertText: entry.key,
            range,
            detail: entry.path,
        }));
        return { suggestions };
    };
    ["latex", "plaintext"].forEach((languageId) => {
        var _a, _b;
        (_b = (_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerCompletionItemProvider) === null || _b === void 0 ? void 0 : _b.call(_a, languageId, {
            triggerCharacters: ["{", ",", "\\", "/", "."],
            provideCompletionItems: provideItems,
        });
    });
    state.registered = true;
};
