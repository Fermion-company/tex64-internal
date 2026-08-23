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
// Answers can arrive before the page has attached a listener — a reply to a
// question asked as it mounts, or across a re-render that swaps subscribers.
// Hold them rather than dropping them, as the desktop bridge does.
const pendingHostMessages = [];
const MAX_PENDING_HOST_MESSAGES = 200;

const dispatchHostMessage = (message) => {
  if (hostListeners.size === 0) {
    if (pendingHostMessages.length < MAX_PENDING_HOST_MESSAGES) {
      pendingHostMessages.push(message);
    }
    return;
  }
  hostListeners.forEach((listener) => {
    try {
      listener(message);
    } catch (error) {
      console.error("tex64Native host listener error:", error);
    }
  });
};

ipcRenderer.on(GUEST_CHANNEL, (_event, message) => {
  dispatchHostMessage(message);
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
      if (pendingHostMessages.length > 0) {
        const backlog = pendingHostMessages.splice(0, pendingHostMessages.length);
        for (const message of backlog) {
          try {
            handler(message);
          } catch (error) {
            console.error("tex64Native host listener error:", error);
          }
        }
      }
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
