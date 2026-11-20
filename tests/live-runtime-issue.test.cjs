"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const compile = name => ts.transpileModule(fs.readFileSync(require.resolve(name), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const proxy = () => {
  const exported = {}, updates = [];
  new Function("exports", "require", compile("../web-src/app/issues-proxy.ts"))(exported, () => ({ uiText: en => en }));
  return { updates, ...exported.createIssuesProxy((count, summary, status, issues) => updates.push({ count, summary, status, issues })) };
};

test("runtime reason appears once, survives build results and clears on recovery without losing other issues", () => {
  const p = proxy();
  const build = { severity: "error", message: "Undefined control sequence" };
  p.updateIssuesProxy(1, build.message, "error", [build]);
  p.setLiveRuntimeError("primary", "ld: tapi error: malformed file");
  assert.deepEqual(p.updates.at(-1).issues, [build, { severity: "warning", message: "ld: tapi error: malformed file" }]);
  const count = p.updates.length;
  p.setLiveRuntimeError("primary", "ld: tapi error: malformed file");
  assert.equal(p.updates.length, count);
  p.setLiveRuntimeError("secondary", "ld: tapi error: malformed file");
  assert.equal(p.updates.at(-1).issues.length, 2);
  p.updateIssuesProxy(0, "", "success", []);
  assert.deepEqual(p.updates.at(-1).issues, [{ severity: "warning", message: "ld: tapi error: malformed file" }]);
  p.setLiveRuntimeError("primary", null);
  assert.equal(p.updates.at(-1).issues.length, 1);
  p.setLiveRuntimeError("secondary", null);
  assert.equal(p.updates.at(-1).issues.length, 0);
  assert.equal(p.getLastIssueSnapshot().count, 0);
});

test("viewer accepts structured boot errors only from its current PDF session and clears them on navigation", () => {
  const exported = {}, listeners = [], errors = [];
  class Element { constructor() { this.style = {}; this.classList = { add() {}, remove() {} }; } }
  class Frame extends Element {
    constructor() { super(); this.src = ""; this.contentWindow = { postMessage() {} }; }
    setAttribute() {}
    removeAttribute() { this.src = ""; }
  }
  new Function("exports", "require", "window", "document", "HTMLElement", "HTMLIFrameElement", "HTMLImageElement", compile("../web-src/app/viewer.ts"))(
    exported, () => ({ IMAGE_MIME_TYPES: new Map(), getFileExtension: () => "pdf" }),
    { atob: globalThis.atob, location: { href: "http://localhost/" }, addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); } },
    { activeElement: null }, Element, Frame, class extends Element {},
  );
  const frame = new Frame();
  const viewer = exported.createViewer({ editorViewer: null, editorViewerImage: null, editorViewerPdf: frame,
    editorHost: null, onLiveRuntimeError: message => errors.push(message) });
  const send = (error, source = frame.contentWindow) => listeners.forEach(fn => fn({ source,
    data: { source: "tex64-pdf", payload: { type: "live-runtime-error", payload: error } } }));
  viewer.showPdfViewer("main.pdf", Buffer.from("%PDF").toString("base64"));
  const error = { code: "TDOM_SHIM_UNAVAILABLE", message: "cc not found" };
  send(error);
  assert.ok(!errors.includes(error.message));
  viewer.setLivePreview("http://127.0.0.1:1234", 1, { workspaceRoot: "/project", pdfPath: "main.pdf" });
  send(error, {});
  assert.ok(!errors.includes(error.message));
  send(error);
  assert.equal(errors.at(-1), error.message);
  send(null);
  assert.equal(errors.at(-1), null);
  send(error);
  viewer.setLivePreview(null, 2);
  assert.equal(errors.at(-1), null);
  send(error);
  assert.equal(errors.at(-1), null);
});
