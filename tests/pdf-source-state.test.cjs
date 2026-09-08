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
  manager.markReady();
  assert.equal(messages.find(m => m.type === "open").payload.needsRebuild, true);
  manager.show(pdf);
  assert.equal(messages.at(-1).payload.needsRebuild, true);
  manager.markBuilt(root, path.join(root, "another.pdf"));
  assert.equal(messages.at(-1).payload.needsRebuild, true);
  manager.markBuilt(root, pdf);
  assert.equal(messages.at(-1).payload.needsRebuild, false);
  manager.markRestored(path.join(directory, "other-project"), "other-boundary");
  assert.equal(messages.at(-1).payload.needsRebuild, false);
  manager.markRestored(root, "boundary-2");
  manager.show(pdf, { reload: false });
  assert.equal(messages.at(-1).payload.needsRebuild, true);
});

test("embedded viewer retains restore warning across frame reload and scopes identical names to their workspace", async () => {
  const ts = require("typescript");
  const code = await fs.readFile(require.resolve("../web-src/app/viewer.ts"), "utf8");
  const compiled = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  const exported = {}; const listeners = [];
  class Element {}
  class Frame extends Element { constructor() { super(); this.src = ""; this.messages = []; this.contentWindow = { postMessage: m => this.messages.push(m.payload) }; } removeAttribute() { this.src = ""; } }
  const window = { atob: globalThis.atob, location: { href: "https://tex64.test/index.html" }, addEventListener: (_event, callback) => listeners.push(callback) };
  new Function("exports", "require", "window", "document", "HTMLElement", "HTMLIFrameElement", "HTMLImageElement", compiled)(
    exported, () => ({ IMAGE_MIME_TYPES: new Map(), getFileExtension: () => "pdf" }), window, { activeElement: null }, Element, Frame, class extends Element {},
  );
  const frame = new Frame();
  const viewer = exported.createViewer({ editorViewer: null, editorViewerImage: null, editorViewerPdf: frame, editorHost: null });
  const root = "/project-a";
  const source = { rootPath: root, requiresRebuild: true, rebuiltPaths: [] };
  exported.updatePdfSourceState(source, true);
  viewer.showPdfViewer("main.pdf", Buffer.from("%PDF").toString("base64"));
  listeners.forEach(listener => listener({ source: frame.contentWindow, data: { source: "tex64-pdf", payload: { type: "ready" } } }));
  assert.equal(frame.messages.find(m => m.type === "open").payload.needsRebuild, true);
  viewer.setLivePreview("http://127.0.0.1:1234", 1);
  exported.updatePdfSourceState({ rootPath: "/project-b", requiresRebuild: false, rebuiltPaths: [] }, true);
  assert.equal(frame.messages.at(-1).payload.needsRebuild, true); // Existing viewer still belongs to A.
  viewer.setLivePreview(null, 2);
  assert.equal(frame.messages.at(-1).type, "live");
  assert.equal(frame.messages.at(-1).payload, null);
  exported.updatePdfSourceState({ ...source, rebuiltPaths: ["/project-a/another.pdf"] });
  assert.equal(frame.messages.at(-1).payload.needsRebuild, true);
  exported.updatePdfSourceState({ ...source, rebuiltPaths: ["/project-a/main.pdf"] });
  assert.equal(frame.messages.at(-1).payload.needsRebuild, false);
  viewer.showPdfViewer("main.pdf", Buffer.from("%PDF").toString("base64")); // New B tab same relative name.
  assert.equal(frame.messages.at(-1).payload.needsRebuild, false);
  viewer.hideViewer();
});
