const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const loadPdfWindowManager = () => {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") {
      return {
        BrowserWindow: class {},
        app: { getPath: () => "/tmp" },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../electron/services/pdf.cjs")];
    return require("../electron/services/pdf.cjs").PDFWindowManager;
  } finally {
    Module._load = originalLoad;
  }
};

test("switching Live to tab mode hides the detached PDF window", () => {
  const PDFWindowManager = loadPdfWindowManager();
  const sent = [];
  let hideCount = 0;
  const manager = new PDFWindowManager();
  manager.window = {
    isDestroyed: () => false,
    hide: () => { hideCount += 1; },
    webContents: {
      isDestroyed: () => false,
      send: (_channel, message) => sent.push(message),
    },
  };
  manager.isReady = true;
  manager.liveUrl = "http://127.0.0.1:1234";
  manager.currentPath = "/tmp/static.pdf";

  manager.setLive(null, { generation: 2, hide: true });

  assert.equal(hideCount, 1);
  assert.deepEqual(sent.at(-1), { type: "live", payload: null });
});

test("turning Live off in separate-window mode preserves its static PDF", () => {
  const PDFWindowManager = loadPdfWindowManager();
  let hideCount = 0;
  const manager = new PDFWindowManager();
  manager.window = {
    isDestroyed: () => false,
    hide: () => { hideCount += 1; },
    webContents: { isDestroyed: () => false, send: () => {} },
  };
  manager.isReady = true;
  manager.liveUrl = "http://127.0.0.1:1234";
  manager.currentPath = "/tmp/static.pdf";

  manager.setLive(null, { generation: 3, hide: false });

  assert.equal(hideCount, 0);
});

test("a Live-only detached window stays transparent until its exact surface ack", () => {
  const PDFWindowManager = loadPdfWindowManager();
  const opacity = [];
  let showCount = 0;
  const webContents = {
    isDestroyed: () => false,
    send: () => {},
  };
  const manager = new PDFWindowManager();
  manager.window = {
    isDestroyed: () => false,
    setTitle: () => {},
    setOpacity: (value) => opacity.push(value),
    showInactive: () => { showCount += 1; },
    webContents,
  };
  manager.isReady = true;

  manager.setLive("http://127.0.0.1:1234", { generation: 7, show: true });

  assert.deepEqual(opacity, [0]);
  assert.equal(showCount, 1, "transparent window is warmed without taking focus");
  assert.equal(manager.markLiveReady({
    url: "http://127.0.0.1:1234",
    generation: 6,
  }, webContents), false, "stale activation cannot reveal the native window");
  assert.equal(manager.markLiveReady({
    url: "http://127.0.0.1:1234",
    generation: 7,
  }, {}), false, "an obsolete renderer cannot reveal the replacement window");
  assert.deepEqual(opacity, [0]);

  assert.equal(manager.markLiveReady({
    url: "http://127.0.0.1:1234",
    generation: 7,
  }, webContents), true);
  assert.deepEqual(opacity, [0, 1]);
  assert.equal(showCount, 2);
});

test("turning Live off hides a detached window that has no static PDF", () => {
  const PDFWindowManager = loadPdfWindowManager();
  let hideCount = 0;
  const manager = new PDFWindowManager();
  manager.window = {
    isDestroyed: () => false,
    hide: () => { hideCount += 1; },
    setOpacity: () => {},
    webContents: { isDestroyed: () => false, send: () => {} },
  };
  manager.isReady = true;
  manager.liveUrl = "http://127.0.0.1:1234";

  manager.setLive(null, { generation: 8, hide: false });

  assert.equal(hideCount, 1);
});

test("turning Live off hides a staging native window before restoring its opacity", () => {
  const PDFWindowManager = loadPdfWindowManager();
  const events = [];
  const manager = new PDFWindowManager();
  manager.window = {
    isDestroyed: () => false,
    hide: () => events.push("hide"),
    setOpacity: (value) => events.push(`opacity:${value}`),
    setIgnoreMouseEvents: () => {},
    webContents: { isDestroyed: () => false, send: () => {} },
  };
  manager.isReady = true;
  manager.liveUrl = "http://127.0.0.1:1234";
  manager.pendingLiveShow = {
    url: manager.liveUrl,
    generation: 10,
    error: null,
  };

  manager.setLive(null, { generation: 11, hide: false });

  assert.deepEqual(events, ["hide", "opacity:1"]);
});

test("a new detached error surface stays transparent through its paint acknowledgement", () => {
  const PDFWindowManager = loadPdfWindowManager();
  const opacity = [];
  let showCount = 0;
  const webContents = {
    isDestroyed: () => false,
    send: () => {},
  };
  const manager = new PDFWindowManager();
  manager.window = {
    isDestroyed: () => false,
    setTitle: () => {},
    setOpacity: (value) => opacity.push(value),
    setIgnoreMouseEvents: () => {},
    showInactive: () => { showCount += 1; },
    webContents,
  };
  manager.isReady = true;

  manager.setLive(null, {
    generation: 9,
    show: true,
    error: "リアルタイムプレビュー: engine failed",
  });

  assert.deepEqual(opacity, [0]);
  assert.equal(showCount, 1, "the error renderer warms while transparent");
  assert.equal(manager.markLiveErrorReady({
    url: null,
    generation: 8,
    error: "リアルタイムプレビュー: engine failed",
  }, webContents), false, "a stale generation cannot reveal the error window");
  assert.equal(manager.markLiveErrorReady({
    url: null,
    generation: 9,
    error: "different error",
  }, webContents), false, "an obsolete error cannot reveal the window");
  assert.deepEqual(opacity, [0]);

  assert.equal(manager.markLiveErrorReady({
    url: null,
    generation: 9,
    error: "リアルタイムプレビュー: engine failed",
  }, webContents), true);
  assert.deepEqual(opacity, [0, 1]);
  assert.equal(showCount, 2);
});

test("window-live IPC forwards the explicit hide intent", async () => {
  const { registerTdomEngineHandlers } = require("../electron/handlers/tdom-engine.cjs");
  let windowLiveHandler = null;
  let forwarded = null;
  registerTdomEngineHandlers({
    ipcMain: {
      handle: (name, handler) => {
        if (name === "tex64:tdom:window-live") windowLiveHandler = handler;
      },
    },
    getTdomEngineService: () => ({}),
    getPdfWindowManager: () => ({
      setLive: (url, options) => { forwarded = { url, options }; },
    }),
  });

  assert.equal(typeof windowLiveHandler, "function");
  const result = await windowLiveHandler(null, {
    url: null,
    generation: 4,
    show: false,
    hide: true,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(forwarded, {
    url: null,
    options: { generation: 4, show: false, hide: true },
  });
});
