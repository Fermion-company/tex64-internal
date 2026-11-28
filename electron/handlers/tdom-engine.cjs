"use strict";

const path = require("path");
const { isBuildEngine } = require("../services/agent-build-context.cjs");
const { findTexCommand } = require("../services/texlive-paths.cjs");

const registerTdomEngineHandlers = ({ ipcMain, getTdomEngineService, getMainWindow,
  getWorkspaceRoot, pdfWindowManager, livePdfFallback, synctexService, sendToRenderer, isBlocked = () => false, isBuilding = () => false }) => {
  const result = async (operation, allowWhileBlocked = false) => {
    try {
      if (!allowWhileBlocked && isBlocked()) return { ok: false, error: "Project history is busy." };
      return await operation();
    }
    catch (error) { return { ok: false, error: error?.message || String(error) }; }
  };
  const ownsMainRenderer = (event) => event.sender === getMainWindow()?.webContents &&
    event.senderFrame === event.sender.mainFrame;
  ipcMain.handle("tex64:tdom:start", (event, program = "lualatex") => result(async () => {
    if (!ownsMainRenderer(event)) return { ok: false };
    const engine = getTdomEngineService();
    if (["pdflatex", "xelatex", "uplatex"].includes(program)) {
      if (engine.getStatus().state !== "stopped") engine.stop();
      return { ok: true, fallback: true };
    }
    if (!engine.needsPdfFallback()) {
      try {
        const result = await engine.start();
        if (result?.ok && result.url) livePdfFallback.inputs.clear();
        return result;
      }
      catch (error) {
        if (error?.code === "TDOM_CANCELLED" || isBlocked()) throw error;
        console.warn("[tdom] Using LuaLaTeX PDF preview after startup failed:", error?.message);
      }
    }
    return { ok: true, fallback: true };
  }));
  ipcMain.handle("tex64:tdom:status", () => getTdomEngineService().getStatus());
  ipcMain.handle("tex64:tdom:stop", () => {
    pdfWindowManager.closeUnbuiltWindow();
    livePdfFallback.stop();
    pdfWindowManager.setFallbackPreview(null);
    return result(() => getTdomEngineService().stop());
  });
  const previewViewers = new WeakSet();
  ipcMain.handle("tex64:tdom:fallback-math", (event, request) => result(async () => {
    if (!(ownsMainRenderer(event) || (pdfWindowManager.ownsSender(event.sender) && event.senderFrame === event.sender.mainFrame)) ||
        !request) return { ok: false };
    const senderId = event.sender.id;
    const owner = request.secondary === true && ownsMainRenderer(event) ? senderId + ":secondary" : senderId;
    if (isBlocked() || isBuilding()) {
      if (request.action === "edit" && (request.finish || request.cancel)) {
        livePdfFallback.endPaperEdit(owner, request.sessionId);
      }
      if (isBlocked() || request.action !== "view") return { ok: false };
    }
    if (request.action === "view") {
      if (!previewViewers.has(event.sender)) {
        previewViewers.add(event.sender);
        event.sender.once("destroyed", () => {
          livePdfFallback.releaseViewer(senderId);
          livePdfFallback.releaseViewer(senderId + ":secondary");
        });
      }
      const emptyCaret = livePdfFallback.setViewerPapers(owner, request.displayed, request.loading);
      return { ok: true, emptyCaret };
    }
    if (request.action === "open") return livePdfFallback.reverse(synctexService, request, owner);
    if (request.action === "edit") return livePdfFallback.editPaper(owner, request, sendToRenderer);
    return { ok: false };
  }, true));
  ipcMain.handle("tex64:tdom:supersede-pdf", (event, requestId, abandon) => {
    if (ownsMainRenderer(event)) livePdfFallback.supersede(requestId, abandon === true);
  });
  ipcMain.handle("tex64:tdom:command-available", (event, command) =>
    ownsMainRenderer(event) && (isBuildEngine(command) || ["dvipdfmx", "extractbb", "bibtex", "upbibtex", "biber"].includes(command)) &&
    Boolean(findTexCommand(command)));
  ipcMain.handle("tex64:tdom:compile-pdf", (event, payload) => {
    if (!ownsMainRenderer(event)) return { ok: false };
    if (isBuilding()) return { ok: false, code: "TDOM_BUILD_IN_PROGRESS" };
    return result(() => livePdfFallback.compile(payload));
  });
  ipcMain.handle("tex64:tdom:show-window-pdf", (event, generation) => {
    if (!ownsMainRenderer(event)) return { ok: false };
    const latest = livePdfFallback.latest;
    if (generation === null) pdfWindowManager.setFallbackPreview(null);
    else if (latest && generation === latest.generation && latest.root === getWorkspaceRoot()) {
      pdfWindowManager.setFallbackPreview(latest);
    }
    return { ok: true };
  });
  ipcMain.handle("tex64:tdom:push", (_event, payload) => result(() => getTdomEngineService().push(payload)));
  ipcMain.handle("tex64:tdom:focus", (_event, payload) => result(() => getTdomEngineService().focus(payload)));
  ipcMain.handle("tex64:tdom:snapshot", (_event, payload) =>
    result(() => getTdomEngineService().snapshot(payload)));
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
  ipcMain.handle("tex64:tdom:set-unbuilt-window", (event, target) => {
    if (!ownsMainRenderer(event)) return { ok: false };
    if (target === null) {
      pdfWindowManager.closeUnbuiltWindow();
      return { ok: true };
    }
    const root = getWorkspaceRoot();
    if (!root || target?.workspaceRoot !== root ||
        typeof target.pdfPath !== "string" || isBlocked()) return { ok: false };
    return { ok: pdfWindowManager.openUnbuiltWindow(path.resolve(root, target.pdfPath)) };
  });
  ipcMain.handle("tex64:tdom:reply-window-anchor", (event, payload) => {
    if (!ownsMainRenderer(event)) return { ok: false, error: "Invalid live preview owner." };
    return pdfWindowManager.replyLiveAnchor(payload)
      ? { ok: true } : { ok: false, error: "Live preview anchor expired." };
  });
};

module.exports = { registerTdomEngineHandlers };
