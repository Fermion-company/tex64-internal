"use strict";

const registerTdomEngineHandlers = ({ ipcMain, getTdomEngineService, isBlocked = () => false }) => {
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
};

module.exports = { registerTdomEngineHandlers };
