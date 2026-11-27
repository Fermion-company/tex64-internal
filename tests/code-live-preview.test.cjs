"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

const source = fs.readFileSync(require.resolve("../web-src/app/code-live-preview.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;

// Drive the real controller with a deterministic clock and host callbacks.
// Polls are explicit so tests can distinguish retries from external refreshes.
const createClock = () => {
  let now = 1000, nextId = 1;
  const timers = new Map();
  const firedAt = [];
  return {
    now: () => now,
    firedAt,
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    async advance(ms) {
      await Promise.resolve();
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.at;
        firedAt.push(now);
        timer.fn();
        await Promise.resolve();
      }
      now = end;
    },
  };
};

const setup = async ({ ready = true, initialPath = "/project/main.tex", fallbackOnRestart = false, documentResolution = {} } = {}) => {
  const clock = createClock();
  const pdfCompiles = [], pdfPapers = [], commandChecks = [], errors = [];
  let unavailable = null, pdfError = null, pdfWarning = null;
  const pushes = [], focuses = [], polls = new Map(), listeners = new Map();
  let text = "initial", enabled = true, changeSettings, contentChanged, cursorChanged, compositionEnded;
  let holdNextPush = false, acceptPush;
  let limited = false, starts = 0, compileEngine = "lualatex";
  const shown = [], status = { running: true, state: "ready", pageLimited: false };
  const model = { path: initialPath };
  const editor = {
    getValue: () => text,
    getModel: () => model,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    onDidChangeModelContent(fn) { contentChanged = fn; return { dispose() { contentChanged = null; } }; },
    onDidCompositionEnd(fn) { compositionEnded = fn; return { dispose() { compositionEnded = null; } }; },
    onDidChangeCursorPosition(fn) { cursorChanged = fn; return { dispose() { cursorChanged = null; } }; },
  };
  model.getOffsetAt = () => 0;
  const group = {
    editor, currentFilePath: model.path, isDirty: true, isComposing: false,
    viewer: {
      showFallbackPreview(target, data) { pdfPapers.push({ target, data, previousLiveUrl: shown.at(-1) }); },
      setLivePreview(url) { if (shown.at(-1) !== url) shown.push(url); },
      getViewerMode: () => "editor",
    },
  };
  const window = {
    tex64Tdom: {
      start: async (engine) => {
        if (engine !== "lualatex") return { ok: true, fallback: true };
        starts += 1;
        return fallbackOnRestart && starts > 1 ? { ok: true, fallback: true } : { ok: true, url: "http://preview" };
      },
      stop() {},
      async commandAvailable(name) { commandChecks.push(name); return name !== unavailable; },
      async compilePdf(payload) {
        pdfCompiles.push(payload);
        if (pdfError) return { ok: false, error: pdfError };
        if (unavailable) return { ok: false, code: "TDOM_TEX_COMMAND_MISSING", command: unavailable };
        return { ok: true, generation: pdfCompiles.length, data: "PDF " + pdfCompiles.length, warning: pdfWarning };
      },
      status: async () => status,
      push(payload) {
        pushes.push({ at: clock.now(), payload });
        if (limited) return Promise.resolve({ ok: true, limited: true, pages: 389, ...(limited === "pending" ? { pending: true } : {}) });
        const result = { ok: true, url: "http://preview", srcRev: pushes.length };
        if (holdNextPush) {
          holdNextPush = false;
          return new Promise(resolve => { acceptPush = () => resolve(result); });
        }
        return Promise.resolve(result);
      },
      focus: async payload => { focuses.push({ at: clock.now(), payload }); },
    },
    addEventListener: (name, fn) => listeners.set(name, fn),
    setInterval: (fn, ms) => { polls.set(ms, fn); return ms; },
    clearInterval: id => polls.delete(id),
  };
  const exported = {};
  new Function("exports", "require", "window", "Date", "setTimeout", "clearTimeout", compiled)(
    exported,
    name => {
      if (name.endsWith("editor-settings-store.js")) return { editorSettings: {
        isEnabled: () => enabled,
        subscribe: fn => { changeSettings = fn; },
      } };
      if (name === "./i18n.js") return { uiText: english => english };
      if (name.endsWith("model-path.js")) return { getEditorModelPath: model => model.path };
      throw new Error(`Unexpected import: ${name}`);
    },
    window, { now: clock.now }, clock.setTimeout, clock.clearTimeout,
  );
  const api = exported.initCodeLivePreview({
    getActiveGroup: () => group,
    getEditorGroups: () => [group],
    getAppMode: () => "code",
    getWorkspaceRoot: () => "/project",
    getRootFile: () => group.currentFilePath,
    getDirtyFileSnapshots: () => [],
    getCompileEngine: () => compileEngine,
    showFirstPaper() {},
    closeFirstPaper() {},
    onRuntimeError(value) { errors.push(value); },
    ...documentResolution,
  });
  if (ready) {
    await clock.advance(160);
    assert.equal(pushes.length, 1);
    pushes.length = focuses.length = clock.firedAt.length = 0;
  }
  return {
    clock, pushes, focuses, group, api, pdfCompiles, pdfPapers,
    edit(value) { text = value; contentChanged(); },
    type(value, change) { text = value; contentChanged({ changes: [{ text: change }], isFlush: false }); },
    cursor: () => cursorChanged(),
    endComposition: () => compositionEnded(),
    poll: () => polls.get(200)(),
    switchFile(path, value) { model.path = group.currentFilePath = path; text = value; },
    setEnabled(value) { enabled = value; changeSettings({ kind: "flag", id: "preview.realtime" }); },
    holdNextPush() { holdNextPush = true; },
    setLimited(value) { limited = value; },
    setEngine(value) { compileEngine = value; },
    setMissing(value) { unavailable = value; },
    setPdfError(value) { pdfError = value; },
    setPdfWarning(value) { pdfWarning = value; },
    commandChecks, errors,
    starts: () => starts,
    shown, status,
    health: () => polls.get(2000)(),
    acceptPush: () => acceptPush(),
    buildSuccess: () => listeners.get("tex64:build-state")({ detail: {
      state: "success", workspaceRoot: "/project", targetFile: group.currentFilePath,
    } }),
  };
};

const pushedText = push => push.payload.buffers[0].text;

test("first paper opens on the first accepted revision while a newer edit is still in flight", async () => {
  const offered = [];
  const h = await setup({ ready: false, documentResolution: { showFirstPaper: target => offered.push(target.pdfPath) } });
  h.holdNextPush();
  await h.clock.advance(16);
  h.edit("still typing");
  await h.clock.advance(16);
  h.holdNextPush();
  h.acceptPush();
  await h.clock.advance(0);
  assert.equal(h.pushes.length, 2);
  assert.equal(h.shown.at(-1), "http://preview");
  assert.equal(offered.length, 1);
  h.acceptPush();
  await h.clock.advance(0);
  assert.equal(offered.length, 1);
});

test("a late first revision from before a document switch cannot reopen the previous session", async () => {
  const h = await setup({ ready: false });
  h.holdNextPush();
  await h.clock.advance(16);
  h.switchFile("/project/other.tex", "other");
  h.poll();
  await h.clock.advance(16);
  h.switchFile("/project/main.tex", "reopened");
  h.poll();
  await h.clock.advance(16);
  h.holdNextPush();
  h.acceptPush();
  await h.clock.advance(0);
  assert.ok(!h.shown.includes("http://preview"));
  assert.equal(pushedText(h.pushes.at(-1)), "reopened");
  h.acceptPush();
  await h.clock.advance(0);
  assert.equal(h.shown.at(-1), "http://preview");
});

test("the fallback PDF arrives while the viewer can still capture the live reading position", async () => {
  const h = await setup({ fallbackOnRestart: true });
  Object.assign(h.status, { running: false, state: "stopped" });
  await h.health();
  await h.clock.advance(2000);
  assert.equal(h.pdfPapers.at(-1)?.data, "PDF 1");
  assert.equal(h.pdfPapers.at(-1).previousLiveUrl, "http://preview");
  assert.equal(h.shown.at(-1), null);
});

test("changing the active TeX engine recompiles unchanged source while preserving the last paper", async () => {
  const h = await setup();
  for (const engine of ["xelatex", "pdflatex", "uplatex"]) {
    h.setEngine(engine);
    h.poll();
    await h.clock.advance(2000);
    const payload = h.pdfCompiles.at(-1);
    assert.equal(payload.engine, engine);
    assert.equal(payload.buffers[0].text, "initial");
    assert.equal(h.pdfPapers.at(-1).data, "PDF " + h.pdfCompiles.length);
  }
  assert.equal(h.pdfPapers[0].previousLiveUrl, "http://preview");
  assert.equal(h.pdfCompiles.length, 3);
});

test("installing the missing converter resumes the same paper without edits or failed recompiles", async () => {
  const h = await setup();
  h.setEngine("uplatex");
  h.setMissing("dvipdfmx");
  h.poll();
  await h.clock.advance(2500);
  assert.match(h.errors.at(-1), /dvipdfmx/);
  await h.clock.advance(5000);
  await h.health();
  assert.deepEqual(h.commandChecks, ["dvipdfmx"]);
  assert.equal(h.pdfCompiles.length, 1);
  h.setMissing(null);
  await h.clock.advance(5000);
  await h.health();
  await h.clock.advance(2000);
  assert.equal(h.pdfPapers.at(-1).data, "PDF 2");
  assert.equal(h.errors.at(-1), null);
});

test("losing the resident engine keeps the last paper until the replacement accepts the current manuscript", async () => {
  const h = await setup();
  const shownBeforeCrash = h.shown.slice();
  const startsBeforeCrash = h.starts();
  h.holdNextPush();
  Object.assign(h.status, { running: false, state: "stopped" });
  await h.health();
  await h.clock.advance(500);
  assert.equal(h.starts(), startsBeforeCrash + 1);
  assert.equal(h.pushes.at(-1).payload.fresh, true);
  assert.deepEqual(h.shown, shownBeforeCrash);
  h.acceptPush();
  await h.clock.advance(50);
  assert.equal(h.shown.at(-1), "http://preview");
});

test("an empty project sends no preview source and starts previewing its first document without a reload", async () => {
  const h = await setup({ ready: false, initialPath: null });
  await h.clock.advance(500);
  h.poll();
  await h.clock.advance(500);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.focuses, []);

  const document = "\\documentclass{article}\n\\begin{document}Hello\\end{document}";
  h.switchFile("/project/main.tex", document);
  h.poll();
  await h.clock.advance(16);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].payload.workspaceRoot, "/project");
  assert.equal(h.pushes[0].payload.rootFile, "/project/main.tex");
  assert.equal(h.pushes[0].payload.fresh, true);
  assert.equal(pushedText(h.pushes[0]), document);

  h.edit(document.replace("Hello", "Edited"));
  await h.clock.advance(32);
  assert.deepEqual(h.pushes.map(pushedText), [document, document.replace("Hello", "Edited")]);
  assert.equal(h.pushes[1].payload.fresh, false);
});

test("initial binding and startup coalesce into one push, one task later", async () => {
  const h = await setup({ ready: false });
  assert.equal(h.pushes.length, 0);
  await h.clock.advance(1);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].at, 1001);
  assert.equal(h.pushes[0].payload.fresh, true);
});

test("same-task paste, multi-cursor and programmatic companion edits produce one latest push", async () => {
  const h = await setup();
  h.edit("paste"); // firstPush after a pause
  h.edit("paste + second cursor"); // debouncedPush in the same task
  h.edit("paste + second cursor + companion");
  assert.equal(h.pushes.length, 0, "nothing goes out inside the task that made the edits");
  await h.clock.advance(1);
  assert.deepEqual(h.pushes.map(pushedText), ["paste + second cursor + companion"]);
  await h.clock.advance(100);
  assert.equal(h.pushes.length, 1);
});

test("a keystroke goes out when the editor's call returns; edits made in one call go out together", async () => {
  const h = await setup();
  h.edit("first");
  await h.clock.advance(16);
  h.pushes.length = 0;
  const start = h.clock.now();
  h.edit("a");
  assert.equal(h.pushes.length, 0, "not inside the call that made the edit");
  await h.clock.advance(0);
  assert.deepEqual(h.pushes.map((push) => [push.at - start, pushedText(push)]), [[0, "a"]]);
  await h.clock.advance(10);
  h.edit("b");
  await h.clock.advance(0);
  assert.equal(h.pushes[1].at - start, 10);
  assert.equal(pushedText(h.pushes[1]), "b");
  h.pushes.length = 0;
  for (const text of ["c", "d", "e", "f"]) h.edit(text);
  await h.clock.advance(0);
  assert.deepEqual(h.pushes.map(pushedText), ["f"]);
});

test("plain typed characters go out inside the editor's own call; a brace or a command waits for the call to return", async () => {
  const h = await setup();
  h.edit("first");
  await h.clock.advance(16);
  h.pushes.length = 0;
  h.type("first a", "a");
  assert.deepEqual(h.pushes.map(pushedText), ["first a"], "sent before the editor paints");
  await h.clock.advance(0); // the engine accepts it
  h.type("first ", ""); // a deletion
  assert.equal(h.pushes.length, 2);
  await h.clock.advance(5);
  assert.equal(h.pushes.length, 2, "nothing is sent twice");
  h.type("first \\begin{", "\\begin{");
  assert.equal(h.pushes.length, 2);
  h.edit("first \\begin{}"); // the editor closes the brace in the same call
  await h.clock.advance(0);
  assert.deepEqual(h.pushes.slice(2).map(pushedText), ["first \\begin{}"]);
  h.type("first \\begin{}\n", "\n");
  assert.equal(h.pushes.length, 3, "a new line waits too: the editor may indent or complete after it");
  await h.clock.advance(0);
  assert.equal(h.pushes.length, 4);
});

test("long IME composition sends only the committed buffer when the composition ends", async () => {
  const h = await setup();
  h.group.isComposing = true;
  h.edit("composition");
  const start = h.clock.now();
  await h.clock.advance(239);
  assert.equal(h.pushes.length, 0);
  assert.deepEqual(h.clock.firedAt, []);
  h.group.isComposing = false; // No final content change follows this commit.
  h.endComposition();
  await h.clock.advance(0);
  assert.equal(h.pushes[0].at - start, 239);
  assert.equal(pushedText(h.pushes[0]), "composition");
});

test("a chapter being composed in another pane keeps its last committed overlay while the root updates", async () => {
  for (const dirty of [true, false]) {
    const groups = [];
    const path = "/project/chapter.tex";
    const model = { getValue() { assert.fail("the transient IME buffer must not be read"); } };
    const h = await setup({ ready: false, documentResolution: {
      getEditorGroups: () => groups,
      getDirtyFileSnapshots: read => groups.length ? [{ path, content: read(model), isDirty: true, truncated: false }] : [],
    } });
    groups.push(h.group, {
      editor: { getModel: () => model }, viewer: h.group.viewer, currentFilePath: path,
      isComposing: true, composingFilePath: path, compositionBaseline: { model, text: "確定済み", dirty },
    });
    await h.clock.advance(16);
    h.edit("root edit");
    await h.clock.advance(16);
    assert.equal(h.pushes.length, 2);
    for (const { payload } of h.pushes) {
      assert.deepEqual(payload.buffers.filter(entry => entry.path === path), dirty ? [{ path, text: "確定済み" }] : []);
    }
    assert.equal(h.pushes[1].payload.buffers.find(entry => entry.path === h.group.currentFilePath).text, "root edit");
  }
});

test("a second view of the same Monaco model cannot enqueue another pane's candidate", async () => {
  const groups = [];
  const h = await setup({ ready: false, documentResolution: { getEditorGroups: () => groups } });
  groups.push(h.group);
  await h.clock.advance(16);
  const path = h.group.currentFilePath;
  groups.push({
    ...h.group, isComposing: true, composingFilePath: path,
    compositionBaseline: { model: h.group.editor.getModel(), text: "initial", dirty: true },
  });
  h.type("initial候補", "候補");
  h.poll();
  await h.clock.advance(210);
  assert.deepEqual(h.pushes.map(pushedText), ["initial"]);
  groups.pop();
  h.edit("initial確定");
  await h.clock.advance(16);
  assert.deepEqual(h.pushes.map(pushedText), ["initial", "initial確定"]);
});

test("IME commit uses the fast typing path and cancels its obsolete retry", async () => {
  const h = await setup();
  h.group.isComposing = true;
  h.edit("transient");
  await h.clock.advance(16);
  h.group.isComposing = false;
  h.edit("committed");
  await h.clock.advance(16);
  assert.deepEqual(h.pushes.map(pushedText), ["committed"]);
  h.clock.firedAt.length = 0;
  await h.clock.advance(200);
  assert.deepEqual(h.clock.firedAt, []);
});

test("suspension cancels first, trailing and composition timers and allows a fresh restart", async () => {
  for (const composing of [false, true]) {
    const h = await setup();
    h.group.isComposing = composing;
    h.edit("first");
    h.edit("latest");
    if (composing) await h.clock.advance(16);
    h.setEnabled(false);
    h.clock.firedAt.length = 0;
    await h.clock.advance(500);
    assert.deepEqual(h.clock.firedAt, []);
    assert.equal(h.pushes.length, 0);
    h.group.isComposing = false;
    h.setEnabled(true);
    await h.clock.advance(16);
    assert.deepEqual(h.pushes.map(pushedText), ["latest"]);
    assert.equal(h.pushes[0].payload.fresh, true);
  }
});

test("slow engine keeps one push in flight and sends only the latest queued edit on acceptance", async () => {
  const h = await setup();
  h.holdNextPush();
  h.edit("in flight");
  await h.clock.advance(16);
  h.edit("obsolete pending");
  await h.clock.advance(16);
  h.edit("latest pending");
  await h.clock.advance(16);
  assert.deepEqual(h.pushes.map(pushedText), ["in flight"]);
  const acceptedAt = h.clock.now();
  h.acceptPush();
  await h.clock.advance(0);
  assert.deepEqual(h.pushes.map(pushedText), ["in flight", "latest pending"]);
  assert.equal(h.pushes[1].at, acceptedAt, "the queue drains without another debounce");
});

test("rebind, truth poll, source refresh and build completion still schedule or deduplicate pushes", async () => {
  const h = await setup();
  h.poll();
  await h.clock.advance(32);
  assert.equal(h.pushes.length, 0);
  h.switchFile("/project/other.tex", "other file");
  h.poll();
  await h.clock.advance(16);
  assert.equal(h.pushes[0].payload.rootFile, "/project/other.tex");
  assert.equal(h.pushes[0].payload.fresh, true);
  h.api.refreshSource();
  h.api.refreshSource();
  h.poll();
  h.buildSuccess();
  await h.clock.advance(16);
  assert.equal(h.pushes.length, 2, "forced refresh sends unchanged bytes once");
  assert.equal(h.pushes[1].payload.fresh, false);
  h.edit("edited during build");
  h.buildSuccess();
  await h.clock.advance(16);
  assert.deepEqual(h.pushes.map(pushedText), ["other file", "other file", "edited during build"]);
});

test("a shared chapter and style update the selected manuscript while an explicit root switches papers", async () => {
  const main = "main.tex", letter = "letter.tex", chapter = "shared.tex";
  let including = [main, letter];
  const h = await setup({ initialPath: letter, documentResolution: {
    getRootFile: () => main,
    getDocumentFor: path => path === chapter ? main : path,
    getDocumentsIncluding: path => path === chapter ? including : [],
  } });
  for (const path of ["layout.sty", chapter]) {
    h.switchFile(path, "changed " + path);
    h.poll();
    await h.clock.advance(16);
    assert.equal(h.pushes.at(-1).payload.rootFile, letter);
    assert.equal(h.pushes.at(-1).payload.fresh, false);
  }
  including = []; // main supplied a binding root for the chapter
  h.poll();
  await h.clock.advance(16);
  assert.equal(h.pushes.at(-1).payload.rootFile, main);
  assert.equal(h.pushes.at(-1).payload.fresh, true);
});

test("cursor focus retains its 160ms debounce", async () => {
  const h = await setup();
  const start = h.clock.now();
  h.cursor();
  await h.clock.advance(159);
  assert.equal(h.focuses.length, 0);
  await h.clock.advance(1);
  assert.equal(h.focuses[0].at - start, 160);
});

test("a document past the resident length limit still prints edits without restarting the engine", async () => {
  const h = await setup({ ready: false });
  h.setLimited(true);
  await h.clock.advance(160);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.starts(), 1);
  assert.equal(h.shown.includes("http://preview"), false);

  h.edit("typed while limited");
  h.poll();
  await h.clock.advance(500);
  h.poll();
  await h.clock.advance(500);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.starts(), 1);
  assert.equal(h.pdfCompiles.at(-1).buffers[0].text, "typed while limited");
  assert.equal(h.pdfPapers.at(-1).data, "PDF 1");
});

test("while main is preparing the chapter of a long document the push is asked again, and Live starts when it is ready", async () => {
  const h = await setup({ ready: false });
  h.setLimited("pending");
  await h.clock.advance(160);
  assert.equal(h.pushes.length, 1);
  assert.equal(typeof h.pushes[0].payload.activePath, "string");
  assert.equal(h.shown.includes("http://preview"), false);
  await h.clock.advance(5_000);
  assert.equal(h.pushes.length, 2);
  h.setLimited(false);
  await h.clock.advance(5_000);
  assert.equal(h.pushes.length, 3);
  assert.equal(h.shown.includes("http://preview"), true);
  await h.clock.advance(20_000);
  assert.equal(h.pushes.length, 3, "nothing is asked again once Live runs");
});

test("a Build asks again for a limited document, and Live starts once its paper is under the limit", async () => {
  const h = await setup({ ready: false });
  h.setLimited(true);
  await h.clock.advance(160);
  h.buildSuccess();
  await h.clock.advance(50);
  assert.equal(h.pushes.length, 2);
  assert.equal(h.shown.includes("http://preview"), false);

  h.setLimited(false);
  h.buildSuccess();
  await h.clock.advance(50);
  assert.equal(h.pushes.length, 3);
  assert.equal(h.starts(), 1);
  assert.equal(h.shown.at(-1), "http://preview");
  h.edit("typed after the shorter Build");
  await h.clock.advance(50);
  assert.equal(h.pushes.length, 4);
});

test("another document leaves the length limit behind", async () => {
  const h = await setup({ ready: false });
  h.setLimited(true);
  await h.clock.advance(160);
  h.setLimited(false);
  h.switchFile("/project/short.tex", "a short document");
  h.poll();
  await h.clock.advance(160);
  assert.equal(h.pushes.at(-1).payload.rootFile, "/project/short.tex");
  assert.equal(h.shown.at(-1), "http://preview");
});

test("a document that grows past the resident limit switches to an updated PDF without restarting", async () => {
  const h = await setup();
  assert.equal(h.shown.at(-1), "http://preview");
  const startsBefore = h.starts();
  Object.assign(h.status, { running: false, state: "stopped", pageLimited: true });
  await h.health();
  await h.clock.advance(10);
  h.poll();
  await h.clock.advance(500);
  assert.equal(h.shown.at(-1), null);
  assert.equal(h.starts(), startsBefore);
  assert.equal(h.pushes.length, 0);
  await h.clock.advance(900);
  assert.equal(h.pdfCompiles.at(-1).buffers[0].text, "initial");
  assert.equal(h.pdfPapers.at(-1).data, "PDF 1");
});

test("PDF preview retries a transient launcher failure once without another keystroke", async () => {
  const h = await setup();
  h.setEngine("pdflatex");
  h.setPdfError("working directory temporarily unavailable");
  h.poll();
  await h.clock.advance(2500);
  assert.match(h.errors.at(-1), /working directory/);
  h.setPdfError(null);
  await h.health();
  await h.clock.advance(2500);
  assert.equal(h.pdfPapers.at(-1).data, "PDF 2");
  h.setPdfError("permission denied");
  h.edit("next version");
  await h.clock.advance(3000);
  await h.health();
  await h.clock.advance(2500);
  const attempts = h.pdfCompiles.length;
  await h.health();
  await h.clock.advance(5000);
  await h.health();
  assert.equal(h.pdfCompiles.length, attempts);
  assert.equal(h.pdfPapers.at(-1).data, "PDF 2");
});

test("a current TeX error on a blank first paper uses one draft and resumes native updates after repair", async () => {
  const h = await setup({ ready: false });
  let activation;
  const setLive = h.group.viewer.setLivePreview;
  h.group.viewer.setLivePreview = (url, generation) => {
    activation = { url, generation };
    setLive(url);
  };
  await h.clock.advance(160);
  const failure = { ...activation, srcRev: 1 };
  h.api.recoverEmptyPaper({ ...failure, generation: failure.generation - 1 });
  h.api.recoverEmptyPaper({ ...failure, srcRev: 0 });
  assert.equal(h.pdfCompiles.length, 0);
  h.setPdfWarning("Undefined control sequence");
  h.api.recoverEmptyPaper(failure);
  h.api.recoverEmptyPaper(failure);
  await h.clock.advance(0);
  assert.equal(h.pdfCompiles.length, 1);
  assert.equal(h.pdfPapers.at(-1).data, "PDF 1");
  h.poll();
  await h.clock.advance(2600);
  assert.equal(h.pdfCompiles.length, 1);
  h.setPdfWarning(null);
  h.edit("fixed source");
  await h.clock.advance(2600);
  assert.equal(h.pdfCompiles.length, 2);
  assert.equal(pushedText(h.pushes.at(-1)), "fixed source");
  assert.equal(h.shown.at(-1), "http://preview");
  h.api.recoverEmptyPaper(failure);
  assert.equal(h.pdfCompiles.length, 2);
});
