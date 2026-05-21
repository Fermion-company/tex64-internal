// Pure conversions between LSP wire types and monaco's editor types. monaco is
// passed in (the global loaded via the AMD loader) so we can use its Range/Uri
// constructors and resolve its kind enums by name rather than hardcoding values
// that differ between LSP and monaco.
// monaco: 1-based line/column. LSP: 0-based line/character.
export const toLspPosition = (position) => ({
    line: Math.max(0, position.lineNumber - 1),
    character: Math.max(0, position.column - 1),
});
export const toMonacoRange = (monaco, range) => new monaco.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
export const toMonacoTextEdit = (monaco, edit) => ({
    range: toMonacoRange(monaco, edit.range),
    text: edit.newText,
});
// LSP CompletionItemKind (1-based) -> monaco CompletionItemKind name.
const LSP_COMPLETION_KIND = {
    1: "Text",
    2: "Method",
    3: "Function",
    4: "Constructor",
    5: "Field",
    6: "Variable",
    7: "Class",
    8: "Interface",
    9: "Module",
    10: "Property",
    11: "Unit",
    12: "Value",
    13: "Enum",
    14: "Keyword",
    15: "Snippet",
    16: "Color",
    17: "File",
    18: "Reference",
    19: "Folder",
    20: "EnumMember",
    21: "Constant",
    22: "Struct",
    23: "Event",
    24: "Operator",
    25: "TypeParameter",
};
export const toMonacoCompletionKind = (monaco, lspKind) => {
    var _a, _b, _c, _d, _e;
    const kinds = (_b = (_a = monaco === null || monaco === void 0 ? void 0 : monaco.languages) === null || _a === void 0 ? void 0 : _a.CompletionItemKind) !== null && _b !== void 0 ? _b : {};
    const name = (_c = LSP_COMPLETION_KIND[lspKind !== null && lspKind !== void 0 ? lspKind : 1]) !== null && _c !== void 0 ? _c : "Text";
    return (_e = (_d = kinds[name]) !== null && _d !== void 0 ? _d : kinds.Text) !== null && _e !== void 0 ? _e : 0;
};
// LSP SymbolKind (1-based) -> monaco SymbolKind name.
const LSP_SYMBOL_KIND = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    20: "Key",
    21: "Null",
    22: "EnumMember",
    23: "Struct",
    24: "Event",
    25: "Operator",
    26: "TypeParameter",
};
export const toMonacoSymbolKind = (monaco, lspKind) => {
    var _a, _b, _c, _d, _e;
    const kinds = (_b = (_a = monaco === null || monaco === void 0 ? void 0 : monaco.languages) === null || _a === void 0 ? void 0 : _a.SymbolKind) !== null && _b !== void 0 ? _b : {};
    const name = (_c = LSP_SYMBOL_KIND[lspKind !== null && lspKind !== void 0 ? lspKind : 13]) !== null && _c !== void 0 ? _c : "Variable";
    return (_e = (_d = kinds[name]) !== null && _d !== void 0 ? _d : kinds.Variable) !== null && _e !== void 0 ? _e : 0;
};
// LSP DiagnosticSeverity (1 Error..4 Hint) -> monaco MarkerSeverity.
export const toMonacoMarkerSeverity = (monaco, severity) => {
    var _a, _b, _c, _d, _e, _f;
    const s = (_a = monaco === null || monaco === void 0 ? void 0 : monaco.MarkerSeverity) !== null && _a !== void 0 ? _a : {};
    switch (severity) {
        case 1:
            return (_b = s.Error) !== null && _b !== void 0 ? _b : 8;
        case 2:
            return (_c = s.Warning) !== null && _c !== void 0 ? _c : 4;
        case 3:
            return (_d = s.Info) !== null && _d !== void 0 ? _d : 2;
        case 4:
            return (_e = s.Hint) !== null && _e !== void 0 ? _e : 1;
        default:
            return (_f = s.Error) !== null && _f !== void 0 ? _f : 8;
    }
};
const markedStringToMarkdown = (item) => {
    if (typeof item === "string") {
        return item;
    }
    if (item && typeof item.value === "string") {
        return item.language ? `\`\`\`${item.language}\n${item.value}\n\`\`\`` : item.value;
    }
    return "";
};
// LSP documentation/hover contents -> monaco IMarkdownString ({ value }).
export const toMarkdownString = (contents) => {
    if (contents === undefined || contents === null) {
        return undefined;
    }
    if (typeof contents === "string") {
        return { value: contents };
    }
    if (Array.isArray(contents)) {
        const value = contents.map(markedStringToMarkdown).filter(Boolean).join("\n\n");
        return value ? { value } : undefined;
    }
    // MarkupContent or MarkedString object.
    const maybeMarkup = contents;
    if (typeof maybeMarkup.value === "string" && maybeMarkup.kind !== undefined) {
        return { value: maybeMarkup.value };
    }
    const value = markedStringToMarkdown(contents);
    return value ? { value } : undefined;
};
// LSP CompletionItem -> monaco completion item. `defaultRange` is used when the
// item carries no textEdit (monaco requires a range).
export const toMonacoCompletionItem = (monaco, item, defaultRange) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const insertAsSnippet = (item === null || item === void 0 ? void 0 : item.insertTextFormat) === 2;
    const snippetRule = (_c = (_b = (_a = monaco === null || monaco === void 0 ? void 0 : monaco.languages) === null || _a === void 0 ? void 0 : _a.CompletionItemInsertTextRule) === null || _b === void 0 ? void 0 : _b.InsertAsSnippet) !== null && _c !== void 0 ? _c : 4;
    let insertText = (_e = (_d = item === null || item === void 0 ? void 0 : item.insertText) !== null && _d !== void 0 ? _d : item === null || item === void 0 ? void 0 : item.label) !== null && _e !== void 0 ? _e : "";
    let range = defaultRange;
    const textEdit = item === null || item === void 0 ? void 0 : item.textEdit;
    if (textEdit) {
        insertText = (_f = textEdit.newText) !== null && _f !== void 0 ? _f : insertText;
        const editRange = (_h = (_g = textEdit.range) !== null && _g !== void 0 ? _g : textEdit.replace) !== null && _h !== void 0 ? _h : textEdit.insert;
        if (editRange) {
            range = toMonacoRange(monaco, editRange);
        }
    }
    const additionalTextEdits = Array.isArray(item === null || item === void 0 ? void 0 : item.additionalTextEdits)
        ? item.additionalTextEdits.map((edit) => toMonacoTextEdit(monaco, edit))
        : undefined;
    return {
        label: (_j = item === null || item === void 0 ? void 0 : item.label) !== null && _j !== void 0 ? _j : "",
        kind: toMonacoCompletionKind(monaco, item === null || item === void 0 ? void 0 : item.kind),
        insertText,
        insertTextRules: insertAsSnippet ? snippetRule : undefined,
        range,
        detail: item === null || item === void 0 ? void 0 : item.detail,
        documentation: toMarkdownString(item === null || item === void 0 ? void 0 : item.documentation),
        sortText: item === null || item === void 0 ? void 0 : item.sortText,
        filterText: item === null || item === void 0 ? void 0 : item.filterText,
        preselect: item === null || item === void 0 ? void 0 : item.preselect,
        additionalTextEdits,
        command: (item === null || item === void 0 ? void 0 : item.command)
            ? { id: item.command.command, title: item.command.title, arguments: item.command.arguments }
            : undefined,
    };
};
// LSP Location | LocationLink -> monaco { uri, range }.
export const toMonacoLocation = (monaco, location) => {
    var _a;
    if (!location) {
        return null;
    }
    // LocationLink has targetUri/targetSelectionRange.
    if (location.targetUri) {
        return {
            uri: monaco.Uri.parse(location.targetUri),
            range: toMonacoRange(monaco, (_a = location.targetSelectionRange) !== null && _a !== void 0 ? _a : location.targetRange),
        };
    }
    if (location.uri && location.range) {
        return {
            uri: monaco.Uri.parse(location.uri),
            range: toMonacoRange(monaco, location.range),
        };
    }
    return null;
};
export const toMonacoLocations = (monaco, result) => {
    if (!result) {
        return [];
    }
    const list = Array.isArray(result) ? result : [result];
    return list.map((item) => toMonacoLocation(monaco, item)).filter((loc) => loc !== null);
};
// LSP DocumentSymbol[] (hierarchical) | SymbolInformation[] -> monaco DocumentSymbol[].
export const toMonacoDocumentSymbols = (monaco, result) => {
    if (!Array.isArray(result)) {
        return [];
    }
    return result.map((symbol) => {
        var _a, _b, _c;
        // SymbolInformation has `location`; DocumentSymbol has `range`/`selectionRange`.
        const range = symbol.range
            ? toMonacoRange(monaco, symbol.range)
            : symbol.location
                ? toMonacoRange(monaco, symbol.location.range)
                : undefined;
        const selectionRange = symbol.selectionRange
            ? toMonacoRange(monaco, symbol.selectionRange)
            : range;
        return {
            name: (_a = symbol.name) !== null && _a !== void 0 ? _a : "",
            detail: (_b = symbol.detail) !== null && _b !== void 0 ? _b : "",
            kind: toMonacoSymbolKind(monaco, symbol.kind),
            tags: (_c = symbol.tags) !== null && _c !== void 0 ? _c : [],
            range,
            selectionRange,
            children: Array.isArray(symbol.children)
                ? toMonacoDocumentSymbols(monaco, symbol.children)
                : [],
        };
    });
};
// LSP FoldingRange[] -> monaco FoldingRange[] (1-based line numbers).
export const toMonacoFoldingRanges = (result) => {
    if (!Array.isArray(result)) {
        return [];
    }
    return result.map((range) => {
        var _a, _b;
        return ({
            start: ((_a = range.startLine) !== null && _a !== void 0 ? _a : 0) + 1,
            end: ((_b = range.endLine) !== null && _b !== void 0 ? _b : 0) + 1,
        });
    });
};
// LSP DocumentHighlight[] -> monaco DocumentHighlight[]. Kinds differ by one
// (LSP Text=1/Read=2/Write=3, monaco Text=0/Read=1/Write=2).
export const toMonacoDocumentHighlights = (monaco, result) => {
    if (!Array.isArray(result)) {
        return [];
    }
    return result
        .filter((h) => h && h.range)
        .map((h) => ({
        range: toMonacoRange(monaco, h.range),
        kind: typeof h.kind === "number" ? Math.max(0, h.kind - 1) : 0,
    }));
};
// LSP InlayHint[] -> monaco InlayHint[]. Label may be a string or label parts.
export const toMonacoInlayHints = (result) => {
    if (!Array.isArray(result)) {
        return [];
    }
    return result.map((hint) => {
        var _a, _b, _c, _d, _e;
        return ({
            position: {
                lineNumber: ((_b = (_a = hint.position) === null || _a === void 0 ? void 0 : _a.line) !== null && _b !== void 0 ? _b : 0) + 1,
                column: ((_d = (_c = hint.position) === null || _c === void 0 ? void 0 : _c.character) !== null && _d !== void 0 ? _d : 0) + 1,
            },
            label: Array.isArray(hint.label)
                ? hint.label.map((part) => { var _a; return (_a = part === null || part === void 0 ? void 0 : part.value) !== null && _a !== void 0 ? _a : ""; }).join("")
                : (_e = hint.label) !== null && _e !== void 0 ? _e : "",
            kind: hint.kind,
            paddingLeft: hint.paddingLeft,
            paddingRight: hint.paddingRight,
            tooltip: typeof hint.tooltip === "string" ? hint.tooltip : undefined,
        });
    });
};
// LSP DocumentLink[] -> monaco ILink[]. `target` is a URI string monaco accepts.
export const toMonacoLinks = (monaco, result) => {
    if (!Array.isArray(result)) {
        return [];
    }
    return result
        .filter((link) => link && link.range)
        .map((link) => {
        const out = { range: toMonacoRange(monaco, link.range) };
        if (link.target) {
            out.url = link.target;
        }
        if (typeof link.tooltip === "string") {
            out.tooltip = link.tooltip;
        }
        return out;
    });
};
// LSP WorkspaceEdit -> monaco WorkspaceEdit ({ edits: [...] }).
export const toMonacoWorkspaceEdit = (monaco, workspaceEdit) => {
    const edits = [];
    if (!workspaceEdit) {
        return { edits };
    }
    const pushEdits = (uri, textEdits) => {
        const resource = monaco.Uri.parse(uri);
        textEdits.forEach((edit) => {
            const textEdit = toMonacoTextEdit(monaco, edit);
            edits.push({ resource, textEdit, edit: textEdit, versionId: undefined });
        });
    };
    if (workspaceEdit.changes && typeof workspaceEdit.changes === "object") {
        Object.keys(workspaceEdit.changes).forEach((uri) => {
            var _a;
            pushEdits(uri, (_a = workspaceEdit.changes[uri]) !== null && _a !== void 0 ? _a : []);
        });
    }
    if (Array.isArray(workspaceEdit.documentChanges)) {
        workspaceEdit.documentChanges.forEach((change) => {
            var _a;
            if (((_a = change === null || change === void 0 ? void 0 : change.textDocument) === null || _a === void 0 ? void 0 : _a.uri) && Array.isArray(change.edits)) {
                pushEdits(change.textDocument.uri, change.edits);
            }
        });
    }
    return { edits };
};
