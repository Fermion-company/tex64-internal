import test from "node:test";
import assert from "node:assert/strict";

import {
  toLspPosition,
  toMonacoRange,
  toMonacoCompletionKind,
  toMonacoSymbolKind,
  toMonacoMarkerSeverity,
  toMarkdownString,
  toMonacoCompletionItem,
  toMonacoLocations,
  toMonacoDocumentSymbols,
  toMonacoWorkspaceEdit,
  toMonacoFoldingRanges,
  toMonacoDocumentHighlights,
  toMonacoInlayHints,
  toMonacoLinks,
} from "../Resources/web/app/lsp/lsp-conversions.js";

class Range {
  constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
    this.startLineNumber = startLineNumber;
    this.startColumn = startColumn;
    this.endLineNumber = endLineNumber;
    this.endColumn = endColumn;
  }
}

const monaco = {
  Range,
  Uri: { parse: (s) => ({ scheme: "file", value: s, toString: () => s }) },
  languages: {
    CompletionItemKind: { Text: 18, Function: 1, Keyword: 17, Snippet: 25, Field: 3 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    SymbolKind: { Module: 1, Function: 11, Variable: 12, Class: 4 },
  },
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
};

test("position: monaco (1-based) -> LSP (0-based)", () => {
  assert.deepEqual(toLspPosition({ lineNumber: 1, column: 1 }), { line: 0, character: 0 });
  assert.deepEqual(toLspPosition({ lineNumber: 10, column: 5 }), { line: 9, character: 4 });
});

test("range: LSP (0-based) -> monaco (1-based)", () => {
  const r = toMonacoRange(monaco, {
    start: { line: 0, character: 0 },
    end: { line: 1, character: 5 },
  });
  assert.deepEqual(
    [r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn],
    [1, 1, 2, 6]
  );
});

test("completion kind maps by name through the runtime enum", () => {
  assert.equal(toMonacoCompletionKind(monaco, 3), 1); // LSP Function -> monaco Function
  assert.equal(toMonacoCompletionKind(monaco, 14), 17); // LSP Keyword -> monaco Keyword
  assert.equal(toMonacoCompletionKind(monaco, 15), 25); // LSP Snippet -> monaco Snippet
  assert.equal(toMonacoCompletionKind(monaco, undefined), 18); // default Text
});

test("symbol + marker-severity maps", () => {
  assert.equal(toMonacoSymbolKind(monaco, 12), 11); // LSP Function -> monaco Function
  assert.equal(toMonacoMarkerSeverity(monaco, 1), 8); // Error
  assert.equal(toMonacoMarkerSeverity(monaco, 2), 4); // Warning
  assert.equal(toMonacoMarkerSeverity(monaco, 3), 2); // Info
});

test("markdown conversion: string, MarkupContent, MarkedString[]", () => {
  assert.deepEqual(toMarkdownString("hi"), { value: "hi" });
  assert.deepEqual(toMarkdownString({ kind: "markdown", value: "**b**" }), { value: "**b**" });
  const arr = toMarkdownString(["a", { language: "tex", value: "x^2" }]);
  assert.equal(arr.value, "a\n\n```tex\nx^2\n```");
});

test("completion item: snippet flag + textEdit range win", () => {
  const item = toMonacoCompletionItem(
    monaco,
    {
      label: "align",
      kind: 15,
      insertTextFormat: 2,
      textEdit: {
        range: { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } },
        newText: "align}\n\t$0\n\\end{align}",
      },
    },
    "DEFAULT_RANGE"
  );
  assert.equal(item.kind, 25);
  assert.equal(item.insertTextRules, 4, "snippet rule applied");
  assert.equal(item.insertText, "align}\n\t$0\n\\end{align}");
  assert.equal(item.range.startColumn, 2);
  assert.equal(item.range.endColumn, 5);
});

test("completion item: no textEdit falls back to defaultRange", () => {
  const item = toMonacoCompletionItem(
    monaco,
    { label: "ref", kind: 18, insertText: "ref" },
    "DEFAULT_RANGE"
  );
  assert.equal(item.range, "DEFAULT_RANGE");
  assert.equal(item.insertTextRules, undefined);
});

test("locations: Location and LocationLink shapes", () => {
  const a = toMonacoLocations(monaco, {
    uri: "file:///a.tex",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
  });
  assert.equal(a.length, 1);
  assert.equal(a[0].uri.toString(), "file:///a.tex");

  const b = toMonacoLocations(monaco, [
    {
      targetUri: "file:///b.tex",
      targetSelectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } },
    },
  ]);
  assert.equal(b[0].uri.toString(), "file:///b.tex");
  assert.equal(b[0].range.startLineNumber, 2);
});

test("document symbols: hierarchical + SymbolInformation", () => {
  const symbols = toMonacoDocumentSymbols(monaco, [
    {
      name: "Intro",
      kind: 12,
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
      children: [
        {
          name: "sub",
          kind: 12,
          location: {
            range: { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } },
          },
        },
      ],
    },
  ]);
  assert.equal(symbols[0].name, "Intro");
  assert.equal(symbols[0].kind, 11);
  assert.equal(symbols[0].children.length, 1);
  assert.equal(symbols[0].children[0].name, "sub");
  // SymbolInformation: range derived from location.range; selectionRange falls back to it.
  assert.equal(symbols[0].children[0].range.startLineNumber, 3);
});

test("folding ranges: 0-based lines -> 1-based", () => {
  const ranges = toMonacoFoldingRanges([
    { startLine: 1, endLine: 5, kind: "region" },
    { startLine: 2, endLine: 4 },
  ]);
  assert.deepEqual(ranges, [
    { start: 2, end: 6 },
    { start: 3, end: 5 },
  ]);
});

test("document highlights: kind offset by one, range converted", () => {
  const hl = toMonacoDocumentHighlights(monaco, [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, kind: 2 },
    { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } },
  ]);
  assert.equal(hl.length, 2);
  assert.equal(hl[0].kind, 1); // LSP Read(2) -> monaco Read(1)
  assert.equal(hl[0].range.startLineNumber, 1);
  assert.equal(hl[1].kind, 0); // missing -> Text(0)
});

test("inlay hints: position 1-based, label parts joined", () => {
  const hints = toMonacoInlayHints([
    { position: { line: 3, character: 2 }, label: "x" },
    { position: { line: 4, character: 0 }, label: [{ value: "a" }, { value: "b" }] },
  ]);
  assert.deepEqual(hints[0].position, { lineNumber: 4, column: 3 });
  assert.equal(hints[0].label, "x");
  assert.equal(hints[1].label, "ab");
});

test("document links: target -> url, range converted", () => {
  const links = toMonacoLinks(monaco, [
    {
      range: { start: { line: 0, character: 7 }, end: { line: 0, character: 15 } },
      target: "file:///proj/intro.tex",
      tooltip: "open",
    },
  ]);
  assert.equal(links.length, 1);
  assert.equal(links[0].url, "file:///proj/intro.tex");
  assert.equal(links[0].tooltip, "open");
  assert.equal(links[0].range.startColumn, 8);
});

test("workspace edit: changes map -> monaco edits", () => {
  const edit = toMonacoWorkspaceEdit(monaco, {
    changes: {
      "file:///a.tex": [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          newText: "foo",
        },
      ],
    },
  });
  assert.equal(edit.edits.length, 1);
  assert.equal(edit.edits[0].resource.toString(), "file:///a.tex");
  assert.equal(edit.edits[0].textEdit.text, "foo");
});
