"use strict";

// Guest preload for the embedded tex64-ai web app (AI mode webview).
// The web app stays a plain web page; this bridge is the only difference the
// native embed sees, and it deliberately exposes the minimum surface. The
// page detects `window.tex64Native` to branch native-specific behavior.
const { contextBridge, ipcRenderer } = require("electron");

// Guest -> embedder. The embedder is the only thing that talks to main.
const HOST_CHANNEL = "tex64-ai-web";
// Embedder -> guest.
const GUEST_CHANNEL = "tex64-ai-host";

const hostListeners = new Set();

ipcRenderer.on(GUEST_CHANNEL, (_event, message) => {
  hostListeners.forEach((listener) => {
    try {
      listener(message);
    } catch (error) {
      console.error("tex64Native host listener error:", error);
    }
  });
});

contextBridge.exposeInMainWorld("tex64Native", {
  platform: "native",
  /**
   * The workspace the desktop app has open: its files, its build, its SyncTeX,
   * its agent. Message types are allowlisted by the embedder in both
   * directions, so the guest can only reach the surface the host opened to it.
   */
  host: {
    send: (type, payload) => {
      if (typeof type !== "string" || !type) return;
      ipcRenderer.sendToHost(HOST_CHANNEL, {
        type: "host-request",
        request: { type, payload },
      });
    },
    onMessage: (handler) => {
      if (typeof handler !== "function") return () => {};
      hostListeners.add(handler);
      return () => hostListeners.delete(handler);
    },
  },
  // Ask the host app to open a URL in the system browser. Routed
  // guest -> embedder renderer -> main so the guest never talks to main
  // directly.
  openExternal: (url) => {
    if (typeof url === "string" && url) {
      ipcRenderer.sendToHost("tex64-ai-web", { type: "open-external", url });
    }
  },
});
