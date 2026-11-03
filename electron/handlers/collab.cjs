"use strict";

// IPC surface of the collaboration hub:
//   ipcMain.handle("tex64:collab", action, payload)   start / join / leave / end / flush / status / comments:*
//   ipcMain.on("tex64:collab:send", frame)             renderer → hub Y.Doc frames
//   main → renderer: webContents.send("tex64:collab:message", message)
// Invite links (tex64://collab/join?…) arrive from open-url / second-instance
// and are handed to the renderer dialog; the user confirms before joining.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { parseInviteLink } = require("../services/collab/invite.cjs");

const MAX_COMMENT_BYTES = 4 * 1024 * 1024;

const createCollabHandlers = ({ ipcMain, hub, state, workspace, sendCollab, getLocale, onInvite }) => {
  const ownerOk = (event) => event.sender === state.mainWindow?.webContents && event.senderFrame === event.sender.mainFrame;
  const guestError = () => (getLocale() === "ja" ? "ホストが行います" : "The host does this");

  // A save is addressed to the folder its comments were loaded from, so a
  // save that lands after a project switch still goes to its own project.
  const knownRoots = new Set();
  const commentsPath = (root = workspace.getRootPath()) => (root ? path.join(root, ".tex64", "comments.json") : null);

  const loadComments = async () => {
    const root = workspace.getRootPath();
    if (root) knownRoots.add(root);
    const target = commentsPath(root);
    if (!target) return { comments: [] };
    try {
      const parsed = JSON.parse(await fsp.readFile(target, "utf8"));
      return { comments: Array.isArray(parsed?.comments) ? parsed.comments : [] };
    } catch (error) {
      if (error.code === "ENOENT") return { comments: [], missing: true };
      throw error;
    }
  };

  const saveComments = async (payload) => {
    const current = workspace.getRootPath();
    const root = typeof payload?.root === "string" && payload.root ? payload.root : current;
    if (!root) throw Object.assign(new Error("No workspace is open."), { code: "NO_WORKSPACE" });
    if (root !== current && !knownRoots.has(root)) throw Object.assign(new Error("The workspace changed."), { code: "WORKSPACE_CHANGED" });
    if (hub.isActive() && hub.session?.rootPath === root) throw Object.assign(new Error("Comments are shared through the session while it runs."), { code: "COLLAB_ACTIVE" });
    knownRoots.add(root);
    const target = commentsPath(root);
    const comments = Array.isArray(payload?.comments) ? payload.comments : [];
    const text = JSON.stringify({ schema: 1, comments }, null, 2);
    if (Buffer.byteLength(text) > MAX_COMMENT_BYTES) throw new Error("Comments file is too large.");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, "utf8");
    return { comments };
  };

  ipcMain.handle("tex64:collab", async (event, action, payload = {}) => {
    if (!ownerOk(event)) return { ok: false, code: "INVALID_OWNER", error: "Invalid collaboration owner." };
    try {
      if (typeof action !== "string") throw new Error("Invalid collaboration request.");
      const request = payload && typeof payload === "object" ? payload : {};
      switch (action) {
        case "status":
          return { ok: true, ...hub.status(), defaultName: hub.deps.userName() };
        case "start":
          return { ok: true, ...(await hub.start({ name: request.name })) };
        case "join":
          return { ok: true, ...(await hub.join({ link: request.link, name: request.name })) };
        case "leave":
        case "end":
          await hub.leave();
          return { ok: true, ...hub.status() };
        case "flush":
          return { ok: true, flushed: await hub.flush() };
        case "comments:load":
          return { ok: true, ...(await loadComments()) };
        case "comments:save":
          return { ok: true, ...(await saveComments(request)) };
        default:
          throw Object.assign(new Error("Unknown collaboration action."), { code: "INVALID_ACTION" });
      }
    } catch (error) {
      return { ok: false, code: error?.code || "COLLAB_ERROR", error: error?.message || String(error) };
    }
  });

  ipcMain.on("tex64:collab:send", (event, frame) => {
    if (!ownerOk(event)) return;
    hub.handleRendererFrame(frame);
  });

  const pendingInvites = [];
  const deliverInvite = (link) => {
    if (!state.mainWindow || state.mainWindow.isDestroyed() || !state.rendererReadyForCollab) {
      pendingInvites.push(link);
      return;
    }
    sendCollab({ type: "collab:invite", link });
    onInvite?.();
  };

  // Returns true when the URL was an invite link (handled here).
  const handleInviteUrl = (url) => {
    const parsed = parseInviteLink(url);
    if (!parsed) return false;
    deliverInvite(String(url).trim());
    return true;
  };

  const flushPendingInvites = () => {
    state.rendererReadyForCollab = true;
    while (pendingInvites.length) deliverInvite(pendingInvites.shift());
  };

  return { handleInviteUrl, flushPendingInvites, guestError };
};

module.exports = { createCollabHandlers };
