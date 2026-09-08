const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { TerminalWindow } = require("../electron/services/terminal-window.cjs");
class Window extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.visible = false; this.destroyed = false;
    this.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: (fn) => { this.openHandler = fn; }, isDestroyed: () => this.destroyed, send: (channel, payload) => this.messages.push({ channel, payload }) });
    this.messages = [];
  }
  loadFile(file) { this.file = file; this.emit("ready-to-show"); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  destroy() { this.destroyed = true; this.emit("closed"); }
}
class Service {
  constructor(callbacks) { this.callbacks = callbacks; this.sessions = new Map([["term-1", {}]]); }
  killAll() { this.sessions.clear(); }
}
test("terminal helper isolates owner/frame, keeps sessions hidden and tears down on root change or crash", () => {
  let root = "/project-one";
  const helper = new TerminalWindow({ BrowserWindow: Window, Service, getMainWindow: () => null, rootPath: () => root, webDirectory: "/app/web" });
  helper.open(); const first = helper.window; const service = helper.service;
  assert.equal(first.options.title, "project-one — TeX64 Terminal");
  let titlePrevented = false; first.emit("page-title-updated", { preventDefault: () => { titlePrevented = true; } });
  assert.equal(titlePrevented, true);
  assert.equal(first.options.webPreferences.sandbox, true);
  assert.equal(first.options.webPreferences.nodeIntegration, false);
  assert.equal(helper.owns({ sender: first.webContents, senderFrame: first.webContents.mainFrame }), true);
  assert.equal(helper.owns({ sender: first.webContents, senderFrame: {} }), false);
  assert.equal(helper.owns({ sender: {}, senderFrame: first.webContents.mainFrame }), false);
  service.callbacks.onData("term-1", "owned output");
  assert.deepEqual(first.messages[0], { channel: "tex64:terminal:data", payload: { id: "term-1", data: "owned output" } });
  let prevented = false;
  first.emit("close", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(first.visible, false); assert.equal(service.sessions.size, 1);
  helper.open(); assert.equal(helper.window, first); assert.equal(first.visible, true);
  root = "/project-two"; helper.workspaceChanged(root);
  assert.equal(first.destroyed, true); assert.equal(service.sessions.size, 0);
  helper.open(); const second = helper.window; const secondService = helper.service;
  assert.notEqual(second, first);
  assert.equal(helper.owns({ sender: first.webContents, senderFrame: first.webContents.mainFrame }), false);
  assert.deepEqual(second.openHandler({ url: "https://example.com" }), { action: "deny" });
  second.webContents.emit("render-process-gone");
  assert.equal(secondService.sessions.size, 0); assert.equal(helper.window, null);
});
