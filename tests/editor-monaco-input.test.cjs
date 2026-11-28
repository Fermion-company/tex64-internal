"use strict";
// The vendored Monaco in headless Chromium: IME composition state (through
// Chromium's own IME path, CDP Input.imeSetComposition) and which suggestion
// the editor's suggestSelection preselects.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { chromium } = require("playwright");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const monacoRoot = path.join(root, "Resources/web/monaco");
const transpile = (rel) =>
  ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

let browser;
test.before(async () => {
  browser = await chromium.launch({ headless: true });
});
test.after(async () => {
  await browser?.close();
});

// A page with one monaco editor created with `options`.
const openEditor = async (options) => {
  const page = await browser.newPage();
  await page.route("http://monaco.test/**", (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname);
    if (rel === "/") {
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta charset="utf-8"><div id="ed" style="width:640px;height:320px"></div><script src="/vs/loader.js"></script>',
      });
    }
    const file = path.join(monacoRoot, rel);
    if (!file.startsWith(monacoRoot) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ body: fs.readFileSync(file), contentType: rel.endsWith(".css") ? "text/css" : "text/javascript" });
  });
  await page.goto("http://monaco.test/");
  await page.evaluate(
    (opts) =>
      new Promise((resolve) => {
        window.MonacoEnvironment = { getWorkerUrl: () => "data:text/javascript,;" };
        require.config({ paths: { vs: "/vs" } });
        require(["vs/editor/editor.main"], () => {
          monaco.languages.register({ id: "latex" });
          // As monaco-language.ts: "{" brings its "}".
          monaco.languages.setLanguageConfiguration("latex", {
            brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
            autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }],
          });
          window.editor = monaco.editor.create(document.getElementById("ed"), { language: "latex", ...opts });
          resolve();
        });
      }),
    options
  );
  await page.click("#ed .view-lines");
  return page;
};

// The app's editor modules, transpiled, with the settings and i18n stubbed.
const MODULES = [
  "web-src/app/completion-context.ts",
  "web-src/app/editor-ergonomics.ts",
  "web-src/app/editor-composition.ts",
  "web-src/app/editor-session/outside-edits.ts",
  "web-src/app/files.ts",
  "web-src/app/editor-session/buffer-ops.ts",
  "web-src/app/lsp/lsp-conversions.ts",
  "web-src/app/lsp/lsp-providers.ts",
];
const installModules = (page) =>
  page.evaluate((sources) => {
    const map = {
      "./completion-context.js": "web-src/app/completion-context.ts",
      "../completion-context.js": "web-src/app/completion-context.ts",
      "../editor-ergonomics.js": "web-src/app/editor-ergonomics.ts",
      "../files.js": "web-src/app/files.ts",
      "./lsp-conversions.js": "web-src/app/lsp/lsp-conversions.ts",
    };
    const settings = { editorSettings: { isEnabled: () => true } };
    const stubs = {
      "./editor-settings/editor-settings-store.js": settings,
      "../editor-settings/editor-settings-store.js": settings,
      "./i18n.js": { uiText: (en) => en },
    };
    const cache = {};
    const load = (rel) => {
      if (cache[rel]) return cache[rel];
      const exports = {};
      cache[rel] = exports;
      new Function("exports", "require", sources[rel])(exports, (spec) => stubs[spec] ?? load(map[spec]));
      return exports;
    };
    window.load = load;
    window.group = { isComposing: false, compositionText: "", composingFilePath: null, currentFilePath: "main.tex" };
    window.ends = 0;
    window.recovered = [];
  }, Object.fromEntries(MODULES.map((rel) => [rel, transpile(rel)])));

// The editor wired as monaco-setup.ts wires it: ergonomics, the host's key
// capture, composition tracking (closing the suggest list when one starts),
// and the texlab provider answering "\begin{…}" like texlab.
const wireLikeApp = (page) =>
  page.evaluate(() => {
    const host = document.getElementById("ed");
    load("web-src/app/editor-ergonomics.ts").attachEditorErgonomics(monaco, editor, group);
    const composition = load("web-src/app/editor-composition.ts");
    composition.attachEditorKeyCapture(editor, host, group, () =>
      Boolean(document.querySelector(".suggest-widget.visible"))
    );
    composition.trackComposition(editor, host, group, {
      onStart: () => editor.trigger("tex64", "hideSuggestWidget", {}),
      onEnd: () => (window.ends += 1),
      recover: (text) => window.recovered.push(text),
    });
    const client = {
      capabilities: { completionProvider: { triggerCharacters: ["{"] } },
      isReady: () => true,
      request: async (_method, params) => {
        const line = editor.getModel().getLineContent(params.position.line + 1).slice(0, params.position.character);
        const typed = line.match(/\\begin\{([^{}]*)$/);
        if (!typed) return { isIncomplete: false, items: [] };
        const start = params.position.character - typed[1].length;
        return {
          isIncomplete: false,
          items: ["itemize", "enumerate"].map((label, index) => ({
            label,
            detail: "built-in",
            kind: 1,
            sortText: String(index).padStart(2, "0"),
            textEdit: { newText: label, range: { start: { line: params.position.line, character: start }, end: params.position } },
          })),
        };
      },
    };
    load("web-src/app/lsp/lsp-providers.ts").registerLspProviders(monaco, client, ["latex"]);
  });

const compose = async (page, mode) => {
  await installModules(page);
  await page.evaluate(() =>
    load("web-src/app/editor-composition.ts").trackComposition(editor, document.getElementById("ed"), group, {
      onEnd: () => (window.ends += 1),
      recover: (text) => window.recovered.push(text),
    })
  );
  const input = await page.evaluate(() => document.activeElement.className);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
  await page.waitForTimeout(100);
  const during = await page.evaluate(() => ({ composing: group.isComposing, path: group.composingFilePath }));
  await cdp.send("Input.imeSetComposition", { text: "かん", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "漢" });
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => ({
    composing: group.isComposing,
    path: group.composingFilePath,
    ends,
    recovered,
    text: editor.getValue(),
  }));
  return { mode, input, during, after };
};

test("IME composition sets isComposing with EditContext (this Monaco's default)", async (t) => {
  const page = await openEditor({ value: "a" });
  t.after(() => page.close());
  assert.equal(await page.evaluate(() => editor.getOption(monaco.editor.EditorOption.editContext)), true);
  const result = await compose(page, "editContext");
  // Input goes through an EditContext element, not a textarea.
  assert.match(result.input, /native-edit-context/);
  assert.deepEqual(result.during, { composing: true, path: "main.tex" });
  assert.deepEqual(result.after, { composing: false, path: null, ends: 1, recovered: [], text: "a漢" });
});

test("IME composition sets isComposing on the textarea path too (EditContext off)", async (t) => {
  const page = await openEditor({ value: "a", editContext: false });
  t.after(() => page.close());
  const result = await compose(page, "textarea");
  assert.match(result.input, /inputarea/);
  assert.deepEqual(result.during, { composing: true, path: "main.tex" });
  assert.deepEqual(result.after, { composing: false, path: null, ends: 1, recovered: [], text: "a漢" });
});

// The app's own suggestSelection value.
const appSuggestSelection = () => read("web-src/app/monaco-setup.ts").match(/suggestSelection: "([^"]+)"/)[1];

test("a remembered pick only wins among equally good matches", async (t) => {
  const page = await openEditor({ value: "", suggestSelection: appSuggestSelection(), quickSuggestions: false });
  t.after(() => page.close());
  await page.evaluate(() => {
    const names = ["itemize", "inline", "PartItems"];
    monaco.languages.registerCompletionItemProvider("latex", {
      triggerCharacters: ["{"],
      provideCompletionItems: (model, position) => {
        const typed = model.getLineContent(position.lineNumber).slice(0, position.column - 1).match(/\\begin\{([^{}]*)$/);
        if (!typed) return { suggestions: [] };
        const range = new monaco.Range(position.lineNumber, position.column - typed[1].length, position.lineNumber, position.column);
        return {
          suggestions: names.map((label, index) => ({
            label,
            kind: monaco.languages.CompletionItemKind.Text,
            insertText: label,
            range,
            sortText: String(index).padStart(2, "0"),
          })),
        };
      },
    });
  });
  // Types "\begin{<word>" on a new last line and returns the preselected row.
  const focusedAfterTyping = (word) =>
    page.evaluate(async (w) => {
      editor.trigger("test", "hideSuggestWidget", {});
      const model = editor.getModel();
      const last = model.getLineCount();
      editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
      editor.trigger("keyboard", "type", { text: `\n\\begin{${w}` });
      editor.trigger("test", "editor.action.triggerSuggest", {});
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const row = document.querySelector(".suggest-widget.visible .monaco-list-row.focused .label-name");
        if (row) return row.textContent;
      }
      return null;
    }, word);
  const pick = (label) =>
    page.evaluate(async (wanted) => {
      for (let i = 0; i < 5; i += 1) {
        const row = document.querySelector(".suggest-widget.visible .monaco-list-row.focused .label-name");
        if (row?.textContent === wanted) {
          editor.trigger("keyboard", "acceptSelectedSuggestion", {});
          return true;
        }
        editor.trigger("keyboard", "selectNextSuggestion", {});
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    }, label);

  // A fresh session preselects the best match.
  assert.equal(await focusedAfterTyping("i"), "itemize");
  // Picking a weaker match once at "i" ...
  assert.equal(await pick("PartItems"), true);
  // ... does not take Tab away from the better match as the name grows.
  for (const word of ["it", "ite", "item"]) {
    assert.equal(await focusedAfterTyping(word), "itemize", word);
  }
  // Among equal matches ("itemize" and "inline" for "i") the last pick wins.
  assert.equal(await focusedAfterTyping("i"), "itemize");
  assert.equal(await pick("inline"), true);
  assert.equal(await focusedAfterTyping("i"), "inline");
});

test("no Tab or Enter accepts, closes or breaks the line while a composition is open", async (t) => {
  const page = await openEditor({ value: "\\begin{ContentsSections}\n\n\\end{ContentsSections}", quickSuggestions: false });
  t.after(() => page.close());
  await installModules(page);
  await wireLikeApp(page);
  const focused = await page.evaluate(async () => {
    editor.setPosition({ lineNumber: 2, column: 1 });
    for (const ch of "\\begin{i") editor.trigger("keyboard", "type", { text: ch });
    editor.trigger("test", "editor.action.triggerSuggest", {});
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const row = document.querySelector(".suggest-widget.visible .monaco-list-row.focused .label-name");
      if (row) return row.textContent;
    }
    return null;
  });
  assert.equal(focused, "itemize");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "亜", selectionStart: 1, selectionEnd: 1 });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => group.isComposing), true);
  // Plain key events (keyCode 9 / 13, isComposing false), as the real-app run sent.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  await cdp.send("Input.insertText", { text: "亜" });
  await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(() => editor.getModel().getLinesContent()), [
    "\\begin{ContentsSections}",
    "\\begin{i亜}",
    "\\end{ContentsSections}",
  ]);
  assert.equal(await page.evaluate(() => group.isComposing), false);
});

test("Enter with several cursors at \\begin{env|} closes each, one undo step, never splits a brace", async (t) => {
  const lines = ["\\begin{itemize}", "  \\begin{enumerate}", "\\begin{center}", "\\end{center}"];
  const page = await openEditor({ value: lines.join("\n"), quickSuggestions: false });
  t.after(() => page.close());
  await installModules(page);
  await wireLikeApp(page);
  await page.evaluate(() => {
    // Each caret right before the auto-inserted "}".
    editor.setSelections([
      new monaco.Selection(1, 15, 1, 15),
      new monaco.Selection(2, 19, 2, 19),
      new monaco.Selection(3, 14, 3, 14),
    ]);
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => ({
    lines: editor.getModel().getLinesContent(),
    cursors: editor.getSelections().map((s) => [s.positionLineNumber, s.positionColumn]),
  }));
  assert.deepEqual(after.lines, [
    "\\begin{itemize}",
    "  ",
    "\\end{itemize}",
    "  \\begin{enumerate}",
    "    ",
    "  \\end{enumerate}",
    "\\begin{center}",
    "",
    "\\end{center}",
  ]);
  // "center" already has its \end: the line breaks after the brace.
  assert.deepEqual(after.cursors, [[2, 3], [5, 5], [8, 1]]);
  await page.evaluate(() => editor.trigger("keyboard", "undo", null));
  assert.deepEqual(await page.evaluate(() => editor.getModel().getLinesContent()), lines);
});

test("an Axiom alias shares the real Monaco buffer's IME queue", async (t) => {
  const page = await openEditor({ value: "a" });
  t.after(() => page.close());
  await installModules(page);
  await wireLikeApp(page);
  await page.evaluate(() => {
    const { createOutsideEdits } = load("web-src/app/editor-session/outside-edits.ts");
    const model = editor.getModel();
    window.outsideEdits = createOutsideEdits({
      editorGroups: { primary: group },
      monacoModels: new Map([["main.tex", { model, savedContent: "a" }]]),
      findGroupKeyByPath: (path) => path === "main.tex" ? "primary" : null,
      getEditorGroup: () => group,
      applyFormattedContent: (_group, _path, text) => {
        const end = model.getPositionAt(model.getValueLength());
        editor.executeEdits("outside", [{
          range: monaco.Range.fromPositions(end), text,
        }]);
        return false;
      },
    });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
  await page.waitForFunction(() => group.isComposing);
  assert.equal(await page.evaluate(() =>
    outsideEdits.applyContentToOpenFile("alias.tex", " external", { fileIdentity: "main.tex" }).handled), true);
  assert.doesNotMatch(await page.evaluate(() => editor.getValue()), /external/);
  await cdp.send("Input.insertText", { text: "漢" });
  await page.waitForFunction(() => editor.getValue() === "a漢 external");
});

// A forced model swap (the folder changed, the file went away) during a
// composition, as workspace-ops.ts does it: clearEditorView with the group's
// file already gone. The composition ends with it, in both input modes.
for (const editContext of [true, false]) {
  test(`a model replaced during a composition ends it (${editContext ? "EditContext" : "textarea"})`, async (t) => {
    const page = await openEditor({ value: "a", editContext, quickSuggestions: false });
    t.after(() => page.close());
    await installModules(page);
    await page.evaluate(() => {
      const host = document.getElementById("ed");
      Object.assign(group, { key: "primary", editor, editorHost: host, pendingCompositionAction: null });
      // (a model of the app's own: the editor's built-in one goes with a swap)
      window.original = monaco.editor.createModel("a", "latex");
      editor.setModel(original);
      editor.setPosition({ lineNumber: 1, column: 2 });
      window.runtime = {
        monacoModels: new Map([["main.tex", { model: original, savedContent: "a" }]]),
        dirtyFiles: new Set(), editorGroups: { primary: group }, emptyEditorModel: null,
        deps: { getMonacoApi: () => monaco },
      };
      window.buffer = load("web-src/app/editor-session/buffer-ops.ts").createEditorSessionBufferOps(runtime, {
        forEachEditorGroup: (callback) => callback(group), isActiveGroup: () => true,
      });
      window.cancels = 0;
      load("web-src/app/editor-ergonomics.ts").attachEditorErgonomics(monaco, editor, group);
      const composition = load("web-src/app/editor-composition.ts");
      composition.attachEditorKeyCapture(editor, host, group, () => false);
      composition.trackComposition(editor, host, group, {
        onEnd: () => { window.ends += 1; buffer.handleCompositionEnd(group); },
        onCancel: () => { window.cancels += 1; buffer.handleCompositionEnd(group, { cancelled: true }); },
        recover: (text) => window.recovered.push(text),
      });
      // An Axiom change to the open file, waiting for the composition.
      window.outsideEdits = load("web-src/app/editor-session/outside-edits.ts").createOutsideEdits({
        editorGroups: { primary: group }, monacoModels: runtime.monacoModels,
        findGroupKeyByPath: () => "primary", getEditorGroup: () => group,
        applyFormattedContent: (_group, path, text) => { window.applied = [path, text]; return false; },
      });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
    await page.waitForFunction(() => group.isComposing);
    const queued = await page.evaluate(() => {
      // Work queued for this model; with no input to blur, it stays queued.
      window.ran = [];
      const host = group.editorHost;
      group.editorHost = null;
      buffer.scheduleAfterComposition(group, () => ran.push("ran"), () => ran.push("answered"));
      group.editorHost = host;
      return outsideEdits.applyContentToOpenFile("main.tex", "a external", {}).handled;
    });
    assert.equal(queued, true);
    assert.equal(await page.evaluate(() => window.applied ?? null), null);

    await page.evaluate(() => {
      group.currentFilePath = null;
      buffer.clearEditorView(group);
    });
    assert.deepEqual(await page.evaluate(() => ({
      composing: group.isComposing, path: group.composingFilePath, text: group.compositionText, cancels, ran,
    })), { composing: false, path: null, text: "", cancels: 1, ran: ["answered"] });
    // The outside change no longer waits.
    await page.waitForFunction(() => window.applied?.[1] === "a external", null, { timeout: 2000 });
    await page.waitForTimeout(50);
    assert.deepEqual(await page.evaluate(() => ran), ["answered"], "the queued action did not run on the new model");
    if (!editContext) {
      // The composition went into the model it was typed in, and an IME
      // commit afterwards reaches neither model.
      await cdp.send("Input.insertText", { text: "漢" });
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => original.getValue()), "aか");
    }
    assert.equal(await page.evaluate(() => editor.getValue()), "");
    assert.deepEqual(await page.evaluate(() => recovered), []);

    // Enter and Tab are ordinary keys again in the new model.
    await page.evaluate(() => editor.focus());
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(50);
    assert.match(await page.evaluate(() => editor.getValue()), /^\n[\t ]+$/);
    assert.equal(await page.evaluate(() => group.isComposing), false);
  });
}

test("disposing the editor during a composition clears it", async (t) => {
  const page = await openEditor({ value: "a", editContext: false });
  t.after(() => page.close());
  await installModules(page);
  await page.evaluate(() => {
    window.cancels = 0;
    load("web-src/app/editor-composition.ts").trackComposition(editor, document.getElementById("ed"), group, {
      onEnd: () => (window.ends += 1), onCancel: () => (window.cancels += 1), recover: (text) => window.recovered.push(text),
    });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
  await page.waitForFunction(() => group.isComposing);
  await page.evaluate(() => editor.dispose());
  assert.deepEqual(await page.evaluate(() => [group.isComposing, cancels]), [false, 1]);
});

// Enter at "\begin{name|}" with the suggestion list open on a partial name is
// a line break (after the brace); it never writes "\end{<partial>}". A name the
// list shows as typed, or a name with the list closed, is closed as before.
// Tab accepts the suggestion with the list open and indents with it closed.
test("Enter and Tab at a partial or complete environment name, with the suggestion list open or closed", async (t) => {
  const page = await openEditor({ value: "", quickSuggestions: false });
  t.after(() => page.close());
  await installModules(page);
  await wireLikeApp(page);
  const run = (name, { list, key }) =>
    page.evaluate(async ({ name, list, key }) => {
      editor.setValue("");
      editor.setPosition({ lineNumber: 1, column: 1 });
      editor.focus();
      for (const ch of `\\begin{${name}`) editor.trigger("keyboard", "type", { text: ch });
      editor.trigger("test", "hideSuggestWidget", {});
      if (list) {
        editor.trigger("test", "editor.action.triggerSuggest", {});
        let focused = null;
        for (let i = 0; i < 40 && !focused; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          focused = document.querySelector(".suggest-widget.visible .monaco-list-row.focused .label-name")?.textContent ?? null;
        }
        if (focused !== "itemize") return { focused };
      }
      return { focused: list ? "itemize" : null, key };
    }, { name, list, key });
  const press = async (key) => {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
    return page.evaluate(() => editor.getModel().getLinesContent());
  };
  const cases = [
    ["it", true, "Enter", ["\\begin{it}", ""]],
    ["itemize", true, "Enter", ["\\begin{itemize}", "  ", "\\end{itemize}"]],
    ["it", false, "Enter", ["\\begin{it}", "  ", "\\end{it}"]],
    ["itemize", false, "Enter", ["\\begin{itemize}", "  ", "\\end{itemize}"]],
  ];
  for (const [name, list, key, expected] of cases) {
    assert.deepEqual(await run(name, { list, key }), { focused: list ? "itemize" : null, key }, `${name} ${list}`);
    assert.deepEqual(await press(key), expected, `${key} at "${name}" with the list ${list ? "open" : "closed"}`);
  }
  // Tab: the list's suggestion with it open, never the partial name's \end.
  await run("it", { list: true, key: "Tab" });
  const accepted = await press("Tab");
  assert.equal(accepted[0], "\\begin{itemize}");
  assert.equal(accepted.some((line) => line.includes("\\end{it}")), false);
  await run("it", { list: false, key: "Tab" });
  const indented = await press("Tab");
  assert.equal(indented.length, 1);
  assert.match(indented[0], /^\\begin\{it\s+\}$/);
});
