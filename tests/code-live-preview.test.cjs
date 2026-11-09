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

const setup = async ({ ready = true } = {}) => {
  const clock = createClock();
  const pushes = [], focuses = [], polls = new Map(), listeners = new Map();
  let text = "initial", enabled = true, changeSettings, contentChanged, cursorChanged;
  let holdNextPush = false, acceptPush;
  const model = { path: "/project/main.tex" };
  const editor = {
    getValue: () => text,
    getModel: () => model,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    onDidChangeModelContent(fn) { contentChanged = fn; return { dispose() { contentChanged = null; } }; },
    onDidChangeCursorPosition(fn) { cursorChanged = fn; return { dispose() { cursorChanged = null; } }; },
  };
  model.getOffsetAt = () => 0;
  const group = {
    editor, currentFilePath: model.path, isDirty: true, isComposing: false,
    viewer: { setLivePreview() {}, getViewerMode: () => "editor" },
  };
  const window = {
    tex64Tdom: {
      start: async () => ({ ok: true, url: "http://preview" }),
      stop() {},
      push(payload) {
        pushes.push({ at: clock.now(), payload });
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
  });
  if (ready) {
    await clock.advance(160);
    assert.equal(pushes.length, 1);
    pushes.length = focuses.length = clock.firedAt.length = 0;
  }
  return {
    clock, pushes, focuses, group, api,
    edit(value) { text = value; contentChanged(); },
    cursor: () => cursorChanged(),
    poll: () => polls.get(200)(),
    switchFile(path, value) { model.path = group.currentFilePath = path; text = value; },
    setEnabled(value) { enabled = value; changeSettings({ kind: "flag", id: "preview.realtime" }); },
    holdNextPush() { holdNextPush = true; },
    acceptPush: () => acceptPush(),
    buildSuccess: () => listeners.get("tex64:build-state")({ detail: {
      state: "success", workspaceRoot: "/project", targetFile: group.currentFilePath,
    } }),
  };
};

const pushedText = push => push.payload.buffers[0].text;

test("initial binding and startup coalesce into one push at 16ms", async () => {
  const h = await setup({ ready: false });
  await h.clock.advance(15);
  assert.equal(h.pushes.length, 0);
  await h.clock.advance(1);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].at, 1016);
  assert.equal(h.pushes[0].payload.fresh, true);
});

test("same-task paste, multi-cursor and programmatic companion edits produce one latest push", async () => {
  const h = await setup();
  h.edit("paste"); // firstPush after a pause
  h.edit("paste + second cursor"); // debouncedPush in the same task
  h.edit("paste + second cursor + companion");
  await h.clock.advance(15);
  assert.equal(h.pushes.length, 0);
  await h.clock.advance(1);
  assert.deepEqual(h.pushes.map(pushedText), ["paste + second cursor + companion"]);
  await h.clock.advance(100);
  assert.equal(h.pushes.length, 1);
});

test("continued typing uses a 16ms trailing delay and a 32ms maximum wait", async () => {
  const h = await setup();
  h.edit("first");
  await h.clock.advance(16);
  h.pushes.length = 0;
  const start = h.clock.now();
  h.edit("a");
  await h.clock.advance(10);
  h.edit("b");
  await h.clock.advance(10);
  h.edit("c");
  await h.clock.advance(10);
  h.edit("d");
  await h.clock.advance(1);
  assert.equal(h.pushes.length, 0);
  await h.clock.advance(1);
  assert.equal(h.pushes[0].at - start, 32);
  assert.equal(pushedText(h.pushes[0]), "d");
  h.edit("e");
  await h.clock.advance(15);
  assert.equal(h.pushes.length, 1);
  await h.clock.advance(1);
  assert.equal(h.pushes[1].at - start, 48);
});

test("long IME composition retries every 80ms and eventually pushes the committed buffer", async () => {
  const h = await setup();
  h.group.isComposing = true;
  h.edit("composition");
  const start = h.clock.now();
  await h.clock.advance(255);
  assert.equal(h.pushes.length, 0);
  assert.deepEqual(h.clock.firedAt.map(at => at - start), [16, 96, 176]);
  h.group.isComposing = false; // Also recover if no final content event arrives.
  await h.clock.advance(1);
  assert.equal(h.pushes[0].at - start, 256);
  assert.equal(pushedText(h.pushes[0]), "composition");
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

test("cursor focus retains its 160ms debounce", async () => {
  const h = await setup();
  const start = h.clock.now();
  h.cursor();
  await h.clock.advance(159);
  assert.equal(h.focuses.length, 0);
  await h.clock.advance(1);
  assert.equal(h.focuses[0].at - start, 160);
});
