"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ts = require("typescript");

// The real voice-edit and composer microphone, transpiled with the small set
// of modules they import, driven through a fake microphone, MediaRecorder,
// FileReader, DOM and Monaco editor.
const MODULES = ["voice-edit", "ai-chat-voice", "voice-recorder", "ai-i18n", "i18n"];
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-voice-edit-"));
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
for (const name of MODULES) {
  const source = fs.readFileSync(path.join(__dirname, "../web-src/app", `${name}.ts`), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  fs.writeFileSync(path.join(outDir, `${name}.js`), output);
}
test.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

// ── Fake host ──
let now = 1_000_000;
Date.now = () => now;

const timers = new Map();
let nextTimer = 1;
globalThis.window = {
  setTimeout: (fn) => { const id = nextTimer++; timers.set(id, { fn, repeat: false }); return id; },
  clearTimeout: (id) => { timers.delete(id); },
  setInterval: (fn) => { const id = nextTimer++; timers.set(id, { fn, repeat: true }); return id; },
  clearInterval: (id) => { timers.delete(id); },
};
const runTimeouts = () => {
  for (const [id, timer] of [...timers]) {
    if (timer.repeat) continue;
    timers.delete(id);
    timer.fn();
  }
};

class FakeClassList {
  constructor() { this.names = new Set(); }
  add(...names) { names.forEach((name) => this.names.add(name)); }
  remove(...names) { names.forEach((name) => this.names.delete(name)); }
  contains(name) { return this.names.has(name); }
  toggle(name, force) {
    const on = force ?? !this.names.has(name);
    if (on) this.names.add(name); else this.names.delete(name);
    return on;
  }
}
class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.className = "";
    this.classList = new FakeClassList();
    this.children = [];
    this.attributes = new Map();
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.innerHTML = "";
    this.title = "";
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  dispatchEvent() { return true; }
  focus() {}
  click() { for (const fn of this.listeners.click ?? []) fn({ preventDefault() {}, stopPropagation() {} }); }
}
class FakeHTMLElement extends FakeElement {}
class FakeButton extends FakeHTMLElement {}
class FakeTextArea extends FakeHTMLElement {
  constructor() { super("textarea"); this.value = ""; this.selectionStart = 0; this.selectionEnd = 0; }
  setRangeText(text, start, end) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + text.length;
  }
}
globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeHTMLElement;
globalThis.HTMLButtonElement = FakeButton;
globalThis.HTMLTextAreaElement = FakeTextArea;
globalThis.document = { createElement: (tag) => (tag === "button" ? new FakeButton(tag) : new FakeHTMLElement(tag)) };

// The microphone: each request waits until the test grants or denies it.
const mic = { requests: [], streams: [] };
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  writable: true,
  value: {
    mediaDevices: {
      getUserMedia: () =>
        new Promise((resolve, reject) => {
          mic.requests.push({
            grant: () => {
              const track = { stopped: false, stop() { this.stopped = true; } };
              const stream = { track, getTracks: () => [track] };
              mic.streams.push(stream);
              resolve(stream);
              return stream;
            },
            deny: () => reject(new Error("NotAllowedError")),
          });
        }),
    },
  },
});

class FakeMediaRecorder {
  static isTypeSupported(type) { return type === "audio/webm;codecs=opus"; }
  constructor(stream, options) {
    if (FakeMediaRecorder.failNext) {
      FakeMediaRecorder.failNext = false;
      throw new Error("NotSupportedError");
    }
    this.stream = stream;
    this.mimeType = options?.mimeType ?? "audio/webm";
    this.state = "inactive";
  }
  start() { this.state = "recording"; }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    // Like the browser: the last data and the stop event come later.
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(600)]) });
      this.onstop?.();
    });
  }
}
FakeMediaRecorder.failNext = false;
globalThis.MediaRecorder = FakeMediaRecorder;

// Reading the clip waits until the test lets it finish.
const readers = [];
globalThis.FileReader = class {
  readAsDataURL(blob) { this.blob = blob; readers.push(this); }
};
const finishReads = () => {
  while (readers.length) {
    const reader = readers.shift();
    reader.result = "data:audio/webm;base64,QUJDREVGR0g=";
    reader.onload();
  }
};

const flush = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const monaco = {
  KeyMod: { CtrlCmd: 2048, Alt: 512 },
  KeyCode: { KeyV: 52, Escape: 9 },
  editor: { ContentWidgetPositionPreference: { ABOVE: 1, BELOW: 2 } },
};
const makeModel = (lines) => ({
  getLineCount: () => lines.length,
  getLineContent: (line) => lines[line - 1],
  getLineMaxColumn: (line) => lines[line - 1].length + 1,
  getValueInRange: (range) => lines.slice(range.startLineNumber - 1, range.endLineNumber).join("\n"),
});
const makeEditor = (model) => {
  const listeners = { model: [], dispose: [] };
  const editor = {
    model,
    actions: {},
    commands: [],
    widgets: new Set(),
    widgetAdds: 0,
    getModel: () => editor.model,
    setModel(next) { editor.model = next; listeners.model.forEach((fn) => fn()); },
    dispose() { editor.model = null; listeners.dispose.forEach((fn) => fn()); },
    addAction(action) { editor.actions[action.id] = action; },
    addCommand(key, fn, when) { editor.commands.push({ key, fn, when }); },
    createContextKey(name, value) { const key = { value, set(next) { key.value = next; } }; return key; },
    getSelection: () => ({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1, isEmpty: () => true }),
    getPosition: () => ({ lineNumber: 2, column: 1 }),
    onDidChangeModel(fn) { listeners.model.push(fn); },
    onDidDispose(fn) { listeners.dispose.push(fn); },
    addContentWidget(widget) { editor.widgetAdds += 1; editor.widgets.add(widget.getId()); },
    removeContentWidget(widget) { editor.widgets.delete(widget.getId()); },
    layoutContentWidget() {},
    createDecorationsCollection: () => ({ clear() {} }),
  };
  return editor;
};

const load = async (name) => import(pathToFileURL(path.join(outDir, `${name}.js`)).href);

const setup = async () => {
  mic.requests.length = 0;
  mic.streams.length = 0;
  readers.length = 0;
  timers.clear();
  const { createVoiceEditController } = await load("voice-edit");
  let workspace = "/ws/a";
  const calls = { posted: [], held: [], sent: [], pills: [] };
  const controller = createVoiceEditController({
    postToNative: (payload) => { calls.posted.push(payload); return true; },
    holdSelection: (selection) => calls.held.push(selection),
    sendInstruction: (text) => calls.sent.push(text),
    getWorkspaceRootKey: () => workspace,
  });
  const editor = makeEditor(makeModel(["\\section{Intro}", "Some text here.", "", "More."]));
  controller.attachEditor(monaco, editor, {
    getFilePath: () => "/ws/a/main.tex",
    isDirty: () => false,
    onPillChange: (state) => calls.pills.push(state),
  });
  const escape = editor.commands.find((command) => command.key === monaco.KeyCode.Escape);
  return {
    controller,
    editor,
    calls,
    setWorkspace: (root) => { workspace = root; },
    press: () => editor.actions["tex64.voice-edit"].run(),
    escape: () => escape.fn(),
    transcribeRequests: () => calls.posted.filter((payload) => payload.type === "agent:transcribe"),
    lastHeld: () => calls.held[calls.held.length - 1],
  };
};

// Press, grant the microphone, speak for two seconds, press again: the clip
// is then being read.
const recordAndStop = async (t) => {
  t.press();
  mic.requests[mic.requests.length - 1].grant();
  await flush();
  now += 2000;
  t.press();
  await flush();
};
const recordAndTranscribe = async (t) => {
  await recordAndStop(t);
  finishReads();
  await flush();
  const requests = t.transcribeRequests();
  assert.ok(requests.length > 0, "the clip went to the host");
  return requests[requests.length - 1].requestId;
};

test("the spoken words are sent with the range held when recording began", async () => {
  const t = await setup();
  const requestId = await recordAndTranscribe(t);
  assert.equal(t.calls.held[0].path, "/ws/a/main.tex");
  assert.equal(t.calls.held[0].text, "Some text here.");
  t.controller.handleTranscribeResult({ requestId, ok: true, text: "  make it bold " });
  assert.deepEqual(t.calls.sent, ["make it bold"]);
  assert.equal(t.calls.pills[t.calls.pills.length - 1], "sent");
  assert.equal(mic.streams[0].track.stopped, true);
});

test("words that come back after the workspace changed are not sent", async () => {
  const t = await setup();
  const requestId = await recordAndTranscribe(t);
  t.setWorkspace("/ws/b");
  t.controller.handleTranscribeResult({ requestId, ok: true, text: "make it bold" });
  assert.deepEqual(t.calls.sent, []);
  assert.equal(t.lastHeld(), null);
  assert.equal(t.calls.pills[t.calls.pills.length - 1], "hidden");
  assert.equal(t.editor.widgets.size, 0);
});

test("cancel() lets the held range go at once and a late answer is ignored", async () => {
  const t = await setup();
  const oldId = await recordAndTranscribe(t);
  t.controller.cancel();
  assert.equal(t.lastHeld(), null);
  assert.equal(t.editor.widgets.size, 0);
  t.controller.handleTranscribeResult({ requestId: oldId, ok: true, text: "old words" });
  assert.deepEqual(t.calls.sent, []);
  // A new edit is not disturbed by the old one's answer.
  const newId = await recordAndTranscribe(t);
  assert.notEqual(newId, oldId);
  t.controller.handleTranscribeResult({ requestId: oldId, ok: true, text: "old words" });
  t.controller.handleTranscribeResult({ requestId: newId, ok: true, text: "new words" });
  assert.deepEqual(t.calls.sent, ["new words"]);
});

test("another file in the editor during transcription ends the edit", async () => {
  const t = await setup();
  const requestId = await recordAndTranscribe(t);
  t.editor.setModel(makeModel(["Other file."]));
  assert.equal(t.lastHeld(), null);
  assert.equal(t.editor.widgets.size, 0);
  t.controller.handleTranscribeResult({ requestId, ok: true, text: "make it bold" });
  assert.deepEqual(t.calls.sent, []);
});

test("a microphone granted after the editor changed file is released, not recorded", async () => {
  const t = await setup();
  t.press();
  assert.equal(mic.requests.length, 1);
  t.editor.setModel(makeModel(["Other file."]));
  assert.equal(t.lastHeld(), null);
  // No second request while the first is still open.
  t.press();
  assert.equal(mic.requests.length, 1);
  const stream = mic.requests[0].grant();
  await flush();
  assert.equal(stream.track.stopped, true);
  assert.equal(t.editor.widgetAdds, 0);
  assert.ok(!t.calls.pills.includes("shown"));
  assert.equal(t.transcribeRequests().length, 0);
  // The microphone is free again for a new edit.
  t.press();
  assert.equal(mic.requests.length, 2);
});

test("a microphone refused after the edit ended shows nothing", async () => {
  const t = await setup();
  t.press();
  t.editor.setModel(makeModel(["Other file."]));
  const heldCalls = t.calls.held.length;
  mic.requests[0].deny();
  await flush();
  assert.equal(t.calls.held.length, heldCalls);
  assert.ok(!t.calls.pills.includes("shown"));
  assert.equal(timers.size, 0);
});

test("a clip still being read when the edit ends goes nowhere", async () => {
  const t = await setup();
  await recordAndStop(t);
  assert.equal(readers.length, 1);
  t.editor.setModel(makeModel(["Other file."]));
  finishReads();
  await flush();
  assert.equal(t.transcribeRequests().length, 0);
  assert.equal(t.lastHeld(), null);
  assert.deepEqual(t.calls.sent, []);
});

test("Esc while recording drops the clip and frees the microphone", async () => {
  const t = await setup();
  t.press();
  const stream = mic.requests[0].grant();
  await flush();
  now += 2000;
  t.escape();
  await flush();
  assert.equal(stream.track.stopped, true);
  assert.equal(readers.length, 0);
  assert.equal(t.transcribeRequests().length, 0);
  assert.equal(t.lastHeld(), null);
});

test("a disposed editor ends its edit and its answer is ignored", async () => {
  const t = await setup();
  const requestId = await recordAndTranscribe(t);
  t.editor.dispose();
  assert.equal(t.lastHeld(), null);
  t.controller.handleTranscribeResult({ requestId, ok: true, text: "make it bold" });
  assert.deepEqual(t.calls.sent, []);
});

test("nothing heard: nothing is sent and the pill goes after a moment", async () => {
  const t = await setup();
  const requestId = await recordAndTranscribe(t);
  t.controller.handleTranscribeResult({ requestId, ok: false, code: "empty", error: "Nothing was heard." });
  assert.deepEqual(t.calls.sent, []);
  assert.equal(t.lastHeld(), null);
  assert.equal(t.editor.widgets.size, 1);
  runTimeouts();
  assert.equal(t.editor.widgets.size, 0);
  assert.equal(t.calls.pills[t.calls.pills.length - 1], "hidden");
});

test("a recorder that cannot start releases the microphone and sends nothing", async () => {
  const t = await setup();
  FakeMediaRecorder.failNext = true;
  t.press();
  const stream = mic.requests[0].grant();
  await flush();
  assert.equal(stream.track.stopped, true);
  assert.equal(t.lastHeld(), null);
  assert.equal(t.transcribeRequests().length, 0);
  runTimeouts();
  assert.equal(t.editor.widgets.size, 0);
  t.press();
  assert.equal(mic.requests.length, 2);
});

test("composer microphone: a second press while the microphone is asked for opens no second stream", async () => {
  mic.requests.length = 0;
  mic.streams.length = 0;
  readers.length = 0;
  const { createVoiceController } = await load("ai-chat-voice");
  const posted = [];
  const input = new FakeTextArea();
  const voice = createVoiceController({
    aiMic: new FakeButton("button"),
    aiMicTimer: new FakeHTMLElement("span"),
    aiInput: input,
    postToNative: (payload) => { posted.push(payload); return true; },
    notify: () => {},
  });
  voice.toggle();
  voice.toggle();
  assert.equal(mic.requests.length, 1);
  assert.equal(voice.isBusy(), true);
  mic.requests[0].grant();
  await flush();
  now += 2000;
  voice.toggle();
  await flush();
  finishReads();
  await flush();
  assert.equal(posted.length, 1);
  voice.handleTranscribeResult({ requestId: posted[0].requestId, ok: true, text: "hello" });
  assert.equal(input.value, "hello");
  assert.equal(voice.isBusy(), false);
});
