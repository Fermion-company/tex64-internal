const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tex180Pdf", {
  postMessage: (payload) => {
    ipcRenderer.send("tex180:pdf", payload);
  },
  onMessage: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = (_event, message) => {
      handler(message);
    };
    ipcRenderer.on("tex180:pdf-message", listener);
    return () => {
      ipcRenderer.removeListener("tex180:pdf-message", listener);
    };
  },
});
