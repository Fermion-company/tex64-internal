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

// Integrated terminal bridge: `create` opens a pty session and returns its id;
// keystrokes/resize/kill are fire-and-forget by id; output and exit arrive on
// the dedicated listener channels.
const terminalDataHandlers = new Set();
const terminalExitHandlers = new Set();

ipcRenderer.on("tex64:terminal:data", (_event, message) => {
  terminalDataHandlers.forEach((handler) => {
    try {
      handler(message);
    } catch (error) {
      console.error("tex64Terminal data handler error:", error);
    }
  });
});

ipcRenderer.on("tex64:terminal:exit", (_event, message) => {
  terminalExitHandlers.forEach((handler) => {
    try {
      handler(message);
    } catch (error) {
      console.error("tex64Terminal exit handler error:", error);
    }
  });
});

const terminalApi = {
  create: async (options = {}) => {
    try {
      return await ipcRenderer.invoke("tex64:terminal:create", options);
    } catch (error) {
      return { error: error && error.message ? error.message : "terminal create failed" };
    }
  },
  write: (id, data) => ipcRenderer.send("tex64:terminal:write", { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send("tex64:terminal:resize", { id, cols, rows }),
  kill: (id) => ipcRenderer.send("tex64:terminal:kill", { id }),
  onData: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    terminalDataHandlers.add(handler);
    return () => {
      terminalDataHandlers.delete(handler);
    };
  },
  onExit: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    terminalExitHandlers.add(handler);
    return () => {
      terminalExitHandlers.delete(handler);
    };
  },
};

// In-app billing: `checkout` returns an embedded Stripe Checkout session
// (clientSecret + publishableKey) the renderer mounts in a modal; `openPortal`
// asks main to open the Stripe Customer Portal in an in-app window.
const billingApi = {
  checkout: async (plan) => {
    try {
      return await ipcRenderer.invoke("tex64:billing:checkout", { plan });
    } catch (error) {
      return { error: error && error.message ? error.message : "checkout failed" };
    }
  },
  openPortal: async () => {
    try {
      return await ipcRenderer.invoke("tex64:billing:portal");
    } catch (error) {
      return { error: error && error.message ? error.message : "portal failed" };
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
contextBridge.exposeInMainWorld("tex64Terminal", terminalApi);
contextBridge.exposeInMainWorld("tex64Billing", billingApi);
