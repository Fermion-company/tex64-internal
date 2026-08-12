"use strict";

const registerFermionEngineHandlers = ({ ipcMain, getFermionEngineService }) => {
  const result = async (operation) => {
    try { return await operation(); }
    catch (error) { return { ok: false, error: error?.message || String(error) }; }
  };
  ipcMain.handle("tex64:fermion:start", () => result(() => getFermionEngineService().start()));
  ipcMain.handle("tex64:fermion:status", () => getFermionEngineService().getStatus());
  ipcMain.handle("tex64:fermion:stop", () => result(() => getFermionEngineService().stop()));
  ipcMain.handle("tex64:fermion:push", (_event, payload) => result(() => getFermionEngineService().push(payload)));
};

module.exports = { registerFermionEngineHandlers };
