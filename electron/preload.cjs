const { contextBridge, ipcRenderer } = require("electron");

let postMessageHandler = (payload) => {
  ipcRenderer.send("tex64", payload);
};

const messageHandlers = new Set();
const pendingMessages = [];
const MAX_PENDING_MESSAGES = 500;

const dispatchMessage = (message) => {
  if (messageHandlers.size === 0) {
    if (pendingMessages.length < MAX_PENDING_MESSAGES) {
      pendingMessages.push(message);
    }
    return;
  }
  messageHandlers.forEach((handler) => {
    try {
      handler(message);
    } catch (error) {
      console.error("tex64Bridge handler error:", error);
    }
  });
};

ipcRenderer.on("tex64:message", (_event, message) => {
  dispatchMessage(message);
});

const bridgeApi = {
  onMessage: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    messageHandlers.add(handler);
    // Flush the pending queue to ALL currently registered handlers.
    if (pendingMessages.length > 0) {
      const backlog = pendingMessages.splice(0, pendingMessages.length);
      backlog.forEach((message) => {
        messageHandlers.forEach((h) => {
          try {
            h(message);
          } catch (error) {
            console.error("tex64Bridge handler error (backlog):", error);
          }
        });
      });
    }
    return () => {
      messageHandlers.delete(handler);
    };
  },
};

const captureApi = {
  listSources: async (options = {}) => {
    const size = options.thumbnailSize ?? { width: 1600, height: 900 };
    console.log("[tex64Capture] Invoking main process to get sources...");
    try {
      const sources = await ipcRenderer.invoke("tex64:capture:getSources", { thumbnailSize: size });
      console.log("[tex64Capture] Got sources from main process:", sources.length);
      return sources;
    } catch (error) {
      console.error("[tex64Capture] Error from main process:", error);
      throw error;
    }
  },
  checkPermission: async () => {
    try {
      return await ipcRenderer.invoke("tex64:capture:checkPermission");
    } catch {
      return "unknown";
    }
  },
  openPermissionSettings: async () => {
    try {
      return await ipcRenderer.invoke("tex64:capture:openPermissionSettings");
    } catch {
      return false;
    }
  },
  captureHighRes: async (sourceId) => {
    try {
      return await ipcRenderer.invoke("tex64:capture:captureHighRes", { sourceId });
    } catch (error) {
      console.error("[tex64Capture] Error capturing high-res:", error);
      return null;
    }
  },
};

const mathOcrApi = {
  run: async (payload) => ipcRenderer.invoke("tex64:math-ocr:run", payload),
};

// LSP bridge: the renderer-side client speaks JSON-RPC through this; main relays
// it to/from texlab over stdio. `send` is one-way (the client matches replies by
// id itself); inbound messages and lifecycle status arrive via the listeners.
const lspMessageHandlers = new Set();
const lspStatusHandlers = new Set();

ipcRenderer.on("tex64:lsp:message", (_event, message) => {
  lspMessageHandlers.forEach((handler) => {
    try {
      handler(message);
    } catch (error) {
      console.error("tex64Lsp message handler error:", error);
    }
  });
});

ipcRenderer.on("tex64:lsp:status", (_event, status) => {
  lspStatusHandlers.forEach((handler) => {
    try {
      handler(status);
    } catch (error) {
      console.error("tex64Lsp status handler error:", error);
    }
  });
});

const spellApi = {
  check: async (words) => {
    try {
      return await ipcRenderer.invoke("tex64:spell:check", words);
    } catch {
      return [];
    }
  },
  suggest: async (word) => {
    try {
      return await ipcRenderer.invoke("tex64:spell:suggest", word);
    } catch {
      return [];
    }
  },
  add: async (word) => {
    try {
      return await ipcRenderer.invoke("tex64:spell:add", word);
    } catch {
      return false;
    }
  },
};

const lspApi = {
  send: (message) => ipcRenderer.send("tex64:lsp:send", message),
  onMessage: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    lspMessageHandlers.add(handler);
    return () => {
      lspMessageHandlers.delete(handler);
    };
  },
  onStatus: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    lspStatusHandlers.add(handler);
    return () => {
      lspStatusHandlers.delete(handler);
    };
  },
  getStatus: async () => {
    try {
      return await ipcRenderer.invoke("tex64:lsp:status");
    } catch {
      return { available: false, running: false };
    }
  },
};

Object.defineProperty(bridgeApi, "postMessage", {
  get: () => postMessageHandler,
  set: (next) => {
    if (typeof next === "function") {
      postMessageHandler = next;
    }
  },
  enumerable: true,
});

contextBridge.exposeInMainWorld("tex64Bridge", bridgeApi);
contextBridge.exposeInMainWorld("tex64Capture", captureApi);
contextBridge.exposeInMainWorld("tex64MathOcr", mathOcrApi);
contextBridge.exposeInMainWorld("tex64Lsp", lspApi);
contextBridge.exposeInMainWorld("tex64Spell", spellApi);
