"use strict";
// Editor completion: the suggest list in "\begin{i}" (texlab items, closing
// the environment on accept, focused row colors), Enter before the brace of
// "\begin{env}", user snippets in name arguments, and the keys that accept.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// Transpiles a web-src module to CommonJS; `stubs` maps import specifiers.
const loadTs = (rel, stubs = {}) => {
  const compiled = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exported = {};
  const requireStub = (spec) => {
    if (spec in stubs) return stubs[spec];
    throw new Error(`unexpected import ${spec} in ${rel}`);
  };
  new Function("exports", "require", compiled)(exported, requireStub);
  return exported;
};

const settings = { off: new Set() };
const settingsStub = { editorSettings: { isEnabled: (flag) => !settings.off.has(flag) } };
const i18nStub = { uiText: (en) => en };
const loadContext = () => loadTs("web-src/app/completion-context.ts");
const loadErgonomics = () =>
  loadTs("web-src/app/editor-ergonomics.ts", {
    "./editor-settings/editor-settings-store.js": settingsStub,
    "./i18n.js": i18nStub,
  });
const loadProviders = () =>
  loadTs("web-src/app/lsp/lsp-providers.ts", {
    "./lsp-conversions.js": loadTs("web-src/app/lsp/lsp-conversions.ts"),
    "../completion-context.js": loadContext(),
    "../editor-ergonomics.js": loadErgonomics(),
    "../editor-settings/editor-settings-store.js": settingsStub,
    "../i18n.js": i18nStub,
  });

class FakeRange {
  constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
    Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
  }
}

// texlab 5.25.1 (Resources/texlab) answer in "\begin{…}": kernel entries come
// with detail "built-in" and include the non-environments input/csname/line.
const texlabEnvItems = (line, start, end) =>
  [
    ["ContentsSections", "user-defined"],
    ["PartItems", "user-defined"],
    ["abstract", "built-in"],
    ["csname", "built-in"],
    ["input", "built-in"],
    ["itemize", "built-in"],
    ["line", "built-in"],
    ["list", "built-in"],
  ].map(([label, detail], index) => ({
    label,
    detail,
    kind: 1,
    preselect: false,
    sortText: String(index).padStart(2, "0"),
    textEdit: { newText: label, range: { start: { line, character: start }, end: { line, character: end } } },
  }));

// Runs the registered latex completion provider; `lines` is the document,
// the caret is at (lineNumber, column), 1-based as in monaco.
const complete = async (
  lines,
  lineNumber,
  column,
  { inSnippet = false, typedWhileWaiting = "", lspItems = texlabEnvItems, otherModels = [] } = {}
) => {
  const providers = {};
  const model = {
    uri: { toString: () => "file:///doc.tex" },
    getLineContent: (n) => lines[n - 1],
    getLinesContent: () => [...lines],
    getValue: () => lines.join("\n"),
    getLanguageId: () => "latex",
    getWordUntilPosition: () => ({ startColumn: column, endColumn: column }),
  };
  const monaco = {
    Range: FakeRange,
    editor: {
      getModels: () => [model, ...otherModels],
      getEditors: () => [
        { getModel: () => model, hasTextFocus: () => true, getContribution: () => ({ isInSnippet: () => inSnippet }) },
      ],
    },
    languages: {
      CompletionItemKind: { Text: 18 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (language, provider) => {
        providers[language] = provider;
        return { dispose() {} };
      },
    },
  };
  const before = lines[lineNumber - 1].slice(0, column - 1);
  const start = before.lastIndexOf("{") + 1;
  const client = {
    capabilities: { completionProvider: { triggerCharacters: ["\\", "{"] } },
    isReady: () => true,
    request: async () => {
      // The user keeps typing while texlab answers.
      const line = lines[lineNumber - 1];
      lines[lineNumber - 1] = line.slice(0, column - 1) + typedWhileWaiting + line.slice(column - 1);
      return { isIncomplete: false, items: lspItems(lineNumber - 1, start, column - 1) };
    },
  };
  loadProviders().registerLspProviders(monaco, client, ["latex"]);
  const result = await providers.latex.provideCompletionItems(model, { lineNumber, column }, {}, {});
  return result.suggestions;
};

// What monaco's snippet insertion writes for `item` on `line`: unescapes the
// snippet, gives each following line the line's indentation
// (adjustWhitespace) and puts the caret at $0.
const applyLikeMonaco = (line, item) => {
  const range = item.range;
  let text = "";
  let caret = -1;
  const snippet = item.insertTextRules === 4 ? item.insertText : item.insertText.replace(/[\\$}]/g, "\\$&");
  for (let i = 0; i < snippet.length; i += 1) {
    if (snippet[i] === "\\" && "\\$}".includes(snippet[i + 1])) {
      text += snippet[++i];
    } else if (snippet[i] === "$" && snippet[i + 1] === "0") {
      caret = text.length;
      i += 1;
    } else {
      text += snippet[i];
    }
  }
  if (caret < 0) caret = text.length;
  const indent = line.match(/^[ \t]*/)[0];
  const head = text.slice(0, caret).split("\n");
  const adjust = (s) => s.split("\n").map((part, i) => (i === 0 ? part : indent + part)).join("\n");
  const written = line.slice(0, range.startColumn - 1) + adjust(text) + line.slice(range.endColumn - 1);
  const caretLine = head.length - 1;
  const caretColumn = caretLine === 0 ? range.startColumn + caret : indent.length + head[caretLine].length + 1;
  return { written, caretLine, caretColumn };
};

const byLabel = (suggestions, label) => suggestions.find((item) => item.label === label);

test("\\begin{i}: texlab's non-environments (input, csname, line) are not offered", async () => {
  const lines = ["\\begin{ContentsSections}", "\\begin{i}", "\\end{ContentsSections}"];
  const labels = (await complete(lines, 2, 9)).map((item) => item.label);
  assert.deepEqual(labels, ["ContentsSections", "PartItems", "abstract", "itemize", "list"]);
  const endLabels = (await complete(["\\end{li}"], 1, 8)).map((item) => item.label);
  assert.ok(!endLabels.includes("line") && endLabels.includes("list"));
});

test("\\begin{...}: an environment the document defines under such a name is kept", () => {
  const { dropNonEnvironmentItems } = loadContext();
  const items = [
    { label: "input", detail: "user-defined" },
    { label: "input", detail: "built-in" },
    { label: "itemize", detail: "built-in" },
  ];
  assert.deepEqual(dropNonEnvironmentItems(items, "\\begin{in"), [items[0], items[2]]);
});

test("outside an environment name the commands \\input, \\line, \\csname stay", () => {
  const { dropNonEnvironmentItems, isEnvironmentNameContext } = loadContext();
  const commands = ["input", "line", "csname", "item"].map((label) => ({ label, detail: "built-in" }));
  assert.equal(dropNonEnvironmentItems(commands, "\\in").length, 4);
  assert.equal(dropNonEnvironmentItems(commands, "\\begin{itemize}\\in").length, 4);
  assert.equal(dropNonEnvironmentItems(commands, "\\ref{l").length, 4);
  assert.equal(isEnvironmentNameContext("\\begin {it"), true);
  assert.equal(isEnvironmentNameContext("\\begin{itemize}"), false);
  assert.equal(isEnvironmentNameContext("\\newenvironment{i"), false);
});

test("accepting an environment name writes the brace, body line and \\end, caret on the body", async () => {
  const lines = ["\\begin{ContentsSections}", "  \\begin{i}", "\\end{ContentsSections}"];
  const item = byLabel(await complete(lines, 2, 11), "itemize");
  assert.equal(item.insertTextRules, 4);
  // Replaces the typed name and the auto-inserted brace: one edit.
  assert.deepEqual({ ...item.range }, { startLineNumber: 2, startColumn: 10, endLineNumber: 2, endColumn: 12 });
  const applied = applyLikeMonaco(lines[1], item);
  assert.equal(applied.written, "  \\begin{itemize}\n    \n  \\end{itemize}");
  assert.deepEqual([applied.caretLine, applied.caretColumn], [1, 5]);
  // The same text and caret as typing the "}" by hand.
  const typed = loadErgonomics().planEnvironmentCompletion("  \\begin{itemize}", "", "  \\begin{itemize}");
  assert.equal(applied.written, `  \\begin{itemize}${typed.text}`);
  assert.equal(applied.caretColumn, typed.cursorColumn);
  // Without an auto-inserted brace the brace is written too.
  const bare = byLabel(await complete(["\\begin{i"], 1, 9), "itemize");
  assert.equal(applyLikeMonaco("\\begin{i", bare).written, "\\begin{itemize}\n  \n\\end{itemize}");
});

test("a name typed while texlab answers does not undo the closing", async () => {
  // Requested at "\begin{|}" (the "{" trigger); "i" lands before the answer.
  const item = byLabel(await complete(["\\begin{}"], 1, 8, { typedWhileWaiting: "i" }), "itemize");
  assert.equal(item.insertTextRules, 4);
  assert.deepEqual({ ...item.range }, { startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 9 });
});

test("accepting a name does not close where typing \"}\" would not", async () => {
  const plain = (item) => item.insertTextRules !== 4 && item.insertText === item.label;
  // An \end{itemize} already pairs with this begin.
  const closed = ["\\begin{i}", "  \\item a", "\\end{itemize}"];
  assert.ok(plain(byLabel(await complete(closed, 1, 9), "itemize")));
  // ...but one that belongs to another begin does not.
  const other = ["\\begin{itemize}", "\\end{itemize}", "\\begin{i}"];
  assert.ok(!plain(byLabel(await complete(other, 3, 9), "itemize")));
  // \end{…}, text after the brace, a begin that is not alone on its line.
  assert.ok(plain(byLabel(await complete(["\\end{i}"], 1, 7), "itemize")));
  assert.ok(plain(byLabel(await complete(["\\begin{i}{cc}"], 1, 9), "itemize")));
  assert.ok(plain(byLabel(await complete(["\\item \\begin{i}"], 1, 15), "itemize")));
  // Inside a snippet's placeholders, and with the feature turned off.
  assert.ok(plain(byLabel(await complete(["\\begin{i}"], 1, 9, { inSnippet: true }), "itemize")));
  settings.off.add("ergo.autoCloseEnvironment");
  try {
    assert.ok(plain(byLabel(await complete(["\\begin{i}"], 1, 9), "itemize")));
  } finally {
    settings.off.delete("ergo.autoCloseEnvironment");
  }
});

// A monaco editor stand-in for attachEditorErgonomics.
const fakeEditor = (lines, position, cursors = 1) => {
  let doc = [...lines];
  let pos = { ...position };
  const on = {};
  const offset = (l, c) => doc.slice(0, l - 1).reduce((sum, line) => sum + line.length + 1, 0) + c - 1;
  const model = {
    getLineContent: (n) => doc[n - 1],
    getLinesContent: () => [...doc],
    getValue: () => doc.join("\n"),
  };
  const editor = {
    onDidType: (cb) => (on.type = cb),
    onKeyDown: (cb) => (on.keydown = cb),
    onDidChangeCursorPosition: () => {},
    getModel: () => model,
    getPosition: () => pos,
    getSelections: () => Array.from({ length: cursors }, () => ({})),
    setPosition: (next) => (pos = { ...next }),
    executeEdits: (_source, edits) => {
      for (const { range, text } of edits) {
        const full = doc.join("\n");
        const a = offset(range.startLineNumber, range.startColumn);
        const b = offset(range.endLineNumber, range.endColumn);
        doc = (full.slice(0, a) + text + full.slice(b)).split("\n");
      }
    },
  };
  loadErgonomics().attachEditorErgonomics({ KeyCode: { Enter: 3 }, Range: FakeRange }, editor, {});
  const enter = () => {
    const event = { keyCode: 3, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    on.keydown(event);
    return event.prevented;
  };
  return { on, enter, text: () => doc.join("\n"), pos: () => pos };
};

test("Enter at \\begin{env|} closes the environment instead of splitting the brace", () => {
  const ed = fakeEditor(["\\begin{ContentsSections}", "  \\begin{itemize}", "\\end{ContentsSections}"], { lineNumber: 2, column: 17 });
  assert.equal(ed.enter(), true);
  assert.equal(ed.text(), "\\begin{ContentsSections}\n  \\begin{itemize}\n    \n  \\end{itemize}\n\\end{ContentsSections}");
  assert.deepEqual(ed.pos(), { lineNumber: 3, column: 5 });
  // With its \end already below, Enter still breaks after the brace.
  const paired = fakeEditor(["  \\begin{itemize}", "  \\end{itemize}"], { lineNumber: 1, column: 17 });
  assert.equal(paired.enter(), true);
  assert.equal(paired.text(), "  \\begin{itemize}\n  \n  \\end{itemize}");
  assert.deepEqual(paired.pos(), { lineNumber: 2, column: 3 });
});

test("with several cursors Enter and typing are left to monaco", () => {
  const items = fakeEditor(["\\item a"], { lineNumber: 1, column: 8 }, 2);
  assert.equal(items.enter(), false);
  assert.equal(items.text(), "\\item a");
  const env = fakeEditor(["\\begin{itemize}"], { lineNumber: 1, column: 16 }, 2);
  env.on.type("}");
  assert.equal(env.text(), "\\begin{itemize}");
  // One cursor: unchanged behaviour.
  const one = fakeEditor(["\\begin{itemize}"], { lineNumber: 1, column: 16 });
  one.on.type("}");
  assert.equal(one.text(), "\\begin{itemize}\n  \n\\end{itemize}");
});

test("user snippets are not offered in environment, label, citation and file arguments", async () => {
  const providers = {};
  global.window = {
    addEventListener() {},
    tex64Snippets: {
      call: async () => ({ ok: true, revision: 1, items: [{ id: "1", name: "List", prefix: "it", body: "\\begin{itemize}\n\t\\item $0\n\\end{itemize}" }] }),
    },
  };
  try {
    const { attachSnippetEditor } = loadTs("web-src/app/snippets-ui.ts", {
      "./actions-menu.js": {},
      "./i18n.js": i18nStub,
      "./explain.js": {},
      "./completion-context.js": loadContext(),
    });
    attachSnippetEditor(
      { onDidFocusEditorText() {}, addAction() {} },
      {
        languages: {
          CompletionItemKind: { Snippet: 27 },
          CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
          registerCompletionItemProvider: (language, provider) => (providers[language] = provider),
        },
      }
    );
    await new Promise((resolve) => setImmediate(resolve));
    // The provider reads the shared library on demand, so it may answer later.
    const offered = async (line) =>
      (await providers.latex.provideCompletionItems({ getLineContent: () => line }, { lineNumber: 1, column: line.length + 1 })).suggestions.length;
    assert.equal(await offered("it"), 1);
    assert.equal(await offered("\\ref{a} it"), 1);
    for (const line of [
      "\\begin{it",
      "\\end{it",
      "\\ref{it",
      "\\eqref{it",
      "\\cref{sec:a,it",
      "\\cite{it",
      "\\citep[p.~2]{a,it",
      "\\parencite{it",
      "\\input{it",
      "\\include{it",
      "\\includegraphics[width=3cm]{it",
      "\\bibliography{it",
      "\\addbibresource{it",
      "\\import{dir/}{it",
    ]) {
      assert.equal(await offered(line), 0, line);
    }
  } finally {
    delete global.window;
  }
});

// Contrast ratio per WCAG 2.x.
const luminance = (hex) => {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (rgba, baseHex) => {
  const [r, g, b, a] = rgba.split(",").map((s) => Number(s.trim()));
  const base = [0, 2, 4].map((i) => parseInt(baseHex.replace("#", "").slice(i, i + 2), 16));
  return `#${[r, g, b].map((c, i) => Math.round(c * a + base[i] * (1 - a)).toString(16).padStart(2, "0")).join("")}`;
};

test("the focused suggestion row shows its whole label in light and dark themes", () => {
  const { applyMonacoTheme } = loadTs("web-src/app/monaco-theme.ts");
  const themes = {};
  applyMonacoTheme({ editor: { defineTheme: (name, theme) => (themes[name] = theme), setTheme() {} } }, "light");

  // theme.css paints the focused row over the widget's --panel-strong.
  const css = read("Resources/web/theme.css");
  const focusedRow = css.match(/\.monaco-list-row\.selected \{\s*background: rgba\(([^)]+)\)/);
  assert.ok(focusedRow, "focused suggest row rule not found in theme.css");
  const panelStrong = (selector) => css.slice(css.indexOf(selector)).match(/--panel-strong: (#[0-9A-Fa-f]{6})/)[1];
  const cases = [
    ["tex64-vscode-light-plus", panelStrong(':root[data-theme="light"] {')],
    ["tex64-vscode-dark-plus", panelStrong(":root {")],
  ];
  for (const [name, panel] of cases) {
    const colors = themes[name].colors;
    // Unset, monaco falls back to list.activeSelectionForeground (white in
    // both vs and vs-dark): only the matched letters stayed readable.
    const label = colors["editorSuggestWidget.selectedForeground"] ?? "#FFFFFF";
    const rowBackground = over(focusedRow[1], panel);
    assert.ok(contrast(label, rowBackground) >= 4.5, `${name}: label ${label} on ${rowBackground}`);
    assert.ok(
      contrast(label, colors["editorSuggestWidget.selectedBackground"]) >= 4.5,
      `${name}: label ${label} on ${colors["editorSuggestWidget.selectedBackground"]}`
    );
  }
});

test("Tab accepts the focused suggestion, not during IME input; Enter stays a line break", () => {
  const { suggestTabCommand } = loadContext();
  assert.equal(suggestTabCommand({ key: "Tab" }, true), "acceptSelectedSuggestion");
  assert.equal(suggestTabCommand({ key: "Tab", shiftKey: true }, true), "selectPrevSuggestion");
  assert.equal(suggestTabCommand({ key: "Tab", isComposing: true }, true), null);
  assert.equal(suggestTabCommand({ key: "Tab", keyCode: 229 }, true), null);
  assert.equal(suggestTabCommand({ key: "Tab" }, false), null);
  assert.equal(suggestTabCommand({ key: "Enter" }, true), null);
  const src = read("web-src/app/monaco-setup.ts");
  assert.match(src, /acceptSuggestionOnEnter: "off"/);
  assert.match(src, /attachEditorKeyCapture\(editorAny, host, group,/);
  assert.doesNotMatch(src, /"selectNextSuggestion"/);
});

// Behaviour in the real Monaco: tests/editor-monaco-input.test.cjs.
test("a remembered pick only reorders equally good matches", () => {
  assert.match(read("web-src/app/monaco-setup.ts"), /suggestSelection: "recentlyUsed",/);
});

test("items without a label never reach monaco", async () => {
  const withEmpty = (line, start, end) => [
    ...texlabEnvItems(line, start, end),
    { label: "", kind: 1, textEdit: { newText: "", range: { start: { line, character: start }, end: { line, character: end } } } },
    { label: "  ", kind: 1 },
  ];
  const labels = (await complete(["\\ref{}"], 1, 6, { lspItems: withEmpty })).map((item) => item.label);
  assert.ok(labels.length > 0 && labels.every((label) => typeof label === "string" && label.trim() !== ""));
});

test("\\begin{ offers environments the open documents define but do not use yet", async () => {
  const usedOnly = (line, start, end) => texlabEnvItems(line, start, end).filter((item) => item.label !== "PartItems");
  const doc = [
    "\\newenvironment{PartItems}{}{}",
    "\\renewenvironment{abstract}{}{}",
    "% \\newenvironment{Commented}{}{}",
    "\\begin{}",
  ];
  const other = (text, language = "latex") => ({ getLanguageId: () => language, getValue: () => text });
  const suggestions = await complete(doc, 4, 8, {
    lspItems: usedOnly,
    otherModels: [
      other("\\newtcolorbox[auto counter]{mybox}{}\n\\newtheorem*{remark}{Remark}\n\\DeclareTColorBox{qbox}{O{}}{}\n\\NewDocumentEnvironment{nde}{}{}{}"),
      other("\\newenvironment{bibonly}{}{}", "bibtex"),
    ],
  });
  const labels = suggestions.map((item) => item.label);
  for (const name of ["PartItems", "mybox", "remark", "qbox", "nde"]) {
    assert.equal(labels.filter((label) => label === name).length, 1, name);
  }
  assert.equal(labels.filter((label) => label === "abstract").length, 1);
  assert.ok(!labels.includes("Commented") && !labels.includes("bibonly"));
  // They close on accept like texlab's own items.
  assert.equal(byLabel(suggestions, "PartItems").insertTextRules, 4);
});

test("while a composition is open the editor host swallows Tab and Enter, not the IME's keys", () => {
  const { editorKeyCapture } = loadContext();
  const composing = { suggestVisible: true, composing: true };
  assert.equal(editorKeyCapture({ key: "Tab", keyCode: 9 }, composing), "swallow");
  assert.equal(editorKeyCapture({ key: "Enter", keyCode: 13 }, composing), "swallow");
  assert.equal(editorKeyCapture({ key: "Tab", keyCode: 229, isComposing: true }, composing), null);
  assert.equal(editorKeyCapture({ key: "Enter", keyCode: 229 }, composing), null);
  assert.equal(editorKeyCapture({ key: "a", keyCode: 65 }, composing), null);
  const idle = { suggestVisible: true, composing: false };
  assert.equal(editorKeyCapture({ key: "Tab", keyCode: 9 }, idle), "acceptSelectedSuggestion");
  assert.equal(editorKeyCapture({ key: "Enter", keyCode: 13 }, idle), null);
  assert.equal(editorKeyCapture({ key: "Tab", keyCode: 9 }, { suggestVisible: false, composing: false }), null);
});
