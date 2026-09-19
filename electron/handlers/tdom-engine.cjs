"use strict";

const path = require("path");

const registerTdomEngineHandlers = ({ ipcMain, getTdomEngineService, getMainWindow,
  getWorkspaceRoot, pdfWindowManager, isBlocked = () => false }) => {
  const result = async (operation) => {
    try {
      if (isBlocked()) return { ok: false, error: "Project history is busy." };
      return await operation();
    }
    catch (error) { return { ok: false, error: error?.message || String(error) }; }
  };
  ipcMain.handle("tex64:tdom:start", () => result(() => getTdomEngineService().start()));
  ipcMain.handle("tex64:tdom:status", () => getTdomEngineService().getStatus());
  ipcMain.handle("tex64:tdom:stop", () => result(() => getTdomEngineService().stop()));
  ipcMain.handle("tex64:tdom:push", (_event, payload) => result(() => getTdomEngineService().push(payload)));
  ipcMain.handle("tex64:tdom:focus", (_event, payload) => result(() => getTdomEngineService().focus(payload)));
  ipcMain.handle("tex64:tdom:snapshot", (_event, payload) =>
    result(() => getTdomEngineService().snapshot(payload)));
  const ownsMainRenderer = (event) => event.sender === getMainWindow()?.webContents &&
    event.senderFrame === event.sender.mainFrame;
  ipcMain.handle("tex64:tdom:set-window-preview", (event, payload) => {
    if (!ownsMainRenderer(event)) return { ok: false, error: "Invalid live preview owner." };
    if (payload == null) {
      pdfWindowManager.setLivePreview(null);
      return { ok: true };
    }
    const service = getTdomEngineService();
    const status = service.getStatus();
    const workspaceRoot = getWorkspaceRoot();
    const target = payload?.target;
    if (!status.running || status.state !== "ready" || typeof status.url !== "string" ||
        payload.url !== status.url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(payload.url) ||
        !workspaceRoot || !target || typeof target.workspaceRoot !== "string" || !target.workspaceRoot ||
        path.resolve(target.workspaceRoot) !== path.resolve(workspaceRoot) ||
        typeof target.pdfPath !== "string" || !target.pdfPath ||
        !Number.isSafeInteger(payload.generation) || payload.generation < 0 ||
        typeof payload.hold !== "boolean" ||
        !(payload.expectedSrcRev == null || (Number.isSafeInteger(payload.expectedSrcRev) && payload.expectedSrcRev >= 0))) {
      return { ok: false, error: "Invalid live preview state." };
    }
    const targetPdf = path.isAbsolute(target.pdfPath)
      ? path.resolve(target.pdfPath) : path.resolve(workspaceRoot, target.pdfPath);
    const engineRoot = typeof service.lastPath === "string" ? path.resolve(service.lastPath) : null;
    const expectedPdf = engineRoot?.replace(/\.tex$/i, ".pdf") ?? null;
    if (!engineRoot || !expectedPdf || targetPdf !== expectedPdf ||
        !(engineRoot === path.resolve(workspaceRoot) || engineRoot.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`))) {
      return { ok: false, error: "Live preview target does not match the open document." };
    }
    pdfWindowManager.setLivePreview({
      url: payload.url,
      generation: payload.generation,
      target: { workspaceRoot: path.resolve(workspaceRoot), pdfPath: targetPdf },
      hold: payload.hold,
      expectedSrcRev: payload.expectedSrcRev ?? null,
    });
    return { ok: true };
  });
  ipcMain.handle("tex64:tdom:reply-window-anchor", (event, payload) => {
    if (!ownsMainRenderer(event)) return { ok: false, error: "Invalid live preview owner." };
    return pdfWindowManager.replyLiveAnchor(payload)
      ? { ok: true } : { ok: false, error: "Live preview anchor expired." };
  });
};

module.exports = { registerTdomEngineHandlers };
