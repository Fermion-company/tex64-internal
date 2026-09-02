"use strict";

// Preload for a detached terminal window. It exposes only the terminal bridge —
// the window hosts an xterm and nothing else, so none of the editor APIs the
// main preload carries belong here.

const { contextBridge, ipcRenderer } = require("electron");

const dataHandlers = new Set();
const exitHandlers = new Set();

const fanOut = (handlers, message) => {
  handlers.forEach((handler) => {
    try {
      handler(message);
    } catch (error) {
      console.error("tex64Terminal handler error:", error);
    }
  });
};

ipcRenderer.on("tex64:terminal:data", (_event, message) => fanOut(dataHandlers, message));
ipcRenderer.on("tex64:terminal:exit", (_event, message) => fanOut(exitHandlers, message));

contextBridge.exposeInMainWorld("tex64Terminal", {
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
    dataHandlers.add(handler);
    return () => dataHandlers.delete(handler);
  },
  onExit: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    exitHandlers.add(handler);
    return () => exitHandlers.delete(handler);
  },
});
