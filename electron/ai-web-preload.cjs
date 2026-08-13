"use strict";

// Guest preload for the embedded tex64-ai web app (AI mode webview).
// The web app stays a plain web page; this bridge is the only difference the
// native embed sees, and it deliberately exposes the minimum surface. The
// page detects `window.tex64Native` to branch native-specific behavior.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tex64Native", {
  platform: "native",
  // Ask the host app to open a URL in the system browser. Routed
  // guest -> embedder renderer -> main so the guest never talks to main
  // directly.
  openExternal: (url) => {
    if (typeof url === "string" && url) {
      ipcRenderer.sendToHost("tex64-ai-web", { type: "open-external", url });
    }
  },
});
