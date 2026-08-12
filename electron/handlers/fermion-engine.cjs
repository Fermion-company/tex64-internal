"use strict";

const registerFermionEngineHandlers = ({ ipcMain, getFermionEngineService, getCanvasFermionEngineService }) => {
  const result = async (operation) => {
    try { return await operation(); }
    catch (error) { return { ok: false, error: error?.message || String(error) }; }
  };
  ipcMain.handle("tex64:fermion:start", () => result(() => getFermionEngineService().start()));
  ipcMain.handle("tex64:fermion:status", () => getFermionEngineService().getStatus());
  ipcMain.handle("tex64:fermion:stop", () => result(() => getFermionEngineService().stop()));
  ipcMain.handle("tex64:fermion:push", (_event, payload) => result(() => getFermionEngineService().push(payload)));
  ipcMain.handle("tex64:fermion:canvas-render", (_event, payload) => result(() => getCanvasFermionEngineService().renderPdf(payload)));
};

module.exports = { registerFermionEngineHandlers };
