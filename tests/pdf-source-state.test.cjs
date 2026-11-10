"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PdfSourceState } = require("../electron/services/pdf-source-state.cjs");

test("restore invalidates project PDFs, persists over reopen, and clears only the successfully built target", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-pdf-source-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "project");
  const main = path.join(root, "main.pdf"), other = path.join(root, "figures", "standalone.pdf");
  let source = new PdfSourceState(path.join(directory, "state"));
  assert.equal(source.needsRebuild(root, main), false);
  source.restored(root, "restore-1");
  assert.equal(source.needsRebuild(root, main), true);
  assert.equal(source.needsRebuild(root, other), true);
  assert.equal(source.needsRebuild(root, path.join(directory, "project-other", "main.pdf")), false);
  source = new PdfSourceState(path.join(directory, "state"));
  assert.equal(source.needsRebuild(root, main), true);
  source.built(root, main);
  assert.equal(source.needsRebuild(root, main), false);
  assert.equal(source.needsRebuild(root, other), true);
  source = new PdfSourceState(path.join(directory, "state"));
  source.restored(root, "restore-1"); // Startup / sync retry replays the same persisted boundary.
  assert.equal(source.needsRebuild(root, main), false);
  assert.equal(source.needsRebuild(root, other), true);
  source.restored(root, "restore-2");
  assert.equal(source.needsRebuild(root, main), true);
});

test("identical relative PDF names do not cross project roots; damaged state fails conservatively", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-pdf-roots-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, "first"), second = path.join(directory, "second");
  const source = new PdfSourceState(path.join(directory, "state"));
  source.restored(first, "restore-first");
  source.restored(second, "restore-second");
  source.built(first, path.join(second, "main.pdf"));
  assert.equal(source.needsRebuild(second, path.join(second, "main.pdf")), true);
  source.built(first, path.join(first, "main.pdf"));
  assert.equal(source.needsRebuild(first, path.join(first, "main.pdf")), false);
  assert.equal(source.needsRebuild(second, path.join(second, "main.pdf")), true);
  await fs.writeFile(source.file(first), "invalid");
  assert.equal(new PdfSourceState(path.join(directory, "state")).needsRebuild(first, path.join(first, "main.pdf")), true);
});

test("ordinary PDF window sends persistent source state on reload and ready, scoped to its PDF", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-pdf-window-source-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const modulePath = require.resolve("../electron/services/pdf.cjs");
  const code = await fs.readFile(modulePath, "utf8");
  const loaded = { exports: {} };
  const localRequire = require("node:module").createRequire(modulePath);
  new Function("require", "module", "__dirname", code)((name) => name === "electron" ? {
    app: { getPath: () => directory }, BrowserWindow: class {},
  } : localRequire(name), loaded, path.dirname(modulePath));
  const manager = new loaded.exports.PDFWindowManager();
  const messages = [];
  manager.window = { isDestroyed: () => false, setTitle() {}, show() {}, focus() {},
    webContents: { isDestroyed: () => false, send: (_channel, message) => messages.push(message) } };
  const root = path.join(directory, "project"); const pdf = path.join(root, "main.pdf");
  manager.setWorkspaceRoot(root);
  manager.show(pdf);
  manager.markRestored(root, "boundary-1");
  // Live/build messages can follow the source state. Check fresh, typed
  // messages from each action so an old notification cannot satisfy a reload.
  const expectState = (type, needsRebuild) => {
    const matching = messages.filter(message => message.type === type);
    assert.equal(matching.length, 1, `expected one fresh ${type} message`);
    assert.equal(matching[0].payload.path, pdf);
    assert.equal(matching[0].payload.needsRebuild, needsRebuild);
  };
  messages.length = 0;
  manager.markReady();
  expectState("open", true);
  expectState("source-state", true);
  messages.length = 0;
  manager.show(pdf);
  expectState("open", true);
  messages.length = 0;
  manager.markBuilt(root, path.join(root, "another.pdf"));
  expectState("source-state", true);
  messages.length = 0;
  manager.markBuilt(root, pdf);
  expectState("source-state", false);
  messages.length = 0;
  manager.markRestored(path.join(directory, "other-project"), "other-boundary");
  expectState("source-state", false);
  messages.length = 0;
  manager.markRestored(root, "boundary-2");
  expectState("source-state", true);
  messages.length = 0;
  manager.show(pdf, { reload: false });
  assert.equal(messages.some(message => message.type === "open"), false);
  messages.length = 0;
  manager.markReady();
  expectState("source-state", true);
});

test("embedded viewer retains restore warning across frame reload and scopes identical names to their workspace", async () => {
  const ts = require("typescript");
  const code = await fs.readFile(require.resolve("../web-src/app/viewer.ts"), "utf8");
  const compiled = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  const exported = {}; const listeners = [];
  class Element {}
  class Frame extends Element { constructor() { super(); this.src = ""; this.messages = []; this.contentWindow = { postMessage: m => this.messages.push(m.payload) }; } removeAttribute() { this.src = ""; } }
  const window = { atob: globalThis.atob, location: { href: "https://tex64.test/index.html" }, addEventListener: (event, callback) => { if (event === "message") listeners.push(callback); } };
  new Function("exports", "require", "window", "document", "HTMLElement", "HTMLIFrameElement", "HTMLImageElement", compiled)(
    exported, () => ({ IMAGE_MIME_TYPES: new Map(), getFileExtension: () => "pdf" }), window, { activeElement: null }, Element, Frame, class extends Element {},
  );
  const frame = new Frame();
  const viewer = exported.createViewer({ editorViewer: null, editorViewerImage: null, editorViewerPdf: frame, editorHost: null });
  const root = "/project-a";
  const source = { rootPath: root, requiresRebuild: true, rebuiltPaths: [] };
  const ready = () => listeners.forEach(listener => listener({ source: frame.contentWindow, data: { source: "tex64-pdf", payload: { type: "ready" } } }));
  const expectState = (type, needsRebuild) => {
    const matching = frame.messages.filter(message => message.type === type);
    assert.equal(matching.length, 1, `expected one fresh ${type} message`);
    assert.equal(matching[0].payload.path, "main.pdf");
    assert.equal(matching[0].payload.needsRebuild, needsRebuild);
    frame.messages.length = 0;
  };
  exported.updatePdfSourceState(source, true);
  viewer.showPdfViewer("main.pdf", Buffer.from("%PDF").toString("base64"));
  ready();
  expectState("open", true);
  viewer.hideViewer();
  viewer.showPdfViewer("main.pdf", Buffer.from("%PDF").toString("base64"));
  assert.equal(frame.messages.length, 0); // Reload waits for the new frame.
  ready();
  expectState("open", true);
  // A URL without a scoped target cannot take ownership of a PDF.
  viewer.setLivePreview("http://127.0.0.1:1234", 1);
  assert.equal(frame.messages.length, 0);
  const target = { workspaceRoot: root, pdfPath: "main.pdf" };
  viewer.setLivePreview("http://127.0.0.1:1234", 1, target);
  assert.deepEqual(frame.messages.splice(0), [{ type: "live", payload: {
    url: "http://127.0.0.1:1234", generation: 1, target, hold: false, expectedSrcRev: null,
  } }]);
  exported.updatePdfSourceState({ rootPath: "/project-b", requiresRebuild: false, rebuiltPaths: [] }, true);
  expectState("source-state", true); // Existing viewer still belongs to A.
  viewer.setLivePreview(null, 2);
  assert.deepEqual(frame.messages.splice(0), [{ type: "live", payload: null }]);
  exported.updatePdfSourceState({ ...source, rebuiltPaths: ["/project-a/another.pdf"] });
  expectState("source-state", true);
  exported.updatePdfSourceState({ ...source, rebuiltPaths: ["/project-a/main.pdf"] });
  expectState("source-state", false);
  exported.updatePdfSourceState(source); // A is stale again; B must stay clear.
  expectState("source-state", true);
  viewer.showPdfViewer("main.pdf", Buffer.from("%PDF").toString("base64")); // New B tab same relative name.
  expectState("open", false);
  viewer.hideViewer();
});
