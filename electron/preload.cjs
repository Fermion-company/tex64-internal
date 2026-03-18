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
