"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const subscribe = (channel, handler) => {
  const listener = (_event, value) => handler(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld("tex64Terminal", {
  create: (options = {}) => ipcRenderer.invoke("tex64:terminal:create", options),
  write: (id, data) => ipcRenderer.send("tex64:terminal:write", { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send("tex64:terminal:resize", { id, cols, rows }),
  kill: (id) => ipcRenderer.send("tex64:terminal:kill", { id }),
  setFocused: (focused) => ipcRenderer.send("tex64:terminal:focus", focused),
  onCommand: (handler) => subscribe("tex64:terminal:command", handler),
  onData: (handler) => subscribe("tex64:terminal:data", handler),
  onExit: (handler) => subscribe("tex64:terminal:exit", handler),
});
