// Pure conversions between LSP wire types and monaco's editor types. monaco is
// passed in (the global loaded via the AMD loader) so we can use its Range/Uri
// constructors and resolve its kind enums by name rather than hardcoding values
// that differ between LSP and monaco.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Monaco = any;

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };

// monaco: 1-based line/column. LSP: 0-based line/character.
export const toLspPosition = (position: { lineNumber: number; column: number }): LspPosition => ({
  line: Math.max(0, position.lineNumber - 1),
  character: Math.max(0, position.column - 1),
});

export const toMonacoRange = (monaco: Monaco, range: LspRange) =>
  new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1
  );

export const toMonacoTextEdit = (monaco: Monaco, edit: { range: LspRange; newText: string }) => ({
  range: toMonacoRange(monaco, edit.range),
  text: edit.newText,
});

// LSP CompletionItemKind (1-based) -> monaco CompletionItemKind name.
const LSP_COMPLETION_KIND: Record<number, string> = {
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

export const toMonacoCompletionKind = (monaco: Monaco, lspKind: number | undefined): number => {
  const kinds = monaco?.languages?.CompletionItemKind ?? {};
  const name = LSP_COMPLETION_KIND[lspKind ?? 1] ?? "Text";
  return kinds[name] ?? kinds.Text ?? 0;
};

// LSP SymbolKind (1-based) -> monaco SymbolKind name.
const LSP_SYMBOL_KIND: Record<number, string> = {
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

export const toMonacoSymbolKind = (monaco: Monaco, lspKind: number | undefined): number => {
  const kinds = monaco?.languages?.SymbolKind ?? {};
  const name = LSP_SYMBOL_KIND[lspKind ?? 13] ?? "Variable";
  return kinds[name] ?? kinds.Variable ?? 0;
};

// LSP DiagnosticSeverity (1 Error..4 Hint) -> monaco MarkerSeverity.
export const toMonacoMarkerSeverity = (monaco: Monaco, severity: number | undefined): number => {
  const s = monaco?.MarkerSeverity ?? {};
  switch (severity) {
    case 1:
      return s.Error ?? 8;
    case 2:
      return s.Warning ?? 4;
    case 3:
      return s.Info ?? 2;
    case 4:
      return s.Hint ?? 1;
    default:
      return s.Error ?? 8;
  }
};

type MarkupContent = { kind?: string; value?: string };
type MarkedString = string | { language?: string; value?: string };

const markedStringToMarkdown = (item: MarkedString): string => {
  if (typeof item === "string") {
    return item;
  }
  if (item && typeof item.value === "string") {
    return item.language ? `\`\`\`${item.language}\n${item.value}\n\`\`\`` : item.value;
  }
  return "";
};

// LSP documentation/hover contents -> monaco IMarkdownString ({ value }).
export const toMarkdownString = (
  contents: string | MarkupContent | MarkedString | MarkedString[] | undefined
): { value: string } | undefined => {
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
  const maybeMarkup = contents as MarkupContent;
  if (typeof maybeMarkup.value === "string" && maybeMarkup.kind !== undefined) {
    return { value: maybeMarkup.value };
  }
  const value = markedStringToMarkdown(contents as MarkedString);
  return value ? { value } : undefined;
};

// LSP CompletionItem -> monaco completion item. `defaultRange` is used when the
// item carries no textEdit (monaco requires a range).
export const toMonacoCompletionItem = (
  monaco: Monaco,
  item: any,
  defaultRange: unknown
) => {
  const insertAsSnippet = item?.insertTextFormat === 2;
  const snippetRule = monaco?.languages?.CompletionItemInsertTextRule?.InsertAsSnippet ?? 4;

  let insertText: string = item?.insertText ?? item?.label ?? "";
  let range: unknown = defaultRange;

  const textEdit = item?.textEdit;
  if (textEdit) {
    insertText = textEdit.newText ?? insertText;
    const editRange = textEdit.range ?? textEdit.replace ?? textEdit.insert;
    if (editRange) {
      range = toMonacoRange(monaco, editRange);
    }
  }

  const additionalTextEdits = Array.isArray(item?.additionalTextEdits)
    ? item.additionalTextEdits.map((edit: any) => toMonacoTextEdit(monaco, edit))
    : undefined;

  return {
    label: item?.label ?? "",
    kind: toMonacoCompletionKind(monaco, item?.kind),
    insertText,
    insertTextRules: insertAsSnippet ? snippetRule : undefined,
    range,
    detail: item?.detail,
    documentation: toMarkdownString(item?.documentation),
    sortText: item?.sortText,
    filterText: item?.filterText,
    preselect: item?.preselect,
    additionalTextEdits,
    command: item?.command
      ? { id: item.command.command, title: item.command.title, arguments: item.command.arguments }
      : undefined,
  };
};

// LSP Location | LocationLink -> monaco { uri, range }.
export const toMonacoLocation = (monaco: Monaco, location: any) => {
  if (!location) {
    return null;
  }
  // LocationLink has targetUri/targetSelectionRange.
  if (location.targetUri) {
    return {
      uri: monaco.Uri.parse(location.targetUri),
      range: toMonacoRange(monaco, location.targetSelectionRange ?? location.targetRange),
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

export const toMonacoLocations = (monaco: Monaco, result: any) => {
  if (!result) {
    return [];
  }
  const list = Array.isArray(result) ? result : [result];
  return list.map((item) => toMonacoLocation(monaco, item)).filter((loc) => loc !== null);
};

// LSP DocumentSymbol[] (hierarchical) | SymbolInformation[] -> monaco DocumentSymbol[].
export const toMonacoDocumentSymbols = (monaco: Monaco, result: any): any[] => {
  if (!Array.isArray(result)) {
    return [];
  }
  return result.map((symbol: any) => {
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
      name: symbol.name ?? "",
      detail: symbol.detail ?? "",
      kind: toMonacoSymbolKind(monaco, symbol.kind),
      tags: symbol.tags ?? [],
      range,
      selectionRange,
      children: Array.isArray(symbol.children)
        ? toMonacoDocumentSymbols(monaco, symbol.children)
        : [],
    };
  });
};

// LSP FoldingRange[] -> monaco FoldingRange[] (1-based line numbers).
export const toMonacoFoldingRanges = (result: any): any[] => {
  if (!Array.isArray(result)) {
    return [];
  }
  return result.map((range: any) => ({
    start: (range.startLine ?? 0) + 1,
    end: (range.endLine ?? 0) + 1,
  }));
};

// LSP DocumentHighlight[] -> monaco DocumentHighlight[]. Kinds differ by one
// (LSP Text=1/Read=2/Write=3, monaco Text=0/Read=1/Write=2).
export const toMonacoDocumentHighlights = (monaco: Monaco, result: any): any[] => {
  if (!Array.isArray(result)) {
    return [];
  }
  return result
    .filter((h: any) => h && h.range)
    .map((h: any) => ({
      range: toMonacoRange(monaco, h.range),
      kind: typeof h.kind === "number" ? Math.max(0, h.kind - 1) : 0,
    }));
};

// LSP InlayHint[] -> monaco InlayHint[]. Label may be a string or label parts.
export const toMonacoInlayHints = (result: any): any[] => {
  if (!Array.isArray(result)) {
    return [];
  }
  return result.map((hint: any) => ({
    position: {
      lineNumber: (hint.position?.line ?? 0) + 1,
      column: (hint.position?.character ?? 0) + 1,
    },
    label: Array.isArray(hint.label)
      ? hint.label.map((part: any) => part?.value ?? "").join("")
      : hint.label ?? "",
    kind: hint.kind,
    paddingLeft: hint.paddingLeft,
    paddingRight: hint.paddingRight,
    tooltip: typeof hint.tooltip === "string" ? hint.tooltip : undefined,
  }));
};

// LSP DocumentLink[] -> monaco ILink[]. `target` is a URI string monaco accepts.
export const toMonacoLinks = (monaco: Monaco, result: any): any[] => {
  if (!Array.isArray(result)) {
    return [];
  }
  return result
    .filter((link: any) => link && link.range)
    .map((link: any) => {
      const out: any = { range: toMonacoRange(monaco, link.range) };
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
export const toMonacoWorkspaceEdit = (monaco: Monaco, workspaceEdit: any) => {
  const edits: any[] = [];
  if (!workspaceEdit) {
    return { edits };
  }
  const pushEdits = (uri: string, textEdits: any[]) => {
    const resource = monaco.Uri.parse(uri);
    textEdits.forEach((edit) => {
      const textEdit = toMonacoTextEdit(monaco, edit);
      edits.push({ resource, textEdit, edit: textEdit, versionId: undefined });
    });
  };
  if (workspaceEdit.changes && typeof workspaceEdit.changes === "object") {
    Object.keys(workspaceEdit.changes).forEach((uri) => {
      pushEdits(uri, workspaceEdit.changes[uri] ?? []);
    });
  }
  if (Array.isArray(workspaceEdit.documentChanges)) {
    workspaceEdit.documentChanges.forEach((change: any) => {
      if (change?.textDocument?.uri && Array.isArray(change.edits)) {
        pushEdits(change.textDocument.uri, change.edits);
      }
    });
  }
  return { edits };
};
